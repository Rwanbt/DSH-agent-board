/**
 * Panel CSS. Only DSH theme tokens (--dsw-*) are used, so light, dark and
 * custom themes apply unchanged. Borderless surfaces (fill contrast only),
 * floating inspector, curved SVG connectors drawn by ui/tree.js.
 * Layout switches on the panel width (container query), not the window width.
 *
 * @module dsh-agent-board/client/ui/styles
 */

const DAB_STYLE_ID = 'dsh-agent-board-style'

const DAB_CSS = `
.dab-root { container-type: inline-size; container-name: dab; position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow: hidden; }
.dab-root *, .dab-root *::before, .dab-root *::after { box-sizing: border-box; }
/* Borderless cards need a fill that differs from the page in BOTH themes (light layers are all #fff). */
.dab-root { --dab-card-fill: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))); --dab-panel-fill: var(--dsw-alias-bg-layer-1); --dab-chip-fill: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))); }
.dab-round, .dab-dot, .dab-mark::before, .dab-group-ring, .dab-pill { corner-shape: round; }

/* ---------- toolbar */
.dab-toolbar { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 16px; position: relative; z-index: 4; }
.dab-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dab-title { font-size: 16px; line-height: 24px; font-weight: 500; margin: 0 4px 0 0; white-space: nowrap; }
.dab-grow { flex: 1 1 0; min-width: 0; }
.dab-counter { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-counter b { color: var(--dsw-alias-label-primary); font-weight: 500; font-variant-numeric: tabular-nums; }
.dab-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dab-dot[data-tone="running"] { background: var(--dsw-alias-brand-primary); }
.dab-dot[data-tone="waiting"] { background: var(--dsw-alias-state-warn-primary); }
.dab-dot[data-tone="unread"] { background: var(--dsw-alias-state-success-primary); }
.dab-dot[data-tone="failed"] { background: var(--dsw-alias-state-error-primary); }
.dab-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dab-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 28px; border-radius: var(--dsw-radius-sm); border: 0;
  background: var(--dab-card-fill); color: var(--dsw-alias-label-primary); padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.dab-btn:focus-visible, .dab-input:focus-visible, .dab-select:focus-visible, .dab-pill:focus-visible, .dab-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dab-btn[aria-pressed="true"] { background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-bg-layer-1)); }
.dab-btn[disabled] { opacity: .45; cursor: not-allowed; }
.dab-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }
.dab-btn[data-variant="ghost"] { background: transparent; }
@media (hover: hover) {
  .dab-btn:hover:not([disabled]), .dab-pill:hover, .dab-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dab-btn[data-danger="true"]:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover-danger); }
  .dab-card:hover { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-1)); }
  .dab-hist:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.dab-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md); background: var(--dab-card-fill); }
.dab-seg .dab-btn { background: transparent; min-height: 26px; }
.dab-seg .dab-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-base); }
.dab-input, .dab-select { min-height: 28px; border-radius: var(--dsw-radius-sm); border: 0; background: var(--dab-card-fill); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; padding: 4px 10px; min-width: 0; }
.dab-input { flex: 1 1 200px; max-width: 320px; }
.dab-select { max-width: 200px; flex: none; appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 26px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center; background-size: 12px; text-overflow: ellipsis; }
.dab-select:disabled { opacity: .55; cursor: default; }
.dab-dd { position: relative; display: inline-flex; flex: none; min-width: 0; }
.dab-dd > .dab-select { width: 100%; text-align: left; display: inline-flex; align-items: center; }
.dab-dd-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dab-dd-pop { position: absolute; left: 0; top: calc(100% + 6px); z-index: 8; min-width: max(100%, 180px); max-width: min(320px, 90vw); max-height: 50vh; overflow: auto;
  margin: 0; padding: 4px; list-style: none; border-radius: var(--dsw-radius-md); background: var(--dab-panel-fill); box-shadow: var(--dsw-elevation-prominent); outline: none; }
.dab-dd-opt { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 4px 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary); }
.dab-dd-opt[data-active="true"] { background: var(--dab-chip-fill); }
.dab-dd-opt[aria-selected="true"] { font-weight: 500; }
.dab-dd-check { margin-left: auto; color: var(--dsw-alias-label-secondary); }
@media (pointer: coarse) { .dab-dd-opt { min-height: 40px; font-size: 15px; } }
.dab-select option { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dab-counters { display: inline-flex; align-items: center; gap: 10px; flex: none; }
.dab-search-wrap { display: flex; flex: 1 1 160px; min-width: 120px; max-width: 320px; }
.dab-search-wrap .dab-input { max-width: none; }
.dab-ico { display: block; flex: none; }
.dab-btn .dab-ico { display: inline-block; vertical-align: -3px; }
.dab-icon-btn[data-danger="true"]:not([disabled]) { color: var(--dsw-alias-state-error-primary); }
.dab-icon-btn[disabled] { opacity: .4; cursor: default; }
@media (pointer: coarse) { .dab-input, .dab-select { font-size: 16px; } }
.dab-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dab-notice { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-alert { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dab-icon-btn { flex: none; width: 28px; height: 28px; border-radius: var(--dsw-radius-sm); border: 0; background: transparent; display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; padding: 0; }

/* ---------- orchestrator status popover (small, in the toolbar) */
.dab-state { position: relative; }
.dab-state > summary { list-style: none; cursor: pointer; }
.dab-state > summary::-webkit-details-marker { display: none; }
.dab-state-pop { position: absolute; right: 0; top: calc(100% + 6px); width: min(360px, 90vw); max-height: 60vh; overflow: auto; padding: 10px 12px;
  border-radius: var(--dsw-radius-lg); background: var(--dab-panel-fill); box-shadow: var(--dsw-elevation-prominent); z-index: 6; }

/* ---------- layout */
.dab-main { flex: 1; min-height: 0; display: flex; position: relative; }
.dab-scroll { flex: 1; min-width: 0; overflow: auto; padding: 6px 16px 40px; }
.dab-projects { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: flex-start; }
.dab-project { margin: 0 0 14px; min-width: 0; max-width: 100%; }
.dab-project-head { display: flex; align-items: center; gap: 8px; border: 0; background: none; padding: 4px 6px 4px 2px; margin: 0 0 6px; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; text-align: left; border-radius: var(--dsw-radius-sm); }
.dab-project-head .dab-caret { color: var(--dsw-alias-label-secondary); width: 12px; flex: none; }
.dab-project-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-forest { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: flex-start; }
.dab-tile { position: relative; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 2px; }
.dab-more { margin-top: 8px; }

/* ---------- tree: layout only, connectors are an SVG overlay (.dab-links) */
.dab-tree { list-style: none; margin: 0; padding: 0; position: relative; z-index: 1; }
.dab-branch { display: flex; align-items: flex-start; list-style: none; margin: 0; padding: 0; }
.dab-kids { list-style: none; margin: 0; padding: 0 0 0 34px; display: flex; flex-direction: column; gap: 8px; }
.dab-links { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; z-index: 0; }
.dab-links path { fill: none; stroke: var(--dsw-alias-border-l3); stroke-width: 1.25; stroke-linecap: round; }
.dab-links path[data-active="true"] { stroke: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }

/* ---------- card (borderless: fill contrast only) */
.dab-card { position: relative; flex: none; width: 210px; min-height: 46px; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px;
  border-radius: var(--dsw-radius-md); border: 0; background: var(--dab-card-fill); cursor: pointer; user-select: none;
  transition: background-color .12s ease, box-shadow .12s ease; outline: none; }
.dab-card[data-root="true"] { width: 248px; border-radius: var(--dsw-radius-lg); padding: 10px 12px; }
.dab-card:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dab-card[data-selected="true"] { box-shadow: 0 0 0 1.5px var(--dsw-alias-brand-primary); }
.dab-card[data-status="waiting_user"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dab-card-fill)); }
.dab-card[data-status="interrupted"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, var(--dab-card-fill)); }
.dab-card[data-status="provider_unavailable"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, var(--dab-card-fill)); }
.dab-card[data-status="failed"][data-seen="false"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, var(--dab-card-fill)); }
.dab-card[data-calm="true"] .dab-name { color: var(--dsw-alias-label-secondary); }
.dab-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dab-name { flex: 1; min-width: 0; font-weight: 500; font-size: 13px; line-height: 18px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.dab-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; padding-left: 22px; }
.dab-meta > span { overflow: hidden; text-overflow: ellipsis; }
.dab-meta .dab-sep::before { content: "·"; }
.dab-wait { font-size: 12px; color: var(--dsw-alias-state-warn-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 22px; }
.dab-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 22px; }
.dab-card-foot { display: flex; align-items: center; gap: 6px; margin-top: 2px; padding-left: 22px; }
.dab-pill { display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: 999px; background: var(--dab-chip-fill);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 0 8px; min-height: 22px; cursor: pointer; }
/* Compact provider/model chip (card meta row and inspector). Same line height as
   the surrounding meta text, so the card layout does not change. */
.dab-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-chip[data-source="unknown"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); }
.dab-chip[data-source="assignment"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, transparent); }
.dab-pill[data-tone="running"] { color: var(--dsw-alias-label-primary); }
.dab-quick { opacity: 0; }
.dab-card:focus-within .dab-quick, .dab-card[data-selected="true"] .dab-quick { opacity: 1; }
@media (hover: hover) { .dab-card:hover .dab-quick { opacity: 1; } }
@media (hover: none) { .dab-quick { opacity: 1; } }

/* ---------- status mark (always a true circle) */
.dab-mark { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
.dab-mark::before { content: ""; display: block; border-radius: 50%; corner-shape: round; }
.dab-mark[data-status="running"]::before { animation: dab-spin .9s linear infinite; width: 13px; height: 13px; border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); border-top-color: var(--dsw-alias-label-primary); }
.dab-mark[data-status="waiting_user"]::before { width: 9px; height: 9px; background: var(--dsw-alias-state-warn-primary); }
.dab-mark[data-status="finished_unread"]::before { width: 9px; height: 9px; background: var(--dsw-alias-state-success-primary); }
.dab-mark[data-status="failed"]::before { width: 9px; height: 9px; background: var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="failed"][data-seen="true"]::before { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="finished_read"]::before { width: 8px; height: 8px; background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary)); }
.dab-mark[data-status="idle"]::before { width: 8px; height: 8px; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary)); }
/* Interrupted: hollow amber ring. Provider outage: dashed error ring. Neither
   animates, so the running ring stays the only motion in the panel. */
.dab-mark[data-status="interrupted"]::before { width: 9px; height: 9px; background: transparent; box-shadow: inset 0 0 0 2px var(--dsw-alias-state-warn-primary); }
.dab-mark[data-status="provider_unavailable"]::before { width: 9px; height: 9px; border: 1.5px dashed var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="unknown"]::before { width: 8px; height: 8px; border: 1.5px dashed var(--dsw-alias-label-secondary); }
.dab-group-ring { display: inline-block; width: 8px; height: 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-primary); margin-right: 2px; }
@keyframes dab-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dab-mark[data-status="running"]::before { animation: none; border-right-color: var(--dsw-alias-label-primary); }
  .dab-card, .dab-inspector { transition: none; }
}

/* ---------- compact grid */
.dab-compact-group { margin: 0 0 10px; }
.dab-compact-parent { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-compact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px; }
.dab-compact-grid .dab-card { width: auto; min-height: 0; padding: 6px 8px; }

/* ---------- inspector: floating panel */
.dab-inspector { flex: none; width: 340px; max-width: 42%; margin: 4px 12px 12px 0; border-radius: var(--dsw-radius-xl); border: 0;
  background: var(--dab-panel-fill); box-shadow: var(--dsw-elevation-panel); overflow: auto; padding: 14px 16px 20px;
  display: flex; flex-direction: column; gap: 10px; align-self: stretch; }
.dab-insp-head { display: flex; align-items: flex-start; gap: 8px; }
.dab-insp-title { font-size: 14px; line-height: 22px; font-weight: 500; margin: 0; word-break: break-word; flex: 1; min-width: 0; }
.dab-insp-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.dab-answer { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; background: var(--dab-card-fill);
  border-radius: var(--dsw-radius-md); padding: 8px 10px; max-height: 320px; overflow: auto; }
.dab-answer[data-empty="true"] { color: var(--dsw-alias-label-secondary); font-style: italic; }
.dab-dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; font-size: 12px; }
.dab-dl dt { color: var(--dsw-alias-label-secondary); }
.dab-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dab-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.dab-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dab-linkish { border: 0; background: none; padding: 0; color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; text-align: left; }
.dab-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; corner-shape: round; font-size: 12px; background: var(--dab-card-fill); color: var(--dsw-alias-label-secondary); white-space: nowrap; }

/* ---------- drawer (history): floating */
.dab-drawer { position: absolute; top: 8px; right: 12px; bottom: 12px; width: min(440px, calc(100% - 24px)); background: var(--dab-panel-fill);
  border-radius: var(--dsw-radius-xl); box-shadow: var(--dsw-elevation-prominent); display: flex; flex-direction: column; z-index: 5; overflow: hidden; }
.dab-drawer-head { padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 8px; }
.dab-drawer-head .dab-input { flex: none; max-width: none; width: 100%; }
.dab-drawer-list { flex: 1; overflow: auto; list-style: none; margin: 0; padding: 0 8px 16px; }
.dab-hist { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--dsw-radius-md); cursor: pointer; }
.dab-hist:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-hist[data-selected="true"] { background: var(--dab-card-fill); }
.dab-hist-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dab-hist-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- misc */
.dab-panel { border-radius: var(--dsw-radius-lg); padding: 8px 12px; margin: 0 0 12px; background: var(--dab-card-fill); }
.dab-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dab-list li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.dab-empty { padding: 40px 12px; text-align: center; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.dab-mobile-menu { display: none; }
.dab-only-narrow { display: none; }

/* ---------- narrow panel (phone, small window): compact header + overview */
@container dab (max-width: 720px) {
  .dab-toolbar { padding: 8px 10px 6px; gap: 6px; }
  .dab-only-wide { display: none !important; }
  .dab-only-narrow { display: inline-flex; }
  .dab-title { font-size: 15px; }
  .dab-input { max-width: none; flex: 1 1 0; }
  .dab-mobile-menu { display: flex; flex-direction: column; gap: 8px; padding: 8px 0 2px; }
  .dab-mobile-menu .dab-bar { gap: 6px; }
  .dab-scroll { padding: 4px 10px 32px; overflow-x: hidden; }
  .dab-projects { display: block; }
  .dab-project { margin-bottom: 10px; }
  .dab-forest { display: block; }
  .dab-forest > .dab-tile + .dab-tile { margin-top: 8px; }
  .dab-tile { overflow: visible; padding: 0; }
  .dab-branch { flex-direction: column; align-items: stretch; }
  .dab-card, .dab-card[data-root="true"] { width: 100%; padding: 7px 10px; min-height: 0; }
  .dab-name { -webkit-line-clamp: 1; }
  .dab-kids { padding: 6px 0 0 22px; gap: 6px; }
  .dab-inspector { position: absolute; left: 8px; right: 8px; bottom: 8px; width: auto; max-width: none; max-height: 64%; margin: 0; z-index: 5; box-shadow: var(--dsw-elevation-prominent); }
  .dab-pill, .dab-btn { min-height: 32px; }
  .dab-icon-btn { width: 32px; height: 32px; }
}
`

function dabInjectStyles(ctxStyles) {
  try {
    if (typeof ctxStyles?.insert === 'function') return ctxStyles.insert(DAB_CSS)
    const document = globalThis.document
    if (document === undefined || document === null) return () => {}
    const previous = document.getElementById(DAB_STYLE_ID)
    if (previous !== null) previous.remove()
    const style = document.createElement('style')
    style.id = DAB_STYLE_ID
    style.textContent = DAB_CSS
    document.head.appendChild(style)
    return () => {
      try { style.remove() } catch { /* ignore */ }
    }
  } catch {
    return () => {}
  }
}
