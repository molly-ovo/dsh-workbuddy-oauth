/**
 * Account-removal tests.
 *
 * The question these answer is the one a user asks before signing out: *does
 * removing the account actually remove what was collected about it?* Deleting
 * the credential file alone left the uid behind in three other stores, so these
 * assert on every uid-keyed file rather than on the credential alone.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { purgeAccount } from '../src/account-purge.ts'
import { disabledUids, forgetAccount, setAccountDisabled } from '../src/account-state.ts'
import { clearCooldown, readCooldowns, writeCooldown } from '../src/cooldown-state.ts'
import { credentialPath, listCredentials, writeCredential, type WorkBuddyCredential } from '../src/credentials.ts'
import { LEGACY_TASK_STATE_FILENAME } from '../src/legacy-task-state.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-purge-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

function sample(uid: string, overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: `at-${uid}`,
    refreshToken: `rt-${uid}`,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid,
    region: 'cn',
    ...overrides,
  }
}

describe('purgeAccount', () => {
  it('removes the credential, the cooldown and the enable state together', async () => {
    await writeCredential(sample('uid-a'))
    await writeCooldown('uid-a', Date.now() + 60_000)
    await setAccountDisabled('uid-a', true)

    const result = await purgeAccount('uid-a')

    expect(result).toEqual({
      credentialRemoved: true,
      cooldownCleared: true,
      enableStateForgotten: true,
      probeStoresPurged: 0,
      legacyTaskStateRemoved: false,
    })
    await expect(listCredentials()).resolves.toEqual([])
    expect((await readCooldowns()).has('uid-a')).toBe(false)
    expect((await disabledUids()).has('uid-a')).toBe(false)
  })

  it('erases the uid from every state file on disk, not just the credential', async () => {
    // The regression this guards: the credential file disappeared while
    // `cooldowns.json` and `disabled-accounts.json` kept naming the account.
    await writeCredential(sample('uid-a'))
    await writeCooldown('uid-a', Date.now() + 60_000)
    await setAccountDisabled('uid-a', true)

    await purgeAccount('uid-a')

    for (const name of ['cooldowns.json', 'disabled-accounts.json']) {
      const text = await readFile(join(home, 'workbuddy-standalone', name), 'utf8')
      expect(text).not.toContain('uid-a')
    }
  })

  it('leaves other accounts untouched', async () => {
    await writeCredential(sample('uid-a'))
    await writeCredential(sample('uid-b'))
    await writeCooldown('uid-b', Date.now() + 60_000)
    await setAccountDisabled('uid-b', true)

    await purgeAccount('uid-a')

    const remaining = await listCredentials()
    expect(remaining.map((credential) => credential.uid)).toEqual(['uid-b'])
    expect((await readCooldowns()).has('uid-b')).toBe(true)
    expect((await disabledUids()).has('uid-b')).toBe(true)
  })

  it('reports what it could not find rather than failing', async () => {
    // Removing an account that is already gone is a no-op, not an error: the
    // card and the command both reach here after a partial earlier removal.
    const result = await purgeAccount('nobody')
    expect(result.credentialRemoved).toBe(false)
    expect(result.cooldownCleared).toBe(false)
    expect(result.enableStateForgotten).toBe(false)
  })

  it('offers the account key to the probe stores and counts what they dropped', async () => {
    await writeCredential(sample('uid-a', { enterpriseId: 'ent-1' }))
    const seen: string[] = []

    const result = await purgeAccount('uid-a', {
      accountKey: 'uid-a:ent-1',
      forgetProbeRecords: (key) => {
        seen.push(key)
        return 1
      },
    })

    expect(seen).toEqual(['uid-a:ent-1'])
    expect(result.probeStoresPurged).toBe(1)
  })

  it('does not consult the probe stores when the account key is unknown', async () => {
    // A uid-less credential yields no key; calling through with an empty string
    // would let every such account share one probe bucket.
    let called = false
    await purgeAccount('uid-a', {
      accountKey: '',
      forgetProbeRecords: () => {
        called = true
        return 1
      },
    })
    expect(called).toBe(false)
  })

  it('removes the credential file from disk', async () => {
    await writeCredential(sample('uid-a'))
    await purgeAccount('uid-a')
    await expect(readFile(credentialPath('uid-a'), 'utf8')).rejects.toThrow()
  })

  it('deletes the state file left by the removed task-automation feature', async () => {
    // That file is keyed by uid and has no writer any more, so without this it
    // outlives every account it names — the leak this suite is about, on a file
    // no current source file mentions.
    const legacy = join(home, 'workbuddy-standalone', LEGACY_TASK_STATE_FILENAME)
    await mkdir(join(home, 'workbuddy-standalone'), { recursive: true })
    await writeFile(legacy, JSON.stringify({
      version: 1,
      accounts: { 'uid-a': { lastSuccessDate: '2026-09-30' } },
    }), 'utf8')
    await writeCredential(sample('uid-a'))

    const result = await purgeAccount('uid-a')

    expect(result.legacyTaskStateRemoved).toBe(true)
    await expect(readFile(legacy, 'utf8')).rejects.toThrow()
  })

  it('reports a missing legacy file rather than failing', async () => {
    // Every install that never ran the removed feature has no such file, and a
    // sign-out there must be a no-op, not an error.
    await writeCredential(sample('uid-a'))
    const result = await purgeAccount('uid-a')
    expect(result.legacyTaskStateRemoved).toBe(false)
  })
})

describe('per-account state helpers', () => {
  it('clearCooldown removes one entry and reports whether it existed', async () => {
    await writeCooldown('uid-a', Date.now() + 60_000)
    await writeCooldown('uid-b', Date.now() + 60_000)

    await expect(clearCooldown('uid-a')).resolves.toBe(true)
    await expect(clearCooldown('uid-a')).resolves.toBe(false)

    const remaining = await readCooldowns()
    expect(remaining.has('uid-a')).toBe(false)
    expect(remaining.has('uid-b')).toBe(true)
  })

  it('forgetAccount removes one uid and reports whether it existed', async () => {
    await setAccountDisabled('uid-a', true)
    await setAccountDisabled('uid-b', true)

    await expect(forgetAccount('uid-a')).resolves.toBe(true)
    await expect(forgetAccount('uid-a')).resolves.toBe(false)

    const disabled = await disabledUids()
    expect(disabled.has('uid-a')).toBe(false)
    expect(disabled.has('uid-b')).toBe(true)
  })

  it('keeps an enabled account out of the disabled set', async () => {
    // `forgetAccount` must not be the only way to leave the set: enabling is a
    // separate, reversible operation and has to keep working.
    await setAccountDisabled('uid-a', true)
    await setAccountDisabled('uid-a', false)
    expect((await disabledUids()).has('uid-a')).toBe(false)
  })
})
