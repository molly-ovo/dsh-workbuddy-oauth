/**
 * The settings card's stylesheet, injected at runtime.
 *
 * ## Why CSS lives in a TypeScript string
 *
 * The client half ships as ONE `lib/client.js`, registered through
 * `__ModuleLoader__.load`. A `.css` file beside it would never load: nothing
 * fetches it. And a CSS *import* is silently dropped by this build — measured,
 * `tsdown` emitted neither a sidecar nor an inline copy and the bundle's byte
 * size did not change, which is the worst possible failure because it looks
 * like success. So the rules are a string that the bundle carries and installs
 * itself.
 *
 * This is also what `dshmarket` does (its `client.js` carries the same
 * `style[data-plugin-css]` guard), so the pattern is established rather than
 * invented here.
 *
 * ## Why not inline `style` props, which is what this card used before
 *
 * A React `style` prop sets inline styles, and **inline styles cannot express
 * `:hover`, `:active`, `:focus-visible` or `:disabled`**. The card therefore had
 * no interaction feedback at all — and its ten `disabled={...}` buttons were
 * visually identical to live ones, so a click during a sign-in did nothing with
 * no explanation. Those four states need a real stylesheet.
 *
 * ## Token discipline
 *
 * Every colour is a `--dsw-alias-*` theme token, and the button rules mirror the
 * host's own `dsh-client-ui-primitives/lib/Button.module.css` so this card
 * reacts exactly like a host button. No literal colours except the white text on
 * the danger fill, which has no token because the host has no danger button.
 * A renamed token degrades appearance but cannot break rendering.
 *
 * @module dsh-workbuddy-oauth/client/styles
 */

/** Marks the injected tag, and keeps a second injection from duplicating it. */
const STYLE_TAG_ID = 'dsh-workbuddy-oauth/client'

/**
 * Card stylesheet.
 *
 * Class names are prefixed `wb-` so nothing here can collide with a host class
 * or another plugin's — the host's own sheets are not scoped against us.
 */
