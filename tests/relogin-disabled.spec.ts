/**
 * The "disabled account comes back disabled after signing in again" bug.
 *
 * Reported from real use: an account was disabled, then signed out, then signed
 * in again — and the fresh sign-in still showed as disabled. The credential was
 * stored correctly; what survived was the uid in `disabled-accounts.json`, and
 * `completeLogin` never cleared it. Nothing selects the account, every surface
 * reports it disabled, and the user has no way to tell why.
 *
 * These drive the real `apply()` and the real account-state file, so they pin
 * the interaction between the two rather than either one alone. The OAuth
 * exchange itself is stubbed at the `fetch` boundary, which is the only way to
 * reach `completeLogin` without a live upstream.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { disabledUids, setAccountDisabled } from '../src/account-state.ts'
import { listCredentials } from '../src/credentials.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-relogin-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  vi.unstubAllGlobals()
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

/** The uid the stubbed upstream reports. */
const UID = 'uid-relogin'

/** Command handlers captured by the context stub. */
const registeredCommands = new Map<
  string,
  (invocation: { rawInput: string; agent?: unknown; signal: AbortSignal }) => Promise<unknown>
>()

/** A context stub that records every registered command handler. */
function commandContext(): Context {
  registeredCommands.clear()
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    llm: { registerAdapter: () => () => {} },
    commands: {
      register(definition: { name: string; handler: never }) {
        registeredCommands.set(definition.name, definition.handler)
        return () => {}
      },
    },
    /**
     * The sign-in path confirms through `userQuestions`; without it the command
     * degrades to printing the link and never completes. This answers the single
     * confirmation the flow asks for.
     */
    get: (name: string) =>
      name === 'userQuestions'
        ? {
            async ask(request: { questions: Array<{ options?: Array<{ label: string }> }> }) {
              const label = request.questions[0]?.options?.[0]?.label ?? ''
              return { answers: [{ selected: [label] }] }
            },
          }
        : undefined,
    inject: (_names: readonly string[], _cb: (scoped: Context) => void) => () => {},
    effect: (fn: () => () => void) => {
      fn()
      return () => {}
    },
    emit: vi.fn(),
    webServer: { register: () => () => {} },
  } as unknown as Context
}

/**
 * Answer the three OAuth calls in the shapes `oauth.ts` expects.
 *
 * Must be installed **before** `apply()`: `LoginClient` resolves its `fetch` at
 * construction time (inside `apply`), so a stub installed afterwards is never
 * consulted.
 */
function stubUpstream(uid: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    const body = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    if (url.includes('/auth/state')) {
      return body({ state: 'state-1', authUrl: 'https://example.com/authorize' })
    }
    if (url.includes('/auth/token')) {
      return body({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresIn: 3600,
        domain: 'copilot.tencent.com',
      })
    }
    if (url.includes('/login/account')) {
      return body({ uid, enterpriseId: '', nickname: 'relogin' })
    }
    return new Response('{}', { status: 404 })
  }))
}

/** Drive one full sign-in through the real `/wb-login` handler. */
async function signIn(): Promise<void> {
  const handler = registeredCommands.get('wb-login')
  if (handler === undefined) throw new Error('wb-login was not registered')
  const result = await handler({ rawInput: '', agent: undefined, signal: new AbortController().signal })
  // The command reports its own failures as text; surface them, because a
  // silently-failed sign-in would make the assertions below meaningless.
  const text = (result as { text?: string }).text ?? ''
  if (!text.includes('登录成功')) throw new Error(`sign-in did not succeed: ${text}`)
}

describe('signing back into a previously disabled account', () => {
  it('clears the disable flag, so the account is selectable again', async () => {
    // The reported sequence: disable, sign out, sign in again.
    stubUpstream(UID)
    const ctx = commandContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await new Promise(resolve => setTimeout(resolve, 250))

    await setAccountDisabled(UID, true)
    expect([...(await disabledUids())]).toContain(UID)

    await signIn()

    // The credential is stored, and — the bug — the account must no longer be
    // reported as disabled.
    expect((await listCredentials()).map(entry => entry.uid)).toContain(UID)
    expect([...(await disabledUids())]).not.toContain(UID)
  })

  it('leaves other accounts disabled', async () => {
    // Clearing the flag must be scoped to the account that signed in.
    stubUpstream(UID)
    const ctx = commandContext()
    apply(ctx, { appVersion: '', cliVersion: '', region: 'cn' })
    await new Promise(resolve => setTimeout(resolve, 250))

    await setAccountDisabled('other-uid', true)
    await setAccountDisabled(UID, true)

    await signIn()

    const disabled = [...(await disabledUids())]
    expect(disabled).not.toContain(UID)
    expect(disabled).toContain('other-uid')
  })
})
