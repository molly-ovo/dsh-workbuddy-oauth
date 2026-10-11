/**
 * Region-scoped body preparation for the `off` effort spelling (#87).
 *
 * The adapter pins `thinkingLevelMap.off` to the literal `'off'` so the level
 * stays selectable, and pi-ai sends that spelling for any request carrying no
 * explicit level — Default and Off serialize identically. Both endpoints reject
 * it, so the strip runs on both region paths. These tests pin that: the CN path
 * gets its own preparer (which must not re-run the shared normalisation), and
 * neither path may ever put the spelling on the wire.
 */

import { describe, expect, it } from 'vitest'
import { prepareChatBody, prepareCnChatBody, prepareInternationalChatBody } from '../src/upstream.ts'

describe('prepareCnChatBody effort handling (issue #87)', () => {
  it("drops the adapter's own `off` spelling on the CN wire too", () => {
    // CN used to pass `off` through by an explicit scope decision ("this
    // endpoint has accepted the spelling in every measurement so far"). #87
    // measured it rejecting the spelling on a validating CN model — HTTP 400 /
    // 11150 「模型不支持该思考强度」 — so the premise no longer holds and the
    // strip is applied here as well.
    const body = JSON.parse(prepareCnChatBody(JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
    // Everything else about the CN body is untouched.
    expect(body['model']).toBe('deepseek-v4.1-flash')
  })

  it('covers Default as well as Off, since both produce the same body', () => {
    // The picker's Default and its Off entry serialize identically: pi-ai fills
    // `thinkingLevelMap.off` whenever no level is given. A fix that only hid
    // the Off menu item would therefore leave Default failing; the request-layer
    // strip is what makes both succeed.
    const explicitOff = prepareCnChatBody(JSON.stringify({ messages: [], reasoning_effort: 'off' }))
    const noLevel = prepareCnChatBody(JSON.stringify({ messages: [] }))
    expect(JSON.parse(explicitOff)).toEqual(JSON.parse(noLevel))
  })

  it('keeps declared spellings and an explicit `none` untouched on CN', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepareCnChatBody(JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: effort,
      })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it('does not re-run the shared normalisation over an already-prepared body', () => {
    // The shim applies `prepareChatBody` before handing the body to chatStream,
    // so this step must only strip — re-normalising would be a second pass over
    // an already-normalised body.
    const prepared = prepareChatBody(JSON.stringify({
      messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    const source = JSON.parse(prepared)
    expect(source['stream']).toBe(true)
    const out = JSON.parse(prepareCnChatBody(prepared))
    // Still normalised exactly once, and no longer carrying the spelling.
    expect(out['stream']).toBe(true)
    expect(out['messages'][0].role).toBe('system')
    expect('reasoning_effort' in out).toBe(false)
  })

  it('returns a non-JSON body unchanged, as the shared preparer does', () => {
    expect(prepareCnChatBody('not json')).toBe('not json')
  })

  it('leaves a JSON array body unchanged rather than re-wrapping it', () => {
    expect(prepareCnChatBody('[1,2]')).toBe('[1,2]')
  })
})

describe('both region paths never send the `off` spelling (issue #87)', () => {
  const REGIONS = [
    ['CN', prepareCnChatBody],
    ['international', prepareInternationalChatBody],
  ] as const

  it.each(REGIONS)('%s drops `off` from the body', (_label, prepare) => {
    const body = JSON.parse(prepare(JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 'sys' }],
      reasoning_effort: 'off',
    })))
    expect('reasoning_effort' in body).toBe(false)
  })

  it.each(REGIONS)('%s omits the field when Default resolves to `off`', (_label, prepare) => {
    // Default and Off serialize identically: pi-ai fills
    // `thinkingLevelMap.off` whenever no level is given. The request layer is
    // what makes both succeed — hiding the Off menu item alone would leave
    // Default failing.
    const explicitOff = prepare(JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'off' }))
    const noLevel = prepare(JSON.stringify({ model: 'm', messages: [] }))
    expect(JSON.parse(explicitOff)).toEqual(JSON.parse(noLevel))
  })

  it.each(REGIONS)('%s leaves every declared spelling and `none` untouched', (_label, prepare) => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none']) {
      const body = JSON.parse(prepare(JSON.stringify({ messages: [], reasoning_effort: effort })))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })

  it.each(REGIONS)('%s keeps the rest of the body intact', (_label, prepare) => {
    const body = JSON.parse(prepare(JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
      reasoning_effort: 'off',
    })))
    expect(body['model']).toBe('m')
    expect(body['max_tokens']).toBe(128)
    // The international path prepends its gateway system prompt; the caller's
    // own message is preserved as the last entry either way.
    const messages = body['messages'] as readonly { role: string; content: string }[]
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'hi' })
  })

  it.each(REGIONS)('%s strips the spelling even with no messages array', (_label, prepare) => {
    // A body without a messages array takes an early return; the strip must
    // still apply, or such a request would reach the endpoint carrying the
    // rejected spelling.
    const body = JSON.parse(prepare(JSON.stringify({ reasoning_effort: 'off' })))
    expect('reasoning_effort' in body).toBe(false)
  })
})
