import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import { PiAiAdapter, PiAiAdapterOptions } from "@deepseek-ai/dsh-llm-pi-ai";
import { IncomingMessage, ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/region.d.ts
/**
 * Region (realm) definitions for the two WorkBuddy deployments.
 *
 * Kept as a first-class concept from day one: the domestic and international
 * services are separate account systems with separate quotas, and their
 * catalog endpoints behave differently. A plugin that hard-codes one of them
 * cannot be extended to the other without a rewrite.
 *
 * Endpoint table mirrors the upstream `realmConfig` used by the official CLI:
 * the CN API host and the CN web origin are deliberately *different* domains,
 * and the login endpoints check `Origin`.
 *
 * @module dsh-workbuddy-oauth/region
 */
/** Which WorkBuddy deployment a credential belongs to. */
type WorkBuddyRegion = 'cn' | 'global';
/** Upstream endpoints for one region. */
interface RegionEndpoints {
  /** API base: chat, catalog and billing endpoints hang off this. */
  base: string;
  /** Web origin used for `Origin` / `Referer`. */
  origin: string;
  /**
   * Host the OAuth sign-in flow must be driven against, when it differs from
   * {@link base}.
   *
   * Measured: the state endpoint echoes the host it was called on into the
   * authorization URL it returns, and the login page a state is issued for is
   * host-scoped — so the URL the user opens, and every follow-up call for that
   * state, has to sit on one host. The desktop app opens `www.workbuddy.cn` with
   * `platform=workbuddy`, and phone-number sign-in on a `copilot.tencent.com`
   * URL is rejected with `无效的token`. `base` stays the API host because chat
   * and catalog are served from there.
   */
  loginBase: string;
  /** Human label for status output. */
  label: string;
}
/**
 * Endpoint table.
 *
 * CN's `base` and `origin` are different domains on purpose — the upstream
 * validates `Origin` against the web site while serving the API from the
 * copilot host. Do not "tidy" these into one value. `loginBase` is a third host
 * for the same reason; see {@link RegionEndpoints.loginBase}.
 */
declare function regionEndpoints(region: WorkBuddyRegion): RegionEndpoints;
/**
 * Infer the region from a credential's `domain` field.
 *
 * The upstream returns a bare domain (e.g. `workbuddy.ai`), so this matches on
 * the suffix rather than equality.
 *
 * @param domain - Domain reported by the upstream credential.
 * @returns The region that domain belongs to; defaults to `cn`.
 */
declare function regionOfDomain(domain: string): WorkBuddyRegion;
/** Both regions, for iteration in status output. */
declare const ALL_REGIONS: readonly WorkBuddyRegion[];
//#endregion
//#region src/oauth.d.ts
/** Authorization has not completed yet — retryable, not a fault. */
declare class LoginPendingError extends Error {
  constructor(message?: string);
}
/** Sign-in has not started or the state expired — the caller must restart. */
declare class LoginExpiredError extends Error {
  constructor(message?: string);
}
/** Result of the first step: the URL the user must open. */
interface AuthorizationRequest {
  region: WorkBuddyRegion;
  state: string;
  url: string;
}
/** Token bundle as returned by the token endpoint. */
interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  /** Lifetime in **seconds**, relative to the moment the token was issued. */
  expiresIn: number;
  domain: string;
}
/** Account identity reported alongside the token. */
interface AccountInfo {
  uid: string;
  enterpriseId: string;
  nickname: string;
}
/** Everything a completed sign-in produces. */
interface LoginResult {
  region: WorkBuddyRegion;
  token: TokenBundle;
  account: AccountInfo;
}
/** Minimal fetch shape, so tests can inject a stub. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Injectable options. */
interface LoginClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Clock, injectable so the TTL and poll-cadence rules are testable without
   * sleeping.
   */
  now?: () => number;
  /** Override the poll floor. Tests lower it; production should not. */
  minPollIntervalMs?: number;
  /** Override the state lifetime. */
  loginTtlMs?: number;
}
/**
 * Drives the device-code flow.
 *
 * The three calls are split rather than wrapped in one `login()` because the
 * browser step happens between `begin` and `poll`, and a slash command must be
 * able to print the URL, return, and poll on the user's next invocation.
 */
declare class LoginClient {
  private readonly fetchImpl;
  private readonly timeoutMs;
  private readonly now;
  private readonly minPollIntervalMs;
  private readonly loginTtlMs;
  /**
   * Live attempts, keyed by state.
   *
   * Tracking these locally is what makes the safety rules enforceable: the TTL
   * needs a creation time, the cadence floor needs a last-poll time, and
   * knowing the region a state belongs to is what stops a poll from being sent
   * to the wrong region's host (which the upstream would see as a token for one
   * service being redeemed at another).
   */
  private readonly pending;
  constructor(options?: LoginClientOptions);
  /**
   * Perform one JSON call and unwrap the envelope.
   *
   * @throws LoginPendingError - upstream says the user has not authorized yet.
   * @throws Error - any other failure, including a malformed body.
   */
  private call;
  /** Step 1 — ask the upstream for a `state` and the authorization URL. */
  begin(region: WorkBuddyRegion): Promise<AuthorizationRequest>;
  /**
   * Resolve a state to its live attempt, enforcing the lifetime.
   *
   * @throws LoginExpiredError - unknown state, or past {@link LOGIN_TTL_MS}.
   */
  private requirePending;
  /**
   * Step 2 — poll for the token.
   *
   * The region is taken from the recorded attempt rather than a caller
   * argument, so a state can only ever be redeemed at the host that issued it.
   * `workbuddy2api` stores the realm alongside the state for exactly this
   * reason (its `validateRealmMatch`).
   *
   * @throws LoginExpiredError - unknown or timed-out state.
   * @throws LoginPendingError - polled again too soon, or the user has not
   *   finished authorizing.
   */
  poll(state: string): Promise<TokenBundle>;
  /** Step 3 — read the account identity bound to this authorization. */
  account(state: string, accessToken: string): Promise<AccountInfo>;
  /**
   * Poll and read the account in one step, then retire the state.
   *
   * The state is deleted only on success: a pending result must leave it in
   * place so the user can come back and poll again after finishing in the
   * browser.
   *
   * @throws LoginExpiredError - unknown or timed-out state.
   * @throws LoginPendingError - authorization has not completed.
   * @throws Error - the token arrived but carries no `uid`, which makes the
   *   credential unusable (every upstream call needs it).
   */
  complete(state: string): Promise<LoginResult>;
}
/** Normalize a user-supplied region argument, accepting `1`/`cn`/`2`/`global`. */
declare function parseRegionInput(input: string): WorkBuddyRegion | undefined;
//#endregion
//#region src/credentials.d.ts
/** A normalized credential, timestamps in epoch milliseconds. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  /** When {@link accessToken} stops being valid. */
  expiresAtMs: number;
  /** When {@link refreshToken} stops being usable, when the upstream reports it. */
  refreshExpiresAtMs?: number;
  /** Upstream domain, used to derive the region and as an outbound header. */
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  region: WorkBuddyRegion;
}
/**
 * List every stored credential.
 *
 * Unreadable or unparsable files are skipped rather than failing the listing:
 * a single damaged account must not hide the healthy ones.
 */
