/**
 * Plugin-owned credential store.
 *
 * Replaces `dsh-workbuddy-connect`'s desktop-credential reader. Credentials
 * come from this plugin's own OAuth flow ({@link ./oauth.ts}) and live in one
 * file per account under `$DSH_HOME/workbuddy-standalone/`, so:
 *
 * - no desktop app is required, and none is read;
 * - several accounts can coexist (the file name carries the uid);
 * - token refresh writes only our own file.
 *
 * `expiresAtMs` is epoch **milliseconds** here. The upstream OAuth call returns
 * `expiresIn` in seconds, so conversion happens once, at this boundary.
 *
 * @module dsh-workbuddy-standalone/credentials
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { regionOfDomain, type WorkBuddyRegion } from './region.ts'
import type { AccountInfo, LoginResult } from './oauth.ts'

/** Directory under the Harness home that holds this plugin's state. */
export const STATE_DIR_NAME = 'workbuddy-standalone'

/** Prefix of each credential file; the remainder is the account uid. */
export const CREDENTIAL_FILE_PREFIX = 'workbuddy-'

/** On-disk format version. Readers reject anything else rather than guess. */
const FORMAT_VERSION = 1

/** A normalized credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  /** When {@link accessToken} stops being valid. */
  expiresAtMs: number
  /** When {@link refreshToken} stops being usable, when the upstream reports it. */
  refreshExpiresAtMs?: number
  /** Upstream domain, used to derive the region and as an outbound header. */
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  region: WorkBuddyRegion
}

/** What was written to disk for one account. */
interface CredentialDocument {
  version: typeof FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Root directory for this plugin's state. */
export function stateDir(): string {
  return join(resolveDshHome(), STATE_DIR_NAME)
}

/** Directory holding one file per account. */
export function credentialsDir(): string {
  return join(stateDir(), 'accounts')
}

/**
 * Absolute path of one plugin-owned state file.
 *
 * Everything this plugin writes lives under {@link stateDir()}, so a single
 * directory can be deleted to reset it and nothing is scattered across the
 * Harness home.
 *
 * @param name - file name inside the state directory.
 */
export function stateFilePath(name: string): string {
  return join(stateDir(), name)
}

/**
 * Path of one region's probe-record file.
 *
 * **Deliberately not the ported default.** `probe-store.ts`'s
 * `workbuddyProbePath()` resolves to `$DSH_HOME/.workbuddy-probe.json`, which is
 * exactly where `dsh-workbuddy-connect` keeps its own CN records. Sharing that
 * file would make two plugins write one document, and while the records are
 * account-keyed the *fingerprint basis* is each plugin's own — so a record
 * written by one could be judged stale by the other and silently re-probed.
 * Per region, because the two upstreams disagree about rates and effort sets
 * for the same model ids, so a CN observation must never answer for a global
 * row.
 */
export function probePathFor(region: WorkBuddyRegion): string {
  return stateFilePath(`probe-${region}.json`)
}

/** Absolute path of one account's credential file. */
export function credentialPath(uid: string): string {
  return join(credentialsDir(), `${CREDENTIAL_FILE_PREFIX}${uid}.json`)
}

/** Whether a parsed value looks like a credential document we can trust. */
function isCredentialDocument(value: unknown): value is CredentialDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<CredentialDocument>
  if (document.version !== FORMAT_VERSION) return false
  const credential = document.credential
  if (typeof credential !== 'object' || credential === null) return false
  const candidate = credential as Partial<WorkBuddyCredential>
  return (
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken !== '' &&
    typeof candidate.uid === 'string' &&
    candidate.uid !== '' &&
    typeof candidate.domain === 'string' &&
    typeof candidate.expiresAtMs === 'number' &&
    Number.isFinite(candidate.expiresAtMs)
  )
}

/**
 * Parse one credential file.
 *
 * @returns The credential, or `undefined` when the file is absent, malformed
 *   or written by an incompatible version. A damaged file is reported as
 *   "not signed in" rather than thrown, so one bad account cannot take down
 *   the whole pool.
 */
export async function readCredential(path: string): Promise<WorkBuddyCredential | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isCredentialDocument(parsed)) return undefined
    return normalizeCredential(parsed.credential)
  } catch {
    return undefined
  }
}

/**
 * Fill in derived fields a stored document may predate.
 *
 * `region` is recomputed from `domain` rather than trusted from disk: it is a
 * pure function of the domain, and a stale stored value would silently route
 * requests at the wrong region.
 */
function normalizeCredential(stored: WorkBuddyCredential): WorkBuddyCredential {
  return {
    ...stored,
    region: regionOfDomain(stored.domain),
  }
}

/**
 * Write one account's credential without taking the file lock.
 *
 * Only for callers that already hold it. `withFileLock` is not reentrant, so a
 * caller holding the lock and then calling the locked {@link writeCredential}
 * would deadlock against itself until the timeout.
 */
