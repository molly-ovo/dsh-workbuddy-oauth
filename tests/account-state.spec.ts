/**
 * Account enable/disable state tests.
 *
 * The state file is separate from the credential files, so what matters here is
 * the toggle semantics (idempotent, persistent, absent-reads-as-empty) and that
 * a damaged file degrades to "all enabled" rather than "all disabled" — the
 * safer direction, since a bogus read must never lock the user out of every
 * account.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disabledUids, setAccountDisabled, DISABLED_ACCOUNTS_FILENAME } from '../src/account-state.ts'
import { stateFilePath } from '../src/credentials.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-acct-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('account disabled state', () => {
  it('reads as empty before anything is disabled', async () => {
    expect([...(await disabledUids())]).toEqual([])
  })

  it('persists a disable across reads', async () => {
    await setAccountDisabled('uid-1', true)
    expect(await disabledUids()).toEqual(new Set(['uid-1']))
  })

  it('is idempotent in both directions', async () => {
    await setAccountDisabled('uid-1', true)
    await setAccountDisabled('uid-1', true)
    expect([...(await disabledUids())]).toEqual(['uid-1'])

    await setAccountDisabled('uid-1', false)
    await setAccountDisabled('uid-1', false)
    expect([...(await disabledUids())]).toEqual([])
  })

  it('keeps several disabled accounts sorted and intact', async () => {
    await setAccountDisabled('uid-b', true)
    await setAccountDisabled('uid-a', true)
    expect([...(await disabledUids())]).toEqual(['uid-a', 'uid-b'])
  })

  it('reads a damaged state file as empty, not as "everything disabled"', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(stateFilePath('.'), { recursive: true })
    await writeFile(stateFilePath(DISABLED_ACCOUNTS_FILENAME), '{not json', 'utf8')
    expect([...(await disabledUids())]).toEqual([])
  })
})