declare function listCredentials(): Promise<readonly WorkBuddyCredential[]>;
/**
 * Convert a completed login into a storable credential.
 *
 * `expiresIn` arrives in seconds and `now` in milliseconds, so the conversion
 * happens exactly here.
 *
 * @param result - Output of {@link LoginClient.complete}.
 * @param now - Current time in epoch milliseconds; injectable for tests.
 */
declare function credentialFromLogin(result: LoginResult, now?: number): WorkBuddyCredential;
/**
 * Mask any mobile number inside a display name.
 *
 * Applied at the *display* boundary only: the credential file keeps the real
 * nickname, so nothing is lost and a later feature can still use it. A name that
 * merely contains a number — `张三 13800138000` — is masked in place, because
 * redacting only exact matches would leak the common case.
 *
 * A country-code prefix the user typed is kept (`+86` is not personal data); only
 * the number itself is redacted.
 *
 * @param text - the raw display name.
 * @returns the name with every mobile number reduced to `2 digits + stars + 2`.
 */
declare function maskPhoneNumbers(text: string): string;
/**
 * Human-readable account label for status output.
 *
 * The nickname is masked rather than returned raw: an account nicknamed with its
 * own phone number or email address would otherwise be printed verbatim by every
 * command, the settings card, and the status document.
 */
declare function displayNameOf(credential: WorkBuddyCredential): string;
//#endregion
//#region src/version.d.ts
/**
 * Build-time injected plugin version.
 *
 * `tsdown.config.ts` defines `__DSH_WORKBUDDY_OAUTH_VERSION__` from
 * package.json. The declare + fallback keeps `tsc --noEmit` and vitest working
 * on source that has not been through the bundler.
 *
 * @module dsh-workbuddy-oauth/version
 */
/** Version of this plugin, as published in package.json. */
declare const PLUGIN_VERSION: string;
//#endregion
//#region src/fingerprint.d.ts
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
 * @module dsh-workbuddy-oauth/fingerprint
 */
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
declare function deriveId(purpose: string, uid: string): string | undefined;
/** The two device headers the upstream expects, for one account. */
interface DeviceHeaders {
  'X-Machine-ID': string;
  'X-Session-ID': string;
}
/**
 * Build the device identity headers for one account.
 *
 * @returns The headers, or an empty object when `uid` is empty — sending a
 *   blank header is worse than sending none, because upstream would record a
 *   device with no identity.
 */
declare function deviceHeaders(uid: string): DeviceHeaders | Record<string, never>;
/**
 * A request id carrying a stable per-account prefix plus a unique suffix.
 *
 * @param uid - Account uid; an empty uid yields a shared `anonymous` prefix,
 *   which is acceptable here because the id still has to be unique per call.
 * @param now - Current epoch milliseconds, injectable for tests.
 */
declare function requestId(uid: string, now?: number): string;
//#endregion
//#region src/refresh.d.ts
/** Outcome of a refresh attempt. */
type RefreshOutcome = {
  status: 'refreshed';
  credential: WorkBuddyCredential;
} | {
  status: 'not-needed';
  credential: WorkBuddyCredential;
} | {
  status: 'failed';
  reason: string;
};
/** Injectable collaborators, so the logic is testable without a network. */
interface RefreshDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
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
declare function refreshCredential(uid: string, deps?: RefreshDeps): Promise<RefreshOutcome>;
//#endregion
//#region src/store.d.ts
/** Thrown when no usable credential exists; the shim maps this to HTTP 401. */
declare class NotSignedInError extends Error {
  constructor(message?: string);
}
/** What the ported code needs from a credential store. */
interface CredentialStore {
  /**
   * Resolve the credential to serve the next request; refreshes if needed.
   *
   * @param sessionKey - optional conversation identity. When given, and an
   *   account is already pinned to it and still selectable, that account wins —
   *   so one conversation keeps one account instead of hopping mid-turn.
   */
  resolve(sessionKey?: string): Promise<WorkBuddyCredential>;
  /** The current credential without refreshing, or `undefined` when none. */
  current(): Promise<WorkBuddyCredential | undefined>;
  /**
   * Mark one account as failed, cooling it out of selection until `untilMs`.
   *
   * The store does not decide *how long* a failure cools an account — it only
   * records the deadline, so it needs no knowledge of the upstream's error
   * vocabulary. The shim (which already classifies upstream failures) computes
   * the deadline and hands it over.
   */
  noteFailure(uid: string, untilMs: number): void;
}
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
declare function chooseRotating(credentials: readonly WorkBuddyCredential[], cursor: number, cooldownUntilMs: ReadonlyMap<string, number>, now?: number): {
  credential: WorkBuddyCredential;
  nextCursor: number;
} | undefined;
/** Options for {@link createCredentialStore}. */
interface CredentialStoreOptions {
  /**
   * Region this store serves.
   *
   * Each region gets its own store because a credential is only valid against
   * its own upstream host. Without this filter a domestic and an international
   * account would be interchangeable to a store, and the shim would present the
   * wrong region's token.
   */
  region?: WorkBuddyRegion;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Refresh hook, injectable for tests. Defaults to {@link refreshCredential}. */
  refresh?: typeof refreshCredential;
}
/**
 * Build the credential store the ported shim and adapter consume.
 *
 * `resolve()` refreshes when the chosen token is at or near expiry, and
 * reports {@link NotSignedInError} when nothing is stored — the shim turns that
 * into a 401 carrying the message, so an unconfigured install reports "sign in"
 * rather than an opaque failure.
 */
declare function createCredentialStore(options?: CredentialStoreOptions): CredentialStore;
//#endregion
//#region src/cooldown-state.d.ts
/**
 * Persisted failure cooldowns.
 *
 * The cooldown map (`uid → cool-until epoch ms`) lives in memory while the
 * process runs. This module adds a write-through disk copy so a DSH restart does
 * not resurrect a cooled account: an account that exhausted its credit an hour
 * ago must not be retried on the next start, because the failure it would hit is
 * exactly the one the cooldown exists to avoid.
 *
 * Deliberately **not** persisted: the rotation cursor (restarting from account
 * one is harmless) and session affinity (a 30-minute TTL that a restart exceeds
 * anyway — conversations do not survive a host restart).
 *
 * The file is read when the store is built and on every write, so two DSH
 * windows stay consistent the same way the disabled set is.
 *
 * @module dsh-workbuddy-oauth/cooldown-state
 */
