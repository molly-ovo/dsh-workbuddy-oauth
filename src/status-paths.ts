/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * Both halves are built independently (two tsdown entries), so everything they
 * must agree on lives here as literal values. A shared *expression* would be
 * one build-config drift away from the card asking a route the host never
 * mounted, and the failure mode — a card that silently shows nothing — is hard
 * to attribute.
 *
 * Deliberately free of `node:` imports: this module is reachable from the
 * browser bundle, where a value import of anything Node-specific would either
 * fail the bundle-purity gate or silently pull a polyfill.
 *
 * @module dsh-workbuddy-oauth/status-paths
 */

import type { WorkBuddyRegion } from './region.ts'
import type { WorkBuddyCredits, WorkBuddyEffort } from './upstream.ts'
import type { WorkBuddyProbeValidation } from './probe-store.ts'

export type { WorkBuddyCredits } from './upstream.ts'

/** Read-only status endpoint consumed by this plugin's browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy-oauth/status'

/**
 * State-changing control endpoint.
 *
 * Separate from the status route because it accepts writes. The status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing an action — any local process can write
 * `Host: 127.0.0.1`. A route that spends the user's credit therefore also
 * requires the in-process key handed to the browser with the status document.
 *
 * **One path per region, and that is a correctness requirement, not tidiness.**
 * The two regions each own a probe store and a probe service, and
 * `webServer.register` *throws* on a duplicate path — so registering both at one
 * path would abort the second registration and, with it, that region's control
 * surface. The browser reaches the right one because the card knows which region
 * a model belongs to before it asks to probe it.
 *
 * Literal strings rather than a computed suffix: the two halves are built
 * independently, and a shared *expression* is one build-config drift away from
 * the card asking a route the host never mounted.
 */
export const WORKBUDDY_CONTROL_PATH = '/plugins/dsh-workbuddy-oauth/control'

/** Control endpoint for the international region. */
export const WORKBUDDY_AI_CONTROL_PATH = '/plugins/dsh-workbuddy-oauth/ai/control'

/** The control path for one region. */
export function controlPathFor(region: WorkBuddyRegion): string {
  return region === 'global' ? WORKBUDDY_AI_CONTROL_PATH : WORKBUDDY_CONTROL_PATH
}

/** Header carrying the in-process control key on a control request. */
export const WORKBUDDY_CONTROL_KEY_HEADER = 'x-workbuddy-oauth-key'

/** One signed-in account, as the card displays it. */
export interface WorkBuddyWebAccount {
  uid: string
  label: string
  region: WorkBuddyRegion
  /** Access-token expiry, epoch milliseconds. */
  expiresAtMs: number
  /**
   * Whether this account may serve requests.
   *
   * Carried so the card can label the state without holding a second copy of the
   * enable/disable rule; a disabled account is still listed, because it is still
   * signed in.
   */
  enabled: boolean
}

/** One model as the card's model list and probe picker need it. */
export interface WorkBuddyWebModel {
  id: string
  name: string
  /** Declared context window, tokens. */
  contextWindow: number
  /** Declared max output tokens. */
  maxTokens: number
  /**
   * Whether this model declares more than one context window.
   *
   * The card needs it to show which rows the maximum-window switch actually
   * changes, and to decide whether to offer that switch at all: a region whose
   * models all declare a single window cannot be affected by the flag, so the
   * control would appear to do nothing there.
   */
  multiWindow: boolean
}

/** One model's recorded probe observation. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: WorkBuddyProbeValidation
  efforts: readonly WorkBuddyEffort[]
  probedAt: number
}

/** One region's slice of the status document. */
export interface WorkBuddyWebRegion {
  region: WorkBuddyRegion
  /** Human label, e.g. `WorkBuddy (国内版)`. */
  label: string
  /**
   * Control-route path for this region's probe actions.
   *
   * Carried in the document rather than recomputed by the card: the path is a
   * host-side routing decision, and a card that derived it independently would
   * be one rename away from posting into a 404.
   */
  controlPath: string
  /**
   * The provider id this region registers under.
   *
   * Carried in the document rather than recomputed by the card: the two bundles
   * are built independently, so a provider id spelled twice is one build-config
   * drift away from the card filtering for a group that does not exist.
   */
  providerId: string
  /**
   * Whether this region has a usable credential.
   *
   * Carried explicitly rather than inferred from `models.length`: an account
   * whose catalog fetch has not landed yet has a credential and no live roster,
   * and the card must not report that as "signed out".
   */
  signedIn: boolean
  /**
   * Models this region currently exposes. Empty while signed out *and* while a
   * signed-in account's first fetch is still in flight — `signedIn`
   * distinguishes the two.
   */
  models: readonly WorkBuddyWebModel[]
  /**
   * Model ids the user has hidden from the picker, for this region.
   *
   * Carried so the card can render the checkbox state without holding a second
   * copy of the rule; the host already filters these out of `models`, so the
   * card only needs the ids to know which boxes to tick.
   */
  hiddenModels: readonly string[]
  /**
   * Whether the user chose the largest declared context window for this region.
   *
   * Carried so the card can render the checkbox state without holding a second
   * copy of the rule. Only the international region declares
   * `supportedContextWindows`, so this is meaningful there; the CN region still
   * reports the same global flag for a uniform card layout.
   */
  useMaximumContextWindow: boolean
  /** Whether a probe sweep is in flight for this region right now. */
  probeRunning: boolean
  /**
   * Models the user could probe by hand: reasoning-capable rows the upstream
   * left undeclared, which is exactly the set that gets no level picker
   * without an observation.
   */
  probeCandidates: readonly string[]
  /** Recorded observations, newest first. */
  probeResults: readonly WorkBuddyWebProbeModel[]
}

/** The document the browser half reads. */
export interface WorkBuddyWebStatus {
  /** Discriminator. The card refuses anything else rather than dereferencing it. */
  status: 'ok'
  /** Plugin version, so a stale card can be told from a stale host. */
  version: string
  accounts: readonly WorkBuddyWebAccount[]
  regions: readonly WorkBuddyWebRegion[]
  /**
   * The in-process control key.
   *
   * Travels on this read-only, loopback-guarded response because that is the
   * only way the same-origin card can learn it; it authorizes control actions
   * only, never credentials or completions.
   */
  controlKey: string
}

/** Result of one control action; `reason` is a short human-readable detail. */
export interface WorkBuddyControlResult {
  state: string
  reason?: string
  /**
   * Authorization URL for `login-begin`.
   *
   * Returned to the card rather than logged host-side: the whole point of the
   * card's sign-in flow is that the user never copies a link out of a log.
   */
  url?: string
  /** Login attempt id for `login-begin`, to be handed back to `login-complete`. */
  loginState?: string
  /**
   * Credit balance for `refresh-credits`.
   *
   * Returned rather than logged host-side so the card can show it immediately
   * after a balance refresh, without a second status round-trip.
   */
  credits?: WorkBuddyCredits
}
