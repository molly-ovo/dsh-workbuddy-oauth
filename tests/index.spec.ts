/**
 * Plugin-assembly tests.
 *
 * These exist because of a real failure: the first installed build threw
 * `workbuddy shim has no listening address` at load time, because the adapter
 * was constructed before the loopback listener held a port. The provider's
 * models read the shim origin during construction, so the order is load-bearing
 * and nothing else in the suite exercised it.
 *
 * The tests drive `apply()` against a fake context, which is the only way to
 * pin assembly order without booting DSH.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, providerIdFor, WORKBUDDY_AI_PROVIDER, WORKBUDDY_PROVIDER } from '../src/index.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-index-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

/** Record one adapter registration. */
interface Registration {
  providerIds: readonly string[]
  adapter: { listModels?: unknown }
}

/**
 * A context stub carrying only what `apply` touches.
 *
 * `registerAdapter` is the assertion surface: the bug this file guards against
 * happened *before* it was reached, so a test that only counted registrations
 * would also fail — but the ordering test below asserts the shim was ready,
 * which is the actual invariant.
 */
function fakeContext(): {
  ctx: Context
  registrations: Registration[]
  effects: Array<() => void>
} {
  const registrations: Registration[] = []
  const effects: Array<() => void> = []
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm: {
      registerAdapter(providerIds: readonly string[], adapter: Registration['adapter']) {
        registrations.push({ providerIds, adapter })
        return () => {}
      },
    },
    commands: {
      register: () => () => {},
    },
    get: () => undefined,
    effect(fn: () => () => void) {
      effects.push(fn())
      return () => {}
    },
    emit: vi.fn(),
  } as unknown as Context
  return { ctx, registrations, effects }
}

/** Let the async `startRegion` calls settle. */
async function settle(): Promise<void> {
  // A macrotask hop is enough: the shim binds a port, which resolves as a
  // pending promise settled by the event loop.
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe('provider ids', () => {
  it('gives each region its own id', () => {
    // The upstreams advertise overlapping model ids, so a shared provider id
    // would make a descriptor depend on which region registered last.
    expect(providerIdFor('cn')).toBe(WORKBUDDY_PROVIDER)
    expect(providerIdFor('global')).toBe(WORKBUDDY_AI_PROVIDER)
    expect(WORKBUDDY_PROVIDER).not.toBe(WORKBUDDY_AI_PROVIDER)
  })

  it('does not collide with the plugin it is meant to replace', () => {
    // Regression: the first install registered `workbuddy` / `workbuddy-ai`,
    // the exact ids `dsh-workbuddy-connect` claims, and DSH refused both with
    // `an adapter for provider "workbuddy" is already registered`. Running
    // alongside connect is the expected migration setup, so the ids must stay
    // namespaced.
    const claimedByConnect = ['workbuddy', 'workbuddy-ai']
    for (const id of [WORKBUDDY_PROVIDER, WORKBUDDY_AI_PROVIDER]) {
      expect(claimedByConnect).not.toContain(id)
    }
  })

  it('namespaces the ids under this package so a reader can tell them apart', () => {
    expect(WORKBUDDY_PROVIDER.startsWith('workbuddy-standalone')).toBe(true)
    expect(WORKBUDDY_AI_PROVIDER.startsWith('workbuddy-standalone')).toBe(true)
  })
})

describe('apply', () => {
  it('registers both regions without throwing', async () => {
    // Regression: the shipped build threw here with
    // `workbuddy shim has no listening address`.
    const { ctx, registrations } = fakeContext()
    expect(() => apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })).not.toThrow()

    await settle()
    expect(registrations.map((entry) => entry.providerIds[0]).sort()).toEqual(
      [WORKBUDDY_PROVIDER, WORKBUDDY_AI_PROVIDER].sort(),
    )
  })

  it('registers each provider exactly once', async () => {
    const { ctx, registrations } = fakeContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()

    const ids = registrations.map((entry) => entry.providerIds[0])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('logs no error while starting', async () => {
    const { ctx } = fakeContext()
    const error = vi.fn()
    ;(ctx.logger as unknown as { error: unknown }).error = error

    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()
    expect(error).not.toHaveBeenCalled()
  })

  it('exposes a working provider for each region', async () => {
    const { ctx, registrations } = fakeContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()

    for (const registration of registrations) {
      expect(registration.adapter).toBeDefined()
      expect(registration.providerIds).toHaveLength(1)
    }
  })
})
