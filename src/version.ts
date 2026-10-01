/**
 * Build-time injected plugin version.
 *
 * `tsdown.config.ts` defines `__DSH_WORKBUDDY_OAUTH_VERSION__` from
 * package.json. The declare + fallback keeps `tsc --noEmit` and vitest working
 * on source that has not been through the bundler.
 *
 * @module dsh-workbuddy-oauth/version
 */

declare const __DSH_WORKBUDDY_OAUTH_VERSION__: string | undefined

/** Version of this plugin, as published in package.json. */
export const PLUGIN_VERSION: string =
  typeof __DSH_WORKBUDDY_OAUTH_VERSION__ === 'string'
    ? __DSH_WORKBUDDY_OAUTH_VERSION__
    : '0.0.0-dev'
