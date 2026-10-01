/**
 * One-off live probe: send a real chat request through the same code path the
 * plugin uses, and report whether the upstream answers.
 *
 * This exists because the plugin's own tests deliberately never touch the
 * network, so nothing in the suite proves the wire format still works with a
 * real account. Run it only when a credential is already stored.
 *
 * It prints the outcome, never the token.
 */

import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Read the stored credential, tolerating the on-disk shape. */
async function loadCredential() {
  const dir = join(DSH_HOME, 'workbuddy-oauth', 'accounts')
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(dir)
  const file = names.find((name) => name.startsWith('workbuddy-') && name.endsWith('.json'))
  if (file === undefined) throw new Error(`no credential in ${dir}`)
  const document = JSON.parse(await readFile(join(dir, file), 'utf8'))
  return document.credential
}

/** Derive a device id the way src/fingerprint.ts does. */
function deriveId(purpose, uid) {
  if (uid === '') return undefined
  return createHash('md5').update(`wb2a:${purpose}:${uid}`, 'utf8').digest('hex').slice(0, 32)
}

const credential = await loadCredential()
console.log(`account   : ${credential.nickname ?? '(no nickname)'} / ${credential.region}`)
console.log(`domain    : ${credential.domain}`)
console.log(`expires   : ${new Date(credential.expiresAtMs).toISOString()}`)
console.log(`expired?  : ${credential.expiresAtMs <= Date.now()}`)

const region = credential.region
const chatBase = region === 'global' ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com'
const origin = region === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'

const appVersion = region === 'global' ? '5.5.2' : '5.5.6'
const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
const userAgent = `WorkBuddy/${appVersion} ${product}/${appVersion}`

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: origin,
  Referer: `${origin}/`,
  'User-Agent': userAgent,
  Authorization: `Bearer ${credential.accessToken}`,
  'X-User-Id': credential.uid,
  ...(credential.domain !== '' ? { 'X-Domain': credential.domain } : {}),
  ...(credential.enterpriseId !== undefined && credential.enterpriseId !== ''
    ? { 'X-Enterprise-Id': credential.enterpriseId }
    : { 'X-No-Enterprise-Id': '1' }),
  'X-Machine-ID': deriveId('machine', credential.uid),
  'X-Session-ID': deriveId('session', credential.uid),
}

const body = {
  model: process.argv[2] ?? 'deepseek-v4.1-flash',
  stream: true,
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 16,
}

console.log(`\nPOST ${chatBase}/v2/chat/completions`)
console.log(`model : ${body.model}`)
console.log('--- response ---')

let response
try {
  response = await fetch(`${chatBase}/v2/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
} catch (error) {
  console.log(`TRANSPORT FAILED: ${error}`)
  process.exitCode = 1
  process.exit()
}

console.log(`HTTP ${response.status}`)
if (!response.ok) {
  const text = await response.text()
  console.log(`body: ${text.slice(0, 800)}`)
  process.exitCode = 1
} else {
  // Read a few SSE frames and show whether any content arrived.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let frames = 0
  let text = ''
  let sawDone = false
  while (frames < 12) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { sawDone = true; continue }
      frames += 1
      try {
        const parsed = JSON.parse(payload)
        const delta = parsed.choices?.[0]?.delta
        if (typeof delta?.content === 'string') text += delta.content
        if (typeof parsed.error === 'object' && parsed.error !== null) {
          console.log(`upstream error frame: ${JSON.stringify(parsed.error).slice(0, 300)}`)
        }
      } catch { /* non-JSON frame */ }
    }
    if (sawDone) break
  }
  await reader.cancel().catch(() => {})
  console.log(`frames received : ${frames}`)
  console.log(`[DONE] seen     : ${sawDone}`)
  console.log(`content         : ${JSON.stringify(text.slice(0, 200))}`)
  console.log(frames > 0 ? '\nRESULT: OK — upstream streamed a response' : '\nRESULT: no content frames')
}