export async function writeCredentialUnlocked(credential: WorkBuddyCredential): Promise<string> {
  const path = credentialPath(credential.uid)
  const document: CredentialDocument = { version: FORMAT_VERSION, credential }
  await mkdir(credentialsDir(), { recursive: true })
  // 0o600: these files hold a bearer token. `dirMode` keeps the containing tree
  // private too, in case this is the call that creates it.
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
  return path
}

/** Write one account's credential atomically, under the file lock. */
export async function writeCredential(credential: WorkBuddyCredential): Promise<string> {
  const path = credentialPath(credential.uid)
  // `withFileLock` creates a sibling lock file and therefore requires the
  // parent directory to already exist; it does not create it.
  await mkdir(credentialsDir(), { recursive: true })
  return withFileLock(path, () => writeCredentialUnlocked(credential))
}

/** Remove one account's credential file. Returns whether a file was removed. */
export async function deleteCredential(uid: string): Promise<boolean> {
  const path = credentialPath(uid)
  try {
    await rm(path, { force: false })
    return true
  } catch {
    return false
  }
}

/**
 * List every stored credential.
 *
 * Unreadable or unparsable files are skipped rather than failing the listing:
 * a single damaged account must not hide the healthy ones.
 */
export async function listCredentials(): Promise<readonly WorkBuddyCredential[]> {
  let names: string[]
  try {
    names = await readdir(credentialsDir())
  } catch {
    return []
  }
  const found: WorkBuddyCredential[] = []
  for (const name of names) {
    if (!name.startsWith(CREDENTIAL_FILE_PREFIX) || !name.endsWith('.json')) continue
    const credential = await readCredential(join(credentialsDir(), name))
    if (credential !== undefined) found.push(credential)
  }
  // Stable order so selection and status output do not shuffle between calls.
  return found.sort((a, b) => a.uid.localeCompare(b.uid))
}

/**
 * Convert a completed login into a storable credential.
 *
 * `expiresIn` arrives in seconds and `now` in milliseconds, so the conversion
 * happens exactly here.
 *
 * @param result - Output of {@link LoginClient.complete}.
 * @param now - Current time in epoch milliseconds; injectable for tests.
 */
export function credentialFromLogin(result: LoginResult, now: number = Date.now()): WorkBuddyCredential {
  const base: WorkBuddyCredential = {
    accessToken: result.token.accessToken,
    refreshToken: result.token.refreshToken,
    expiresAtMs: now + result.token.expiresIn * 1000,
    domain: result.token.domain,
    uid: result.account.uid,
    region: result.region,
  }
  return withAccountFields(base, result.account)
}

/** Attach the optional account fields only when they carry a value. */
function withAccountFields(
  credential: WorkBuddyCredential,
  account: Pick<AccountInfo, 'enterpriseId' | 'nickname'>,
): WorkBuddyCredential {
  return {
    ...credential,
    ...(account.enterpriseId !== '' ? { enterpriseId: account.enterpriseId } : {}),
    ...(account.nickname !== '' ? { nickname: account.nickname } : {}),
  }
}

/** Whether a credential's access token is expired or about to expire. */
export function isExpired(credential: WorkBuddyCredential, marginMs = 60_000, now = Date.now()): boolean {
  return credential.expiresAtMs - marginMs <= now
}

/**
 * A mainland-China mobile number, optionally carrying an `86` country code.
 *
 * The surrounding `(?<!\d)` / `(?!\d)` guards keep a longer digit run from being
 * partially masked: in `113800138000` the inner digits are not a phone number,
 * and masking them would mangle an id that merely contains those digits.
 */
const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d{9})(?!\d)/gu

/** How many leading and trailing digits stay readable; the rest become `*`. */
const PHONE_VISIBLE_DIGITS = 3

/**
 * Mask any mobile number inside a display name.
 *
 * Applied at the *display* boundary only: the credential file keeps the real
 * nickname, so nothing is lost and a later feature can still use it. A name that
 * merely contains a number — `张三 13800138000` — is masked in place, because
 * redacting only exact matches would leak the common case.
 *
 * A country-code prefix the user typed is kept (`+86` is not personal data); only
 * the number itself is redacted.
 *
 * @param text - the raw display name.
 * @returns the name with every mobile number reduced to `3 digits + stars + 3`.
 */
export function maskPhoneNumbers(text: string): string {
  return text.replace(PHONE_PATTERN, (whole: string, digits: string) => {
    const stars = '*'.repeat(Math.max(0, digits.length - PHONE_VISIBLE_DIGITS * 2))
    const masked = `${digits.slice(0, PHONE_VISIBLE_DIGITS)}${stars}${digits.slice(-PHONE_VISIBLE_DIGITS)}`
    return whole.replace(digits, masked)
  })
}

/**
 * Human-readable account label for status output.
 *
 * The nickname is masked rather than returned raw: an account nicknamed with its
 * own phone number would otherwise be printed verbatim by every command, the
 * settings card, and the status document.
 */
export function displayNameOf(credential: WorkBuddyCredential): string {
  if (credential.nickname !== undefined && credential.nickname !== '') {
    return maskPhoneNumbers(credential.nickname)
  }
  return credential.uid.slice(0, 8)
}
