/**
 * The bundle's configuration page on the Plugins page.
 *
 * Shows the accounts this plugin holds and triggers the same OAuth sign-in the
 * `/wb-login` command drives. The card is a *transport* over the control route,
 * never a second login implementation — a card that authenticated on its own
 * would let the UI report success while the path the rest of the plugin trusts
 * (the credential file and the catalog refresh) never ran.
 *
 * ## Why class names rather than inline styles
 *
 * An inline `style` prop cannot express `:hover`, `:active`, `:focus-visible` or
 * `:disabled`, so a card built entirely from inline styles has no interaction
 * feedback and its disabled buttons look live. All styling therefore lives in
 * `./styles.ts`, installed once per document.
 *
 * ## Why the status document drives every mutation
 *
 * The card never predicts an outcome locally. A toggle the host refused must not
 * look applied, so every action posts and then re-reads the truth.
 *
 * @module dsh-workbuddy-standalone/client/WorkBuddyConfigPage
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: this module registers into `plugins.bundle.config`, which the
// Plugins page declares. A value import would fail the client bundle-purity
// gate, since cross-plugin collaboration goes through cordis services.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { readStatus, sendControl } from './host.ts'
import { installStyles } from './styles.ts'
import { creditSlot } from './credit-slot.ts'
import type { WorkBuddyLocaleKey } from './locales.ts'
import type { WorkBuddyWebAccount, WorkBuddyWebModel, WorkBuddyWebStatus } from '../status-paths.ts'
import type { WorkBuddyCredits } from '../upstream.ts'

/** Props the Plugins page delivers to the bundle's configuration entry. */
export type WorkBuddyConfigPageProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'workbuddy'>

/** Button classes; interaction states come from the stylesheet. */
const BTN = 'wb-btn'
const BTN_PRIMARY = 'wb-btn wb-btn-primary'
const BTN_DANGER = 'wb-btn wb-btn-danger'

/** One region's slice of the status document. */
type RegionView = WorkBuddyWebStatus['regions'][number]

/** How often the card re-checks the status document. */
const RECONCILE_MS = 30_000

/** Which tab is open. */
type Tab = 'accounts' | 'models' | 'credits'

