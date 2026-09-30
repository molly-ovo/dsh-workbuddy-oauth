/**
 * Stable device fingerprint derivation.
 *
 * ## Why this exists
 *
 * The upstream treats requests as coming from a physical device. A client that
 * invents a fresh machine id per process, or that sends none at all, looks like
 * a new device every launch — the pattern upstream risk control is built to
 * flag, and the one that gets multi-account setups correlated and blocked.
 *
 * The fix every mature project in this space converged on is the same:
 * **derive the id deterministically from the account uid**, so each account
 * always presents as one fixed device and different accounts present as
 * different devices. Same uid plus same purpose yields the same id forever,
 * across restarts and machines.
 *
 * ## Provenance
 *
 * The scheme (`md5("<salt>:<uid>")` truncated to 36 hex chars, with distinct
 * salts per purpose) matches the reference implementations this plugin is
 * modelled on — `workbuddy2api`'s `derive_id`, as carried by
 * `ardeyouxipianyi/workbuddy2api-hub` and rebuilt for Rust in
 * `NextAgentX/trae-workbuddy-switch`. Reusing the established derivation is
 * deliberate: it is what upstream has been serving without issue.
 *
 * ## Scope: fingerprints are NOT for the login flow
 *
 * Checked against all three reference implementations: the OAuth calls
 * (`auth/state`, `auth/token`, `login/account`) carry **only** the CLI user
 * agent and the region's `Origin`/`Referer`. No `X-Machine-ID`, no
 * `X-Session-ID`. Device headers appear on chat, billing and task endpoints.
 *
 * So this module is applied to outbound API calls and *not* to sign-in, which
 * also keeps a sign-in from being tied to a device identity it does not need.
 *
 * @module dsh-workbuddy-standalone/fingerprint
 */

import { createHash } from 'node:crypto'

/**
 * Namespace prefix for derived ids. Changing it would change every id, which
 * upstream would read as every account moving to a new device — leave it alone.
 */
const ID_NAMESPACE = 'wb2a'

/**
 * Length in hex characters of a derived id.
 *
 * MD5 yields 16 bytes, i.e. 32 hex characters. The reference project this
 * follows writes `md5(...).hexdigest()[:36]`, whose `[:36]` is a no-op on a
 * 32-character string — the whole digest is used, and that is what upstream
 * has been served. (A sibling Rust implementation uses SHA-256 truncated to
 * 18 bytes, also producing 36; the two differ, and this plugin follows the
 * MD5 line because the values observed working upstream come from it.)
 *
 * The value is asserted in tests, so this constant cannot drift unnoticed.
 */
const DERIVED_ID_HEX_LENGTH = 32

/**
 * Derive a stable identifier for one account and purpose.
 *
 * The uid is required: without one there is no stable basis, and returning a
 * constant would make every account share a device. Callers must therefore
 * skip the header entirely when the uid is empty, which is why this returns
 * `undefined` rather than a placeholder.
 *
 * @param purpose - What the id is for; `machine` and `session` are sent
 *   upstream. Distinct purposes must not collide, so the value is part of the
 *   hash input.
 * @param uid - The account's uid from the OAuth account endpoint.
 * @returns Hex characters of {@link DERIVED_ID_HEX_LENGTH}, or `undefined` when
 *   there is no uid.
 */
export function deriveId(purpose: string, uid: string): string | undefined {
  if (uid === '') return undefined
  return createHash('md5')
    .update(`${ID_NAMESPACE}:${purpose}:${uid}`, 'utf8')
    .digest('hex')
    .slice(0, DERIVED_ID_HEX_LENGTH)
}

/** The two device headers the upstream expects, for one account. */
export interface DeviceHeaders {
  'X-Machine-ID': string
  'X-Session-ID': string
}

/**
 * Build the device identity headers for one account.
 *
 * @returns The headers, or an empty object when `uid` is empty — sending a
 *   blank header is worse than sending none, because upstream would record a
 *   device with no identity.
 */
export function deviceHeaders(uid: string): DeviceHeaders | Record<string, never> {
  const machine = deriveId('machine', uid)
  const session = deriveId('session', uid)
  if (machine === undefined || session === undefined) return {}
  return { 'X-Machine-ID': machine, 'X-Session-ID': session }
}

/**
 * Derive a stable prefix for request ids.
 *
 * Upstream aggregates a conversation turn by request id. A random id per call
 * fragments one turn into many, which is visible in billing and is the symptom
 * the reference projects fixed with a stable prefix.
 */
export function requestIdPrefix(uid: string): string {
  return deriveId('req', uid) ?? 'wb2a-anonymous'
}

/**
 * A request id carrying a stable per-account prefix plus a unique suffix.
 *
 * @param uid - Account uid; an empty uid yields a shared `anonymous` prefix,
 *   which is acceptable here because the id still has to be unique per call.
 * @param now - Current epoch milliseconds, injectable for tests.
 */
export function requestId(uid: string, now: number = Date.now()): string {
  const suffix = String(now % 1_000_000).padStart(6, '0')
  return `${requestIdPrefix(uid)}-${suffix}`
}
