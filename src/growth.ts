/**
 * CN growth-center client: daily check-in, tasks, streak, lottery, buddy travel.
 *
 * Every path here was **measured against the live upstream** (see
 * `tools/growth-probe.mjs` and `tools/checkin-probe.mjs`, both re-runnable
 * read-only); none is taken from a reference's comment alone (L4's rule). The
 * claim endpoint is the one cross-checked exception: both references measured
 * that the chat domain answers 400 and the web domain answers 200, so claim
 * sends web-shaped headers to `www.workbuddy.cn`.
 *
 * **Scope: real endpoints only.** This client deliberately has no
 * `/v2/report` event channel. Reporting fabricated client behaviour to light
 * tasks or the streak is the mechanism the references use, but the account owner
 * chose not to do it (their account had already been rate-limited once), so P4's
 * 4.4 activity report and 4.6 night-owl task are dropped rather than
 * quietly implemented. What remains — check-in, travel, streak redemption,
 * lottery, and claiming tasks the user really completed — needs no forgery.
 *
 * Not implemented, deliberately:
 * - miniprogram-scoped tasks (`X-Client-Platform: miniprogram`) — that header
 *   changes the visible task set; the default scope suffices for claiming.
 * - makeup sign-in / newbie gift / compensation — one-time benefits, not
 *   recurring automation.
 *
 * @module dsh-workbuddy-standalone/growth
 */

import { deviceHeaders, requestId } from './fingerprint.ts'
import { resolveAppVersion } from './identity.ts'
import type { WorkBuddyCredential } from './credentials.ts'

/** The origin the task/streak/travel/lottery endpoints live on (measured). */
const CHAT_BASE = 'https://copilot.tencent.com'

/** The web growth-center origin; claim requests must present it (measured via references). */
const WEB_BASE = 'https://www.workbuddy.cn'

/** The billing origin: daily check-in and resource queries (measured). */
const BILLING_BASE = 'https://www.codebuddy.cn'

/**
 * The CLI component of the composite User-Agent the growth probe measured as
 * accepted. Kept beside the chat client's `CLIENT_UA` in `upstream.ts` rather
 * than shared, because the two composites differ in shape; a future version
 * bump must update both.
 */
const CLI_COMPONENT = '2.63.2'

/** Browser-shaped User-Agent for the web growth center (claim). */
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * The outbound header shapes these endpoints accept.
 *
 * Each one is a measurement, not a preference:
 * - `growth` — task list/accept, streak, lottery, travel on the copilot host,
 *   with the composite desktop User-Agent (`tools/growth-probe.mjs` returns 200
 *   for every route with exactly this set).
 * - `claim` — task reward claim. The chat host answers 400 for this path and the
 *   web host answers 200, so it carries the web origin, the web platform marker
 *   and a browser User-Agent (both references measured the split).
 * - `billing` — daily check-in on the billing host, whose headers the billing
 *   probe measured as accepted (`tools/checkin-probe.mjs`).
 */
export type GrowthHeaderShape = 'growth' | 'claim' | 'billing'

/** The host that serves one header shape. Host and headers move together. */
function baseFor(shape: GrowthHeaderShape): string {
  if (shape === 'claim') return WEB_BASE
  if (shape === 'billing') return BILLING_BASE
  return CHAT_BASE
}

/** Headers for one growth request. */
export function growthHeaders(credential: WorkBuddyCredential, shape: GrowthHeaderShape): Record<string, string> {
  const identity: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    'X-Domain': credential.domain === '' ? 'copilot.tencent.com' : credential.domain,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    ...deviceHeaders(credential.uid),
    'X-Request-ID': requestId(credential.uid),
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId },
  }
  // The web growth center is a browser surface: it wants the browser markers and
  // none of the desktop identity beyond the bearer token and the user id.
  if (shape === 'claim') {
    return {
      ...identity,
      Origin: WEB_BASE,
      Referer: `${WEB_BASE}/profile/growth-center`,
      'x-client-platform': 'web',
      'User-Agent': WEB_USER_AGENT,
    }
  }
  // The desktop-shaped endpoints: the version comes from the shared identity so
  // a configured app version governs these too, and the UA carries the product
  // name the upstream splits on.
  const version = resolveAppVersion('cn')
  return {
    ...identity,
    'X-Requested-With': 'XMLHttpRequest',
    Origin: BILLING_BASE,
    Referer: `${BILLING_BASE}/`,
    'X-Product': 'SaaS',
    'User-Agent': shape === 'billing'
      ? `WorkBuddy/${version}`
      : `WorkBuddy/${version} WorkBuddy/${version} CLI/${CLI_COMPONENT}`,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': version,
  }
}

