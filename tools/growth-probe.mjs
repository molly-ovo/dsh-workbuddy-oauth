/**
 * Measure the CN growth endpoints against the real upstream, read-only.
 *
 * Every call here is a GET, and none of them claims or spends anything: the
 * write-shaped endpoints (accept / claim / depart / redeem / draw / report) are
 * deliberately NOT touched by this probe — those are exercised by the plugin's
 * own commands once implemented, where the user can see each action.
 *
 * Shapes to confirm before writing the client code (L4: never trust the
 * reference's comment over the live body):
 *   GET /v2/activity/growth/tasks          task list + progress + accept_status
 *   GET /activity/growth/streak            streak days + tiers + makeup cards
 *   GET /activity/growth/buddy/travel/status
 *   GET /activity/growth/lottery/summary
 *   daily check-in state (panel's checkin_status test names a daily-checkin
 *   endpoint; confirm the exact path before writing code)
 */

import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ACCOUNTS = join(DSH_HOME, 'workbuddy-standalone', 'accounts')
const CHAT_BASE = 'https://copilot.tencent.com'

function deriveId(purpose, uid) {
  if (uid === '') return undefined
  return createHash('md5').update(`wb2a:${purpose}:${uid}`, 'utf8').digest('hex').slice(0, 32)
}

function headers(credential) {
  const origin = 'https://www.codebuddy.cn'
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.63.2',
    Authorization: `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    ...(credential.domain ? { 'X-Domain': credential.domain } : { 'X-No-Department-Info': '1' }),
    ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.5.6',
    'X-Product': 'SaaS',
    'X-Machine-ID': deriveId('machine', credential.uid),
    'X-Session-ID': deriveId('session', credential.uid),
  }
}

const names = await readdir(ACCOUNTS).catch(() => [])
const creds = []
for (const name of names) {
  if (!name.startsWith('workbuddy-') || !name.endsWith('.json')) continue
  const doc = JSON.parse(await readFile(join(ACCOUNTS, name), 'utf8'))
  if (doc.credential?.region === 'cn') creds.push(doc.credential)
}
if (creds.length === 0) {
  console.log('no CN credential stored')
  process.exit(0)
}
const credential = creds[0]
console.log(`account: ${credential.nickname ?? '(?)'} uid=${credential.uid.slice(0, 8)}\n`)

const probes = [
  ['tasks', `${CHAT_BASE}/v2/activity/growth/tasks`],
  ['streak', `${CHAT_BASE}/activity/growth/streak`],
  ['travel-status', `${CHAT_BASE}/activity/growth/buddy/travel/status`],
  ['lottery-summary', `${CHAT_BASE}/activity/growth/lottery/summary`],
  ['energy', `${CHAT_BASE}/v2/activity/growth/energy`],
  ['meter-resource', `${CHAT_BASE}/v2/billing/meter/get-user-resource`],
]

for (const [label, url] of probes) {
  try {
    const response = await fetch(url, { headers: headers(credential) })
    const text = await response.text()
    let shape = text
    try {
      const parsed = JSON.parse(text)
      const data = parsed.data ?? parsed
      shape = JSON.stringify(data).slice(0, 700)
    } catch { /* keep raw */ }
    console.log(`--- ${label}  HTTP ${response.status}`)
    console.log(`    ${shape}`)
  } catch (error) {
    console.log(`--- ${label}  ERROR ${error}`)
  }
}
