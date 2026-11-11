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
.dab-meta { display: flex; align-items: center; flex-wrap: wrap; align-content: flex-start; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; padding-left: 22px; }
/* The work row (task id, Task Board state, age) wraps freely: no max-height, so a
   wrapped line is never clipped mid-glyph; each item ellipsizes on its own. */
.dab-meta-work { row-gap: 2px; }
.dab-meta > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 100%; }
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

/* ---------- identity (GOAL 4): mascot, resolved role, project, task chip */
.dab-card-main { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.dab-card-mascot { flex: none; display: inline-flex; align-items: center; justify-content: center; }
.dab-card-mascot .dab-avatar, .dab-band-mascot .dab-avatar, .dab-hier-orch .dab-avatar, .dab-project-orch .dab-avatar { flex: none; }
.dab-card-ident { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* Inside the identity column the rows align with the title, not with the mascot. */
.dab-card-ident > .dab-meta, .dab-card-ident > .dab-wait, .dab-card-ident > .dab-err, .dab-card-ident > .dab-card-foot { padding-left: 0; }
.dab-role-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-role-chip[data-resolution="generic"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); }
/* A deduced role is marked, never presented as declared: dotted chip edge + a
   small muted suffix. No role colour is added here (the mascot carries it). */
.dab-role-chip[data-resolution="inferred"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); border-bottom: 1px dotted var(--dsw-alias-label-secondary); }
.dab-role-inferred { font-size: 10px; line-height: 12px; color: var(--dsw-alias-label-secondary); text-transform: lowercase; }
/* Family chip: identity context only, never a status colour. */
.dab-family-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary));
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-project-line { color: var(--dsw-alias-label-secondary); }
.dab-task-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.dab-task-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-secondary); }
.dab-task-chip[data-tone="active"] .dab-task-dot { background: var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary)); }
.dab-task-chip[data-tone="waiting"] .dab-task-dot, .dab-task-chip[data-tone="reviewing"] .dab-task-dot,
.dab-task-chip[data-tone="interrupted"] .dab-task-dot { background: var(--dsw-alias-state-warn-primary); }
.dab-task-chip[data-tone="blocked"] .dab-task-dot { background: var(--dsw-alias-state-error-primary); }
.dab-task-chip[data-tone="unread"] .dab-task-dot { background: var(--dsw-alias-state-success-primary); }
.dab-task-chip[data-tone="done"] .dab-task-dot { background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dab-task-chip[data-tone="idle"] .dab-task-dot, .dab-task-chip[data-tone="gone"] .dab-task-dot { background: var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); }
.dab-activity { margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* ---------- mascot (ui/avatar.js owns the markup, this file owns the paint) */
.dab-avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: var(--dab-avatar-size, 40px); height: var(--dab-avatar-size, 40px); border-radius: 50%; }
.dab-avatar[data-selected="true"] { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dab-avatar-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.dab-avatar-fallback { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: 50%; background: var(--dab-chip-fill); }
/* Status dot: SEPARATE from the mascot; colour comes from the status tone, the
   role colour never expresses a status. Anchored BOTTOM-LEFT: the kit draws the
   role pictogram (network/wrench/search/…) in the bottom-right of the character,
   so the dot must not cover identity. */
.dab-avatar-dot { position: absolute; left: 0; right: auto; bottom: 0; box-sizing: content-box; border-radius: 50%;
  width: max(7px, calc(var(--dab-avatar-size, 40px) * 0.23)); height: max(7px, calc(var(--dab-avatar-size, 40px) * 0.23));
  border: 2px solid var(--dab-card-fill); background: var(--dsw-alias-label-secondary); }
.dab-avatar-dot[data-tone="active"] { background: var(--dsw-alias-state-success-primary); }
.dab-avatar-dot[data-tone="planning"] { background: var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary)); }
.dab-avatar-dot[data-tone="waiting"], .dab-avatar-dot[data-tone="reviewing"],
.dab-avatar-dot[data-tone="interrupted"] { background: var(--dsw-alias-state-warn-primary); }
.dab-avatar-dot[data-tone="blocked"] { background: var(--dsw-alias-state-error-primary); }
.dab-avatar-dot[data-tone="unread"] { background: var(--dsw-alias-state-success-primary); }
.dab-avatar-dot[data-tone="done"] { background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dab-avatar-dot[data-tone="idle"] { background: var(--dsw-alias-label-secondary); }
.dab-avatar-dot[data-tone="gone"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); }
.dab-avatar-task { position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%); padding: 0 4px; border-radius: 999px;
  font-size: 9px; line-height: 12px; white-space: nowrap; background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); }
