/**
 * Slash-command surface for sign-in and account status.
 *
 * ## Why commands rather than only a settings card
 *
 * `dsh-workbuddy-connect` can show status in a settings card because it reads a
 * sign-in the desktop app already performed — there is nothing to trigger. This
 * plugin owns the sign-in, so it must expose an *action*, and the two surfaces
 * DSH offers for that are commands and a settings card.
 *
 * Commands come first because they work in every profile that has a command
 * adapter (CLI and web) and need no client bundle, so the plugin becomes usable
 * before any browser-side code exists.
 *
 * ## The interaction shape
 *
 * Borrowed from `tearslee/dsh-workbuddy2api`, which solved the awkward part:
 * the authorization link must reach the user, and the user must then tell us
 * they are done. Its answer is a single question whose `detail` carries the
 * link and whose only option is "done" — the user never copies a URL or
 * re-runs a command. That shape is reproduced here.
 *
 * ## Degrading, not failing
 *
 * `userQuestions` is absent in headless and ACP profiles, and `ask` also
 * refuses a non-root agent. Both cases fall back to printing the link and the
 * instructions to re-run the command, which keeps the feature usable rather
 * than turning a missing UI service into an error.
 *
 * @module dsh-workbuddy-standalone/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  credentialFromLogin,
  displayNameOf,
  listCredentials,
  deleteCredential,
  type WorkBuddyCredential,
} from './credentials.ts'
import { disabledUids, setAccountDisabled } from './account-state.ts'
import { LoginClient, LoginExpiredError, LoginPendingError, parseRegionInput } from './oauth.ts'
import { regionEndpoints, type WorkBuddyRegion } from './region.ts'
import { PLUGIN_VERSION } from './version.ts'

export type { CommandResult }

/**
 * The slice of the `userQuestions` service this module uses.
 *
 * Declared locally rather than imported, deliberately: the package is always
 * present in a profile but is not a dependency of this plugin, so importing
 * its types would either fail `tsc` (TS2307) or force a hard dependency that
 * makes the plugin refuse to load in a combination that lacks the service.
 * `ctx.get('userQuestions')` returns `undefined` there and the caller degrades.
 *
 * `ask` requires the exact live root agent. A sub-agent has no human answerer
 * and `ask` fails with `DELEGATED_CALLER`; the command layer treats that the
 * same as an absent service.
 */
