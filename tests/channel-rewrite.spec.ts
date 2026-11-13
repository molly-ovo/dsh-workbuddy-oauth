/**
 * The content-fingerprint rewrite.
 *
 * The CN gateway compares the `system` message against a literal blocklist of
 * third-party harness prompts. Rewriting the matched phrases keeps the
 * instructions in `system` (their authority intact) instead of demoting the
 * message to `user`. The invariants that matter: only the scanned roles are
 * touched, a body with no match comes back byte-for-byte, and the table is
 * idempotent so a retry cannot double-rewrite.
 */

import { describe, expect, it } from 'vitest'
import { rewriteChannelFingerprints, rewriteChannelPhrases } from '../src/channel-rewrite.ts'

const SYSTEM = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the deepseek-v4.1-flash model.'

describe('rewriteChannelPhrases', () => {
  it('neutralizes the identity opener the gateway matches', () => {
    const out = rewriteChannelPhrases(SYSTEM)
    expect(out).toContain('You are an AI agent running inside DeepSeek Harness')
    expect(out).not.toContain('You are an AI agent powered by DeepSeek Harness')
  })

  it('rewrites the @-paths paragraph sentence by sentence', () => {
    const paragraph = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.'
    const out = rewriteChannelPhrases(paragraph)
    expect(out).toContain('Paths that begin with @')
    expect(out).toContain('Relative paths are resolved against the workspace root')
    expect(out).toContain('absolute paths point at files or directories on the host.')
  })

  it('handles the truncated form that has no trailing semicolon', () => {
    // The host cuts this paragraph at the trigger boundary, so the literal must
    // match without punctuation.
    expect(rewriteChannelPhrases('Relative paths resolve from the workspace root'))
      .toBe('Relative paths are resolved against the workspace root')
  })

  it('returns unmatched text untouched', () => {
    const plain = 'hello world, nothing to see here'
    expect(rewriteChannelPhrases(plain)).toBe(plain)
  })

  it('is idempotent', () => {
    const once = rewriteChannelPhrases(SYSTEM)
    expect(rewriteChannelPhrases(once)).toBe(once)
  })
})

describe('rewriteChannelFingerprints', () => {
  it('rewrites the system message and keeps its role', () => {
    const body = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: '你好' }],
    })
    const parsed = JSON.parse(rewriteChannelFingerprints(body)) as { messages: Array<{ role: string; content: string }> }
    expect(parsed.messages[0]?.role).toBe('system')
    expect(parsed.messages[0]?.content).toContain('running inside DeepSeek Harness')
  })

  it('leaves the user turn alone', () => {
    const userText = 'You are an AI agent powered by DeepSeek Harness'
    const body = JSON.stringify({ messages: [{ role: 'user', content: userText }] })
    // Rewriting what the human typed would be editing their message.
    expect(rewriteChannelFingerprints(body)).toBe(body)
  })

  it('returns the identical string when nothing matches', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 'plain instructions' }],
    })
    expect(rewriteChannelFingerprints(body)).toBe(body)
  })

  it('rewrites text blocks in the content-array form', () => {
    const body = JSON.stringify({
      messages: [{ role: 'system', content: [{ type: 'text', text: SYSTEM }] }],
    })
    const parsed = JSON.parse(rewriteChannelFingerprints(body)) as { messages: Array<{ content: Array<{ text: string }> }> }
    expect(parsed.messages[0]?.content[0]?.text).toContain('running inside DeepSeek Harness')
  })

  it('returns an unparseable body unchanged', () => {
    expect(rewriteChannelFingerprints('not json')).toBe('not json')
  })
})
