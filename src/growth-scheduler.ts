/**
 * The growth scheduler: when to run a pass, and how to run one safely.
 *
 * **In-process timers, not `dsh-schedule`.** The harness scheduler delivers a
 * prompt to a Session, which starts an agent turn: using it for a background
 * HTTP maintenance job would burn model tokens to make a check-in call. Both
 * reference projects run their own in-process timers for exactly this reason.
 *
 * Cadence mirrors hub's: two attempt hours a day, so a failed morning pass gets
 * a second chance in the evening, while the persisted `lastSuccessDate` keeps the
 * day from running twice.
 *
 * @module dsh-workbuddy-standalone/growth-scheduler
 */

import { GrowthClient, type GrowthStatusView } from './growth.ts'
import { runGrowthPass, type GrowthRunResult } from './growth-runner.ts'
import { readTaskState, updateTaskState, type TaskStateEntry } from './task-state.ts'
import { listCredentials, displayNameOf, type WorkBuddyCredential } from './credentials.ts'
import { disabledUids } from './account-state.ts'
import { refreshCredential } from './refresh.ts'

/** Local hours at which a pass is attempted. Two, so a failure can retry. */
export const RUN_HOURS: readonly number[] = [9, 21]

/** Minimum gap between two attempts for one account, so a tick cannot hammer. */
export const RETRY_GUARD_MS = 3 * 60 * 60_000

/** Refresh a token proactively once it is this close to expiring (hub's margin). */
export const KEEPALIVE_MARGIN_MS = 2 * 60 * 60_000

/** Local `YYYY-MM-DD`, the day key both the state file and the due check use. */
export function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Whether a pass is due, with a reason for the log. */
export interface DueDecision {
  due: boolean
  reason: string
}

/**
 * Decide whether one account should run now.
 *
 * The three rules are ordered by authority: an already-finished day outranks the
 * attempt window, and the window outranks the retry guard, so an account is never
 * reported as "not due" merely because a previous attempt failed.
 */
export function dueForRun(entry: TaskStateEntry | undefined, now: Date): DueDecision {
  const today = localDate(now)
  if (entry !== undefined && entry.lastSuccessDate === today) {
    return { due: false, reason: '今日已完成' }
  }
  if (!RUN_HOURS.includes(now.getHours())) {
    return { due: false, reason: `不在执行时段（${RUN_HOURS.join('/')} 点）` }
  }
  if (entry !== undefined && now.getTime() - entry.lastAttemptAtMs < RETRY_GUARD_MS) {
    return { due: false, reason: '距上次尝试不足 3 小时' }
  }
  return { due: true, reason: '到期执行' }
}

/** One account's sweep outcome. */
export interface GrowthSweepEntry {
  uid: string
  label: string
  ran: boolean
  reason: string
  result?: GrowthRunResult
  error?: string
}

/** Options for {@link runGrowthSweep}. */
export interface GrowthSweepOptions {
  client?: GrowthClient
  now?: () => Date
  /** Credentials, injectable for tests. */
  credentials?: () => Promise<readonly WorkBuddyCredential[]>
  /** Disabled uids, injectable for tests. */
  disabled?: () => Promise<ReadonlySet<string>>
  /** Refresh hook, injectable for tests. */
  refresh?: typeof refreshCredential
  /** `true` runs every enabled account regardless of the due check. */
  force?: boolean
}

/**
 * Run one sweep. Each account is isolated: a throw is recorded for that account
 * and never stops the others (the phase's acceptance rule), and a pass that
 * reached upstream records the day so the next tick skips it.
 */
export async function runGrowthSweep(options: GrowthSweepOptions = {}): Promise<GrowthSweepEntry[]> {
  const now = options.now ?? (() => new Date())
  const client = options.client ?? new GrowthClient()
  const loadCredentials = options.credentials ?? listCredentials
  const loadDisabled = options.disabled ?? disabledUids
  const refresh = options.refresh ?? refreshCredential

  const [all, disabled, state] = await Promise.all([loadCredentials(), loadDisabled(), readTaskState()])
  const accounts = all.filter(credential => credential.region === 'cn' && !disabled.has(credential.uid))

  const entries: GrowthSweepEntry[] = []
  for (const credential of accounts) {
    const label = displayNameOf(credential)
    const at = now()
    const decision = options.force === true ? { due: true, reason: '手动触发' } : dueForRun(state[credential.uid], at)
    if (!decision.due) {
      entries.push({ uid: credential.uid, label, ran: false, reason: decision.reason })
      continue
    }
    // Remember the attempt before it happens: a pass that dies mid-flight must
    // still count as attempted, or a tick loop would retry it immediately.
    await updateTaskState(credential.uid, { lastAttemptAtMs: at.getTime() })

    let result: GrowthRunResult | undefined
    let error: string | undefined
    await keepalive(credential, at, refresh)
    try {
      result = await runGrowthPass(credential, { client })
    } catch (thrown: unknown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }

    // Only a pass that reached upstream marks the day done, so an offline laptop
    // still runs at the next hour instead of losing the day.
    if (result?.ok === true) {
      await updateTaskState(credential.uid, { lastSuccessDate: localDate(at) })
    }
    entries.push({
      uid: credential.uid, label, ran: true, reason: decision.reason,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    })
  }
  return entries
}

/**
 * Refresh a token that is about to expire, so an account idle for days still has
 * a live session when a request finally arrives (P4's keepalive). A failure is
 * not fatal here: the on-demand refresh in `store.resolve` remains the backstop.
 */
async function keepalive(
  credential: WorkBuddyCredential,
  now: Date,
  refresh: typeof refreshCredential,
): Promise<void> {
  if (credential.expiresAtMs - now.getTime() > KEEPALIVE_MARGIN_MS) return
  await refresh(credential.uid).catch(() => undefined)
}

/** One account's read-only growth view, for the status command. */
export interface GrowthStatusEntry {
  uid: string
  label: string
  view?: GrowthStatusView
  /** Whether today's pass already ran, and why it would not now. */
  due: DueDecision
  error?: string
}

/** Options for {@link readGrowthStatus}; same seams as the sweep. */
export interface GrowthStatusOptions {
  client?: GrowthClient
  now?: () => Date
  credentials?: () => Promise<readonly WorkBuddyCredential[]>
  disabled?: () => Promise<ReadonlySet<string>>
}

/**
 * Read every enabled CN account's growth state without writing anything.
 *
 * A per-account failure is reported in that account's entry: a status command
 * that throws because one token expired tells the user nothing about the rest.
 */
export async function readGrowthStatus(options: GrowthStatusOptions = {}): Promise<GrowthStatusEntry[]> {
  const now = options.now ?? (() => new Date())
  const client = options.client ?? new GrowthClient()
  const loadCredentials = options.credentials ?? listCredentials
  const loadDisabled = options.disabled ?? disabledUids

  const [all, disabled, state] = await Promise.all([loadCredentials(), loadDisabled(), readTaskState()])
  const accounts = all.filter(credential => credential.region === 'cn' && !disabled.has(credential.uid))

  const entries: GrowthStatusEntry[] = []
  for (const credential of accounts) {
    const base = {
      uid: credential.uid,
      label: displayNameOf(credential),
      due: dueForRun(state[credential.uid], now()),
    }
    try {
      entries.push({ ...base, view: await client.status(credential) })
    } catch (thrown: unknown) {
      entries.push({ ...base, error: thrown instanceof Error ? thrown.message : String(thrown) })
    }
  }
  return entries
}
