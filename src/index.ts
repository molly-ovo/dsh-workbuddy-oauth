/**
 * WorkBuddy models for DeepSeek Harness, signed in through this plugin's own
 * OAuth flow.
 *
 * ## What this is, relative to `dsh-workbuddy-connect`
 *
 * The provider, adapter, shim and upstream client are ported from connect (MIT)
 * and keep its wire behavior, which has been exercised against the live
 * endpoint. What differs is confined to the credential and identity seams:
 *
 * | Concern | connect | here |
 * |---|---|---|
 * | Credential | read + decrypt the desktop app's file | this plugin's OAuth flow |
 * | Outbound identity | read the installed app's version | configuration value |
 * | Accounts | one (whichever the app is signed into) | one per stored file |
 *
 * Consequently there is no desktop-credential decryption, no Electron
 * discovery, no process heartbeat, and no app-bundle parsing in this plugin.
 *
 * ## Structure
 *
 * One provider id (`workbuddy`), parameterized by region at request time rather
 * than duplicated per region. Connect registers two providers because each
 * variant is tied to a different installed app; this plugin has no such tie, so
 * a single provider keeps the settings surface and the model picker smaller.
 * The region still travels with each credential, so a domestic and an
 * international account can coexist.
 *
 * @module dsh-workbuddy-standalone
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createWorkBuddyAdapter } from './adapter.ts'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.ts'
import { createWorkBuddyShim } from './shim.ts'
import { createCredentialStore } from './store.ts'
import { WorkBuddyUpstreamClient } from './upstream.ts'
import { credentialFromLogin, deleteCredential, displayNameOf, listCredentials, probePathFor, type WorkBuddyCredential } from './credentials.ts'
import { setAccountDisabled } from './account-state.ts'
import { readHiddenModels, setRegionHiddenModels } from './hidden-models.ts'
import { readUseMaximumContextWindow, writeUseMaximumContextWindow } from './preferences.ts'
import { LoginClient, LoginPendingError } from './oauth.ts'
import { regionEndpoints, type WorkBuddyRegion } from './region.ts'
import { saveAccount } from './store.ts'
import { registerCommands, type UserQuestionsService } from './commands.ts'
import { PLUGIN_VERSION } from './version.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import { WorkBuddyProbeStore } from './probe-store.ts'
import { WorkBuddyProbeService } from './probe-service.ts'
import { createControlKey, registerWorkBuddyControlRoute } from './control-route.ts'
import { registerWorkBuddyStatusRoute } from './web-status.ts'
import { controlPathFor } from './status-paths.ts'

export { PLUGIN_VERSION } from './version.ts'
export { deriveId, deviceHeaders, requestId } from './fingerprint.ts'
export {
  credentialFromLogin,
  displayNameOf,
  listCredentials,
  maskPhoneNumbers,
  type WorkBuddyCredential,
} from './credentials.ts'
export { LoginClient, LoginPendingError, LoginExpiredError, parseRegionInput } from './oauth.ts'
export { ALL_REGIONS, regionEndpoints, regionOfDomain, type WorkBuddyRegion } from './region.ts'
export { createCredentialStore, chooseRotating, NotSignedInError } from './store.ts'
export { COOLDOWN_STATE_FILENAME, readCooldowns, writeCooldown } from './cooldown-state.ts'
export { createWorkBuddyAdapter } from './adapter.ts'
export { createWorkBuddyShim } from './shim.ts'
export { FALLBACK_WORKBUDDY_MODELS, FALLBACK_WORKBUDDY_AI_MODELS, WorkBuddyCatalog } from './catalog.ts'
export type { WorkBuddyModelInfo } from './catalog.ts'
export { WorkBuddyProbeStore, workbuddyProbePath, fingerprintModel } from './probe-store.ts'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export { probeModel, PROBE_EFFORT_CANDIDATES } from './probe.ts'
export { createControlKey, workBuddyControlHandler } from './control-route.ts'
export { workBuddyWebStatus, workBuddyStatusHandler } from './web-status.ts'
export {
  WORKBUDDY_STATUS_PATH,
  WORKBUDDY_CONTROL_PATH,
  WORKBUDDY_AI_CONTROL_PATH,
  WORKBUDDY_CONTROL_KEY_HEADER,
  controlPathFor,
  type WorkBuddyWebStatus,
  type WorkBuddyWebRegion,
  type WorkBuddyWebProbeModel,
  type WorkBuddyWebAccount,
  type WorkBuddyWebModel,
  type WorkBuddyControlResult,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddy-standalone'

/** The model registry required before the provider can register. */
export const inject = ['llm', 'commands']

