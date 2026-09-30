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
 * @module dsh-workbuddy-standalone/cooldown-state
 */

import { readFile, mkdir } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stateFilePath } from './credentials.ts'

/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1

/** Name of the state file inside the plugin state directory. */
export const COOLDOWN_STATE_FILENAME = 'cooldowns.json'

/** The document on disk: uid → cool-until epoch ms. */
interface CooldownDocument {
  version: typeof FORMAT_VERSION
  /** uid → epoch ms; entries at or before `now` are dropped on load. */
  cooldowns: Record<string, number>
}

/** Path of the cooldown state file. */
function cooldownPath(): string {
  return stateFilePath(COOLDOWN_STATE_FILENAME)
}

/**
 * Whether a parsed value is a cooldown document we can trust.
 *
 * Rejecting malformed entries outright (rather than skipping them) is what makes
 * a damaged file read as empty: a single bad value would otherwise poison a map
 * the selection loop trusts with account routing.
 */
function isCooldownDocument(value: unknown): value is CooldownDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<CooldownDocument>
  if (document.version !== FORMAT_VERSION) return false
  const map = document.cooldowns
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return false
  return Object.entries(map).every(
    ([uid, until]) => typeof uid === 'string' && uid !== '' && typeof until === 'number' && Number.isFinite(until),
  )
}

/** Read the persisted map, dropping entries that have already expired. */
export async function readCooldowns(now: number = Date.now()): Promise<Map<string, number>> {
  // Resolved synchronously, before the first await: `resolveDshHome()` reads the
  // environment, and a test (or a profile reload) can change that environment
  // while an in-flight write is suspended. Every path used by this call is
  // captured here so the read lands where the caller's environment says.
  const path = cooldownPath()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return new Map()
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isCooldownDocument(parsed)) return new Map()
    return new Map(Object.entries(parsed.cooldowns).filter(([, until]) => until > now))
  } catch {
    return new Map()
  }
}

/**
 * Writes still in flight, so tests can wait for persistence deterministically.
 *
 * `noteFailure` is fire-and-forget — a request must never wait on a state-file
 * write — but a test that ends while its write is suspended would race the
 * environment restore in the test harness and land the entry in the real home
 * directory (observed: an entry written to `~/.dsh` by a temp-dir test).
 */
const pendingWrites = new Set<Promise<unknown>>()

/** Resolves when every cooldown write started so far has settled. */
export function awaitCooldownWrites(): Promise<unknown> {
  return Promise.allSettled([...pendingWrites])
}

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
export async function writeCooldown(uid: string, untilMs: number, now: number = Date.now()): Promise<void> {
  const path = cooldownPath()
  const dir = stateFilePath('.')
  const task = (async (): Promise<void> => {
    const current = await readCooldowns(now)
    if (current.get(uid) === untilMs) return
    current.set(uid, untilMs)
    const document: CooldownDocument = {
      version: FORMAT_VERSION,
      cooldowns: Object.fromEntries([...current].sort(([a], [b]) => a.localeCompare(b))),
    }
    await mkdir(dir, { recursive: true })
    await withFileLock(path, () =>
      writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      }),
    )
  })()
  pendingWrites.add(task)
  void task.catch(() => {}).finally(() => { pendingWrites.delete(task) })
  return task
}

/**
 * Drop every persisted entry.
 *
 * Used so a stale map does not outlive its process: the in-memory map is the
 * truth at runtime, and a leftover file from a killed process could otherwise
 * park accounts that are perfectly healthy now.
 */
export async function clearCooldowns(): Promise<void> {
  const path = cooldownPath()
  try {
    await withFileLock(path, () => writeFileAtomic(path, '', { mode: 0o600, dirMode: 0o700 }))
  } catch {
    // Nothing to clear, or the directory is gone; either way the map is empty.
  }
}
