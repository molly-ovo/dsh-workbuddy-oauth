/**
 * Credential resolution for the provider and shim.
 *
 * The ported shim and adapter were written against connect's
 * `WorkBuddyCredentialStore`, which resolves a desktop-app credential and
 * refreshes it. This module presents the same narrow surface — `resolve()` —
 * on top of this plugin's own OAuth credentials ({@link ./credentials.ts}),
 * so the ported code needed no changes to its credential handling.
 *
 * ## Why a thin adapter instead of changing the ported code
 *
 * Keeping the seam identical means the parts that were verified against the
 * live upstream (header construction, chat body preparation, error
 * classification) stay untouched, and only the *source of the credential*
 * differs. That is the whole point of this plugin.
 *
 * ## Single account in Phase 1
 *
 * `resolve()` returns the account that should serve the next request. Phase 1
 * has exactly one decision — when several credentials exist, prefer one whose
 * token is still valid, and fall back to the lexicographically first so the
 * choice is stable rather than arbitrary. Token selection *per conversation*
 * (affinity) and health-based rotation are Phase 2 concerns; leaving them out
 * here keeps this module honest about what it does.
 *
 * @module dsh-workbuddy-standalone/store
 */

import {
  credentialPath,
  deleteCredential,
  displayNameOf,
  isExpired,
  listCredentials,
  readCredential,
  writeCredential,
  type WorkBuddyCredential,
} from './credentials.ts'
import type { WorkBuddyRegion } from './region.ts'
import { refreshCredential, needsRefresh } from './refresh.ts'

/** Thrown when no usable credential exists; the shim maps this to HTTP 401. */
export class NotSignedInError extends Error {
  constructor(message = '尚未登录 WorkBuddy。请先执行 /wb-login 完成登录。') {
    super(message)
    this.name = 'NotSignedInError'
  }
}

/** What the ported code needs from a credential store. */
export interface CredentialStore {
  /** Resolve the credential to serve the next request; refreshes if needed. */
  resolve(): Promise<WorkBuddyCredential>
  /** The current credential without refreshing, or `undefined` when none. */
  current(): Promise<WorkBuddyCredential | undefined>
}

/**
 * Choose which credential serves the next request.
 *
 * Pure, and exported so the rule is testable without touching the filesystem.
 *
 * @param credentials - Candidate credentials, already filtered to one region by
 *   the caller. Region filtering is not done here because a credential is only
 *   ever valid for its own upstream host: presenting a domestic token to the
 *   international service (or vice versa) is an authentication failure, and the
 *   caller knows which endpoint it is about to call.
 * @param now - Current epoch milliseconds.
 * @returns The chosen credential, or `undefined` when none is stored.
 */
export function chooseCredential(
  credentials: readonly WorkBuddyCredential[],
  now: number = Date.now(),
): WorkBuddyCredential | undefined {
  if (credentials.length === 0) return undefined
  // Prefer an unexpired token: choosing an expired one would spend a refresh
  // cycle (and a rotation) on a request that another account could serve as-is.
  const live = credentials.filter((credential) => !isExpired(credential, 0, now))
  const pool = live.length > 0 ? live : credentials
  // Stable order, so repeated calls pick the same account instead of alternating
  // and multiplying credential traffic.
  return [...pool].sort((a, b) => a.uid.localeCompare(b.uid))[0]
}

/** Options for {@link createCredentialStore}. */
export interface CredentialStoreOptions {
  /**
   * Region this store serves.
   *
   * Each region gets its own store because a credential is only valid against
   * its own upstream host. Without this filter a domestic and an international
   * account would be interchangeable to a store, and the shim would present the
   * wrong region's token.
   */
  region?: WorkBuddyRegion
  /** Clock, injectable for tests. */
  now?: () => number
  /** Refresh hook, injectable for tests. Defaults to {@link refreshCredential}. */
  refresh?: typeof refreshCredential
}

/**
 * Build the credential store the ported shim and adapter consume.
 *
 * `resolve()` refreshes when the chosen token is at or near expiry, and
 * reports {@link NotSignedInError} when nothing is stored — the shim turns that
 * into a 401 carrying the message, so an unconfigured install reports "sign in"
 * rather than an opaque failure.
 */
export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const now = options.now ?? Date.now
  const refresh = options.refresh ?? refreshCredential
  const region = options.region

  /** Credentials this store may serve: its own region's, when one is set. */
  const candidates = async (): Promise<readonly WorkBuddyCredential[]> => {
    const all = await listCredentials()
    return region === undefined ? all : all.filter((credential) => credential.region === region)
  }

  return {
    async current(): Promise<WorkBuddyCredential | undefined> {
      return chooseCredential(await candidates(), now())
    },

    async resolve(): Promise<WorkBuddyCredential> {
      const chosen = chooseCredential(await candidates(), now())
      if (chosen === undefined) throw new NotSignedInError()

      // A credential with no refresh token cannot be refreshed, so attempting
      // it would fail pointlessly. Serve it and let the upstream reject it,
      // which produces a clearer message ("sign in again") than a refresh
      // failure would.
      if (!needsRefresh(chosen, now())) return chosen

      // Expired or inside the margin: refresh, and re-read on success so the
      // caller gets the committed credential rather than our in-memory guess.
      const outcome = await refresh(chosen.uid)
      if (outcome.status === 'failed') {
        // Refresh failure is reported as a sign-in problem: retrying cannot
        // help, and the user's action is the same either way.
        throw new NotSignedInError(
          `账号 ${displayNameOf(chosen)} 的登录已失效，请重新执行 /wb-login。原因：${outcome.reason}`,
        )
      }
      const refreshed = await readCredential(credentialPath(chosen.uid))
      return refreshed ?? outcome.credential
    },
  }
}

/** Remove one account. Phase 2's multi-account commands build on this. */
export async function removeAccount(uid: string): Promise<boolean> {
  return deleteCredential(uid)
}

/** Persist a freshly signed-in account. */
export async function saveAccount(credential: WorkBuddyCredential): Promise<string> {
  return writeCredential(credential)
}