/** One task row, flattened from the upstream shape (progress may be nested or flat). */
export interface GrowthTask {
  code: string
  title: string
  /** Action guidance; `jumpUrl` is a desktop deep link (`workbuddy://…`). */
  description: string
  jumpUrl: string
  /** `not_accepted` / `accepted` / `completed` / `claimed`, upstream verbatim. */
  acceptStatus: string
  current: number
  target: number
  rewardCredit: number
  rewardEnergy: number
  locked: boolean
}

/** One streak tier row (7d/14d/28d). */
export interface GrowthStreakTier {
  tier: string
  days: number
  credit: number
  energy: number
  cards: number
  chances: number
  /** `locked` / `ready` / `claimed` (upstream `tier_*_status`). */
  status: string
}

/** One read-only status view across the growth center. */
export interface GrowthStatusView {
  tasks: readonly GrowthTask[]
  streakDays: number
  makeupCards: number
  tiers: readonly GrowthStreakTier[]
  lotteryChances: number
  travel: { state: string; dailyLimitReached: boolean; rewardCredit: number }
  energyBalance: number
}

/** Options for {@link GrowthClient}; all injectable so tests never touch the network. */
export interface GrowthClientOptions {
  now?: () => number
  fetchImpl?: typeof fetch
  /** Minimum gap between two upstream calls (risk-control pacing). */
  gapMs?: number
}

/** The measured envelope every growth endpoint answers with. */
export interface GrowthEnvelope<T> {
  code: number
  msg: string
  data: T | undefined
  /** HTTP status, for callers that distinguish transport from business failure. */
  status: number
}

/** The daily check-in outcome; `already` is a success, not an error. */
export interface CheckinResult {
  ok: boolean
  /** Upstream said today was already claimed (code 10001). */
  already: boolean
  msg: string
  code: number
  status: number
}

/**
 * CN growth-center client over the stored credentials.
 *
 * One instance serves every CN account; each call names the account. Every
 * write-shaped method is **idempotent or safely rejected**: `accept` replays
 * (already-accepted is a success), `claim` is rejected by upstream when the
 * progress has not landed or was already claimed, `depart` refuses a second
 * same-day departure. A scheduled run racing the user's own clicks therefore
 * cannot double-claim anything.
 */
export class GrowthClient {
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly gapMs: number
  /** When the last upstream call finished; pacing keeps ≥ gapMs between calls. */
  private lastCallAt = 0

  constructor(options: GrowthClientOptions = {}) {
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.gapMs = options.gapMs ?? 1_000
  }

  /** Wait out the risk-control gap, then stamp this call. */
  private async pace(): Promise<void> {
    const since = this.now() - this.lastCallAt
    if (this.lastCallAt !== 0 && since < this.gapMs) {
      await new Promise(resolve => setTimeout(resolve, this.gapMs - since))
    }
    this.lastCallAt = this.now()
  }

