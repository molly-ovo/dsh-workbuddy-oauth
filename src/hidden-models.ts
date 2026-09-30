/**
 * Per-region hidden-model set.
 *
 * The user can hide a model from the DSH picker; the rule is about **model ids
 * per region**, not about accounts — the CN and international rosters are
 * different lists, and a hidden id survives a later catalog refresh because the
 * set is keyed by id rather than by the row that was present when it was set.
 * (Chats already using a hidden model keep working: the shim routes on the id,
 * and only the picker's roster is filtered.)
 *
 * Persisted so a restart does not resurrect a model the user deliberately hid.
 *
 * @module dsh-workbuddy-standalone/hidden-models
 */

import { readFile, mkdir } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stateFilePath } from './credentials.ts'
import type { WorkBuddyRegion } from './region.ts'

/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1

/** Name of the state file inside the plugin state directory. */
export const HIDDEN_MODELS_FILENAME = 'hidden-models.json'

/** region → hidden model ids. */
export type HiddenModels = Record<WorkBuddyRegion, string[]>

/** The document on disk. */
interface HiddenModelsDocument {
  version: typeof FORMAT_VERSION
  hidden: HiddenModels
}

/** Path of the hidden-models state file. */
function hiddenModelsPath(): string {
  return stateFilePath(HIDDEN_MODELS_FILENAME)
}

/** Whether a parsed value is a hidden-models document we can trust. */
function isHiddenModelsDocument(value: unknown): value is HiddenModelsDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<HiddenModelsDocument>
  if (document.version !== FORMAT_VERSION) return false
  const hidden = document.hidden
  if (typeof hidden !== 'object' || hidden === null || Array.isArray(hidden)) return false
  return (['cn', 'global'] as const).every(region =>
    Array.isArray(hidden[region]) && hidden[region]!.every(id => typeof id === 'string' && id !== ''),
  )
}

/** Reads still in flight, so tests can wait deterministically (see cooldown-state). */
const pendingWrites = new Set<Promise<unknown>>()

/** Resolves when every hidden-model write started so far has settled. */
export function awaitHiddenModelWrites(): Promise<unknown> {
  return Promise.allSettled([...pendingWrites])
}

/** Read the whole document; absent or damaged reads as both regions empty. */
export async function readHiddenModels(): Promise<HiddenModels> {
  const path = hiddenModelsPath()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { cn: [], global: [] }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isHiddenModelsDocument(parsed) ? parsed.hidden : { cn: [], global: [] }
  } catch {
    return { cn: [], global: [] }
  }
}

/**
 * Replace one region's hidden set atomically, preserving the other region's.
 *
 * Read-modify-write under a file lock (same discipline as `account-state.ts`),
 * so two DSH windows toggling different regions do not erase each other.
 */
export async function setRegionHiddenModels(region: WorkBuddyRegion, ids: readonly string[]): Promise<void> {
  const path = hiddenModelsPath()
  const dir = stateFilePath('.')
  const task = (async (): Promise<void> => {
    const current = await readHiddenModels()
    const next: HiddenModels = { cn: [...current.cn], global: [...current.global], [region]: [...ids].sort() }
    const document: HiddenModelsDocument = { version: FORMAT_VERSION, hidden: next }
    await mkdir(dir, { recursive: true })
    await withFileLock(path, () =>
      writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
    )
  })()
  pendingWrites.add(task)
  void task.catch(() => {}).finally(() => { pendingWrites.delete(task) })
  return task
}
