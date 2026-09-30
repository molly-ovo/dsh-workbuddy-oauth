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
import { setAccountDisabled } from '../src/account-state.ts'
import { awaitCooldownWrites } from '../src/cooldown-state.ts'
import { NotSignedInError, chooseRotating, createCredentialStore } from '../src/store.ts'
import type { RefreshOutcome } from '../src/refresh.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-store-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  // Settle fire-and-forget cooldown writes before the environment is restored
  // and the temp home is deleted: an in-flight write holds the file lock, and
  // deleting under it fails with EBUSY/ENOTEMPTY (observed).
  await awaitCooldownWrites()
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

describe('disabled accounts', () => {
  it('excludes a disabled account from selection', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    await setAccountDisabled('uid-a', true)

    const store = createCredentialStore()
    const current = await store.current()
    expect(current?.uid).toBe('uid-b')
  })

  it('falls back to a disabled account only when nothing else is left', async () => {
    await writeCredential(credential('uid-a'))
    await setAccountDisabled('uid-a', true)

    // No enabled account remains, so the store reports nothing selectable
    // rather than spending a disabled account's token.
    await expect(createCredentialStore().current()).resolves.toBeUndefined()
  })
})

describe('chooseRotating', () => {
  const pool = [credential('uid-a'), credential('uid-b'), credential('uid-c')]
  const now = Date.now()

  it('returns undefined for an empty pool', () => {
    expect(chooseRotating([], 0, new Map(), now)).toBeUndefined()
  })

  it('rotates across accounts in ring order', () => {
    let cursor = 0
    const first = chooseRotating(pool, cursor, new Map(), now)
    cursor = first?.nextCursor ?? 0
    const second = chooseRotating(pool, cursor, new Map(), now)

    expect(first?.credential.uid).toBe('uid-a')
    expect(second?.credential.uid).toBe('uid-b')
    // The cursor always advances, so a long-running pool spreads load instead
    // of pinning the lexicographically-first account.
    expect(first?.nextCursor).toBe(1)
    expect(second?.nextCursor).toBe(2)
  })

  it('skips a cooled-out account', () => {
    const cooled = new Map([['uid-a', now + 60_000]])
    const chosen = chooseRotating(pool, 0, cooled, now)
    expect(chosen?.credential.uid).toBe('uid-b')
  })

  it('serves the soonest-to-recover account when all are cooled out', () => {
    const cooled = new Map([
      ['uid-a', now + 120_000],
      ['uid-b', now + 30_000],
      ['uid-c', now + 60_000],
    ])
    const chosen = chooseRotating(pool, 0, cooled, now)
    expect(chosen?.credential.uid).toBe('uid-b')
  })

  it('prefers a live token over an expired one, even under rotation', () => {
    const expiredA = credential('uid-a', { expiresAtMs: now - 1 })
    const mixed = [expiredA, credential('uid-b'), credential('uid-c')]
    const chosen = chooseRotating(mixed, 0, new Map(), now)
    // uid-a is expired, so it is dropped from the live set and rotation starts
    // from the first *live* account.
    expect(chosen?.credential.uid).toBe('uid-b')
  })

  it('is stable for a single account regardless of cursor', () => {
    for (const cursor of [0, 1, 7]) {
      const chosen = chooseRotating([credential('uid-a')], cursor, new Map(), now)
      expect(chosen?.credential.uid).toBe('uid-a')
    }
  })
})

describe('failure cooldown via the store', () => {
  it('parks a failed account out of the next selection', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const store = createCredentialStore()

    store.noteFailure('uid-a', Date.now() + 60_000)
    const current = await store.current()
    expect(current?.uid).toBe('uid-b')
  })

  it('clears naturally when the cooldown passes', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const store = createCredentialStore()

    store.noteFailure('uid-a', Date.now() + 1)
    await new Promise(resolve => setTimeout(resolve, 10))
    const current = await store.current()
    // After the deadline passes, uid-a is ready again and (cursor 0) is picked.
    expect(current?.uid).toBe('uid-a')
  })

  it('honours a persisted cooldown after the store is rebuilt', async () => {
    // The restart scenario: a failure parks uid-a, the process goes away, and a
    // fresh store (what a DSH restart builds) must still honour the park —
    // otherwise an exhausted account is retried on every restart.
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const first = createCredentialStore()
    first.noteFailure('uid-a', Date.now() + 60_000)
    // Deterministic: wait for the fire-and-forget persistence write, rather
    // than sleeping and hoping.
    await awaitCooldownWrites()

    const second = createCredentialStore()
    expect((await second.current())?.uid).toBe('uid-b')
  })

  it('does not resurrect an expired persisted cooldown', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const first = createCredentialStore()
    first.noteFailure('uid-a', Date.now() + 20)
    await awaitCooldownWrites()
    await new Promise(resolve => setTimeout(resolve, 30))

    // The deadline passed: the fresh store must serve uid-a again, not park it
    // forever because a stale entry stayed on disk.
    const second = createCredentialStore()
    expect((await second.current())?.uid).toBe('uid-a')
  })
})

describe('session affinity', () => {
  it('keeps one conversation on one account', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const store = createCredentialStore()

    const first = await store.resolve('session-1')
    const second = await store.resolve('session-1')

    // Rotation would move to uid-b on the second call; affinity must keep the
    // conversation pinned to whichever account it landed on first.
    expect(first.uid).toBe('uid-a')
    expect(second.uid).toBe(first.uid)
  })

  it('does not let affinity bypass a cooled account', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const store = createCredentialStore()

    const first = await store.resolve('session-1')
    expect(first.uid).toBe('uid-a')
    // uid-a fails, so the next turn in the same conversation must NOT keep using
    // it — affinity is subordinated to cooldown.
    store.noteFailure('uid-a', Date.now() + 60_000)
    const second = await store.resolve('session-1')
    expect(second.uid).toBe('uid-b')
  })

  it('treats distinct conversations independently', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const store = createCredentialStore()

    const one = await store.resolve('session-1')
    const two = await store.resolve('session-2')
    // Two conversations rotate independently, so they land on different accounts
    // (cursor advances once per un-pinned selection).
    expect(one.uid).toBe('uid-a')
    expect(two.uid).toBe('uid-b')
  })

  it('does not bind affinity for a session-less request', async () => {
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    const store = createCredentialStore()

    // No session key → pure rotation, no pin created, so the second call moves on.
    const first = await store.resolve()
    const second = await store.resolve()
    expect(first.uid).toBe('uid-a')
    expect(second.uid).toBe('uid-b')
  })
})
