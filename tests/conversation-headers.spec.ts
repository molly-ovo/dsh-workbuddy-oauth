/**
 * Conversation-header trio tests.
 *
 * `www.workbuddy.ai` rejects every `/v2/chat/completions` request that omits
 * `X-Conversation-ID` / `X-Conversation-Request-ID` / `X-Conversation-Message-ID`
 * with HTTP 400 / code 11128 ("request illegal"). These tests pin the fix:
 * chat and probe requests carry the trio, each id is a fresh UUID per request,
 * the existing identity headers are untouched, and a chat request still never
 * carries a refresh token.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/credentials.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const TRIO = ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'test-access',
    refreshToken: 'test-refresh-must-not-leak',
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'www.workbuddy.ai',
    uid: 'uid-1',
    region: 'global',
    ...overrides,
  }
}

/** Capture the headers of every fetch; answer with a minimal SSE stream. */
function captureFetch(): Array<Record<string, string>> {
  const seen: Array<Record<string, string>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    seen.push({ ...(init?.headers as Record<string, string>) })
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }))
  return seen
}

const BODY = JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conversation header trio', () => {
  it('is present on every chat request, as UUIDs', async () => {
    const seen = captureFetch()
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential(), BODY)
    expect(seen).toHaveLength(1)
    for (const name of TRIO) expect(seen[0]![name]).toMatch(UUID)
  })

  it('is present on the CN endpoint too', async () => {
    const seen = captureFetch()
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential({ domain: 'copilot.tencent.com', region: 'cn' }), BODY)
    for (const name of TRIO) expect(seen[0]![name]).toMatch(UUID)
  })

  it('is fresh per request and the three ids differ from each other', async () => {
    const seen = captureFetch()
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential(), BODY)
    await client.chatStream(credential(), BODY)
    const ids = seen.flatMap(h => TRIO.map(name => h[name]))
    expect(new Set(ids).size).toBe(6)
  })

  it('rides the probe path as well', async () => {
    const seen = captureFetch()
    const client = new WorkBuddyUpstreamClient()
    await client.probeEffort(credential(), 'test-model', undefined, new AbortController().signal)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    for (const name of TRIO) expect(seen[0]![name]).toMatch(UUID)
  })

  it('leaves the existing identity headers untouched', async () => {
    const seen = captureFetch()
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential(), BODY)
    const h = seen[0]!
    expect(h['X-User-Id']).toBe('uid-1')
    expect(h['X-IDE-Type']).toBe('WorkBuddy')
    expect(h['X-IDE-Name']).toBe('WorkBuddy')
    expect(h['X-Product']).toBe('SaaS')
    expect(h['Content-Type']).toBe('application/json')
    expect(h['Authorization']).toBe('Bearer test-access')
    expect(typeof h['X-IDE-Version']).toBe('string')
    expect(h['User-Agent']).toBeTruthy()
  })

  it('never carries the refresh token on a chat request', async () => {
    const seen = captureFetch()
    const client = new WorkBuddyUpstreamClient()
    await client.chatStream(credential(), BODY)
    const h = seen[0]!
    expect(h['X-Refresh-Token']).toBeUndefined()
    expect(Object.values(h).join('\n')).not.toContain('test-refresh-must-not-leak')
  })
})
