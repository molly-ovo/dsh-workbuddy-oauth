/**
 * Persisted growth-run bookkeeping.
 *
 * The daily pass must run **at most once per day per account**, and that fact
 * has to survive a DSH restart — otherwise every restart re-runs the pass and
 * re-posts check-in and travel calls that upstream already settled. (They are
 * idempotent, so this is waste and extra traffic, not corruption; on a growth
 * endpoint, extra traffic is still the thing to avoid.)
 *
 * Two fields, because "ran today" and "succeeded" are different questions:
 *
 * - `lastAttemptAtMs` bounds retries. A failed pass must get another chance, but
 *   not every tick, so an attempt is remembered even when it fails.
 * - `lastSuccessDate` marks the day done. Only a pass that reached upstream sets
 *   it, so a laptop that was asleep at the morning hour still runs later.
 *
 * Deliberately not stored: any per-task or per-reward detail. Upstream is the
 * authority on what has been claimed, and duplicating that here would only add a
 * way for the two to disagree.
 *
 * @module dsh-workbuddy-standalone/task-state
 */

import { readFile, mkdir } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stateFilePath } from './credentials.ts'

/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1

/** Name of the state file inside the plugin state directory. */
export const TASK_STATE_FILENAME = 'task-state.json'

/** One account's bookkeeping. */
export interface TaskStateEntry {
  /** Epoch ms of the most recent attempt, successful or not. */
  lastAttemptAtMs: number
  /** Local `YYYY-MM-DD` of the most recent successful pass, or `''`. */
  lastSuccessDate: string
}

/** uid → entry. */
export type TaskState = Record<string, TaskStateEntry>

/** The document on disk. */
interface TaskStateDocument {
  version: typeof FORMAT_VERSION
  accounts: TaskState
}

/** Path of the task-state file. */
function taskStatePath(): string {
  return stateFilePath(TASK_STATE_FILENAME)
}

/** Whether a parsed value is a task-state document we can trust. */
function isTaskStateDocument(value: unknown): value is TaskStateDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<TaskStateDocument>
  if (document.version !== FORMAT_VERSION) return false
  const accounts = document.accounts
  if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) return false
  return Object.entries(accounts).every(([uid, entry]) => {
    if (uid === '' || typeof entry !== 'object' || entry === null) return false
    const candidate = entry as Partial<TaskStateEntry>
    return typeof candidate.lastAttemptAtMs === 'number'
      && Number.isFinite(candidate.lastAttemptAtMs)
      && typeof candidate.lastSuccessDate === 'string'
  })
}

/** Reads still in flight, so tests can wait deterministically (see cooldown-state). */
const pendingWrites = new Set<Promise<unknown>>()

/** Resolves when every task-state write started so far has settled. */
export function awaitTaskStateWrites(): Promise<unknown> {
  return Promise.allSettled([...pendingWrites])
}

/**
 * Read the whole document; an absent or damaged file reads as empty.
 *
 * A damaged file must never block automation: the cost of forgetting is one
 * redundant (idempotent) pass, while a throwing read would stop the scheduler.
 */
export async function readTaskState(): Promise<TaskState> {
  // Resolved before the first await: the environment can change while a
  // fire-and-forget write is suspended (see cooldown-state's note).
  const path = taskStatePath()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isTaskStateDocument(parsed) ? parsed.accounts : {}
  } catch {
    return {}
  }
}

/**
 * Merge one account's entry into the document atomically.
 *
 * Read-modify-write under a file lock, mirroring `account-state.ts`: two DSH
 * windows can run their own timers, and the second write must not erase the
 * first's accounts.
 */
export async function updateTaskState(uid: string, patch: Partial<TaskStateEntry>): Promise<void> {
  const path = taskStatePath()
  const dir = stateFilePath('.')
  const task = (async (): Promise<void> => {
    const current = await readTaskState()
    const previous = current[uid]
    const next: TaskStateEntry = {
      lastAttemptAtMs: patch.lastAttemptAtMs ?? previous?.lastAttemptAtMs ?? 0,
      lastSuccessDate: patch.lastSuccessDate ?? previous?.lastSuccessDate ?? '',
    }
    if (previous !== undefined && previous.lastAttemptAtMs === next.lastAttemptAtMs
      && previous.lastSuccessDate === next.lastSuccessDate) {
      return
    }
    const document: TaskStateDocument = {
      version: FORMAT_VERSION,
      accounts: { ...current, [uid]: next },
    }
    await mkdir(dir, { recursive: true })
    await withFileLock(path, () =>
      writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
    )
  })()
  pendingWrites.add(task)
  void task.catch(() => {}).finally(() => { pendingWrites.delete(task) })
  return task
}
