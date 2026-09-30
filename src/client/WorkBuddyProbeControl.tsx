/**
 * Per-model reasoning-level detection beside the composer's model selector.
 *
 * The reasoning-level gap this control closes: the upstream no longer declares
 * `supportedEfforts` for most models, so the picker shows no level chooser for
 * them. A user-authorized probe records which spellings the upstream accepts,
 * and once recorded the adapter exposes those levels in the dropdown. This
 * control is the *trigger* — the levels themselves appear in the model picker,
 * never here.
 *
 * One icon, annotated with a static label and a tooltip. It shows only when the
 * selected model belongs to this plugin and is an undeclared, reasoning-capable
 * row — every other selection renders nothing, which is what keeps the icon off
 * non-WorkBuddy models.
 *
 * @module dsh-workbuddy-standalone/client/WorkBuddyProbeControl
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { WorkBuddyLocaleKey } from './locales.ts'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { readStatus, regionOfProvider, sendControl } from './host.ts'
import type { WorkBuddyWebProbeModel, WorkBuddyWebRegion, WorkBuddyWebStatus } from '../status-paths.ts'

/** Injected props; `directory` resolves the session's current model selection. */
export interface WorkBuddyProbeControlProps {
  directory: ModelDirectory['store']
  t: Translate<WorkBuddyLocaleKey>
}

/** How often the control re-checks state while the window is focused. */
const RECONCILE_MS = 60_000

const wrapperStyle: CSSProperties = {
  display: 'inline-flex',
  position: 'relative',
  alignItems: 'center',
  transform: 'translateY(2px)',
  marginRight: -8,
}
const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  height: 30,
  padding: '0 6px',
  border: 0,
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}
const labelStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}
const tooltipStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 'calc(100% + 8px)',
  zIndex: 1000,
  transform: 'translateX(-50%)',
  padding: '4px 8px',
  borderRadius: 6,
  background: 'var(--dsw-specific-tip, #1f2329)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary, #fff)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
}
const confirmStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 1001,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  width: 260,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '18px',
}
const confirmRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
const confirmButtonStyle: CSSProperties = {
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
  ...confirmButtonStyle,
  border: '1px solid var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}
const noteStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 1001,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}

/**
 * The model-selection store's snapshot, as this control reads it. Only the
 * selection matters here; the rest of the directory snapshot is the picker's
 * business.
 */
interface SelectionSnapshot {
  current: { provider: string; model: string } | null
}

/** Whether a model id is in the region's probe-candidate list. */
function isCandidate(region: WorkBuddyWebRegion, model: string): boolean {
  return region.probeCandidates.includes(model)
}

/** The recorded observation for a model, or `undefined`. */
function resultFor(region: WorkBuddyWebRegion, model: string): WorkBuddyWebProbeModel | undefined {
  return region.probeResults.find(result => result.id === model)
}

/**
 * The model-selection snapshot read through `useSyncExternalStore`. The
 * directory's store is the same uSES-shaped object connect reads, so this
 * control can stay model-agnostic about where the selection comes from.
 */
function useSelection(directory: ModelDirectory['store']): { provider: string; model: string } | null {
  const subscribe = useCallback((listener: () => void) => directory.subscribe(listener), [directory])
  const snapshot = useCallback(() => directory.getSnapshot() as unknown as SelectionSnapshot, [directory])
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  return value.current
}

/**
 * The per-model control. Mounted with a `key` so a selection change remounts it
 * and clears any open bubble.
 */
export function WorkBuddyProbeControl({ directory, t }: WorkBuddyProbeControlProps) {
  const selection = useSelection(directory)
  const [status, setStatus] = useState<WorkBuddyWebStatus>()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const [note, setNote] = useState<WorkBuddyWebProbeModel>()
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const readSeq = useRef(0)
  const tooltipId = useId()

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++readSeq.current
    const value = await readStatus(signal)
    if (mounted.current && !signal?.aborted && seq === readSeq.current && value !== undefined) setStatus(value)
  }, [])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => { void refresh(controller.signal) }, RECONCILE_MS)
    window.addEventListener('focus', () => { void refresh(controller.signal) })
    return () => {
      mounted.current = false
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('focus', () => { void refresh(controller.signal) })
    }
  }, [refresh])

  if (selection === null || status === undefined) return null

  const region = regionOfProvider(status, selection.provider)
  if (region === undefined) return null

  const model = selection.model
  const result = resultFor(region, model)
  // A recorded result keeps the entry visible even once the model leaves the
  // candidate list — that is the case the tooltip reports a verified answer in.
  const visible = isCandidate(region, model) || result !== undefined
  if (!visible) return null

  const detect = async (): Promise<void> => {
    if (inFlight.current || region.probeRunning) return
    inFlight.current = true
    setNote(undefined)
    setConfirming(false)
    setBusy(true)
    setFailed(false)
    try {
      const outcome = await sendControl(region.controlPath, status.controlKey, { action: 'probe', model })
      if (outcome === undefined || outcome.state !== 'ok') {
        if (mounted.current) setFailed(true)
        return
      }
      // The response carries no result body; re-read the document so the levels
      // come from the same judgement the adapter applies, not from this control's
      // guess about what a success means.
      await refresh()
      const fresh = resultFor(region, model)
      if (fresh !== undefined && mounted.current) setNote(fresh)
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const text = busy
    ? t('probeTooltipRunning', { model })
    : result !== undefined && result.validation === 'validating' && result.efforts.length > 0
      ? t('probeTooltipVerified', { levels: result.efforts.join(' / ') })
      : failed
        ? t('probeTooltipRetry')
        : t('probeTooltipIdle', { model })

  const showTooltip = tooltipVisible && !confirming && note === undefined

  return (
    <span
      style={wrapperStyle}
      onMouseEnter={() => { setTooltipVisible(true) }}
      onMouseLeave={() => { setTooltipVisible(false) }}
    >
      <button
        type="button"
        aria-label={text}
        aria-describedby={showTooltip ? tooltipId : undefined}
        aria-busy={busy}
        aria-expanded={confirming}
        disabled={busy || region.probeRunning}
        onClick={() => { setConfirming(true) }}
        onFocus={() => { setTooltipVisible(true) }}
        onBlur={() => { setTooltipVisible(false) }}
        style={{ ...buttonStyle, opacity: (busy || region.probeRunning) && !confirming ? 0.6 : 1 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4" />
          <path d="M12 12 20 4" />
          <circle cx="12" cy="12" r="1" />
        </svg>
        <span style={labelStyle}>{t('probeLabel')}</span>
      </button>

      {showTooltip && (
        <span id={tooltipId} role="tooltip" style={tooltipStyle}>{text}</span>
      )}

      {confirming && (
        <span style={confirmStyle}>
          <span>{t('probeConfirmBody')}</span>
          <span style={confirmRowStyle}>
            <button type="button" style={confirmButtonStyle} onClick={() => { setConfirming(false) }}>
              {t('cancel')}
            </button>
            <button type="button" style={primaryButtonStyle} onClick={() => { void detect() }}>
              {t('probeConfirmAction')}
            </button>
          </span>
        </span>
      )}

      {note === undefined ? null : (
        <span role="status" aria-live="polite" style={noteStyle}>
          <span>
            {note.validation === 'validating' && note.efforts.length > 0
              ? t('probeNoteVerified', { levels: note.efforts.join(' / ') })
              : t('probeNoteFailed')}
          </span>
          <button type="button" style={confirmButtonStyle} onClick={() => { setNote(undefined) }}>
            {t('probeDismiss')}
          </button>
        </span>
      )}
    </span>
  )
}
