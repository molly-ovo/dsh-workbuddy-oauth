/**
 * The growth automation runner: one idempotent pass per account.
 *
 * **Scope: real endpoints only (the account owner's decision).** The references
 * light their daily rewards by POSTing fabricated `chat_request_send` events to
 * `/v2/report`. This runner does not, so P4's 4.4 activity report and 4.6
 * night-owl task are dropped rather than quietly implemented — the owner's
 * account had already been rate-limited once, and the reward is a few points.
 * What remains needs no forgery: check-in, buddy travel, streak redemption,
 * lottery, and claiming tasks the *user really completed* (which is how a manual
 * desktop session pays out).
 *
 * Deliberately also absent: accepting incomplete tasks. With no event channel an
 * accepted task can only ever be advanced by a real desktop action, and the
 * reference's own note records the failure mode — "a pile of accepted tasks at
 * 0/1". Claiming does not require accepting, so nothing is lost.
 *
 * @module dsh-workbuddy-standalone/growth-runner
 */

import { GrowthClient, type GrowthStatusView, type GrowthTask } from './growth.ts'
import { displayNameOf } from './credentials.ts'
import type { WorkBuddyCredential } from './credentials.ts'

/** One human-readable line of run output. */
export type GrowthRunLine = string

/** The outcome of one full pass for one account. */
export interface GrowthRunResult {
  uid: string
  label: string
  ok: boolean
  /** Credit and energy actually landed this pass. */
  credit: number
  energy: number
  /** Whether today's check-in was settled by this pass (vs already done). */
  checkedIn: boolean
  lines: readonly GrowthRunLine[]
}

/** Options for {@link runGrowthPass}; the client is injectable for tests. */
export interface GrowthRunnerOptions {
  client?: GrowthClient
  now?: () => number
}

/**
 * Whether a task can be claimed right now.
 *
 * Exported because "progress reached but not yet claimed" is exactly the state
 * the user's own desktop actions produce, and the runner must settle those too
 * — hub's note: completed tasks must be claimed first, not skipped, or the
 * reward from a manual action is lost.
 */
export function isClaimable(task: GrowthTask): boolean {
  return task.acceptStatus !== 'claimed' && task.target > 0 && task.current >= task.target
}

/**
 * Run one full growth pass for one CN account.
 *
 * Ordering: settle the daily check-in, then claim everything already complete —
 * the only rewards a real desktop session makes claimable, and the ones the
 * reference warns must not be skipped. Travel, tiers and lottery close the pass.
 * Each step is independent, so one failure never aborts the rest; the pass is
 * safe to re-run at any time because every write is idempotent upstream.
 */
