/**
 * Gateway-compliance header tests (international 400 / code 11128).
 *
 * The international endpoint refuses a chat that carries only the headers
 * {@link chatHeaders} already sends, with HTTP 400 and business code `11128`
 * whose `displayMsg.zh` reads 「请求被拦截，请重新发送」. Because
 * `classifyUpstreamError` funnels every 4xx without a credit or session marker
 * into its `client` fallback, the user sees a generic "invalid request"
 * instead of "your client is not recognised". This file pins the header
 * families that turn that 400 into a 200.
 *
 * Two facts about the failure shape the tests below, and both were measured
 * on the live international gateway on 2026-10-20 with a real account:
 *
 * 1. The **`X-Agent-*` identity family** is what the gate reads. Without it a
 *    request that is otherwise well-formed is refused; with it the same
 *    request, same credential, succeeds.
 * 2. The **`X-Conversation-*` tracking family** is what keeps one user send
 *    counted as one request. The backend counts a send by
 *    `X-Conversation-Request-ID`, so a chat carrying a fresh id every time is
 *    counted on its own — a multi-step send shows up as many requests.
 *
 * The asymmetry that makes this international-only is deliberate and is tested
 * for: `X-Agent-Intent`/`X-Agent-Purpose` are sent by WorkBuddy's own client
 * on both builds, while `X-Agent-Type: main` is international-only. The
 * reference implementation (`magpie-community/plugins` workbuddy, `sign()`)
 * returns early before `X-Agent-Type` unless the site is the international
 * one — which is exactly why the CN endpoint serves the same body without
 * complaint.
 *
 * The fetch-level assertions capture the outbound headers, so what is tested is
 * what goes on the wire rather than what a helper returned.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  INTERNATIONAL_AGENT_HEADERS,
  SHARED_AGENT_HEADERS,
  WorkBuddyUpstreamClient,
  withGatewayChatHeaders,
} from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

const GLOBAL: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'workbuddy.ai', uid: 'uid-g', region: 'global',
}

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'copilot.tencent.com', uid: 'uid-c', region: 'cn',
}

const CHAT_BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Reply with exactly PONG.' },
  ],
  max_tokens: 16,
})

/** A 200 whose body streams one event, so the caller sees a real answer. */
function okStream(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"PONG"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * Drive one `chatStream` call with `fetch` stubbed, and return the headers it
 * actually put on the wire.
 */
async function headersOnTheWire(
  credential: WorkBuddyCredential,
  options: { body?: string; sessionKey?: string } = {},
): Promise<Record<string, string>> {
  const calls: Array<Record<string, string>> = []
  const fetchStub = vi.fn(async (_url: string | URL, init: RequestInit) => {
    calls.push(init.headers as Record<string, string>)
    return okStream()
  })
  vi.stubGlobal('fetch', fetchStub)
  try {
    const client = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => ({ clientVersion: '5.5.6' }),
    })
    await client.chatStream(credential, options.body ?? CHAT_BODY, undefined, options.sessionKey)
  } finally {
    vi.unstubAllGlobals()
  }
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('international gateway compliance', () => {
  it('sends the X-Agent-* identity family on the international region', async () => {
    const headers = await headersOnTheWire(GLOBAL)
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Agent-Type']).toBe('main')
  })

  it('sends the X-Conversation-* tracking family on the international region', async () => {
    const headers = await headersOnTheWire(GLOBAL)
    for (const name of [
      'X-Conversation-ID',
      'X-Conversation-Request-ID',
      'X-Conversation-Message-ID',
      'X-Request-ID',
    ]) {
      expect(headers[name]).toMatch(/^[0-9a-f]{32}$/)
    }
    // WorkBuddy's own client has these two be the same value.
    expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
  })

  it('sends the shared identity pair on the CN region too', async () => {
    // WorkBuddy's own client sends these two on both builds, so mirroring it
    // means sending them here as well.
    const headers = await headersOnTheWire(CN)
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
  })

  it('leaves the CN region without the international-only X-Agent-Type', async () => {
    // The shared pair IS sent on CN (see above). What is international-only is
    // X-Agent-Type: main, and sending it on CN would claim an identity that
    // build does not have — which is exactly why the CN endpoint serves the
    // same body without it.
    const headers = await headersOnTheWire(CN)
    expect(headers['X-Agent-Type']).toBeUndefined()
  })

  it('sends the international-only half on the international region', async () => {
    const headers = await headersOnTheWire(GLOBAL)
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Agent-Type']).toBe('main')
  })

  it('still tracks the conversation on the CN region', async () => {
    // Attribution is not international-only: the tracking family is what keeps
    // one send counted as one request on either build.
    const headers = await headersOnTheWire(CN)
    expect(headers['X-Conversation-ID']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps the pre-existing identity headers', async () => {
    // The new families must not have displaced what already worked.
    const headers = await headersOnTheWire(GLOBAL)
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('5.5.6')
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['X-Domain']).toBe('workbuddy.ai')
  })
})