.dab-project-orch { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dab-project-orch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.dab-dot[data-tone="idle"] { background: var(--dsw-alias-label-secondary); }

/* ---------- supervision band (host supervision LAYER, not an agent) */
.dab-band { flex: none; margin: 0 0 10px; border-radius: var(--dsw-radius-lg); background: var(--dab-card-fill); overflow: hidden; }
.dab-band-head { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 54px; padding: 8px 30px 8px 12px; border: 0; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--dsw-radius-lg); }
.dab-band-head > .dab-caret { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); width: 12px; flex: none; color: var(--dsw-alias-label-secondary); }
.dab-band-head:focus-visible, .dab-hier-project-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dab-band-mascot { flex: none; display: inline-flex; align-items: center; }
.dab-band-ident { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dab-band-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; font-weight: 500; }
.dab-band-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-band-counters { flex: 0 1 auto; display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.dab-band-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 12px 12px; min-width: 0; }
/* The body is always in the DOM (aria-controls must resolve); collapsed = hidden. */
.dab-band-body[hidden] { display: none; }
.dab-band-notice { padding: 6px 8px; border-radius: var(--dsw-radius-sm); font-size: 12px;
  color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.dab-band-agent { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.dab-band-section { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dab-band-list { max-height: 180px; overflow: auto; }
.dab-band-list li { align-items: flex-start; }
.dab-sup-status { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-sup-status[data-status="active"] .dab-dot { background: var(--dsw-alias-brand-primary); }
.dab-sup-status[data-status="blocked"] .dab-dot { background: var(--dsw-alias-state-error-primary); }
.dab-sup-status[data-status="unknown"] .dab-dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); }
.dab-tag[data-tone="proposal"] { color: var(--dsw-alias-state-warn-primary); }
.dab-cap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 14px; }
.dab-cap-row { display: grid; grid-template-columns: minmax(96px, auto) auto; gap: 0 8px; align-items: baseline; padding: 3px 0;
  border-top: 1px solid var(--dsw-alias-border-l3, transparent); font-size: 12px; }
.dab-cap-label { color: var(--dsw-alias-label-primary); }
.dab-cap-value { font-weight: 500; }
.dab-cap-value[data-available="true"] { color: var(--dsw-alias-label-secondary); }
.dab-cap-value[data-available="false"] { color: var(--dsw-alias-state-warn-primary); }
.dab-cap-reason { grid-column: 1 / -1; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); }
.dab-cap-reason-label { opacity: .75; }

/* ---------- hierarchy view: workspace -> projects -> teams of cards */
.dab-hier { display: flex; flex-direction: column; gap: 10px; }
.dab-hier-ws { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg); background: var(--dab-card-fill); }
.dab-hier-ws-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dab-hier-ws-mascot { flex: none; display: inline-flex; align-items: center; }
.dab-hier-ws-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dab-hier-ws-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; font-weight: 500; }
.dab-hier-ws-sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-hier-projects { display: flex; flex-direction: column; gap: 10px; }
.dab-hier-project { border-radius: var(--dsw-radius-lg); background: var(--dab-card-fill); padding: 4px 6px 8px; }
.dab-hier-project-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%; padding: 6px; border: 0; border-radius: var(--dsw-radius-md);
  background: none; color: inherit; font: inherit; font-size: 13px; font-weight: 500; text-align: left; cursor: pointer; }
