/**
 * Cleanup for `task-state.json`, a file this plugin no longer writes.
 *
 * The P4 task-automation feature was removed (`src/task-state.ts` is gone), but
 * the file it left behind is keyed by account uid and nothing deletes it. On an
 * install that predates the removal it survives every sign-out, so a uid stays
 * on disk after the account it names is gone — the same leak `account-purge.ts`
 * exists to prevent, on a file that module cannot know about because no source
 * file names it any more.
 *
 * ## Why this deletes the whole file rather than one entry
 *
 * The writer is gone, so nothing can add an entry: any file still present is
 * entirely stale. Removing one uid at a time would leave the rest of the
 * document behind for no purpose, and there is no reader to be consistent with.
 * A whole-file delete is therefore both simpler and more complete.
 *
 * ## Why it is a separate module
 *
 * `credentials.ts` owns `stateFilePath` and is imported by everything; the purge
 * orchestrator imports the uid-keyed stores. Neither should grow knowledge of a
 * removed feature. Keeping the legacy filename and its reasoning here means the
 * day this module is deleted, nothing else has to change.
 *
 * @module dsh-workbuddy-standalone/legacy-task-state
 */

import { rm } from 'node:fs/promises'
import { stateFilePath } from './credentials.ts'

/**
 * Name of the removed feature's state file.
 *
 * Exported so a test can create one without restating the literal.
 */
export const LEGACY_TASK_STATE_FILENAME = 'task-state.json'

/**
 * Delete the removed feature's state file, if an older install left one.
 *
 * @returns whether a file was actually removed.
 */
export async function removeLegacyTaskState(): Promise<boolean> {
  try {
    // `force: false` so a missing file is an error we swallow into `false`
    // rather than a silent success — the caller reports what was cleaned.
    await rm(stateFilePath(LEGACY_TASK_STATE_FILENAME), { force: false })
    return true
  } catch {
    return false
  }
}