describe('conversation and turn ids', () => {
  it('derives one conversation id per session key', async () => {
    const a = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1' })
    const b = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1' })
    const c = await headersOnTheWire(GLOBAL, { sessionKey: 'session-2' })
    expect(a['X-Conversation-ID']).toBe(b['X-Conversation-ID'])
    expect(a['X-Conversation-ID']).not.toBe(c['X-Conversation-ID'])
  })

  it('repeats the turn id for every step of one send', async () => {
    // A tool call answered and sent again is the same user send. If the turn id
    // changed here, the backend would count one send as two requests.
    const first = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1' })
    const afterTool = await headersOnTheWire(GLOBAL, {
      sessionKey: 'session-1',
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: true,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Reply with exactly PONG.' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'pwsh' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'PONG' },
        ],
      }),
    })
    expect(afterTool['X-Conversation-Request-ID']).toBe(first['X-Conversation-Request-ID'])
    expect(afterTool['X-Conversation-ID']).toBe(first['X-Conversation-ID'])
    // Each message is its own, as WorkBuddy's client makes them.
    expect(afterTool['X-Conversation-Message-ID']).not.toBe(first['X-Conversation-Message-ID'])
  })

  it('changes the turn id when the user sends a new message', async () => {
    const first = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1' })
    const next = await headersOnTheWire(GLOBAL, {
      sessionKey: 'session-1',
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: true,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Reply with exactly PONG.' },
          { role: 'user', content: 'And again.' },
        ],
      }),
    })
    expect(next['X-Conversation-Request-ID']).not.toBe(first['X-Conversation-Request-ID'])
    // Still the same conversation: a new send is not a new conversation.
    expect(next['X-Conversation-ID']).toBe(first['X-Conversation-ID'])
  })

  it('does not key a turn on a tool result carried in a user message', async () => {
    // Anthropic-shaped clients put the tool result inside a *user* message.
    // Keying the turn on it would change the id with every step of the send —
    // the opposite of what a turn id is for.
    const body = (result: string): string => JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'do the thing' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: result }] },
      ],
    })
    const a = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1', body: body('ok') })
    const b = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1', body: body('changed') })
    const c = await headersOnTheWire(GLOBAL, { sessionKey: 'session-1', body: body('ok') })
    expect(a['X-Conversation-Request-ID']).toBe(b['X-Conversation-Request-ID'])
    // It must be the turn of the user's own words, not a per-request id: the
    // regression this guards was the id silently falling back to random, which
    // still "worked" but split every send into its own counted request.
    expect(a['X-Conversation-Request-ID']).toBe(c['X-Conversation-Request-ID'])
  })

  it('falls back to a per-request id when no user message is signable', async () => {
    const headers = await headersOnTheWire(GLOBAL, {
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: true,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
      }),
    })
    expect(headers['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
    // Nothing names a conversation, so none is claimed: a made-up one would be
    // a conversation of the request's own.
    expect(headers['X-Conversation-ID']).toBeUndefined()
  })
})

describe('withGatewayChatHeaders', () => {
  it('attaches every tracking id to a well-formed chat', () => {
    const headers = withGatewayChatHeaders({}, CHAT_BODY)
    for (const name of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID', 'X-Request-ID']) {
      expect(headers[name]).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('keeps an id the caller already carried', () => {
    // The caller's own attribution is better information than a derivation
    // made here — overwriting it would discard a name the caller chose.
    const headers = withGatewayChatHeaders({
      'X-Conversation-ID': 'a'.repeat(32),
      'X-Conversation-Request-ID': 'b'.repeat(32),
      'X-Conversation-Message-ID': 'c'.repeat(32),
      'X-Request-ID': 'c'.repeat(32),
    }, CHAT_BODY)
    expect(headers['X-Conversation-ID']).toBe('a'.repeat(32))
    expect(headers['X-Conversation-Request-ID']).toBe('b'.repeat(32))
    expect(headers['X-Conversation-Message-ID']).toBe('c'.repeat(32))
    expect(headers['X-Request-ID']).toBe('c'.repeat(32))
  })

  it('stays usable when the body is not JSON', () => {
    // A chat whose shape cannot be read still has to be attributable.
    const headers = withGatewayChatHeaders({}, 'not json at all')
    expect(headers['X-Conversation-Message-ID']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['X-Request-ID']).toBe(headers['X-Conversation-Message-ID'])
    expect(headers['X-Conversation-ID']).toBeUndefined()
  })

  it('does not set the X-Agent-* family itself', () => {
    // The identity decision belongs to the caller, because it depends on the
    // region. Mixing it in here would make the CN path claim an international
    // identity.
    const headers = withGatewayChatHeaders({}, CHAT_BODY)
    expect(headers['X-Agent-Intent']).toBeUndefined()
    expect(headers['X-Agent-Purpose']).toBeUndefined()
    expect(headers['X-Agent-Type']).toBeUndefined()
  })

  it('exposes exactly the international-only identity header', () => {
    expect(Object.keys(INTERNATIONAL_AGENT_HEADERS).sort()).toEqual([
      'X-Agent-Intent',
      'X-Agent-Purpose',
      'X-Agent-Type',
    ])
    // The shared pair is a strict subset: CN gets it, international gets it
    // plus one. If that relationship ever breaks, one region is either
    // under-identified or over-identified.
    for (const [name, value] of Object.entries(SHARED_AGENT_HEADERS)) {
      expect(INTERNATIONAL_AGENT_HEADERS[name]).toBe(value)
    }
    expect(Object.keys(SHARED_AGENT_HEADERS)).not.toContain('X-Agent-Type')
  })
})

describe('probe path', () => {
  it('presents the same gateway identity as a real message', async () => {
    // A probe that passes while a real message would be refused measures
    // nothing, so the probe shares the chat path's headers.
    const calls: Array<Record<string, string>> = []
    const fetchStub = vi.fn(async (_url: string | URL, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>)
      return okStream()
    })
    vi.stubGlobal('fetch', fetchStub)
    try {
      const client = new WorkBuddyUpstreamClient({
        resolveChatIdentity: async () => ({ clientVersion: '5.5.6' }),
      })
      await client.probeEffort(GLOBAL, 'deepseek-v4.1-flash', undefined, AbortSignal.timeout(1000))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!['X-Agent-Type']).toBe('main')
    expect(calls[0]!['X-Conversation-ID']).toMatch(/^[0-9a-f]{32}$/)
    expect(calls[0]!['X-Conversation-Request-ID']).toMatch(/^[0-9a-f]{32}$/)
  })
})
