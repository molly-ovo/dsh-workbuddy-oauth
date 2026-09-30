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
import type { WorkBuddyCredits } from '../upstream.ts'

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
/** The region group title, one step larger than the body text it labels. */
const regionTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}
/** The region row header: a full-width toggle for the model list it opens. */
const regionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
}
/** The "expand / collapse" affordance on the region row; a word, not a glyph. */
const toggleStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 12,
  lineHeight: 1,
  color: 'var(--dsw-alias-label-tertiary)',
}
/**
 * The model list as a responsive grid rather than one long column: 24 rows in a
 * wide card is a wall of checkboxes with most of the width empty. Cells are
 * ~200px minimum so a narrow card falls back to one column and a wide one wraps
 * into two or three, without any JS measuring.
 */
const modelGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: '2px 16px',
  alignItems: 'center',
}
/** One grid cell: checkbox, then name, then a right-aligned window figure. */
const modelRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}
/** The per-model context window, right-aligned so the figures form a column. */
const contextStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
  fontVariantNumeric: 'tabular-nums',
}
/**
 * The maximum-window toggle: label first, control last, flush left with the
 * group titles above the model grid. No explanatory copy — the label names the
 * behaviour, and the host applies it only where a larger window exists.
 */
const maxWindowRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}
const mutedStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
/** Success state, so "signed in" reads differently from a neutral label. */
const signedInStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' }
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
// `brand-primary`, not `label-link`: the latter is not one of the theme's tokens,
// so the link colour depended on a hard-coded fallback instead of the theme.
const linkStyle: CSSProperties = { color: 'var(--dsw-alias-brand-primary)', fontSize: 12 }

