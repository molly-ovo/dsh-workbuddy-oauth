/**
 * Complete removal of one account.
 *
 * Deleting the credential file alone is not enough: several other stores are
 * keyed by the account's uid, and each of them would keep naming an account that
 * no longer exists. That is both a privacy problem (a uid identifies an account)
 * and a correctness one — if the same uid signs in again, a leftover disabled
 * flag or a stale probe observation would silently apply to it.
 *
 * This module exists so every removal path (the `/wb-logout` command, the
 * settings card's sign-out, and the store's own `removeAccount`) erases the same
 * set. A new uid-keyed store must be added here, which is the point: the list is
 * in one place rather than repeated at each call site.
 *
 * It also removes `task-state.json`, left by a feature this plugin no longer
 * ships. That file is uid-keyed and has no writer, so it would otherwise
 * outlive every account it names; see ./legacy-task-state.ts.
 *
 * @module dsh-workbuddy-oauth/account-purge
 */

import { deleteCredential } from './credentials.ts'
import { clearCooldown } from './cooldown-state.ts'
import { forgetAccount } from './account-state.ts'
import { removeLegacyTaskState } from './legacy-task-state.ts'

/** What one account removal actually erased, for reporting and tests. */
export interface AccountPurgeResult {
  /** Whether the stored credential file was present and removed. */
  credentialRemoved: boolean
  /** Whether a persisted failure cooldown named this account. */
  cooldownCleared: boolean
  /** Whether the enable/disable state named this account. */
  enableStateForgotten: boolean
  /** How many probe stores dropped records for this account. */
  probeStoresPurged: number
  /** Whether a state file left by the removed task-automation feature was deleted. */
  legacyTaskStateRemoved: boolean
}

/** Hooks the caller supplies for state it owns. */
export interface AccountPurgeOptions {
  /**
   * Drop one account's probe records from every probe store the caller owns.
   *
   * Injected rather than imported because the probe stores are per-region and
   * live with the region runtimes, which this module must not reach into. The
   * key is `uid:enterpriseId`, matching `accountIdentityOf`. All stores are
   * offered the key because this module does not know which region the account
   * belonged to, and a probe store simply reports `false` when it held nothing.
   *
   * @returns how many stores actually dropped records.
   */
  forgetProbeRecords?: (accountKey: string) => number
  /** The account key for {@link AccountPurgeOptions.forgetProbeRecords}. */
  accountKey?: string
}

/**
 * Remove one account and every trace of it this plugin keeps.
 *
 * Deliberately **not** transactional: each store is independent, and a failure
 * in one must not leave the credential file in place, because the credential is
 * the secret. The credential is therefore deleted first, and a later failure is
 * reported to the caller rather than rolled back — a leftover cooldown entry is
 * harmless compared with a token that should have been erased.
 *
 * @param uid - the account uid to remove.
 * @param options - probe-store hooks; omitted when the caller has none.
 * @returns what was erased.
 */
export async function purgeAccount(
  uid: string,
  options: AccountPurgeOptions = {},
): Promise<AccountPurgeResult> {
  // First: the secret itself. Everything below is derived state.
  const credentialRemoved = await deleteCredential(uid)
  const cooldownCleared = await clearCooldown(uid)
  const enableStateForgotten = await forgetAccount(uid)
  // Whole-file, not per-uid: the writer no longer exists, so anything left in it
  // is stale. See ./legacy-task-state.ts.
  const legacyTaskStateRemoved = await removeLegacyTaskState()

  let probeStoresPurged = 0
  const { forgetProbeRecords, accountKey } = options
  if (forgetProbeRecords !== undefined && accountKey !== undefined && accountKey !== '') {
    probeStoresPurged = forgetProbeRecords(accountKey)
  }

  return {
    credentialRemoved,
    cooldownCleared,
    enableStateForgotten,
    probeStoresPurged,
    legacyTaskStateRemoved,
  }
}
