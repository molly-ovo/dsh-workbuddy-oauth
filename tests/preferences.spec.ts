/**
 * Preferences persistence: the maximum-context-window flag.
 *
 * One boolean survives a restart, so a user's choice must round-trip through
 * disk. The discipline is the same as the other state files: versioned shape,
 * atomic write, and an absent/damaged file reads as the default (`false`).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { awaitPreferenceWrites, readUseMaximumContextWindow, writeUseMaximumContextWindow } from '../src/preferences.ts'

let home = ''
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-pref-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  await awaitPreferenceWrites()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

describe('preferences', () => {
  it('reads absent as the default false', async () => {
    await expect(readUseMaximumContextWindow()).resolves.toBe(false)
  })

  it('round-trips a true value', async () => {
    await writeUseMaximumContextWindow(true)
    await expect(readUseMaximumContextWindow()).resolves.toBe(true)
  })

  it('round-trips back to false', async () => {
    await writeUseMaximumContextWindow(true)
    await writeUseMaximumContextWindow(false)
    await expect(readUseMaximumContextWindow()).resolves.toBe(false)
  })
})
