/**
 * Measure what an exhausted account actually returns.
 *
 * The cooldown length must key on the real response, not on the marker list:
 * if exhaustion arrives as, say, `code 6004` (model-level rate limit) rather
 * than a 402, then cooling `hard_credit` would leave the real case untouched.
 *
 * Sends one minimal chat request per named account through the same headers the
 * plugin uses, and prints the raw status and body. Reads credentials by uid
 * prefix from the first argument list.
 */

import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ACCOUNTS = join(DSH_HOME, 'workbuddy-standalone', 'accounts')
const PREFIXES = process.argv.slice(2)

/** Derive a device id the way src/fingerprint.ts does. */
function deriveId(purpose, uid) {
  if (uid === '') return undefined
  return createHash('md5').update(`wb2a:${purpose}:${uid}`, 'utf8').digest('hex').slice(0, 32)
}

async function loadAll() {
  const names = await readdir(ACCOUNTS)
  const out = []
  for (const name of names) {
    if (!name.startsWith('workbuddy-') || !name.endsWith('.json')) continue
    const document = JSON.parse(await readFile(join(ACCOUNTS, name), 'utf8'))
    out.push(document.credential)
  }
  return out
}

const credentials = await loadAll()
const targets = PREFIXES.length === 0
  ? credentials
  : credentials.filter(c => PREFIXES.some(p => c.uid.startsWith(p)))

if (targets.length === 0) {
  console.log(`no credential matched; stored uids: ${credentials.map(c => c.uid.slice(0, 8)).join(', ')}`)
  process.exit(0)
}

for (const credential of targets) {
  const base = credential.region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
  const origin = credential.region === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  const version = credential.region === 'global' ? '5.5.2' : '5.5.6'
  const product = credential.region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'

  console.log(`\n=== ${credential.uid.slice(0, 8)}  ${credential.nickname ?? '(no nickname)'}  [${credential.region}] ===`)

  const response = await fetch(`${base}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: origin,
      Referer: `${origin}/`,
      'User-Agent': `${product}/${version} ${product}/${version}`,
      Authorization: `Bearer ${credential.accessToken}`,
      'X-User-Id': credential.uid,
      ...(credential.domain !== '' ? { 'X-Domain': credential.domain } : {}),
      ...(credential.enterpriseId !== undefined && credential.enterpriseId !== ''
        ? { 'X-Enterprise-Id': credential.enterpriseId }
        : { 'X-No-Enterprise-Id': '1' }),
      'X-Machine-ID': deriveId('machine', credential.uid),
      'X-Session-ID': deriveId('session', credential.uid),
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
    }),
  })

  console.log(`HTTP ${response.status}`)
  const text = await response.text()
  console.log(`body: ${text.slice(0, 600).replace(/\s+/g, ' ')}`)
}
