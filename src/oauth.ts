/**
 * OAuth device-code sign-in, owned by this plugin.
 *
 * This module is the structural difference from `dsh-workbuddy-connect`:
 * connect reads (and decrypts) the WorkBuddy desktop app's credential file,
 * which is why it ships ~50 KB of credential-protection code and breaks when
 * the desktop app changes its at-rest format. Here the plugin obtains its own
 * credential straight from the upstream OAuth endpoints, so no desktop app,
 * no decryption and no file-format tracking is involved.
 *
 * The flow is deliberately non-interactive: `state` → hand the URL to the
 * user → poll for the token. No TTY, no local callback port.
 *
 * Endpoints, headers and the `{code,msg,data}` envelope mirror the flow the
 * official CLI performs. `expiresIn` is in **seconds**.
 *
 * @module dsh-workbuddy-standalone/oauth
 */

import { randomUUID } from 'node:crypto'
import { regionEndpoints, type WorkBuddyRegion } from './region.ts'

/** User agent the login endpoints expect. Do not substitute the plugin's own. */
export const LOGIN_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * The `platform` value the sign-in request asks for.
 *
 * **Not `CLI`.** The desktop app's own authorization URL reports
 * `platform=workbuddy`, and phone-number sign-in on the resulting page fails with
 * `无效的token` (`sl_…`, a OneID token) when the page is opened for a
 * `CLI`-scoped state — measured by comparing the two URLs. `CLI` is what both
 * reference implementations send, so this diverges from them deliberately: they
 * expose an OpenAI-compatible gateway where the CLI flow is the whole product,
 * while this plugin is signing in on behalf of a desktop-app user.
 */
export const AUTH_PLATFORM = 'workbuddy'

/** Desktop-app version the authorization URL advertises, matching the app. */
const AUTH_URL_VERSION = '5.5.6'

/**
 * Add the two query parameters the desktop app's authorization URL carries.
 *
 * The state endpoint echoes back only `platform` and `state` — it ignores
 * `version` and `loginSessionId` when they are sent on the request, and does not
 * mint them itself (verified against the live endpoint). The desktop app
 * therefore appends them client-side, and `loginSessionId` is a fresh UUID each
 * time the app opens the page, so it is a per-attempt correlation id rather than
 * server state.
 *
 * `loginSessionId` is what lets the phone-login (OneID) path correlate the page
 * with the client that opened it; without it the page's phone flow rejects the
 * token. A malformed URL is returned unchanged rather than throwing: a login page
 * that opens is strictly better than a hard failure, and the upstream is the
 * authority on what it issued.
 *
 * @param authUrl - the URL the state endpoint returned.
 * @param region - selects the advertised app version.
 * @returns the URL with `version` and `loginSessionId` present.
 */
export function officialAuthUrl(authUrl: string, region: WorkBuddyRegion): string {
  let parsed: URL
  try {
    parsed = new URL(authUrl)
  } catch {
    return authUrl
  }
  // Only fill them in when absent, so a future upstream that starts returning
  // them keeps its own values.
  if (!parsed.searchParams.has('version')) {
    parsed.searchParams.set('version', region === 'global' ? '5.5.2' : AUTH_URL_VERSION)
  }
  if (!parsed.searchParams.has('loginSessionId')) {
    parsed.searchParams.set('loginSessionId', randomUUID())
  }
  return parsed.href
}

/**
 * Minimum gap between two polls of the same state.
 *
 * Why this matters for account safety rather than politeness: the sign-in
 * endpoints are the ones an abusive client would hammer (poll in a tight loop
 * and you look like credential stuffing, not a user waiting in a browser).
 * The reference implementations poll at most once per user action; the poll
 * command in `workbuddy2api` is explicitly one-shot, and `login.sh` waits for
 * a keypress between rounds.
 *
 * We keep the one-shot shape — a slash command polls once per invocation — and
 * add this floor so a retry loop or an impatient double invocation cannot turn
 * into a burst. Set generously: the user controls the pace from the browser,
 * so polling faster buys nothing.
 */
export const MIN_POLL_INTERVAL_MS = 3_000

/**
 * How long an issued `state` stays usable.
 *
 * Matches the 600 s window `workbuddy2api` puts on a pending login. Expiring
 * locally means an abandoned sign-in cannot be resumed hours later with a
 * state the upstream has long forgotten.
 */
export const LOGIN_TTL_MS = 600_000

/** The upstream `{code,msg,data}` envelope. `code !== 0` is a business failure. */
interface Envelope<T> {
  code?: number
  msg?: string
  data?: T
}

