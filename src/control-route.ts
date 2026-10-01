/**
 * The plugin's state-changing control route.
 *
 * Two guards, because they stop different things:
 *
 * 1. **Loopback Host + Origin**, shared with the status route. This drops
 *    DNS-rebinding pages, whose requests arrive addressed to the attacker's
 *    domain.
 * 2. **An in-process random key**, minted per process and handed only to the
 *    same-origin card through the status document. Loopback alone is *not*
 *    authentication — any local process can write `Host: 127.0.0.1` — so a
 *    route that spends the user's credit must prove the caller was told the
 *    key.
 *
 * A probe request is never accepted with a prompt, a model id outside the live
 * catalog, or a sentinel from the browser: it is assembled entirely host-side.
 *
 * Ported from `dsh-workbuddy-connect` (MIT), reduced to the actions this plugin
 * actually offers — the visibility and context-window actions belong to phases
 * this plugin has not reached, and carrying their branches would mean shipping
 * routes that answer 404 by construction.
 *
 * @module dsh-workbuddy-oauth/control-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import {
  WORKBUDDY_CONTROL_KEY_HEADER,
  WORKBUDDY_CONTROL_PATH,
  type WorkBuddyControlResult,
} from './status-paths.ts'

/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** One action the browser may ask for. */
export type WorkBuddyControlAction =
  | { action: 'probe'; model: string }
  | { action: 'clear' }
  | { action: 'refresh' }
  | { action: 'login-begin'; region: string }
  | { action: 'login-complete'; state: string }
  | { action: 'logout'; uid: string }
  | { action: 'set-account-enabled'; uid: string; enabled: boolean }
  | { action: 'set-model-visible'; region: string; modelId: string; visible: boolean }
  | { action: 'set-maximum-context-window'; enabled: boolean }
  | { action: 'refresh-credits'; uid: string }

/** Constructor dependencies. */
export interface WorkBuddyControlRouteOptions {
  /**
   * Run a probe for one model. Resolves to a short status, never a raw upstream
   * body.
   */
  probe: (modelId: string) => Promise<WorkBuddyControlResult>
  /** Drop every recorded observation. */
  clear: () => void
  /** Re-read the credential and re-fetch the model catalog. */
  refresh?: () => Promise<WorkBuddyControlResult>
  /**
   * Ask the upstream for an authorization URL.
   *
   * The card drives the same OAuth exchange the `/wb-login` command does; this
   * route is only a transport, so both surfaces cannot drift into two different
   * login implementations.
   */
  loginBegin?: (region: string) => Promise<WorkBuddyControlResult>
  /**
   * Redeem an authorization: succeeds once the user has approved upstream, and
   * reports `pending` while they have not.
   */
  loginComplete?: (state: string) => Promise<WorkBuddyControlResult>
  /**
   * Delete one stored credential.
   *
   * The card's counterpart to `/wb-logout`. The host owns the deletion so the
   * command and the card cannot disagree about what signing out means.
   */
  logout?: (uid: string) => Promise<WorkBuddyControlResult>
  /**
   * Enable or disable one account without deleting it.
   *
   * The card's counterpart to `/wb-account enable|disable`: reversible, unlike
   * {@link logout}.
   */
  setAccountEnabled?: (uid: string, enabled: boolean) => Promise<WorkBuddyControlResult>
  /**
   * Hide or show one model for a region.
   *
   * The card's counterpart to the hidden-models rule; the host owns the
   * persistence and the catalog filtering, so the picker and the checkbox cannot
   * disagree about what is hidden.
   */
  setModelVisible?: (region: string, modelId: string, visible: boolean) => Promise<WorkBuddyControlResult>
  /**
   * Select or clear the largest-declared-context-window preference.
   *
   * The card's counterpart to the catalog's `setUseMaximumContextWindow`; the
   * host owns the persistence and the catalog flag, so the picker and the
   * checkbox cannot disagree.
   */
  setMaximumContextWindow?: (enabled: boolean) => Promise<WorkBuddyControlResult>
  /**
   * Fetch one account's credit balance.
   *
   * The card's counterpart to P5.1; returns the balance in `credits` rather than
   * storing it host-side, so the card shows it immediately after a refresh
   * without a second status round-trip.
   */
  refreshCredits?: (uid: string) => Promise<WorkBuddyControlResult>
  /** Route path to mount; defaults to {@link WORKBUDDY_CONTROL_PATH}. */
  path?: string
}

