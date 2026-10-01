/**
 * Browser half: the WorkBuddy settings card and the reasoning-level control.
 *
 * One bundle, two contributions, each guarded so a failure in one leaves the
 * other intact — and neither can take down the host provider, whose model
 * channel is unaffected by anything this half registers.
 *
 * Only DSH 0.1.6+'s Plugins page seam (`plugins.bundle.config`, keyed by the
 * bundle's package name) is registered: the 0.1.5 `settings.plugin.item` slot no
 * longer exists on the running host, and registering a seam the host never
 * declares is exactly what makes it silently never run.
 *
 * @module dsh-workbuddy-oauth/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the slot declaration this bundle registers into. The Plugins page
// declares `plugins.bundle.config`; the composer bar declares
// `conversation.input.right`. Cross-plugin collaboration goes through cordis
// services, so value imports would fail the client bundle-purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.tsx'
import { WorkBuddyProbeControl } from './WorkBuddyProbeControl.tsx'
import { installStyles } from './styles.ts'
import { en, zh, type WorkBuddyLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy card and control copy. */
    'workbuddy': WorkBuddyLocaleKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddy-oauth-client'

/** The bundle's package name, which is also this half's configuration key. */
export const BUNDLE_NAME = 'dsh-workbuddy-oauth'

/** Required client services. */
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/** Prefix every guarded client contribution's degradation logs with this. */
const CLIENT_CONTRIBUTION_FAILED = '[dsh-workbuddy-oauth] client contribution failed to load (host provider unaffected):'

/** Disposer handed back when a deferred registration degraded: nothing to undo. */
const NOOP_DISPOSER = (): void => {}

/**
 * Run ONE browser-side contribution, degrading its failure to a `console.error`
 * instead of throwing into the DSH loader. Returns the contribution's own value
 * on success, or `undefined` when it degraded.
 *
 * Guarded at both boundaries where it can throw: the eager
 * `ctx.slots.inject(...)` call (a slot-API shape break) and the deferred slot
 * callback (which the slot runtime invokes long after `apply` has returned).
 */
function guardClientContribution<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error: unknown) {
    console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error)
    return undefined
  }
}

/** Register the bundle's browser-side contributions. */
export function apply(ctx: ClientContext): void {
  const namespace = 'workbuddy'
  // Install the card's stylesheet once per document, before anything renders:
  // the interaction states the card depends on (`:hover`, `:active`,
  // `:focus-visible`, `:disabled`) cannot be expressed by inline styles. Its own
  // failure is not fatal — an unstyled card still works, so this is guarded like
  // every other contribution.
  guardClientContribution('stylesheet', () => { installStyles() })
  guardClientContribution('settings copy', () => {
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-oauth: settings copy')
  })
  const t = ctx.locale.bind(namespace)

  // The Plugins-page configuration entry, keyed by the bundle's package name as
  // the page dispatches it. This is the settings card (P2.4).
  guardClientContribution('plugins.bundle.config page', () => {
    ctx.slots.inject('plugins.bundle.config', () => (
      guardClientContribution('plugins.bundle.config page', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: namespace,
      }, WorkBuddyConfigPage)) ?? NOOP_DISPOSER
    ))
  })

  // The reasoning-level control beside the composer's model selector.
  // `modelDirectories` may arrive after this fiber starts, so the scoped
  // callback — and the slot callback inside it — are guarded at their own
  // boundaries too.
  guardClientContribution('conversation probe control', () => {
    ctx.inject(['modelDirectories'], scope => {
      guardClientContribution('conversation probe control', () => {
        scope.slots.inject('conversation.input.right', () => (
          guardClientContribution('conversation probe control', () => scope.slots.register({
            name: 'conversation.input.right',
            // **Namespaced, not `workbuddy-probe`.** `dsh-workbuddy-connect`
            // registers the same seat with `id: "workbuddy-probe"`, and a list
            // slot throws on a same-id + same-priority second registration
            // (`already has an entry with id`). Reusing its id is exactly the
            // provider-id collision (F2), only on the client slot — and it fails
            // silently here because the guard swallows the throw.
            id: 'workbuddy-oauth-probe',
            order: 10,
            inject: sessionId => ({
              directory: scope.modelDirectories.directoryFor(
                sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
              ).store,
              t,
            }),
          }, WorkBuddyProbeControl)) ?? NOOP_DISPOSER
        ))
      })
    })
  })
}
