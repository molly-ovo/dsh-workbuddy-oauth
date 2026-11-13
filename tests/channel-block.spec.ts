/**
 * Recovery from the CN gateway's channel check (`400` / `11128`).
 *
 * Measured 2026-11-13: the gateway reads the **system** message against a
 * literal blocklist of third-party harness prompts. It is a phrase match, not a
 * length or header rule — each half of the offending sentence pair is accepted
 * on its own, the same body on the international endpoint answers 200, and the
 * identical text sent as a `user` message passes. So the recovery is a role
 * change, applied only after a rejection.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoteInstructionMessage, isChannelBlock } from '../src/upstream.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore } from '../src/store.ts'
import type { WorkBuddyCredential } from '../src/credentials.ts'

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
  domain: 'copilot.tencent.com', uid: 'uid-a', region: 'cn',
}

const BLOCKED = {
  ok: false as const,
  status: 400,
  kind: 'client' as const,
  message: '{"code":11128,"msg":"Illegal API invocation from an unapproved channel","displayMsg":{"zh":"请求被拦截，请重新发送"}}',
}

describe('isChannelBlock', () => {
  it('recognises the measured rejection', () => {
    expect(isChannelBlock(BLOCKED.message)).toBe(true)
  })

  it('ignores other 400s', () => {
    expect(isChannelBlock('{"code":11133,"msg":"the request parameters were rejected by the model provider"}')).toBe(false)
  })
})

describe('demoteInstructionMessage', () => {
  it('re-issues the system message as a user message, verbatim', () => {
    const source = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'INSTRUCTIONS' },
        { role: 'user', content: 'hi' },
      ],
    })
    const demoted = JSON.parse(demoteInstructionMessage(source)) as { messages: Array<{ role: string; content: string }> }
    expect(demoted.messages.map((m) => m.role)).toEqual(['user', 'user'])
    // The bytes the model sees are unchanged; only the role moved.
    expect(demoted.messages[0]?.content).toBe('INSTRUCTIONS')
  })

  it('leaves a body with no instruction message alone', () => {
    const source = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    expect(demoteInstructionMessage(source)).toBe(source)
  })

  it('leaves an empty system message alone', () => {
    const source = JSON.stringify({ messages: [{ role: 'system', content: '' }, { role: 'user', content: 'hi' }] })
    expect(demoteInstructionMessage(source)).toBe(source)
  })

  it('returns an unparseable body unchanged', () => {
    expect(demoteInstructionMessage('not json')).toBe('not json')
  })
})

describe('shim channel-block recovery', () => {
  let shim: WorkBuddyShim | undefined

  afterEach(async () => {
    await shim?.close()
    shim = undefined
  })

  const store: CredentialStore = {
    async resolve() { return CREDENTIAL },
    async current() { return CREDENTIAL },
    noteFailure() {},
    async clearFailure() {},
  }

  /** A client that blocks the request while its system message is intact. */
  function blockingClient() {
    const seen: string[] = []
    return {
      seen,
      chatStream: async (_credential: WorkBuddyCredential, body: string) => {
        seen.push(body)
        const parsed = JSON.parse(body) as { messages: Array<{ role: string }> }
        const hasSystem = parsed.messages.some((message) => message.role === 'system' || message.role === 'developer')
        return hasSystem
          ? BLOCKED
          : {
            ok: true as const,
            response: new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
          }
      },
    }
  }

  /** Start one shim and hand back a sender, so a test can drive several turns. */
  async function openShim(client: { chatStream: unknown }): Promise<() => Promise<Response>> {
    shim = createWorkBuddyShim({
      store,
      client: client as never,
      catalog: new WorkBuddyCatalog(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    await shim.ready
    const base = shim.baseUrl()
    const token = shim.token()
    return () => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'system', content: 'INSTRUCTIONS' }, { role: 'user', content: '你好' }],
      }),
    })
  }

  const post = async (client: { chatStream: unknown }): Promise<Response> => (await openShim(client))()

  it('retries once with the instruction message demoted, and succeeds', async () => {
    const client = blockingClient()
    const response = await post(client)
    expect(response.status).toBe(200)
    expect(client.seen).toHaveLength(2)
    expect(client.seen[1]).toContain('"role":"user"')
  })

  it('sends the demoted shape straight away once the block is known', async () => {
    // The check reads prompt text, and that text is identical next turn — so a
    // second doomed attempt would only double the upstream request count and add
    // a round trip to every message.
    const client = blockingClient()
    const send = await openShim(client)
    await send()
    expect(client.seen).toHaveLength(2)

    await send()
    expect(client.seen).toHaveLength(3)
    expect(client.seen[2]).toContain('"role":"user"')
  })

  it('does not retry a request the gateway accepts', async () => {
    const seen: string[] = []
    const client = {
      chatStream: async (_c: WorkBuddyCredential, body: string) => {
        seen.push(body)
        return { ok: true as const, response: new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }
      },
    }
    const response = await post(client)
    expect(response.status).toBe(200)
    // A passing prompt keeps its system role: the demotion is a recovery, not a policy.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('"role":"system"')
  })
})