export interface UserQuestionsService {
  ask: (request: {
    questions: Array<{
      id: string
      question: string
      detail?: string
      header?: string
      options?: Array<{ label: string; description?: string }>
    }>
    agent?: unknown
    signal?: AbortSignal
  }) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

/** How many times to poll the token endpoint while the user authorizes. */
export const POLL_ATTEMPTS = 20

/** Gap between polls. Matches the flow's observed pace and stays above the client's own floor. */
export const POLL_INTERVAL_MS = 3_000

/** The option label that means "I finished in the browser". */
const CONFIRM_LABEL = '已完成授权，继续'

/** Sleep, abortable so a cancelled command stops waiting promptly. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Format a token expiry for display, plus a coarse "time left" hint. */
function describeExpiry(credential: WorkBuddyCredential, now = Date.now()): string {
  const remainingMs = credential.expiresAtMs - now
  if (remainingMs <= 0) return '已过期（下次使用时会自动刷新）'
  const minutes = Math.floor(remainingMs / 60_000)
  if (minutes < 60) return `约 ${minutes} 分钟后可刷新`
  const hours = Math.floor(minutes / 60)
  return `约 ${hours} 小时内有效`
}

/**
 * Render the account list, shared by `/wb-status` and the post-login summary.
 *
 * @param credentials - Accounts to show.
 * @param disabled - Disabled account uids, marking entries excluded from selection.
 * @param now - Current epoch milliseconds.
 */
export function renderAccounts(
  credentials: readonly WorkBuddyCredential[],
  disabled: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): string {
  if (credentials.length === 0) {
    return '当前没有已登录的账号。执行 /wb-login 开始登录。'
  }
  const lines = credentials.map((credential, index) => {
    const label = displayNameOf(credential)
    const region = regionEndpoints(credential.region).label
    const state = disabled.has(credential.uid) ? '（已停用）' : ''
    return `  ${index + 1}. ${label} · ${region} · ${describeExpiry(credential, now)}${state}`
  })
  return [`已登录 ${credentials.length} 个账号：`, ...lines].join('\n')
}

/** Dependencies the commands need from the plugin instance. */
export interface CommandDeps {
  /**
   * Complete a sign-in: persist the credential and refresh model catalogs.
   *
   * Injected because persisting is the plugin's business (it owns the stores
   * and the catalogs), while *driving* the OAuth exchange is this module's.
   */
  complete: (state: string) => Promise<{ uid: string; label: string }>
  /** Ask the user something, or `undefined` when no UI service is available. */
  userQuestions: UserQuestionsService | undefined
  /** Plugin logging surface. */
  warn: (message: string, error?: unknown) => void
}

/**
 * Prompt for the authorization link and wait for the user's confirmation.
 *
 * @returns `true` when the user says they finished; `false` when they dismissed
 *   it. Throws only on a real failure.
 */
async function confirmAuthorization(
  url: string,
  region: WorkBuddyRegion,
  agent: unknown,
  deps: CommandDeps,
): Promise<{ confirmed: boolean; fallbackText?: string }> {
  const service = deps.userQuestions
  if (service === undefined) {
    // No UI to ask through: hand back instructions instead of failing.
    return {
      confirmed: false,
      fallbackText: [
        `请在浏览器中打开以下链接完成${regionEndpoints(region).label}授权：`,
        '',
        `  ${url}`,
        '',
        '授权完成后，重新执行 /wb-login 以完成登录（授权链接每次都会重新生成）。',
      ].join('\n'),
    }
  }

  try {
    const answer = await service.ask({
      questions: [
        {
          id: 'workbuddy-authorize',
          question: '请在浏览器中打开链接完成授权，完成后选择下方选项：',
          header: '账号授权',
          detail:
            `${url}\n\n` +
            `（${regionEndpoints(region).label} · 链接由上游签发，仅用于本次登录）`,
          options: [{ label: CONFIRM_LABEL, description: '上游确认后凭证会自动保存并刷新模型列表' }],
        },
      ],
      agent,
    })
    return { confirmed: answer.answers[0]?.selected[0] === CONFIRM_LABEL }
  } catch (error: unknown) {
    // A sub-agent or an aborted prompt reaches here. Degrade to the text
    // fallback rather than reporting the sign-in as broken.
    deps.warn('无法弹出授权确认框，改用文本提示', error)
    return {
      confirmed: false,
      fallbackText: [
        '无法弹出确认框（当前上下文没有可用的交互界面）。',
        '',
        `请在浏览器中打开：${url}`,
        '',
        '授权完成后重新执行 /wb-login。',
      ].join('\n'),
    }
  }
}

/**
 * Register the plugin's commands.
 *
 * @param ctx - Plugin context; `commands` must be available.
 * @param logins - The plugin's login client.
 * @param deps - Injected collaborators.
 * @returns The disposers for every registration.
 */
export function registerCommands(
  ctx: Context,
  logins: LoginClient,
  deps: CommandDeps,
): Array<() => void> {
  const disposers: Array<() => void> = []
  const commands = ctx.commands

  /** `/wb-login [cn|global]` — begin and complete a sign-in. */
  disposers.push(
    commands.register({
      name: 'wb-login',
      description: '登录 WorkBuddy 账号（不依赖桌面 App）',
      input: { hint: '[cn | global]' },
      handler: async ({ rawInput, agent, signal }): Promise<CommandResult> => {
        const trimmed = rawInput.trim()
        const region = parseRegionInput(trimmed)
        // An unrecognized argument is an error rather than a silent fallback:
        // quietly signing in to the wrong region would look like success.
        if (trimmed !== '' && region === undefined) {
          return {
            kind: 'error',
            text: `无法识别参数「${trimmed}」。用法：/wb-login [cn | global]（不带参数默认国内版）`,
          }
        }
        const target = region ?? 'cn'

        let url: string
        let state: string
        try {
          const request = await logins.begin(target)
          url = request.url
          state = request.state
        } catch (error: unknown) {
          return {
            kind: 'error',
            text:
              `无法向上游申请授权链接：${error instanceof Error ? error.message : String(error)}\n` +
              `（该步骤需要访问 ${regionEndpoints(target).base}）`,
          }
        }

        const confirm = await confirmAuthorization(url, target, agent, deps)
        if (confirm.fallbackText !== undefined) {
          return { kind: 'error', text: confirm.fallbackText }
        }
        if (!confirm.confirmed) {
          return { kind: 'success', text: '已取消授权，未写入任何凭据。' }
        }

        // The upstream may not have registered the authorization the instant the
        // user clicks, so poll with backoff rather than failing on the first try.
        let lastError: unknown
        for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
          try {
            const result = await deps.complete(state)
            const accounts = await listCredentials()
            const disabled = await disabledUids()
            return {
              kind: 'success',
              text: [
                `登录成功：${result.label}`,
                '',
                renderAccounts(accounts, disabled),
                '',
                '模型列表已刷新，可在模型选择器中选择 WorkBuddy 模型。',
              ].join('\n'),
            }
          } catch (error: unknown) {
            lastError = error
            // Only a pending authorization is worth retrying; anything else is
            // a real failure and polling would just delay the report.
            if (!(error instanceof LoginPendingError)) break
            if (attempt < POLL_ATTEMPTS) {
              try {
                await sleep(POLL_INTERVAL_MS, signal)
              } catch {
                return { kind: 'error', text: '登录已取消。' }
              }
            }
          }
        }

        if (lastError instanceof LoginPendingError) {
          return {
            kind: 'error',
            text:
              `等待授权超时（约 ${Math.round((POLL_INTERVAL_MS * POLL_ATTEMPTS) / 1000)} 秒内上游始终未确认）。\n` +
              '请确认浏览器中已完成授权并看到成功提示，然后重新执行 /wb-login（链接每次重新生成）。',
          }
        }
        if (lastError instanceof LoginExpiredError) {
          return { kind: 'error', text: `${lastError.message}请重新执行 /wb-login。` }
        }
        return {
          kind: 'error',
          text: `登录失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
        }
      },
    }),
  )

  /** `/wb-status` — accounts and plugin state. */
  disposers.push(
    commands.register({
      name: 'wb-status',
      description: '查看已登录的 WorkBuddy 账号与插件状态',
      handler: async (): Promise<CommandResult> => {
        const credentials = await listCredentials()
        const disabled = await disabledUids()
        return {
          kind: 'success',
          text: [
            `dsh-workbuddy-standalone v${PLUGIN_VERSION}`,
            '',
            renderAccounts(credentials, disabled),
          ].join('\n'),
        }
      },
    }),
  )

  /** `/wb-logout [uid]` — remove a stored credential. */
  disposers.push(
    commands.register({
      name: 'wb-logout',
      description: '退出登录（仅删除本插件保存的凭据，不影响上游账号）',
      input: { hint: '[uid 前缀]' },
      handler: async ({ rawInput }): Promise<CommandResult> => {
        const credentials = await listCredentials()
        if (credentials.length === 0) {
          return { kind: 'success', text: '当前没有已登录的账号。' }
        }

        const selector = rawInput.trim()
        const target = selector === ''
          ? (credentials.length === 1 ? credentials[0] : undefined)
          : credentials.find((credential) => credential.uid.startsWith(selector))

        if (target === undefined) {
          return {
            kind: 'error',
            text: [
              selector === ''
                ? '存在多个账号，请指定要退出的 uid 前缀：'
                : `没有匹配「${selector}」的账号。`,
              '',
              renderAccounts(credentials, await disabledUids()),
              '',
              '用法：/wb-logout <uid 前缀>',
            ].join('\n'),
          }
        }

        const label = displayNameOf(target)
        await deleteCredential(target.uid)
        const remaining = await listCredentials()
        return {
          kind: 'success',
          text: [
            `已退出：${label}`,
            '',
            remaining.length === 0
              ? '已无登录账号，模型分组将在下次刷新后消失。'
              : renderAccounts(remaining, await disabledUids()),
          ].join('\n'),
        }
      },
    }),
  )

  /** `/wb-account [enable|disable] [uid 前缀]` — list and toggle accounts. */
  disposers.push(
    commands.register({
      name: 'wb-account',
      description: '管理 WorkBuddy 账号（列出 / 启用 / 停用）',
      input: { hint: '[enable | disable] [uid 前缀]' },
      handler: async ({ rawInput }): Promise<CommandResult> => {
        const [verb, selectorRaw] = rawInput.trim().split(/\s+/) as [string, string | undefined]
        const selector = selectorRaw?.trim() ?? ''

        if (verb === undefined || verb === '') {
          // Listing: show every stored account with its enabled/disabled state.
          const credentials = await listCredentials()
          const disabled = await disabledUids()
          return { kind: 'success', text: renderAccounts(credentials, disabled) }
        }

        if (verb !== 'enable' && verb !== 'disable') {
          return {
            kind: 'error',
            text: `无法识别动作「${verb}」。用法：/wb-account [enable | disable] <uid 前缀>（不带动作则列出全部账号）`,
          }
        }

        const credentials = await listCredentials()
        if (credentials.length === 0) {
          return { kind: 'success', text: '当前没有已登录的账号。执行 /wb-login 开始登录。' }
        }

        // No selector with several accounts is ambiguous: refuse rather than
        // toggle the wrong one. A single account may omit the selector.
        const target = selector === ''
          ? (credentials.length === 1 ? credentials[0] : undefined)
          : credentials.find((credential) => credential.uid.startsWith(selector))

        if (target === undefined) {
          return {
            kind: 'error',
            text: [
              selector === ''
                ? '存在多个账号，请指定要操作的 uid 前缀：'
                : `没有匹配「${selector}」的账号。`,
              '',
              renderAccounts(credentials, await disabledUids()),
              '',
              '用法：/wb-account <enable | disable> <uid 前缀>',
            ].join('\n'),
          }
        }

        const disabled = await setAccountDisabled(target.uid, verb === 'disable')
        const label = displayNameOf(target)
        return {
          kind: 'success',
          text: [
            `${verb === 'disable' ? '已停用' : '已启用'}：${label}`,
            '',
            renderAccounts(credentials, disabled),
          ].join('\n'),
        }
      },
    }),
  )

  return disposers
}

/** Create the login client used by the commands. Exported for tests. */
export { LoginClient }

/** Re-exported so callers do not need to reach into `./oauth.ts` for the type. */
export type { WorkBuddyCredential }

/** Build a credential from a completed login. Kept here as the command-facing name. */
export { credentialFromLogin }
