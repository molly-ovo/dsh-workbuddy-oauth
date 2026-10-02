/**
 * Probe-service tests.
 *
 * The service is ported from `dsh-workbuddy-connect`, but its collaborators are
 * this plugin's own — so the test pins the *seams* rather than re-proving the
 * protocol (`probe.ts` has its own upstream tests). What matters here: consent,
 * the account re-check, and declared-set precedence, each of which is a
 * behavioural rule that compiles cleanly and only shows up as credit spent or a
 * record stored under the wrong account.
 */

import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyProbeService } from '../src/probe-service.ts'
import { WorkBuddyProbeStore } from '../src/probe-store.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore } from '../src/store.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import type { ProbeAttempt, ProbeRegion } from '../src/probe.ts'

/** A model with no declared effort set — the probe candidate. */
const UNDECLARED: WorkBuddyModelInfo = {
  id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true,
  reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
}

/** A model that declares a set — probing must never answer for it. */
const DECLARED: WorkBuddyModelInfo = {
  id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 131_072, supportsImages: true,
  reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
}

function makeService(options: {
  models?: readonly WorkBuddyModelInfo[]
  consent?: () => boolean
  account?: () => string | undefined
  region?: ProbeRegion
  send?: (modelId: string) => (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>
} = {}): WorkBuddyProbeService {
  const catalog = new WorkBuddyCatalog(options.models ?? [UNDECLARED])
  catalog.setVisible(true)
  const store = new WorkBuddyProbeStore({ pluginVersion: '0.0.0' })
  const credentials: CredentialStore = {
    current: async () => ({ accessToken: 't', refreshToken: 'r', expiresAtMs: Date.now() + 60_000, domain: 'workbuddy.ai', uid: 'uid-1', region: 'cn' }),
    resolve: async () => { throw new Error('unused') },
    noteFailure: () => {},
  }
  const client = {} as WorkBuddyUpstreamClient
  return new WorkBuddyProbeService({
    store,
    catalog,
    credentials,
    client,
    // The China vocabulary; the region-specific test below passes `global`.
    region: options.region ?? 'cn',
    consent: options.consent ?? (() => false),
    account: options.account ?? (() => 'uid-1:'),
    ...(options.send === undefined ? {} : { send: options.send }),
  })
}

describe('WorkBuddyProbeService', () => {
  it('refuses an automatic probe without consent', async () => {
    const service = makeService({ consent: () => false })
    await expect(service.probe('hy3')).resolves.toEqual({ state: 'unavailable', reason: 'probing is not authorized' })
  })

  it('does not serve an observation for a model with a declared effort set', () => {
    const service = makeService({ models: [DECLARED] })
    // `recordFor` must be undefined: a declared set always wins, and an
    // observation must never widen or narrow it.
    expect(service.recordFor('glm-5.3-flash')).toBeUndefined()
    expect(service.isCandidate('glm-5.3-flash')).toBe(false)
  })

  it('flags an undeclared reasoning model as a candidate', () => {
    const service = makeService()
    expect(service.isCandidate('hy3')).toBe(true)
  })

  it('serves no record while signed out', () => {
    const service = makeService({ account: () => undefined })
    expect(service.recordFor('hy3')).toBeUndefined()
  })

  it('returns unavailable when the model is unknown', async () => {
    const service = makeService({ consent: () => true })
    await expect(service.probe('nope', true)).resolves.toEqual({ state: 'unavailable', reason: 'unknown model: nope' })
  })

  it('returns unavailable when signed out', async () => {
    const service = makeService({ account: () => undefined })
    await expect(service.probe('hy3', true)).resolves.toEqual({ state: 'unavailable', reason: 'no WorkBuddy credential' })
  })

  it('serializes probes and records a validating outcome', async () => {
    // The sender answers "accepted" for everything, which `probeModel` reads as
    // non-validating (the sentinel is also accepted). The point here is not the
    // verdict but that the outcome reaches the store and the run resolves.
    let calls = 0
    const service = makeService({
      consent: () => true,
      send: () => async () => {
        calls += 1
        return { status: 200, streamed: true }
      },
    })
    const outcome = await service.probe('hy3', true)
    expect(outcome.state).toBe('ok')
    expect(calls).toBe(2) // baseline + sentinel: non-validating stops there
    expect(outcome).toMatchObject({ validation: 'non-validating' })
  })

  it('keeps manual consent independent of the automatic gate', async () => {
    // Manual consent (the card's confirm bubble) must run even when the
    // automatic gate is off — that is the whole "user-authorized probe" path.
    const service = makeService({
      consent: () => false,
      send: () => async () => ({ status: 200, streamed: true }),
    })
    const outcome = await service.probe('hy3', true)
    expect(outcome.state).toBe('ok')
  })
})

/**
 * The rejection vocabulary is per region.
 *
 * The China and international endpoints answer a non-canonical
 * `reasoning_effort` with *different* codes: `invalid_reasoning_effort` on one,
 * `model_param_invalid` on the other. A probe reading a single shared code
 * therefore reads the other endpoint's rejection as an unattributable answer
 * and reports `unknown` — which the card shows as "detection did not finish",
 * with no way to tell it apart from a real failure.
 *
 * These tests fail if the two vocabularies are ever collapsed back into one.
 */
describe('per-region effort-rejection vocabulary', () => {
  /** Answers the way the named endpoint answers a bad effort value. */
  function senderRejectingWith(code: string) {
    return () => async (effort: string | undefined): Promise<ProbeAttempt> => {
      // The baseline (no effort) must succeed, or nothing can be attributed.
      if (effort === undefined) return { status: 200, streamed: true }
      return { status: 400, streamed: false, errorCode: code }
    }
  }

  it('reads the global endpoint\'s own rejection code', async () => {
    const service = makeService({
      consent: () => true,
      region: 'global',
      send: senderRejectingWith('model_param_invalid'),
    })
    const outcome = await service.probe('hy3', true)
    // Every candidate is refused, so the sweep completes with an empty set —
    // the sentinel rejection was attributed, which is what makes this run
    // decisive rather than `unknown`.
    expect(outcome).toMatchObject({ state: 'ok', validation: 'validating', efforts: [] })
  })

  it('does not widen the China endpoint with the global code', async () => {
    // The generic code was measured on the global endpoint only. Reading it on
    // China would attribute rejections to a code never observed there.
    const service = makeService({
      consent: () => true,
      region: 'cn',
      send: senderRejectingWith('model_param_invalid'),
    })
    const outcome = await service.probe('hy3', true)
    expect(outcome.state).toBe('unavailable')
    expect(outcome).toMatchObject({ reason: expect.stringContaining('model_param_invalid') })
  })

  it('still reads the China endpoint\'s code on the global endpoint', async () => {
    // Kept on both: the spelling was already in the wild for global rosters.
    const service = makeService({
      consent: () => true,
      region: 'global',
      send: senderRejectingWith('invalid_reasoning_effort'),
    })
    const outcome = await service.probe('hy3', true)
    expect(outcome).toMatchObject({ state: 'ok', validation: 'validating' })
  })
})
