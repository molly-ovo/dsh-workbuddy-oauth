/**
 * Token refresh.
 *
 * Two properties here are account-safety properties, not conveniences.
 *
 * ## 1. One refresh at a time per account (single flight)
 *
 * The upstream **rotates** the refresh token: the response carries a new one
 * and the old one is spent. Two concurrent refreshes for the same account
 * therefore race — the second sends a token the first already consumed, which
 * the upstream reads as replay of a used credential. That is the shape of a
 * stolen-token attack, and it is exactly what risk control is looking for.
 *
 * In-process callers are de-duplicated through a shared promise, so N callers
 * cause one request. The cross-process case is handled by serializing the
 * whole read-refresh-write cycle under the credential file lock, so a second
 * process re-reads the freshly committed token and skips its refresh.
 *
 * ## 2. Do not refresh on a timer
 *
 * Refreshing in the background "just in case" multiplies credential traffic
 * for no benefit. Refresh lazily, only when a request actually needs a token
 * that is at or near expiry, with a margin so a token cannot expire mid-flight.
 *
 * The shape of the request (POST, `X-Refresh-Token`, the `X-Auth-Refresh-Source`
 * discriminator) follows the reference implementations, which are the ones
 * observed working against the live upstream.
 *
 * @module dsh-workbuddy-standalone/refresh
 */

import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  credentialPath,
  readCredential,
  writeCredentialUnlocked,
  type WorkBuddyCredential,
} from './credentials.ts'
import { regionEndpoints } from './region.ts'

/** Endpoint that exchanges a refresh token for a new access token. */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

/**
 * Refresh this long before expiry.
 *
 * Five minutes matches the reference implementations and is comfortably longer
 * than one chat turn, so a token cannot expire between being checked and being
 * used.
 */
export const REFRESH_MARGIN_MS = 5 * 60_000

/** User agent for refresh calls. */
const REFRESH_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Outcome of a refresh attempt. */
export type RefreshOutcome =
  | { status: 'refreshed'; credential: WorkBuddyCredential }
  | { status: 'not-needed'; credential: WorkBuddyCredential }
  | { status: 'failed'; reason: string }

/** Injectable collaborators, so the logic is testable without a network. */
export interface RefreshDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** Headers the refresh endpoint expects. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const { origin } = regionEndpoints(credential.region)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': REFRESH_USER_AGENT,
    Origin: origin,
    Referer: `${origin}/`,
    'X-Refresh-Token': credential.refreshToken,
    // The upstream discriminates refresh origin on this header; the reference
    // implementations send `workbuddy` for the domestic app and `plugin`
    // elsewhere, and getting it wrong is visible to them.
    'X-Auth-Refresh-Source': credential.region === 'cn' ? 'workbuddy' : 'plugin',
    'X-User-Id': credential.uid,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': credential.region === 'global' ? 'en-US' : 'zh-CN',
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/**
 * Whether a credential needs refreshing.
 *
 * @param credential - The stored credential.
 * @param now - Current epoch milliseconds.
 * @param marginMs - Refresh when expiry is nearer than this.
 */
export function needsRefresh(
  credential: WorkBuddyCredential,
  now: number = Date.now(),
  marginMs: number = REFRESH_MARGIN_MS,
): boolean {
  // A credential with no usable refresh token cannot be refreshed; reporting
  // "needed" would make every call attempt and fail. Signing in again is the
  // only fix, and `refreshCredential` says so.
  if (credential.refreshToken === '') return false
  return credential.expiresAtMs - marginMs <= now
}

/** Pull the new tokens out of the upstream envelope, tolerating its nesting. */
function extractTokens(payload: unknown): { accessToken?: string; refreshToken?: string; expiresIn?: number } {
  if (typeof payload !== 'object' || payload === null) return {}
  const root = payload as Record<string, unknown>
  // The reference implementations unwrap twice, because the payload has been
  // seen both as `{data:{...}}` and `{data:{data:{...}}}`.
  const first = root['data']
  const inner =
    typeof first === 'object' && first !== null && 'data' in (first as Record<string, unknown>)
      ? (first as Record<string, unknown>)['data']
      : first
  if (typeof inner !== 'object' || inner === null) return {}
  const body = inner as Record<string, unknown>
  const result: { accessToken?: string; refreshToken?: string; expiresIn?: number } = {}
  if (typeof body['accessToken'] === 'string') result.accessToken = body['accessToken']
  if (typeof body['refreshToken'] === 'string') result.refreshToken = body['refreshToken']
  if (typeof body['expiresIn'] === 'number' && Number.isFinite(body['expiresIn'])) {
    result.expiresIn = body['expiresIn']
  }
  return result
}

