/**
 * Credential resolution for the provider and shim.
 *
 * The ported shim and adapter were written against connect's
 * `WorkBuddyCredentialStore`, which resolves a desktop-app credential and
 * refreshes it. This module presents the same narrow surface — `resolve()` —
 * on top of this plugin's own OAuth credentials ({@link ./credentials.ts}),
 * so the ported code needed no changes to its credential handling.
 *
 * ## Why a thin adapter instead of changing the ported code
 *
 * Keeping the seam identical means the parts that were verified against the
 * live upstream (header construction, chat body preparation, error
 * classification) stay untouched, and only the *source of the credential*
 * differs. That is the whole point of this plugin.
 *
 * ## Single account in Phase 1
 *
 * `resolve()` returns the account that should serve the next request. Phase 1
 * has exactly one decision — when several credentials exist, prefer one whose
 * token is still valid, and fall back to the lexicographically first so the
 * choice is stable rather than arbitrary. Token selection *per conversation*
 * (affinity) and health-based rotation are Phase 2 concerns; leaving them out
 * here keeps this module honest about what it does.
 *
 * @module dsh-workbuddy-standalone/store
 */

import {
  credentialPath,
  deleteCredential,
  displayNameOf,
  isExpired,
  listCredentials,
  readCredential,
  writeCredential,
  type WorkBuddyCredential,
} from './credentials.ts'
import { disabledUids } from './account-state.ts'
import type { WorkBuddyRegion } from './region.ts'
import { refreshCredential, needsRefresh } from './refresh.ts'

/** Thrown when no usable credential exists; the shim maps this to HTTP 401. */
export class NotSignedInError extends Error {
  constructor(message = '尚未登录 WorkBuddy。请先执行 /wb-login 完成登录。') {
    super(message)
    this.name = 'NotSignedInError'
  }
}

/** What the ported code needs from a credential store. */
export interface CredentialStore {
  /**
   * Resolve the credential to serve the next request; refreshes if needed.
   *
   * @param sessionKey - optional conversation identity. When given, and an
   *   account is already pinned to it and still selectable, that account wins —
   *   so one conversation keeps one account instead of hopping mid-turn.
   */
  resolve(sessionKey?: string): Promise<WorkBuddyCredential>
  /** The current credential without refreshing, or `undefined` when none. */
  current(): Promise<WorkBuddyCredential | undefined>
  /**
   * Mark one account as failed, cooling it out of selection until `untilMs`.
   *
   * The store does not decide *how long* a failure cools an account — it only
   * records the deadline, so it needs no knowledge of the upstream's error
   * vocabulary. The shim (which already classifies upstream failures) computes
   * the deadline and hands it over.
   */
  noteFailure(uid: string, untilMs: number): void
}

/** How long a conversation keeps its pinned account without a request. */
const SESSION_AFFINITY_TTL_MS = 30 * 60_000

/**
 * Rotating selection: pick the next ready account in ring order.
 *
 * The single-account rule is stable here because a one-account pool always
 * answers that account; rotation only becomes visible with two or more. Order
 * of preference within one call:
 *
 * 1. unexpired token: choosing an expired one would spend a refresh cycle (and
 *    a rotation) on a request that another account could serve as-is;
 * 2. not currently cooled out (a recently failed account stays parked);
 * 3. ring order from `cursor`, so load spreads instead of always hitting the
 *    lexicographically-first account.
 *
 * When *every* account is cooled out, the soonest-to-recover account is served
 * anyway — refusing would leave the whole pool unusable until a timer fires,
 * and for a personal install a short wait on the least-bad account is better
 * than a hard failure.
 *
 * Pure, and exported so the rule is testable without touching the filesystem.
 * `credentials` are already filtered to one region by the caller: a credential
 * is only ever valid for its own upstream host, so presenting a domestic token
 * to the international service (or vice versa) is an authentication failure,
 * and the caller knows which endpoint it is about to call.
 *
 * @returns the chosen credential and the next cursor, or `undefined` when none.
 */
export function chooseRotating(
  credentials: readonly WorkBuddyCredential[],
  cursor: number,
  cooldownUntilMs: ReadonlyMap<string, number>,
  now: number = Date.now(),
): { credential: WorkBuddyCredential; nextCursor: number } | undefined {
  if (credentials.length === 0) return undefined
  const live = credentials.filter((credential) => !isExpired(credential, 0, now))
  const base = live.length > 0 ? live : credentials
  const ready = base.filter((credential) => (cooldownUntilMs.get(credential.uid) ?? 0) <= now)
  if (ready.length > 0) {
    const index = ((cursor % ready.length) + ready.length) % ready.length
    const credential = ready[index]
    return { credential: credential as WorkBuddyCredential, nextCursor: (index + 1) % ready.length }
  }
  // Everything is cooled out: serve the soonest-to-recover account rather than
  // none. Recovery order, not ring order — the ring is irrelevant when no one is
  // ready.
  const soonest = [...base].sort(
    (a, b) => (cooldownUntilMs.get(a.uid) ?? 0) - (cooldownUntilMs.get(b.uid) ?? 0),
  )[0]
  return soonest === undefined ? undefined : { credential: soonest, nextCursor: 0 }
}

