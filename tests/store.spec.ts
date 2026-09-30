/**
 * Credential store tests.
 *
 * The store is the seam between this plugin's OAuth credentials and the ported
 * shim/adapter, so what matters is the selection rule and the refresh-on-expiry
 * behavior — not the file I/O, which `credentials.spec.ts` already covers.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeCredential, type WorkBuddyCredential } from '../src/credentials.ts'
import { NotSignedInError, chooseCredential, createCredentialStore } from '../src/store.ts'
import type { RefreshOutcome } from '../src/refresh.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-store-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

function credential(uid: string, overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: `at-${uid}`,
    refreshToken: `rt-${uid}`,
    expiresAtMs: Date.now() + 3_600_000,
    domain: 'copilot.tencent.com',
    uid,
    region: 'cn',
    ...overrides,
  }
}

describe('credential selection', () => {
  it('returns undefined when nothing is stored', () => {
    expect(chooseCredential([])).toBeUndefined()
  })

  it('prefers a live token over an expired one', () => {
    // Serving from a live account avoids spending a rotation on a request that
    // another account could answer as-is.
    const expired = credential('uid-a', { expiresAtMs: Date.now() - 1 })
    const live = credential('uid-z')
    expect(chooseCredential([expired, live])?.uid).toBe('uid-z')
  })

  it('falls back to an expired account when that is all there is', () => {
    // Refusing here would make a single-account install unusable whenever its
    // token happened to lapse; the store refreshes instead.
    const expired = credential('uid-a', { expiresAtMs: Date.now() - 1 })
    expect(chooseCredential([expired])?.uid).toBe('uid-a')
  })

  it('is stable across calls rather than alternating', () => {
    // Alternating accounts would multiply credential traffic and, upstream,
    // look like several devices sharing work.
    const pool = [credential('uid-c'), credential('uid-a'), credential('uid-b')]
    expect(chooseCredential(pool)?.uid).toBe('uid-a')
    expect(chooseCredential([...pool].reverse())?.uid).toBe('uid-a')
  })
})

describe('resolve', () => {
  it('throws NotSignedIn when no account exists', async () => {
    const store = createCredentialStore()
    await expect(store.resolve()).rejects.toBeInstanceOf(NotSignedInError)
  })

  it('returns the live credential without refreshing', async () => {
    await writeCredential(credential('uid-a'))
    const refresh = vi.fn()
    const store = createCredentialStore({ refresh: refresh as never })

    const resolved = await store.resolve()
    expect(resolved.uid).toBe('uid-a')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes an expired credential and returns the committed result', async () => {
    await writeCredential(credential('uid-a', { expiresAtMs: Date.now() - 1 }))
    const refreshed = credential('uid-a', { accessToken: 'fresh' })
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => {
      // Simulate the real path committing to disk before returning.
      await writeCredential(refreshed)
      return { status: 'refreshed', credential: refreshed }
    })

    const store = createCredentialStore({ refresh: refresh as never })
    const resolved = await store.resolve()
    expect(refresh).toHaveBeenCalledWith('uid-a')
    expect(resolved.accessToken).toBe('fresh')
  })

  it('reports a refresh failure as a sign-in problem', async () => {
    await writeCredential(credential('uid-a', { expiresAtMs: Date.now() - 1 }))
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ status: 'failed', reason: '会话已失效' }))

    const store = createCredentialStore({ refresh: refresh as never })
    // Retrying cannot help and the user's action is the same either way, so it
    // is reported as NotSignedIn rather than a transient error.
    await expect(store.resolve()).rejects.toBeInstanceOf(NotSignedInError)
    await expect(store.resolve()).rejects.toThrow(/会话已失效/)
  })

  it('does not refresh a credential with no refresh token, and still serves it', async () => {
    await writeCredential(credential('uid-a', { refreshToken: '', expiresAtMs: Date.now() - 1 }))
    const refresh = vi.fn()
    const store = createCredentialStore({ refresh: refresh as never })

    // `needsRefresh` is false without a refresh token, so the store serves what
    // it has; upstream will reject it and the user is told to sign in again.
    const resolved = await store.resolve()
    expect(resolved.uid).toBe('uid-a')
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('current', () => {
  it('reports the chosen account without refreshing', async () => {
    await writeCredential(credential('uid-a', { expiresAtMs: Date.now() - 1 }))
    const refresh = vi.fn()
    const store = createCredentialStore({ refresh: refresh as never })

    const current = await store.current()
    expect(current?.uid).toBe('uid-a')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('is undefined before any sign-in', async () => {
    await expect(createCredentialStore().current()).resolves.toBeUndefined()
  })
})
