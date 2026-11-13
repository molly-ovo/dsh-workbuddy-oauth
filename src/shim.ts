/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process or a DNS-rebinding page can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, chat POSTs must be application/json, and the Authorization
 * header must carry the shim's per-process shared secret. The plugin's
 * own client satisfies all four by construction; local attackers cannot
 * read the secret out of the plugin process's memory.
 *
 * @module dsh-workbuddy-oauth/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { CredentialStore as WorkBuddyCredentialStore } from './store.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { writeFile } from 'node:fs/promises'
import {
  demoteInstructionMessage,
  extractDisplayErrorMessage,
  isChannelBlock,
  prepareChatBody,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
} from './upstream.ts'
import { stateFilePath } from './credentials.ts'
import { refreshCredential } from './refresh.ts'
import { rewriteChannelFingerprints } from './channel-rewrite.ts'

/**
 * How long an upstream failure parks an account out of selection.
 *
 * The two durations differ by an order of magnitude because the *cause* differs:
 *
 * - `hard_credit` means the account is out of credit. That does not clear in a
 *   minute — measured, the upstream answers `额度已用尽` and offers a top-up
 *   purchase link — so a short cooldown would put the account back in rotation
 *   and burn a failing request every interval. One hour is a compromise between
 *   "do not retry a dead account" and "notice automatically if credit returns";
 *   the user can also re-enable or sign in again explicitly.
 * - `soft_rate` means "too fast": the upstream's own limit resets on its own, so
 *   a short park is enough to stop the next request from hitting the same wall.
 *
 * `server` (5xx) is transient by nature, hence the shortest.
 */
export const FAILURE_COOLDOWN_MS: Readonly<Record<'hard_credit' | 'soft_rate' | 'server', number>> = {
  hard_credit: 60 * 60_000,
  soft_rate: 60_000,
  server: 10_000,
}

/**
 * The cooldown a failure class warrants, or `undefined` for classes that must
 * not park an account (`session_dead` is "sign in again", `not_found`/`client`
 * are request-shape problems that would fail identically on any account).
 */
export function cooldownForKind(kind: UpstreamErrorKind, now: number = Date.now()): number | undefined {
  const ms = kind === 'hard_credit' || kind === 'soft_rate' || kind === 'server'
    ? FAILURE_COOLDOWN_MS[kind]
    : undefined
  return ms === undefined ? undefined : now + ms
}

/**
 * How long an account whose *session* the upstream has revoked stays parked.
 *
 * `cooldownForKind` never parks `session_dead`, because a request-shaped 401
 * could be a transient hiccup. But when the refresh token is refused as well,
 * the account really cannot serve anything until the user signs in again — and
 * leaving it in rotation means every message retries a dead session before
 * rotating. Parking it briefly lets a multi-account pool fail over on the *same*
 * message instead of the next one; the user's re-login clears it (see
 * {@link clearCooldown} in the sign-in path).
 */
export const SESSION_DEAD_PARK_MS = 5 * 60_000

/**
 * How long a channel-check rejection is remembered.
 *
 * The check reads the prompt text, and DSH's prompt is identical from turn to
 * turn, so re-sending the doomed attempt every message would double the upstream
 * request count and add a round trip to each one. Ten minutes is long enough to
 * cover an active conversation and short enough that a gateway change is picked
 * up on the next break rather than at the next restart.
 */
export const CHANNEL_BLOCK_MEMORY_MS = 10 * 60_000

/** Whether a response body is the gateway's HTML page rather than JSON. */
function isHtmlBody(text: string): boolean {
  return text.trimStart().startsWith('<')
}

/**
 * Describe an outbound chat body by shape alone, for failure logs.
 *
 * The fields chosen are the ones that decide which branch of the upstream
 * gateway answers: the top-level key set (an unknown or missing field is what
 * `11133` complains about), the message roles in order (a `developer` role is
 * what `11128` rejects on CN), and whether tools rode along. **No message text,
 * no tool schema and no user content is ever included** — this line is meant to
 * be pasteable into a public issue.
 *
 * @param bodyJson - the body as it is about to be sent.
 */