/** In-process single-flight table, keyed by uid. */
const inFlight = new Map<string, Promise<RefreshOutcome>>()

/**
 * Refresh one account's token if needed.
 *
 * Concurrent calls for the same uid share one request, and the cycle is
 * serialized under the credential file lock so a second process re-reads the
 * committed token instead of replaying a spent refresh token.
 *
 * @param uid - Account to refresh; its stored credential is the input.
 * @param deps - Optional fetch/clock overrides.
 */
export async function refreshCredential(uid: string, deps: RefreshDeps = {}): Promise<RefreshOutcome> {
  const existing = inFlight.get(uid)
  if (existing !== undefined) return existing

  const run = (async (): Promise<RefreshOutcome> => {
    const path = credentialPath(uid)

    // Check existence before locking: the lock is a sibling file, so it cannot
    // be created in a directory that does not exist yet. An account that was
    // never signed in is a normal answer ("sign in again"), not an fs error.
    if ((await readCredential(path)) === undefined) {
      return { status: 'failed', reason: '账号凭据不存在或已损坏，请重新登录。' } as const
    }

    // The lock spans the network call on purpose: it is what keeps two
    // processes from spending the same rotating refresh token. The wait is
    // generous for that reason.
    return withFileLock(path, async () => {
      // Re-read inside the lock: another writer may have refreshed already.
      const stored = await readCredential(path)
      if (stored === undefined) {
        return { status: 'failed', reason: '账号凭据不存在或已损坏，请重新登录。' } as const
      }
      const now = (deps.now ?? Date.now)()
      if (!needsRefresh(stored, now)) {
        return { status: 'not-needed', credential: stored } as const
      }
      if (stored.refreshToken === '') {
        return { status: 'failed', reason: '没有 refresh token，需要重新登录。' } as const
      }

      const fetchImpl = deps.fetchImpl ?? fetch
      const { base } = regionEndpoints(stored.region)
      let response: Response
      try {
        response = await fetchImpl(`${base}${REFRESH_PATH}`, {
          method: 'POST',
          headers: refreshHeaders(stored),
          body: '{}',
          signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
        })
      } catch (error) {
        return {
          status: 'failed',
          reason: `刷新请求失败：${error instanceof Error ? error.message : String(error)}`,
        } as const
      }

      const text = await response.text().catch(() => '')
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        return { status: 'failed', reason: `刷新响应不是 JSON（HTTP ${response.status}）` } as const
      }

      const tokens = extractTokens(payload)
      if (tokens.accessToken === undefined || tokens.accessToken === '') {
        const message =
          typeof payload === 'object' && payload !== null && 'msg' in payload
            ? String((payload as Record<string, unknown>)['msg'])
            : `HTTP ${response.status}`
        return { status: 'failed', reason: `刷新未返回新 token：${message}` } as const
      }

      const refreshed: WorkBuddyCredential = {
        ...stored,
        accessToken: tokens.accessToken,
        // Rotation: keep the new refresh token when offered, otherwise the old
        // one remains valid.
        refreshToken: tokens.refreshToken ?? stored.refreshToken,
        expiresAtMs:
          tokens.expiresIn !== undefined ? now + tokens.expiresIn * 1000 : stored.expiresAtMs,
      }
      // Unlocked write: this whole cycle already runs inside the file lock, and
      // `withFileLock` is not reentrant.
      await writeCredentialUnlocked(refreshed)
      return { status: 'refreshed', credential: refreshed } as const
    }, { waitMs: 60_000 })
  })()

  inFlight.set(uid, run)
  try {
    return await run
  } finally {
    inFlight.delete(uid)
  }
}
