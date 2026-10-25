/**
 * The `X-Conversation-*` trio on the chat wire.
 *
 * Since 2026-10-16 the gateway answers a `/v2/chat/completions` request that
 * omits all three with `400` / `11128` ("conversation id missing"), which the
 * host renders as a generic request failure. The names come from the official
 * desktop client; the upstream project measured the CN gateway accepting the
 * trio as well, so both regions carry it.
 *
 * What is asserted here is only what the plugin controls: the three headers are
 * present, distinct, and fresh per request. Whether the values are opaque is the
 * upstream's business — measured, it keeps no history keyed by them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.workbuddy.cn', uid: 'uid-a', region: 'cn',
}

const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai', region: 'global' }

const NAMES = ['x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id'] as const

afterEach(() => vi.unstubAllGlobals())

/** Send one chat request and return the headers it put on the wire. */
async function wireHeaders(credential: WorkBuddyCredential): Promise<Headers> {
  let headers: Headers | undefined
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    headers = new Headers(init?.headers as Record<string, string>)
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }))
  const client = new WorkBuddyUpstreamClient({ identity: {} })
  await client.chatStream(credential, JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
  }))
  if (headers === undefined) throw new Error('the client never reached fetch')
  return headers
}

describe('conversation headers', () => {
  it('sends all three on a CN chat request', async () => {
    const headers = await wireHeaders(CN)
    for (const name of NAMES) expect(headers.get(name)).toBeTruthy()
  })

  it('sends them on the international endpoint too', async () => {
    const headers = await wireHeaders(GLOBAL)
    for (const name of NAMES) expect(headers.get(name)).toBeTruthy()
  })

  it('gives each header its own value, and each request fresh values', async () => {
    const first = await wireHeaders(CN)
    const second = await wireHeaders(CN)

    const firstValues = NAMES.map((name) => first.get(name))
    expect(new Set(firstValues).size).toBe(3)
    // Fresh per request: two sub-agents running at once must not share one
    // conversation channel.
    for (const name of NAMES) expect(second.get(name)).not.toBe(first.get(name))
  })

  it('keeps the refresh token off the chat request', async () => {
    // The safety rule this trio could have been bolted on next to: chat never
    // carries `X-Refresh-Token`.
    const headers = await wireHeaders(CN)
    expect(headers.get('x-refresh-token')).toBeNull()
  })
})
