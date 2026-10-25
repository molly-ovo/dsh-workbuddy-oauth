/**
 * Recovery from a revoked session (`401` before the stream starts).
 *
 * The failure this pins down is the one that looked like a broken plugin: the
 * upstream retires an account's tokens when the same account signs in
 * somewhere else, but the stored access token keeps its future `expiresAtMs`.
 * The store's lazy refresh therefore never fires, every request presents the
 * dead token, and the user sees the host's generic "invalid API key" banner
 * for days — with a perfectly good second account sitting unused because a 401
 * deliberately never parks an account.
 *
 * Two behaviours are asserted here, and they have to hold together: refresh the
 * credential *once* and retry the same body (safe — nothing has been delivered
 * yet), and when the refresh token is refused too, say "sign in again" and park
 * the account so the pool fails over.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore } from '../src/store.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }))
vi.mock('../src/refresh.ts', () => ({ refreshCredential: refreshMock }))

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'stale-token', refreshToken: 'rt', expiresAtMs: Date.now() + 86_400_000,
  domain: 'copilot.tencent.com', uid: 'uid-a', region: 'cn',
}

const REFRESHED: WorkBuddyCredential = { ...CREDENTIAL, accessToken: 'fresh-token' }

/** A store stub that records the cooldowns the shim applies. */
function recordingStore(): CredentialStore & { failures: Array<{ uid: string; untilMs: number }> } {
  const failures: Array<{ uid: string; untilMs: number }> = []
  return {
    failures,
    async resolve(): Promise<WorkBuddyCredential> { return CREDENTIAL },
    async current() { return CREDENTIAL },
    noteFailure(uid, untilMs) { failures.push({ uid, untilMs }) },
    async clearFailure() {},
  }
}

/** The gateway's APISIX page — what a revoked token actually answers with. */
const GATEWAY_401 = '<html><head><title>401 Authorization Required</title></head><body>openresty</body></html>'

/** An upstream stub that answers with the given sequence of results. */
function scriptedClient(results: Array<{ ok: true } | { ok: false; status: number; kind: string; message: string }>) {
  const calls: WorkBuddyCredential[] = []
  return {
    calls,
    chatStream: async (credential: WorkBuddyCredential) => {
      calls.push(credential)
      // The last result repeats, so a caller that retries more than once is
      // visible as extra calls rather than as an index overflow.
      const next = results[Math.min(calls.length - 1, results.length - 1)] ?? results[results.length - 1]
      if (next === undefined) throw new Error('the stub needs at least one result')
      if (next.ok) {
        return {
          ok: true as const,
          response: new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        }
      }
      return next as { ok: false; status: number; kind: 'session_dead'; message: string }
    },
  }
}

const SESSION_DEAD = { ok: false as const, status: 401, kind: 'session_dead', message: GATEWAY_401 }

let shim: WorkBuddyShim | undefined

afterEach(async () => {
  await shim?.close()
  shim = undefined
  refreshMock.mockReset()
})

async function start(store: CredentialStore, client: { chatStream: unknown }): Promise<{ origin: string; token: string }> {
  shim = createWorkBuddyShim({
    store,
    client: client as never,
    catalog: new WorkBuddyCatalog(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
  await shim.ready
  return { origin: shim.baseUrl(), token: shim.token() }
}

async function post(origin: string, token: string): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('shim recovery from a revoked session', () => {
  it('refreshes the rejected token and retries the same request', async () => {
    const store = recordingStore()
    const client = scriptedClient([SESSION_DEAD, { ok: true }])
    refreshMock.mockResolvedValue({ status: 'refreshed', credential: REFRESHED })

    const { origin, token } = await start(store, client)
    const response = await post(origin, token)

    expect(response.status).toBe(200)
    // The retry is what makes this transparent: one message, no user action.
    expect(client.calls.map((c) => c.accessToken)).toEqual(['stale-token', 'fresh-token'])
    // A forced refresh is the point — the stored expiry is still in the future,
    // so an expiry-gated refresh would have skipped it.
    expect(refreshMock).toHaveBeenCalledWith('uid-a', { force: true, staleAccessToken: 'stale-token' })
    expect(store.failures).toEqual([])
  })

  it('retries at most once when the fresh token is rejected too', async () => {
    const store = recordingStore()
    const client = scriptedClient([SESSION_DEAD, SESSION_DEAD])
    refreshMock.mockResolvedValue({ status: 'refreshed', credential: REFRESHED })

    const { origin, token } = await start(store, client)
    const response = await post(origin, token)

    expect(response.status).toBe(401)
    expect(client.calls).toHaveLength(2)
  })

  it('tells the user to sign in again when the refresh token is refused too', async () => {
    const store = recordingStore()
    const client = scriptedClient([SESSION_DEAD])
    refreshMock.mockResolvedValue({
      status: 'failed',
      reason: '刷新未返回新 token：12153: invalid_grant',
      permanent: true,
    })

    const { origin, token } = await start(store, client)
    const response = await post(origin, token)

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { message: string } }
    // The gateway's HTML page must not be what the user reads, and the action
    // has to be named: the host renders this as "invalid API key" otherwise.
    expect(body.error.message).toContain('/wb-login')
    expect(body.error.message).not.toContain('<html>')
    expect(client.calls).toHaveLength(1)
    // Parked, so a second account serves the *next* request instead of the same
    // dead session being retried every turn.
    expect(store.failures).toHaveLength(1)
    expect(store.failures[0]?.untilMs).toBeGreaterThan(Date.now())
  })

  it('does not park the account when the refresh failed for a transient reason', async () => {
    const store = recordingStore()
    const client = scriptedClient([SESSION_DEAD])
    refreshMock.mockResolvedValue({ status: 'failed', reason: '刷新请求失败：fetch failed' })

    const { origin, token } = await start(store, client)
    await post(origin, token)

    // A network blip says nothing about the credential, so the account keeps
    // its place in the pool.
    expect(store.failures).toEqual([])
  })

  it('does not attempt a refresh when the account has no refresh token', async () => {
    const store: CredentialStore = {
      async resolve(): Promise<WorkBuddyCredential> { return { ...CREDENTIAL, refreshToken: '' } },
      async current() { return CREDENTIAL },
      noteFailure() {},
      async clearFailure() {},
    }
    const client = scriptedClient([SESSION_DEAD])

    const { origin, token } = await start(store, client)
    const response = await post(origin, token)

    expect(response.status).toBe(401)
    expect(refreshMock).not.toHaveBeenCalled()
  })
})