.dab-hier-project-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 42%; }
.dab-hier-orch { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dab-hier-orch[data-gap="true"] { color: var(--dsw-alias-state-warn-primary); }
.dab-gap-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1.5px currentColor; }
.dab-hier-counts { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dab-hier-project-head > .dab-hier-counts { margin-left: auto; }
.dab-hier-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 4px; }
.dab-hier-team { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dab-hier-team-title { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-hier-team-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-hier-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 6px; }
.dab-hier-cards .dab-card { width: auto; }
.dab-hier-notes { padding: 6px 8px; border-radius: var(--dsw-radius-md); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }

/* ---------- narrow: stacked band, single-column hierarchy (no connector lines) */
@container dab (max-width: 720px) {
  .dab-band-head { flex-wrap: wrap; align-items: flex-start; min-height: 0; }
  /* The chevron stays on the FIRST line (absolute), never under the counters. */
  .dab-band-head > .dab-caret { top: 10px; transform: none; }
  .dab-band-counters { width: 100%; justify-content: flex-start; }
  .dab-band-body { padding: 2px 10px 10px; }
  .dab-cap-grid { grid-template-columns: 1fr; }
  .dab-hier-project-head { align-items: flex-start; }
  .dab-hier-project-title { max-width: 100%; white-space: normal; }
  .dab-hier-project-head > .dab-hier-counts { margin-left: 0; }
  .dab-hier-cards { grid-template-columns: 1fr; }
  .dab-project-orch-name { max-width: 110px; }
}
@container dab (max-width: 420px) {
  .dab-hier-ws-head { align-items: flex-start; }
  .dab-band-counters { gap: 8px; }
  .dab-hier-ws-sub { gap: 6px; }
}

/* =====================================================================
 * RESPONSIVE COCKPIT (GOAL 5)
 * Header + filter bar + Super Orchestrator band + indicators + adaptive
 * grid + inspector drawer/sheet. Container queries only: the panel width is
 * what matters, not the window width.
 * ===================================================================== */

/* ---------- header (52-60 px) */
.dab-toolbar { position: relative; padding: 8px 16px 7px; gap: 7px; border-bottom: 1px solid var(--dsw-alias-border-l3, transparent); background: var(--dsw-alias-bg-base); }
.dab-head { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 40px; }
.dab-head-ident { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 auto; }
.dab-head-mark { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px;
  background: var(--dab-card-fill); color: var(--dsw-alias-label-secondary); font-size: 15px; line-height: 1; }
.dab-head-text { min-width: 0; }
.dab-title { font-size: 17px; line-height: 21px; font-weight: 600; margin: 0; letter-spacing: -.2px; white-space: nowrap; }
.dab-subtitle { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dab-head-actions { display: flex; align-items: center; gap: 7px; flex: none; }
.dab-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-live .dab-dot { width: 7px; height: 7px; }
.dab-live[data-tone="running"] .dab-dot { background: var(--dsw-alias-state-success-primary); }
.dab-live[data-tone="failed"] .dab-dot { background: var(--dsw-alias-state-error-primary); }
.dab-live[data-tone="idle"] .dab-dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); }
.dab-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md); background: var(--dab-card-fill); flex: none; }
.dab-seg-btn { display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 7px; min-height: 26px; padding: 3px 9px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.dab-seg-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-weight: 500; }
.dab-seg-btn:disabled { opacity: .45; cursor: default; }
.dab-seg-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* Icon-only view switch: three IDENTICAL square targets, icon dead-centre.
   The label is removed from the DOM at that width (see toolbar.js), so no
   hidden text node or leftover gap can shift the pictogram. */
