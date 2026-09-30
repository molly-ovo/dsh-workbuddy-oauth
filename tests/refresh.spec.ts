/**
 * Token refresh tests.
 *
 * The refresh endpoint is the most sensitive one the plugin touches: it spends
 * a rotating credential. The rules under test are therefore account-safety
 * rules — de-duplicate concurrent refreshes, never replay a spent token, and
 * do not refresh when nothing needs it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialFromLogin, readCredential, writeCredential, type WorkBuddyCredential } from '../src/credentials.ts'
import { REFRESH_PATH, needsRefresh, refreshCredential } from '../src/refresh.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-refresh-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

/** A stored credential with a controllable expiry. */
function stored(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid: 'uid-1',
    region: 'cn',
    ...overrides,
  }
}

/** A refresh response in the nested envelope the upstream uses. */
function refreshResponse(accessToken = 'new-access', refreshToken = 'new-refresh'): Response {
  return new Response(JSON.stringify({ code: 0, data: { data: { accessToken, refreshToken, expiresIn: 7200 } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('when a refresh is needed', () => {
  it('is false well before expiry', () => {
    expect(needsRefresh(stored(), Date.now())).toBe(false)
  })

  it('is true inside the margin, so a token cannot expire mid-flight', () => {
    const now = 1_700_000_000_000
    expect(needsRefresh(stored({ expiresAtMs: now + 60_000 }), now)).toBe(true)
  })

  it('is true once expired', () => {
    const now = 1_700_000_000_000
    expect(needsRefresh(stored({ expiresAtMs: now - 1 }), now)).toBe(true)
  })

  it('is false when there is no refresh token to spend', () => {
    // Reporting "needed" would make every call attempt and fail; the real fix
    // is signing in again, which the failure path says.
    const now = 1_700_000_000_000
    expect(needsRefresh(stored({ refreshToken: '', expiresAtMs: now - 1 }), now)).toBe(false)
  })
})

describe('refresh request shape', () => {
  it('posts to the refresh endpoint with the rotating token in its header', async () => {
    const fetchImpl = vi.fn(async () => refreshResponse())
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    const outcome = await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.status).toBe('refreshed')

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://copilot.tencent.com${REFRESH_PATH}`)
    const headers = init.headers as Record<string, string>
    expect(headers['X-Refresh-Token']).toBe('old-refresh')
    // The upstream discriminates refresh origin on this header.
    expect(headers['X-Auth-Refresh-Source']).toBe('workbuddy')
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    expect(init.method).toBe('POST')
  })

  it('uses the plugin source and English for the international region', async () => {
    const fetchImpl = vi.fn(async () => refreshResponse())
    await writeCredential(
      stored({ region: 'global', domain: 'www.workbuddy.ai', expiresAtMs: Date.now() - 1 }),
    )

    await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Auth-Refresh-Source']).toBe('plugin')
    expect(headers['Accept-Language']).toBe('en-US')
  })

  it('routes to the region recorded on the credential', async () => {
    const fetchImpl = vi.fn(async () => refreshResponse())
    await writeCredential(
      stored({ region: 'global', domain: 'www.workbuddy.ai', expiresAtMs: Date.now() - 1 }),
    )

    await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url.startsWith('https://www.workbuddy.ai')).toBe(true)
  })
})

describe('refresh persists the rotated credential', () => {
  it('stores the new access token and the rotated refresh token', async () => {
    const fetchImpl = vi.fn(async () => refreshResponse('fresh-access', 'fresh-refresh'))
    await writeCredential(stored({ expiresAtMs: Date.now() - 1, nickname: '保留我' }))

    await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })

    const after = await readCredential(join(home, 'workbuddy-standalone', 'accounts', 'workbuddy-uid-1.json'))
    expect(after?.accessToken).toBe('fresh-access')
    expect(after?.refreshToken).toBe('fresh-refresh')
    // Untouched fields survive, so a refresh never loses account metadata.
    expect(after?.nickname).toBe('保留我')
  })

  it('keeps the existing refresh token when the upstream does not rotate it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { accessToken: 'only-access' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const after = await readCredential(join(home, 'workbuddy-standalone', 'accounts', 'workbuddy-uid-1.json'))
    expect(after?.refreshToken).toBe('old-refresh')
  })
})

describe('concurrent refreshes are de-duplicated', () => {
  it('spends the rotating token exactly once', async () => {
    // Two concurrent refreshes would send a token the first already consumed.
    // Upstream reads that as replay of a used credential — the pattern risk
    // control exists to catch.
    let resolveResponse: ((value: Response) => void) | undefined
    const gate = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const fetchImpl = vi.fn(async () => gate)
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    const first = refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const second = refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })

    resolveResponse?.(refreshResponse())
    const [a, b] = await Promise.all([first, second])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a.status).toBe('refreshed')
    expect(b.status).toBe('refreshed')
  })
})

describe('failure paths', () => {
  it('does not call the upstream when the credential is already fresh', async () => {
    const fetchImpl = vi.fn(async () => refreshResponse())
    await writeCredential(stored())

    const outcome = await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.status).toBe('not-needed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a missing credential rather than throwing', async () => {
    const outcome = await refreshCredential('nobody', { fetchImpl: vi.fn() as unknown as typeof fetch })
    expect(outcome.status).toBe('failed')
  })

  it('reports an envelope with no token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 12153, msg: 'session expired' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    const outcome = await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('session expired')
  })

  it('reports a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    const outcome = await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('502')
  })

  it('reports a transport error without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    const outcome = await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') expect(outcome.reason).toContain('ECONNREFUSED')
  })

  it('leaves the stored credential untouched on failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await writeCredential(stored({ expiresAtMs: Date.now() - 1 }))

    await refreshCredential('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const after = await readCredential(join(home, 'workbuddy-standalone', 'accounts', 'workbuddy-uid-1.json'))
    expect(after?.accessToken).toBe('old-access')
  })
})

describe('credentialFromLogin integration', () => {
  it('produces a credential that a refresh can then update', async () => {
    const credential = credentialFromLogin({
      region: 'cn',
      token: { accessToken: 'a', refreshToken: 'r', expiresIn: 1, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-9', enterpriseId: '', nickname: '' },
    })
    await writeCredential(credential)

    const fetchImpl = vi.fn(async () => refreshResponse('a2', 'r2'))
    const outcome = await refreshCredential('uid-9', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(outcome.status).toBe('refreshed')
    if (outcome.status === 'refreshed') expect(outcome.credential.accessToken).toBe('a2')
  })
})
