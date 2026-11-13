/**
 * The failure-shape diagnostic (`describeChatBody`).
 *
 * Purpose: a `400` from the WorkBuddy gateway names no field — the host shows
 * only 「请求被拦截，请重新发送」 — so the log has to carry enough structure to
 * identify the offending branch (unknown key, `developer` role, tool payload)
 * while staying safe to paste into a public issue. These tests pin both halves:
 * the structure is present, and **no message text or tool schema leaks**.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkBuddyShim, describeChatBody } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import type { CredentialStore } from '../src/store.ts'

const BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [
    { role: 'developer', content: 'SECRET SYSTEM PROMPT' },
    { role: 'user', content: 'SECRET USER TEXT' },
  ],
  tools: [{ type: 'function', function: { name: 'Read', description: 'SECRET TOOL DESC', parameters: {} } }],
})

describe('describeChatBody', () => {
  it('names the keys, the role sequence and the tool count', () => {
    const summary = describeChatBody(BODY)
    expect(summary).toContain('developer user')
    expect(summary).toContain('tools=1')
    expect(summary).toContain('messages=2')
    expect(summary).toContain('deepseek-v4.1-flash')
    expect(summary).toContain('keys=[messages model stream tools]')
  })

  it('carries no message text, tool description or parameter names', () => {
    const summary = describeChatBody(BODY)
    expect(summary).not.toContain('SECRET')
    expect(summary).not.toContain('Read')
  })

  it('reports an unparseable body by size instead of throwing', () => {
    expect(describeChatBody('not json')).toBe('unparseable body, 8 bytes')
  })

  it('truncates a long role list rather than dumping the conversation', () => {
    const long = JSON.stringify({
      messages: Array.from({ length: 20 }, () => ({ role: 'user', content: 'x' })),
    })
    const summary = describeChatBody(long)
    expect(summary).toContain('messages=20')
    expect(summary).toContain('…')
  })
})

describe('failing-request archive', () => {
  const savedHome = process.env['DSH_HOME']
  const savedFlag = process.env['DSH_WORKBUDDY_DUMP_REQUEST']
  let home: string | undefined

  afterEach(async () => {
    if (savedHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = savedHome
    if (savedFlag === undefined) delete process.env['DSH_WORKBUDDY_DUMP_REQUEST']
    else process.env['DSH_WORKBUDDY_DUMP_REQUEST'] = savedFlag
    if (home !== undefined) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  /** Drive one request whose upstream answer is a client-shaped 400. */
  async function request(homeDir: string): Promise<void> {
    process.env['DSH_HOME'] = homeDir
    const store: CredentialStore = {
      async resolve() {
        return {
          accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3_600_000,
          domain: 'copilot.tencent.com', uid: 'uid-a', region: 'cn',
        }
      },
      async current() { return undefined },
      noteFailure() {},
      async clearFailure() {},
    }
    const shim = createWorkBuddyShim({
      store,
      client: {
        chatStream: async () => ({ ok: false as const, status: 400, kind: 'client' as const, message: '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}' }),
      } as never,
      catalog: new WorkBuddyCatalog(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    await shim.ready
    await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'INSTRUCTIONS' }, { role: 'user', content: 'hi' }] }),
    })
    await shim.close()
  }

  it('writes nothing by default — a released plugin does not archive prompts', async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-dump-off-'))
    delete process.env['DSH_WORKBUDDY_DUMP_REQUEST']
    await request(home)
    await expect(access(join(home, 'workbuddy-oauth', 'last-failed-request.json'))).rejects.toThrow()
  })

  it('archives the body when the operator opts in', async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-dump-on-'))
    process.env['DSH_WORKBUDDY_DUMP_REQUEST'] = '1'
    await request(home)
    const text = await readFile(join(home, 'workbuddy-oauth', 'last-failed-request.json'), 'utf8')
    expect(text).toContain('INSTRUCTIONS')
  })
})