/** The tab bar row. */
const tabBarStyle: CSSProperties = { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2)' }
/** One tab; the active one reads as selected rather than a plain button. */
const tabStyle: CSSProperties = {
  padding: '4px 12px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  borderBottom: '2px solid var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
}

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
  const [tab, setTab] = useState<'accounts' | 'models'>('accounts')
  const [credits, setCredits] = useState<Record<string, WorkBuddyCredits>>({})
  const [creditsBusy, setCreditsBusy] = useState<ReadonlySet<string>>(new Set())
  const mounted = useRef(false)
  /**
   * Guards the completion call so two overlapping redeems cannot race: redeeming
   * the same state twice would race, and the loser can only report a failure for
   * a sign-in that actually succeeded.
   */
  const completing = useRef(false)

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
   * Redeem an outstanding authorization.
   *
   * The upstream does not report the browser approval to us; the host finds out
   * by redeeming the state, so this is a question, and `pending` is a normal
   * in-between answer rather than an error. There is no dedicated "confirm"
   * button — the card's Refresh re-reads status and completes any outstanding
   * login, which is the single affordance the user needs.
   */
  const completeLogin = useCallback(async (state: string): Promise<void> => {
    if (status === undefined || completing.current) return
    completing.current = true
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
        action: 'login-complete',
        state,
      })
      if (!mounted.current) return
      if (result === undefined) {
        setPending(undefined)
        setNotice(t('loginFailed', { reason: 'control route unreachable' }))
        return
      }
      if (result.state === 'ok') {
        setPending(undefined)
        setNotice(t('loginSucceeded', { label: result.reason ?? '' }))
        await refresh()
        return
      }
      if (result.state === 'failed') {
        setPending(undefined)
        setNotice(t('loginFailed', { reason: result.reason ?? '' }))
      }
      // `pending` keeps the link + hint so the user can refresh again once the
      // browser is finished.
    } finally {
      completing.current = false
    }
  }, [status, t, refresh])

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
   * The card's Refresh: complete any outstanding login, then re-read the
   * document. Completing first is what lets Refresh substitute for the removed
   * "confirm" button — after the user authorizes in the browser, Refresh redeems
   * the state and shows the new account in one gesture.
   */
  const onRefresh = async (): Promise<void> => {
    if (pending !== undefined) await completeLogin(pending.state)
    await refresh()
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

  /**
   * Fetch one account's credit balance and hold it for display.
   *
   * The balance is shown from local state rather than the status document: a
   * status read must not make a network call per account, so the balance is only
   * fetched when the user asks. A failed fetch clears any stale value, so the
   * card never keeps showing a balance it can no longer stand behind.
   */
  const queryCredits = async (uid: string): Promise<void> => {
    if (status === undefined) return
    setCreditsBusy(previous => new Set(previous).add(uid))
    setNotice(undefined)
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
        action: 'refresh-credits',
        uid,
      })
      if (result === undefined || result.state !== 'ok' || result.credits === undefined) {
        setCredits(previous => { const next = { ...previous }; delete next[uid]; return next })
        setNotice(t('creditsError', { reason: result?.reason ?? t('working') }))
        return
      }
      setCredits(previous => ({ ...previous, [uid]: result.credits! }))
    } finally {
      if (mounted.current) setCreditsBusy(previous => { const next = new Set(previous); next.delete(uid); return next })
    }
  }

  /**
   * Hide or show one model.
   *
   * Posts to the region's own control path — the two regions share model ids, so
   * a model toggle must land on the roster it was listed under.
   */
  const toggleModel = async (region: WorkBuddyWebStatus['regions'][number], modelId: string, visible: boolean): Promise<void> => {
    if (status === undefined) return
    const result = await sendControl(region.controlPath, status.controlKey, {
      action: 'set-model-visible',
      region: region.region,
      modelId,
      visible,
    })
    await refresh()
    if (result === undefined || result.state !== 'ok') {
      setNotice(t('loginFailed', { reason: result?.reason ?? t('working') }))
    }
  }

  /**
   * Select or clear the maximum-context-window preference.
   *
   * One flag shared across regions; the host owns the catalog flag and the
   * persistence, so the checkbox and the picker cannot disagree.
   */
  const toggleMaxWindow = async (enabled: boolean): Promise<void> => {
    if (status === undefined) return
    const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
      action: 'set-maximum-context-window',
      enabled,
    })
    await refresh()
    if (result === undefined || result.state !== 'ok') {
      setNotice(t('loginFailed', { reason: result?.reason ?? t('working') }))
    }
  }

  if (view === 'summary') return t('intro')

  const maxWindow = status?.regions[0]?.useMaximumContextWindow === true

  return (
    <section style={sectionStyle}>
      <span style={titleStyle}>{t('title')}</span>
      <span style={introStyle}>{t('intro')}</span>

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
          onClick={() => { void onRefresh() }}
        >
          {t('refresh')}
        </button>
      </div>

      {pending === undefined ? null : (
        <span style={noticeStyle}>
          <span>
            {t('loginOpenLink')}
            {' '}
            <a href={pending.url} target="_blank" rel="noreferrer" style={linkStyle}>{pending.url}</a>
            {' '}
            {t('loginRefreshHint')}
          </span>
          <button type="button" style={buttonStyle} onClick={() => { setPending(undefined) }}>
            {t('cancel')}
          </button>
        </span>
      )}

      {notice === undefined ? null : (
        <span role="status" aria-live="polite" style={noticeStyle}>{notice}</span>
      )}

      {status === undefined ? null : (
        <>
          <div role="tablist" style={tabBarStyle}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'accounts'}
              style={tab === 'accounts' ? tabActiveStyle : tabStyle}
              onClick={() => { setTab('accounts') }}
            >
              {t('tabAccounts')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'models'}
              style={tab === 'models' ? tabActiveStyle : tabStyle}
              onClick={() => { setTab('models') }}
            >
              {t('tabModels')}
            </button>
          </div>

          {tab === 'accounts' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={rowStyle}>
                <span style={regionStyle}>{t('loginState')}</span>
                <span style={status.accounts.length === 0 ? mutedStyle : signedInStyle}>
                  {status.accounts.length === 0
                    ? t('noAccounts')
                    : t('accountCount', { count: status.accounts.length })}
                </span>
              </div>
              {status.accounts.map(account => (
                <AccountRow
                  key={account.uid}
                  account={account}
                  t={t}
                  busy={busy}
                  credits={credits[account.uid]}
                  creditsBusy={creditsBusy.has(account.uid)}
                  onQueryCredits={() => queryCredits(account.uid)}
                  onToggle={(enabled) => runAccountAction(
                    { action: 'set-account-enabled', uid: account.uid, enabled },
                    account.label,
                  )}
                  onLogout={() => runAccountAction({ action: 'logout', uid: account.uid }, account.label)}
                />
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={maxWindowRowStyle}>
                <span style={regionStyle}>{t('useMaximumContextWindow')}</span>
                <input
                  type="checkbox"
                  checked={maxWindow}
                  onChange={() => { void toggleMaxWindow(!maxWindow) }}
                />
              </label>
              {status.regions.map(region => (
                <RegionBlock
                  key={region.region}
                  region={region}
                  t={t}
                  onToggleModel={(modelId, visible) => toggleModel(region, modelId, visible)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/**
 * One region block: the sign-in summary, then its models with context window and
 * a visibility checkbox.
 *
 * The checkbox is the borrow from connect's ContextTable: the hidden set lives
 * host-side, and the card only renders which boxes are ticked. A signed-out
 * region lists no models, so the checkbox column simply does not appear.
 */
function RegionBlock({ region, t, onToggleModel }: {
  region: WorkBuddyWebStatus['regions'][number]
  t: WorkBuddyConfigPageProps['t']
  onToggleModel: (modelId: string, visible: boolean) => void
}): ReactNode {
  const hidden = new Set(region.hiddenModels)
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        style={{ ...regionHeaderStyle, cursor: region.models.length === 0 ? 'default' : 'pointer' }}
        aria-expanded={region.models.length === 0 ? undefined : expanded}
        disabled={region.models.length === 0}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={regionTitleStyle}>{region.label}</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, marginLeft: 'auto', flex: '0 0 auto' }}>
          <span style={region.signedIn ? signedInStyle : mutedStyle}>
            {region.signedIn
              ? t('signedInWithModels', { count: region.models.length })
              : t('signedOut')}
          </span>
          {region.models.length === 0 ? null : (
            <span aria-hidden="true" style={toggleStyle}>
              {expanded ? t('collapse') : t('expand')}
            </span>
          )}
        </span>
      </button>
      {!expanded || region.models.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={mutedStyle}>{t('modelVisibilityIntro')}</span>
          <div style={modelGridStyle}>
            {region.models.map(model => (
              <label key={model.id} style={modelRowStyle}>
                <input
                  type="checkbox"
                  checked={!hidden.has(model.id)}
                  onChange={() => onToggleModel(model.id, hidden.has(model.id))}
                />
                <span style={{ ...regionStyle, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {model.name}
                </span>
                <span style={contextStyle}>{formatContext(model.contextWindow)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Render a token count compactly: 1,000,000 → `1M`, 192,000 → `192K`. */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

/**
 * One account row: identity, state, and the management actions.
 *
 * Signing out is irreversible (it deletes the stored credential), so it asks for
 * confirmation first — the command path requires typing a uid prefix, which is
 * its own confirmation, and a bare button here would be easier to misfire than
 * either.
 */
function AccountRow({ account, t, busy, credits, creditsBusy, onQueryCredits, onToggle, onLogout }: {
  account: WorkBuddyWebAccount
  t: WorkBuddyConfigPageProps['t']
  busy: boolean
  credits?: WorkBuddyCredits | undefined
  creditsBusy: boolean
  onQueryCredits: () => void
  onToggle: (enabled: boolean) => Promise<void>
  onLogout: () => Promise<void>
}): ReactNode {
  const [confirming, setConfirming] = useState(false)
  return (
    <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
      <span style={regionStyle}>{account.label}</span>
      <span style={mutedStyle}>{account.uid.slice(0, 8)}</span>
      {credits !== undefined ? (
        <span style={mutedStyle}>{renderCredits(credits, t)}</span>
      ) : null}
      <span style={mutedStyle}>{t(account.enabled ? 'enabledTag' : 'disabledTag')}</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        style={buttonStyle}
        disabled={busy || creditsBusy}
        onClick={() => { onQueryCredits() }}
      >
        {creditsBusy ? t('creditsLoading') : t('queryCredits')}
      </button>
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

/** The account's total balance, shown inline beside its uid. */
function renderCredits(credits: WorkBuddyCredits, t: WorkBuddyConfigPageProps['t']): string {
  return credits.unlimited === true
    ? t('creditsUnlimited')
    : t('creditsTotal', { total: credits.total })
}

/** Re-exported so the entry can declare the namespace it registers. */
export type { WorkBuddyLocaleKey }
