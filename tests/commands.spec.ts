/**
 * Command surface tests.
 *
 * The commands are the only way a user can start a sign-in, so these pin the
 * behaviours that would otherwise leave someone stuck: the pending-while-they-
 * authorize path, the text fallback when no UI can be shown, argument
 * validation, and logout selection.
 *
 * The registry is faked rather than booted: what is under test is this plugin's
 * handler logic and its use of the documented contract, not `dsh-commands`
 * itself.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { registerCommands, renderAccounts, type UserQuestionsService } from '../src/commands.ts'
import { writeCredential, type WorkBuddyCredential } from '../src/credentials.ts'
import { purgeAccount } from '../src/account-purge.ts'
import { LoginClient, LoginExpiredError, LoginPendingError } from '../src/oauth.ts'
import type { WorkBuddyRegion } from '../src/region.ts'

let home: string
const savedHome = process.env['DSH_HOME']

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-cmd-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  await rm(home, { recursive: true, force: true })
})

/** A definition as captured by the fake registry. */
interface CapturedDefinition {
  name: string
  description: string
  handler: (invocation: { rawInput: string; agent?: unknown; signal: AbortSignal }) => Promise<CommandResult>
}

/** Minimal stand-in for `ctx.commands` that records registrations. */
function fakeContext(): { ctx: Context; definitions: Map<string, CapturedDefinition> } {
  const definitions = new Map<string, CapturedDefinition>()
  const ctx = {
    commands: {
      register(definition: CapturedDefinition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
  } as unknown as Context
  return { ctx, definitions }
}

/** Invoke one registered command. */
async function run(
  definitions: Map<string, CapturedDefinition>,
  name: string,
  rawInput = '',
  agent: unknown = { id: 'agent-1' },
): Promise<CommandResult> {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`command not registered: ${name}`)
  return definition.handler({ rawInput, agent, signal: new AbortController().signal })
}

/** A login client whose begin/complete results the test controls. */
function fakeLogins(overrides: { begin?: unknown; complete?: unknown } = {}): LoginClient {
  const begin =
    overrides.begin ??
    ((region: WorkBuddyRegion) => Promise.resolve({ region, state: 'st-1', url: 'https://auth.example/1' }))
  const complete = overrides.complete ?? (() => Promise.resolve({ region: 'cn' as WorkBuddyRegion }))
  const client = {
    begin: (region: WorkBuddyRegion) => (begin as (r: WorkBuddyRegion) => Promise<unknown>)(region),
    complete: (state: string) => (complete as (s: string) => Promise<unknown>)(state),
  }
  return client as unknown as LoginClient
}

/** Wrap a fake login client so call counts can be asserted. */
function spiedLogins(overrides: { begin?: unknown; complete?: unknown } = {}) {
  const logins = fakeLogins(overrides)
  const begin = vi.fn(logins.begin as never)
  const complete = vi.fn(logins.complete as never)
  return { logins: { begin, complete } as unknown as LoginClient, begin, complete }
}

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

/** Dependencies with a working completer and no UI service by default. */
function deps(overrides: Record<string, unknown> = {}) {
  return {
    complete: vi.fn(async () => ({ uid: 'uid-1', label: '号一' })),
    // The real purge, not a stub: `/wb-logout` is only correct if the credential
    // actually disappears, and these tests assert on the state after it runs.
    remove: (uid: string) => purgeAccount(uid),
    userQuestions: undefined as UserQuestionsService | undefined,
    warn: vi.fn(),
    ...overrides,
  }
}

describe('registration', () => {
  it('registers the four commands', () => {
    const { ctx, definitions } = fakeContext()
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    expect([...definitions.keys()].sort()).toEqual(['wb-account', 'wb-login', 'wb-logout', 'wb-status'])
  })

  it('returns disposers that unregister', () => {
    const { ctx, definitions } = fakeContext()
    const disposers = registerCommands(ctx, fakeLogins() as never, deps() as never)
    expect(definitions.size).toBe(4)
    for (const dispose of disposers) dispose()
    expect(definitions.size).toBe(0)
  })
})

describe('/wb-login', () => {
  it('rejects an unrecognized region instead of guessing', async () => {
    // Silently defaulting would look like success while signing in to the
    // wrong region.
    const { ctx, definitions } = fakeContext()
    const { logins, begin } = spiedLogins()
    registerCommands(ctx, logins as never, deps() as never)

    const result = await run(definitions, 'wb-login', 'intl')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法识别参数')
    expect(begin).not.toHaveBeenCalled()
  })

  it('defaults to the domestic region', async () => {
    const { ctx, definitions } = fakeContext()
    const { logins, begin } = spiedLogins()
    registerCommands(ctx, logins as never, deps() as never)

    await run(definitions, 'wb-login', '')
    expect(begin).toHaveBeenCalledWith('cn')
  })

  it('honours an explicit region', async () => {
    const { ctx, definitions } = fakeContext()
    const { logins, begin } = spiedLogins()
    registerCommands(ctx, logins as never, deps() as never)

    await run(definitions, 'wb-login', 'global')
    expect(begin).toHaveBeenCalledWith('global')
  })

  it('returns the link as text when no UI service exists', async () => {
    // Headless and ACP profiles have no asker; the command must still tell the
    // user what to open rather than failing.
    const { ctx, definitions } = fakeContext()
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-login')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('https://auth.example/1')
    expect(result.text).toContain('/wb-login')
  })

  it('reports a failed begin with the endpoint it needed', async () => {
    const { ctx, definitions } = fakeContext()
    const logins = fakeLogins({
      begin: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    registerCommands(ctx, logins as never, deps() as never)

    const result = await run(definitions, 'wb-login')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('ECONNREFUSED')
    expect(result.text).toContain('copilot.tencent.com')
  })

  it('treats a dismissed prompt as a cancel rather than a failure', async () => {
    const { ctx, definitions } = fakeContext()
    const userQuestions: UserQuestionsService = {
      ask: vi.fn(async () => ({ answers: [{ id: 'workbuddy-authorize', selected: [] }] })),
    }
    registerCommands(ctx, fakeLogins() as never, deps({ userQuestions }) as never)

    const result = await run(definitions, 'wb-login')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已取消')
  })

  it('shows the authorization link in the prompt detail', async () => {
    const { ctx, definitions } = fakeContext()
    // Typed parameter so `mock.calls` carries the request shape we assert on.
    const ask = vi.fn(async (_request: Parameters<UserQuestionsService['ask']>[0]) => ({
      answers: [{ id: 'workbuddy-authorize', selected: ['已完成授权，继续'] }],
    }))
    registerCommands(ctx, fakeLogins() as never, deps({ userQuestions: { ask } }) as never)

    await run(definitions, 'wb-login')
    const request = ask.mock.calls[0]?.[0]
    // The link must be inside the prompt, so the user never copies a URL from
    // scrollback and re-runs the command.
    expect(request?.questions[0]?.detail).toContain('https://auth.example/1')
  })

  it('retries a pending authorization and then succeeds', async () => {
    const { ctx, definitions } = fakeContext()
    let attempt = 0
    const complete = vi.fn(async () => {
      attempt += 1
      if (attempt < 2) throw new LoginPendingError('还没点完')
      return { uid: 'uid-1', label: '号一' }
    })
    const userQuestions: UserQuestionsService = {
      ask: vi.fn(async () => ({ answers: [{ id: 'x', selected: ['已完成授权，继续'] }] })),
    }
    await writeCredential(credential('uid-1'))
    registerCommands(ctx, fakeLogins() as never, deps({ complete, userQuestions }) as never)

    const result = await run(definitions, 'wb-login')
    expect(result.kind).toBe('success')
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result.text).toContain('登录成功')
  })

  it('stops retrying when the failure is not a pending authorization', async () => {
    const { ctx, definitions } = fakeContext()
    const complete = vi.fn(async () => {
      throw new Error('上游 500')
    })
    const userQuestions: UserQuestionsService = {
      ask: vi.fn(async () => ({ answers: [{ id: 'x', selected: ['已完成授权，继续'] }] })),
    }
    registerCommands(ctx, fakeLogins() as never, deps({ complete, userQuestions }) as never)

    const result = await run(definitions, 'wb-login')
    // Retrying a hard failure would only delay the report.
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('上游 500')
  })

  it('tells the user to re-run after an expired state', async () => {
    const { ctx, definitions } = fakeContext()
    const complete = vi.fn(async () => {
      throw new LoginExpiredError('登录窗口已超时。')
    })
    const userQuestions: UserQuestionsService = {
      ask: vi.fn(async () => ({ answers: [{ id: 'x', selected: ['已完成授权，继续'] }] })),
    }
    registerCommands(ctx, fakeLogins() as never, deps({ complete, userQuestions }) as never)

    const result = await run(definitions, 'wb-login')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('重新执行 /wb-login')
  })

  it('degrades to text when the asker refuses the caller', async () => {
    // A sub-agent has no human answerer and `ask` throws; that must not be
    // reported as a broken sign-in.
    const { ctx, definitions } = fakeContext()
    const ask = vi.fn(async () => {
      throw new Error('DELEGATED_CALLER')
    })
    registerCommands(ctx, fakeLogins() as never, deps({ userQuestions: { ask } }) as never)

    const result = await run(definitions, 'wb-login')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('https://auth.example/1')
    expect(result.text).toContain('无法弹出确认框')
  })
})

describe('/wb-status', () => {
  it('reports no accounts before any sign-in', async () => {
    const { ctx, definitions } = fakeContext()
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-status')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有已登录的账号')
  })

  it('lists stored accounts with their region and expiry', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a', { nickname: '号一' }))
    await writeCredential(credential('uid-b', { region: 'global', domain: 'www.workbuddy.ai' }))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-status')
    expect(result.text).toContain('号一')
    expect(result.text).toContain('国内版')
    expect(result.text).toContain('国际版')
  })
})

