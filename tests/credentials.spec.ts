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
  maskEmailAddresses,
  maskPhoneNumbers,
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

describe('phone masking', () => {
  it('redacts an account named after its own phone number', () => {
    // The whole reason this exists: the nickname is printed by every command,
    // the settings card and the status document, so an account named with a
    // mobile number would be published verbatim.
    expect(maskPhoneNumbers('13800138000')).toBe('13*******00')
  })

  it('leaves only two digits on each side, hiding seven of eleven', () => {
    // Three-and-three left the carrier prefix and only five hidden digits; the
    // fourth digit belongs to the subscriber's own segment.
    expect(maskPhoneNumbers('13800138000')).toHaveLength(11)
    expect(maskPhoneNumbers('13800138000').replace(/\*/g, '')).toBe('1300')
  })

  it('masks a number embedded in a longer name', () => {
    expect(maskPhoneNumbers('张三 13800138000')).toBe('张三 13*******00')
    expect(maskPhoneNumbers('13800138000(工作)')).toBe('13*******00(工作)')
  })

  it('keeps a typed country-code prefix, masking only the number', () => {
    expect(maskPhoneNumbers('+8613800138000')).toBe('+8613*******00')
    expect(maskPhoneNumbers('86-13800138000')).toBe('86-13*******00')
  })

  it('leaves names without a mobile number alone', () => {
    for (const name of ['小明', '爱在', '', 'user-42', '1380013800', '138001380001']) {
      expect(maskPhoneNumbers(name)).toBe(name)
    }
  })

  it('does not mask digits that merely contain a phone-shaped run', () => {
    // A longer digit run is an id, not a number: masking its middle would
    // corrupt it while protecting nothing.
    expect(maskPhoneNumbers('113800138000')).toBe('113800138000')
    expect(maskPhoneNumbers('9138001380001')).toBe('9138001380001')
  })

  it('masks every number when a name carries more than one', () => {
    expect(maskPhoneNumbers('13800138000 / 13900139000')).toBe('13*******00 / 13*******00')
  })

  it('applies through displayNameOf, so every surface is covered', () => {
    expect(displayNameOf(sample({ nickname: '13800138000' }))).toBe('13*******00')
  })
})

describe('email masking', () => {
  it('redacts the local part of an address used as a nickname', () => {
    // Accounts are often named after the address they signed up with, and the
    // local part is the identifying half — the domain names only a provider.
    expect(maskEmailAddresses('alice@example.com')).toBe('a****@example.com')
  })

  it('masks an address embedded in a longer name', () => {
    expect(maskEmailAddresses('张三 <zhangsan@example.com>')).toBe('张三 <z*******@example.com>')
  })

  it('keeps a single-character local part readable without padding it', () => {
    // The floor of three stars keeps `a@x.com` from rendering as `a@x.com`,
    // which would look unmasked.
    expect(maskEmailAddresses('a@example.com')).toBe('a***@example.com')
  })

  it('leaves a bare user@host alone', () => {
    // Without a dot in the domain this is an internal id, not an address;
    // masking it would corrupt a display name while protecting nothing.
    for (const name of ['user@localhost', 'user@host', '@example.com', 'user@']) {
      expect(maskEmailAddresses(name)).toBe(name)
    }
  })

  it('masks every address when a name carries more than one', () => {
    expect(maskEmailAddresses('a@x.com / b@y.org')).toBe('a***@x.com / b***@y.org')
  })

  it('does not start a match mid-token', () => {
    expect(maskEmailAddresses('xxb@y.com')).toBe('x***@y.com')
  })

  it('applies through displayNameOf alongside phone masking', () => {
    expect(displayNameOf(sample({ nickname: 'alice@example.com' }))).toBe('a****@example.com')
    // Both identifier types are redacted by the one entry point.
    expect(displayNameOf(sample({ nickname: '张三 13800138000 z@example.com' })))
      .toBe('张三 13*******00 z***@example.com')
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
