/**
 * Measure the CN daily check-in endpoint, read-only first.
 *
 * The growth probe's `/v2/billing/meter/get-user-resource` answered 404 on the
 * copilot host, and the references disagree about the host (hub sends it to
 * `www.codebuddy.cn` with billing headers; panel comments a meter path on the
 * chat base). The check-in itself is a non-idempotent POST, so this probe only
 * measures the **status** side: the resource query that hub's
 * `fetch_credits()` also uses, on both hosts, GET and POST-shaped. A 200 on one
 * of them tells us the host and the path family before any write-shaped call.
 *
 * No check-in POST is sent from here: claiming the daily bonus twice is
 * upstream's business to reject, but a probe has no reason to spend the day's
 * check-in at all — the plugin's command will, once, visibly.
 */

import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ACCOUNTS = join(DSH_HOME, 'workbuddy-standalone', 'accounts')

function deriveId(purpose, uid) {
  if (uid === '') return undefined
  return createHash('md5').update(`wb2a:${purpose}:${uid}`, 'utf8').digest('hex').slice(0, 32)
}

/** Billing-shaped headers (hub's `headers("billing")`), parameterised by host. */
function billingHeaders(credential, origin) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'WorkBuddy/5.5.6',
    Origin: origin,
    Referer: `${origin}/`,
    Authorization: `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.uid,
    'X-Domain': credential.domain || 'copilot.tencent.com',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN',
    'X-Machine-ID': deriveId('machine', credential.uid),
    'X-Session-ID': deriveId('session', credential.uid),
    'X-Product': 'SaaS',
    ...(credential.enterpriseId
      ? { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }
      : { 'X-No-Enterprise-Id': '1' }),
  }
}

const names = await readdir(ACCOUNTS).catch(() => [])
let credential
for (const name of names) {
  if (!name.startsWith('workbuddy-') || !name.endsWith('.json')) continue
  const doc = JSON.parse(await readFile(join(ACCOUNTS, name), 'utf8'))
  if (doc.credential?.region === 'cn') { credential = doc.credential; break }
}
if (credential === undefined) {
  console.log('no CN credential stored')
  process.exit(0)
}
console.log(`account: ${credential.nickname ?? '?'} uid=${credential.uid.slice(0, 8)}\n`)

const BODY = JSON.stringify({
  PageNumber: 1,
  PageSize: 5,
  ProductCode: 'p_tcaca',
  Status: [0, 3],
  PackageEndTimeRangeBegin: new Date().toISOString().slice(0, 19).replace('T', ' '),
  PackageEndTimeRangeEnd: '2036-01-01 00:00:00',
})

const probes = [
  ['billing  POST get-user-resource', 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource', 'POST', BODY],
  ['copilot  POST get-user-resource', 'https://copilot.tencent.com/v2/billing/meter/get-user-resource', 'POST', BODY],
  ['billing  POST daily-checkin-status', 'https://www.codebuddy.cn/v2/billing/meter/daily-checkin', 'GET', undefined],
  ['billing  POST checkin (READ-ONLY substitute: none)', undefined, undefined, undefined],
]

for (const [label, url, method, body] of probes) {
  if (url === undefined) { console.log(`--- ${label}: skipped (never POST checkin from a probe)\n`); continue }
  try {
    const response = await fetch(url, {
      method,
      headers: billingHeaders(credential, new URL(url).origin),
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    console.log(`--- ${label}  HTTP ${response.status}`)
    console.log(`    ${text.slice(0, 400).replace(/\s+/g, ' ')}\n`)
  } catch (error) {
    console.log(`--- ${label}  ERROR ${error}\n`)
  }
}
