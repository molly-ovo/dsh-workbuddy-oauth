/**
 * Device fingerprint tests.
 *
 * The value of this module is entirely in its invariants: an id that changes
 * between calls is worse than no id at all, because upstream reads it as the
 * account moving to a new device. So these tests are about stability, isolation
 * between accounts and purposes, and correct absence.
 */

import { describe, expect, it } from 'vitest'
import { deriveId, deviceHeaders, requestId, requestIdPrefix } from '../src/fingerprint.ts'

describe('derived ids are stable', () => {
  it('yields the same id for the same account every time', () => {
    // Stability is the whole point: a value that drifts per call is what gets
    // an account flagged as a new device.
    expect(deriveId('machine', 'uid-1')).toBe(deriveId('machine', 'uid-1'))
    expect(deriveId('session', 'uid-1')).toBe(deriveId('session', 'uid-1'))
  })

  it('is lowercase hex of the reference derivation length', () => {
    // md5 hex is 32 characters. The reference projects slice `[:36]`, which is
    // simply the whole digest — kept here so the length is asserted rather
    // than assumed.
    const id = deriveId('machine', 'uid-1')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(id).toHaveLength(32)
  })

  it('reproduces the exact value the reference derivation yields', () => {
    // md5("wb2a:machine:uid-1")[:36], computed independently with node:crypto.
    // Pinning the literal means a change to the namespace, separator or hash
    // fails here rather than silently presenting every account to the upstream
    // as a brand-new device.
    expect(deriveId('machine', 'uid-1')).toBe('5c0d819be032718d987b07c3c9e56bec')
    expect(deriveId('session', 'uid-1')).toBe('0ae75aadeecdbca36c75436e69f81984')
  })
})

describe('ids are isolated', () => {
  it('separates accounts', () => {
    expect(deriveId('machine', 'uid-1')).not.toBe(deriveId('machine', 'uid-2'))
  })

  it('separates purposes for one account', () => {
    // Machine and session must not collide, or the two headers would carry the
    // same value.
    expect(deriveId('machine', 'uid-1')).not.toBe(deriveId('session', 'uid-1'))
  })
})

describe('absence is explicit', () => {
  it('returns undefined for an empty uid instead of a shared id', () => {
    // A constant fallback would make every signed-out caller look like one
    // device; undefined forces the caller to omit the header.
    expect(deriveId('machine', '')).toBeUndefined()
    expect(deviceHeaders('')).toEqual({})
  })

  it('builds both headers once a uid exists', () => {
    const headers = deviceHeaders('uid-1')
    expect(Object.keys(headers).sort()).toEqual(['X-Machine-ID', 'X-Session-ID'])
    expect(headers).toHaveProperty('X-Machine-ID', deriveId('machine', 'uid-1'))
    expect(headers).toHaveProperty('X-Session-ID', deriveId('session', 'uid-1'))
  })
})

describe('request ids', () => {
  it('keeps a stable prefix and a varying suffix', () => {
    // A stable prefix is what lets the upstream group one conversation turn;
    // a varying suffix keeps each call distinct.
    const first = requestId('uid-1', 1_000_001)
    const second = requestId('uid-1', 1_000_002)
    expect(first.startsWith(requestIdPrefix('uid-1'))).toBe(true)
    expect(second.startsWith(requestIdPrefix('uid-1'))).toBe(true)
    expect(first).not.toBe(second)
  })

  it('pads the suffix to a fixed width', () => {
    expect(requestId('uid-1', 5)).toMatch(/-000005$/)
  })

  it('separates accounts by prefix', () => {
    expect(requestIdPrefix('uid-1')).not.toBe(requestIdPrefix('uid-2'))
  })

  it('still yields a usable id without a uid', () => {
    expect(requestIdPrefix('')).toBe('wb2a-anonymous')
    expect(requestId('', 1)).toMatch(/^wb2a-anonymous-/)
  })
})