/** Name of the state file inside the plugin state directory. */
declare const COOLDOWN_STATE_FILENAME = "cooldowns.json";
/** Read the persisted map, dropping entries that have already expired. */
declare function readCooldowns(now?: number): Promise<Map<string, number>>;
/**
 * Merge one entry into the persisted map atomically.
 *
 * Read-modify-write under a file lock so a toggle made in another DSH window is
 * not lost, mirroring {@link ../account-state.ts!setAccountDisabled}. A failed
 * write is reported to the caller's catch and never thrown: losing a
 * persistence update must not break the request that produced it.
 *
 * All three paths are computed **before the first await**, for the same reason
 * {@link readCooldowns} captures its path up front: this function is usually
 * called fire-and-forget, so its later awaits routinely outlive the environment
 * (and `DSH_HOME`) it was called under.
 */
declare function writeCooldown(uid: string, untilMs: number, now?: number): Promise<void>;
//#endregion
//#region src/identity.d.ts
/** The identity a chat request presents as. */
interface ChatIdentity {
  /** Desktop-app version; drives the desktop User-Agent and `X-IDE-Version`. */
  clientVersion: string;
  /** Bundled agent-CLI version; absent drops the `CLI/…` token. */
  cliVersion?: string;
}
/** The identity a catalog request presents as. */
interface AppVersionInfo {
  version: string;
  source: 'config' | 'fallback';
}
/** Where the identity values come from. Every field is optional. */
interface IdentityConfig {
  /** Desktop-app version to claim. */
  appVersion?: string;
  /** CLI version to claim; omit to drop the `CLI/…` token. */
  cliVersion?: string;
}
//#endregion
//#region src/probe.d.ts
/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
declare const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyEffort[];
/** Sentinel generator; injectable so tests get deterministic values. */
type SentinelFactory = () => string;
/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  /** True when a parseable SSE event arrived. */
  streamed: boolean;
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string;
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string;
}
/** How one attempt is performed; the caller owns credentials and HTTP. */
type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>;
/** The outcome of probing one model. */
type ProbeOutcome = {
  validation: 'validating';
  efforts: readonly WorkBuddyEffort[];
  requests: number;
} | {
  validation: 'non-validating';
  efforts: readonly [];
  requests: number;
} | {
  validation: 'unknown';
  efforts: readonly [];
  requests: number;
  reason: string;
};
/**
 * Which endpoint's rejection vocabulary a probe interprets.
 *
 * The two apps talk to different upstreams, and those upstreams answer a bad
 * `reasoning_effort` with *different* codes. Reading one shared set would widen
 * attribution on the endpoint where a code was never observed.
 */
type ProbeRegion = 'cn' | 'global';
/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}. `options.region` selects which
 * endpoint's rejection vocabulary is read; it defaults to `cn`, matching the
 * China app that was the first target.
 */
declare function probeModel(options: {
  send: ProbeSender;
  sentinel?: SentinelFactory;
  candidates?: readonly WorkBuddyEffort[];
  timeoutMs?: number;
  region?: ProbeRegion;
}): Promise<ProbeOutcome>;
//#endregion
//#region src/upstream.d.ts
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** One CLI-usable model as the upstream catalog describes it. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  /** The upstream's preferred window before an optional maximum is selected. */
  defaultContextWindow?: number;
  maxInputTokens?: number;
  supportedContextWindows?: readonly number[];
  promotions?: readonly WorkBuddyPromotion[];
  maxTokens: number;
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean;
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire
   * effort values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto
   * pi-ai's thinking levels, and the supported set decides which levels the
   * DSH model selector offers.
   */
  reasoning?: WorkBuddyModelReasoning;
  /**
   * Billing convenience metadata: the credits multiplier string the upstream
   * reports (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000` or `badge:夜间折扣:#1E90FF`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a
   * language-neutral display form (`x0.79`) that reads the same in every UI
   * language. The raw upstream string (which may spell `x0.79 credits`) stays
   * on {@link WorkBuddyModelBilling.credits} for diagnostics.
   */
  billing?: WorkBuddyModelBilling;
}
/** Reasoning metadata the upstream catalog declares for one model. */
interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean;
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort;
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean;
}
/** The concrete effort spellings WorkBuddy exposes on the wire. */
type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Billing convenience metadata reported for one model. */
interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
  /**
   * The rate cannot be stated for this model right now.
   *
   * Set when a row that arrived with promotions attached has no promotion in
   * force: the upstream bakes the discounted value into `credits`, so the
   * cached rate describes a discount that has ended. The original price is not
   * recoverable from the row, so the plugin reports "unknown, refresh needed"
   * rather than repeating a figure it can no longer stand behind — in
   * particular it never keeps claiming the model is free.
   */
  rateUnknown?: boolean;
}
/** One billing package and its remaining credit. */
interface WorkBuddyCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  unlimited?: true;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  accounts: readonly WorkBuddyCreditAccount[];
  /**
   * The account's cycle quota is uncapped (`limitNum === -1` on the CN
   * enterprise endpoint).
   *
   * A separate flag rather than a `-1`/`0` sentinel in {@link total}: the two
   * mean opposite things to a reader ("no limit" vs "nothing left"), and the
   * existing negative-clamp in the personal branch would turn a sentinel into
   * a plausible-looking zero. Every renderer must therefore test this flag
   * first and not fall back to `total` when it is set.
   */
  unlimited?: true;
  cycleResetTime?: string;
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
};
/** Provenance of one successful catalog fetch, surfaced by the status card. */
interface WorkBuddyCatalogFetch {
  fetchedAtMs: number;
  /** Which document answered, e.g. `workbuddy-ai:app`. */
  source: string;
  /** UA version used, when the request needed one. */
  appVersion?: AppVersionInfo;
}
/** Constructor dependencies. */
interface WorkBuddyUpstreamClientOptions {
  /**
   * Identity the client presents as: the app version and optional CLI version.
   *
   * Replaces connect's desktop-app readers. This is a plain value rather than a
   * resolver because there is nothing to resolve — the version is configured,
   * not discovered — which also removes the per-call file I/O and its caching
   * layer.
   */
  identity?: IdentityConfig;
  /**
   * App-version resolver for international catalog requests; injectable for
   * tests. Defaults to the configured identity.
   */
  resolveAppVersion?: () => Promise<AppVersionInfo>;
  /**
   * Chat-identity resolver for chat and probe requests; injectable for tests.
   * Defaults to the configured identity. Refresh, catalog, and billing never
   * consult it — those requests keep their long-standing headers.
   */
  resolveChatIdentity?: (region: WorkBuddyRegion) => Promise<ChatIdentity>;
}
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 *
 * One instance is *per variant*: the international provider needs its own
 * catalog source, UA version, and probe differences, and keeping them on the
 * instance avoids passing a variant through every call signature.
 */
