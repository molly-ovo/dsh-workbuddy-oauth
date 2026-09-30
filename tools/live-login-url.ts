/**
 * End-to-end check of the fixed authorization URL against the live upstream.
 *
 * Drives the plugin's own `LoginClient.begin` (not a re-implementation) and
 * prints the URL a user would be handed, so it can be compared field by field
 * with the desktop app's:
 *   https://www.workbuddy.cn/login/?platform=workbuddy&state=<uuid>
 *     &version=5.5.6&loginSessionId=<uuid>
 */

import { LoginClient } from '../src/oauth.ts'

for (const region of ['cn', 'global']) {
  const request = await new LoginClient().begin(region)
  const url = new URL(request.url)
  console.log(`region=${region}`)
  console.log(`  ${request.url}`)
  console.log(`  host            : ${url.host}`)
  console.log(`  path            : ${url.pathname}`)
  console.log(`  platform        : ${url.searchParams.get('platform')}`)
  console.log(`  state           : ${url.searchParams.get('state')}`)
  console.log(`  version         : ${url.searchParams.get('version')}`)
  console.log(`  loginSessionId  : ${url.searchParams.get('loginSessionId')}`)
  console.log(`  missing vs app  : ${['platform', 'state', 'version', 'loginSessionId'].filter(k => !url.searchParams.has(k)).join(', ') || '(none)'}`)
  console.log('')
}
