/**
 * OAuth device-code flow tests.
 *
 * These run against a stubbed `fetch`, so they pin the protocol shape the
 * upstream expects (endpoint paths, the `{code,msg,data}` envelope, the
 * seconds-based `expiresIn`) without touching the network or a real account.
 *
 * Beyond the happy path, this file pins the account-safety rules, because
 * those are the ones whose absence gets accounts flagged rather than merely
 * producing a confusing error:
 *
 * - a not-yet-authorized user is `pending`, never a hard failure;
 * - polls for one state are rate limited before they reach the upstream;
 * - a state expires, and cannot be redeemed at another region's host.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  LOGIN_TTL_MS,
  LoginClient,
  LoginExpiredError,
  LoginPendingError,
  loginHeaders,
  parseRegionInput,
} from '../src/oauth.ts'

/** Build a `Response`-alike from an envelope. */
function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch stub that answers each URL by matching a substring. */
function stubFetch(routes: readonly { match: string; reply: () => Response }[]) {
  return vi.fn(async (url: string) => {
    for (const route of routes) {
      if (url.includes(route.match)) return route.reply()
    }
    throw new Error(`unstubbed url: ${url}`)
  })
}

/** Routes that carry a sign-in all the way through. */
const happyRoutes = [
  { match: '/auth/state', reply: () => envelope({ code: 0, data: { state: 'st-1', authUrl: 'https://auth.example/1' } }) },
  {
    match: '/auth/token',
    reply: () => envelope({ code: 0, data: { accessToken: 'at', refreshToken: 'rt', expiresIn: 7200, domain: 'workbuddy.ai' } }),
  },
  { match: '/login/account', reply: () => envelope({ code: 0, data: { uid: 'uid-1', enterpriseId: 'ent', nickname: '号一' } }) },
] as const

/** A controllable clock, so TTL and cadence are testable without sleeping. */
function clock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('sign-in headers', () => {
  it('sends the user agent the login endpoints expect', () => {
    const headers = loginHeaders('https://www.codebuddy.cn')
    expect(headers['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
    expect(headers['Referer']).toBe('https://www.codebuddy.cn/')
  })

  it('adds an Authorization header only when a token is supplied', () => {
    expect('Authorization' in loginHeaders('https://x', 'tok')).toBe(true)
    expect('Authorization' in loginHeaders('https://x')).toBe(false)
    expect('Authorization' in loginHeaders('https://x', '')).toBe(false)
  })

  it('never sends device fingerprint headers during sign-in', () => {
    // No reference implementation sends X-Machine-ID / X-Session-ID on the
    // OAuth calls; they are for chat and billing only. Pinning it here stops a
    // future refactor from quietly attaching a device identity to sign-in.
    const headers = loginHeaders('https://www.codebuddy.cn', 'tok')
    expect('X-Machine-ID' in headers).toBe(false)
    expect('X-Session-ID' in headers).toBe(false)
  })
})

describe('begin', () => {
  it('returns the state and authorization URL', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const client = new LoginClient({ fetchImpl })

    await expect(client.begin('cn')).resolves.toEqual({
      region: 'cn',
      state: 'st-1',
      url: 'https://auth.example/1',
    })
    // CN's API host and web origin are different domains by design.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI',
    )
  })

  it('refuses a response missing the state', async () => {
    const fetchImpl = stubFetch([
      { match: '/auth/state', reply: () => envelope({ code: 0, data: { authUrl: 'https://a' } }) },
    ])
    await expect(new LoginClient({ fetchImpl }).begin('cn')).rejects.toThrow(/state/)
  })

  it('targets the international host for the global region', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    await new LoginClient({ fetchImpl }).begin('global')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://www.workbuddy.ai/v2/plugin/auth/state?platform=CLI')
  })
})

describe('poll', () => {
  it('reports a not-yet-authorized user as pending, not as a failure', async () => {
    // The shape the upstream actually returns while the user is still in the
    // browser: a 4xx with a non-zero envelope code.
    const fetchImpl = stubFetch([
      ...happyRoutes.slice(0, 1),
      { match: '/auth/token', reply: () => envelope({ code: 11217, msg: 'login ing...' }, 400) },
    ])
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')

    await expect(client.poll(state)).rejects.toBeInstanceOf(LoginPendingError)
  })

  it('reports a pending state when the token field is merely absent', async () => {
    const fetchImpl = stubFetch([
      ...happyRoutes.slice(0, 1),
      { match: '/auth/token', reply: () => envelope({ code: 0, data: { refreshToken: 'rt' } }) },
    ])
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')

    await expect(client.poll(state)).rejects.toBeInstanceOf(LoginPendingError)
  })

  it('maps the token bundle and keeps expiresIn in seconds', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('global')

    await expect(client.poll(state)).resolves.toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 7200,
      domain: 'workbuddy.ai',
    })
  })

  it('percent-encodes the state in the query', async () => {
    const fetchImpl = stubFetch([
      { match: '/auth/state', reply: () => envelope({ code: 0, data: { state: 'a b&c', authUrl: 'https://a' } }) },
      { match: '/auth/token', reply: () => envelope({ code: 0, data: { accessToken: 'a' } }) },
    ])
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')
    await client.poll(state)
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('state=a%20b%26c')
  })

  it('surfaces a non-JSON body as an error naming the status', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/auth/state')
        ? envelope({ code: 0, data: { state: 'st', authUrl: 'https://a' } })
        : new Response('<html>502</html>', { status: 502 }),
    )
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')

    await expect(client.poll(state)).rejects.toThrow(/HTTP 502/)
  })
})