/** Mint the per-process control key. */
export function createControlKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text: string): WorkBuddyControlAction | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'clear') return { action: 'clear' }
  // No payload: the region is already known from the route the request arrived
  // on, so the browser cannot ask this route to refresh a different provider.
  if (action === 'refresh') return { action: 'refresh' }
  if (action === 'probe') {
    const model = wrapped['model']
    if (typeof model !== 'string' || model.trim() === '') return undefined
    return { action: 'probe', model: model.trim() }
  }
  if (action === 'login-begin') {
    // The region is validated host-side against the known set, not passed
    // through: it selects an upstream host, so an arbitrary string would let the
    // browser point the plugin at another origin.
    const region = wrapped['region']
    if (region !== 'cn' && region !== 'global') return undefined
    return { action: 'login-begin', region }
  }
  if (action === 'login-complete') {
    const state = wrapped['state']
    if (typeof state !== 'string' || state.trim() === '') return undefined
    return { action: 'login-complete', state: state.trim() }
  }
  if (action === 'logout') {
    // A uid is required and must be non-empty: an absent one would otherwise be
    // read as "delete everything", which is the opposite of a targeted action.
    const uid = wrapped['uid']
    if (typeof uid !== 'string' || uid.trim() === '') return undefined
    return { action: 'logout', uid: uid.trim() }
  }
  if (action === 'set-account-enabled') {
    const uid = wrapped['uid']
    if (typeof uid !== 'string' || uid.trim() === '') return undefined
    const enabled = wrapped['enabled']
    if (typeof enabled !== 'boolean') return undefined
    return { action: 'set-account-enabled', uid: uid.trim(), enabled }
  }
  if (action === 'set-model-visible') {
    const region = wrapped['region']
    if (region !== 'cn' && region !== 'global') return undefined
    const modelId = wrapped['modelId']
    if (typeof modelId !== 'string' || modelId.trim() === '') return undefined
    const visible = wrapped['visible']
    if (typeof visible !== 'boolean') return undefined
    return { action: 'set-model-visible', region, modelId: modelId.trim(), visible }
  }
  if (action === 'set-maximum-context-window') {
    const enabled = wrapped['enabled']
    if (typeof enabled !== 'boolean') return undefined
    return { action: 'set-maximum-context-window', enabled }
  }
  if (action === 'refresh-credits') {
    const uid = wrapped['uid']
    if (typeof uid !== 'string' || uid.trim() === '') return undefined
    return { action: 'refresh-credits', uid: uid.trim() }
  }
  return undefined
}

/**
 * The control route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 */
export function workBuddyControlHandler(
  deps: WorkBuddyControlRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers[WORKBUDDY_CONTROL_KEY_HEADER] as string | undefined)) {
      json(res, 403, { error: 'invalid-control-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const action = parseAction(body)
    if (action === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      if (action.action === 'clear') {
        deps.clear()
        json(res, 200, { state: 'cleared' })
        return
      }
      if (action.action === 'refresh') {
        if (deps.refresh === undefined) {
          json(res, 404, { error: 'refresh-not-supported' })
          return
        }
        json(res, 200, await deps.refresh())
        return
      }
      if (action.action === 'login-begin') {
        if (deps.loginBegin === undefined) {
          json(res, 404, { error: 'login-not-supported' })
          return
        }
        json(res, 200, await deps.loginBegin(action.region))
        return
      }
      if (action.action === 'login-complete') {
        if (deps.loginComplete === undefined) {
          json(res, 404, { error: 'login-not-supported' })
          return
        }
        json(res, 200, await deps.loginComplete(action.state))
        return
      }
      if (action.action === 'logout') {
        if (deps.logout === undefined) {
          json(res, 404, { error: 'logout-not-supported' })
          return
        }
        json(res, 200, await deps.logout(action.uid))
        return
      }
      if (action.action === 'set-account-enabled') {
        if (deps.setAccountEnabled === undefined) {
          json(res, 404, { error: 'account-toggle-not-supported' })
          return
        }
        json(res, 200, await deps.setAccountEnabled(action.uid, action.enabled))
        return
      }
      if (action.action === 'set-model-visible') {
        if (deps.setModelVisible === undefined) {
          json(res, 404, { error: 'model-visibility-not-supported' })
          return
        }
        json(res, 200, await deps.setModelVisible(action.region, action.modelId, action.visible))
        return
      }
      if (action.action === 'set-maximum-context-window') {
        if (deps.setMaximumContextWindow === undefined) {
          json(res, 404, { error: 'context-window-not-supported' })
          return
        }
        json(res, 200, await deps.setMaximumContextWindow(action.enabled))
        return
      }
      if (action.action === 'refresh-credits') {
        if (deps.refreshCredits === undefined) {
          json(res, 404, { error: 'credits-not-supported' })
          return
        }
        json(res, 200, await deps.refreshCredits(action.uid))
        return
      }
      json(res, 200, await deps.probe(action.model))
    } catch (error: unknown) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Mount the POST control route on an optional webServer context. */
export function registerWorkBuddyControlRoute(
  ctx: Context,
  deps: WorkBuddyControlRouteOptions,
  key: string,
): void {
  const path = deps.path ?? WORKBUDDY_CONTROL_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: workBuddyControlHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-oauth: control route')
}
