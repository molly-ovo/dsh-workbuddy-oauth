/**
 * `reasoningFields` tests: the reasoning-level capability of one model row.
 *
 * These pin the precedence the adapter must hold — declared set > observation >
 * default-effort fallback > off-only — because a mistake here is silent in every
 * direction that matters: the wrong precedence either hides levels the upstream
 * supports (the user loses control) or offers levels it rejects (the request
 * fails after the message is durable).
 */

import { describe, expect, it } from 'vitest'
import { reasoningFields } from '../src/adapter.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

function model(reasoning: NonNullable<WorkBuddyModelInfo['reasoning']>): WorkBuddyModelInfo {
  return {
    id: 'm', name: 'M', contextWindow: 100_000, maxTokens: 16_000, supportsImages: true,
    reasoning,
  }
}

const VALIDATING = {
  fingerprint: 'f', validation: 'validating' as const,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  probedAtMs: 1, pluginVersion: 'v', account: 'a',
}

describe('reasoningFields', () => {
  it('reads a non-reasoning model as off-only', () => {
    expect(reasoningFields(model({ supports: false, onlyReasoning: false, canDisableThinking: true })))
      .toEqual({ reasoning: false })
  })

  it('offers the declared set and nothing else', () => {
    const fields = reasoningFields(model({
      supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: true,
    }))
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toEqual({
      off: 'off', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null,
    })
  })

  it('uses a validating observation for an undeclared row', () => {
    const fields = reasoningFields(model({
      supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false,
    }), VALIDATING)
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    })
  })

  it('falls back to the default effort when undeclared and unobserved', () => {
    // The gap this change closes: a reasoning model with no declared set and no
    // observation used to read as off-only, so the picker offered no level at
    // all. It must now offer exactly the upstream's default effort.
    const fields = reasoningFields(model({
      supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false,
    }))
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null,
    })
  })

  it('ignores a non-validating observation and falls back to the default effort', () => {
    const fields = reasoningFields(model({
      supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false,
    }), { ...VALIDATING, validation: 'non-validating', efforts: [] })
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toEqual({
      off: null, minimal: null, low: null, medium: 'medium', high: null, xhigh: null, max: null,
    })
  })

  it('stays off-only when nothing is declared, observed, or defaulted', () => {
    expect(reasoningFields(model({
      supports: true, onlyReasoning: true, canDisableThinking: false,
    }))).toEqual({ reasoning: false })
  })
})
