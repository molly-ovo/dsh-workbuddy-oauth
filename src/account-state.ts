/**
 * Per-account enable/disable state.
 *
 * A disabled account is still *stored* (its credential file stays on disk) but
 * is excluded from credential selection, so its token is never spent until the
 * user re-enables it. The state lives in its own file rather than inside the
 * credential document: the credential format is written by the OAuth flow and
 * read by the ported code, and widening it for an enable flag would force a
 * format-version migration for a fact that is only about *selection*.
 *
 * @module dsh-workbuddy-oauth/account-state
 */

import { readFile, mkdir } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stateFilePath } from './credentials.ts'

/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1

/** Name of the state file inside {@link stateDir}. */
export const DISABLED_ACCOUNTS_FILENAME = 'disabled-accounts.json'

/** The document on disk: the set of disabled account uids. */
interface DisabledDocument {
  version: typeof FORMAT_VERSION
  disabled: string[]
}

/** Path of the disabled-accounts state file. */
function disabledPath(): string {
  return stateFilePath(DISABLED_ACCOUNTS_FILENAME)
}

/** Whether a parsed value is a disabled-accounts document we can trust. */
function isDisabledDocument(value: unknown): value is DisabledDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<DisabledDocument>
  if (document.version !== FORMAT_VERSION) return false
  return Array.isArray(document.disabled) && document.disabled.every(uid => typeof uid === 'string')
}

/** Read the current disabled set; an absent or damaged file reads as empty. */
async function readDisabled(): Promise<Set<string>> {
  let text: string
  try {
    text = await readFile(disabledPath(), 'utf8')
  } catch {
    return new Set()
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isDisabledDocument(parsed) ? new Set(parsed.disabled) : new Set()
  } catch {
    return new Set()
  }
}

/** Write the disabled set atomically; a failed write is reported, never thrown. */
async function writeDisabled(disabled: ReadonlySet<string>): Promise<void> {
  const document: DisabledDocument = { version: FORMAT_VERSION, disabled: [...disabled].sort() }
  await mkdir(stateFilePath('.'), { recursive: true })
  await withFileLock(disabledPath(), () =>
    writeFileAtomic(disabledPath(), `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    }),
  )
}

/**
 * The set of disabled account uids.
 *
 * Read on demand so a `/wb-account` toggle in another DSH window is honoured on
 * the next selection without a restart.
 */
export async function disabledUids(): Promise<ReadonlySet<string>> {
  return readDisabled()
}

/**
 * Forget one account's enable/disable state.
 *
 * Called when an account is removed. A disabled uid that outlives its
 * credential is a stale identifier left on disk for no purpose, and if the same
 * uid is ever re-added it would silently come back disabled.
 *
 * @returns whether the uid was present and therefore removed.
 */
export async function forgetAccount(uid: string): Promise<boolean> {
  const current = await readDisabled()
  if (!current.delete(uid)) return false
  await writeDisabled(current)
  return true
}

/**
 * Enable or disable one account.
 *
 * Idempotent: disabling an already-disabled account and enabling an already-
 * enabled one both settle to the requested state.
 *
 * @returns the new disabled set, for callers that want to re-read selection.
 */
export async function setAccountDisabled(uid: string, disabled: boolean): Promise<ReadonlySet<string>> {
  const current = await readDisabled()
  if (disabled) current.add(uid)
  else current.delete(uid)
  await writeDisabled(current)
  return current
}
