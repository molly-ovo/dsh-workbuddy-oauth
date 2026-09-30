/**
 * Failure-cooldown mapping tests.
 *
 * The mapping is the whole of the "failure backoff" behaviour at this stage:
 * which upstream error classes park an account, and which deliberately do not.
 * Getting it wrong is silent — a mis-mapped class either keeps retrying a dead
 * account (wasting a request each time) or parks accounts for request-shape
 * errors that would fail identically on any account.
 */

import { describe, expect, it } from 'vitest'
import { cooldownForKind, FAILURE_COOLDOWN_MS } from '../src/shim.ts'
describe('cooldownForKind', () => {
  it('cools account-shaped failures', () => {
    for (const kind of ['hard_credit', 'soft_rate', 'server'] as const) {
      expect(cooldownForKind(kind, 1000)).toBe(1000 + FAILURE_COOLDOWN_MS[kind])
    }
  })

  it('does not cool request-shape failures', () => {
    // `client` and `not_found` are problems in the request, not the account:
    // rotating to another account would fail identically, so there is nothing
    // to gain from parking the account that happened to be selected.
    expect(cooldownForKind('client', 1000)).toBeUndefined()
    expect(cooldownForKind('not_found', 1000)).toBeUndefined()
  })

  it('does not cool a dead session', () => {
    // A dead session needs a re-login, not a cooldown; parking it would only
    // hide it from selection until the timer ran out, then retry and fail again.
    expect(cooldownForKind('session_dead', 1000)).toBeUndefined()
  })

  it('parks an exhausted account for an hour, not a minute', () => {
    // Credit does not return by waiting: the upstream answers 额度已用尽 and
    // offers a top-up purchase. A one-minute cooldown put the dead account back
    // into rotation every minute, burning a failing request each time. The
    // durations must differ by an order of magnitude because the causes do.
    expect(FAILURE_COOLDOWN_MS.hard_credit).toBe(60 * 60_000)
    expect(FAILURE_COOLDOWN_MS.hard_credit).toBeGreaterThan(FAILURE_COOLDOWN_MS.soft_rate * 10)
  })

  it('keeps a rate limit short, since it clears on its own', () => {
    expect(FAILURE_COOLDOWN_MS.soft_rate).toBe(60_000)
    expect(FAILURE_COOLDOWN_MS.server).toBe(10_000)
  })
})