export async function runGrowthPass(
  credential: WorkBuddyCredential,
  options: GrowthRunnerOptions = {},
): Promise<GrowthRunResult> {
  const client = options.client ?? new GrowthClient(options)
  const label = displayNameOf(credential)
  const lines: string[] = []
  let credit = 0
  let energy = 0

  // 0. Daily check-in. `already` is the normal steady-state answer, so it is
  //    reported as done rather than as noise.
  let checkedIn = false
  const checkin = await client.checkin(credential)
  if (checkin.ok) {
    checkedIn = true
    lines.push(checkin.already ? '✓ 今日签到已完成' : '✓ 签到成功')
  } else {
    lines.push(`! 签到失败：${checkin.msg || `code=${checkin.code}`}`)
  }

  const status = await client.status(credential)
  if (status.tasks.length === 0) {
    lines.push('未获取到任务清单（上游无数据或网络失败）')
    return { uid: credential.uid, label, ok: false, credit, energy, checkedIn, lines }
  }

  // 1. Settle everything already complete — the cheapest rewards first, and the
  //    only ones a manual desktop action makes claimable.
  const claimable = status.tasks.filter(isClaimable)
  for (const task of claimable) {
    const result = await client.claim(credential, task.code)
    if (result.ok) {
      credit += result.credit
      energy += result.energy
      lines.push(`✓ [${task.title}] 领奖 +${result.credit} 积分${result.energy > 0 ? ` +${result.energy} 能量` : ''}`)
    } else {
      lines.push(`! [${task.title}] 领奖失败：${result.msg || '未知原因'}`)
    }
  }

  // 2. Report, never accept: with no event channel an accepted task can only be
  //    advanced by a real desktop action, and claiming needs no acceptance.
  const pending = status.tasks.filter((task) => task.acceptStatus === 'not_accepted' && !task.locked)
  if (pending.length > 0) {
    lines.push(`ℹ ${pending.length} 个任务需在桌面端真实操作后自动点亮，本插件不做事件伪造`)
  }

  // 3. Buddy travel: claim an arrived reward, depart an idle buddy.
  const travel = await runTravelPass(client, credential, status)
  lines.push(...travel.lines)
  credit += travel.credit

  // 4. Streak tiers: redeem every tier that is ready; locked/claimed skip.
  for (const tier of status.tiers) {
    if (tier.status !== 'ready') continue
    const result = await client.redeemTier(credential, tier.tier)
    if (result.code === 0) {
      credit += tier.credit
      energy += tier.energy
      lines.push(`★ 兑换 ${tier.tier} 连登档（+${tier.credit} 积分 +${tier.energy} 能量 卡×${tier.cards} 抽×${tier.chances}）`)
    } else {
      // 403 "days not enough" is the expected shape for a race with the daily
      // rollover; anything else is worth the message.
      lines.push(`! 兑换 ${tier.tier} 档失败：${result.msg || `code=${result.code}`}`)
    }
  }

  // 5. Lottery: spend every chance the summary reports.
  let chances = status.lotteryChances
  while (chances > 0) {
    const draw = await client.lotteryDraw(credential)
    if (draw.code !== 0) {
      lines.push(`! 抽奖失败：${draw.msg || `code=${draw.code}`}`)
      break
    }
    lines.push(`🎲 抽奖：${summarize(draw.data)}`)
    chances -= 1
  }

  lines.push(`本次到账：+${credit} 积分 +${energy} 能量（连登 ${status.streakDays} 天）`)
  return { uid: credential.uid, label, ok: true, credit, energy, checkedIn, lines }
}

/** Travel sub-pass, split out because its states read as a small machine. */
async function runTravelPass(
  client: GrowthClient,
  credential: WorkBuddyCredential,
  status: GrowthStatusView,
): Promise<{ credit: number; lines: string[] }> {
  const lines: string[] = []
  let credit = 0
  const { state, dailyLimitReached } = status.travel
  if (state === 'arrived') {
    const claim = await client.travelClaim(credential)
    if (claim.code === 0) {
      const reward = claim.data?.reward_credit ?? 0
      credit += reward
      lines.push(`🐱 猫猫归来领奖 +${reward} 积分`)
    } else {
      lines.push(`! 猫猫领奖失败：${claim.msg || `code=${claim.code}`}`)
    }
  } else if (state === 'idle') {
    if (dailyLimitReached) {
      lines.push('🐱 猫猫今日已旅行过，明日刷新')
    } else {
      const depart = await client.travelDepart(credential)
      if (depart.code === 0) {
        lines.push(`🐱 猫猫已出发${depart.data?.location?.name ? `前往「${depart.data.location.name}」` : ''}`)
      } else {
        lines.push(`! 猫猫派出失败：${depart.msg || `code=${depart.code}`}`)
      }
    }
  } else if (state === 'traveling') {
    lines.push('🐱 猫猫旅行途中')
  } else {
    lines.push(`? 猫猫状态未知：${state}`)
  }
  return { credit, lines }
}

/** One-line summary of a lottery prize payload, whatever shape it has. */
function summarize(data: unknown): string {
  if (data === undefined || data === null) return '（无明细）'
  const text = JSON.stringify(data)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}
