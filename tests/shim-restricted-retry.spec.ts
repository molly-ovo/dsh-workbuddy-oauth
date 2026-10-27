/**
 * Account-restriction failover through the real shim.
 *
 * Two fake accounts: the first answers the 403 / code 11140 "account restricted"
 * body, the second answers a stream. Before the fix the shim made exactly one
 * attempt, reported the failure and left the restricted account selected for
 * the next turn (a 403 classified as `client` is never cooled).
 */

import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyShim } from '../src/shim.ts'

const RESTRICTED_BODY = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  requestId: '00000000-0000-4000-8000-000000000000',
  displayMsg: { en: 'Your account has been restricted due to unusual activity' },
})

type Fail = { ok: false, status: number, kind: string, message: string }

function harness(failures: Record<string, Fail | undefined>, uids: string[]) {
  const parked = new Map<string, number>()
  const served: string[] = []
  const store = {
    async resolve() {
      const now = Date.now()
      const ready = uids.filter(uid => (parked.get(uid) ?? 0) <= now)
      return { uid: ready[0] ?? uids[0] }
    },
    noteFailure(uid: string, until: number) { parked.set(uid, until) },
  }
  const client = {
    async chatStream(credential: { uid: string }) {
      served.push(credential.uid)
      const failure = failures[credential.uid]
      if (failure) return failure
      return { ok: true, status: 200, response: { body: Readable.toWeb(Readable.from(['data: [DONE]\n\n'])) } }
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shim = createWorkBuddyShim({ store, client, catalog: { list: async () => [] } } as any)
  return { shim, parked, served }
}

async function post(shim: ReturnType<typeof createWorkBuddyShim>) {
  await shim.ready
  const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${shim.token()}`, 'x-session-id': 'sess-1' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
  return { status: res.status, text: await res.text() }
}

const open: Array<ReturnType<typeof createWorkBuddyShim>> = []
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close()
})

describe('shim failover on a restricted account', () => {
  it('parks the restricted account and serves the same request from another one', async () => {
    const restricted: Fail = { ok: false, status: 403, kind: 'account_restricted', message: RESTRICTED_BODY }
    const h = harness({ a: restricted }, ['a', 'b'])
    open.push(h.shim)
    const { status, text } = await post(h.shim)
    expect(status).toBe(200)
    expect(text).toContain('[DONE]')
    expect(h.served).toEqual(['a', 'b'])
    expect(h.parked.get('a') ?? 0).toBeGreaterThan(Date.now())
  })

  it('stops when every account is restricted instead of looping', async () => {
    const restricted: Fail = { ok: false, status: 403, kind: 'account_restricted', message: RESTRICTED_BODY }
    const h = harness({ a: restricted, b: restricted }, ['a', 'b'])
    open.push(h.shim)
    const { status, text } = await post(h.shim)
    expect(status).toBe(403)
    expect(text).toContain('restricted')
    expect(h.served).toEqual(['a', 'b'])
  })

  it('never spends more than three accounts on one request', async () => {
    const rate: Fail = { ok: false, status: 429, kind: 'soft_rate', message: '{"msg":"slow down"}' }
    const h = harness({ a: rate, b: rate, c: rate, d: rate }, ['a', 'b', 'c', 'd'])
    open.push(h.shim)
    await post(h.shim)
    expect(h.served).toEqual(['a', 'b', 'c'])
  })

  it('does not retry a request-shape failure on another account', async () => {
    const shape: Fail = { ok: false, status: 400, kind: 'client', message: '{"code":11128,"msg":"request illegal"}' }
    const h = harness({ a: shape }, ['a', 'b'])
    open.push(h.shim)
    const { status } = await post(h.shim)
    expect(status).not.toBe(200)
    expect(h.served).toEqual(['a'])
    expect(h.parked.has('a')).toBe(false)
  })
})
