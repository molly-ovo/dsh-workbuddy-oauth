/**
 * Growth client tests over a stubbed fetch.
 *
 * What these pin down is the wire behaviour the references measured and this
 * module re-measured with `tools/growth-probe.mjs`:
 * - envelopes arrive inside HTTP 200, so callers check `code`, not `response.ok`;
 * - the claim host and origin are the web ones (the chat host answers 400);
 * - a non-JSON body reads as a transport failure instead of throwing;
 * - `accept` reports per-task outcomes instead of collapsing to one boolean;
 * - `status` keeps its sections independent: one dead route costs one field.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrowthClient, growthHeaders } from '../src/growth.ts'
import { resolveAppVersion } from '../src/identity.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

let home = ''
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-growth-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'copilot.tencent.com', uid: 'uid-a', region: 'cn',
}

interface RecordedCall {
  url: string
  init?: RequestInit | undefined
}

interface Route {
  pattern: RegExp
  status?: number
  body: unknown
}

/** A fetch stub that records every call and answers from the first matching route. */
function stubFetch(routes: readonly Route[]): { client: GrowthClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    const route = routes.find(candidate => candidate.pattern.test(url))
    const body = route === undefined ? { code: -1, msg: 'no route' } : route.body
    return new Response(JSON.stringify(body), {
      status: route?.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { client: new GrowthClient({ fetchImpl, gapMs: 0 }), calls }
}

const TASKS_ENVELOPE = {
  code: 0,
  msg: 'OK',
  data: {
    tasks: [
      {
        task_code: 'create_canvas', title: '创建设计任务', description: '前往 Workbuddy 创建画布',
        jump_url: 'workbuddy://chat', accept_status: 'completed', locked: false,
        reward_credit: 300, reward_energy: 5, progress: { current: 1, target: 1 },
      },
      {
        task_code: 'chat_5', title: '发起 5 次对话', description: '', jump_url: 'workbuddy://chat',
        accept_status: 'accepted', locked: false, reward_credit: 100, reward_energy: 0,
        current: 2, target: 5,
      },
    ],
  },
}

const STREAK_ENVELOPE = {
  code: 0,
  msg: 'OK',
  data: {
    streak: { days: 8 },
    makeup_cards: { balance: 1, max: 4 },
    redemption_status: {
      tier_7d_status: 'ready',
      tier_14d_status: 'locked',
      tier_28d_status: 'claimed',
      tiers: [
        { tier: '7d', days: 7, credit: 0, energy: 2, cards: 1, chances: 1 },
        { tier: '14d', days: 14, credit: 50, energy: 3, cards: 1, chances: 1 },
        { tier: '28d', days: 28, credit: 150, energy: 5, cards: 1, chances: 1 },
      ],
    },
  },
}

function growthRoutes(overrides: Record<string, unknown> = {}): readonly Route[] {
  return [
    { pattern: /\/v2\/activity\/growth\/tasks$/, body: overrides['tasks'] ?? TASKS_ENVELOPE },
    { pattern: /activity\/growth\/streak$/, body: overrides['streak'] ?? STREAK_ENVELOPE },
    {
      pattern: /buddy\/travel\/status$/,
      body: overrides['travel'] ?? { code: 0, msg: 'OK', data: { state: 'idle', daily_limit_reached: false, reward_credit: 0 } },
    },
    { pattern: /lottery\/summary$/, body: { code: 0, msg: 'OK', data: { chances: 2, module: { enabled: true } } } },
    { pattern: /growth\/energy$/, body: { code: 0, msg: 'OK', data: { balance: 12 } } },
    {
      pattern: /buddy\/travel\/config$/,
      body: { code: 0, msg: 'OK', data: { locations: [{ id: 7, name: '海边' }] } },
    },
  ]
}

describe('growthHeaders', () => {
  it('matches the header set the read-only probe measured as accepted', () => {
    // The probe is the only evidence these routes exist, so the shipped headers
    // must be the ones it sent: codebuddy.cn origin, a product-shaped
    // User-Agent, and the desktop markers. A leaner set was never measured.
    const growth = growthHeaders(CREDENTIAL, 'growth')
    expect(growth['Origin']).toBe('https://www.codebuddy.cn')
    expect(growth['User-Agent']).toContain('WorkBuddy/')
    expect(growth['X-Product']).toBe('SaaS')
    expect(growth['X-IDE-Version']).toBe(resolveAppVersion('cn'))
    expect(growth['x-client-platform']).toBeUndefined()
  })

  it('gives the claim shape the web markers instead of the desktop ones', () => {
    const claim = growthHeaders(CREDENTIAL, 'claim')
    expect(claim['Origin']).toBe('https://www.workbuddy.cn')
    expect(claim['Referer']).toBe('https://www.workbuddy.cn/profile/growth-center')
    expect(claim['x-client-platform']).toBe('web')
    // A browser surface does not carry the desktop IDE identity.
    expect(claim['X-IDE-Type']).toBeUndefined()
    expect(claim['X-Product']).toBeUndefined()
  })

  it('gives the billing shape its own User-Agent, without the CLI component', () => {
    const billing = growthHeaders(CREDENTIAL, 'billing')
    expect(billing['User-Agent']).toBe(`WorkBuddy/${resolveAppVersion('cn')}`)
    expect(billing['Origin']).toBe('https://www.codebuddy.cn')
  })

  it('carries the account identity and device headers', () => {
    const headers = growthHeaders(CREDENTIAL, 'growth')
    expect(headers['Authorization']).toBe('Bearer at')
    expect(headers['X-User-Id']).toBe('uid-a')
    expect(headers['X-Machine-ID']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['X-Session-ID']).toMatch(/^[0-9a-f]{32}$/)
    // requestId() derives a per-account hex prefix, then appends the ms suffix.
    expect(headers['X-Request-ID']).toMatch(/^[0-9a-f]{32}-[0-9]{6}$/)
  })

  it('marks a missing enterprise id instead of sending a blank header', () => {
    const headers = growthHeaders(CREDENTIAL, 'growth')
    expect(headers['X-No-Enterprise-Id']).toBe('1')
    expect(headers['X-Enterprise-Id']).toBeUndefined()

    const scoped = growthHeaders({ ...CREDENTIAL, enterpriseId: 'ent-9' }, 'growth')
    expect(scoped['X-Enterprise-Id']).toBe('ent-9')
    expect(scoped['X-Tenant-Id']).toBe('ent-9')
    expect(scoped['X-No-Enterprise-Id']).toBeUndefined()
  })
})

describe('GrowthClient.checkin', () => {
  it('treats a fresh claim and an already-claimed day as the same success', async () => {
    // 10001 is the normal answer when a scheduled run races the user's own
    // click; reporting it as a failure would make an idempotent day look broken.
    const fresh = stubFetch([{ pattern: /daily-checkin$/, body: { code: 0, msg: 'OK', data: { credit: 10 } } }])
    const freshResult = await fresh.client.checkin(CREDENTIAL)
    expect(freshResult.ok).toBe(true)
    expect(freshResult.already).toBe(false)

    const repeat = stubFetch([{ pattern: /daily-checkin$/, body: { code: 10001, msg: 'already checked in' } }])
    const repeatResult = await repeat.client.checkin(CREDENTIAL)
    expect(repeatResult.ok).toBe(true)
    expect(repeatResult.already).toBe(true)
  })

  it('reports a real rejection as a failure', async () => {
    const { client } = stubFetch([{ pattern: /daily-checkin$/, body: { code: 403, msg: 'forbidden' } }])
    const result = await client.checkin(CREDENTIAL)
    expect(result.ok).toBe(false)
    expect(result.already).toBe(false)
    expect(result.msg).toBe('forbidden')
  })

  it('posts to the billing host with the billing header shape', async () => {
    const { client, calls } = stubFetch([{ pattern: /daily-checkin$/, body: { code: 0, data: {} } }])
    await client.checkin(CREDENTIAL)
    expect(calls[0]?.url).toBe('https://www.codebuddy.cn/v2/billing/meter/daily-checkin')
    expect(calls[0]?.init?.headers).toMatchObject({ 'X-Product': 'SaaS' })
    expect(String(calls[0]?.init?.body)).toBe('{}')
  })
})

describe('GrowthClient.tasks', () => {
  it('flattens both progress shapes and keeps the upstream fields', async () => {
    const { client } = stubFetch(growthRoutes())
    const env = await client.tasks(CREDENTIAL)
    expect(env.code).toBe(0)
    expect(env.data).toHaveLength(2)
    // Nested progress shape.
    expect(env.data?.[0]).toMatchObject({ code: 'create_canvas', current: 1, target: 1, rewardCredit: 300 })
    // Flat shape (no `progress` object).
    expect(env.data?.[1]).toMatchObject({ code: 'chat_5', current: 2, target: 5, acceptStatus: 'accepted' })
  })

  it('reads a non-JSON body as a transport failure instead of throwing', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as typeof fetch
    const client = new GrowthClient({ fetchImpl, gapMs: 0 })
    const env = await client.tasks(CREDENTIAL)
    expect(env.code).toBe(-1)
    expect(env.status).toBe(502)
    expect(env.data).toEqual([])
  })
})

describe('GrowthClient.accept', () => {
  it('splits per-task outcomes instead of collapsing to one boolean', async () => {
    const routes: readonly Route[] = [
      ...growthRoutes(),
      {
        pattern: /tasks\/accept$/,
        body: {
          code: 0,
          msg: 'OK',
          data: {
            results: [
              { task_code: 't1', status: 'accepted' },
              { task_code: 't2', status: 'already_accepted' },
              { task_code: 't3', status: 'rejected' },
            ],
          },
        },
      },
    ]
    const { client } = stubFetch(routes)
    const result = await client.accept(CREDENTIAL, ['t1', 't2', 't3', 't4'])
    expect(result.accepted).toEqual(['t1', 't2'])
    // t4 never appeared in the reply: it must not silently count as accepted.
    expect(result.failed).toEqual(['t3', 't4'])
  })

  it('skips the upstream call for an empty batch', async () => {
    const { client, calls } = stubFetch(growthRoutes())
    const result = await client.accept(CREDENTIAL, [])
    expect(result.accepted).toEqual([])
    expect(result.failed).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('GrowthClient.claim', () => {
  it('sends the web shape and reports credit on success', async () => {
    const routes: readonly Route[] = [
      {
        pattern: /tasks\/create_canvas\/claim$/,
        body: { code: 0, msg: 'OK', data: { credit: 300, energy: 5 } },
      },
    ]
    const { client, calls } = stubFetch(routes)
    const result = await client.claim(CREDENTIAL, 'create_canvas')
    expect(result.ok).toBe(true)
    expect(result.credit).toBe(300)
    expect(result.energy).toBe(5)
    // The claim host is the web one: this is the measured difference between a
    // 400 and a 200.
    expect(calls[0]?.url.startsWith('https://www.workbuddy.cn/activity/growth/tasks/')).toBe(true)
    expect(calls[0]?.init?.headers).toMatchObject({ 'x-client-platform': 'web' })
  })

  it('reports a business rejection (code != 0 inside 200) as a failure with the message', async () => {
    const routes: readonly Route[] = [
      { pattern: /claim$/, body: { code: 400, msg: 'task not completed' } },
    ]
    const { client } = stubFetch(routes)
    const result = await client.claim(CREDENTIAL, 'chat_5')
    expect(result.ok).toBe(false)
    expect(result.msg).toBe('task not completed')
    expect(result.credit).toBe(0)
  })
})

describe('GrowthClient.status', () => {
  it('assembles every section from its own endpoint', async () => {
    const { client } = stubFetch(growthRoutes())
    const view = await client.status(CREDENTIAL)
    expect(view.tasks).toHaveLength(2)
    expect(view.streakDays).toBe(8)
    expect(view.makeupCards).toBe(1)
    expect(view.tiers).toEqual([
      { tier: '7d', days: 7, credit: 0, energy: 2, cards: 1, chances: 1, status: 'ready' },
      { tier: '14d', days: 14, credit: 50, energy: 3, cards: 1, chances: 1, status: 'locked' },
      { tier: '28d', days: 28, credit: 150, energy: 5, cards: 1, chances: 1, status: 'claimed' },
    ])
    expect(view.lotteryChances).toBe(2)
    expect(view.travel).toEqual({ state: 'idle', dailyLimitReached: false, rewardCredit: 0 })
    expect(view.energyBalance).toBe(12)
  })

  it('keeps sections independent when one route dies', async () => {
    // The streak endpoint 500s; tasks, travel and lottery must still arrive.
    const routes: readonly Route[] = [
      ...growthRoutes().filter(route => !route.pattern.test('https://copilot.tencent.com/activity/growth/streak')),
      { pattern: /streak$/, status: 500, body: { error: 'boom' } },
    ]
    const { client } = stubFetch(routes)
    const view = await client.status(CREDENTIAL)
    expect(view.tasks).toHaveLength(2)
    expect(view.streakDays).toBe(0)
    expect(view.tiers).toEqual([])
    expect(view.travel.state).toBe('idle')
    expect(view.lotteryChances).toBe(2)
    expect(view.energyBalance).toBe(12)
  })
})

describe('GrowthClient.travelDepart', () => {
  it('picks the first configured location and sends it as location_id', async () => {
    const routes: readonly Route[] = [
      {
        pattern: /buddy\/travel\/config$/,
        body: { code: 0, msg: 'OK', data: { locations: [{ id: 7, name: '海边' }] } },
      },
      {
        pattern: /buddy\/travel\/depart$/,
        body: { code: 0, msg: 'OK', data: { location: { name: '海边' } } },
      },
    ]
    const { client, calls } = stubFetch(routes)
    const env = await client.travelDepart(CREDENTIAL)
    expect(env.code).toBe(0)
    const depart = calls.find(call => call.url.includes('travel/depart'))
    expect(depart).toBeDefined()
    expect(JSON.parse(String(depart?.init?.body))).toEqual({ location_id: 7 })
  })

  it('falls back to location 1 when the config route is unavailable', async () => {
    const routes: readonly Route[] = [
      {
        pattern: /buddy\/travel\/depart$/,
        body: { code: 0, msg: 'OK', data: { location: { name: '公园' } } },
      },
    ]
    const { client, calls } = stubFetch(routes)
    const env = await client.travelDepart(CREDENTIAL)
    expect(env.code).toBe(0)
    const depart = calls.find(call => call.url.includes('travel/depart'))
    expect(JSON.parse(String(depart?.init?.body))).toEqual({ location_id: 1 })
  })
})
