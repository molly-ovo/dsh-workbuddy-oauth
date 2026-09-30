/**
 * Control-route guard tests.
 *
 * These exist for the same reason the assembly tests do: the guards stop a real
 * attack (a DNS-rebinding page, or any local process writing `Host: 127.0.0.1`)
 * and a probe spends the user's credit, so a missing guard is a security hole
 * that compiles cleanly and only shows up as "the button did something it should
 * not have".
 */

import { describe, expect, it, vi } from 'vitest'
import { createControlKey, workBuddyControlHandler } from '../src/control-route.ts'
import { WORKBUDDY_CONTROL_KEY_HEADER } from '../src/status-paths.ts'

/** Drive the handler against a minimal request/response pair and return the answer. */
async function dispatch(
  deps: Parameters<typeof workBuddyControlHandler>[0],
  key: string,
  init: { method?: string; host?: string; origin?: string | undefined; controlKey?: string | null; body?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const handler = workBuddyControlHandler(deps, key)
  let captured = ''
  let status = 0
  const res = {
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (payload: string) => {
      captured = payload
      return res
    },
  }
  const headers: Record<string, string> = { host: init.host ?? '127.0.0.1:43120' }
  if (init.origin !== undefined) headers['origin'] = init.origin
  // Default to the correct key: most tests are about what happens *after* the
  // key check, and they explicitly pass a wrong one when the guard itself is the
  // subject.
  headers[WORKBUDDY_CONTROL_KEY_HEADER] = init.controlKey === null ? '' : (init.controlKey ?? key)
  // A bare request with a body: the handler reads it as an async iterator.
  const body = init.body ?? ''
  const req = {
    method: init.method ?? 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
  await handler(req as never, res as never)
  return { status, body: captured === '' ? undefined : JSON.parse(captured) }
}

const baseDeps = {
  probe: vi.fn(async () => ({ state: 'ok' })),
  clear: vi.fn(),
  refresh: vi.fn(async () => ({ state: 'refreshed' })),
}

describe('control route guards', () => {
  it('rejects a non-POST method', async () => {
    const result = await dispatch(baseDeps, createControlKey(), { method: 'GET' })
    expect(result.status).toBe(405)
  })

  it('rejects a request whose Host is not loopback', async () => {
    const result = await dispatch(baseDeps, createControlKey(), { host: 'evil.example.com' })
    expect(result.status).toBe(403)
    expect(baseDeps.probe).not.toHaveBeenCalled()
  })

  it('rejects a browser Origin that is not loopback', async () => {
    // A rebinding page sends its own domain as Origin; that must be dropped even
    // though the Host header names loopback.
    const result = await dispatch(baseDeps, createControlKey(), {
      origin: 'https://evil.example.com',
    })
    expect(result.status).toBe(403)
    expect(baseDeps.probe).not.toHaveBeenCalled()
  })

  it('accepts an absent Origin (the plugin browser half sends none)', async () => {
    const result = await dispatch(baseDeps, createControlKey(), {
      origin: undefined,
      body: JSON.stringify({ action: 'clear' }),
    })
    expect(result.status).toBe(200)
    expect(baseDeps.clear).toHaveBeenCalledOnce()
  })

  it('rejects a missing or wrong control key', async () => {
    const key = createControlKey()
    for (const controlKey of [null, 'x'.repeat(48), key.slice(0, -1)] as Array<string | null>) {
      const result = await dispatch(baseDeps, key, { controlKey })
      expect(result.status).toBe(403)
    }
    expect(baseDeps.probe).not.toHaveBeenCalled()
  })

  it('rejects an unparseable body', async () => {
    const result = await dispatch(baseDeps, createControlKey(), { body: '{not json' })
    expect(result.status).toBe(400)
  })

  it('rejects an unknown action', async () => {
    const result = await dispatch(baseDeps, createControlKey(), {
      body: JSON.stringify({ action: 'delete-everything' }),
    })
    expect(result.status).toBe(400)
    expect(baseDeps.probe).not.toHaveBeenCalled()
  })

  it('rejects a probe action with a blank model id', async () => {
    const result = await dispatch(baseDeps, createControlKey(), {
      body: JSON.stringify({ action: 'probe', model: '   ' }),
    })
    expect(result.status).toBe(400)
    expect(baseDeps.probe).not.toHaveBeenCalled()
  })

  it('rejects a login-begin action with an unrecognized region', async () => {
    // The region selects an upstream host, so an arbitrary string must not be
    // passed through to the OAuth client.
    const result = await dispatch(baseDeps, createControlKey(), {
      body: JSON.stringify({ action: 'login-begin', region: 'https://evil' }),
    })
    expect(result.status).toBe(400)
  })

  it('runs the probe action for a valid request and forwards the result', async () => {
    const result = await dispatch(baseDeps, createControlKey(), {
      body: JSON.stringify({ action: 'probe', model: 'deepseek-v4.1-flash' }),
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ state: 'ok' })
    expect(baseDeps.probe).toHaveBeenCalledWith('deepseek-v4.1-flash')
  })

  it('answers 404 when a login action is asked of a route that does not support it', async () => {
    const result = await dispatch(baseDeps, createControlKey(), {
      body: JSON.stringify({ action: 'login-begin', region: 'cn' }),
    })
    expect(result.status).toBe(404)
  })
})