/** A notice, carrying the outcome so the stylesheet can colour it. */
interface Notice {
  text: string
  kind: 'ok' | 'err' | 'warn' | 'busy'
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

/** Render the bundle's configuration. */
export function WorkBuddyConfigPage({ view, t }: WorkBuddyConfigPageProps): ReactNode {
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState<PendingLogin>()
  const [notice, setNotice] = useState<Notice>()
  const [busy, setBusy] = useState(false)
  const [busyKey, setBusyKey] = useState<string>()
  const [tab, setTab] = useState<Tab>('accounts')
  const [credits, setCredits] = useState<Record<string, WorkBuddyCredits>>({})
  const [creditsError, setCreditsError] = useState<Record<string, string>>({})
  const [creditsBusy, setCreditsBusy] = useState<ReadonlySet<string>>(new Set())
  const [confirmingUid, setConfirmingUid] = useState<string>()
  /**
   * Collapsed mode for both card grids: one row per card, name and actions only.
   *
   * Defaults to expanded. Shared by the accounts and credits tabs so switching
   * between them does not silently change how much is on screen.
   */
  const [collapsed, setCollapsed] = useState(false)
  const mounted = useRef(false)
  /**
   * Guards the completion call so two overlapping redeems cannot race: redeeming
   * the same state twice would race, and the loser can only report a failure for
   * a sign-in that actually succeeded.
   */
  const completing = useRef(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const value = await readStatus(signal)
    if (!mounted.current) return
    // An `undefined` answer leaves the previous document in place; only the very
    // first read decides whether the card is loaded, so a later blip does not
    // throw away accounts the user can still act on.
    if (value !== undefined) setStatus(value)
    setLoaded(true)
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
   * in-between answer rather than an error.
   */
  const completeLogin = useCallback(async (state: string): Promise<void> => {
    if (status === undefined || completing.current) return
    completing.current = true
    setBusyKey('refresh')
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
        action: 'login-complete',
        state,
      })
      if (!mounted.current) return
      if (result === undefined) {
        setNotice({ text: t('loginFailed', { reason: t('working') }), kind: 'err' })
        return
      }
      if (result.state === 'ok') {
        setPending(undefined)
        setNotice({ text: t('loginSucceeded', { label: result.reason ?? '' }), kind: 'ok' })
        await refresh()
        return
      }
      if (result.state === 'failed') {
        setPending(undefined)
        setNotice({ text: t('loginFailed', { reason: result.reason ?? '' }), kind: 'err' })
      }
      // A `pending` answer keeps the link and the button so the user can try again
      // once the browser is actually finished.
    } finally {
      completing.current = false
      if (mounted.current) setBusyKey(undefined)
    }
  }, [status, t, refresh])

  const startLogin = async (region: string): Promise<void> => {
    if (status === undefined || busy) return
    setBusy(true)
    setBusyKey(`login-${region}`)
    setNotice(undefined)
    try {
      // The status route is region-independent, so any region's control path can
      // carry `login-begin`; the region travels in the body, not in the route.
      const path = status.regions[0]?.controlPath ?? ''
      const result = await sendControl(path, status.controlKey, { action: 'login-begin', region })
      if (result?.state === 'pending' && result.url !== undefined && result.loginState !== undefined) {
        setPending({ state: result.loginState, url: result.url, region })
      } else {
        setNotice({ text: t('loginFailed', { reason: result?.reason ?? t('loginStarting') }), kind: 'err' })
      }
    } finally {
      if (mounted.current) { setBusy(false); setBusyKey(undefined) }
    }
  }

  /** The card's Refresh: complete any outstanding login, then re-read. */
  const onRefresh = async (): Promise<void> => {
    if (pending !== undefined) {
      await completeLogin(pending.state)
      return
    }
    setBusyKey('refresh')
    await refresh()
    if (mounted.current) setBusyKey(undefined)
  }

  /**
   * Run one per-account control action and re-read the document.
   *
   * Each action reports its own name on failure: reusing the sign-in wording
   * made a failed "disable" read as "sign-in failed", which points the user at
   * the wrong thing entirely.
   */
  const runAccountAction = async (
    body: { action: 'logout'; uid: string } | { action: 'set-account-enabled'; uid: string; enabled: boolean },
    label: string,
  ): Promise<void> => {
    if (status === undefined || busy) return
    const doing = body.action === 'logout' ? t('logoutFailed') : t('toggleAccountFailed')
    setBusy(true)
    setBusyKey(`${body.action}-${body.uid}`)
    setNotice(undefined)
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, body)
      if (result === undefined || result.state !== 'ok') {
        setNotice({
          text: t('actionFailed', { action: doing, reason: result?.reason ?? t('working') }),
          kind: 'err',
        })
        return
      }
      setNotice({
        text: body.action === 'logout'
          ? t('logoutSucceeded', { label })
          : t(body.enabled ? 'enableSucceeded' : 'disableSucceeded', { label }),
        kind: 'ok',
      })
      setConfirmingUid(undefined)
      await refresh()
    } finally {
      if (mounted.current) { setBusy(false); setBusyKey(undefined) }
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
    if (status === undefined || creditsBusy.has(uid)) return
    setCreditsBusy(previous => new Set(previous).add(uid))
    setCreditsError(previous => { const next = { ...previous }; delete next[uid]; return next })
    setBusyKey(`credits-${uid}`)
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
        action: 'refresh-credits',
        uid,
      })
      if (!mounted.current) return
      if (result === undefined || result.state !== 'ok' || result.credits === undefined) {
        setCredits(previous => { const next = { ...previous }; delete next[uid]; return next })
        setCreditsError(previous => ({ ...previous, [uid]: result?.reason ?? t('working') }))
        return
      }
      setCredits(previous => ({ ...previous, [uid]: result.credits! }))
    } finally {
      if (mounted.current) {
        setCreditsBusy(previous => { const next = new Set(previous); next.delete(uid); return next })
        setBusyKey(undefined)
      }
    }
  }

  /** Query every account's balance at once, for the credits tab. */
  const queryAllCredits = async (): Promise<void> => {
    if (status === undefined) return
    await Promise.all(status.accounts.map(account => queryCredits(account.uid)))
  }

  /**
   * Hide or show one model.
   *
   * Posts to the region's own control path — the two regions share model ids, so
   * a model toggle must land on the roster it was listed under.
   */
  const toggleModel = async (region: RegionView, modelId: string, visible: boolean): Promise<void> => {
    if (status === undefined) return
    setBusyKey(`model-${modelId}`)
    try {
      const result = await sendControl(region.controlPath, status.controlKey, {
        action: 'set-model-visible',
        region: region.region,
        modelId,
        visible,
      })
      await refresh()
      if (mounted.current && (result === undefined || result.state !== 'ok')) {
        setNotice({
          text: t('actionFailed', { action: t('hideModelFailed'), reason: result?.reason ?? t('working') }),
          kind: 'err',
        })
      }
    } finally {
      if (mounted.current) setBusyKey(undefined)
    }
  }

  /** Select or clear the maximum-context-window preference. */
  const toggleMaxWindow = async (enabled: boolean): Promise<void> => {
    if (status === undefined) return
    setBusyKey('maxwindow')
    try {
      const result = await sendControl(status.regions[0]?.controlPath ?? '', status.controlKey, {
        action: 'set-maximum-context-window',
        enabled,
      })
      await refresh()
      if (mounted.current && (result === undefined || result.state !== 'ok')) {
        setNotice({
          text: t('actionFailed', { action: t('maxWindowFailed'), reason: result?.reason ?? t('working') }),
          kind: 'err',
        })
      }
    } finally {
      if (mounted.current) setBusyKey(undefined)
    }
  }

  if (view === 'summary') return t('intro')

  const maxWindow = status?.regions[0]?.useMaximumContextWindow === true
  /**
   * How many models the maximum-window toggle actually changes, counted from the
   * roster rather than assumed: a region whose models all declare one window is
   * unaffected, and the hint must not promise a change that cannot happen.
   */
  const windowAffected = status === undefined
    ? 0
    : status.regions.reduce((sum, region) => sum + region.models.filter(model => model.multiWindow === true).length, 0)

  const tabButton = (id: Tab, label: string): ReactNode => (
    <button
      type="button"
      role="tab"
      className="wb-tab"
      aria-selected={tab === id}
      onClick={() => { setTab(id) }}
    >
      {label}
    </button>
  )

  return (
    <section className="wb-card">
      {/*
        The signed-in count rides on the title row, right of the name and smaller
        than it: it qualifies the title rather than competing with it. It lives
        here because it describes the plugin as a whole, not the accounts tab —
        the row that used to repeat it inside that tab was titled "sign-in state",
        which read as a second heading.
      */}
      <div className="wb-titlerow">
        <span className="wb-title">{t('title')}</span>
        {status === undefined || status.accounts.length === 0
          ? null
          : <span className="wb-count">{t('accountCount', { count: status.accounts.length })}</span>}
      </div>
      <span className="wb-intro">{t('intro')}</span>

      <div className="wb-row">
        {/*
          Both sign-in buttons use the same outline style. They are peers — two
          ways to reach the same account list, differing only in region — so
          neither is more "primary" than the other.
        */}
        <button
          type="button"
          className={BTN}
          disabled={busy || status === undefined}
          data-busy={busyKey === 'login-cn' ? '1' : undefined}
          onClick={() => { void startLogin('cn') }}
        >
          {t('login')} · {t('regionCn')}
        </button>
        <button
          type="button"
          className={BTN}
          disabled={busy || status === undefined}
          data-busy={busyKey === 'login-global' ? '1' : undefined}
          onClick={() => { void startLogin('global') }}
        >
          {t('login')} · {t('regionGlobal')}
        </button>
        <button
          type="button"
          className={BTN}
          disabled={status === undefined}
          data-busy={busyKey === 'refresh' ? '1' : undefined}
          onClick={() => { void onRefresh() }}
        >
          {t('refresh')}
        </button>
        {/*
          The collapse control lives on the toolbar row, after the actions, so
          both card tabs place it identically. It belongs to the card grids only:
          the model roster is the content that tab exists for, so collapsing it
          would leave nothing to do, and it is not offered there.
        */}
        {status === undefined || status.accounts.length === 0 || (tab !== 'accounts' && tab !== 'credits')
          ? null
          : (
            <>
              <span className="wb-spacer" />
              <button
                type="button"
                className={BTN}
                aria-pressed={collapsed}
                onClick={() => { setCollapsed(!collapsed) }}
              >
                {collapsed ? t('expand') : t('collapse')}
              </button>
            </>
          )}
      </div>

      {/*
        The pending sign-in carries its OWN completion button. The hint used to
        point at the toolbar's Refresh, which sat far from the link while the only
        button beside it was Cancel — so the nearest affordance was the wrong one.
      */}
      {pending === undefined ? null : (
        <div className="wb-note wb-note-busy wb-panel">
          <span>{t('loginOpenLink')}</span>
          <span>
            <a href={pending.url} target="_blank" rel="noreferrer" className="wb-link">{pending.url}</a>
          </span>
          <span className="wb-row">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busyKey === 'refresh'}
              data-busy={busyKey === 'refresh' ? '1' : undefined}
              onClick={() => { void completeLogin(pending.state) }}
            >
              {t('loginConfirmAction')}
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setPending(undefined)
                setNotice({ text: t('loginCancelled'), kind: 'warn' })
              }}
            >
              {t('cancel')}
            </button>
            <span className="wb-hint">{t('loginRefreshHint')}</span>
          </span>
        </div>
      )}

      {notice === undefined ? null : (
        <span role="status" aria-live="polite" className={`wb-note wb-note-${notice.kind} wb-row`}>
          {notice.text}
          <span className="wb-spacer" />
          <button type="button" className={BTN} onClick={() => { setNotice(undefined) }}>
            {t('dismiss')}
          </button>
        </span>
      )}

      {/* Loading, then a failure the user can act on — previously both were a
          silent empty card with greyed buttons and no explanation. */}
      {status === undefined ? (
        loaded ? (
          <>
            <span className="wb-note wb-note-err wb-row">
              {t('statusUnavailable')}
              <span className="wb-spacer" />
              <button type="button" className={BTN} onClick={() => { setLoaded(false); void refresh() }}>
                {t('retry')}
              </button>
            </span>
            <span className="wb-hint">{t('statusUnavailableHint')}</span>
          </>
        ) : (
          <span className="wb-note wb-note-busy wb-row">{t('statusLoading')}</span>
        )
      ) : null}

      {status === undefined ? null : (
        <>
          <div role="tablist" className="wb-tabbar">
            {tabButton('accounts', t('tabAccounts'))}
            {tabButton('models', t('tabModels'))}
            {tabButton('credits', t('tabCredits'))}
          </div>

          {tab === 'accounts' ? (
            <div className="wb-panel">
              {status.accounts.length === 0 ? (
                <span className="wb-note">{t('creditsNone')}</span>
              ) : (
                <AccountCards
                  accounts={status.accounts}
                  t={t}
                  busy={busy}
                  busyKey={busyKey}
                  confirmingUid={confirmingUid}
                  collapsed={collapsed}
                  onAskLogout={setConfirmingUid}
                  onCancelLogout={() => { setConfirmingUid(undefined) }}
                  onToggle={(uid, enabled) => runAccountAction({ action: 'set-account-enabled', uid, enabled }, labelOf(status, uid))}
                  onLogout={(uid) => runAccountAction({ action: 'logout', uid }, labelOf(status, uid))}
                />
              )}
            </div>
          ) : null}

          {/*
            One tab for both regions, each rendered as its own block. The
            maximum-window switch stays on the region it can affect: only the
            international roster declares supportedContextWindows, so on the
            domestic block it would be a control that changes nothing.
          */}
          {tab === 'models' ? (
            <div className="wb-panel">
              {status.regions.map(region => (
                <RegionBlock
                  key={region.region}
                  region={region}
                  t={t}
                  busy={busy}
                  busyKey={busyKey}
                  maxWindow={maxWindow}
                  windowAffected={windowAffected}
                  onToggleMaxWindow={toggleMaxWindow}
                  onToggleModel={(modelId, visible) => toggleModel(region, modelId, visible)}
                  onLogin={() => { void startLogin(region.region) }}
                />
              ))}
            </div>
          ) : null}

          {tab === 'credits' ? (
            <div className="wb-panel">
              <div className="wb-row">
                <span className="wb-label">{t('creditsHeading')}</span>
                <span className="wb-muted">{t('accountCount', { count: status.accounts.length })}</span>
                <span className="wb-spacer" />
                <button
                  type="button"
                  className={BTN}
                  disabled={status.accounts.length === 0 || creditsBusy.size > 0}
                  onClick={() => { void queryAllCredits() }}
                >
                  {t('creditsRefreshAll')}
                </button>
              </div>
              {status.accounts.length === 0 ? (
                <span className="wb-note">{t('creditsNone')}</span>
              ) : (
                <span className="wb-hint">{t('creditsIntro')}</span>
              )}
              <div className={collapsed ? 'wb-acct-cards wb-acct-cards-collapsed' : 'wb-acct-cards'}>
                {status.accounts.map(account => (
                  <CreditCard
                    key={account.uid}
                    account={account}
                    t={t}
                    credits={credits[account.uid]}
                    error={creditsError[account.uid]}
                    busy={creditsBusy.has(account.uid)}
                    onQuery={() => { void queryCredits(account.uid) }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

/** One account's label, for an action's success message. */
function labelOf(status: WorkBuddyWebStatus, uid: string): string {
  return status.accounts.find(account => account.uid === uid)?.label ?? uid.slice(0, 8)
}

/**
 * The account list, as a grid of cards.
 *
 * Cards rather than a table. A table needs a header row to say what each column
 * is, and that header plus its separator sat directly under the tab strip's own
 * border — two rules stacked, which read as clutter. A card carries its own
 * context instead: the uid, state and token lifetime sit under the name they
 * describe, so no header is needed at all.
 *
 * The grid is `auto-fill` with a minimum width (in the stylesheet), so a narrow
 * settings panel drops to one column rather than squeezing two.
 */
function AccountCards({ accounts, t, busy, busyKey, confirmingUid, collapsed, onAskLogout, onCancelLogout, onToggle, onLogout }: {
  accounts: readonly WorkBuddyWebAccount[]
  t: WorkBuddyConfigPageProps['t']
  busy: boolean
  busyKey: string | undefined
  confirmingUid: string | undefined
  collapsed: boolean
  onAskLogout: (uid: string) => void
  onCancelLogout: () => void
  onToggle: (uid: string, enabled: boolean) => Promise<void>
  onLogout: (uid: string) => Promise<void>
}): ReactNode {
  return (
    <div className={collapsed ? 'wb-acct-cards wb-acct-cards-collapsed' : 'wb-acct-cards'}>
      {accounts.map(account => {
        const confirming = confirmingUid === account.uid
        const expiry = expiryOf(account, t)
        return (
          <div key={account.uid} className="wb-acct-card">
            {confirming ? (
              /*
               * The confirmation replaces the whole card body. While it is open
               * the other actions are gone rather than merely disabled: two
               * competing buttons in one card is how the wrong one gets pressed.
               */
              <div className="wb-confirm">
                <span className="wb-label">{t('logoutConfirmTitle', { label: account.label })}</span>
                <span className="wb-muted">{t('logoutConfirmBody')}</span>
                <span className="wb-confirm-actions">
                  <button type="button" className={BTN} onClick={onCancelLogout}>
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    className={BTN_DANGER}
                    disabled={busy}
                    data-busy={busyKey === `logout-${account.uid}` ? '1' : undefined}
                    onClick={() => { void onLogout(account.uid) }}
                  >
                    {t('logoutConfirmAction')}
                  </button>
                </span>
              </div>
            ) : (
              <>
                <div className="wb-acct-main">
                  <div className="wb-acct-top">
                    <span className="wb-acct-name" title={account.label}>{account.label}</span>
                    <span className="wb-badge">
                      {account.region === 'cn' ? t('regionCn') : t('regionGlobal')}
                    </span>
                  </div>
                  <div className="wb-acct-meta">
                    <span className="wb-acct-uid">{account.uid.slice(0, 8)}</span>
                    <span className="wb-acct-sep">·</span>
                    <span className={account.enabled ? undefined : 'wb-tag-off'}>
                      {account.enabled ? t('enabledTag') : t('disabledTag')}
                    </span>
                    <span className="wb-acct-sep">·</span>
                    <span className={`wb-acct-exp ${expiry.warn ? 'wb-tag-warn' : ''}`}>{expiry.text}</span>
                  </div>
                </div>
                <div className="wb-acct-actions">
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    data-busy={busyKey === `set-account-enabled-${account.uid}` ? '1' : undefined}
                    onClick={() => { void onToggle(account.uid, !account.enabled) }}
                  >
                    {account.enabled ? t('disable') : t('enable')}
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    disabled={busy}
                    onClick={() => { onAskLogout(account.uid) }}
                  >
                    {t('logout')}
                  </button>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * How long this account's access token lasts, as text.
 *
 * The status document has always carried `expiresAtMs` and the card never showed
 * it, so a token about to lapse was invisible until the next request failed.
 * Days only past 48 hours, so a nine-hour token is not reported as "0 days".
 */
function expiryOf(account: WorkBuddyWebAccount, t: WorkBuddyConfigPageProps['t']): { text: string, warn: boolean } {
  const left = account.expiresAtMs - Date.now()
  if (left <= 0) return { text: t('tokenExpired'), warn: true }
  const minutes = Math.floor(left / 60_000)
  if (minutes < 60) return { text: t('tokenRefreshesInMinutes', { minutes }), warn: minutes < 5 }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return { text: t('tokenRefreshesIn', { hours }), warn: false }
  return { text: t('tokenRefreshesInDays', { days: Math.floor(hours / 24) }), warn: false }
}

/**
 * One region's block: its models, and the maximum-window switch where it applies.
 *
 * No collapse behaviour. Collapsing exists to make a long *list of accounts*
 * scannable; a model roster is exactly the content this tab is opened for, so
 * hiding parts of it would leave the tab with nothing to do.
 */
function RegionBlock({ region, t, busy, busyKey, maxWindow, windowAffected, onToggleMaxWindow, onToggleModel, onLogin }: {
  region: RegionView
  t: WorkBuddyConfigPageProps['t']
  busy: boolean
  busyKey: string | undefined
  maxWindow: boolean
  windowAffected: number
  onToggleMaxWindow: (enabled: boolean) => Promise<void>
  onToggleModel: (modelId: string, visible: boolean) => void
  onLogin: () => void
}): ReactNode {
  const hidden = new Set(region.hiddenModels)
  const affects = region.models.filter(model => model.multiWindow === true).length
  return (
    <div className="wb-panel">
      <div className="wb-region-head">
        <span className="wb-region-title">{region.label}</span>
        <span className={region.signedIn ? 'wb-ok' : 'wb-muted'}>
          {region.signedIn
            ? t('signedInWithModels', { count: region.models.length })
            : t('signedOut')}
        </span>
      </div>

      {region.signedIn ? null : (
        <div className="wb-row">
          <span className="wb-note">{t('noAccountsInRegion')}</span>
          <button type="button" className={BTN} disabled={busy} onClick={onLogin}>
            {t('login')} · {region.region === 'cn' ? t('regionCn') : t('regionGlobal')}
          </button>
        </div>
      )}

      {/*
        The switch renders only where it can do something, and there is no note
        where it cannot. Only the international roster declares secondary
        context windows, so a "this region has no such switch" line would appear
        on exactly one block, every time — explaining the absence of a control
        the user was never shown, on a tab whose purpose is the model list.
      */}
      {!region.signedIn || affects === 0 ? null : (
        <label className="wb-maxrow">
          <input
            type="checkbox"
            checked={maxWindow}
            disabled={busyKey === 'maxwindow'}
            onChange={() => { void onToggleMaxWindow(!maxWindow) }}
          />
          <span className="wb-label">{t('useMaximumContextWindow')}</span>
          <span className="wb-spacer" />
          <span className="wb-hint">
            {maxWindow
              ? t('maxWindowHintOn', { count: windowAffected })
              : t('maxWindowHintOff', { count: windowAffected })}
          </span>
        </label>
      )}

      {region.signedIn && region.models.length > 0 ? (
        <>
          <div className="wb-grid">
            {region.models.map(model => (
              <label key={model.id} className="wb-mrow">
                <input
                  type="checkbox"
                  checked={!hidden.has(model.id)}
                  onChange={() => onToggleModel(model.id, hidden.has(model.id))}
                />
                <span className="wb-mname" style={hidden.has(model.id) ? { opacity: 0.45 } : undefined}>
                  {model.name}
                </span>
                <span className={maxWindow && model.multiWindow === true ? 'wb-ctx wb-ctx-up' : 'wb-ctx'}>
                  {formatContext(model.contextWindow)}
                </span>
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

/**
 * One account's credit balance, in the same card shape as the accounts tab.
 *
 * The right slot carries whatever this card's state calls for — a button before
 * the first check, then the number itself, which is also the button that checks
 * again. One slot, one element: an earlier layout showed a value and a "check
 * again" button side by side, which said the same thing twice.
 *
 * **Collapsing does not change the slot.** A previous version swapped the number
 * for a plain button when collapsed, which left the fetched balance with nowhere
 * to appear: pressing the button looked like it had done nothing at all. What
 * collapse hides is the second, descriptive line, never the result.
 */
function CreditCard({ account, t, credits, error, busy, onQuery }: {
  account: WorkBuddyWebAccount
  t: WorkBuddyConfigPageProps['t']
  credits: WorkBuddyCredits | undefined
  error: string | undefined
  busy: boolean
  onQuery: () => void
}): ReactNode {
  const expiry = expiryOf(account, t)
  const slot = creditSlot(busy, error, credits)
  let body: ReactNode
  if (slot.kind === 'loading') {
    body = <button type="button" className={BTN} disabled data-busy="1">{t('creditsLoading')}</button>
  } else if (slot.kind === 'retry') {
    body = <button type="button" className={BTN} onClick={onQuery}>{t('retry')}</button>
  } else if (slot.kind === 'query') {
    body = <button type="button" className={BTN} onClick={onQuery}>{t('queryCredits')}</button>
  } else if (slot.kind === 'unlimited') {
    body = (
      <button type="button" className="wb-credit-value" title={t('requeryCredits')} onClick={onQuery}>
        <span className="wb-credit-unlimited">{t('creditsUnlimited')}</span>
      </button>
    )
  } else {
    body = (
      <button type="button" className="wb-credit-value" title={t('requeryCredits')} onClick={onQuery}>
        <span className="wb-credit-num">{slot.total}</span>
        <span className="wb-credit-unit">{t('creditsUnit')}</span>
      </button>
    )
  }

  return (
    <div className={error === undefined ? 'wb-credit-card' : 'wb-credit-card wb-credit-card-err'}>
      <div className="wb-credit-main">
        <div className="wb-credit-top">
          <span className="wb-credit-name" title={account.label}>{account.label}</span>
          <span className="wb-badge">{account.region === 'cn' ? t('regionCn') : t('regionGlobal')}</span>
        </div>
        <div className="wb-credit-meta">
          <span className="wb-acct-uid">{account.uid.slice(0, 8)}</span>
          <span className="wb-acct-sep">·</span>
          <span className={account.enabled ? undefined : 'wb-tag-off'}>
            {account.enabled ? t('enabledTag') : t('disabledTag')}
          </span>
          <span className="wb-acct-sep">·</span>
          <span className={`wb-acct-exp ${expiry.warn ? 'wb-tag-warn' : ''}`}>{expiry.text}</span>
          {error === undefined ? null : (
            <>
              <span className="wb-acct-sep">·</span>
              <span className="wb-tag-off">{t('creditsError', { reason: error })}</span>
            </>
          )}
        </div>
      </div>
      <div className="wb-credit-slot">{body}</div>
    </div>
  )
}

/** Render a token count compactly: 1,000,000 → `1M`, 192,000 → `192K`. */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  return `${Math.round(tokens / 1_000)}K`
}

/** Re-exported so the entry can declare the namespace it registers. */
export type { WorkBuddyLocaleKey }