/** Authorization has not completed yet — retryable, not a fault. */
export class LoginPendingError extends Error {
  constructor(message = '登录尚未完成：请先在浏览器里完成授权，再重试。') {
    super(message)
    this.name = 'LoginPendingError'
  }
}

/** Sign-in has not started or the state expired — the caller must restart. */
export class LoginExpiredError extends Error {
  constructor(message = '授权状态已失效，请重新发起登录。') {
    super(message)
    this.name = 'LoginExpiredError'
  }
}

/** Headers every login call sends. */
export function loginHeaders(origin: string, token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': LOGIN_USER_AGENT,
    ...(token !== undefined && token !== '' ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** Result of the first step: the URL the user must open. */
export interface AuthorizationRequest {
  region: WorkBuddyRegion
  state: string
  url: string
}

/** Token bundle as returned by the token endpoint. */
export interface TokenBundle {
  accessToken: string
  refreshToken: string
  /** Lifetime in **seconds**, relative to the moment the token was issued. */
  expiresIn: number
  domain: string
}

/** Account identity reported alongside the token. */
export interface AccountInfo {
  uid: string
  enterpriseId: string
  nickname: string
}

/** Everything a completed sign-in produces. */
export interface LoginResult {
  region: WorkBuddyRegion
  token: TokenBundle
  account: AccountInfo
}

/** Minimal fetch shape, so tests can inject a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Injectable options. */
export interface LoginClientOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  /**
   * Clock, injectable so the TTL and poll-cadence rules are testable without
   * sleeping.
   */
  now?: () => number
  /** Override the poll floor. Tests lower it; production should not. */
  minPollIntervalMs?: number
  /** Override the state lifetime. */
  loginTtlMs?: number
}

/** A live sign-in attempt. */
interface PendingLogin {
  region: WorkBuddyRegion
  createdAt: number
  /** Last successful poll, for the cadence floor. */
  lastPolledAt?: number
}

/**
 * Drives the device-code flow.
 *
 * The three calls are split rather than wrapped in one `login()` because the
 * browser step happens between `begin` and `poll`, and a slash command must be
 * able to print the URL, return, and poll on the user's next invocation.
 */
export class LoginClient {
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly minPollIntervalMs: number
  private readonly loginTtlMs: number

  /**
   * Live attempts, keyed by state.
   *
   * Tracking these locally is what makes the safety rules enforceable: the TTL
   * needs a creation time, the cadence floor needs a last-poll time, and
   * knowing the region a state belongs to is what stops a poll from being sent
   * to the wrong region's host (which the upstream would see as a token for one
   * service being redeemed at another).
   */
  private readonly pending = new Map<string, PendingLogin>()

  constructor(options: LoginClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.now = options.now ?? (() => Date.now())
    this.minPollIntervalMs = options.minPollIntervalMs ?? MIN_POLL_INTERVAL_MS
    this.loginTtlMs = options.loginTtlMs ?? LOGIN_TTL_MS
  }

  /**
   * Perform one JSON call and unwrap the envelope.
   *
   * @throws LoginPendingError - upstream says the user has not authorized yet.
   * @throws Error - any other failure, including a malformed body.
   */
  private async call<T>(
    url: string,
    region: WorkBuddyRegion,
    init: { method: string; body?: string; token?: string },
  ): Promise<T> {
    const { origin } = regionEndpoints(region)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: loginHeaders(origin, init.token),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error(`请求 ${url} 失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const text = await response.text().catch(() => '')
    let envelope: Envelope<T>
    try {
      envelope = JSON.parse(text) as Envelope<T>
    } catch {
      throw new Error(`上游返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }

    if (envelope.code !== undefined && envelope.code !== 0) {
      const detail = `code=${envelope.code} msg=${envelope.msg ?? ''}`
      const msg = envelope.msg ?? ''
      // "login ing" is a business-level pending state, not a failure: the
      // upstream reports it as HTTP 200 with `{code:11217, msg:"11217:login
      // ing..."}` and no `data` (measured live — see tools/login-probe.mjs),
      // while an older shape surfaced it as a 4xx. Both must map to
      // `LoginPendingError`, because a user who has simply not finished in the
      // browser must see "waiting", never "failed".
      if (
        envelope.code === 11217
        || msg.includes('login ing')
        || (response.status >= 400 && response.status < 500)
      ) {
        throw new LoginPendingError(`登录尚未完成（${detail}）`)
      }
      throw new Error(detail)
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`)
    }
    if (envelope.data === undefined) {
      throw new Error(`上游响应缺少 data 字段：${text.slice(0, 200)}`)
    }
    return envelope.data
  }

  /** Step 1 — ask the upstream for a `state` and the authorization URL. */
  async begin(region: WorkBuddyRegion): Promise<AuthorizationRequest> {
    // `loginBase`, not `base`: the host a state is issued on is the host the
    // login page (and every follow-up call for that state) lives on.
    const { loginBase } = regionEndpoints(region)
    const data = await this.call<{ state?: unknown; authUrl?: unknown }>(
      `${loginBase}/v2/plugin/auth/state?platform=${AUTH_PLATFORM}`,
      region,
      { method: 'POST', body: '{}' },
    )
    if (typeof data.state !== 'string' || data.state === '') {
      throw new Error('上游未返回 state，登录无法继续。')
    }
    if (typeof data.authUrl !== 'string' || data.authUrl === '') {
      throw new Error('上游未返回 authUrl，登录无法继续。')
    }
    this.pending.set(data.state, { region, createdAt: this.now() })
    // The upstream echoes `platform` and `state` but omits the two parameters the
    // desktop app's own page carries (`version`, `loginSessionId`); see
    // {@link officialAuthUrl}.
    return { region, state: data.state, url: officialAuthUrl(data.authUrl, region) }
  }

  /**
   * Resolve a state to its live attempt, enforcing the lifetime.
   *
   * @throws LoginExpiredError - unknown state, or past {@link LOGIN_TTL_MS}.
   */
  private requirePending(state: string): PendingLogin {
    const entry = this.pending.get(state)
    if (entry === undefined) {
      throw new LoginExpiredError('未知的登录状态：可能已过期，请重新发起登录。')
    }
    if (this.now() - entry.createdAt > this.loginTtlMs) {
      this.pending.delete(state)
      throw new LoginExpiredError('登录窗口已超时，请重新发起登录。')
    }
    return entry
  }

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
  async poll(state: string): Promise<TokenBundle> {
    const entry = this.requirePending(state)

    // Cadence floor. Enforced before the request so an impatient retry cannot
    // reach the upstream at all, not merely be logged after the fact.
    const sinceLast = entry.lastPolledAt === undefined ? undefined : this.now() - entry.lastPolledAt
    if (sinceLast !== undefined && sinceLast < this.minPollIntervalMs) {
      const waitMs = this.minPollIntervalMs - sinceLast
      throw new LoginPendingError(
        `轮询过于频繁，请等待约 ${Math.ceil(waitMs / 1000)} 秒后再试（避免触发上游风控）。`,
      )
    }
    entry.lastPolledAt = this.now()

    const region = entry.region
    // The state was issued by this host, so it must be redeemed here.
    const { loginBase } = regionEndpoints(region)
    const data = await this.call<{
      accessToken?: unknown
      refreshToken?: unknown
      expiresIn?: unknown
      domain?: unknown
    }>(`${loginBase}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, region, { method: 'GET' })

    if (typeof data.accessToken !== 'string' || data.accessToken === '') {
      throw new LoginPendingError('登录尚未完成：token 端点还没有返回 accessToken。')
    }
    return {
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
      expiresIn: typeof data.expiresIn === 'number' && Number.isFinite(data.expiresIn) ? data.expiresIn : 0,
      domain: typeof data.domain === 'string' ? data.domain : '',
    }
  }

  /** Step 3 — read the account identity bound to this authorization. */
  async account(state: string, accessToken: string): Promise<AccountInfo> {
    const entry = this.requirePending(state)
    const { loginBase } = regionEndpoints(entry.region)
    const data = await this.call<{ uid?: unknown; enterpriseId?: unknown; nickname?: unknown }>(
      `${loginBase}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
      entry.region,
      { method: 'GET', token: accessToken },
    )
    return {
      uid: typeof data.uid === 'string' ? data.uid : '',
      enterpriseId: typeof data.enterpriseId === 'string' ? data.enterpriseId : '',
      nickname: typeof data.nickname === 'string' ? data.nickname : '',
    }
  }

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
  async complete(state: string): Promise<LoginResult> {
    const entry = this.requirePending(state)
    const token = await this.poll(state)
    const account = await this.account(state, token.accessToken)
    if (account.uid === '') {
      throw new Error('上游未返回 uid，无法确定账号身份。')
    }
    // Retire the state: the same authorization must not mint a second
    // credential, and the token has already been read.
    this.pending.delete(state)
    return { region: entry.region, token, account }
  }
}

/** Normalize a user-supplied region argument, accepting `1`/`cn`/`2`/`global`. */
export function parseRegionInput(input: string): WorkBuddyRegion | undefined {
  switch (input.trim().toLowerCase()) {
    case '':
    case '1':
    case 'cn':
    case '国内':
    case '国内版':
      return 'cn'
    case '2':
    case 'global':
    case '国际':
    case '国际版':
      return 'global'
    default:
      return undefined
  }
}