export function describeChatBody(bodyJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return `unparseable body, ${bodyJson.length} bytes`
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `top-level ${Array.isArray(parsed) ? 'array' : typeof parsed}`
  }
  const body = parsed as Record<string, unknown>
  const messages = Array.isArray(body['messages']) ? body['messages'] as unknown[] : []
  const roles = messages.slice(0, 8).map((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return '?'
    return String((message as Record<string, unknown>)['role'])
  })
  const tools = Array.isArray(body['tools']) ? body['tools'].length : 0
  const model = typeof body['model'] === 'string' ? body['model'] : '(none)'
  return `${bodyJson.length} bytes, model=${model}, keys=[${Object.keys(body).sort().join(' ')}], `
    + `messages=${messages.length} roles=[${roles.join(' ')}${messages.length > 8 ? ' …' : ''}], tools=${tools}`
}

/**
 * Minimal logger surface the plugin context already provides.
 *
 * `info` exists so one line per chat request can report **which account served
 * it**. Selection behaviour (rotation, cooldown, session affinity) is otherwise
 * invisible: nothing about the response says which credential produced it, so
 * without this an operator cannot tell a working rotation from a stuck pool.
 */
export interface ShimLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog } = options
  const logger = options.logger

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  // The shim never forwards it upstream — the real credential comes from the
  // store. A local attacker who can hit the port still cannot forge this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /**
   * Until when the channel check is assumed to reject instruction messages.
   *
   * Set when the gateway answers `400` / `11128`, cleared by the TTL rather than
   * by a success (a demoted request succeeding proves nothing about the original
   * shape). In-process and per-instance, so a restart re-probes from scratch.
   */
  let channelBlockedUntil = 0

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too. The plugin's own client
      // always satisfies both; DNS-rebinding pages and cross-origin POSTs
      // do not.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'workbuddy',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    // Session affinity: pi-ai forwards DSH's `sessionId` as `x-session-id`
    // (configured in adapter.ts). The store pins that conversation to one
    // account so a multi-turn exchange does not hop accounts mid-context.
    // This header is internal (pi-ai → shim) and never forwarded upstream.
    const affinityHeader = req.headers['x-session-id']
    const sessionKey = typeof affinityHeader === 'string' && affinityHeader !== ''
      ? affinityHeader
      : undefined

    let credential
    try {
      credential = await store.resolve(sessionKey)
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    // Once this gateway has blocked one instruction message it will block the
    // next one too — the check is on the prompt text, which does not change
    // between turns. Sending the doomed attempt every time would double the
    // upstream request count and add a wasted round trip to every message, so
    // the rejection is remembered for a while and the retry is sent directly.
    // Bounded by a TTL so a changed gateway is re-probed instead of being
    // demoted forever.
    // CN first: neutralize the fingerprints the gateway compares, which keeps
    // the instructions in `system` where their authority belongs. Then, if a
    // rejection is still remembered, skip straight to the role demotion.
    let outbound = credential.region === 'cn' ? rewriteChannelFingerprints(prepared) : prepared
    if (Date.now() < channelBlockedUntil) outbound = demoteInstructionMessage(outbound)
    let result = await client.chatStream(credential, outbound, controller.signal)

    /**
     * Recover from a rejected access token.
     *
     * The upstream retires a session's tokens when the same account signs in
     * elsewhere, but the stored access token keeps its future `expiresAtMs` —
     * so the lazy refresh in the store never fires and every request would keep
     * presenting a dead token until its nominal expiry (days later).
     *
     * A 401 arrives before any of the stream does, so re-sending the same body
     * is safe here in a way a mid-stream retry never would be: nothing has been
     * delivered, and the only thing that changed is the credential. One attempt
     * only — if a fresh token is rejected too, the cause is not the credential.
     */
    if (!result.ok && result.status === 401 && credential.refreshToken !== '') {
      const outcome = await refreshCredential(credential.uid, {
        force: true,
        staleAccessToken: credential.accessToken,
      })
      if (outcome.status === 'failed') {
        logger?.warn(`dsh-workbuddy-oauth: refresh failed for uid=${credential.uid.slice(0, 8)}: ${outcome.reason}`)
        if (outcome.permanent === true) {
          // Signing in again is the only fix; park the account so the rest of
          // the pool can serve instead of retrying a dead session each turn.
          store.noteFailure(credential.uid, Date.now() + SESSION_DEAD_PARK_MS)
        }
      } else {
        credential = outcome.credential
        result = await client.chatStream(credential, outbound, controller.signal)
      }
    }

    /**
     * Fallback for a fingerprint the rewrite table has not learned yet.
     *
     * `rewriteChannelFingerprints` already ran on CN, so reaching here means the
     * gateway matched something outside the table. The scan only reads `system`,
     * so re-issuing the instruction message as `user` gets past a check of any
     * wording — at the cost of instruction authority, which is why it is the
     * second choice and why the rejection is remembered.
     */
    if (!result.ok && result.status === 400 && isChannelBlock(result.message)) {
      channelBlockedUntil = Date.now() + CHANNEL_BLOCK_MEMORY_MS
      const demoted = demoteInstructionMessage(outbound)
      if (demoted !== outbound) {
        logger?.warn('dsh-workbuddy-oauth: gateway blocked the system message (11128); retrying it as a user message')
        outbound = demoted
        result = await client.chatStream(credential, outbound, controller.signal)
      }
    }

    // One line per request naming the serving account. This is the only
    // observable evidence of selection behaviour: alternating uids mean rotation,
    // a repeated uid within one conversation means affinity held, and an account
    // dropping out after a failure means cooldown parked it.
    //
    // The uid is already a non-personal identifier (the credential file name),
    // and only its first 8 characters are logged — enough to tell accounts apart
    // without publishing a full identifier. The nickname is deliberately not
    // logged: it can be a phone number, which is why `displayNameOf` masks it.
    logger?.info(
      `dsh-workbuddy-oauth: chat ${result.ok ? 'ok' : result.kind} via uid=${credential.uid.slice(0, 8)}`
      + `${sessionKey === undefined ? ' (no session)' : ''}`,
    )

    if (!result.ok) {
      // Request-shape failures are the ones a user cannot act on and cannot
      // report usefully: the host shows only the upstream's localized sentence
      // ("请求被拦截，请重新发送"), which names no field. Log what the upstream
      // actually answered plus the *shape* of what we sent — key names, message
      // roles, tool count — and never the text of a message, which is the
      // user's own conversation.
      logger?.warn(
        `dsh-workbuddy-oauth: upstream ${result.status} ${result.kind}: ${result.message.slice(0, 600)}`,
      )
      logger?.warn(`dsh-workbuddy-oauth: request shape ${describeChatBody(outbound)}`)
      if (result.kind === 'client') {
        // Everything above is structure; a gateway that rejects on *content*
        // (the 11128 channel check) needs the bytes to be diagnosable at all.
        // The file stays local, is owner-only, and is overwritten by the next
        // failure — it is the one artefact that turns "请求被拦截" into a diff.
        const dumpPath = stateFilePath('last-failed-request.json')
        try {
          await writeFile(dumpPath, outbound, { mode: 0o600 })
          logger?.warn(`dsh-workbuddy-oauth: failed request body written to ${dumpPath}`)
        } catch {
          // A failed diagnostic must never mask the real failure.
        }
      }

      // Park the account out of selection when the failure is account-shaped.
      // The next request then rotates to another account instead of hitting the
      // same wall immediately. Request-shape failures (client/not_found) and
      // session-dead are deliberately not cooled.
      const until = cooldownForKind(result.kind)
      if (until !== undefined) store.noteFailure(credential.uid, until)

      const detail = extractDisplayErrorMessage(result.message)
        // A gateway 401 has no JSON envelope to read a message out of — the body
        // is the APISIX HTML page. Passing that through surfaced in the UI as
        // the host's generic "invalid API key" banner, which names the symptom
        // and not the action; say what to do instead.
        ?? (result.kind === 'session_dead' && isHtmlBody(result.message)
          ? '登录会话已被上游作废（账号可能在别处重新登录过），请重新执行 /wb-login 完成登录。'
          : result.message.slice(0, 400))
      // The host adapter classifies any error text containing a bare
      // `401`/`403` word as AUTH, which would mask business errors (safety
      // review, illegal request) behind an "invalid API key" banner. Only
      // session failures keep the status note — every 401 classifies as
      // session_dead, so genuine auth errors stay recognisable. Known
      // residue: an extracted display text that itself names 403 still trips
      // the host heuristic; the real text wins over hiding the number.
      const statusNote = (result.status === 401 || result.status === 403) && result.kind !== 'session_dead'
        ? ''
        : ` (http ${result.status})`
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy upstream ${result.kind}${statusNote}: ${detail}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-workbuddy-oauth: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
