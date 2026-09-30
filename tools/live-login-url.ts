/**
 * End-to-end check of the authorization URL against the live upstream.
 *
 * Drives the plugin's own `LoginClient.begin` (not a re-implementation) and
 * prints the URL a user would be handed, so it can be compared field by field
 * with the desktop app's:
 *   https://www.workbuddy.cn/login/?platform=workbuddy&state=<uuid>
 *     &version=5.5.6&loginSessionId=<uuid>
 *
 * Two intentional differences from the app's URL, both explained in `oauth.ts`:
 * the path has no trailing slash (the upstream issues it that way and both
 * resolve to the same page), and `version` is absent (the page renders
 * identically without it, and nothing here can keep a client version current).
 */

import { LoginClient } from '../src/oauth.ts'

/** Parameters the app's URL carries; `version` is deliberately not required. */
const REQUIRED = ['platform', 'state', 'loginSessionId'] as const

for (const region of ['cn', 'global']) {
  const request = await new LoginClient().begin(region)
  const url = new URL(request.url)
  const missing = REQUIRED.filter(key => !url.searchParams.has(key))
  console.log(`region=${region}`)
  console.log(`  ${request.url}`)
  console.log(`  host            : ${url.host}`)
  console.log(`  path            : ${url.pathname}`)
  console.log(`  platform        : ${url.searchParams.get('platform')}`)
  console.log(`  state           : ${url.searchParams.get('state')}`)
  console.log(`  loginSessionId  : ${url.searchParams.get('loginSessionId')}`)
  console.log(`  version         : ${url.searchParams.get('version') ?? '(omitted on purpose)'}`)
  console.log(`  missing required: ${missing.join(', ') || '(none)'}`)
  console.log('')
}