declare class WorkBuddyUpstreamClient {
  /** Outbound identity configuration; see {@link ./identity.ts}. */
  private readonly identity;
  /**
   * Resolves the App-shaped UA version for international catalog requests.
   * Injectable so tests never read the real filesystem.
   */
  private readonly resolveAppVersion;
  /** Chat-identity resolver; see {@link WorkBuddyUpstreamClientOptions.resolveChatIdentity}. */
  private readonly resolveChatIdentity;
  /** Provenance of the most recent successful catalog fetch, for the card. */
  lastCatalog: WorkBuddyCatalogFetch | undefined;
  constructor(options?: WorkBuddyUpstreamClientOptions);
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  /**
   * GET the personal model catalog.
   *
   * Both variants read `/v3/config`, the product document the desktop product
   * itself fetches. CN used to read `/console/enterprises/personal/models`
   * (the console catalog) instead, and that was why its model list drifted
   * from the desktop App's selector: the console document lags the product
   * one, and the product roster itself churns day to day (`auto`,
   * `kimi-k3-1`, `minimax-m3` have each appeared and disappeared within a
   * week).
   *
   * What distinguishes the two variants here is the User-Agent, not the path:
   * the gateway splits `/v3/config` by client identity, and the split is
   * load-bearing. A CLI-shaped UA yields the CLI's roster — the chat models
   * this plugin serves — while an App-shaped UA yields the App's internal
   * roster. CN keeps the CLI UA it sends for chat, so the catalog it
   * advertises is exactly the one its own requests can use. The international
   * variant has no CLI identity, so it keeps the App-shaped UA.
   *
   * Membership is the `cli` roster intersected with the usable rows (see
   * {@link parseModelCatalog}); the promo badges the product document does
   * not carry are merged in from a best-effort console read — see
   * {@link fetchPromoBadges}.
   *
   * Responses are unwrapped and classified the same way — `readEnvelope` plus
   * `envelopeError` — so an expired session or exhausted credit is reported as
   * such rather than as a generic catalog failure.
   */
  fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]>;
  /**
   * Read the console catalog's promotional tags, by model id.
   *
   * `/v3/config` carries no `badge:<label>:<color>` tags — the discount labels
   * the cards render (`限时免费`, `夜间折扣`, …) live only in
   * `/console/enterprises/personal/models`. Since the roster now comes from
   * the product document, those tags are read from the console one in a
   * second request and merged by id.
   *
   * Best-effort by construction: a badge is a label on a price, so failing to
   * read this document must not fail a catalog refresh. Every failure —
   * network, envelope, an unreadable body — returns undefined, and the models
   * simply ship without badges.
   */
  private fetchPromoBadges;
  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * Two upstream shapes, chosen by account type:
   *
   * - **CN enterprise** (`regionOf === 'cn'` and `enterpriseId` non-empty) asks
   *   `/v2/billing/meter/get-enterprise-user-usage`, which answers with a single
   *   cycle quota. The personal endpoint serves these accounts an empty
   *   `Accounts` list, which the card then renders as "0 credit" — a wrong
   *   number rather than a visible failure (issue #31).
   * - **Everyone else** keeps the personal endpoint unchanged.
   *
   * The region gate is load-bearing: the enterprise endpoint is unverified for
   * the global region, so an international credential that happens to carry an
   * `enterpriseId` must stay on the measured personal path instead of being
   * moved onto an unmeasured one.
   */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
  /**
   * CN enterprise credit read: a single cycle quota instead of a package list.
   *
   * Verified against the WorkBuddy desktop app (`app.asar`,
   * `BackendProvider.getEnterpriseUsage` and `CloudAccountRepo.billing`): the
   * body is an empty object and the account identity travels only in the
   * headers. The two official call sites disagree on the field spelling
   * (`limitNum`/`credit` vs `limit_num`/`used_num`), so both are accepted.
   *
   * A body carrying no recognisable quota field is a hard error rather than a
   * zero. Rendering `0` for "we did not understand the answer" is exactly how
   * issue #31 stayed invisible while users saw a plausible wrong number.
   *
   * The error names fields and types only: it reaches the browser, and the
   * response body may describe the account's usage.
   */
  private fetchEnterpriseCredits;
  /**
   * One probe request: a real streaming chat call carrying the effort under
   * test.
   *
   * Shares `chatHeaders` with the normal chat path on purpose — the plan
   * forbids probing through anything but the plugin's own credential handling,
   * so a result describes what a real message would experience.
   *
   * The caller aborts as soon as a parseable event arrives; the body is never
   * assembled into an answer. `reasoning_effort` is omitted entirely (rather
   * than sent empty) when `effort` is undefined, so the baseline case is a
   * genuinely bare request.
   *
   * Two international differences, both measured on 2026-09-11:
   *
   * - The gateway requires a leading `system` message (400/11128 otherwise), so
   *   one is prepended for the global region only.
   * - `max_tokens: 1` is below some models' floor (the GPT-5.6 family rejects it
   *   with 400/11133 `integer_below_min_value`), so the international probe asks
   *   for a slightly larger minimum. This is a floor the plugin must clear, not
   *   evidence about any model's effort support: a model still refusing that
   *   minimum is reported as an incompatible request, never as "effort
   *   unsupported", and the ceiling is never raised further to force an answer.
   */
  probeEffort(credential: WorkBuddyCredential, model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt>;
}
/**
 * One verified promotion entry.
 *
 * Only the shape actually observed in the international App document is
 * modelled — an enabled, time-boxed, `displayMode: "replace"` discount. An
 * entry that does not match is dropped rather than guessed at: rendering a
 * discount the plugin does not understand could understate what the user pays.
 */
interface WorkBuddyPromotion {
  /** Window start, epoch ms, parsed from the document's offset timestamp. */
  start: number;
  /** Window end, epoch ms. */
  end: number;
  /** Badge text as the upstream wrote it, e.g. `Free now`. */
  label: string;
  /** Multiplier applied to the model's rate; `0` replaces it outright. */
  factor: number;
  /** Higher wins when several promotions cover one model. */
  priority: number;
}
//#endregion
//#region src/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyModelInfo = WorkBuddyUpstreamModel;
/**
 * Static CLI models observed on the CN endpoint (re-verified against the live
 * `/v3/config` document 2026-09-23, including the thinking-effort and billing
 * metadata). The upstream refresh replaces this list at startup; it exists so
 * the provider registers with a usable catalog even while the first fetch is
 * in flight or offline.
 *
 * The list tracks the `cli` agent's model roster exactly — the 16 models it
 * offered that day. The roster churns quickly (`auto`, `kimi-k3-1`,
 * `minimax-m3` each appeared or vanished within days, and a competing patch's
 * 2026-09-22 snapshot named three ids that were gone a day later), so this
 * table is a boot-time placeholder, never a promise: the live fetch
 * intersects the day's roster with the document's usable rows, and
 * `tests/upstream.spec.ts` pins this table to the same parse so the two
 * cannot drift apart silently. Reasoning metadata is verbatim from the live
 * document, and the `free` flag follows the normalized `x0.00` credits
 * marker.
 *
 * Deliberately NOT baked in: promotional badges. `限时免费` and friends are
 * dynamic console-side promotions with no reliable validity window, so a
 * static table would keep them alive long after the offers end. The live
 * refresh merges the day's badges best-effort from the console document (see
 * `fetchPromoBadges` in upstream.ts); until then the rows simply ship
 * without them.
 */
declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/**
 * Static CLI models for the international endpoint, captured 2026-09-11 from
 * the App-form `/v3/config` document (the 20 ids of its `cli` agent, in order).
 *
 * Same purpose and same discipline as {@link FALLBACK_WORKBUDDY_MODELS}: it
 * covers the window before the first successful fetch and an offline start,
 * and it is deliberately *not* a promise about the upstream's current state.
 * Reasoning metadata is verbatim from that snapshot. No promo badge is baked
 * in: promotions are time-boxed (`modelPromotions` carries `validFrom`/
 * `validUntil`), so hard-coding a "Free now" label would keep claiming a
 * discount the upstream may have already ended.
 */
declare const FALLBACK_WORKBUDDY_AI_MODELS: readonly WorkBuddyModelInfo[];
/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility is separate from content. A variant whose app has no credentials
 * must expose *no* models rather than a fallback roster: the DSH model picker
 * drops an empty group, so an empty catalog is exactly how a provider hides
 * without touching registration. Serving the fallback to a signed-out user
 * instead offers models that can only fail (`store.resolve()` throws on the
 * first message), which is worse than showing nothing.
 *
 * The flag defaults to visible so a directly-constructed catalog behaves as it
 * always has; the plugin runtime applies the credential gate.
 */
declare class WorkBuddyCatalog {
  private models;
  private visible;
  private useMaximumContextWindow;
  private hiddenModels;
  constructor(initial?: readonly WorkBuddyModelInfo[]);
  /**
   * Current selectable entries; empty while the variant has no usable
   * credential. Hidden ids are dropped, so this is what the adapter and the
   * model picker read.
   */
  current(): readonly WorkBuddyModelInfo[];
  /**
   * The full roster, without the hidden filter.
   *
   * Distinct from {@link current} so the settings card can render *every* model
   * — including the ones the user hid — with its checkbox un-ticked. Hiding a
   * model is only reversible if the card can still see the hidden row to
   * un-check it, and a roster already filtered down to the visible ids leaves
   * nothing to click. The adapter and picker keep reading `current()`; only the
   * card's visibility list uses this wider view.
   *
   * Empty while the variant has no usable credential, exactly like `current()`.
   */
  roster(): readonly WorkBuddyModelInfo[];
  /** One entry with promotion and context-window selection applied, for display. */
  private display;
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void;
  /** Whether this variant's models are exposed at all. */
  isVisible(): boolean;
  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip an invalidation that would re-render an identical list.
   */
  setVisible(visible: boolean): boolean;
  /** Whether the largest declared window is selected (see {@link setUseMaximumContextWindow}). */
  isUsingMaximumContextWindow(): boolean;
  /** Select the largest declared international window where the upstream offers one. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean;
  /**
   * Replace the hidden-model set for this region.
   *
   * Returns whether the set changed, so the caller can skip invalidating the
   * adapter when the toggle was a no-op. Hidden models stay hidden even when the
   * roster is later replaced by a catalog refresh: the rule is about ids, not
   * about the rows that happened to be present when it was set.
   */
  setHiddenModels(ids: ReadonlySet<string>): boolean;
  /** The model ids currently hidden, for the status document. */
  hiddenModelIds(): readonly string[];
  /** Models to fall back to when the upstream fetch fails; ignores visibility. */
  fallback(): readonly WorkBuddyModelInfo[];
}
//#endregion
//#region src/probe-store.d.ts
/**
 * Whether the model's effort parameter is actually validated.
 *
 * - `validating`: the upstream rejected an unknown sentinel value, so a
 *   per-level answer is meaningful.
 * - `non-validating`: the upstream accepted the sentinel, so it ignores or
 *   loosely coerces the parameter and no per-level answer can be trusted.
 * - `unknown`: baseline or sentinel failed for an unrelated reason (auth,
 *   rate limit, transport, ambiguous error body). Not a negative claim.
 */
type WorkBuddyProbeValidation = 'validating' | 'non-validating' | 'unknown';
/** One model's recorded observation. */
interface WorkBuddyProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string;
  validation: WorkBuddyProbeValidation;
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly WorkBuddyEffort[];
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number;
  /** Plugin version that produced the record. */
  pluginVersion: string;
  /**
   * The account this observation was made under, as `uid:enterpriseId`.
   *
   * An effort set is a fact about one account's entitlement as much as about
   * the model: the same model id can accept different levels under a different
   * subscription. Records are stored under this identity and only ever served
   * back to it, so one account never inherits another's detected levels — and
   * because the store nests by this identity, switching back finds this
   * account's own records intact rather than re-probing from scratch.
   */
  account: string;
}
/**
 * Plugin-owned probe record path inside the Harness home.
 *
 * One file per variant. Same-named models exist on both endpoints (the
 * international catalog repeats `glm-5.3`, `glm-5.2`, `hy3`, `kimi-k2.6`), and
 * {@link fingerprintModel} covers only `id`/`reasoning`/`supportsImages` —
 * never the provider — so a single shared file would let one variant's
 * observation answer for the other. The paths differ; the format does not.
 */
