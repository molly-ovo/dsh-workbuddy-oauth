/**
 * Hidden-model persistence and catalog filtering.
 *
 * Two halves that must agree: the persisted per-region id set, and the catalog's
 * filter that drops those ids from `current()` (which is what the adapter and
 * the model picker read). A restart must not resurrect a model the user hid, and
 * a catalog refresh (which replaces the roster wholesale) must keep the hidden
 * set, because the rule is about ids, not the rows that happened to be present.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.ts'
import { HIDDEN_MODELS_FILENAME, awaitHiddenModelWrites, readHiddenModels, setRegionHiddenModels } from '../src/hidden-models.ts'

let home = ''
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-hidden-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  await awaitHiddenModelWrites()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('hidden-models state', () => {
  it('round-trips a region and preserves the other region', async () => {
    await setRegionHiddenModels('cn', ['hy3', 'glm-5.3'])
    await setRegionHiddenModels('global', ['gpt-5.5'])
    await expect(readHiddenModels()).resolves.toEqual({ cn: ['glm-5.3', 'hy3'], global: ['gpt-5.5'] })
  })

  it('reads an absent or damaged file as both regions empty', async () => {
    await expect(readHiddenModels()).resolves.toEqual({ cn: [], global: [] })
    const dir = join(home, 'workbuddy-oauth')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, HIDDEN_MODELS_FILENAME), '{not json')
    await expect(readHiddenModels()).resolves.toEqual({ cn: [], global: [] })
  })

  it('replaces a region wholesale rather than merging with the previous set', async () => {
    // A toggle computes the whole next set and writes it; re-writing the old ids
    // would resurrect a model the user un-hid.
    await setRegionHiddenModels('cn', ['a', 'b', 'c'])
    await setRegionHiddenModels('cn', ['a'])
    await expect(readHiddenModels()).resolves.toEqual({ cn: ['a'], global: [] })
  })
})

describe('WorkBuddyCatalog hidden filtering', () => {
  it('drops hidden ids from current() and reports them back', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    const [first, second] = FALLBACK_WORKBUDDY_MODELS
    expect(catalog.setHiddenModels(new Set([first!.id, second!.id]))).toBe(true)
    expect(catalog.current().map(model => model.id)).not.toContain(first!.id)
    expect(catalog.current().map(model => model.id)).not.toContain(second!.id)
    expect([...catalog.hiddenModelIds()].sort()).toEqual([first!.id, second!.id].sort())
  })

  it('survives a roster replacement: the rule is about ids, not rows', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    const hiddenId = FALLBACK_WORKBUDDY_MODELS[0]!.id
    catalog.setHiddenModels(new Set([hiddenId]))
    // A catalog refresh replaces the whole roster with fresh rows.
    catalog.set([...FALLBACK_WORKBUDDY_MODELS])
    expect(catalog.current().map(model => model.id)).not.toContain(hiddenId)
  })

  it('reports no change when the set is identical, so the caller skips invalidation', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    const id = FALLBACK_WORKBUDDY_MODELS[0]!.id
    expect(catalog.setHiddenModels(new Set([id]))).toBe(true)
    expect(catalog.setHiddenModels(new Set([id]))).toBe(false)
  })

  it('ignores visibility for the fallback roster, which is read pre-sign-in', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    catalog.setHiddenModels(new Set(FALLBACK_WORKBUDDY_MODELS.map(model => model.id)))
    // fallback() deliberately bypasses visibility so a signed-out read still
    // has rows to describe; the hidden set governs only the picker roster.
    expect(catalog.fallback().length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
  })

  it('keeps hidden ids in roster() so the card can un-hide them', () => {
    // Regression: hiding a model dropped it from `current()`, which was also the
    // list the card rendered — so the row vanished the moment it was hidden and
    // there was nothing left to un-check. `roster()` is the wider view the card
    // reads: every model stays listed, only the checkbox state changes.
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    const [first, second] = FALLBACK_WORKBUDDY_MODELS
    catalog.setHiddenModels(new Set([first!.id, second!.id]))
    expect(catalog.current().map(model => model.id)).not.toContain(first!.id)
    expect(catalog.roster().map(model => model.id)).toContain(first!.id)
    expect(catalog.roster().map(model => model.id)).toContain(second!.id)
    expect(catalog.roster().length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
  })

  it('roster() is empty while the catalog is hidden, like current()', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    catalog.setVisible(false)
    expect(catalog.roster()).toEqual([])
    expect(catalog.current()).toEqual([])
  })

  it('reports the maximum-context-window flag through its getter', () => {
    const catalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS)
    expect(catalog.isUsingMaximumContextWindow()).toBe(false)
    expect(catalog.setUseMaximumContextWindow(true)).toBe(true)
    expect(catalog.isUsingMaximumContextWindow()).toBe(true)
    // A no-op toggle reports false so the caller can skip invalidation.
    expect(catalog.setUseMaximumContextWindow(true)).toBe(false)
  })
})