  /**
   * One JSON call and its envelope.
   *
   * Growth endpoints answer business failures with `code != 0` inside HTTP 200
   * ("task not completed" arrives 200), so callers check `code`, not just
   * `status`. A non-JSON body (HTML error page, empty 404) reads as a transport
   * failure with `code -1` rather than throwing.
   *
   * **The host follows the header shape.** The claim shape carries the web
   * origin, and panel measured that sending web headers to the chat host (or
   * vice versa) is exactly what earns the 400 — so the URL base is chosen from
   * the same `shape` the headers are, and the two cannot drift apart.
   */
  private async call<T>(
    credential: WorkBuddyCredential,
    method: 'GET' | 'POST',
    path: string,
    shape: GrowthHeaderShape,
    body?: unknown,
  ): Promise<GrowthEnvelope<T>> {
    await this.pace()
    const base = baseFor(shape)
    let response: Response
    try {
      response = await this.fetchImpl(`${base}${path}`, {
        method,
        headers: growthHeaders(credential, shape),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error: unknown) {
      return { code: -1, msg: error instanceof Error ? error.message : String(error), data: undefined, status: 0 }
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | { code?: number; msg?: string; data?: T }
      | undefined
    return {
      code: parsed?.code ?? (response.ok ? 0 : -1),
      msg: parsed?.msg ?? '',
      data: parsed?.data,
      status: response.status,
    }
  }

  /** Pull and flatten the task list. */
  async tasks(credential: WorkBuddyCredential): Promise<GrowthEnvelope<readonly GrowthTask[]>> {
    const env = await this.call<unknown>(credential, 'GET', '/v2/activity/growth/tasks', 'growth')
    const raw = (env.data as { tasks?: unknown } | undefined)?.tasks
    if (!Array.isArray(raw)) return { ...env, data: [] }
    return { ...env, data: raw.map(parseTask) }
  }

  /**
   * Accept tasks in one batch.
   *
   * Returns the accepted codes plus the ones upstream rejected; a rejected code
   * is **not** a thrown error, because the batch partially succeeding is the
   * normal case and the caller reports per-task outcomes.
   */
  async accept(
    credential: WorkBuddyCredential,
    codes: readonly string[],
  ): Promise<{ accepted: readonly string[]; failed: readonly string[] } & GrowthEnvelope<unknown>> {
    if (codes.length === 0) {
      return { accepted: [], failed: [], code: 0, msg: '', data: undefined, status: 200 }
    }
    const env = await this.call<{ results?: Array<{ task_code?: string; status?: string }> }>(
      credential, 'POST', '/v2/activity/growth/tasks/accept', 'growth', { task_codes: codes },
    )
    const accepted: string[] = []
    const failed: string[] = []
    const seen = new Set<string>()
    for (const row of env.data?.results ?? []) {
      const code = row.task_code ?? ''
      seen.add(code)
      if (row.status === 'accepted' || row.status === 'already_accepted') accepted.push(code)
      else failed.push(code)
    }
    for (const code of codes) if (!seen.has(code)) failed.push(code)
    return { accepted, failed, ...env }
  }

  /** Claim one task's reward. Returns the credited amounts on success. */
  async claim(
    credential: WorkBuddyCredential,
    code: string,
  ): Promise<{ ok: boolean; credit: number; energy: number; msg: string }> {
    const env = await this.call<{ credit?: number; energy?: number }>(
      credential, 'POST', `/activity/growth/tasks/${encodeURIComponent(code)}/claim`, 'claim', {},
    )
    return {
      ok: env.code === 0,
      credit: env.data?.credit ?? 0,
      energy: env.data?.energy ?? 0,
      msg: env.msg,
    }
  }

  /** Redeem one unlocked streak tier (`7d` / `14d` / `28d`). */
  async redeemTier(credential: WorkBuddyCredential, tier: string): Promise<GrowthEnvelope<unknown>> {
    return this.call(credential, 'POST', '/activity/growth/redeem', 'growth', { tier })
  }

  /** Draw the lottery once; returns the raw prize payload for display. */
  async lotteryDraw(credential: WorkBuddyCredential): Promise<GrowthEnvelope<unknown>> {
    return this.call(credential, 'POST', '/activity/growth/lottery/draw', 'growth', {})
  }

  /**
   * Depart the buddy on a trip.
   *
   * The location id comes from `travel/config` (first entry), because an empty
   * body is rejected with 400 "invalid request" (measured by the reference and
   * consistent with the config endpoint's existence). Falls back to `1` when
   * the config cannot be read.
   */
  async travelDepart(credential: WorkBuddyCredential): Promise<GrowthEnvelope<{ location?: { name?: string } }>> {
    let locationId: number | undefined
    const config = await this.call<{ locations?: Array<{ id?: number }> }>(
      credential, 'GET', '/activity/growth/buddy/travel/config', 'growth',
    )
    const first = config.data?.locations?.[0]
    if (typeof first?.id === 'number') locationId = first.id
    return this.call(credential, 'POST', '/activity/growth/buddy/travel/depart', 'growth', {
      location_id: locationId ?? 1,
    })
  }

  /** Claim a returned buddy's reward. */
  async travelClaim(credential: WorkBuddyCredential): Promise<GrowthEnvelope<{ reward_credit?: number }>> {
    return this.call(credential, 'POST', '/activity/growth/buddy/travel/claim', 'growth', {})
  }

  /**
   * Claim today's daily check-in on the billing host.
   *
   * Both codes mean "nothing left to do today": `0` credited a new day, and
   * `10001` says the day was already claimed — which is the normal answer when a
   * scheduled run races the user's own click, so it is reported as `already`
   * rather than as a failure. Any other code is a real rejection.
   */
  async checkin(credential: WorkBuddyCredential): Promise<CheckinResult> {
    const env = await this.call<unknown>(credential, 'POST', '/v2/billing/meter/daily-checkin', 'billing', {})
    const already = env.code === 10001
    return { ok: env.code === 0 || already, already, msg: env.msg, code: env.code, status: env.status }
  }

  /**
   * One read-only pass over the whole growth center.
   *
   * Each section is independent: one failing endpoint costs its own field and
   * never the rest, so a single dead route cannot blank the whole view.
   */
  async status(credential: WorkBuddyCredential): Promise<GrowthStatusView> {
    const view: GrowthStatusView = {
      tasks: [], streakDays: 0, makeupCards: 0, tiers: [], lotteryChances: 0,
      travel: { state: 'unknown', dailyLimitReached: false, rewardCredit: 0 },
      energyBalance: 0,
    }
    const [tasks, streak, travel, lottery, energy] = await Promise.all([
      this.tasks(credential),
      this.call<Record<string, unknown>>(credential, 'GET', '/activity/growth/streak', 'growth'),
      this.call<Record<string, unknown>>(credential, 'GET', '/activity/growth/buddy/travel/status', 'growth'),
      this.call<{ chances?: number }>(credential, 'GET', '/activity/growth/lottery/summary', 'growth'),
      this.call<{ balance?: number }>(credential, 'GET', '/v2/activity/growth/energy', 'growth'),
    ])
    view.tasks = tasks.data ?? []
    const streakData = streak.data ?? {}
    const streakInfo = (streakData['streak'] ?? {}) as { days?: number }
    const cards = (streakData['makeup_cards'] ?? {}) as { balance?: number }
    const redemption = (streakData['redemption_status'] ?? {}) as Record<string, unknown>
    view.streakDays = streakInfo.days ?? 0
    view.makeupCards = cards.balance ?? 0
    view.tiers = parseTiers(redemption)
    view.lotteryChances = lottery.data?.chances ?? 0
    const travelData = travel.data ?? {}
    view.travel = {
      state: String(travelData['state'] ?? 'unknown'),
      dailyLimitReached: travelData['daily_limit_reached'] === true,
      rewardCredit: typeof travelData['reward_credit'] === 'number' ? travelData['reward_credit'] : 0,
    }
    view.energyBalance = energy.data?.balance ?? 0
    return view
  }
}

/** Flatten one task row; `progress` may be nested or flat (both measured). */
function parseTask(raw: unknown): GrowthTask {
  const row = (raw ?? {}) as Record<string, unknown>
  const progress = (row['progress'] ?? {}) as Record<string, unknown>
  const current = typeof progress['current'] === 'number' ? progress.current : Number(row['current'] ?? 0)
  const target = typeof progress['target'] === 'number' ? progress.target : Number(row['target'] ?? 0)
  return {
    code: String(row['task_code'] ?? ''),
    title: String(row['title'] ?? row['task_code'] ?? ''),
    description: String(row['description'] ?? row['task_desc'] ?? ''),
    jumpUrl: String(row['jump_url'] ?? ''),
    acceptStatus: String(row['accept_status'] ?? 'not_accepted'),
    current,
    target,
    rewardCredit: Number(row['reward_credit'] ?? 0),
    rewardEnergy: Number(row['reward_energy'] ?? 0),
    locked: row['locked'] === true,
  }
}

/** Flatten the redemption tiers from the streak document. */
function parseTiers(redemption: Record<string, unknown>): GrowthStreakTier[] {
  const rows = redemption['tiers']
  if (!Array.isArray(rows)) return []
  return rows.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>
    const tier = String(row['tier'] ?? '')
    const status = redemption[`tier_${tier}_status`]
    return {
      tier,
      days: Number(row['days'] ?? 0),
      credit: Number(row['credit'] ?? 0),
      energy: Number(row['energy'] ?? 0),
      cards: Number(row['cards'] ?? 0),
      chances: Number(row['chances'] ?? 0),
      status: String(status ?? 'locked'),
    }
  })
}