/**
 * Provider ids.
 *
 * **Namespaced deliberately, and not `workbuddy` / `workbuddy-ai`.** An adapter
 * is registered per provider id and a duplicate is a hard error
 * (`an adapter for provider "workbuddy" is already registered`), so a plain
 * `workbuddy` collides with `dsh-workbuddy-connect` — which claims exactly those
 * two ids — and makes this plugin's models silently unavailable whenever both
 * are installed. That is the expected setup for migration, so the collision is
 * not hypothetical: it happened on the first install.
 *
 * The prefix also keeps the two plugins' model groups distinguishable in the
 * picker, which is what a user comparing them needs.
 */
export const WORKBUDDY_PROVIDER = 'workbuddy-standalone'

/** Provider id for the international region. */
export const WORKBUDDY_AI_PROVIDER = 'workbuddy-standalone-ai'

/**
 * Provider id for one region.
 *
 * Two ids, not one: the upstreams advertise overlapping model ids, and a single
 * provider id would make the descriptor for a model depend on which region
 * happened to register last.
 */
export function providerIdFor(region: WorkBuddyRegion): string {
  return region === 'global' ? WORKBUDDY_AI_PROVIDER : WORKBUDDY_PROVIDER
}

/** Stream idle timeout, matching the ported client's expectations. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Whether *automatic* reasoning-effort probing is authorized.
 *
 * **Permanently `false`, and that is a deliberate policy rather than an
 * unfinished setting.** A probe spends the user's credit, so the upstream
 * project's own design rule is that a sweep runs only when the user asks for it.
 * The control route therefore calls `probe(modelId, true)` — per-click manual
 * consent — and this gate exists so that any *future* automatic trigger has to
 * come through a deliberate decision instead of inheriting permission by
 * default.
 *
 * Do not wire a settings toggle to this without revisiting that rule.
 */
export const AUTOMATIC_PROBING_AUTHORIZED = false

/** How often to re-read credentials to notice a sign-in that happened while running, in ms. */
const CREDENTIAL_POLL_MS = 15_000

/** Configuration schema. */
export interface Config {
  /** Desktop-app version to claim in the User-Agent; empty uses the built-in default. */
  appVersion?: string
  /** CLI version to claim; empty omits the `CLI/…` User-Agent token. */
  cliVersion?: string
  /** Region to sign in to when no argument is given. */
  region?: string
}

export const Config: z<Config> = z.object({
  appVersion: z.string().default(''),
  cliVersion: z.string().default(''),
  region: z.string().default('cn'),
})

/** One region's live runtime. */
interface RegionRuntime {
  region: WorkBuddyRegion
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  store: ReturnType<typeof createCredentialStore>
  probeStore: WorkBuddyProbeStore
  probeService: WorkBuddyProbeService
  /**
   * The account in effect for this region, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * **Why a cached synchronous value rather than a store read.** The probe
   * service judges records synchronously on every adapter read
   * (`observe: modelId => service.recordFor(modelId)`), but the credential store
   * is asynchronous — it lists and parses files. Awaiting inside that path would
   * turn a synchronous model-descriptor read into a promise the adapter cannot
   * wait on. So the identity is refreshed whenever the credential is actually
   * read (the startup fetch, the poll, a sign-in, a manual refresh), and the
   * probe service re-checks it before writing a result back.
   */
  account: () => string | undefined
  /**
   * Refresh the cached identity from a credential just read, or clear it when
   * signed out.
   *
   * Called by every path that reads the credential (the startup fetch, the poll,
   * a sign-in, a manual refresh), which is what keeps {@link RegionRuntime.account}
   * truthful without an async read on the adapter's synchronous path.
   */
  setAccount: (credential: WorkBuddyCredential | undefined) => void
  /**
   * Rebuild the provider snapshot and tell the model picker to re-read.
   *
   * A no-op until {@link startRegion} has built the adapter, so a route that
   * fires before registration cannot throw on an undefined callback.
   */
  invalidate: () => void
}

