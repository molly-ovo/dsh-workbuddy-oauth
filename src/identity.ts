/**
 * Outbound client identity: the User-Agent and `X-IDE-Version` a request
 * presents as.
 *
 * ## What replaced what
 *
 * `dsh-workbuddy-connect` resolves this identity by reading the installed
 * desktop app (bundle `Info.plist`, `cli/package.json`), caching what it finds,
 * and falling back to a compiled-in constant. That works, but it makes the
 * plugin's outbound identity depend on a desktop app being installed and
 * parseable — the dependency this plugin exists to remove.
 *
 * Here the identity is a **configuration value with a compiled-in default**.
 * The resolved string is identical in shape to the one connect sends, because
 * that shape is what the upstream has been observed to accept:
 *
 * - chat: `WorkBuddy/<ver> WorkBuddy/<ver>` (or `WorkBuddy AI/<ver>` for the
 *   international region), optionally with a trailing `CLI/<ver>` token.
 * - catalog: `WorkBuddyAI/<ver>` with **no space** — the space form is rejected
 *   with 400/12403.
 *
 * Versions are validated before they reach a header: the value is interpolated
 * into an HTTP header, so whitespace, CR or LF must never pass, and a malformed
 * one throws rather than sending a broken request.
 *
 * @module dsh-workbuddy-standalone/identity
 */

import type { WorkBuddyRegion } from './region.ts'

/**
 * Default desktop-app version claimed for the domestic region.
 *
 * A claim, not a measurement: the upstream has not been observed to branch on
 * the specific value, only on the User-Agent being app-shaped rather than
 * CLI-shaped. Kept equal to the reference implementation's constant so the
 * outbound fingerprint matches what has been running in practice.
 */
export const DEFAULT_CN_APP_VERSION = '5.5.6'

/** Default desktop-app version for the international region. */
export const DEFAULT_GLOBAL_APP_VERSION = '5.5.2'

/**
 * Whether a value is a version that may reach a header.
 *
 * Tolerates a prerelease suffix (`2.137.1-rc.1`); anything containing
 * whitespace, CR or LF never passes, because the value is interpolated into an
 * HTTP header and a newline there is a header-injection vector.
 */
export function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/** The identity a chat request presents as. */
export interface ChatIdentity {
  /** Desktop-app version; drives the desktop User-Agent and `X-IDE-Version`. */
  clientVersion: string
  /** Bundled agent-CLI version; absent drops the `CLI/…` token. */
  cliVersion?: string
}

/** The identity a catalog request presents as. */
export interface AppVersionInfo {
  version: string
  source: 'config' | 'fallback'
}

/** Where the identity values come from. Every field is optional. */
export interface IdentityConfig {
  /** Desktop-app version to claim. */
  appVersion?: string
  /** CLI version to claim; omit to drop the `CLI/…` token. */
  cliVersion?: string
}

/**
 * The version to claim for one region, honouring configuration and validating
 * it.
 *
 * An invalid configured value is **rejected, not coerced** — silently sending
 * the default when the user asked for something else would hide their typo
 * behind a request that appears to work.
 *
 * @throws Error - the configured version is not header-safe.
 */
export function resolveAppVersion(region: WorkBuddyRegion, config: IdentityConfig = {}): string {
  const configured = config.appVersion
  if (configured !== undefined && configured !== '') {
    if (!validVersion(configured)) {
      throw new Error(
        `配置的 appVersion 无法用作请求头：${JSON.stringify(configured)}（需形如 5.5.6）`,
      )
    }
    return configured
  }
  return region === 'global' ? DEFAULT_GLOBAL_APP_VERSION : DEFAULT_CN_APP_VERSION
}

/**
 * Resolve the full chat identity for one region.
 *
 * Never throws on a bad CLI version — an unusable optional token is dropped
 * rather than failing the request, because the `CLI/…` segment is optional to
 * the upstream while a failed message is not recoverable.
 *
 * @throws Error - the app version itself is unusable.
 */
export function resolveChatIdentity(region: WorkBuddyRegion, config: IdentityConfig = {}): ChatIdentity {
  const clientVersion = resolveAppVersion(region, config)
  const cliVersion = config.cliVersion
  if (cliVersion !== undefined && cliVersion !== '' && validVersion(cliVersion)) {
    return { clientVersion, cliVersion }
  }
  return { clientVersion }
}

/**
 * The identity every failure path converges on.
 *
 * Present so a caller missing its configuration still sends an app-shaped
 * request rather than the CLI shape, which would fetch a different model
 * roster.
 */
export function fallbackChatIdentity(region: WorkBuddyRegion): ChatIdentity {
  return { clientVersion: region === 'global' ? DEFAULT_GLOBAL_APP_VERSION : DEFAULT_CN_APP_VERSION }
}

/**
 * Build the chat User-Agent for one region.
 *
 * @throws Error - either version is unusable; see {@link validVersion}.
 */
export function chatUserAgent(identity: ChatIdentity, region: WorkBuddyRegion): string {
  if (!validVersion(identity.clientVersion)) {
    throw new Error(`chat User-Agent 的版本不可用：${JSON.stringify(identity.clientVersion)}`)
  }
  if (identity.cliVersion !== undefined && !validVersion(identity.cliVersion)) {
    throw new Error(`chat User-Agent 的 CLI 版本不可用：${JSON.stringify(identity.cliVersion)}`)
  }
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`]
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`)
  return parts.join(' ')
}

/**
 * Build the App-shaped User-Agent for catalog requests.
 *
 * The product token has **no space** and no repetition: `WorkBuddyAI/<ver>` is
 * the form measured to reach the App roster; the spaced form is rejected with
 * 400/12403.
 *
 * @throws Error - the version is unusable.
 */
export function appUserAgent(version: string): string {
  if (!validVersion(version)) {
    throw new Error(`catalog User-Agent 的版本不可用：${JSON.stringify(version)}`)
  }
  return `WorkBuddyAI/${version}`
}
