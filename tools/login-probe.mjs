/**
 * One-off probe of the OAuth token endpoint's "not yet authorized" shape.
 *
 * Reproduces `LoginClient.begin` → `LoginClient.poll` exactly, but prints the
 * raw HTTP status and body instead of mapping it to an error class. This is the
 * evidence needed to decide whether `code=11217 msg=login ing` arrives as HTTP
 * 200 (business code) or 4xx (HTTP status), because `oauth.ts` maps only the
 * 4xx branch to `LoginPendingError`.
 */

const REGION = 'cn'
const BASE = 'https://copilot.tencent.com'
const ORIGIN = 'https://www.codebuddy.cn'

function loginHeaders(origin, token) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6',
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  }
}

// Step 1: begin — ask for a state + auth URL.
const begin = await fetch(`${BASE}/v2/plugin/auth/state?platform=CLI`, {
  method: 'POST',
  headers: loginHeaders(ORIGIN),
  body: '{}',
})
const beginText = await begin.text()
console.log(`begin: HTTP ${begin.status}`)
console.log(`begin body: ${beginText.slice(0, 400)}`)

const beginData = JSON.parse(beginText)
const state = beginData?.data?.state ?? beginData?.state
const authUrl = beginData?.data?.authUrl ?? beginData?.authUrl
console.log(`state: ${state}`)
console.log(`authUrl: ${authUrl}`)

// Step 2: poll immediately — the user has NOT authorized, so this is the exact
// "login ing" window.
const poll = await fetch(`${BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
  method: 'GET',
  headers: loginHeaders(ORIGIN),
})
const pollText = await poll.text()
console.log(`\npoll: HTTP ${poll.status}`)
console.log(`poll body: ${pollText.slice(0, 800)}`)