/**
 * The stable identity key for a credential, or `undefined` when it has no uid.
 *
 * `enterpriseId` joins the uid because the same user id can exist in two
 * enterprises, and a probe observation (an entitlement fact) must not cross
 * between them. A uid-less credential yields `undefined` rather than a
 * `":enterpriseId"` key that every uid-less account would silently share.
 */
export function accountIdentityOf(
  credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'> | undefined,
): string | undefined {
  if (credential === undefined || credential.uid === '') return undefined
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/**
 * Pick the fallback roster for a region.
 *
 * Used only until the first successful fetch; the live catalog replaces it.
 */
function fallbackFor(region: WorkBuddyRegion): readonly WorkBuddyModelInfo[] {
  return region === 'global' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS
}

/** Build one region's runtime. */
function createRegionRuntime(
  region: WorkBuddyRegion,
  identity: { appVersion?: string; cliVersion?: string },
  consent: () => boolean,
): RegionRuntime {
  const client = new WorkBuddyUpstreamClient({ identity })
  const catalog = new WorkBuddyCatalog(fallbackFor(region))
  // Region-scoped: a credential is only valid against its own upstream host, so
  // a store must never hand the international service a domestic token.
  const store = createCredentialStore({ region })
  const probeStore = new WorkBuddyProbeStore({
    pluginVersion: PLUGIN_VERSION,
    // This plugin's own file, not the ported default: see `probePathFor`.
    path: probePathFor(region),
  })
  let account: string | undefined
  const probeService = new WorkBuddyProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent,
    account: () => account,
  })
  return {
    region,
    client,
    catalog,
    store,
    probeStore,
    probeService,
    account: () => account,
    // Records are read and written against the identity refreshed by
    // `refreshCatalog`; see {@link RegionRuntime.account}.
    setAccount: (credential) => {
      account = accountIdentityOf(credential)
    },
    invalidate: () => {},
  }
}

/**
 * Refresh one region's catalog from the upstream, if an account exists.
 *
 * Failures are swallowed into a log line: a network problem must not stop the
 * provider from registering, and the fallback roster keeps working meanwhile.
 *
 * @param reason - Why the refresh is happening. A periodic poll passes
 *   `'poll'` and stays quiet when nothing changed, so the log does not fill
 *   with one identical line every interval; a user-triggered refresh (after a
 *   sign-in) passes `'login'` and always reports, because the user is waiting
 *   for exactly that confirmation.
 * @returns whether the catalog changed (callers emit an adapter update then).
 */
async function refreshCatalog(
  ctx: Context,
  runtime: RegionRuntime,
  log: (message: string) => void,
  reason: 'startup' | 'login' | 'poll' = 'poll',
): Promise<boolean> {
  const label = regionEndpoints(runtime.region).label
  // Ask the store rather than picking a credential here: the store owns the
  // region filter and the selection rule, and duplicating either would let the
  // catalog be fetched with one account while requests are served by another.
  const credential = await runtime.store.current()
  // Keep the cached identity in step with the credential this read settled on.
  // Every path that reads a credential goes through here (or the poll below), so
  // this one assignment is what makes the probe service's synchronous
  // `account()` truthful.
  runtime.setAccount(credential)
  if (credential === undefined) {
    // No account for this region: hide the group rather than offering models
    // that can only fail on the first message.
    const changed = runtime.catalog.setVisible(false)
    if (changed && reason !== 'poll') log(`${label}：无可用账号，模型分组已隐藏。`)
    return changed
  }
  const becameVisible = runtime.catalog.setVisible(true)

  try {
    const models = await runtime.client.fetchModels(credential)
    if (models.length === 0) {
      if (reason !== 'poll') log(`${label}：上游返回空模型列表，保留内置回落表。`)
      return becameVisible
    }
    // `catalog.set` returns void, so the change check happens here rather than
    // by modifying the ported catalog. Comparing the ids is enough: the poll
    // exists to notice models appearing or disappearing, not to notice
    // reordered metadata.
    const before = runtime.catalog.current().map((model) => model.id).join(',')
    runtime.catalog.set(models)
    const after = runtime.catalog.current().map((model) => model.id).join(',')
    const changed = before !== after
    // A poll that changed nothing is not worth a line, but a startup or a
    // sign-in always is: those are the moments a user checks the log to see
    // whether the plugin worked.
    if (changed || reason !== 'poll') log(`${label}：已同步 ${models.length} 个模型。`)
    return changed || becameVisible
  } catch (error: unknown) {
    // Failures are logged at every reason: a repeated failure is the signal
    // that something is actually broken, unlike a repeated success.
    log(
      `${label}：模型列表拉取失败，保留内置回落表（${error instanceof Error ? error.message : String(error)}）。`,
    )
    return becameVisible
  }
}