describe('/wb-logout', () => {
  it('says so when nothing is signed in', async () => {
    const { ctx, definitions } = fakeContext()
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-logout')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有已登录的账号')
  })

  it('removes the only account without requiring a selector', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a', { nickname: '号一' }))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-logout')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已退出')
  })

  it('refuses to guess when several accounts exist', async () => {
    // Deleting the wrong credential is not recoverable by re-running.
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-logout')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('请指定要退出的 uid 前缀')
  })

  it('matches by uid prefix', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('abc-111', { nickname: '甲' }))
    await writeCredential(credential('xyz-222', { nickname: '乙' }))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-logout', 'abc')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('甲')
  })

  it('reports an unmatched selector', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a'))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-logout', 'zzz')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有匹配')
  })
})

describe('renderAccounts', () => {
  it('invites a sign-in when the list is empty', () => {
    expect(renderAccounts([])).toContain('/wb-login')
  })

  it('marks an expired token as auto-refreshable rather than broken', () => {
    const text = renderAccounts([credential('uid-a', { expiresAtMs: Date.now() - 1 })])
    expect(text).toContain('已过期')
    expect(text).toContain('自动刷新')
  })

  it('marks a disabled account', () => {
    const text = renderAccounts([credential('uid-a', { nickname: '号一' })], new Set(['uid-a']))
    expect(text).toContain('已停用')
  })
})

