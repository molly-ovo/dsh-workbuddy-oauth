/**
 * Shared browser-side helpers: reading the host status document and the control
 * route.
 *
 * Both the settings card and the reasoning-level control read the same route, so
 * the shape check and the POST helper live here rather than being duplicated —
 * a second copy is how the two halves start disagreeing about what a valid
 * document is.
 *
 * @module dsh-workbuddy-oauth/client/host
 */

import {
  WORKBUDDY_STATUS_PATH,
  WORKBUDDY_CONTROL_KEY_HEADER,
  type WorkBuddyControlResult,
  type WorkBuddyCredits,
  type WorkBuddyWebRegion,
  type WorkBuddyWebStatus,
} from '../status-paths.ts'

/**
 * Whether a parsed response really is a status document.
 *
 * A 200 is not a promise about the body: it may be empty, literal `null`, a
 * non-JSON page from a proxy, or an array. Storing an unchecked value would put
 * something in React state that the next render dereferences.
 */
export function isWorkBuddyWebStatus(value: unknown): value is WorkBuddyWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapped = value as Record<string, unknown>
  if (wrapped['status'] !== 'ok') return false
  if (typeof wrapped['controlKey'] !== 'string') return false
  return Array.isArray(wrapped['regions']) && Array.isArray(wrapped['accounts'])
}

/** Read the status document, or `undefined` when it is unavailable or malformed. */
export async function readStatus(signal?: AbortSignal): Promise<WorkBuddyWebStatus | undefined> {
  try {
    const response = await fetch(WORKBUDDY_STATUS_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const value: unknown = await response.json().catch(() => undefined)
    return isWorkBuddyWebStatus(value) ? value : undefined
  } catch {
    // A transport failure degrades to "no status", which every caller renders as
    // an empty card rather than an error page.
    return undefined
  }
}

/** One control action, as the body the route parses. */
export type ControlRequest =
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

/**
 * POST one control action.
 *
 * Resolves to the parsed result, or `undefined` when the request failed — the
 * callers all report failure in their own surface rather than throwing into a
 * React event handler, where nothing would catch it.
 */
export async function sendControl(
  path: string,
  key: string,
  body: ControlRequest,
): Promise<WorkBuddyControlResult | undefined> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', [WORKBUDDY_CONTROL_KEY_HEADER]: key },
      body: JSON.stringify(body),
    })
    if (!response.ok) return undefined
    const value: unknown = await response.json().catch(() => undefined)
    if (typeof value !== 'object' || value === null) return undefined
    const wrapped = value as Record<string, unknown>
    if (typeof wrapped['state'] !== 'string') return undefined
    return {
      state: wrapped['state'],
      ...typeof wrapped['reason'] === 'string' ? { reason: wrapped['reason'] } : {},
      ...typeof wrapped['url'] === 'string' ? { url: wrapped['url'] } : {},
      ...typeof wrapped['loginState'] === 'string' ? { loginState: wrapped['loginState'] } : {},
      // Credits ride on the refresh-credits answer; a hand-maintained field list
      // is exactly how this answer lost them the first time (the card showed
      // "查询失败: credits" for a request that had succeeded). The structural
      // check below is the contract, not a field list to extend by hand.
      ...isCreditsShape(wrapped['credits']) ? { credits: wrapped['credits'] } : {},
    }
  } catch {
    return undefined
  }
}

/** Whether a value is a usable credit answer (total plus its package list). */
function isCreditsShape(value: unknown): value is WorkBuddyCredits {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WorkBuddyCredits>
  if (typeof candidate['total'] !== 'number' || !Number.isFinite(candidate['total'])) return false
  return Array.isArray(candidate['accounts'])
}

/** Find the region a provider id belongs to, or `undefined` for another plugin's model. */
export function regionOfProvider(status: WorkBuddyWebStatus, provider: string): WorkBuddyWebRegion | undefined {
  return status.regions.find(region => region.providerId === provider)
}