/**
 * Plugin entry point.
 *
 * Wires one provider, its loopback shim, and the credential-driven catalog
 * lifecycle. Nothing here reads the WorkBuddy desktop app.
 */
export function apply(ctx: Context, config: Config): void {
  const log = (message: string): void => {
    ctx.logger.info(`dsh-workbuddy-standalone: ${message}`)
  }

  const identity = {
    ...(config.appVersion !== undefined && config.appVersion !== '' ? { appVersion: config.appVersion } : {}),
    ...(config.cliVersion !== undefined && config.cliVersion !== '' ? { cliVersion: config.cliVersion } : {}),
  }

  const runtimes = [
    createRegionRuntime('cn', identity, () => AUTOMATIC_PROBING_AUTHORIZED),
    createRegionRuntime('global', identity, () => AUTOMATIC_PROBING_AUTHORIZED),
  ]

  /**
   * Apply the persisted hidden-model rule to each catalog.
   *
   * Loaded once at startup; the catalog's `setHiddenModels` is separate from the
   * roster (`set`), so a later catalog refresh cannot resurrect a hidden model.
   * The read is fire-and-forget — until it lands, the catalog simply shows the
   * full roster, which is the harmless default.
   */
  void readHiddenModels().then((hidden) => {
    for (const runtime of runtimes) {
      runtime.catalog.setHiddenModels(new Set(hidden[runtime.region]))
    }
  })

  /**
   * Apply the persisted maximum-context-window preference to every catalog.
   *
   * One flag shared across both regions (only the international roster declares
   * a larger window, so in practice only it changes); loaded once at startup,
   * fire-and-forget like the hidden set.
   */
  void readUseMaximumContextWindow().then((useMaximum) => {
    if (!useMaximum) return
    let changed = false
    for (const runtime of runtimes) {
      if (runtime.catalog.setUseMaximumContextWindow(true)) changed = true
    }
    if (changed) ctx.emit('llm/adapters-updated')
  })

  /**
   * Live login attempts, keyed by state.
   *
   * Held here rather than in a module global so a profile reload cannot leave a
   * stale pending login behind.
   */
  const logins = new LoginClient()

  /** Schedules outstanding, cleared on disposal. */
  const timers: NodeJS.Timeout[] = []
  let stopped = false

  const shims: Array<() => Promise<void>> = []

  /**
   * Start one region's loopback endpoint, then register its provider.
   *
   * **Order matters**: the adapter reads the shim's origin while it is being
   * constructed, so the listener must already hold a port. Constructing first
   * throws `workbuddy shim has no listening address` and the whole entry fails
   * to activate. (Connect documents this at its own call site, which is why it
   * awaits `shim.ready` before building the adapter.)
   */
  const startRegion = async (runtime: RegionRuntime): Promise<void> => {
    const { region } = runtime
    const label = regionEndpoints(region).label
    const shim = createWorkBuddyShim({
      store: runtime.store,
      client: runtime.client,
      catalog: runtime.catalog,
      logger: ctx.logger,
    })
    shims.push(() => shim.close())

    try {
      await shim.ready
    } catch (error: unknown) {
      ctx.logger.error(`dsh-workbuddy-standalone: ${label} 回环端点启动失败`, error)
      return
    }

    try {
      const result = createWorkBuddyAdapter({
        // One provider id per region. The two upstreams offer overlapping model
        // ids (both list `deepseek-v4.1-flash`), so a shared id would make
        // `resolveModel` ambiguous and let a request resolve to a descriptor
        // built for the other region's endpoint.
        providerId: providerIdFor(region),
        // The picker groups models under this name. It must stay visibly
        // distinct from `dsh-workbuddy-connect`'s "WorkBuddy" / "WorkBuddy AI"
        // groups — a user with both installed compares them side by side, and a
        // collision-free name is the only thing that tells the groups apart.
        displayName: regionEndpoints(region).label,
        shim,
        store: runtime.store,
        catalog: runtime.catalog,
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) =>
          resolveImageAttachmentAccess(
            attachments,
            (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
            ref,
          ),
        // The reasoning-level gap this plugin used to have: the upstream no
        // longer declares `supportedEfforts` for most rows, so without a local
        // observation those models get no level picker at all. This is the seam
        // that supplies one from a user-authorized probe.
        observe: (modelId) => runtime.probeService.recordFor(modelId),
      })

      const release = ctx.llm.registerAdapter([providerIdFor(region)], result.adapter)
      // Routes and the settings card invalidate through this, so the adapter is
      // rebuilt after a probe observation or a manual catalog refresh.
      runtime.invalidate = () => {
        result.invalidate()
        ctx.emit('llm/adapters-updated')
      }
      try {
        ctx.effect(() => () => {
          release()
          void shim.close()
        })
      } catch {
        // `ctx.effect` throws once the context is disposed, so the disposer it
        // would have registered never runs; release here instead.
        release()
        void shim.close()
      }

      const synced = await refreshCatalog(ctx, runtime, log, 'startup')
      if (synced) result.invalidate()
      ctx.emit('llm/adapters-updated')
    } catch (error: unknown) {
      // Contained per region: one region failing must not take the other down.
      ctx.logger.error(`dsh-workbuddy-standalone: ${label} provider 注册失败`, error)
      void shim.close()
    }
  }

  for (const runtime of runtimes) void startRegion(runtime)

  /**
   * Notice sign-ins that happen while DSH keeps running.
   *
   * Without this the model group would only appear after a restart, because the
   * initial fetch happens once at startup.
   *
   * The catalog is re-fetched only when there is something new to fetch: while a
   * region has no account, polling the upstream would be a wasted request every
   * interval (and the upstream is the last place to spend gratuitous traffic).
   * A region that already has a catalog is left alone — model rosters change on
   * the order of days, and `refreshCatalog` re-fetches on the next sign-in
   * anyway. This keeps the interval cheap and the log quiet.
   */
  const poll = setInterval(() => {
    if (stopped) return
    for (const runtime of runtimes) {
      void runtime.store
        .current()
        .then(async (credential) => {
          if (credential === undefined) {
            // Signed out: hide the group if it is showing, and do not call out.
            if (runtime.catalog.setVisible(false)) ctx.emit('llm/adapters-updated')
            return
          }
          // A credential appeared for a region that was hidden: this is the
          // sign-in case the interval exists for.
          if (!runtime.catalog.isVisible()) {
            const changed = await refreshCatalog(ctx, runtime, log, 'login')
            if (changed) ctx.emit('llm/adapters-updated')
          }
        })
        .catch((error: unknown) => {
          ctx.logger.warn('dsh-workbuddy-standalone: 账号轮询失败', error)
        })
    }
  }, CREDENTIAL_POLL_MS)
  timers.push(poll)

  /**
   * Complete a sign-in: redeem the authorization, persist the credential, and
   * refresh every region's catalog.
   *
   * **One implementation, two surfaces.** Both `/wb-login` and the settings
   * card's sign-in button reach the upstream through this, so the two entry
   * points cannot drift into two different login flows — the failure that would
   * produce is a card that signs in "successfully" while the command path (which
   * the rest of the plugin trusts) never ran.
   */
  const completeLogin = async (state: string): Promise<{ uid: string; label: string }> => {
    const result = await logins.complete(state)
    const credential = credentialFromLogin(result)
    await saveAccount(credential)
    // Refresh immediately so the models are selectable without waiting for the
    // periodic poll.
    await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, 'login')))
    ctx.emit('llm/adapters-updated')
    return { uid: credential.uid, label: displayNameOf(credential) }
  }

  /**
   * Register the sign-in commands.
   *
   * `userQuestions` is read through `ctx.get` rather than declared as a
   * dependency: it is absent in headless and ACP profiles, and injecting it
   * would make the whole plugin refuse to load there. The command layer
   * degrades to a text prompt when it is missing.
   */
  const commandDisposers = registerCommands(ctx, logins, {
    complete: completeLogin,
    userQuestions: ctx.get('userQuestions') as UserQuestionsService | undefined,
    warn: (message, error) => {
      ctx.logger.warn(`dsh-workbuddy-standalone: ${message}`, error)
    },
  })

  /**
   * Same-origin routes backing the settings card and the probe control.
   *
   * `webServer` is optional — a headless or ACP profile serves no browser — so
   * it is reached through `ctx.inject` rather than declared in `inject`. Naming
   * it as a hard dependency would make the whole plugin refuse to load exactly
   * where the commands still work.
   */
  const controlKey = createControlKey()
  ctx.inject(['webServer'], (webCtx) => {
    registerWorkBuddyStatusRoute(webCtx, {
      regions: runtimes.map(runtime => ({
        region: runtime.region,
        providerId: providerIdFor(runtime.region),
        // The full roster, not `current()`: the card's visibility list must
        // still show a hidden model so its checkbox can be re-ticked. `current()`
        // already drops hidden ids, which is exactly what makes hiding
        // irreversible from the card — the row vanishes the moment it is hidden.
        models: () => runtime.catalog.roster(),
        probeRunning: () => runtime.probeService.isRunning(),
        probeCandidates: () =>
          runtime.catalog.current().filter(info => runtime.probeService.isCandidate(info.id)).map(info => info.id),
        probeResults: () =>
          runtime.catalog.current().flatMap(info => {
            const record = runtime.probeService.recordFor(info.id)
            return record === undefined ? [] : [{ id: info.id, record }]
          }),
        hiddenModels: () => runtime.catalog.hiddenModelIds(),
        useMaximumContextWindow: () => runtime.catalog.isUsingMaximumContextWindow(),
      })),
      controlKey,
    })

    for (const runtime of runtimes) {
      registerWorkBuddyControlRoute(webCtx, {
        // One path per region: `webServer.register` throws on a duplicate, so a
        // shared path would abort the second region's control surface.
        path: controlPathFor(runtime.region),
        probe: async (modelId) => {
          // The authenticated manual endpoint is reached only after per-model
          // confirmation, so it carries one-request consent. This never changes
          // the automatic-probing policy.
          const result = await runtime.probeService.probe(modelId, true)
          if (result.state === 'ok') runtime.invalidate()
          return result
        },
        clear: () => {
          runtime.probeStore.clear()
          runtime.invalidate()
        },
        refresh: async () => {
          if (stopped) return { state: 'failed', reason: 'plugin is stopping' }
          const changed = await refreshCatalog(ctx, runtime, log, 'login')
          if (changed) runtime.invalidate()
          return runtime.catalog.isVisible()
            ? { state: 'refreshed', reason: `${runtime.catalog.current().length} models` }
            : { state: 'signed-out' }
        },
        /**
         * The card's sign-in flow.
         *
         * `begin` is region-specific because the authorization URL is issued by
         * one upstream, but `complete` is not: the state carries its own region
         * (see `LoginClient`), so the card cannot redeem a state against the
         * wrong host. Both regions therefore share one `complete`.
         */
        loginBegin: async (region) => {
          const target = region === 'global' ? 'global' : 'cn'
          const request = await logins.begin(target)
          return { state: 'pending', url: request.url, loginState: request.state }
        },
        loginComplete: async (state) => {
          try {
            const result = await completeLogin(state)
            return { state: 'ok', reason: result.label }
          } catch (error: unknown) {
            // A not-yet-approved authorization is the normal case while the user
            // is still in the browser, so it is reported as `pending` rather
            // than as a failure; anything else is a real error.
            if (error instanceof LoginPendingError) return { state: 'pending' }
            return {
              state: 'failed',
              reason: error instanceof Error ? error.message : String(error),
            }
          }
        },
        /**
         * The card's counterpart to `/wb-logout`.
         *
         * Deletes our own stored credential only — the upstream account is
         * untouched — and refreshes the catalog so a group that is now empty
         * disappears instead of offering models that can only fail.
         */
        logout: async (uid) => {
          const credentials = await listCredentials()
          const target = credentials.find(credential => credential.uid === uid)
          if (target === undefined) return { state: 'failed', reason: 'no such account' }
          const label = displayNameOf(target)
          await deleteCredential(uid)
          await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, 'login')))
          ctx.emit('llm/adapters-updated')
          return { state: 'ok', reason: label }
        },
        /**
         * The card's counterpart to `/wb-account enable|disable`.
         *
         * Reversible, unlike {@link logout}: the credential file stays, so the
         * account keeps its tokens and only leaves selection. The catalog is
         * refreshed because disabling the account in use must drop the group
         * rather than leave it serving requests that will now fail.
         */
        setAccountEnabled: async (uid, enabled) => {
          const credentials = await listCredentials()
          if (!credentials.some(credential => credential.uid === uid)) {
            return { state: 'failed', reason: 'no such account' }
          }
          await setAccountDisabled(uid, !enabled)
          await Promise.all(runtimes.map((runtime) => refreshCatalog(ctx, runtime, log, 'login')))
          ctx.emit('llm/adapters-updated')
          return { state: 'ok', reason: enabled ? 'enabled' : 'disabled' }
        },
        /**
         * The card's counterpart to hiding a model.
         *
         * The host owns both the catalog filter and the persisted rule, so the
         * picker and the checkbox cannot disagree. The loop's `runtime` is the
         * region this route serves; the body's region is checked rather than
         * trusted, since a route posting to the wrong region would hide the wrong
         * roster.
         */
        setModelVisible: async (region, modelId, visible) => {
          if (region !== runtime.region) {
            return { state: 'failed', reason: `region mismatch: ${region}` }
          }
          const next = new Set(runtime.catalog.hiddenModelIds())
          if (visible) next.delete(modelId)
          else next.add(modelId)
          const changed = runtime.catalog.setHiddenModels(next)
          await setRegionHiddenModels(runtime.region, [...next])
          if (changed) runtime.invalidate()
          return { state: 'ok', reason: visible ? 'visible' : 'hidden' }
        },
        /**
         * The card's counterpart to the maximum-context-window preference.
         *
         * One flag shared across regions; the host owns the catalog flag and the
         * persistence, so the picker and the checkbox cannot disagree. Invalidates
         * the adapter only when the flag actually changed.
         */
        setMaximumContextWindow: async (enabled) => {
          await writeUseMaximumContextWindow(enabled)
          let changed = false
          for (const region of runtimes) {
            if (region.catalog.setUseMaximumContextWindow(enabled)) changed = true
          }
          if (changed) ctx.emit('llm/adapters-updated')
          return { state: 'ok', reason: enabled ? 'maximum' : 'default' }
        },
        /**
         * The card's counterpart to P5.1: fetch one account's balance.
         *
         * Reads the stored credential by uid and asks the upstream for its
         * balance, returning it in `credits` for immediate display.
         */
        refreshCredits: async (uid) => {
          const credential = (await listCredentials()).find(item => item.uid === uid)
          if (credential === undefined) return { state: 'failed', reason: 'no such account' }
          try {
            const credits = await runtime.client.fetchCredits(credential)
            return { state: 'ok', reason: 'credits', credits }
          } catch (error: unknown) {
            return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
          }
        },
      }, controlKey)
    }
  })

  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    for (const dispose of commandDisposers) dispose()
    for (const close of shims) void close()
  })

  log(`已加载 v${PLUGIN_VERSION}（自有 OAuth 登录，不读取桌面端）`)
}