const CSS = `
/* ============================================================
   Buttons — mirrors the host's Button.module.css
   ============================================================ */
.wb-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.wb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.wb-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.wb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.wb-btn:disabled { cursor: not-allowed; opacity: 0.4; }

/* Filled variant: reserved for an irreversible action worth emphasising. */
.wb-btn-primary {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.wb-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
  border-color: var(--dsw-alias-button-primary-hover);
}
.wb-btn-primary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }

/* Destructive fill for the final sign-out confirmation. */
.wb-btn-danger {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: #fff;
}
.wb-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, #fff);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 85%, #fff);
}

/* ============================================================
   Tabs
   ============================================================ */
.wb-tabbar { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.wb-tab {
  padding: 4px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.wb-tab:hover:not([aria-selected='true']) { background: var(--dsw-alias-interactive-bg-hover); }
.wb-tab:active:not([aria-selected='true']) { background: var(--dsw-alias-interactive-bg-active); }
.wb-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.wb-tab[aria-selected='true'] {
  border-bottom-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

/* ============================================================
   Layout
   ============================================================ */
.wb-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.wb-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
/* Title row: the signed-in count sits beside the name, on the same baseline. */
.wb-titlerow { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
/*
 * 12px against the title's 13px, and normal weight against its 600: the count
 * must not read as part of the heading. It is deliberately smaller than the
 * title rather than merely a different colour, so the hierarchy survives even
 * where a theme renders the success colour close to the label colour.
 */
.wb-count { font-size: 12px; font-weight: 400; color: var(--dsw-alias-state-success-primary); }
.wb-intro { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.wb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wb-panel { display: flex; flex-direction: column; gap: 8px; }
.wb-spacer { flex: 1; }
.wb-muted { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.wb-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
.wb-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.wb-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.wb-link { color: var(--dsw-alias-brand-primary); font-size: 12px; }

.wb-region-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}
.wb-region-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }

/* ============================================================
   Notices — colour carries the outcome
   ============================================================ */
.wb-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  word-break: break-all;
}
/* Tinted border and text, so success, failure and in-progress read differently
   at a glance instead of all looking like the same grey box. */
.wb-note-ok {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-state-success-primary);
}
.wb-note-err {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-state-error-primary);
}
.wb-note-warn {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l2));
  color: var(--dsw-alias-state-warn-primary);
}
.wb-note-busy {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-border-l2));
}

/* ============================================================
   Accounts and credits — the same card grid
   ============================================================ */
/*
 * One column, then two, and never more. auto-fill keeps adding columns as the
 * panel widens, which stretches each card into a wide, mostly empty strip; a
 * breakpoint pins the ceiling at two.
 */
.wb-acct-cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
/* 260px is where a card's contents stop being cramped; two columns plus the gap
   is about 530px, so the breakpoint sits at 560px. */
@media (min-width: 560px) {
  .wb-acct-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
/*
 * Collapsed mode: one row per card, name and actions only.
 *
 * Only the second line is hidden, so the name, its region badge and the buttons
 * all survive — the badge sits on the first line, which is why a collapsed card
 * can still say which region it belongs to. Both card grids are covered: the
 * credits card is its own element, so it needs naming separately.
 */
.wb-acct-cards-collapsed .wb-acct-card,
.wb-acct-cards-collapsed .wb-credit-card { padding: 6px 10px; }
.wb-acct-cards-collapsed .wb-acct-main { gap: 0; }
.wb-acct-cards-collapsed .wb-acct-meta,
.wb-acct-cards-collapsed .wb-credit-meta { display: none; }
/*
 * Left/right split. The identity column takes the slack and truncates; the
 * actions column never shrinks, so a long nickname cannot push a button out of
 * the card.
 */
.wb-acct-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
}
.wb-acct-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.wb-acct-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-acct-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The metadata line never wraps: it truncates its longest part instead, so the
   row height stays uniform across the grid. */
.wb-acct-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.wb-acct-uid { font-family: ui-monospace, Menlo, monospace; flex: 0 0 auto; }
.wb-acct-sep { opacity: 0.5; flex: 0 0 auto; }
/* The token text is the longest field and the one that gives way first; the uid
   and the state stay whole. */
.wb-acct-exp { overflow: hidden; text-overflow: ellipsis; }
.wb-acct-actions { display: flex; gap: 6px; flex: 0 0 auto; }

/* Region badge. */
.wb-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  height: 16px;
  line-height: 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
/* A disabled account and a soon-to-expire token both need to stand out; as plain
   muted text they were indistinguishable from a healthy row. */
.wb-tag-off { font-size: 11px; color: var(--dsw-alias-state-warn-primary); flex: 0 0 auto; }
.wb-tag-warn { color: var(--dsw-alias-state-warn-primary); flex: 0 0 auto; }

/* Destructive confirmation, filling the card it replaces the actions in. */
.wb-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l2));
}
.wb-confirm-actions { display: flex; gap: 6px; justify-content: flex-end; }

/* ============================================================
   Model grid
   ============================================================ */
.wb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 2px 16px;
  align-items: center;
}
.wb-mrow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-mname {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-ctx {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/* A window the maximum-context toggle actually changes, so the effect is visible. */
.wb-ctx-up { color: var(--dsw-alias-state-success-primary); font-weight: 600; }

.wb-maxrow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

/* ============================================================
   Credits — the account card's shape, with the balance on the right
   ============================================================ */
/* Left/right split, matching the account card so the two tabs read as one UI. */
.wb-credit-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
}
/* A failed check tints the border rather than inserting a row: an inline error
   would make one card taller than its neighbours and break the grid's rhythm. */
.wb-credit-card-err {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l2));
}
.wb-credit-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.wb-credit-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.wb-credit-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-credit-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
/*
 * The right slot holds whatever the card's state calls for. It never shrinks,
 * so the balance cannot be pushed out by a long account name.
 */
.wb-credit-slot { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; }
/*
 * A fetched balance is itself the button that refetches it. Styled as a value
 * rather than an action — transparent until hovered — so the card shows a
 * number where it previously offered a button, instead of both at once.
 */
.wb-credit-value {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 8px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.wb-credit-value:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l3);
}
.wb-credit-value:active { background: var(--dsw-alias-interactive-bg-active); }
.wb-credit-value:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.wb-credit-num {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.wb-credit-unit { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.wb-credit-unlimited { font-size: 14px; font-weight: 600; color: var(--dsw-alias-state-success-primary); }
`

/**
 * Install the stylesheet once per document.
 *
 * Idempotent by tag id: the slot can mount, collapse and remount, and each mount
 * would otherwise append another copy of every rule.
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'dsh-workbuddy-oauth'
  tag.dataset['pluginCss'] = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