.dab-viewswitch[data-icons="true"] { gap: 0; }
.dab-viewswitch[data-icons="true"] .dab-seg-btn { width: 34px; height: 30px; padding: 0; justify-content: center; }
.dab-viewswitch[data-icons="true"] .dab-ico { display: block; }
.dab-chiprow { display: contents; }
.dab-menu.dab-menu-chips { position: static; }
.dab-stop { min-height: 30px; gap: 5px; }
.dab-stop[data-danger="true"]:not([disabled]) { color: var(--dsw-alias-state-error-primary); }
@media (hover: hover) { .dab-stop[data-danger="true"]:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover-danger); } }
.dab-menu { position: relative; flex: none; }
.dab-menu-btn { position: relative; }
.dab-menu-badge { position: absolute; top: -1px; right: -1px; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px;
  font-size: 9px; line-height: 13px; text-align: center; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-variant-numeric: tabular-nums; }
.dab-menu-pop { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; min-width: 250px;
  max-width: min(340px, calc(100vw - 20px)); padding: 10px; border-radius: 12px; background: var(--dab-panel-fill);
  box-shadow: var(--dsw-elevation-prominent); display: flex; flex-direction: column; gap: 9px; }
.dab-menu-pop[data-align="start"] { right: auto; left: 0; }
.dab-menu-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dab-menu-row .dab-dd { flex: 1 1 auto; min-width: 0; }
.dab-menu-row .dab-select { width: 100%; max-width: none; }
.dab-menu-row-actions { gap: 6px; }
.dab-menu-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--dsw-alias-label-secondary); font-weight: 600; }
.dab-menu-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-state-content { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dab-narrow-menu { display: flex; flex-direction: column; gap: 10px; min-width: min(280px, 80vw); }

/* ---------- filter bar (40-45 px) */
.dab-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dab-search { display: flex; align-items: center; gap: 6px; padding: 0 10px; height: 32px; border-radius: 9px;
  background: var(--dab-card-fill); min-width: 160px; flex: 1 1 200px; max-width: 320px; color: var(--dsw-alias-label-secondary); }
.dab-search-ico { display: inline-flex; flex: none; }
.dab-search .dab-input { flex: 1 1 auto; min-width: 0; max-width: none; height: 100%; min-height: 0; padding: 0; background: transparent; }
.dab-chips { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.dab-chips::-webkit-scrollbar { display: none; }
.dab-chip-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px;
  min-height: 30px; padding: 0 10px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.dab-chip-btn[aria-pressed="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  color: var(--dsw-alias-label-primary); font-weight: 500; }
.dab-chip-btn:focus-visible, .dab-stat:focus-visible, .dab-super-main:focus-visible, .dab-super-orch:focus-visible, .dab-gcard-open:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dab-shown { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

/* ---------- Super Orchestrator band (60-75 px closed) */
.dab-super { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 2px 0 12px; padding: 8px 12px;
  min-height: 62px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent);
  background: linear-gradient(105deg, color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dab-card-fill)), var(--dab-card-fill) 52%); }
.dab-super-main { display: flex; align-items: center; gap: 10px; flex: 1 1 240px; min-width: 0; padding: 0; border: 0;
  border-radius: 10px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dab-super-mascot { flex: none; display: inline-flex; }
.dab-super-ident { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dab-super-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 14px; font-weight: 600; line-height: 19px; }
.dab-super-state { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dab-super-state .dab-dot { width: 7px; height: 7px; }
.dab-super-state[data-status="active"] .dab-dot { background: var(--dsw-alias-state-success-primary); }
.dab-super-state[data-status="blocked"] .dab-dot { background: var(--dsw-alias-state-error-primary); }
.dab-super-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
/* The band represents the supervision LAYER, not an agent: the marker is visible
   even when the details are collapsed. */
.dab-super-layer { display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 16px; font-weight: 500; }
.dab-super-sep { opacity: .6; }
.dab-super-orchs { display: flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0; }
.dab-super-orch { display: inline-flex; border: 1px solid var(--dsw-alias-border-l3, transparent); border-radius: 9px;
  padding: 2px; background: var(--dsw-alias-bg-base); cursor: pointer; }
.dab-super-orch:hover { border-color: var(--dsw-alias-brand-primary); }
.dab-super-none { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-super-more { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-super .dab-band-body { flex: 1 0 100%; padding: 6px 2px 4px; }
.dab-super .dab-band-head { min-height: 0; }

/* ---------- indicators (50-60 px) */
.dab-stats { display: flex; align-items: stretch; gap: 8px; margin: 0 0 14px; min-width: 0; }
.dab-stat { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l3, transparent); border-radius: 11px; background: var(--dab-card-fill);
  color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.dab-stat[aria-pressed="true"] { box-shadow: inset 0 0 0 1.5px var(--dsw-alias-brand-primary); }
.dab-stat[data-disabled="true"] { opacity: .55; cursor: default; }
.dab-stat-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dab-stat-dot[data-tone="running"] { background: var(--dsw-alias-state-success-primary); }
.dab-stat-dot[data-tone="waiting"] { background: var(--dsw-alias-state-warn-primary); }
.dab-stat-dot[data-tone="reviewing"] { background: var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary)); }
.dab-stat-dot[data-tone="idle"] { background: var(--dsw-alias-label-secondary); }
.dab-stat-value { font-size: 19px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; }
.dab-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- global sections + adaptive grid (240-290 px cards) */
.dab-overview { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.dab-section { min-width: 0; }
.dab-section-head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
.dab-section-title { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; }
.dab-section-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-section-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dab-section-dot[data-tone="waiting"] { background: var(--dsw-alias-state-warn-primary); }
.dab-section-dot[data-tone="running"] { background: var(--dsw-alias-state-success-primary); }
.dab-section-dot[data-tone="idle"] { background: var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary)); }
.dab-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 248px), 1fr)); gap: 9px; min-width: 0; }
.dab-agent-cell { min-width: 0; }
.dab-gcard-wrap { position: relative; display: flex; height: 100%; min-width: 0; }
.dab-gcard-wrap > .dab-gcard { flex: 1 1 auto; }

