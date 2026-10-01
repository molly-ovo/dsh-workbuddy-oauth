/**
 * What the credits card's right-hand slot should show.
 *
 * Extracted from the card so the decision can be tested without a DOM: this is
 * where a real defect lived. Collapsing the tab used to swap a fetched balance
 * for a plain query button, leaving the number with nowhere to appear — pressing
 * the button changed nothing visible, so the query looked broken.
 *
 * The rule this encodes: **the slot never depends on whether the card is
 * collapsed.** Collapsing hides the descriptive second line, never the result.
 * A balance that has been fetched is always shown, in every other state.
 *
 * @module dsh-workbuddy-standalone/client/credit-slot
 */

import type { WorkBuddyCredits } from '../upstream.ts'

/** Which element the slot renders, and therefore what the user sees. */
export type CreditSlot =
  /** A check is in flight and there is nothing to show yet. */
  | { kind: 'loading' }
  /** The last check failed; offer another. */
  | { kind: 'retry' }
  /** Never checked; offer the first check. */
  | { kind: 'query' }
  /** A balance is known and is itself the control that refreshes it. */
  | { kind: 'balance', total: number }
  /** Uncapped: no number can describe it. */
  | { kind: 'unlimited' }

/**
 * Decide the slot for one account.
 *
 * Order matters. A failure is reported ahead of a stale balance, because a
 * figure the card can no longer stand behind is worse than admitting the check
 * failed. `unlimited` is reported ahead of `total`, and never falls back to it:
 * the two mean opposite things ("no cap" vs "nothing left"), so an uncapped
 * account would otherwise render as a confident zero.
 *
 * @param busy - whether a check is in flight for this account.
 * @param error - the last failure's reason, if any.
 * @param credits - the last successful answer, if any.
 */
export function creditSlot(
  busy: boolean,
  error: string | undefined,
  credits: WorkBuddyCredits | undefined,
): CreditSlot {
  if (credits !== undefined && error === undefined) {
    return credits.unlimited === true ? { kind: 'unlimited' } : { kind: 'balance', total: credits.total }
  }
  if (busy) return { kind: 'loading' }
  if (error !== undefined) return { kind: 'retry' }
  return { kind: 'query' }
}
