/**
 * Credential store tests.
 *
 * The store is the piece that replaces the upstream's desktop-credential
 * reader, so its failure modes are the ones that would quietly produce
 * "signed in" with an unusable token. These cover round-tripping, damaged
 * files, region derivation and the seconds→milliseconds conversion.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialFromLogin,
  credentialPath,
  credentialsDir,
  deleteCredential,
  displayNameOf,
  isExpired,
  listCredentials,
  readCredential,
  writeCredential,
  type WorkBuddyCredential,
} from '../src/credentials.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-cred-'))
  // The store resolves its directory through resolveDshHome(), which honours
  // DSH_HOME — pointing it at a temp dir keeps the suite off the real home.
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

function sample(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid: 'uid-a',
    region: 'cn',
    ...overrides,
  }
}

describe('credential round-trip', () => {
  it('writes and reads back every field', async () => {
    const credential = sample({ enterpriseId: 'ent-1', nickname: '测试号' })
    await writeCredential(credential)

    const loaded = await readCredential(credentialPath('uid-a'))
    expect(loaded).toEqual(credential)
  })

  it('lists accounts in a stable order', async () => {
    await writeCredential(sample({ uid: 'uid-b' }))
    await writeCredential(sample({ uid: 'uid-a' }))

    const listed = await listCredentials()
    expect(listed.map((entry) => entry.uid)).toEqual(['uid-a', 'uid-b'])
  })

  it('returns an empty list before anything is stored', async () => {
    await expect(listCredentials()).resolves.toEqual([])
  })
})

describe('damaged input never masquerades as a valid credential', () => {
  it('treats a missing file as absent', async () => {
    await expect(readCredential(credentialPath('nobody'))).resolves.toBeUndefined()
  })

  it('rejects malformed JSON', async () => {
    const path = credentialPath('uid-a')
    await writeCredential(sample())
    await writeFile(path, '{ not json')

    await expect(readCredential(path)).resolves.toBeUndefined()
    // A damaged account must not hide the healthy ones.
    await expect(listCredentials()).resolves.toEqual([])
  })

  it('rejects a document from another format version', async () => {
    const path = credentialPath('uid-a')
    await writeCredential(sample())
    await writeFile(path, JSON.stringify({ version: 99, credential: sample() }))

    await expect(readCredential(path)).resolves.toBeUndefined()
  })

  it('rejects a document whose token or uid is empty', async () => {
    const path = credentialPath('uid-a')
    await writeCredential(sample())
    await writeFile(
      path,
      JSON.stringify({ version: 1, credential: { ...sample(), accessToken: '' } }),
    )
    await expect(readCredential(path)).resolves.toBeUndefined()
  })
})

describe('region is derived, not trusted', () => {
  it('recomputes the region from the stored domain', async () => {
    // A document claiming 'cn' while the domain says workbuddy.ai must load as
    // 'global': region is a pure function of domain, and a stale stored value
    // would route requests at the wrong service.
    const path = credentialPath('uid-a')
    await writeCredential(sample())
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        credential: { ...sample(), domain: 'www.workbuddy.ai', region: 'cn' },
      }),
    )

    const loaded = await readCredential(path)
    expect(loaded?.region).toBe('global')
  })
})

describe('login conversion', () => {
  it('converts expiresIn seconds to an absolute millisecond deadline', () => {
    const now = 1_700_000_000_000
    const credential = credentialFromLogin(
      {
        region: 'global',
        token: { accessToken: 'at', refreshToken: 'rt', expiresIn: 600, domain: 'workbuddy.ai' },
        account: { uid: 'uid-x', enterpriseId: '', nickname: 'Zed' },
      },
      now,
    )

    expect(credential.expiresAtMs).toBe(now + 600_000)
    expect(credential.region).toBe('global')
    expect(credential.nickname).toBe('Zed')
    // Empty optional fields are omitted rather than stored as ''.
    expect('enterpriseId' in credential).toBe(false)
  })
})

describe('expiry and labels', () => {
  it('honours the refresh margin', () => {
    const credential = sample({ expiresAtMs: 1_000_000 })
    expect(isExpired(credential, 60_000, 950_000)).toBe(true)
    expect(isExpired(credential, 60_000, 900_000)).toBe(false)
  })

  it('prefers the nickname and falls back to a uid prefix', () => {
    expect(displayNameOf(sample({ nickname: '小明' }))).toBe('小明')
    expect(displayNameOf(sample({ uid: 'abcdef123456' }))).toBe('abcdef12')
  })
})

describe('deletion', () => {
  it('removes a stored account and reports the outcome', async () => {
    await writeCredential(sample())
    await expect(deleteCredential('uid-a')).resolves.toBe(true)
    await expect(listCredentials()).resolves.toEqual([])
    await expect(deleteCredential('uid-a')).resolves.toBe(false)
  })

  it('creates the credentials directory on first write', async () => {
    await writeCredential(sample())
    await expect(readCredential(join(credentialsDir(), 'workbuddy-uid-a.json'))).resolves.toBeDefined()
  })
})
