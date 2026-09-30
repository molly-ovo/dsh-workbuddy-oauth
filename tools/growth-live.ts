/**
 * Live check of the shipped growth runner against the real upstream.
 *
 * This drives `src/growth-scheduler.ts` and `src/growth-runner.ts` themselves —
 * the code the plugin runs — rather than re-implementing their requests the way
 * the probe scripts do. That distinction matters: the probes only prove the
 * *probe's* headers are accepted, and the shipped set had drifted from them.
 *
 * It performs real, idempotent writes (check-in, travel claim/depart, streak
 * redeem, lottery, and claiming tasks the user actually completed). Re-running is
 * safe: every one of them is rejected or reported as "already done" by upstream.
 *
 * Usage:
 *   node tools/growth-live.ts          # read-only status per account
 *   node tools/growth-live.ts --run    # status, then a full pass
 */

import { listCredentials } from '../src/credentials.ts'
import { GrowthClient } from '../src/growth.ts'
import { readGrowthStatus, runGrowthSweep } from '../src/growth-scheduler.ts'

const wantRun = process.argv.includes('--run')
const client = new GrowthClient()

const status = await readGrowthStatus({ client })
if (status.length === 0) {
  console.log('没有启用中的国内版账号')
  process.exit(0)
}

for (const entry of status) {
  console.log(`=== ${entry.label} (uid=${entry.uid.slice(0, 8)}) ===`)
  if (entry.view === undefined) {
    console.log(`  读取失败：${entry.error}`)
    continue
  }
  const view = entry.view
  console.log(`  任务 ${view.tasks.length} 个｜连登 ${view.streakDays} 天｜猫猫 ${view.travel.state}｜抽奖 ${view.lotteryChances}｜能量 ${view.energyBalance}`)
  console.log(`  今日自动任务：${entry.due.due ? '待执行' : entry.due.reason}`)
  for (const task of view.tasks.filter(t => t.target > 0 && t.current >= t.target && t.acceptStatus !== 'claimed')) {
    console.log(`    可领：${task.code} +${task.rewardCredit}`)
  }
  console.log('')
}

if (!wantRun) {
  console.log('（只读检查；加 --run 执行一次完整任务链）')
  process.exit(0)
}

console.log('=== 执行一次完整任务链（force）===')
const credentials = await listCredentials()
const entries = await runGrowthSweep({ client, force: true, credentials: async () => credentials })
for (const entry of entries) {
  if (!entry.ran) {
    console.log(`【${entry.label}】跳过：${entry.reason}`)
    continue
  }
  console.log(`【${entry.label}】`)
  if (entry.error !== undefined) console.log(`  异常：${entry.error}`)
  for (const line of entry.result?.lines ?? []) console.log(`  ${line}`)
  console.log(`  合计：+${entry.result?.credit ?? 0} 积分 +${entry.result?.energy ?? 0} 能量`)
}
