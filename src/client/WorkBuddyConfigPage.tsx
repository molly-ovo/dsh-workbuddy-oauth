/**
 * The bundle's configuration page on the Plugins page.
 *
 * P2.4: shows the accounts this plugin holds and triggers the same OAuth sign-in
 * the `/wb-login` command drives. The card is a *transport* over the control
 * route, never a second login implementation — a card that authenticated on its
 * own would let the UI report success while the path the rest of the plugin
 * trusts (the credential file and the catalog refresh) never ran.
 *
 * @module dsh-workbuddy-standalone/client/WorkBuddyConfigPage
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: this module registers into `plugins.bundle.config`, which the
// Plugins page declares. A value import would fail the client bundle-purity
// gate, since cross-plugin collaboration goes through cordis services.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { readStatus, sendControl } from './host.ts'
import type { WorkBuddyLocaleKey } from './locales.ts'
import type { WorkBuddyWebAccount, WorkBuddyWebStatus } from '../status-paths.ts'

/** Props the Plugins page delivers to the bundle's configuration entry. */
export type WorkBuddyConfigPageProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'workbuddy'>

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
}
const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}
const introStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const regionStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-primary)' }
const mutedStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
const buttonStyle: CSSProperties = {
  padding: '3px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}
const noticeStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
  wordBreak: 'break-all',
}
const linkStyle: CSSProperties = { color: 'var(--dsw-alias-label-link, #3b82f6)', fontSize: 12 }

/** One in-flight sign-in the card is waiting on. */
interface PendingLogin {
  /** Attempt id handed back to `login-complete`. */
  state: string
  /** Authorization URL the user must open. */
  url: string
  /** Region the attempt was started for. */
  region: string
}

/** How often the card re-checks the status document. */
const RECONCILE_MS = 30_000

/** How often a waiting sign-in asks the host whether the upstream confirmed. */
const LOGIN_POLL_MS = 3_000

/**
 * Render the bundle's configuration.
 *
 * The Plugins page asks only for `view: 'page'` on this slot; a `summary` answer
 * keeps the entry legible if that ever changes.
 */