describe('/wb-account', () => {
  it('lists accounts with no argument', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a', { nickname: '号一' }))
    await writeCredential(credential('uid-b', { nickname: '号二' }))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-account')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('号一')
    expect(result.text).toContain('号二')
  })

  it('disables an account and marks it in the list', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a', { nickname: '号一' }))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-account', 'disable uid-a')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已停用')
    expect(result.text).toContain('号一')
  })

  it('re-enables a disabled account', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a', { nickname: '号一' }))
    registerCommands(ctx, fakeLogins() as never, deps() as never)
    await run(definitions, 'wb-account', 'disable uid-a')

    const result = await run(definitions, 'wb-account', 'enable uid-a')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已启用')
  })

  it('rejects an unrecognized verb', async () => {
    const { ctx, definitions } = fakeContext()
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-account', 'freeze uid-a')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法识别动作')
  })

  it('refuses to guess the target among several accounts', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a'))
    await writeCredential(credential('uid-b'))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-account', 'disable')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('请指定要操作的 uid 前缀')
  })

  it('reports an unmatched selector', async () => {
    const { ctx, definitions } = fakeContext()
    await writeCredential(credential('uid-a'))
    registerCommands(ctx, fakeLogins() as never, deps() as never)

    const result = await run(definitions, 'wb-account', 'disable zzz')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有匹配')
  })
})