declare function workbuddyProbePath(filename?: string): string;
/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
 * so a rename or a promo badge does not throw away a valid observation, and
 * deliberately includes the whole reasoning object so any change to the
 * declared shape re-probes.
 */
declare function fingerprintModel(info: WorkBuddyModelInfo): string;
/** Options for {@link WorkBuddyProbeStore}. */
interface WorkBuddyProbeStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
  /** Observation lifetime; defaults to 14 days. */
  ttlMs?: number;
  /** Plugin version stamped into new records. */
  pluginVersion: string;
  /** Clock injection for tests. */
  now?: () => number;
}
/**
 * The plugin's probe records: read once, written atomically, keyed by the
 * account that produced each observation, and never trusted across a
 * fingerprint change or past the TTL.
 */
declare class WorkBuddyProbeStore {
  private readonly path;
  private readonly ttlMs;
  private readonly pluginVersion;
  private readonly now;
  private records;
  constructor(options: WorkBuddyProbeStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /**
   * The usable record for one account and model, or `undefined` when there is
   * none, it is expired, it was taken against a different catalog row, or it
   * belongs to a different account.
   *
   * @param account - the account in effect, as `uid:enterpriseId`. Records are
   *   only returned for the account that produced them.
   */
  get(modelId: string, fingerprint: string, account: string): WorkBuddyProbeRecord | undefined;
  /**
   * Store one observation under the account stamped on it. Only a decisive
   * answer (`validating` / `non-validating`) replaces an existing decisive
   * record *of the same account*: a transient `unknown` must not erase
   * knowledge the user already paid for.
   */
  set(modelId: string, record: WorkBuddyProbeRecord): void;
  /** Drop every record of every account; used by the card's explicit "clear" action. */
  clear(): void;
  /**
   * Drop one account's records.
   *
   * Called when an account is removed. A record is keyed by `uid:enterpriseId`
   * and carries that identity inside itself, so leaving it behind would keep a
   * removed account's identifier on disk — and if the same account signed in
   * again, a stale observation could answer for it.
   *
   * @param account - the account key, as `uid:enterpriseId`.
   * @returns whether any record was removed.
   */
  forget(account: string): boolean;
  /** Every record currently held, grouped by account, for status display. */
  all(): Readonly<Record<string, Readonly<Record<string, WorkBuddyProbeRecord>>>>;
  /** Build a record stamped with this store's clock, version, and account. */
  record(fingerprint: string, validation: WorkBuddyProbeValidation, efforts: readonly WorkBuddyEffort[], account: string): WorkBuddyProbeRecord;
  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-parsed document that reads as "no records" and silently drops
   * every observation.
   */
  private persist;
}
//#endregion
//#region src/shim.d.ts
/**
 * Minimal logger surface the plugin context already provides.
 *
 * `info` exists so one line per chat request can report **which account served
 * it**. Selection behaviour (rotation, cooldown, session affinity) is otherwise
 * invisible: nothing about the response says which credential produced it, so
 * without this an operator cannot tell a working rotation from a stuck pool.
 */
interface ShimLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyShimOptions {
  store: CredentialStore;
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/adapter.d.ts
/** Constructor dependencies. */
interface WorkBuddyAdapterOptions {
  providerId?: string;
  displayName?: string;
  /**
   * Region this adapter serves, from the variant descriptor. Decides only
   * whether the CN `onlyReasoning` veto hides `off` (#87); defaults to `'cn'`.
   */
  region?: WorkBuddyRegion;
  shim: WorkBuddyShim;
  store: CredentialStore;
  catalog: WorkBuddyCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /** Resolve one image's path in the current model-tool execution world. */
  resolveImageAccess?: NonNullable<PiAiAdapterOptions['resolveImageAccess']>;
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined;
  /**
   * Model ids the current account has hidden from the picker, resolved per
   * read so an account switch is honored without rebuilding the adapter.
   *
   * Hiding is a *listing* concern only: `buildModels()` keeps serving the full
   * catalog because pi-ai's `resolveModel`/`prepareCall` resolve from the same
   * snapshot `listModels` reads — filtering the descriptors there would make a
   * hidden model unresolvable and break sessions already using it. The filter
   * therefore lives in this adapter's `listModels` override alone.
   */
  hidden?: () => readonly string[];
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's
 * public export surface (root entry, `lib/` deep imports blocked by the
 * exports map, `src/` not shipped), so hand-assembly is the only supported
 * path and every newly required field must be adopted here explicitly —
 * `modelErrors` since 0.1.5-alpha.2 (#12).
 */
declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/probe-service.d.ts
/** What the caller learns about a completed probe. */
type WorkBuddyProbeStatus = {
  state: 'ok';
  validation: WorkBuddyProbeRecord['validation'];
  efforts: readonly string[];
  requests: number;
} | {
  state: 'unavailable';
  reason: string;
};
/** Options for {@link WorkBuddyProbeService}. */
interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore;
  catalog: WorkBuddyCatalog;
  credentials: CredentialStore;
  client: WorkBuddyUpstreamClient;
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean;
  /**
   * The account currently in effect, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * Records are read and written against this identity, and it is re-checked
   * after the sweep finishes: an observation produced under account A must not
   * be stored once account B is in effect, however long the probe took. The
   * store's per-account keying alone cannot catch that, because an in-flight
   * probe completes *after* the switch has already happened.
   */
  account: () => string | undefined;
  /**
   * Which endpoint's rejection vocabulary sweeps read.
   *
   * The two apps talk to different upstreams that answer a bad effort with
   * different codes, so each runtime passes its own region rather than sharing
   * one widening set.
   */
  region: ProbeRegion;
  sentinel?: SentinelFactory;
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender;
}
/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
declare class WorkBuddyProbeService {
  private readonly options;
  private queue;
  private readonly pending;
  private running;
  constructor(options: WorkBuddyProbeServiceOptions);
  /** Whether a sweep is in flight right now. */
  isRunning(): boolean;
  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * Applies the plan's precedence: a declared set always wins, so a model that
   * declares `supportedEfforts` is never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined;
  /**
   * Whether a model can be probed by hand: it reasons and the upstream
   * declares no effort set for it.
   *
   * Deliberately *not* filtered by whether a result already exists. Dropping a
   * model once it has been detected made the list shrink with use, so
   * re-detecting one model — after an upstream change, say — meant clearing
   * every other result first.
   */
  isCandidate(modelId: string): boolean;
  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  probe(modelId: string, manualConsent?: boolean): Promise<WorkBuddyProbeStatus>;
}
//#endregion
//#region src/status-paths.d.ts
/** Read-only status endpoint consumed by this plugin's browser half. */
declare const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-oauth/status";
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
declare const WORKBUDDY_CONTROL_PATH = "/plugins/dsh-workbuddy-oauth/control";
/** Control endpoint for the international region. */
declare const WORKBUDDY_AI_CONTROL_PATH = "/plugins/dsh-workbuddy-oauth/ai/control";
/** The control path for one region. */
declare function controlPathFor(region: WorkBuddyRegion): string;
/** Header carrying the in-process control key on a control request. */
declare const WORKBUDDY_CONTROL_KEY_HEADER = "x-workbuddy-oauth-key";
/** One signed-in account, as the card displays it. */
interface WorkBuddyWebAccount {
  uid: string;
  label: string;
  region: WorkBuddyRegion;
  /** Access-token expiry, epoch milliseconds. */
  expiresAtMs: number;
  /**
   * Whether this account may serve requests.
   *
   * Carried so the card can label the state without holding a second copy of the
   * enable/disable rule; a disabled account is still listed, because it is still
   * signed in.
   */
  enabled: boolean;
}
/** One model as the card's model list and probe picker need it. */
interface WorkBuddyWebModel {
  id: string;
  name: string;
  /** Declared context window, tokens. */
  contextWindow: number;
  /** Declared max output tokens. */
  maxTokens: number;
  /**
   * Whether this model declares more than one context window.
   *
   * The card needs it to show which rows the maximum-window switch actually
   * changes, and to decide whether to offer that switch at all: a region whose
   * models all declare a single window cannot be affected by the flag, so the
   * control would appear to do nothing there.
   */
  multiWindow: boolean;
}
/** One model's recorded probe observation. */
interface WorkBuddyWebProbeModel {
  id: string;
  name: string;
  /** `validating` results carry efforts; the other states never do. */
  validation: WorkBuddyProbeValidation;
  efforts: readonly WorkBuddyEffort[];
  probedAt: number;
}
/** One region's slice of the status document. */
interface WorkBuddyWebRegion {
  region: WorkBuddyRegion;
  /** Human label, e.g. `WorkBuddy (国内版)`. */
  label: string;
  /**
   * Control-route path for this region's probe actions.
   *
   * Carried in the document rather than recomputed by the card: the path is a
   * host-side routing decision, and a card that derived it independently would
   * be one rename away from posting into a 404.
   */
  controlPath: string;
  /**
   * The provider id this region registers under.
   *
   * Carried in the document rather than recomputed by the card: the two bundles
   * are built independently, so a provider id spelled twice is one build-config
   * drift away from the card filtering for a group that does not exist.
   */
  providerId: string;
  /**
   * Whether this region has a usable credential.
   *
   * Carried explicitly rather than inferred from `models.length`: an account
   * whose catalog fetch has not landed yet has a credential and no live roster,
   * and the card must not report that as "signed out".
   */
  signedIn: boolean;
  /**
   * Models this region currently exposes. Empty while signed out *and* while a
   * signed-in account's first fetch is still in flight — `signedIn`
   * distinguishes the two.
   */
  models: readonly WorkBuddyWebModel[];
  /**
   * Model ids the user has hidden from the picker, for this region.
   *
   * Carried so the card can render the checkbox state without holding a second
   * copy of the rule; the host already filters these out of `models`, so the
   * card only needs the ids to know which boxes to tick.
   */
  hiddenModels: readonly string[];
  /**
   * Whether the user chose the largest declared context window for this region.
   *
   * Carried so the card can render the checkbox state without holding a second
   * copy of the rule. Only the international region declares
   * `supportedContextWindows`, so this is meaningful there; the CN region still
   * reports the same global flag for a uniform card layout.
   */
  useMaximumContextWindow: boolean;
  /** Whether a probe sweep is in flight for this region right now. */
  probeRunning: boolean;
  /**
   * Models the user could probe by hand: reasoning-capable rows the upstream
   * left undeclared, which is exactly the set that gets no level picker
   * without an observation.
   */
  probeCandidates: readonly string[];
  /** Recorded observations, newest first. */
  probeResults: readonly WorkBuddyWebProbeModel[];
}
/** The document the browser half reads. */
interface WorkBuddyWebStatus {
  /** Discriminator. The card refuses anything else rather than dereferencing it. */
  status: 'ok';
  /** Plugin version, so a stale card can be told from a stale host. */
  version: string;
  accounts: readonly WorkBuddyWebAccount[];
  regions: readonly WorkBuddyWebRegion[];
  /**
   * The in-process control key.
   *
   * Travels on this read-only, loopback-guarded response because that is the
   * only way the same-origin card can learn it; it authorizes control actions
   * only, never credentials or completions.
   */
  controlKey: string;
}
/** Result of one control action; `reason` is a short human-readable detail. */
interface WorkBuddyControlResult {
  state: string;
  reason?: string;
  /**
   * Authorization URL for `login-begin`.
   *
   * Returned to the card rather than logged host-side: the whole point of the
   * card's sign-in flow is that the user never copies a link out of a log.
   */
  url?: string;
  /** Login attempt id for `login-begin`, to be handed back to `login-complete`. */
  loginState?: string;
  /**
   * Credit balance for `refresh-credits`.
   *
   * Returned rather than logged host-side so the card can show it immediately
   * after a balance refresh, without a second status round-trip.
   */
  credits?: WorkBuddyCredits;
}
//#endregion
//#region src/control-route.d.ts
/** Constructor dependencies. */
interface WorkBuddyControlRouteOptions {
  /**
   * Run a probe for one model. Resolves to a short status, never a raw upstream
   * body.
   */
  probe: (modelId: string) => Promise<WorkBuddyControlResult>;
  /** Drop every recorded observation. */
  clear: () => void;
  /** Re-read the credential and re-fetch the model catalog. */
  refresh?: () => Promise<WorkBuddyControlResult>;
  /**
   * Ask the upstream for an authorization URL.
   *
   * The card drives the same OAuth exchange the `/wb-login` command does; this
   * route is only a transport, so both surfaces cannot drift into two different
   * login implementations.
   */
  loginBegin?: (region: string) => Promise<WorkBuddyControlResult>;
  /**
   * Redeem an authorization: succeeds once the user has approved upstream, and
   * reports `pending` while they have not.
   */
  loginComplete?: (state: string) => Promise<WorkBuddyControlResult>;
  /**
   * Delete one stored credential.
   *
   * The card's counterpart to `/wb-logout`. The host owns the deletion so the
   * command and the card cannot disagree about what signing out means.
   */
  logout?: (uid: string) => Promise<WorkBuddyControlResult>;
  /**
   * Enable or disable one account without deleting it.
   *
   * The card's counterpart to `/wb-account enable|disable`: reversible, unlike
   * {@link logout}.
   */
  setAccountEnabled?: (uid: string, enabled: boolean) => Promise<WorkBuddyControlResult>;
  /**
   * Hide or show one model for a region.
   *
   * The card's counterpart to the hidden-models rule; the host owns the
   * persistence and the catalog filtering, so the picker and the checkbox cannot
   * disagree about what is hidden.
   */
  setModelVisible?: (region: string, modelId: string, visible: boolean) => Promise<WorkBuddyControlResult>;
  /**
   * Select or clear the largest-declared-context-window preference.
   *
   * The card's counterpart to the catalog's `setUseMaximumContextWindow`; the
   * host owns the persistence and the catalog flag, so the picker and the
   * checkbox cannot disagree.
   */
  setMaximumContextWindow?: (enabled: boolean) => Promise<WorkBuddyControlResult>;
  /**
   * Fetch one account's credit balance.
   *
   * The card's counterpart to P5.1; returns the balance in `credits` rather than
   * storing it host-side, so the card shows it immediately after a refresh
   * without a second status round-trip.
   */
  refreshCredits?: (uid: string) => Promise<WorkBuddyControlResult>;
  /** Route path to mount; defaults to {@link WORKBUDDY_CONTROL_PATH}. */
  path?: string;
}
/** Mint the per-process control key. */
declare function createControlKey(): string;
/**
 * The control route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 */
declare function workBuddyControlHandler(deps: WorkBuddyControlRouteOptions, key: string): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//#endregion
//#region src/web-status.d.ts
/**
 * One region's live contributors.
 *
 * Functions rather than values: the document is assembled per request, so a
 * sign-in, a catalog refresh, or a finished probe is reflected on the next read
 * without the route holding a snapshot that can go stale.
 */
interface WorkBuddyRegionView {
  region: WorkBuddyRegion;
  /** The provider id this region registers under. */
  providerId: string;
  /** Models this region currently exposes (empty while hidden). */
  models: () => readonly WorkBuddyModelInfo[];
  /** Whether a probe sweep is running for this region. */
  probeRunning: () => boolean;
  /** Models this region could probe by hand. */
  probeCandidates: () => readonly string[];
  /**
   * Recorded observations, judged the same way the adapter judges them.
   *
   * Resolved through the probe service rather than read raw from the store, so
   * the card never promises levels the model picker does not offer: a record can
   * be stale in ways the service already discounts (its catalog row changed, it
   * aged past the TTL, or the upstream has since declared an effort set).
   *
   * Paired with the model id here rather than recovered later: the store's
   * records deliberately carry no id (they are keyed by one), so only the
   * caller — which selected the models — knows which row each record describes.
   */
  probeResults: () => readonly {
    id: string;
    record: WorkBuddyProbeRecord;
  }[];
  /**
   * Model ids the user has hidden for this region.
   *
   * A function like the other contributors rather than a frozen value: the
   * hidden set is a persisted rule that changes out from under the document,
   * and the card must reflect the current toggle state on each read.
   */
  hiddenModels: () => readonly string[];
  /**
   * Whether the user chose the largest declared context window for this region.
   *
   * A function rather than a frozen value so the card reflects the current
   * flag on each read, exactly like {@link hiddenModels}.
   */
  useMaximumContextWindow: () => boolean;
}
/** Constructor dependencies for {@link workBuddyWebStatus}. */
interface WorkBuddyStatusRouteOptions {
  /** Every region this plugin serves. */
  regions: readonly WorkBuddyRegionView[];
  /** Credentials currently stored, newest selection first is not required. */
  credentials?: () => Promise<readonly WorkBuddyCredential[]>;
  /** Disabled account uids, so each account can report its own state. */
  disabled?: () => Promise<ReadonlySet<string>>;
  /** The in-process control key handed to the card. */
  controlKey: string;
  /** Clock, injectable for tests. */
  now?: () => number;
}
/** Assemble the document. */
declare function workBuddyWebStatus(options: WorkBuddyStatusRouteOptions): Promise<WorkBuddyWebStatus>;
/** The status route's request handler, extracted so tests can mount it on a bare server. */
declare function workBuddyStatusHandler(deps: WorkBuddyStatusRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-workbuddy-oauth";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Provider ids.
 *
 * **Namespaced deliberately, and not `workbuddy` / `workbuddy-ai`.** An adapter
 * is registered per provider id and a duplicate is a hard error
 * (`an adapter for provider "workbuddy" is already registered`), so a plain
 * `workbuddy` collides with `dsh-workbuddy-connect` — which claims exactly those
 * two ids — and makes this plugin's models silently unavailable whenever both
 * are installed. That is the expected setup for migration, so the collision is
 * not hypothetical: it happened on the first install.
 *
 * The prefix also keeps the two plugins' model groups distinguishable in the
 * picker, which is what a user comparing them needs.
 */
declare const WORKBUDDY_PROVIDER = "workbuddy-oauth";
/** Provider id for the international region. */
declare const WORKBUDDY_AI_PROVIDER = "workbuddy-oauth-ai";
/**
 * Provider id for one region.
 *
 * Two ids, not one: the upstreams advertise overlapping model ids, and a single
 * provider id would make the descriptor for a model depend on which region
 * happened to register last.
 */
declare function providerIdFor(region: WorkBuddyRegion): string;
/** Stream idle timeout, matching the ported client's expectations. */
declare const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300000;
/**
 * Whether *automatic* reasoning-effort probing is authorized.
 *
 * **Permanently `false`, and that is a deliberate policy rather than an
 * unfinished setting.** A probe spends the user's credit, so the upstream
 * project's own design rule is that a sweep runs only when the user asks for it.
 * The control route therefore calls `probe(modelId, true)` — per-click manual
 * consent — and this gate exists so that any *future* automatic trigger has to
 * come through a deliberate decision instead of inheriting permission by
 * default.
 *
 * Do not wire a settings toggle to this without revisiting that rule.
 */
declare const AUTOMATIC_PROBING_AUTHORIZED = false;
/** Configuration schema. */
interface Config {
  /** Desktop-app version to claim in the User-Agent; empty uses the built-in default. */
  appVersion?: string;
  /** CLI version to claim; empty omits the `CLI/…` User-Agent token. */
  cliVersion?: string;
  /** Region to sign in to when no argument is given. */
  region?: string;
}
declare const Config: z<Config>;
/**
 * The stable identity key for a credential, or `undefined` when it has no uid.
 *
 * `enterpriseId` joins the uid because the same user id can exist in two
 * enterprises, and a probe observation (an entitlement fact) must not cross
 * between them. A uid-less credential yields `undefined` rather than a
 * `":enterpriseId"` key that every uid-less account would silently share.
 */
declare function accountIdentityOf(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'> | undefined): string | undefined;
/**
 * Plugin entry point.
 *
 * Wires one provider, its loopback shim, and the credential-driven catalog
 * lifecycle. Nothing here reads the WorkBuddy desktop app.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { ALL_REGIONS, AUTOMATIC_PROBING_AUTHORIZED, COOLDOWN_STATE_FILENAME, Config, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, LoginClient, LoginExpiredError, LoginPendingError, NotSignedInError, PLUGIN_VERSION, PROBE_EFFORT_CANDIDATES, WORKBUDDY_AI_CONTROL_PATH, WORKBUDDY_AI_PROVIDER, WORKBUDDY_CONTROL_KEY_HEADER, WORKBUDDY_CONTROL_PATH, WORKBUDDY_PROVIDER, WORKBUDDY_STATUS_PATH, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WorkBuddyCatalog, type WorkBuddyControlResult, type WorkBuddyCredential, type WorkBuddyModelInfo, WorkBuddyProbeService, type WorkBuddyProbeStatus, WorkBuddyProbeStore, type WorkBuddyRegion, type WorkBuddyWebAccount, type WorkBuddyWebModel, type WorkBuddyWebProbeModel, type WorkBuddyWebRegion, type WorkBuddyWebStatus, accountIdentityOf, apply, chooseRotating, controlPathFor, createControlKey, createCredentialStore, createWorkBuddyAdapter, createWorkBuddyShim, credentialFromLogin, deriveId, deviceHeaders, displayNameOf, fingerprintModel, inject, listCredentials, maskPhoneNumbers, name, parseRegionInput, probeModel, providerIdFor, readCooldowns, regionEndpoints, regionOfDomain, requestId, workBuddyControlHandler, workBuddyStatusHandler, workBuddyWebStatus, workbuddyProbePath, writeCooldown };