export function WorkBuddyConfigPage({ view, t }: WorkBuddyConfigPageProps): ReactNode {
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  const [pending, setPending] = useState<PendingLogin>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await readStatus(signal)
    if (mounted.current && value !== undefined) setStatus(value)
  }, [])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => { void refresh(controller.signal) }, RECONCILE_MS)
    return () => {
      mounted.current = false
      controller.abort()
      window.clearInterval(timer)
    }
  }, [refresh])

  /**
   * Poll the host while an authorization is outstanding.
   *
   * The upstream does not report the user's browser approval to us; the host
   * finds out by redeeming the state, so the card has to ask. `pending` is the
   * normal in-between answer and is not an error.
   */
  useEffect(() => {
    if (pending === undefined || status === undefined) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
        action: 'login-complete',
        state: pending.state,
      })
      if (cancelled || !mounted.current) return
      if (result === undefined) {
        setPending(undefined)
        setNotice(t('loginFailed', { reason: 'control route unreachable' }))
        return
      }
      if (result.state === 'ok') {
        setPending(undefined)
        setNotice(t('loginSucceeded', { label: result.reason ?? '' }))
        void refresh()
        return
      }
      if (result.state === 'failed') {
        setPending(undefined)
        setNotice(t('loginFailed', { reason: result.reason ?? '' }))
      }
    }
    const timer = window.setInterval(() => { void tick() }, LOGIN_POLL_MS)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pending, status, t, refresh])

  const startLogin = async (region: string): Promise<void> => {
    if (status === undefined || busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      // The status route is region-independent, so any region's control path can
      // carry `login-begin`; the region travels in the body, not in the route.
      const path = status.regions[0]?.controlPath ?? ''
      const result = await sendControl(path, status.controlKey, { action: 'login-begin', region })
      if (result?.state === 'pending' && result.url !== undefined && result.loginState !== undefined) {
        setPending({ state: result.loginState, url: result.url, region })
      } else {
        setNotice(t('loginFailed', { reason: result?.reason ?? t('loginStarting') }))
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /**
   * Run one per-account control action and re-read the document.
   *
   * The card never mutates local state to predict the outcome: a toggle the host
   * refused must not look applied, so the truth always comes back from the
   * status route.
   */
  const runAccountAction = async (
    body: { action: 'logout'; uid: string } | { action: 'set-account-enabled'; uid: string; enabled: boolean },
    label: string,
  ): Promise<void> => {
    if (status === undefined || busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, body)
      if (result === undefined || result.state !== 'ok') {
        setNotice(t('loginFailed', { reason: result?.reason ?? t('working') }))
        return
      }
      setNotice(
        body.action === 'logout'
          ? t('logoutSucceeded', { label })
          : t(body.enabled ? 'enableSucceeded' : 'disableSucceeded', { label }),
      )
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (view === 'summary') return t('intro')

  return (
    <section style={sectionStyle}>
      <span style={titleStyle}>{t('title')}</span>
      <span style={introStyle}>{t('intro')}</span>

      {notice === undefined ? null : (
        <span role="status" aria-live="polite" style={noticeStyle}>{notice}</span>
      )}

      {pending === undefined ? null : (
        <span style={noticeStyle}>
          <span>
            {t('loginOpenLink')}
            {' '}
            <a href={pending.url} target="_blank" rel="noreferrer" style={linkStyle}>{pending.url}</a>
            {' '}
            {t('loginWaiting')}
          </span>
          <button type="button" style={buttonStyle} onClick={() => { setPending(undefined) }}>
            {t('cancel')}
          </button>
        </span>
      )}

      <div style={rowStyle}>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || status === undefined}
          onClick={() => { void startLogin('cn') }}
        >
          {t('login')} · {t('regionCn')}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={busy || status === undefined}
          onClick={() => { void startLogin('global') }}
        >
          {t('login')} · {t('regionGlobal')}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={status === undefined}
          onClick={() => { void refresh() }}
        >
          {t('refresh')}
        </button>
      </div>

      {status === undefined ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {status.regions.map(region => (
            <div key={region.region} style={rowStyle}>
              <span style={regionStyle}>{region.label}</span>
              <span style={mutedStyle}>
                {region.signedIn
                  ? t('models', { count: region.models.length })
                  : t('signedOut')}
              </span>
            </div>
          ))}
          {/*
            One row per account, with the uid prefix visible: signing out or
            disabling names an account by uid, so the card has to show it to be
            usable at all.
          */}
          {status.accounts.map(account => (
            <AccountRow
              key={account.uid}
              account={account}
              t={t}
              busy={busy}
              onToggle={(enabled) => runAccountAction(
                { action: 'set-account-enabled', uid: account.uid, enabled },
                account.label,
              )}
              onLogout={() => runAccountAction({ action: 'logout', uid: account.uid }, account.label)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One account row: identity, state, and the two management actions.
 *
 * Signing out is irreversible (it deletes the stored credential), so it asks for
 * confirmation first — the command path requires typing a uid prefix, which is
 * its own confirmation, and a bare button here would be easier to misfire than
 * either.
 */
function AccountRow({ account, t, busy, onToggle, onLogout }: {
  account: WorkBuddyWebAccount
  t: WorkBuddyConfigPageProps['t']
  busy: boolean
  onToggle: (enabled: boolean) => Promise<void>
  onLogout: () => Promise<void>
}): ReactNode {
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
      <span style={regionStyle}>{account.label}</span>
      <span style={mutedStyle}>{account.uid.slice(0, 8)}</span>
      <span style={mutedStyle}>{t(account.enabled ? 'enabledTag' : 'disabledTag')}</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        style={buttonStyle}
        disabled={busy}
        onClick={() => { void onToggle(!account.enabled) }}
      >
        {t(account.enabled ? 'disable' : 'enable')}
      </button>
      {confirming ? (
        <>
          <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setConfirming(false) }}>
            {t('cancel')}
          </button>
          <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => { void onLogout() }}>
            {t('logoutConfirmAction')}
          </button>
        </>
      ) : (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { setConfirming(true) }}>
          {t('logout')}
        </button>
      )}
      {confirming ? (
        <span style={{ ...mutedStyle, flexBasis: '100%' }}>
          {t('logoutConfirm', { label: account.label })}
        </span>
      ) : null}
    </div>
  )
}

/** Re-exported so the entry can declare the namespace it registers. */
export type { WorkBuddyLocaleKey }
