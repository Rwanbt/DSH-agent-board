/**
 * Panel CSS. Only DSH theme alias tokens (--dsw-alias-*) are used, so light,
 * dark and custom themes apply unchanged. Layout switches on the panel width
 * (container queries), not the window width, because the panel can be narrow
 * inside a wide window.
 *
 * @module dsh-agent-board/client/ui/styles
 */

const DAB_STYLE_ID = 'dsh-agent-board-style'

const DAB_CSS = `
.dab-root { container-type: inline-size; container-name: dab; position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.4; overflow: hidden; }
.dab-root *, .dab-root *::before, .dab-root *::after { box-sizing: border-box; }
.dab-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- toolbar */
.dab-toolbar { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 16px 9px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dab-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dab-title { font-size: 15px; font-weight: 650; margin: 0 4px 0 0; white-space: nowrap; }
.dab-grow { flex: 1 1 0; min-width: 0; }
.dab-counter { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-counter b { color: var(--dsw-alias-label-primary); font-weight: 650; font-variant-numeric: tabular-nums; }
.dab-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dab-dot[data-tone="running"] { background: var(--dsw-alias-brand-primary); }
.dab-dot[data-tone="waiting"] { background: var(--dsw-alias-state-warn-primary); }
.dab-dot[data-tone="unread"] { background: var(--dsw-alias-state-success-primary); }
.dab-dot[data-tone="failed"] { background: var(--dsw-alias-state-error-primary); }
.dab-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dab-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 28px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 3px 10px; font: inherit; font-size: 12px; font-weight: 550; cursor: pointer; white-space: nowrap; }
.dab-btn:hover:not([disabled]) { border-color: var(--dsw-alias-border-l2); }
.dab-btn:focus-visible, .dab-input:focus-visible, .dab-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dab-btn[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1)); }
.dab-btn[disabled] { opacity: .5; cursor: not-allowed; }
.dab-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1)); }
.dab-btn[data-variant="ghost"] { border-color: transparent; background: transparent; }
.dab-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dab-seg .dab-btn { border-color: transparent; background: transparent; min-height: 26px; }
.dab-seg .dab-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l2); }
.dab-input, .dab-select { min-height: 28px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 3px 9px; min-width: 0; }
.dab-input { flex: 1 1 200px; max-width: 340px; }
.dab-select { max-width: 200px; }
.dab-label { font-size: 11px; font-weight: 650; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; }
.dab-notice { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-alert { font-size: 12px; color: var(--dsw-alias-state-error-primary); }

/* ---------- layout */
.dab-main { flex: 1; min-height: 0; display: flex; }
.dab-scroll { flex: 1; min-width: 0; overflow: auto; padding: 12px 16px 40px; scroll-behavior: auto; }
.dab-project { margin: 0 0 14px; }
.dab-project-head { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; padding: 4px 2px; margin: 0 0 8px; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; text-align: left; border-radius: 6px; }
.dab-project-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-project-head .dab-caret { color: var(--dsw-alias-label-secondary); width: 12px; flex: none; }
.dab-project-count { font-weight: 550; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-forest { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.dab-tile { max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 10px; border-radius: 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.dab-more { margin-top: 8px; }

/* ---------- tree (horizontal family tree: parent left, children right) */
.dab-branch { display: flex; align-items: flex-start; list-style: none; margin: 0; padding: 0; }
.dab-kids { list-style: none; margin: 0; padding: 0 0 0 22px; display: flex; flex-direction: column; gap: 8px; position: relative; }
.dab-kids::before { content: ""; position: absolute; left: 0; top: 24px; width: 11px; height: 1px; background: var(--dsw-alias-border-l2); }
.dab-kids > .dab-branch { position: relative; padding-left: 11px; }
.dab-kids > .dab-branch::before { content: ""; position: absolute; left: 0; top: 0; bottom: -8px; width: 1px; background: var(--dsw-alias-border-l2); }
.dab-kids > .dab-branch:first-child::before { top: 24px; }
.dab-kids > .dab-branch:last-child::before { bottom: auto; height: 24px; }
.dab-kids > .dab-branch:first-child:last-child::before { display: none; }
.dab-kids > .dab-branch::after { content: ""; position: absolute; left: 0; top: 24px; width: 11px; height: 1px; background: var(--dsw-alias-border-l2); }
.dab-kids > .dab-branch:first-child:last-child::after { left: -11px; width: 22px; }
.dab-kids:has(> .dab-branch:only-child)::before { display: none; }

/* ---------- card */
.dab-card { position: relative; flex: none; width: 210px; min-height: 50px; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px 8px 10px;
  border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); cursor: pointer; user-select: none;
  transition: border-color .12s ease, box-shadow .12s ease; outline: none; }
.dab-card[data-root="true"] { width: 250px; }
.dab-card:hover { border-color: var(--dsw-alias-border-l2); }
.dab-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dab-card[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dab-card[data-status="waiting_user"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 60%, var(--dsw-alias-border-l1)); }
.dab-card[data-status="failed"][data-seen="false"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1)); }
.dab-card[data-calm="true"] { opacity: .78; }
.dab-card-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
.dab-name { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-card[data-root="true"] .dab-name { font-size: 13px; }
.dab-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; }
.dab-meta > span { overflow: hidden; text-overflow: ellipsis; }
.dab-meta .dab-sep::before { content: "·"; }
.dab-role { font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dab-wait { font-size: 11px; font-weight: 600; color: var(--dsw-alias-state-warn-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-err { font-size: 11px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-card-foot { display: flex; align-items: center; gap: 6px; margin-top: 1px; min-height: 0; }
.dab-pill { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; font-weight: 600; padding: 0 7px; min-height: 20px; cursor: pointer; }
.dab-pill:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dab-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-pill[data-tone="running"] { color: var(--dsw-alias-brand-primary); }
.dab-icon-btn { flex: none; width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; padding: 0; }
.dab-icon-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dab-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); opacity: 1; }
.dab-projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 560px), 1fr)); gap: 6px 22px; align-items: start; }
.dab-quick { opacity: 0; }
.dab-card:hover .dab-quick, .dab-card:focus-within .dab-quick, .dab-card[data-selected="true"] .dab-quick { opacity: 1; }
@media (hover: none) { .dab-quick { opacity: 1; } }

/* ---------- status mark */
.dab-mark { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
.dab-mark::before { content: ""; display: block; border-radius: 50%; }
.dab-mark[data-status="running"]::before { width: 13px; height: 13px; border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent); border-top-color: var(--dsw-alias-brand-primary); animation: dab-spin .9s linear infinite; }
.dab-mark[data-status="waiting_user"]::before { width: 10px; height: 10px; background: var(--dsw-alias-state-warn-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); }
.dab-mark[data-status="finished_unread"]::before { width: 10px; height: 10px; background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); }
.dab-mark[data-status="failed"]::before { width: 9px; height: 9px; border-radius: 2px; transform: rotate(45deg); background: var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="failed"][data-seen="true"]::before { background: transparent; border: 1.5px solid var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="finished_read"]::before { width: 8px; height: 8px; background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary)); opacity: .7; }
.dab-mark[data-status="idle"]::before { width: 8px; height: 8px; border: 1.5px solid var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary)); }
.dab-mark[data-status="unknown"]::before { width: 8px; height: 8px; border: 1.5px dashed var(--dsw-alias-label-secondary); }
.dab-group-ring { display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-brand-primary); margin-right: 2px; }
@keyframes dab-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dab-mark[data-status="running"]::before { animation: none; border-color: var(--dsw-alias-brand-primary); border-right-color: transparent; }
  .dab-card, .dab-scroll { transition: none; scroll-behavior: auto; }
}

/* ---------- compact grid */
.dab-compact-group { margin: 0 0 10px; }
.dab-compact-parent { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 0 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-compact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px; }
.dab-compact-grid .dab-card { width: auto; min-height: 0; padding: 6px 8px; }
.dab-compact-grid .dab-card[data-depth]:not([data-depth="0"]) { border-left-width: 3px; }

/* ---------- inspector */
.dab-inspector { flex: none; width: 340px; max-width: 42%; border-left: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); overflow: auto; padding: 12px 14px 24px;
  display: flex; flex-direction: column; gap: 10px; }
.dab-insp-head { display: flex; align-items: flex-start; gap: 8px; }
.dab-insp-title { font-size: 14px; font-weight: 650; margin: 0; word-break: break-word; flex: 1; min-width: 0; }
.dab-insp-status { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.dab-answer { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12.5px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; padding: 8px 10px; max-height: 320px; overflow: auto; }
.dab-answer[data-empty="true"] { color: var(--dsw-alias-label-secondary); font-style: italic; }
.dab-dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; font-size: 12px; }
.dab-dl dt { color: var(--dsw-alias-label-secondary); }
.dab-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dab-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.dab-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dab-linkish { border: 0; background: none; padding: 0; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.dab-linkish:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }

/* ---------- drawer (history) */
.dab-drawer { position: absolute; inset: 0 0 0 auto; width: min(460px, 100%); background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2);
  box-shadow: -8px 0 24px color-mix(in srgb, black 14%, transparent); display: flex; flex-direction: column; z-index: 3; }
.dab-drawer-head { padding: 12px 14px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 8px; }
.dab-drawer-head .dab-input { flex: none; max-width: none; width: 100%; }
.dab-drawer-list { flex: 1; overflow: auto; list-style: none; margin: 0; padding: 6px 8px 20px; }
.dab-hist { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.dab-hist:hover { background: var(--dsw-alias-bg-layer-1); }
.dab-hist:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-hist[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); }
.dab-hist-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dab-hist-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- misc panels */
.dab-panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 8px 12px; margin: 0 0 12px; background: var(--dsw-alias-bg-layer-1); }
.dab-panel > summary { cursor: pointer; font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-secondary); }
.dab-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dab-list li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.dab-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-empty { padding: 40px 12px; text-align: center; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.dab-tabs { display: flex; gap: 6px; overflow-x: auto; padding: 0 0 2px; scrollbar-width: thin; }

/* ---------- narrow panel (phone, small window) */
@container dab (max-width: 720px) {
  .dab-toolbar { padding: 8px 10px; gap: 6px; }
  .dab-scroll { padding: 8px 10px 32px; }
  .dab-input { max-width: none; flex-basis: 100%; }
  .dab-inspector { position: absolute; left: 0; right: 0; bottom: 0; width: auto; max-width: none; max-height: 62%; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2);
    border-radius: 14px 14px 0 0; box-shadow: 0 -8px 24px color-mix(in srgb, black 16%, transparent); z-index: 2; }
  .dab-tile { padding: 8px; width: 100%; }
  .dab-forest { display: block; }
  .dab-forest > .dab-tile + .dab-tile { margin-top: 10px; }
  /* vertical compact tree */
  .dab-branch { flex-direction: column; align-items: stretch; }
  .dab-card, .dab-card[data-root="true"] { width: 100%; }
  .dab-kids { padding: 6px 0 0 14px; gap: 6px; }
  .dab-kids::before { display: none; }
  .dab-kids > .dab-branch { padding-left: 12px; }
  .dab-kids > .dab-branch::before, .dab-kids > .dab-branch:first-child::before { top: -6px; bottom: -6px; height: auto; display: block; }
  .dab-kids > .dab-branch:last-child::before { bottom: auto; height: 26px; }
  .dab-kids > .dab-branch::after, .dab-kids > .dab-branch:first-child:last-child::after { left: 0; width: 12px; top: 20px; }
  .dab-pill, .dab-btn { min-height: 32px; }
  .dab-icon-btn { width: 32px; height: 32px; }
  .dab-projects { display: block; }
  .dab-quick { opacity: 1; }
}
`

function dabInjectStyles() {
  try {
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
