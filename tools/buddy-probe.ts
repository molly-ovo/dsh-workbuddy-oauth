/**
 * Read-only probe: buddy adoption state and the `first_buddy` task.
 *
 * `first_buddy` (+300) is the one task the plugin can complete **without forging
 * anything**: `buddy/agreement` and `buddy/first` are ordinary first-party calls
 * the desktop client makes when the user adopts a cat, not telemetry fabricated
 * on their behalf. This measures what the two real accounts actually report
 * before any code is written (L4), including whether the account already has a
 * buddy — which also explains the measured "no active buddy" travel failure.
 *
 * No writes: it reads `buddy/info` and the task list only.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { GrowthClient } from '../src/growth.ts'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ACCOUNTS = join(DSH_HOME, 'workbuddy-standalone', 'accounts')
const CHAT_BASE = 'https://copilot.tencent.com'

const names = await readdir(ACCOUNTS).catch(() => [])
const credentials = []
for (const name of names) {
  if (!name.startsWith('workbuddy-') || !name.endsWith('.json')) continue
  const document = JSON.parse(await readFile(join(ACCOUNTS, name), 'utf8'))
  if (document.credential?.region === 'cn') credentials.push(document.credential)
}

const client = new GrowthClient()
for (const credential of credentials) {
  console.log(`=== ${credential.nickname ?? '?'} (uid=${credential.uid.slice(0, 8)}) ===`)

  const info = await client.buddyInfo(credential)
  console.log(`  buddy/info     : HTTP ${info.status} code=${info.code} msg=${JSON.stringify(info.msg)}`)
  console.log(`    parsed       : ${info.data === undefined ? '(无猫)' : JSON.stringify(info.data)}`)

  // Raw body too: the parse is an assumption, and an account that travelled
  // reporting "no buddy" is exactly the signal that it may be wrong.
  const raw = await fetch(`${CHAT_BASE}/activity/growth/buddy/info`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${credential.accessToken}`,
      'X-User-Id': credential.uid,
      'X-Domain': credential.domain,
    },
  })
  console.log(`    RAW          : ${(await raw.text()).slice(0, 400)}`)

  const tasks = await client.tasks(credential)
  const adoption = tasks.data?.find(task => task.code === 'first_buddy')
  console.log(`  first_buddy    : ${adoption === undefined ? '(未下发)' : JSON.stringify(adoption)}`)
  console.log(`  create_canvas  : ${JSON.stringify(tasks.data?.find(t => t.code === 'create_canvas') ?? null)}`)
  console.log('')
}
