/**
 * The read-only status document the browser half renders.
 *
 * Separated from the ported `web-status.ts` shape on purpose: this plugin serves
 * one *bundle* status (both regions, one card) rather than one status per
 * variant, because it registers one provider per region from one plugin
 * instance. Collecting both regions into one document is what lets the card
 * render a single page and lets the probe control resolve its endpoint without
 * knowing which region the selected model belongs to.
 *
 * Kept free of `node:` imports beyond the type level so the tests can drive it
 * against stub collaborators.
 *
 * @module dsh-workbuddy-standalone/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { displayNameOf, listCredentials, type WorkBuddyCredential } from './credentials.ts'
import { disabledUids } from './account-state.ts'
import { regionEndpoints, type WorkBuddyRegion } from './region.ts'
import { hostIsLoopback } from './loopback.ts'
import { PLUGIN_VERSION } from './version.ts'
import {
  controlPathFor,
  WORKBUDDY_STATUS_PATH,
  type WorkBuddyWebAccount,
  type WorkBuddyWebModel,
  type WorkBuddyWebProbeModel,
  type WorkBuddyWebRegion,
  type WorkBuddyWebStatus,
} from './status-paths.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyProbeRecord } from './probe-store.ts'

/**
 * One region's live contributors.
 *
 * Functions rather than values: the document is assembled per request, so a
 * sign-in, a catalog refresh, or a finished probe is reflected on the next read
 * without the route holding a snapshot that can go stale.
 */
export interface WorkBuddyRegionView {
  region: WorkBuddyRegion
  /** The provider id this region registers under. */
  providerId: string
  /** Models this region currently exposes (empty while hidden). */
  models: () => readonly WorkBuddyModelInfo[]
  /** Whether a probe sweep is running for this region. */
  probeRunning: () => boolean
  /** Models this region could probe by hand. */
  probeCandidates: () => readonly string[]
  /**
   * Recorded observations, judged the same way the adapter judges them.
   *
   * Resolved through the probe service rather than read raw from the store, so
   * the card never promises levels the model picker does not offer: a record can
   * be stale in ways the service already discounts (its catalog row changed, it
   * aged past the TTL, or the upstream has since declared an effort set).
   *
   * Paired with the model id here rather than recovered later: the store's
   * records deliberately carry no id (they are keyed by one), so only the
   * caller — which selected the models — knows which row each record describes.
   */
  probeResults: () => readonly { id: string; record: WorkBuddyProbeRecord }[]
  /**
   * Model ids the user has hidden for this region.
   *
   * A function like the other contributors rather than a frozen value: the
   * hidden set is a persisted rule that changes out from under the document,
   * and the card must reflect the current toggle state on each read.
   */
  hiddenModels: () => readonly string[]
  /**
   * Whether the user chose the largest declared context window for this region.
   *
   * A function rather than a frozen value so the card reflects the current
   * flag on each read, exactly like {@link hiddenModels}.
   */
  useMaximumContextWindow: () => boolean
}

/** Constructor dependencies for {@link workBuddyWebStatus}. */
export interface WorkBuddyStatusRouteOptions {
  /** Every region this plugin serves. */
  regions: readonly WorkBuddyRegionView[]
  /** Credentials currently stored, newest selection first is not required. */
  credentials?: () => Promise<readonly WorkBuddyCredential[]>
  /** Disabled account uids, so each account can report its own state. */
  disabled?: () => Promise<ReadonlySet<string>>
  /** The in-process control key handed to the card. */
  controlKey: string
  /** Clock, injectable for tests. */
  now?: () => number
}

/** Accounts, grouped by region, as the card displays them. */
function accountViews(
  credentials: readonly WorkBuddyCredential[],
  disabled: ReadonlySet<string>,
): readonly WorkBuddyWebAccount[] {
  return credentials.map(credential => ({
    uid: credential.uid,
    label: displayNameOf(credential),
    region: credential.region,
    expiresAtMs: credential.expiresAtMs,
    enabled: !disabled.has(credential.uid),
  }))
}

/** One model's display fields. */
function modelViews(models: readonly WorkBuddyModelInfo[]): readonly WorkBuddyWebModel[] {
  return models.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // More than one declared window means the maximum-window switch has
    // something to change on this row. `contextWindow` is already the resolved
    // value for the current flag, so the card needs no second figure.
    multiWindow: (model.supportedContextWindows?.length ?? 0) > 1,
  }))
}

/** One region's slice of the document. */
function regionView(
  view: WorkBuddyRegionView,
  signedIn: boolean,
): WorkBuddyWebRegion {
  const models = view.models()
  const byId = new Map(models.map(model => [model.id, model]))
  return {
    region: view.region,
    label: regionEndpoints(view.region).label,
    controlPath: controlPathFor(view.region),
    providerId: view.providerId,
    signedIn,
    models: modelViews(models),
    hiddenModels: [...view.hiddenModels()],
    useMaximumContextWindow: view.useMaximumContextWindow(),
    probeRunning: view.probeRunning(),
    probeCandidates: [...view.probeCandidates()],
    // Newest first: a detection the user just ran belongs at the top, not
    // appended below every earlier one. A record for a model the upstream has
    // since dropped leaves the catalog entirely, so it drops out here too.
    probeResults: view.probeResults()
      .flatMap(({ id, record }): readonly WorkBuddyWebProbeModel[] => {
        const info = byId.get(id)
        return info === undefined
          ? []
          : [{ id, name: info.name, validation: record.validation, efforts: record.efforts, probedAt: record.probedAtMs }]
      })
      .sort((a, b) => b.probedAt - a.probedAt),
  }
}

/** Assemble the document. */
export async function workBuddyWebStatus(options: WorkBuddyStatusRouteOptions): Promise<WorkBuddyWebStatus> {
  const credentials = await (options.credentials ?? listCredentials)()
  const disabled = await (options.disabled ?? disabledUids)()
  const signedInRegions = new Set(credentials.map(credential => credential.region))
  return {
    status: 'ok',
    version: PLUGIN_VERSION,
    accounts: accountViews(credentials, disabled),
    regions: options.regions.map(view => regionView(view, signedInRegions.has(view.region))),
    controlKey: options.controlKey,
  }
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function workBuddyStatusHandler(
  deps: WorkBuddyStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await workBuddyWebStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_STATUS_PATH,
      handler: workBuddyStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddy-standalone: status route')
}
