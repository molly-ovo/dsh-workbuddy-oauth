/**
 * A single persisted plugin preference: whether to use the upstream's largest
 * declared context window.
 *
 * Only the international roster declares `supportedContextWindows`, so in
 * practice this flag only changes international models; the CN catalog never
 * carries a larger window and is unaffected. The flag is global rather than
 * per-region because it is one user decision, not two.
 *
 * Persisted so a restart keeps the user's choice (same reason `hidden-models.ts`
 * persists, and the same discipline: atomic write, file lock, versioned shape).
 *
 * @module dsh-workbuddy-standalone/preferences
 */

import { readFile, mkdir } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stateFilePath } from './credentials.ts'

/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1

/** Name of the state file inside the plugin state directory. */
export const PREFERENCES_FILENAME = 'preferences.json'

/** The document on disk. */
interface PreferencesDocument {
  version: typeof FORMAT_VERSION
  useMaximumContextWindow: boolean
}

/** Path of the preferences state file. */
function preferencesPath(): string {
  return stateFilePath(PREFERENCES_FILENAME)
}

/** Reads still in flight, so tests can wait deterministically. */
const pendingWrites = new Set<Promise<unknown>>()

/** Resolves when every preference write started so far has settled. */
export function awaitPreferenceWrites(): Promise<unknown> {
  return Promise.allSettled([...pendingWrites])
}

/** Read the preference; absent or damaged reads as the default (`false`). */
export async function readUseMaximumContextWindow(): Promise<boolean> {
  let text: string
  try {
    text = await readFile(preferencesPath(), 'utf8')
  } catch {
    return false
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed === 'object' && parsed !== null &&
      (parsed as Partial<PreferencesDocument>).version === FORMAT_VERSION &&
      typeof (parsed as PreferencesDocument).useMaximumContextWindow === 'boolean'
    ) {
      return (parsed as PreferencesDocument).useMaximumContextWindow
    }
    return false
  } catch {
    return false
  }
}

/** Persist the preference atomically. */
export async function writeUseMaximumContextWindow(useMaximum: boolean): Promise<void> {
  const path = preferencesPath()
  const dir = stateFilePath('.')
  const document: PreferencesDocument = { version: FORMAT_VERSION, useMaximumContextWindow: useMaximum }
  const task = (async (): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await withFileLock(path, () =>
      writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
    )
  })()
  pendingWrites.add(task)
  void task.catch(() => {}).finally(() => { pendingWrites.delete(task) })
  return task
}
