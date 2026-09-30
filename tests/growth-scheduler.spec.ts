/**
 * Scheduler and task-state tests.
 *
 * The rules pinned here are the ones that decide whether a background job touches
 * a real account: when a pass is due, that it runs at most once a day, that a
 * failed pass still counts as attempted (so a tick loop cannot hammer upstream)
 * but does not mark the day done (so an offline laptop still runs later), and that
 * one account's failure never stops another's.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RETRY_GUARD_MS, dueForRun, localDate, readGrowthStatus, runGrowthSweep,
} from '../src/growth-scheduler.ts'
import { TASK_STATE_FILENAME, awaitTaskStateWrites, readTaskState, updateTaskState } from '../src/task-state.ts'
import type { GrowthClient, GrowthStatusView } from '../src/growth.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

let home = ''
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-tasks-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  await awaitTaskStateWrites()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 30 * 24 * 3_600_000,
  domain: 'copilot.tencent.com', uid: 'uid-a', nickname: '小明', region: 'cn',
}

/** The empty-but-valid status view a stub returns unless overridden. */
function emptyView(overrides: Partial<GrowthStatusView> = {}): GrowthStatusView {
  return {
    tasks: [], streakDays: 0, makeupCards: 0, tiers: [], lotteryChances: 0,
    travel: { state: 'traveling', dailyLimitReached: false, rewardCredit: 0 },
    energyBalance: 0, ...overrides,
  }
}

/** A duck-typed client: the scheduler only calls these members. */
function stubClient(overrides: {
  status?: () => Promise<GrowthStatusView>
  checkin?: () => Promise<{ ok: boolean; already: boolean; msg: string; code: number; status: number }>
  claim?: () => Promise<{ ok: boolean; credit: number; energy: number; msg: string }>
  buddyInfo?: () => Promise<unknown>
  buddyAdopt?: () => Promise<unknown>
} = {}): GrowthClient {
  return {
    checkin: overrides.checkin ?? (async () => ({ ok: true, already: true, msg: '', code: 10001, status: 200 })),
    status: overrides.status ?? (async () => emptyView()),
    claim: overrides.claim ?? (async () => ({ ok: true, credit: 0, energy: 0, msg: '' })),
    // Default: the account already has a buddy, so adoption is not attempted.
    buddyInfo: overrides.buddyInfo ?? (async () => ({ code: 0, msg: 'OK', data: { name: '喵', rarity: 'SR' }, status: 200 })),
    buddyAdopt: overrides.buddyAdopt ?? (async () => ({ outcome: 'failed', msg: 'unexpected', status: 0 })),
    redeemTier: async () => ({ code: 0, msg: '', data: undefined, status: 200 }),
    lotteryDraw: async () => ({ code: 0, msg: '', data: undefined, status: 200 }),
    travelClaim: async () => ({ code: 0, msg: '', data: { reward_credit: 0 }, status: 200 }),
    travelDepart: async () => ({ code: 0, msg: '', data: {}, status: 200 }),
  } as unknown as GrowthClient
}

/** A fixed local clock, so the due rules are tested without waiting. */
function at(hour: number, minute = 0, day = 15): Date {
  return new Date(2026, 8, day, hour, minute, 0, 0)
}

describe('localDate', () => {
  it('formats a local day key with zero padding', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDate(at(9))).toBe('2026-09-15')
  })
})

describe('dueForRun', () => {
  it('is due inside a run hour with no history', () => {
    expect(dueForRun(undefined, at(9))).toEqual({ due: true, reason: '到期执行' })
    expect(dueForRun(undefined, at(21))).toEqual({ due: true, reason: '到期执行' })
  })

  it('is not due outside the run hours', () => {
    // Running at 03:00 would be a needless night-time request against a real account.
    for (const hour of [0, 8, 10, 20, 22, 23]) {
      const decision = dueForRun(undefined, at(hour))
      expect(decision.due).toBe(false)
      expect(decision.reason).toContain('不在执行时段')
    }
  })

  it('is not due again once the day succeeded', () => {
    // This is what keeps a restart, or the 21:00 slot, from re-running a
    // finished day. It outranks the hour and the retry guard.
    for (const hour of [9, 21]) {
      const decision = dueForRun({ lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '2026-09-15' }, at(hour))
      expect(decision.due).toBe(false)
      expect(decision.reason).toBe('今日已完成')
    }
  })

  it('is not due again inside the retry guard after a failed attempt', () => {
    const now = at(9, 30)
    const entry = { lastAttemptAtMs: now.getTime() - (RETRY_GUARD_MS - 60_000), lastSuccessDate: '' }
    const decision = dueForRun(entry, now)
    expect(decision.due).toBe(false)
    expect(decision.reason).toContain('不足 3 小时')
  })

  it('is due again once the retry guard has passed on the same day', () => {
    // A morning failure must still get the evening slot.
    const now = at(21)
    const entry = { lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '' }
    expect(dueForRun(entry, now)).toEqual({ due: true, reason: '到期执行' })
  })

  it('is due on the next day even with a fresh attempt', () => {
    // The attempt is yesterday evening; the guard must not reach across the day.
    const entry = { lastAttemptAtMs: at(21, 0, 14).getTime(), lastSuccessDate: '2026-09-14' }
    expect(dueForRun(entry, at(9, 0, 15)).due).toBe(true)
  })
})

