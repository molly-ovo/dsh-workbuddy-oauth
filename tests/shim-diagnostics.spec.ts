/**
 * The failure-shape diagnostic (`describeChatBody`).
 *
 * Purpose: a `400` from the WorkBuddy gateway names no field — the host shows
 * only 「请求被拦截，请重新发送」 — so the log has to carry enough structure to
 * identify the offending branch (unknown key, `developer` role, tool payload)
 * while staying safe to paste into a public issue. These tests pin both halves:
 * the structure is present, and **no message text or tool schema leaks**.
 */

import { describe, expect, it } from 'vitest'
import { describeChatBody } from '../src/shim.ts'

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