/* ---------- global card */
.dab-gcard { position: relative; display: flex; align-items: center; gap: 11px; min-width: 0; min-height: 92px; height: 100%;
  padding: 10px 12px; border: 1px solid transparent; border-radius: 12px; background: var(--dab-card-fill);
  cursor: pointer; user-select: none; outline: none;
  transition: background-color .12s ease, border-color .12s ease, box-shadow .12s ease; }
.dab-gcard[data-selected="true"] { box-shadow: 0 0 0 1.5px var(--dsw-alias-brand-primary); }
.dab-gcard:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dab-gcard[data-status="waiting_user"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 48%, transparent); }
.dab-gcard[data-status="interrupted"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent); }
.dab-gcard[data-status="failed"][data-seen="false"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 48%, transparent); }
.dab-gcard[data-status="provider_unavailable"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 32%, transparent); }
.dab-gcard[data-calm="true"] .dab-gcard-name { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.dab-gcard-mascot { flex: none; display: inline-flex; }
.dab-gcard-ident { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding-right: 14px; }
.dab-gcard-row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dab-gcard-name { flex: 0 1 auto; min-width: 0; font-size: 13px; line-height: 17px; font-weight: 600;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dab-gcard-failover { flex: none; font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-secondary); }
.dab-gcard-project { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-secondary); }
.dab-gcard-project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-gcard-state { flex: none; white-space: nowrap; padding: 0 5px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); font-size: 10px; line-height: 14px; }
.dab-gcard-state[data-tone="waiting"] { color: var(--dsw-alias-state-warn-primary); }
.dab-gcard-state[data-tone="failed"] { color: var(--dsw-alias-state-error-primary); }
.dab-gcard-state[data-tone="unread"] { color: var(--dsw-alias-state-success-primary); }
.dab-gcard-task { min-width: 0; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.dab-gcard-badge { position: absolute; top: 7px; right: 8px; padding: 0 5px; border-radius: 6px; background: var(--dab-chip-fill);
  font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dab-gcard-open { position: absolute; right: 3px; bottom: 3px; width: 26px; height: 26px; opacity: 0; }
.dab-gcard-wrap:focus-within .dab-gcard-open, .dab-gcard[data-selected="true"] ~ .dab-gcard-open { opacity: 1; }
@media (hover: hover) { .dab-gcard-wrap:hover .dab-gcard-open { opacity: 1; } }
@media (hover: none) { .dab-gcard-open { opacity: .75; } }

/* ---------- inspector: desktop drawer overlaying the grid */
.dab-insp-overlay { position: absolute; inset: 0; z-index: 40; }
.dab-insp-scrim { position: absolute; inset: 0; background: color-mix(in srgb, #000 26%, transparent); }
.dab-insp-panel { position: absolute; top: 8px; right: 8px; bottom: 8px; width: min(390px, calc(100% - 16px));
  display: flex; flex-direction: column; overflow: hidden; border-radius: 14px; background: var(--dab-panel-fill);
  box-shadow: var(--dsw-elevation-prominent); }
.dab-insp-grip { display: none; }
.dab-insp-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 14px 16px; }
/* The preview becomes the drawer body: no second frame, no second shadow, and
   it stays IN FLOW (the old narrow rule positioned it absolutely, which would
   collapse the sheet to its grip). */
.dab-insp-panel .dab-inspector { position: static; inset: auto; width: 100%; max-width: none; max-height: none; margin: 0; padding: 6px 2px 8px;
  background: transparent; box-shadow: none; overflow: visible; align-self: auto; }
.dab-insp-panel .dab-insp-head { position: sticky; top: 0; z-index: 2; background: var(--dab-panel-fill); padding: 4px 0 6px; }
/* The drawer is narrower than the old inline inspector: identity chips wrap
   instead of being clipped, and every long value may break. */
.dab-insp-panel .dab-insp-status { flex-wrap: wrap; row-gap: 4px; }
.dab-insp-panel .dab-insp-status > * { max-width: 100%; min-width: 0; }
.dab-insp-panel .dab-chip, .dab-insp-panel .dab-role-chip, .dab-insp-panel .dab-task-chip, .dab-insp-panel .dab-family-chip { max-width: 100%; }
.dab-insp-panel .dab-actions { gap: 6px; }
.dab-insp-panel .dab-dl dd { overflow-wrap: anywhere; }

/* Mid-width panels (a desktop window with a narrow Agent Board column): keep
   3–4 columns instead of two enormous cards. */
@container dab (max-width: 1023px) {
  .dab-agent-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 224px), 1fr)); }
}
/* Below 900 px the view-switch labels move to tooltips so the filter bar stays
   on ONE row (the mockup never uses two command rows on desktop). */
