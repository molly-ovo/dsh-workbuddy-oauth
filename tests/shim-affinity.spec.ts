/**
 * Shim session-affinity wiring test.
 *
 * The unit tests in `store.spec.ts` prove the *store* pins a conversation to an
 * account. What they cannot prove is that the key ever reaches the store: the
 * shim has to read `x-session-id` off the incoming request (which pi-ai sets
 * from DSH's `sessionId`, configured in `adapter.ts`) and hand it to
 * `resolve()`. That glue is two lines, and if it silently stopped working the
 * only symptom would be conversations hopping accounts — i.e. multi-turn
 * context loss, which looks like a model problem, not a plugin problem.
 *
 * This drives a real shim over real loopback HTTP, so it exercises the actual
 * header path rather than a re-typed copy of it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore } from '../src/store.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'copilot.tencent.com', uid: 'uid-a', region: 'cn',
}

/** A store stub that records what it was asked for. */
function recordingStore(): CredentialStore & {
  resolveKeys: Array<string | undefined>
  failures: Array<{ uid: string; untilMs: number }>
} {
  const resolveKeys: Array<string | undefined> = []
  const failures: Array<{ uid: string; untilMs: number }> = []
  return {
    resolveKeys,
    failures,
    async resolve(sessionKey?: string): Promise<WorkBuddyCredential> {
      resolveKeys.push(sessionKey)
      return CREDENTIAL
    },
    async current() { return CREDENTIAL },
    noteFailure(uid, untilMs) { failures.push({ uid, untilMs }) },
  }
}

/** Upstream stub: always a soft rate limit, so the request ends immediately. */
const rateLimited = {
  chatStream: async () => ({ ok: false as const, status: 429, kind: 'soft_rate' as const, message: 'usage exceeds frequency limit' }),
}

let shim: WorkBuddyShim | undefined

afterEach(async () => {
  await shim?.close()
  shim = undefined
})

/** Start a shim against the given store and return its origin + bearer token. */
async function startShim(store: CredentialStore): Promise<{ origin: string; token: string }> {
  shim = createWorkBuddyShim({
    store,
    client: rateLimited as never,
    catalog: new WorkBuddyCatalog(),
    logger: { warn: vi.fn(), error: vi.fn() },
  })
  await shim.ready
  return { origin: shim.baseUrl(), token: shim.token() }
}

/** POST one chat completion, optionally carrying a session-affinity header. */
async function post(origin: string, token: string, sessionId?: string | string[]): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(sessionId === undefined ? {} : { 'x-session-id': sessionId }),
    },
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('shim session affinity', () => {
  it('forwards x-session-id to the store as the session key', async () => {
    const store = recordingStore()
    const { origin, token } = await startShim(store)

    const response = await post(origin, token, 'session-42')
    expect(response.status).toBe(429)

    // This is the glue: without it the store never sees the conversation id and
    // every turn rotates to a different account.
    expect(store.resolveKeys).toEqual(['session-42'])
  })

  it('passes no key when the header is absent', async () => {
    const store = recordingStore()
    const { origin, token } = await startShim(store)

    await post(origin, token)
    expect(store.resolveKeys).toEqual([undefined])
  })

  it('treats the header as an opaque key, verbatim', async () => {
    // A duplicated header never reaches us as an array: the fetch/undici Headers
    // layer joins repeated values with a comma before sending. The value is
    // therefore an opaque string — whatever arrives is the key. That is
    // consistent, so affinity still works; pi-ai sends exactly one header anyway.
    const store = recordingStore()
    const { origin, token } = await startShim(store)

    await post(origin, token, ['a', 'b'])
    expect(store.resolveKeys).toEqual(['a,b'])
  })

  it('parks the failing account so the next turn rotates away from it', async () => {
    const store = recordingStore()
    const { origin, token } = await startShim(store)

    await post(origin, token, 'session-1')
    // A soft rate limit is account-shaped, so the shim records a cooldown for
    // the account it just used — that is what makes affinity yield to cooldown.
    expect(store.failures).toHaveLength(1)
    expect(store.failures[0]?.uid).toBe('uid-a')
    expect(store.failures[0]?.untilMs).toBeGreaterThan(Date.now())
  })
})
