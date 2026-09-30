/**
 * Region (realm) definitions for the two WorkBuddy deployments.
 *
 * Kept as a first-class concept from day one: the domestic and international
 * services are separate account systems with separate quotas, and their
 * catalog endpoints behave differently. A plugin that hard-codes one of them
 * cannot be extended to the other without a rewrite.
 *
 * Endpoint table mirrors the upstream `realmConfig` used by the official CLI:
 * the CN API host and the CN web origin are deliberately *different* domains,
 * and the login endpoints check `Origin`.
 *
 * @module dsh-workbuddy-standalone/region
 */

/** Which WorkBuddy deployment a credential belongs to. */
export type WorkBuddyRegion = 'cn' | 'global'

/** Upstream endpoints for one region. */
export interface RegionEndpoints {
  /** API base: chat, catalog and billing endpoints hang off this. */
  base: string
  /** Web origin used for `Origin` / `Referer`. */
  origin: string
  /**
   * Host the OAuth sign-in flow must be driven against, when it differs from
   * {@link base}.
   *
   * Measured: the state endpoint echoes the host it was called on into the
   * authorization URL it returns, and the login page a state is issued for is
   * host-scoped — so the URL the user opens, and every follow-up call for that
   * state, has to sit on one host. The desktop app opens `www.workbuddy.cn` with
   * `platform=workbuddy`, and phone-number sign-in on a `copilot.tencent.com`
   * URL is rejected with `无效的token`. `base` stays the API host because chat
   * and catalog are served from there.
   */
  loginBase: string
  /** Human label for status output. */
  label: string
}

/**
 * Endpoint table.
 *
 * CN's `base` and `origin` are different domains on purpose — the upstream
 * validates `Origin` against the web site while serving the API from the
 * copilot host. Do not "tidy" these into one value. `loginBase` is a third host
 * for the same reason; see {@link RegionEndpoints.loginBase}.
 */
export function regionEndpoints(region: WorkBuddyRegion): RegionEndpoints {
  return region === 'global'
    ? {
        base: 'https://www.workbuddy.ai',
        origin: 'https://www.workbuddy.ai',
        loginBase: 'https://www.workbuddy.ai',
        label: 'WorkBuddy AI (国际版)',
      }
    : {
        base: 'https://copilot.tencent.com',
        origin: 'https://www.codebuddy.cn',
        loginBase: 'https://www.workbuddy.cn',
        label: 'WorkBuddy (国内版)',
      }
}

/**
 * Infer the region from a credential's `domain` field.
 *
 * The upstream returns a bare domain (e.g. `workbuddy.ai`), so this matches on
 * the suffix rather than equality.
 *
 * @param domain - Domain reported by the upstream credential.
 * @returns The region that domain belongs to; defaults to `cn`.
 */
export function regionOfDomain(domain: string): WorkBuddyRegion {
  const normalized = domain.trim().toLowerCase()
  return normalized === 'workbuddy.ai' || normalized.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

/** Both regions, for iteration in status output. */
export const ALL_REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global'] as const