@container dab (max-width: 900px) {
  .dab-seg-text { display: none; }
  .dab-shown { display: none; }
}

/* ---------- narrow panel: one-line header, 2-column mosaic, bottom sheet */
@container dab (max-width: 720px) {
  .dab-toolbar { padding: 8px 10px 6px; gap: 6px; }
  .dab-head { min-height: 34px; gap: 8px; }
  .dab-head-mark { width: 28px; height: 28px; font-size: 14px; border-radius: 8px; }
  .dab-title { font-size: 15px; line-height: 19px; }
  .dab-subtitle { font-size: 10px; line-height: 13px; }
  .dab-head-actions { gap: 4px; }
  .dab-stop { min-height: 30px; padding: 4px 8px; }
  /* The header stop is icon-only at this width; the one inside the menu keeps
     its word, where the room is available. */
  .dab-head-actions > .dab-stop .dab-stop-text { display: none; }
  .dab-filters { gap: 6px; flex-wrap: wrap; }
  .dab-search { flex: 1 1 140px; max-width: none; }
  .dab-chiprow { display: flex; align-items: center; gap: 6px; order: 3; flex: 1 0 100%; min-width: 0; }
  .dab-chiprow .dab-chips { flex: 1 1 auto; min-width: 0; gap: 0; }
  .dab-chip-btn { min-height: 32px; }
  /* Filters now sit at the end of the chip row, right of "History". Their panel
     is anchored to the toolbar and inset on both sides, so it can never open
     outside the panel whatever the trigger position. */
  .dab-menu.dab-menu-chips .dab-menu-pop { left: 10px; right: 10px; width: auto; max-width: none;
    max-height: min(70vh, 520px); overflow: auto; }
  .dab-shown { display: none; }
  .dab-menu-pop { min-width: 240px; }
  .dab-super { padding: 8px 10px; gap: 8px; min-height: 0; margin-bottom: 10px; }
  .dab-super-main { flex: 1 1 auto; }
  .dab-super-projects { display: none; }
  /* The mode is already in the header menu on a narrow panel: a third line of
     text would push the band past the mobile budget. */
  .dab-super-sub .dab-tag { display: none; }
  .dab-super-state-text { display: none; }
  /* Mobile band = mascot, name, state, project count. The orchestrator mini
     avatars live in the expandable details, exactly like the mockup. */
  .dab-super-orchs { display: none; }
  .dab-stats { gap: 6px; margin-bottom: 12px; }
  .dab-stat { flex-wrap: wrap; align-content: center; gap: 2px 5px; min-height: 46px; padding: 6px 8px; border-radius: 10px; }
  .dab-stat-value { font-size: 17px; }
  .dab-stat-label { flex: 1 0 100%; font-size: 10px; line-height: 13px; }
  .dab-overview { gap: 14px; }
  .dab-section-head { margin-bottom: 6px; }
  .dab-agent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .dab-gcard { flex-direction: column; align-items: flex-start; gap: 3px; min-height: 104px; padding: 7px 9px; }
  .dab-gcard-ident { width: 100%; padding-right: 0; gap: 1px; }
  .dab-gcard-name { font-size: 12px; line-height: 16px; width: 100%; -webkit-line-clamp: 1; }
  .dab-gcard-project { font-size: 9.5px; line-height: 13px; }
  .dab-gcard-task { font-size: 10px; line-height: 13px; }
  .dab-gcard-badge { top: 6px; right: 6px; }
  .dab-gcard-open { width: 30px; height: 30px; right: 0; bottom: 0; }
  .dab-super-none { display: none; }
  .dab-insp-panel { top: auto; left: 0; right: 0; bottom: 0; width: 100%; max-height: 78%;
    border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); }
  .dab-insp-grip { display: block; flex: none; width: 38px; height: 4px; margin: 8px auto 2px; border-radius: 2px;
    background: var(--dsw-alias-label-secondary); opacity: .5; }
  .dab-insp-body { padding: 0 14px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .dab-insp-panel .dab-insp-head { padding-top: 2px; }
  .dab-insp-panel .dab-dl { grid-template-columns: 1fr; gap: 1px 0; }
  .dab-insp-panel .dab-dl dt { margin-top: 6px; }
  .dab-projects { display: block; }
}
@container dab (max-width: 340px) {
  .dab-agent-grid { grid-template-columns: minmax(0, 1fr); }
  .dab-gcard { min-height: 84px; flex-direction: row; align-items: center; }
  .dab-gcard-ident { width: auto; }
}
/* Coarse pointers: real touch targets, no hover-only affordances. */
@media (pointer: coarse) {
  .dab-chip-btn, .dab-seg-btn { min-height: 40px; }
  /* Icon-only views stay SQUARE on touch (40x40), not tall 30x40 rectangles:
     equal width and height keep the icon optically centred. */
  .dab-viewswitch[data-icons="true"] .dab-seg-btn { width: 40px; height: 40px; }
  .dab-search { height: 40px; }
  .dab-stat { min-height: 48px; }
  .dab-icon-btn, .dab-menu-btn { width: 40px; height: 40px; }
  .dab-stop { min-height: 40px; }
  .dab-gcard-open { width: 36px; height: 36px; opacity: .85; }
}
@media (prefers-reduced-motion: reduce) {
  .dab-gcard { transition: none; }
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