describe('task-state', () => {
  it('round-trips one account and preserves the others', async () => {
    await updateTaskState('uid-a', { lastAttemptAtMs: 1000, lastSuccessDate: '2026-09-15' })
    await updateTaskState('uid-b', { lastAttemptAtMs: 2000 })
    await expect(readTaskState()).resolves.toEqual({
      'uid-a': { lastAttemptAtMs: 1000, lastSuccessDate: '2026-09-15' },
      'uid-b': { lastAttemptAtMs: 2000, lastSuccessDate: '' },
    })
  })

  it('reads an absent or damaged file as empty instead of failing the scheduler', async () => {
    await expect(readTaskState()).resolves.toEqual({})
    const dir = join(home, 'workbuddy-standalone')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, TASK_STATE_FILENAME), '{not json')
    await expect(readTaskState()).resolves.toEqual({})
    await writeFile(join(dir, TASK_STATE_FILENAME), JSON.stringify({ version: 99, accounts: { a: {} } }))
    await expect(readTaskState()).resolves.toEqual({})
  })

  it('skips the write when nothing changed', async () => {
    await updateTaskState('uid-a', { lastAttemptAtMs: 1000 })
    const path = join(home, 'workbuddy-standalone', TASK_STATE_FILENAME)
    const before = await readFile(path, 'utf8')
    await updateTaskState('uid-a', { lastAttemptAtMs: 1000 })
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('runGrowthSweep', () => {
  it('runs a due account and records the day as done', async () => {
    // One in-progress task, so the pass reaches upstream and reports ok — an
    // empty list is the runner's "could not reach upstream" shape.
    const client = stubClient({
      status: async () => emptyView({
        streakDays: 2,
        tasks: [{
          code: 'chat_5', title: '发起 5 次对话', description: '', jumpUrl: '',
          acceptStatus: 'accepted', current: 1, target: 5, rewardCredit: 100, rewardEnergy: 0, locked: false,
        }],
      }),
    })
    const entries = await runGrowthSweep({
      client, now: () => at(9), credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.ran).toBe(true)
    expect(entries[0]?.result?.ok).toBe(true)
    await expect(readTaskState()).resolves.toEqual({
      'uid-a': { lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '2026-09-15' },
    })
  })

  it('skips an account that already succeeded today, without calling upstream', async () => {
    await updateTaskState('uid-a', { lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '2026-09-15' })
    const checkin = vi.fn(async () => ({ ok: true, already: true, msg: '', code: 10001, status: 200 }))
    const entries = await runGrowthSweep({
      client: stubClient({ checkin }), now: () => at(21),
      credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(entries[0]?.ran).toBe(false)
    expect(entries[0]?.reason).toBe('今日已完成')
    expect(checkin).not.toHaveBeenCalled()
  })

  it('forces a run past the due check when asked', async () => {
    // `/wb-task run` must not be suppressed by the day's bookkeeping.
    await updateTaskState('uid-a', { lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '2026-09-15' })
    const entries = await runGrowthSweep({
      client: stubClient(), now: () => at(10), force: true,
      credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(entries[0]?.ran).toBe(true)
    expect(entries[0]?.reason).toBe('手动触发')
  })

  it('records a failed attempt but leaves the day open for a retry', async () => {
    // An offline laptop must not lose the day, and must not be retried on the
    // next tick either — hence attempt recorded, success not.
    const client = stubClient({ status: async () => emptyView() })
    const entries = await runGrowthSweep({
      client, now: () => at(9), credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    // An empty task list is the "could not reach upstream" shape.
    expect(entries[0]?.result?.ok).toBe(false)
    await expect(readTaskState()).resolves.toEqual({
      'uid-a': { lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '' },
    })
  })

  it('isolates a throwing account so the others still run', async () => {
    const other: WorkBuddyCredential = { ...CREDENTIAL, uid: 'uid-b', nickname: '小红' }
    const client = stubClient({
      status: async () => { throw new Error('upstream exploded') },
    })
    const entries = await runGrowthSweep({
      client, now: () => at(9),
      credentials: async () => [CREDENTIAL, other], disabled: async () => new Set(),
    })
    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.ran)).toBe(true)
    expect(entries[0]?.error).toContain('upstream exploded')
  })

  it('skips disabled accounts and the international realm', async () => {
    const global: WorkBuddyCredential = { ...CREDENTIAL, uid: 'uid-g', region: 'global' }
    const entries = await runGrowthSweep({
      client: stubClient(), now: () => at(9),
      credentials: async () => [CREDENTIAL, global],
      disabled: async () => new Set(['uid-a']),
    })
    expect(entries).toHaveLength(0)
  })

  it('refreshes a token that is about to expire, and leaves a fresh one alone', async () => {
    const refresh = vi.fn(async () => ({ status: 'refreshed' }) as never)
    const expiring: WorkBuddyCredential = { ...CREDENTIAL, expiresAtMs: at(9).getTime() + 60_000 }
    await runGrowthSweep({
      client: stubClient(), now: () => at(9), refresh,
      credentials: async () => [expiring], disabled: async () => new Set(),
    })
    expect(refresh).toHaveBeenCalledWith('uid-a')

    refresh.mockClear()
    await runGrowthSweep({
      client: stubClient(), now: () => at(9), refresh, force: true,
      credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('buddy adoption in the pass', () => {
  /** A view with one in-progress task, so a pass reaches upstream and reports ok. */
  const withTask = () => emptyView({
    tasks: [{
      code: 'chat_5', title: '发起 5 次对话', description: '', jumpUrl: '',
      acceptStatus: 'accepted', current: 1, target: 5, rewardCredit: 100, rewardEnergy: 0, locked: false,
    }],
  })

  it('adopts when the account has no buddy and credits the reward', async () => {
    const buddyAdopt = vi.fn(async () => ({ outcome: 'adopted', msg: 'OK', credit: 300, energy: 8, status: 200 }))
    const entries = await runGrowthSweep({
      client: stubClient({
        status: async () => withTask(),
        buddyInfo: async () => ({ code: 0, msg: 'OK', data: undefined, status: 200 }),
        buddyAdopt,
      }),
      now: () => at(9), credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(buddyAdopt).toHaveBeenCalledTimes(1)
    expect(entries[0]?.result?.credit).toBe(300)
    expect(entries[0]?.result?.energy).toBe(8)
    expect(entries[0]?.result?.lines.some(line => line.includes('已领养'))).toBe(true)
  })

  it('does not adopt when a buddy already exists', async () => {
    // The account that already has a companion must not spend an adoption call.
    const buddyAdopt = vi.fn()
    await runGrowthSweep({
      client: stubClient({
        status: async () => withTask(),
        buddyInfo: async () => ({ code: 0, msg: 'OK', data: { name: '暗影喵', rarity: 'SR' }, status: 200 }),
        buddyAdopt: buddyAdopt as never,
      }),
      now: () => at(9), credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(buddyAdopt).not.toHaveBeenCalled()
  })

  it('reports the ineligible threshold honestly instead of faking the prerequisite', async () => {
    // The reference satisfies "active today" by reporting a fabricated event;
    // this path must surface the state and stop, not work around it. (There is no
    // forgery method to assert the absence of — the guarantee is that the only
    // calls made are the real agreement/adoption pair, which the client tests
    // pin.)
    const entries = await runGrowthSweep({
      client: stubClient({
        status: async () => withTask(),
        buddyInfo: async () => ({ code: 0, msg: 'OK', data: undefined, status: 200 }),
        buddyAdopt: async () => ({ outcome: 'threshold', msg: 'first_buddy task not completed yet', status: 400 }),
      }),
      now: () => at(9), credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    const lines = entries[0]?.result?.lines ?? []
    expect(lines.some(line => line.includes('未通过门槛'))).toBe(true)
    // The rest of the pass still runs: an ineligible adoption is not a failure.
    expect(entries[0]?.result?.ok).toBe(true)
    expect(entries[0]?.result?.credit).toBe(0)
  })

  it('keeps going when adoption fails outright', async () => {
    const entries = await runGrowthSweep({
      client: stubClient({
        status: async () => withTask(),
        buddyInfo: async () => ({ code: 0, msg: 'OK', data: undefined, status: 200 }),
        buddyAdopt: async () => ({ outcome: 'failed', msg: 'boom', status: 500 }),
      }),
      now: () => at(9), credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(entries[0]?.result?.ok).toBe(true)
    expect(entries[0]?.result?.lines.some(line => line.includes('领养失败'))).toBe(true)
  })
})

describe('readGrowthStatus', () => {  it('reports a per-account failure without hiding the healthy account', async () => {
    const other: WorkBuddyCredential = { ...CREDENTIAL, uid: 'uid-b', nickname: '小红' }
    let call = 0
    const client = {
      status: async () => {
        call += 1
        if (call === 1) throw new Error('token expired')
        return emptyView({ streakDays: 5 })
      },
    } as unknown as GrowthClient
    const entries = await readGrowthStatus({
      client, now: () => at(10),
      credentials: async () => [CREDENTIAL, other], disabled: async () => new Set(),
    })
    expect(entries[0]?.error).toContain('token expired')
    expect(entries[0]?.view).toBeUndefined()
    expect(entries[1]?.view?.streakDays).toBe(5)
  })

  it('reports why the daily pass has not run', async () => {
    await updateTaskState('uid-a', { lastAttemptAtMs: at(9).getTime(), lastSuccessDate: '2026-09-15' })
    const entries = await readGrowthStatus({
      client: stubClient(), now: () => at(11),
      credentials: async () => [CREDENTIAL], disabled: async () => new Set(),
    })
    expect(entries[0]?.due).toEqual({ due: false, reason: '今日已完成' })
  })
})
