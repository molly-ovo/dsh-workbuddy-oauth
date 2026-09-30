/**
 * Cooldown persistence tests.
 *
 * The point is the restart scenario: a failure parks an account, the process
 * goes away, and the next process must still honour the park — otherwise an
 * exhausted account is retried once per restart, which is the exact failure the
 * cooldown exists to avoid. Also covered: expired entries load as absent, a
 * damaged file reads as empty rather than failing selection, and a write is
 * a merge (another window's entry is kept, not clobbered).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  awaitCooldownWrites,
  COOLDOWN_STATE_FILENAME,
  clearCooldowns,
  readCooldowns,
  writeCooldown,
} from '../src/cooldown-state.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-cooldown-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  // Every write started inside the test settles while the temp home is still
  // current: a write suspended past this point would land in the real home
  // directory once the environment below is restored (that race was observed,
  // not hypothetical).
  await awaitCooldownWrites()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('readCooldowns', () => {
  it('reads an empty map when no file exists', async () => {
    await expect(readCooldowns(1000)).resolves.toEqual(new Map())
  })

  it('round-trips a written entry', async () => {
    await writeCooldown('uid-a', 5000, 1000)
    await expect(readCooldowns(1000)).resolves.toEqual(new Map([['uid-a', 5000]]))
  })

  it('drops entries that have already expired instead of serving them', async () => {
    // A stale entry would park a healthy account for nothing on the next start.
    await writeCooldown('uid-old', 2000, 1000)
    await writeCooldown('uid-live', 9000, 1000)
    const loaded = await readCooldowns(3000)
    expect(loaded.has('uid-old')).toBe(false)
    expect(loaded.get('uid-live')).toBe(9000)
  })

  it('reads a damaged file as empty rather than throwing', async () => {
    // Selection must never fail because a state file is corrupt; the cost of
    // a lost cooldown map is one retry, the cost of a throwing read is a
    // broken provider.
    const dir = join(home, 'workbuddy-standalone')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COOLDOWN_STATE_FILENAME), '{not json')
    await expect(readCooldowns(1000)).resolves.toEqual(new Map())
  })

  it('rejects a wrong-format document rather than trusting it', async () => {
    const dir = join(home, 'workbuddy-standalone')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COOLDOWN_STATE_FILENAME), JSON.stringify({ version: 99, cooldowns: { 'uid-a': 5000 } }))
    await expect(readCooldowns(1000)).resolves.toEqual(new Map())
  })
})

describe('writeCooldown', () => {
  it('merges with existing entries instead of replacing the file', async () => {
    // Two DSH windows park different accounts; the second write must keep the
    // first window's entry, the same rule the disabled set follows.
    await writeCooldown('uid-a', 5000, 1000)
    await writeCooldown('uid-b', 6000, 1000)
    await expect(readCooldowns(1000)).resolves.toEqual(new Map([
      ['uid-a', 5000],
      ['uid-b', 6000],
    ]))
  })

  it('overwrites an existing entry for the same uid', async () => {
    await writeCooldown('uid-a', 5000, 1000)
    await writeCooldown('uid-a', 8000, 1000)
    await expect(readCooldowns(1000)).resolves.toEqual(new Map([['uid-a', 8000]]))
  })

  it('writes no file when the entry is unchanged', async () => {
    await writeCooldown('uid-a', 5000, 1000)
    const before = await readFile(join(home, 'workbuddy-standalone', COOLDOWN_STATE_FILENAME), 'utf8')
    await writeCooldown('uid-a', 5000, 1000)
    const after = await readFile(join(home, 'workbuddy-standalone', COOLDOWN_STATE_FILENAME), 'utf8')
    expect(after).toBe(before)
  })

  it('lands the entry in the home current at call time, not at write time', async () => {
    // Regression for an observed race: a fire-and-forget write whose awaits
    // outlived the test used to resolve its directory from the *restored*
    // environment and wrote into the real `~/.dsh`. The path must be captured
    // before the first await.
    const path = join(home, 'workbuddy-standalone', COOLDOWN_STATE_FILENAME)
    const writing = writeCooldown('uid-race', 5000, 1000)
    // Simulate the harness restoring the environment while the write is still
    // in flight; the in-flight write must be unaffected.
    process.env['DSH_HOME'] = savedHome ?? 'C:\\nonexistent-for-test'
    await writing
    process.env['DSH_HOME'] = home
    expect((await readCooldowns(1000)).has('uid-race')).toBe(true)
  })
})

describe('clearCooldowns', () => {
  it('empties the persisted map', async () => {
    await writeCooldown('uid-a', 5000, 1000)
    await clearCooldowns()
    await expect(readCooldowns(1000)).resolves.toEqual(new Map())
  })

  it('succeeds when there is nothing to clear', async () => {
    await expect(clearCooldowns()).resolves.toBeUndefined()
  })
})
