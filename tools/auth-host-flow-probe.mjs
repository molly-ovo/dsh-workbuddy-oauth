/**
 * Verify the CN sign-in flow end-to-end on the official host, `www.workbuddy.cn`.
 *
 * Asking `www.workbuddy.cn` for a state yields the exact URL shape the desktop
 * app opens (`.../login/?platform=workbuddy&state=...`). Before switching the
 * plugin's CN login host to it, confirm the two follow-up endpoints also answer
 * there for a state this host issued — the token poll and the account read. A
 * `state` is host-scoped, so issuing on one host and polling another would fail.
 *
 * Nothing here completes a login (no user authorizes); it only proves the
 * endpoints exist and the pending answer is the expected one.
 */

const BASE = 'https://www.workbuddy.cn'
const UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

const headers = (token) => ({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': UA,
  Origin: BASE,
  Referer: `${BASE}/`,
  ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
})

// 1. Issue a state.
const stateResponse = await fetch(`${BASE}/v2/plugin/auth/state?platform=workbuddy`, {
  method: 'POST', headers: headers(), body: '{}',
})
const stateText = await stateResponse.text()
console.log(`state endpoint: HTTP ${stateResponse.status}`)
console.log(`  ${stateText.slice(0, 300)}`)

let state
try { state = JSON.parse(stateText)?.data?.state } catch { /* reported above */ }
if (state === undefined) {
  console.log('no state issued; stopping')
  process.exit(0)
}
console.log(`\nissued state: ${state}`)

// 2. Poll the token endpoint for that state (the user has not authorized yet, so
//    the expected answer is a business-level "login ing").
const pollResponse = await fetch(`${BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
  method: 'GET', headers: headers(),
})
console.log(`\ntoken endpoint: HTTP ${pollResponse.status}`)
console.log(`  ${(await pollResponse.text()).slice(0, 300)}`)

// 3. The account endpoint, which the flow reads once a token exists.
const accountResponse = await fetch(`${BASE}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
  method: 'GET', headers: headers('probe-token'),
})
console.log(`\naccount endpoint: HTTP ${accountResponse.status}`)
console.log(`  ${(await accountResponse.text()).slice(0, 300)}`)
