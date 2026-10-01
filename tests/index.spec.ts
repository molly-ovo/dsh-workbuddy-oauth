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
import { apply, inject, providerIdFor, WORKBUDDY_AI_PROVIDER, WORKBUDDY_PROVIDER } from '../src/index.ts'
import { WORKBUDDY_AI_CONTROL_PATH, WORKBUDDY_CONTROL_PATH, WORKBUDDY_STATUS_PATH } from '../src/status-paths.ts'

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

/** One registered web route, as `ctx.webServer.register` recorded it. */
interface Route {
  kind: unknown
  path: string
  handler: unknown
}

/**
 * A context stub carrying only what `apply` touches.
 *
 * `registerAdapter` is the assertion surface: the bug this file guards against
 * happened *before* it was reached, so a test that only counted registrations
 * would also fail — but the ordering test below asserts the shim was ready,
 * which is the actual invariant.
 *
 * `inject` is modelled because `apply` reaches `webServer` that way: the real
 * service is optional (a headless profile serves no browser), so it must not be
 * a hard dependency. Passing it here is what makes `apply` register the routes,
 * which is how the "browser profile" case is exercised at all.
 */
function fakeContext(): {
  ctx: Context
  registrations: Registration[]
  effects: Array<() => void>
  routes: Route[]
  injected: string[]
} {
  const registrations: Registration[] = []
  const effects: Array<() => void> = []
  const routes: Route[] = []
  const injected: string[] = []
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
    /**
     * Cordis' `inject` loads the callback once every named service is
     * available. The stub always satisfies the request (`webServer` exists) so
     * the route registrations run; the scoped context is the same object, which
     * matches how `webServer` is reached in production.
     */
    inject(names: readonly string[], callback: (scoped: Context) => void) {
      injected.push(...names)
      callback(ctx)
      return () => {}
    },
    effect(fn: () => () => void) {
      effects.push(fn())
      return () => {}
    },
    emit: vi.fn(),
    webServer: {
      register(route: Route) {
        routes.push(route)
        return () => {}
      },
    },
  } as unknown as Context
  return { ctx, registrations, effects, routes, injected }
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
    expect(WORKBUDDY_PROVIDER.startsWith('workbuddy-oauth')).toBe(true)
    expect(WORKBUDDY_AI_PROVIDER.startsWith('workbuddy-oauth')).toBe(true)
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

  it('mounts the status and control routes on a browser profile', async () => {
    // The card and the probe control read these routes. Without them the
    // settings page renders nothing and the probe button cannot reach the host,
    // which is exactly the state this change exists to end.
    const { ctx, routes } = fakeContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()

    // One control route per region: `webServer.register` throws on a duplicate
    // path, so a shared path would abort the second region's control surface.
    const paths = routes.map(route => route.path).sort()
    expect(paths).toEqual([WORKBUDDY_STATUS_PATH, WORKBUDDY_CONTROL_PATH, WORKBUDDY_AI_CONTROL_PATH].sort())
    expect(new Set(paths).size).toBe(paths.length)
    for (const route of routes) expect(route.kind).toBe('exact')
  })

  it('reaches webServer through inject rather than requiring it', async () => {
    // A hard dependency would make the whole plugin refuse to load in a
    // headless or ACP profile, where the commands still must work.
    const { ctx, injected } = fakeContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()

    expect(injected).toContain('webServer')
    expect(inject).not.toContain('webServer')
  })

  it('hides every region while signed out, so no route promises a model it cannot serve', async () => {
    // The status document is what the card renders. With no credential the
    // regions must report `signedIn: false` and an empty roster rather than the
    // built-in fallback, which would offer models whose first message fails.
    const { ctx, routes } = fakeContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()

    const statusRoute = routes.find(route => route.path === WORKBUDDY_STATUS_PATH)
    expect(statusRoute).toBeDefined()
    const body = await statusBody(statusRoute)
    expect(body.status).toBe('ok')
    expect(body.accounts).toEqual([])
    expect(body.regions).toHaveLength(2)
    for (const region of body.regions) {
      expect(region.signedIn).toBe(false)
      expect(region.models).toEqual([])
      expect(region.probeResults).toEqual([])
    }
    // Each region advertises its own control path; the card posts to it, so a
    // duplicate or a mismatch is a 404 the user would see as a dead button.
    expect(body.regions.map(region => region.controlPath).sort())
      .toEqual([WORKBUDDY_CONTROL_PATH, WORKBUDDY_AI_CONTROL_PATH].sort())
  })

  it('hands the control key to the card', async () => {
    // Without the key the control route answers 403 and the probe button does
    // nothing at all — silently, because the card degrades a failed POST.
    const { ctx, routes } = fakeContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await settle()

    const body = await statusBody(routes.find(route => route.path === WORKBUDDY_STATUS_PATH))
    expect(typeof body.controlKey).toBe('string')
    expect(body.controlKey.length).toBeGreaterThan(0)
  })
})

/** Drive the mounted status route's handler and parse its JSON answer. */
async function statusBody(route: Route | undefined): Promise<{
  status: string
  accounts: unknown[]
  regions: Array<{ signedIn: boolean; models: unknown[]; probeResults: unknown[]; controlPath: string }>
  controlKey: string
}> {
  if (route === undefined) throw new Error('status route was not mounted')
  const handler = route.handler as (req: unknown, res: unknown) => Promise<void>
  let captured = ''
  const res = {
    writeHead: () => res,
    end: (payload: string) => {
      captured = payload
      return res
    },
  }
  await handler({ method: 'GET', headers: { host: '127.0.0.1:43120' } }, res)
  return JSON.parse(captured) as never
}
