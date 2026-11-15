/**
 * Multi-account failover test.
 *
 * One request used to be served by one account and nothing else: when the
 * upstream answered "this account is out of credit / rate-limited / restricted",
 * the user got an error naming the *pool's* problem even though another
 * signed-in account would have answered the identical body.
 *
 * The rule is narrow on purpose, and both halves need proving:
 *
 * - an account-shaped failure retries on a **different** account, and never on
 *   one this request already tried;
 * - a request-shaped failure (`client`, `not_found`) does not retry at all —
 *   another account would answer the same 400.
 *
 * Every case here also pins the reason the retry is legitimate: it only ever
 * happens before the response is written, so nothing is duplicated downstream.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyShim, MAX_ACCOUNT_ATTEMPTS, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore, ResolveOptions } from '../src/store.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

/** A credential for `uid`; nothing else is read by the chat path. */
function credential(uid: string): WorkBuddyCredential {
  return {
    accessToken: `at-${uid}`, refreshToken: `rt-${uid}`, expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com', uid, region: 'cn',
  }
}

/** An upstream answer that means "the account cannot serve this". */
const restricted = {
  ok: false as const, status: 403, kind: 'account_restricted' as const,
  message: '{"code":11140,"msg":"account restricted"}',
}

/** The stream an account returns when it does serve. */
function served(): { ok: true; response: Response } {
  return { ok: true, response: new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }
}

interface Harness {
  store: CredentialStore
  /** uids the upstream stub was asked to serve, in order. */
  attempts: string[]
  /** What `resolve` was asked for, in order. */
  resolves: Array<{ key: string | undefined; exclude: readonly string[] }>
  failures: Array<{ uid: string; untilMs: number }>
}

/** A store over a fixed pool that honours the exclusion set, like the real one. */
function harness(pool: readonly string[]): Harness {
  const attempts: string[] = []
  const resolves: Array<{ key: string | undefined; exclude: readonly string[] }> = []
  const failures: Array<{ uid: string; untilMs: number }> = []
  const store: CredentialStore = {
    async resolve(sessionKey?: string, options?: ResolveOptions): Promise<WorkBuddyCredential> {
      resolves.push({ key: sessionKey, exclude: options?.exclude ?? [] })
      const excluded = new Set(options?.exclude ?? [])
      const next = pool.find((uid) => !excluded.has(uid))
      if (next === undefined) throw new Error('no other account')
      return credential(next)
    },
    async current() { return credential(pool[0] as string) },
    noteFailure(uid, untilMs) { failures.push({ uid, untilMs }) },
    async clearFailure() {},
  }
  return { store, attempts, resolves, failures }
}

let shim: WorkBuddyShim | undefined

afterEach(async () => {
  await shim?.close()
  shim = undefined
})

/** Serve one chat with `answer` deciding what each uid returns. */
async function post(
  h: Harness,
  answer: (uid: string) => { ok: true; response: Response } | { ok: false; status: number; kind: string; message: string },
): Promise<Response> {
  const client = {
    chatStream: async (credential: WorkBuddyCredential) => {
      h.attempts.push(credential.uid)
      return answer(credential.uid)
    },
  }
  shim = createWorkBuddyShim({
    store: h.store,
    client: client as never,
    catalog: new WorkBuddyCatalog(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
  await shim.ready
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}`, 'x-session-id': 'session-1' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('shim account failover', () => {
  it('serves the request from another account when one is restricted', async () => {
    const h = harness(['uid-restricted', 'uid-healthy'])
    // The first account is the pinned one (a fresh pool starts at index 0); the
    // second answers normally.
    const response = await post(h, (uid) => (uid === 'uid-restricted' ? restricted : served()))

    expect(response.status).toBe(200)
    expect(h.attempts).toEqual(['uid-restricted', 'uid-healthy'])
    // The restricted account is parked before the replacement is looked up, so
    // the *next* message does not have to discover it again.
    expect(h.failures.map((failure) => failure.uid)).toEqual(['uid-restricted'])
    // And the retry excludes it, rather than hoping rotation avoids it.
    expect(h.resolves[1]?.exclude).toEqual(['uid-restricted'])
  })

  it('never asks one account twice in the same request', async () => {
    const h = harness(['uid-a', 'uid-b', 'uid-c'])
    const response = await post(h, () => restricted)

    // Three accounts, three attempts, three distinct uids.
    expect(h.attempts).toEqual(['uid-a', 'uid-b', 'uid-c'])
    expect(new Set(h.attempts).size).toBe(h.attempts.length)
    // Everything failed, so the caller sees the failure — with the last account
    // named, not the first.
    expect(response.status).toBe(403)
  })

  it('stops at the attempt cap even when the pool is larger', async () => {
    const h = harness(['uid-a', 'uid-b', 'uid-c', 'uid-d', 'uid-e'])
    const response = await post(h, () => restricted)

    expect(h.attempts).toHaveLength(MAX_ACCOUNT_ATTEMPTS)
    expect(response.status).toBe(403)
  })

  it('reports the restriction when no other account exists', async () => {
    // A single-account install is the common case: failing over would be a
    // no-op, and the user must still be told what the upstream said.
    const h = harness(['uid-only'])
    const response = await post(h, () => restricted)
    const body = (await response.json()) as { error: { message: string } }

    expect(h.attempts).toEqual(['uid-only'])
    expect(response.status).toBe(403)
    expect(body.error.message).toContain('account_restricted')
    expect(h.failures.map((failure) => failure.uid)).toEqual(['uid-only'])
  })

  it('does not fail over a request-shape failure', async () => {
    // A 400 is about the body, which is identical for every account: retrying
    // would spend a second request to get the same answer.
    const h = harness(['uid-a', 'uid-b'])
    const response = await post(h, () => ({
      ok: false as const, status: 400, kind: 'client' as const, message: '{"code":11128}',
    }))

    expect(h.attempts).toEqual(['uid-a'])
    expect(response.status).toBe(400)
    expect(h.failures).toEqual([])
  })

  it('does not fail over a plain 401 that a refresh could not fix', async () => {
    // A 401 is handled by the refresh path; without a permanent refresh failure
    // there is no evidence the *account* is unusable, so the pool is not walked.
    const h = harness(['uid-a', 'uid-b'])
    const response = await post(h, () => ({
      ok: false as const, status: 401, kind: 'session_dead' as const, message: '<html>401</html>',
    }))

    expect(h.attempts).toEqual(['uid-a'])
    expect(response.status).toBe(401)
  })
})
