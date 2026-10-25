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

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/credentials.ts'
import { WorkBuddyUpstreamClient, conversationHeaders, isConversationRejection, uuidV4 } from '../src/upstream.ts'

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

/** A fetch mock answering from a queue of [status, body]; records headers. */
function scriptedFetch(answers: Array<[number, string]>): Array<Record<string, string>> {
  const seen: Array<Record<string, string>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    seen.push({ ...(init?.headers as Record<string, string>) })
    const [status, body] = answers.shift() ?? [200, 'data: [DONE]\n\n']
    return new Response(body, { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } })
  }))
  return seen
}

const REJECTION_11128 = JSON.stringify({ code: 11128, msg: 'request illegal', displayMsg: { zh: '请求被拦截,请重新发送' } })
const OK_STREAM = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

describe('UUID generation', () => {
  it('uses randomUUID when available', () => {
    expect(uuidV4()).toMatch(UUID)
    expect(uuidV4(() => '11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('falls back to a randomBytes v4 id when randomUUID is missing, throws, or returns junk', () => {
    expect(uuidV4(undefined)).toMatch(UUID)
    expect(uuidV4(() => { throw new Error('not available in this context') })).toMatch(UUID)
    expect(uuidV4(() => 'junk')).toMatch(UUID)
    const ids = new Set(Array.from({ length: 200 }, () => uuidV4(undefined)))
    expect(ids.size).toBe(200)
  })

  it('builds the trio from the generator at call time', () => {
    let n = 0
    const h = conversationHeaders(() => `id-${++n}`)
    expect(h).toEqual({ 'X-Conversation-ID': 'id-1', 'X-Conversation-Request-ID': 'id-2', 'X-Conversation-Message-ID': 'id-3' })
  })
})

describe('restart safety', () => {
  it('a fresh module import (engine restart) generates new ids; nothing is cached at module load', async () => {
    const first = captureFetch()
    const a = await import('../src/upstream.ts')
    await new a.WorkBuddyUpstreamClient().chatStream(credential(), BODY)
    vi.resetModules()
    // After resetModules the dynamic import evaluates the module again, as an
    // engine restart would.
    const b = await import('../src/upstream.ts')
    expect(b.WorkBuddyUpstreamClient).not.toBe(a.WorkBuddyUpstreamClient) // really a second evaluation
    await new b.WorkBuddyUpstreamClient().chatStream(credential(), BODY)
    expect(first).toHaveLength(2)
    for (const name of TRIO) {
      expect(first[0]![name]).toMatch(UUID)
      expect(first[1]![name]).toMatch(UUID)
      expect(first[0]![name]).not.toBe(first[1]![name])
    }
  })
})

describe('400 / 11128 guard', () => {
  it('recognises the rejection and nothing else', () => {
    expect(isConversationRejection(400, REJECTION_11128)).toBe(true)
    expect(isConversationRejection(400, '{"message":"workbuddy upstream client (http 400): 请求被拦截,请重新发送"}')).toBe(true)
    expect(isConversationRejection(400, '{"code":111280}')).toBe(false)
    expect(isConversationRejection(400, '{"code":11133}')).toBe(false)
    expect(isConversationRejection(429, REJECTION_11128)).toBe(false)
  })

  it('retries a chat once with a regenerated trio, then succeeds', async () => {
    const seen = scriptedFetch([[400, REJECTION_11128], [200, OK_STREAM]])
    const result = await new WorkBuddyUpstreamClient().chatStream(credential(), BODY)
    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(2)
    for (const name of TRIO) expect(seen[1]![name]).not.toBe(seen[0]![name])
  })

  it('retries only once: a second 11128 is returned to the caller', async () => {
    const seen = scriptedFetch([[400, REJECTION_11128], [400, REJECTION_11128], [200, OK_STREAM]])
    const result = await new WorkBuddyUpstreamClient().chatStream(credential(), BODY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
    expect(seen).toHaveLength(2)
  })

  it('does not retry any other 400', async () => {
    const seen = scriptedFetch([[400, '{"code":11133,"msg":"integer_below_min_value"}']])
    const result = await new WorkBuddyUpstreamClient().chatStream(credential(), BODY)
    expect(result.ok).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('does not retry after the caller aborted', async () => {
    const seen = scriptedFetch([[400, REJECTION_11128], [200, OK_STREAM]])
    const controller = new AbortController()
    controller.abort()
    await new WorkBuddyUpstreamClient().chatStream(credential(), BODY, controller.signal)
    expect(seen).toHaveLength(1)
  })

  it('guards the probe path the same way', async () => {
    const seen = scriptedFetch([[400, REJECTION_11128], [200, OK_STREAM]])
    await new WorkBuddyUpstreamClient().probeEffort(credential(), 'test-model', undefined, new AbortController().signal)
    expect(seen).toHaveLength(2)
    for (const name of TRIO) expect(seen[1]![name]).toMatch(UUID)
  })
})

describe('one sender for every chat request', () => {
  it('only postChatCompletions() calls /v2/chat/completions, and it builds headers per attempt', () => {
    const src = readFileSync(new URL('../src/upstream.ts', import.meta.url), 'utf8')
    const fetches = src.match(/fetch\(`\$\{chatBase\(credential\)\}\/v2\/chat\/completions`/g) ?? []
    expect(fetches).toHaveLength(1)
    const sender = src.slice(src.indexOf('async function postChatCompletions('))
    const body = sender.slice(0, sender.indexOf('\n}\n'))
    expect(body).toContain('/v2/chat/completions')
    expect(body).toMatch(/const send = \(\): Promise<Response> =>\s*fetch\([\s\S]*chatHeaders\(/)
  })
})
