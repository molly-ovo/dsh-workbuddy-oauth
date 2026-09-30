/**
 * Error classification tests, driven by the shapes the upstream actually sends.
 *
 * These exist because of a measured mismatch: a genuinely exhausted CN account
 * answers **HTTP 429** with `{"error":{"data":{"code":14018,"msg":"额度已用尽…"}}}`
 * — not the 402 the marker list assumed, and with wording (「额度**已**用尽」) that
 * the earlier list (「额度用尽」) did not contain. The result was that "out of
 * credit" — a condition that lasts until the user pays — was classified as
 * `soft_rate`, a condition that clears on its own, so the pool retried the dead
 * account every cooldown instead of parking it for an hour.
 *
 * The ordering assertions matter as much as the marker ones: credit is checked
 * before the 429 → soft_rate fallback, because otherwise 429 wins and the real
 * case never reaches the markers.
 */

import { describe, expect, it } from 'vitest'
import { classifyUpstreamError } from '../src/upstream.ts'

/** The exact body a measured exhausted CN account returns. */
const EXHAUSTION_BODY =
  '{"error":{"data":{"code":14018,"msg":"额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage "}}}'

describe('classifyUpstreamError', () => {
  it('classifies the measured exhaustion response as hard_credit despite being a 429', () => {
    // The decisive case: 429 would otherwise fall through to `soft_rate`, and
    // the pool would retry an account that cannot recover by waiting.
    expect(classifyUpstreamError(429, EXHAUSTION_BODY)).toBe('hard_credit')
  })

  it('recognizes the exhaustion business code 14018 on any status', () => {
    expect(classifyUpstreamError(400, 'code 14018 somewhere')).toBe('hard_credit')
    expect(classifyUpstreamError(200, '{"data":{"code":14018}}')).toBe('hard_credit')
  })

  it('recognizes the plain and 已 wording variants', () => {
    for (const wording of ['额度已用尽', '额度用尽', '额度不足', '积分不足', 'insufficient credit']) {
      expect(classifyUpstreamError(429, `xx ${wording} xx`)).toBe('hard_credit')
    }
  })

  it('still reads a real 402 as hard_credit', () => {
    expect(classifyUpstreamError(402, '{}')).toBe('hard_credit')
  })

  it('keeps rate limiting distinct from exhaustion', () => {
    // A rate limit clears by itself, so it must cool briefly rather than for an
    // hour; conflating the two is what the measured response used to cause.
    expect(classifyUpstreamError(429, '{"code":6004,"msg":"usage exceeds frequency limit"}')).toBe('soft_rate')
    expect(classifyUpstreamError(429, '{"code":1234,"msg":"too many requests"}')).toBe('soft_rate')
  })

  it('keeps the non-parking classes intact', () => {
    expect(classifyUpstreamError(401, '{}')).toBe('session_dead')
    expect(classifyUpstreamError(401, '{"msg":"Offline user session not found"}')).toBe('session_dead')
    expect(classifyUpstreamError(404, '{}')).toBe('not_found')
    expect(classifyUpstreamError(500, '{}')).toBe('server')
    expect(classifyUpstreamError(400, '{"code":11101,"msg":"bad json"}')).toBe('client')
  })
})
