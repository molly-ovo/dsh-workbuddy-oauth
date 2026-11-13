/**
 * `pi-ai-guard` tests: the load-time diagnostic for a shadowed pi-ai copy (#92).
 *
 * The failure this guards against is opaque — every request dies at
 * `PI_AI_ERROR` before any upstream HTTP — so the one thing the message must do
 * is name both versions. These tests also pin what it must *not* leak: the
 * module reads a resolved filesystem path to find the manifest, and that path
 * must never reach a log line.
 */

import { describe, expect, it } from 'vitest'
import { piAiVersionWarning, REQUIRED_PI_AI_VERSION, resolvedPiAiVersion } from '../src/pi-ai-guard.ts'

describe('piAiVersionWarning', () => {
  it('stays silent when the resolved copy is the required generation', () => {
    expect(piAiVersionWarning(REQUIRED_PI_AI_VERSION)).toBeUndefined()
  })

  it('stays silent for an explicitly undefined version', () => {
    // Must not fall back to a live resolution: the plugin cannot determine the
    // version, and that is not a mismatch. Falling back would make this
    // assertion vacuous (and, on a matching install, pass for the wrong reason).
    expect(piAiVersionWarning(undefined)).toBeUndefined()
  })

  it('stays silent on a live resolution that matches', () => {
    expect(piAiVersionWarning()).toBeUndefined()
    expect(resolvedPiAiVersion()).toBe(REQUIRED_PI_AI_VERSION)
  })

  it('names both versions and the shadowing setup for an older copy', () => {
    const warning = piAiVersionWarning('0.82.1')
    expect(warning).toBeDefined()
    expect(warning).toContain('0.82.1')
    expect(warning).toContain(REQUIRED_PI_AI_VERSION)
    // The two profile settings that produce the situation #92 measured.
    expect(warning).toContain('hoisted')
    expect(warning).toContain('autoInstallPeers')
  })

  it('reports a copy from another major generation', () => {
    // The host's own `dsh-llm-pi-ai` declares `^1.3.0`, so any 1.x is a
    // legitimate peer resolution; a 2.x copy is a different generation and the
    // one case worth interrupting the log for.
    const warning = piAiVersionWarning('2.0.0')
    expect(warning).toBeDefined()
    expect(warning).toContain('2.0.0')
    expect(warning).toContain(REQUIRED_PI_AI_VERSION)
  })

  it('stays silent inside the supported major line', () => {
    // The exact patch is the host's choice, not this plugin's: 1.3.0 is the
    // floor the host declares and 1.5.x may already be shipping in a newer
    // build. Neither is a mismatch.
    expect(piAiVersionWarning('1.3.0')).toBeUndefined()
    expect(piAiVersionWarning('1.5.2')).toBeUndefined()
  })

  it('carries no absolute filesystem path', () => {
    const warning = piAiVersionWarning('0.82.1') ?? ''
    expect(warning).not.toMatch(/(?:^|\s)\//u)
    expect(warning).not.toMatch(/node_modules/u)
    expect(warning).not.toMatch(/Users|home/u)
  })

  it('carries no plugin prefix of its own', () => {
    // The caller logs it under its own prefix; a second one would read as two
    // plugins reporting.
    const warning = piAiVersionWarning('0.82.1') ?? ''
    expect(warning).not.toMatch(/dsh-workbuddy-oauth/u)
  })

  it('does not assert a single cause', () => {
    // A hoisted profile root is the case #92 measured, but an installer can
    // leave the wrong copy behind too, and a version string cannot tell them
    // apart. The message asks the reader to check rather than declare why.
    const warning = piAiVersionWarning('0.82.1') ?? ''
    expect(warning).not.toMatch(/is shadowing it|because|definitely|certainly/u)
    expect(warning).toMatch(/check/u)
  })
})

describe('resolvedPiAiVersion', () => {
  it('reads the version of the copy Node resolves for this module', () => {
    // Guards the resolver itself: if the walk-up stops finding the manifest,
    // every warning above becomes silently unreachable.
    expect(resolvedPiAiVersion()).toBe(REQUIRED_PI_AI_VERSION)
  })
})