describe('anti-abuse rules on the sign-in flow', () => {
  it('rate limits a rapid second poll before it reaches the upstream', async () => {
    // An impatient double invocation must not become a burst on the endpoint
    // that risk control watches hardest.
    const fetchImpl = stubFetch(happyRoutes)
    const time = clock()
    const client = new LoginClient({ fetchImpl, now: time.now, minPollIntervalMs: 3_000 })
    const { state } = await client.begin('cn')

    await client.poll(state)
    const callsAfterFirst = fetchImpl.mock.calls.length

    time.advance(500)
    await expect(client.poll(state)).rejects.toBeInstanceOf(LoginPendingError)
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst)

    // Past the floor, the poll reaches the upstream again.
    time.advance(3_000)
    await expect(client.poll(state)).resolves.toBeDefined()
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('does not rate limit the very first poll', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const time = clock()
    const client = new LoginClient({ fetchImpl, now: time.now, minPollIntervalMs: 3_000 })
    const { state } = await client.begin('cn')

    await expect(client.poll(state)).resolves.toBeDefined()
  })

  it('expires a state past its lifetime', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const time = clock()
    const client = new LoginClient({ fetchImpl, now: time.now, minPollIntervalMs: 0 })
    const { state } = await client.begin('cn')

    time.advance(LOGIN_TTL_MS + 1)
    await expect(client.poll(state)).rejects.toBeInstanceOf(LoginExpiredError)
  })

  it('refuses an unknown state rather than polling the upstream', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const client = new LoginClient({ fetchImpl })

    await expect(client.poll('never-issued')).rejects.toBeInstanceOf(LoginExpiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses the region recorded at begin, not one supplied later', async () => {
    // A state issued by one region must never be redeemed at the other's host:
    // upstream would see a token for one service presented to another. The
    // poll signature takes no region at all, which is the enforcement.
    const fetchImpl = stubFetch([
      { match: '/auth/state', reply: () => envelope({ code: 0, data: { state: 'st-cn', authUrl: 'https://a' } }) },
      { match: '/auth/token', reply: () => envelope({ code: 0, data: { accessToken: 'at', domain: 'copilot.tencent.com' } }) },
    ])
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')
    await client.poll(state)

    const pollUrl = fetchImpl.mock.calls[1]?.[0] ?? ''
    expect(pollUrl.startsWith('https://copilot.tencent.com')).toBe(true)
    expect(pollUrl).not.toContain('workbuddy.ai')
  })

  it('retires a state after a successful sign-in', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const time = clock()
    const client = new LoginClient({ fetchImpl, now: time.now, minPollIntervalMs: 0 })
    const { state } = await client.begin('cn')

    await client.complete(state)
    // The same authorization must not mint a second credential.
    await expect(client.complete(state)).rejects.toBeInstanceOf(LoginExpiredError)
  })

  it('keeps a state alive across a pending poll so the user can retry', async () => {
    let authorized = false
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/auth/state')) return envelope({ code: 0, data: { state: 'st', authUrl: 'https://a' } })
      if (url.includes('/auth/token')) {
        return authorized
          ? envelope({ code: 0, data: { accessToken: 'at', domain: 'copilot.tencent.com' } })
          : envelope({ code: 11217, msg: 'login ing...' }, 400)
      }
      return envelope({ code: 0, data: { uid: 'uid-1' } })
    })
    const time = clock()
    const client = new LoginClient({ fetchImpl, now: time.now, minPollIntervalMs: 0 })
    const { state } = await client.begin('cn')

    await expect(client.complete(state)).rejects.toBeInstanceOf(LoginPendingError)

    // User finishes in the browser, comes back.
    authorized = true
    await expect(client.complete(state)).resolves.toBeDefined()
  })
})

describe('complete', () => {
  it('returns the token together with the account identity', async () => {
    const fetchImpl = stubFetch(happyRoutes)
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')

    const result = await client.complete(state)
    expect(result.account).toEqual({ uid: 'uid-1', enterpriseId: 'ent', nickname: '号一' })
    expect(result.region).toBe('cn')
  })

  it('fails when the token arrives without a uid', async () => {
    // Every upstream call needs the uid, so a credential without one is
    // unusable and must not be stored as if sign-in succeeded.
    const fetchImpl = stubFetch([
      ...happyRoutes.slice(0, 2),
      { match: '/login/account', reply: () => envelope({ code: 0, data: { nickname: 'x' } }) },
    ])
    const client = new LoginClient({ fetchImpl })
    const { state } = await client.begin('cn')

    await expect(client.complete(state)).rejects.toThrow(/uid/)
  })
})

describe('region input', () => {
  it('accepts the numeric and word forms', () => {
    expect(parseRegionInput('1')).toBe('cn')
    expect(parseRegionInput('cn')).toBe('cn')
    expect(parseRegionInput('')).toBe('cn')
    expect(parseRegionInput('2')).toBe('global')
    expect(parseRegionInput('GLOBAL')).toBe('global')
    expect(parseRegionInput('国际版')).toBe('global')
  })

  it('rejects anything else rather than guessing', () => {
    expect(parseRegionInput('intl')).toBeUndefined()
    expect(parseRegionInput('3')).toBeUndefined()
  })
})