/** Options for {@link createCredentialStore}. */
export interface CredentialStoreOptions {
  /**
   * Region this store serves.
   *
   * Each region gets its own store because a credential is only valid against
   * its own upstream host. Without this filter a domestic and an international
   * account would be interchangeable to a store, and the shim would present the
   * wrong region's token.
   */
  region?: WorkBuddyRegion
  /** Clock, injectable for tests. */
  now?: () => number
  /** Refresh hook, injectable for tests. Defaults to {@link refreshCredential}. */
  refresh?: typeof refreshCredential
}

/**
 * Build the credential store the ported shim and adapter consume.
 *
 * `resolve()` refreshes when the chosen token is at or near expiry, and
 * reports {@link NotSignedInError} when nothing is stored — the shim turns that
 * into a 401 carrying the message, so an unconfigured install reports "sign in"
 * rather than an opaque failure.
 */
export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const now = options.now ?? Date.now
  const refresh = options.refresh ?? refreshCredential
  const region = options.region

  // Rotation state and failure cooldowns. Both are per-instance (and therefore
  // per-region, because each region builds its own store) and in-memory: a
  // restart forgets them, which is acceptable for a personal install — the
  // rotation simply restarts from the first account, and a cooled account is
  // tried again. Persistent pool state is a later phase (P3.7).
  let cursor = 0
  const cooldownUntilMs = new Map<string, number>()
  // Conversation → account affinity. In-memory and TTL-bounded: a conversation
  // that has been quiet for a while re-picks, which is fine for a personal
  // install. Persistent affinity is P3.7.
  const affinity = new Map<string, { uid: string; expiresAt: number }>()

  /** Credentials this store may serve: its own region's, when one is set. */
  const candidates = async (): Promise<readonly WorkBuddyCredential[]> => {
    const all = await listCredentials()
    const byRegion = region === undefined ? all : all.filter((credential) => credential.region === region)
    // A disabled account is stored but must not be selected: its token is never
    // spent until re-enabled. Read fresh so a toggle in another window applies
    // on the next selection.
    const disabled = await disabledUids()
    return byRegion.filter((credential) => !disabled.has(credential.uid))
  }

  /** Whether an account may serve a request right now (enabled, not cooled). */
  const selectable = (credential: WorkBuddyCredential): boolean =>
    (cooldownUntilMs.get(credential.uid) ?? 0) <= now()

  /** The account pinned to a conversation, when the pin is still alive. */
  const pinnedUid = (sessionKey: string | undefined): string | undefined => {
    if (sessionKey === undefined) return undefined
    const entry = affinity.get(sessionKey)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now()) {
      affinity.delete(sessionKey)
      return undefined
    }
    return entry.uid
  }

  const pin = (sessionKey: string | undefined, uid: string): void => {
    if (sessionKey === undefined) return
    affinity.set(sessionKey, { uid, expiresAt: now() + SESSION_AFFINITY_TTL_MS })
  }

  return {
    async current(): Promise<WorkBuddyCredential | undefined> {
      const creds = await candidates()
      const chosen = chooseRotating(creds, cursor, cooldownUntilMs, now())
      if (chosen === undefined) return undefined
      cursor = chosen.nextCursor
      return chosen.credential
    },

    async resolve(sessionKey?: string): Promise<WorkBuddyCredential> {
      const creds = await candidates()

      // Session affinity first: a conversation keeps its account as long as that
      // account is still selectable. A cooled or disabled account is not served
      // by affinity — that would let a pinned conversation bypass cooldown.
      let chosen: WorkBuddyCredential | undefined
      const pinned = pinnedUid(sessionKey)
      if (pinned !== undefined) {
        chosen = creds.find((credential) => credential.uid === pinned && selectable(credential))
        if (chosen !== undefined) pin(sessionKey, chosen.uid)
      }

      // No live pin: rotate to the next ready account and pin it for this
      // conversation, so the *next* turn in the same conversation keeps it.
      if (chosen === undefined) {
        const rotating = chooseRotating(creds, cursor, cooldownUntilMs, now())
        if (rotating === undefined) throw new NotSignedInError()
        cursor = rotating.nextCursor
        chosen = rotating.credential
        pin(sessionKey, chosen.uid)
      }

      // A credential with no refresh token cannot be refreshed, so attempting
      // it would fail pointlessly. Serve it and let the upstream reject it,
      // which produces a clearer message ("sign in again") than a refresh
      // failure would.
      if (!needsRefresh(chosen, now())) return chosen

      // Expired or inside the margin: refresh, and re-read on success so the
      // caller gets the committed credential rather than our in-memory guess.
      const outcome = await refresh(chosen.uid)
      if (outcome.status === 'failed') {
        // Refresh failure is reported as a sign-in problem: retrying cannot
        // help, and the user's action is the same either way.
        throw new NotSignedInError(
          `账号 ${displayNameOf(chosen)} 的登录已失效，请重新执行 /wb-login。原因：${outcome.reason}`,
        )
      }
      const refreshed = await readCredential(credentialPath(chosen.uid))
      return refreshed ?? outcome.credential
    },

    noteFailure(uid: string, untilMs: number): void {
      cooldownUntilMs.set(uid, untilMs)
    },
  }
}

/** Remove one account. Phase 2's multi-account commands build on this. */
export async function removeAccount(uid: string): Promise<boolean> {
  return deleteCredential(uid)
}

/** Persist a freshly signed-in account. */
export async function saveAccount(credential: WorkBuddyCredential): Promise<string> {
  return writeCredential(credential)
}
