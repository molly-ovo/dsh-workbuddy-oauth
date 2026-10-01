/**
 * The credits slot's decision, including the state that used to break.
 *
 * @module dsh-workbuddy-oauth/tests/credit-slot.spec
 */

import { describe, expect, it } from 'vitest'
import { creditSlot } from '../src/client/credit-slot.ts'
import type { WorkBuddyCredits } from '../src/upstream.ts'

const balance = (total: number): WorkBuddyCredits => ({ total, accounts: [] })

describe('the credits slot', () => {
  it('shows a balance once one has been fetched', () => {
    expect(creditSlot(false, undefined, balance(1234))).toEqual({ kind: 'balance', total: 1234 })
  })

  it('offers the first check when nothing is known', () => {
    expect(creditSlot(false, undefined, undefined)).toEqual({ kind: 'query' })
  })

  it('reports unlimited instead of a zero', () => {
    // `unlimited` and `total` mean opposite things, so falling back to `total`
    // would render an uncapped account as a confident "0".
    const credits: WorkBuddyCredits = { total: 0, accounts: [], unlimited: true }
    expect(creditSlot(false, undefined, credits)).toEqual({ kind: 'unlimited' })
  })

  it('offers a retry after a failure, ahead of any stale balance', () => {
    // A figure the card can no longer stand behind must not outrank admitting
    // the check failed.
    expect(creditSlot(false, 'boom', balance(999))).toEqual({ kind: 'retry' })
    expect(creditSlot(false, 'boom', undefined)).toEqual({ kind: 'retry' })
  })

  it('shows a balance while a later refetch is in flight', () => {
    // `busy` must not blank a number the user already has: replacing it with a
    // spinner is what made a working query look broken.
    expect(creditSlot(true, undefined, balance(77))).toEqual({ kind: 'balance', total: 77 })
  })

  it('shows progress only when there is nothing to show yet', () => {
    expect(creditSlot(true, undefined, undefined)).toEqual({ kind: 'loading' })
  })

  it('never depends on the collapsed flag', () => {
    /*
     * The regression this file exists for. `creditSlot` takes no collapsed
     * argument at all, so no collapse state can reach the decision — the
     * signature is the assertion. The previous version branched on `collapsed`
     * and replaced the balance with a button, which left a fetched number with
     * nowhere to appear.
     */
    expect(creditSlot).toHaveLength(3)
    for (const busy of [false, true]) {
      for (const error of [undefined, 'boom']) {
        for (const credits of [undefined, balance(5)]) {
          expect(() => creditSlot(busy, error, credits)).not.toThrow()
        }
      }
    }
  })
})
