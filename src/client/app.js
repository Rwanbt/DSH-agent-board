/**
 * Agent Board panel (React, plain createElement — no build-time JSX).
 *
 * The panel is registered through the official slots: one `main` occupant keyed
 * `dsh-agent-board` and one `sidebar.panellist` row. It renders a card per
 * agent with real native statuses, a filiation tree per project, collapsible
 * subtrees, click-to-preview and double-click-to-open (plus an explicit
 * "Open session" button for touch/mobile), and the orchestrator controls.
 *
 * This file is concatenated into the browser artifact by scripts/build-client.mjs.
 *
 * @module dsh-agent-board/client/app
 */

const DAB_PANEL_ID = 'dsh-agent-board'
const DAB_STYLE_ID = 'dsh-agent-board-style'
const DAB_COMPACT_KEY = 'dsh-agent-board:compact'

const DAB_STRINGS = {
  fr: {
    title: 'Agent Board',
    subtitle: 'Sessions, sous-agents et travail délégué',
    mode: 'Orchestration',
    off: 'Arrêt',
    supervised: 'Supervisé',
    autonomous: 'Autonome',
    stop: 'Arrêter les exécutions',
    compact: 'Cartes compactes',
    refresh: 'Rafraîchir',
    running: 'en cours',
    waiting: 'en attente',
    unread: 'non lus',
    failed: 'en erreur',
    idle: 'inactifs',
    consult: 'terminé, consulté',
    unknown: 'inconnu / déconnecté',
    waitingApproval: 'En attente de votre approbation',
    waitingQuestion: 'En attente de votre réponse',
    waitingPlan: 'En attente de votre revue de plan',
    open: 'Ouvrir la session',
    openHint: 'Double-clic ou bouton pour ouvrir',
    preview: 'Aperçu',
    noPreview: 'Aucun segment de réponse visible pour le moment.',
    collapse: 'Replier',
    expand: 'Déplier',
    empty: 'Aucune session ni sous-agent à afficher.',
    proposals: 'Propositions en attente',
    approve: 'Approuver',
    reject: 'Refuser',
    executions: 'Exécutions',
    noExecution: 'Aucune proposition ni exécution en cours.',
    syncOk: 'Task Board synchronisé',
    syncError: 'Task Board injoignable',
    adapters: 'Adaptateurs',
    restore: 'Reprise après redémarrage',
    resumed: 'interrompue — reprise contrôlée requise',
    offNotice: 'Observation seule : aucun nouvel ordre autonome.',
    supervisedNotice: 'Supervisé : les propositions attendent votre accord.',
    autonomousNotice: 'Autonome : exécution dans le mandat configuré.',
    subagent: 'sous-agent',
    modelUnknown: 'modèle inconnu',
  },
  en: {
    title: 'Agent Board',
    subtitle: 'Sessions, sub-agents and delegated work',
    mode: 'Orchestration',
    off: 'Off',
    supervised: 'Supervised',
    autonomous: 'Autonomous',
    stop: 'Stop executions',
    compact: 'Compact cards',
    refresh: 'Refresh',
    running: 'running',
    waiting: 'waiting',
    unread: 'unread',
    failed: 'failed',
    idle: 'idle',
    consult: 'finished, consulted',
    unknown: 'unknown / disconnected',
    waitingApproval: 'Waiting for your approval',
    waitingQuestion: 'Waiting for your answer',
    waitingPlan: 'Waiting for your plan review',
    open: 'Open session',
    openHint: 'Double-click or button to open',
    preview: 'Preview',
    noPreview: 'No visible answer segment yet.',
    collapse: 'Collapse',
    expand: 'Expand',
    empty: 'No session or sub-agent to display.',
    proposals: 'Pending proposals',
    approve: 'Approve',
    reject: 'Reject',
    executions: 'Executions',
    noExecution: 'No proposal or execution in flight.',
    syncOk: 'Task Board synced',
    syncError: 'Task Board unreachable',
    adapters: 'Adapters',
    restore: 'Restart reconciliation',
    resumed: 'interrupted — controlled resume required',
    offNotice: 'Observation only: no new autonomous order.',
    supervisedNotice: 'Supervised: proposals wait for your approval.',
    autonomousNotice: 'Autonomous: runs inside the configured mandate.',
    subagent: 'sub-agent',
    modelUnknown: 'unknown model',
  },
}

function dabLocale() {
  try {
    const snap = globalThis.__dabLocale?.()
    if (typeof snap === 'string' && snap !== '') return snap.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch { /* ignore */ }
  try {
    const lang = String(globalThis.document?.documentElement?.lang ?? navigator?.language ?? 'en')
    return lang.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch {
    return 'en'
  }
}

let DAB_LANG = 'en'
const dabT = key => (DAB_STRINGS[DAB_LANG] ?? DAB_STRINGS.en)[key] ?? (DAB_STRINGS.en[key] ?? key)

const DAB_STATUS_KEY = {
  running: 'running',
  waiting_user: 'waiting',
  finished_unread: 'unread',
  finished_read: 'consult',
  failed: 'failed',
  idle: 'idle',
  unknown: 'unknown',
}

const DAB_CSS = `
.dab-root {
  display: flex; flex-direction: column; min-height: 0; height: 100%;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.45; overflow: hidden;
}
.dab-header { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 14px 18px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dab-header-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dab-title { font-size: 15px; font-weight: 650; margin: 0; }
.dab-subtitle { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dab-grow { flex: 1; min-width: 0; }
.dab-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: color-mix(in srgb, currentColor 8%, transparent); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-chip[data-tone="running"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dab-chip[data-tone="waiting"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.dab-chip[data-tone="unread"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.dab-chip[data-tone="failed"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.dab-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 4px 10px; font-size: 12px; font-weight: 550; cursor: pointer; }
.dab-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dab-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dab-btn[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1)); }
.dab-btn[disabled] { opacity: .5; cursor: default; }
.dab-btn[data-danger="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l1)); color: var(--dsw-alias-state-error-primary); }
.dab-seg { display: inline-flex; gap: 4px; padding: 2px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dab-notice { padding: 6px 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dab-scroll { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 40px; }
.dab-project { margin-bottom: 18px; }
.dab-project-head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); text-transform: none; }
.dab-project-count { font-weight: 600; font-size: 11px; opacity: .8; }
.dab-row { display: flex; align-items: stretch; gap: 0; }
.dab-indent { flex: none; width: 18px; position: relative; }
.dab-indent::before { content: ""; position: absolute; left: 8px; top: -6px; bottom: -6px; width: 1px; background: var(--dsw-alias-border-l1); }
.dab-card {
  flex: 1; min-width: 0; margin: 0 0 8px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 12px 9px 10px;
  transition: border-color .12s ease, background .12s ease;
}
.dab-card:hover { border-color: var(--dsw-alias-border-l2); }
.dab-card[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); }
.dab-card-head { display: flex; align-items: center; gap: 8px; }
.dab-open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; border: 0; background: none; padding: 0; text-align: left; color: inherit; font: inherit; cursor: pointer; border-radius: 6px; }
.dab-open:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
.dab-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-model { font-variant-numeric: tabular-nums; }
.dab-chevron { flex: none; border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 2px 4px; border-radius: 6px; font-size: 12px; }
.dab-chevron:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-ring { flex: none; width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; position: relative; }
.dab-ring[data-status="running"]::before { content: ""; width: 14px; height: 14px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); border-top-color: var(--dsw-alias-brand-primary); animation: dab-spin 1s linear infinite; box-sizing: border-box; }
.dab-ring[data-status="waiting_user"]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); animation: dab-pulse 1.6s ease-in-out infinite; }
.dab-ring[data-status="finished_unread"]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); }
.dab-ring[data-status="finished_read"]::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dab-ring[data-status="failed"]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); }
.dab-ring[data-status="idle"]::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-state-idle-primary); }
.dab-ring[data-status="unknown"]::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1.5px dashed var(--dsw-alias-label-secondary); }
.dab-detail { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 6px; }
.dab-label { font-size: 11px; font-weight: 700; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
.dab-preview { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--dsw-alias-label-primary); max-height: 168px; overflow: auto; background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px; }
.dab-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dab-waiting { color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.dab-error { color: var(--dsw-alias-state-error-primary); }
.dab-empty { padding: 28px 8px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dab-panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; background: var(--dsw-alias-bg-layer-1); }
.dab-panel-title { font-size: 12px; font-weight: 700; color: var(--dsw-alias-label-secondary); margin: 0 0 8px; }
.dab-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dab-list li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dab-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dab-status-line { padding: 2px 18px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
@keyframes dab-spin { to { transform: rotate(360deg); } }
@keyframes dab-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) {
  .dab-root * { animation-duration: .001ms !important; animation-iteration-count: 1 !important; }
  .dab-ring[data-status="running"]::before { animation: none; border-top-color: var(--dsw-alias-brand-primary); }
}
@media (max-width: 767px) {
  .dab-header { padding: 10px 12px 8px; }
  .dab-scroll { padding: 10px 12px 32px; }
  .dab-name { white-space: normal; }
}
`

function dabInjectStyles() {
  try {
    const document = globalThis.document
    if (document === undefined || document === null) return () => {}
    if (document.getElementById(DAB_STYLE_ID) !== null) return () => {}
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

function dabReadCompact() {
  try {
    return globalThis.localStorage?.getItem(DAB_COMPACT_KEY) === '1'
  } catch {
    return false
  }
}

function dabWriteCompact(value) {
  try {
    globalThis.localStorage?.setItem(DAB_COMPACT_KEY, value ? '1' : '0')
  } catch { /* private mode */ }
}

function dabFormatAge(at) {
  if (!Number.isFinite(Number(at))) return ''
  const seconds = Math.max(0, Math.round((Date.now() - Number(at)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  return `${Math.round(minutes / 60)}h`
}

function dabStatusLabel(status) {
  return dabT(DAB_STATUS_KEY[status] ?? 'unknown')
}

function dabModelText(model) {
  if (model === null || model === undefined) return dabT('modelUnknown')
  const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '?'
  const name = typeof model.model === 'string' && model.model !== '' ? model.model : '?'
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  return `${provider}/${name}${effort}`
}

/** One agent card. */
function DabCard({ node, depth, collapsed, hasChildren, onToggle, onToggleCollapse, onOpen, onAck, compact }) {
  const [expanded, setExpanded] = React.useState(false)
  const selected = expanded
  const pendingLabel = node.expectedAction === 'approval'
    ? dabT('waitingApproval')
    : node.expectedAction === 'question'
      ? dabT('waitingQuestion')
      : node.expectedAction === 'plan-review'
        ? dabT('waitingPlan')
        : null

  const expand = () => {
    setExpanded(current => {
      const next = !current
      if (next === true && node.unread === true) onAck(node.id)
      return next
    })
  }

  const open = () => onOpen(node)

  const onKeyDown = event => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      open()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      expand()
    }
  }

  return React.createElement(
    'div',
    { className: 'dab-row' },
    depth > 0 ? React.createElement('span', { className: 'dab-indent', 'aria-hidden': 'true' }) : null,
    React.createElement(
      'div',
      { className: 'dab-card', 'data-selected': selected ? 'true' : 'false', 'data-node-id': node.id },
      React.createElement(
        'div',
        { className: 'dab-card-head' },
        React.createElement('span', {
          className: 'dab-ring',
          'data-status': node.status,
          'aria-label': dabStatusLabel(node.status),
          role: 'img',
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dab-open',
            'aria-expanded': expanded,
            title: `${dabT('openHint')} — ${node.id}`,
            onClick: expand,
            onDoubleClick: open,
            onKeyDown,
          },
          React.createElement(
            'span',
            { className: 'dab-name' },
            node.archived ? '· ' : '',
            node.title,
            hasChildren ? React.createElement('span', { className: 'dab-chip', style: { marginLeft: '6px' } }, `${node.children.length}`) : null,
          ),
          React.createElement(
            'span',
            { className: 'dab-meta' },
            React.createElement('span', { className: 'dab-chip', 'data-tone': node.status === 'running' ? 'running' : node.status === 'waiting_user' ? 'waiting' : node.status === 'finished_unread' ? 'unread' : node.status === 'failed' ? 'failed' : undefined }, dabStatusLabel(node.status)),
            node.origin === 'subagent' ? React.createElement('span', { className: 'dab-chip' }, dabT('subagent')) : null,
            node.assignmentId !== null ? React.createElement('span', { className: 'dab-chip dab-mono' }, node.taskId ?? '') : null,
            React.createElement('span', { className: 'dab-chip dab-mono dab-model' }, dabModelText(node.model)),
            node.updatedAt !== null ? React.createElement('span', { className: 'dab-chip' }, dabFormatAge(node.updatedAt)) : null,
          ),
        ),
        hasChildren
          ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'dab-chevron',
              'aria-expanded': !collapsed,
              'aria-label': collapsed ? dabT('expand') : dabT('collapse'),
              title: collapsed ? dabT('expand') : dabT('collapse'),
              onClick: onToggleCollapse,
            },
            collapsed ? '▸' : '▾',
          )
          : null,
      ),
      expanded
        ? React.createElement(
          'div',
          { className: 'dab-detail' },
          pendingLabel !== null ? React.createElement('div', { className: 'dab-waiting' }, pendingLabel) : null,
          node.status === 'failed' ? React.createElement('div', { className: 'dab-error' }, dabStatusLabel('failed')) : null,
          React.createElement('div', { className: 'dab-label' }, dabT('preview')),
          React.createElement('p', { className: 'dab-preview' }, node.preview?.text !== undefined && node.preview.text !== '' ? node.preview.text : dabT('noPreview')),
          React.createElement(
            'div',
            { className: 'dab-actions' },
            React.createElement(
              'button',
              { type: 'button', className: 'dab-btn', onClick: open, title: dabT('open') },
              '↗ ',
              dabT('open'),
            ),
            node.previousSessionId !== null ? React.createElement('span', { className: 'dab-chip dab-mono' }, `← ${node.previousSessionId.slice(-10)}`) : null,
            (node.routeHistory ?? []).slice(-2).map((entry, index) => React.createElement(
              'span',
              { className: 'dab-chip dab-mono', key: `route-${index}`, title: entry.reason ?? '' },
              `${entry.from ?? '?'} → ${entry.to ?? '?'}`,
            )),
          ),
          React.createElement('div', { className: 'dab-meta dab-mono' }, node.cwd ?? ''),
        )
        : null,
    ),
  )
}

function DabExecutionList({ host, onApprove, onReject }) {
  const proposals = Array.isArray(host.proposals) ? host.proposals : []
  const assignments = Array.isArray(host.assignments) ? host.assignments : []
  const active = assignments.filter(assignment => assignment.status === 'running' || assignment.status === 'starting').slice(-6)
  const interrupted = assignments.filter(assignment => assignment.status === 'interrupted').slice(-4)
  if (proposals.length === 0 && active.length === 0 && interrupted.length === 0) {
    return React.createElement('div', { className: 'dab-panel' }, React.createElement('p', { className: 'dab-panel-title' }, dabT('executions')), React.createElement('div', { className: 'dab-subtitle' }, dabT('noExecution')))
  }
  return React.createElement(
    'div',
    { className: 'dab-panel' },
    React.createElement('p', { className: 'dab-panel-title' }, dabT('executions')),
    React.createElement(
      'ul',
      { className: 'dab-list' },
      proposals.map(proposal => React.createElement(
        'li',
        { key: proposal.id },
        React.createElement('span', { className: 'dab-chip', 'data-tone': 'waiting' }, dabT('proposals')),
        React.createElement('span', { className: 'dab-grow' }, proposal.title),
        React.createElement('span', { className: 'dab-chip dab-mono' }, proposal.taskId),
        React.createElement('button', { type: 'button', className: 'dab-btn', onClick: () => onApprove(proposal.id) }, dabT('approve')),
        React.createElement('button', { type: 'button', className: 'dab-btn', onClick: () => onReject(proposal.id) }, dabT('reject')),
      )),
      active.map(assignment => React.createElement(
        'li',
        { key: assignment.id },
        React.createElement('span', { className: 'dab-chip', 'data-tone': 'running' }, assignment.status),
        React.createElement('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        React.createElement('span', { className: 'dab-chip dab-mono' }, assignment.model === null || assignment.model === undefined ? '?' : `${assignment.model.provider}/${assignment.model.model}`),
        assignment.sessionId !== null ? React.createElement('span', { className: 'dab-chip dab-mono' }, assignment.sessionId.slice(-10)) : null,
      )),
      interrupted.map(assignment => React.createElement(
        'li',
        { key: `int-${assignment.id}` },
        React.createElement('span', { className: 'dab-chip', 'data-tone': 'failed' }, dabT('restore')),
        React.createElement('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        React.createElement('span', { className: 'dab-error' }, dabT('resumed')),
      )),
    ),
  )
}

/** The main panel page. */
function dabMakePage(store, ctx) {
  return function AgentBoardPage() {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const [collapsed, setCollapsed] = React.useState(() => new Set())
    const [compact, setCompact] = React.useState(dabReadCompact)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')

    const host = snapshot.host ?? {}
    const projection = snapshot.projection ?? { nodes: [], byId: new Map(), roots: [], projects: [], counts: {} }
    const counts = projection.counts ?? {}

    React.useEffect(() => {
      store.start()
      const timer = setInterval(() => { void store.refreshHost() }, 20000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, [])

    const toggleCollapse = id => {
      setCollapsed(current => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const openNode = node => {
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (typeof uiWorkspace?.openSession === 'function') {
          uiWorkspace.openSession(node.id)
          return
        }
        const layout = ctx.get?.('layout')
        if (typeof layout?.selectPanel === 'function') layout.selectPanel('conversation')
      } catch (error) {
        setNotice(`open failed: ${String(error?.message ?? error)}`)
      }
    }

    const ack = sessionId => { void store.ack(typeof sessionId === 'string' ? sessionId : sessionId?.id) }

    const act = async (label, operation) => {
      if (busy) return
      setBusy(true)
      try {
        const result = await operation()
        if (result?.ok !== true) setNotice(`${label}: ${result?.payload?.error ?? result?.error ?? result?.status ?? 'failed'}`)
        else setNotice('')
      } finally {
        setBusy(false)
      }
    }

    const mode = typeof host.mode === 'string' ? host.mode : 'off'
    const running = counts.running ?? 0
    const waiting = counts.waiting_user ?? 0
    const unread = counts.finished_unread ?? 0
    const canStop = (host.assignments ?? []).some(assignment => assignment.status === 'running' || assignment.status === 'starting')

    const header = React.createElement(
      'header',
      { className: 'dab-header' },
      React.createElement(
        'div',
        { className: 'dab-header-row' },
        React.createElement('h1', { className: 'dab-title' }, dabT('title')),
        React.createElement('span', { className: 'dab-subtitle' }, dabT('subtitle')),
        React.createElement('span', { className: 'dab-grow' }),
        running > 0 ? React.createElement('span', { className: 'dab-chip', 'data-tone': 'running' }, `${running} ${dabT('running')}`) : null,
        waiting > 0 ? React.createElement('span', { className: 'dab-chip', 'data-tone': 'waiting' }, `${waiting} ${dabT('waiting')}`) : null,
        unread > 0 ? React.createElement('span', { className: 'dab-chip', 'data-tone': 'unread' }, `${unread} ${dabT('unread')}`) : null,
      ),
      React.createElement(
        'div',
        { className: 'dab-header-row' },
        React.createElement('span', { className: 'dab-label' }, dabT('mode')),
        React.createElement(
          'div',
          { className: 'dab-seg', role: 'group', 'aria-label': dabT('mode') },
          ['off', 'supervised', 'autonomous'].map(value => React.createElement(
            'button',
            {
              key: value,
              type: 'button',
              className: 'dab-btn',
              'aria-pressed': mode === value,
              disabled: busy,
              onClick: () => act('mode', () => store.setMode(value)),
            },
            dabT(value),
          )),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dab-btn',
            'data-danger': 'true',
            disabled: busy || !canStop,
            onClick: () => act('stop', () => store.stop()),
            title: dabT('stop'),
          },
          '■ ',
          dabT('stop'),
        ),
        React.createElement('span', { className: 'dab-grow' }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dab-btn',
            'aria-pressed': compact,
            onClick: () => { const next = !compact; setCompact(next); dabWriteCompact(next) },
          },
          dabT('compact'),
        ),
        React.createElement('button', { type: 'button', className: 'dab-btn', onClick: () => void store.refreshHost(), disabled: busy }, '⟳ ', dabT('refresh')),
      ),
    )

    const noticeText = mode === 'off' ? dabT('offNotice') : mode === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice')
    const sync = host.sync

    const body = React.createElement(
      'div',
      { className: 'dab-scroll' },
      notice !== '' ? React.createElement('div', { className: 'dab-notice dab-error', role: 'status' }, notice) : null,
      React.createElement('div', { className: 'dab-notice' }, noticeText),
      React.createElement('div', { className: 'dab-status-line' },
        sync === null || sync === undefined
          ? (snapshot.hostError !== null ? `${dabT('syncError')}: ${snapshot.hostError}` : '...')
          : sync.ok === true
            ? `${dabT('syncOk')} · rev ${sync.ledgerRevision ?? '?'} · ${sync.tasksTotal ?? 0} tâches · ${dabFormatAge(sync.at)}`
            : `${dabT('syncError')} — ${sync.error ?? ''}`),
      React.createElement(DabExecutionList, {
        host,
        onApprove: id => act('approve', () => store.decide(id, true)),
        onReject: id => act('reject', () => store.decide(id, false)),
      }),
      (host.reconcileNotes ?? []).length > 0
        ? React.createElement('div', { className: 'dab-panel' },
          React.createElement('p', { className: 'dab-panel-title' }, dabT('restore')),
          React.createElement('ul', { className: 'dab-list' }, (host.reconcileNotes ?? []).map(note => React.createElement('li', { key: note.assignmentId },
            React.createElement('span', { className: 'dab-chip', 'data-tone': 'failed' }, note.status),
            React.createElement('span', { className: 'dab-mono' }, note.taskId),
          ))))
        : null,
      (projection.projects ?? []).length === 0
        ? React.createElement('div', { className: 'dab-empty' }, dabT('empty'))
        : projection.projects.map(project => {
          const ownIds = new Set(project.nodes)
          const projectNodes = project.nodes.map(id => projection.byId.get(id)).filter(Boolean)
          const roots = projectNodes.filter(node => node.parentId === null || !ownIds.has(node.parentId))
          const rows = compact
            ? projectNodes.slice().sort((a, b) => String(a.title).localeCompare(String(b.title))).map(node => ({ node, depth: 0, collapsed: false, hasChildren: node.children.length > 0 }))
            : flattenVisible(roots, projection.byId, collapsed)
          return React.createElement(
            'section',
            { className: 'dab-project', key: project.id },
            React.createElement(
              'h2',
              { className: 'dab-project-head' },
              project.title,
              React.createElement('span', { className: 'dab-project-count' }, `${projectNodes.length}`),
            ),
            rows.map(row => React.createElement(DabCard, {
              key: row.node.id,
              node: row.node,
              depth: compact ? 0 : row.depth,
              collapsed: collapsed.has(row.node.id),
              hasChildren: row.hasChildren,
              compact,
              onToggleCollapse: () => toggleCollapse(row.node.id),
              onOpen: openNode,
              onAck: ack,
            })),
          )
        }),
      React.createElement(
        'details',
        { className: 'dab-panel' },
        React.createElement('summary', { className: 'dab-panel-title' }, `${dabT('adapters')} (${(host.adapters?.adapters ?? []).length})`),
        React.createElement('ul', { className: 'dab-list' },
          (host.adapters?.adapters ?? []).map(adapter => React.createElement('li', { key: adapter.id },
            React.createElement('span', { className: 'dab-chip' }, adapter.kind ?? '?'),
            React.createElement('span', { className: 'dab-grow' }, adapter.title ?? adapter.id),
            React.createElement('span', { className: 'dab-chip', 'data-tone': adapter.status === 'available' ? 'unread' : 'failed' }, adapter.status ?? '?'),
            adapter.validatedLive === true ? null : React.createElement('span', { className: 'dab-chip', 'data-tone': 'waiting' }, 'non validé live'),
          )),
        ),
      ),
    )

    return React.createElement('div', { className: 'dab-root', 'data-dsh-agent-board': '' }, header, body)
  }
}

function dabMakeIcon(store) {
  return function AgentBoardIcon() {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const counts = snapshot.projection?.counts ?? {}
    const unread = counts.finished_unread ?? 0
    const waiting = counts.waiting_user ?? 0
    return React.createElement(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', position: 'relative' }, 'aria-hidden': 'true' },
      React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('rect', { x: 2.5, y: 3, width: 7, height: 5.4, rx: 1.4 }),
        React.createElement('rect', { x: 14.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
        React.createElement('rect', { x: 2.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
        React.createElement('path', { d: 'M6 8.4v3.1a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 1 1.5 1.5v1.1' }),
        React.createElement('path', { d: 'M3.2 15.6v-2.1A1.5 1.5 0 0 1 4.7 12h2.1' }),
      ),
      unread + waiting > 0
        ? React.createElement('span', {
          style: {
            position: 'absolute', top: '-6px', right: '-8px', minWidth: '13px', height: '13px', borderRadius: '999px',
            fontSize: '9px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: waiting > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
            color: 'var(--dsw-alias-bg-base)', padding: '0 3px',
          },
        }, String(unread + waiting))
        : null,
    )
  }
}

/** Client plugin entry: styles + store + slot registrations. */
export function apply(ctx) {
  const disposers = []
  // Resolve the host locale first (the shell language, not navigator.language,
  // decides the panel language), then fall back to the document/browser.
  try {
    const snapshot = ctx.get?.('locale')?.getLocale?.()
    const active = snapshot?.active
    const id = typeof active === 'string' ? active : active?.id
    if (typeof id === 'string' && id !== '') globalThis.__dabLocale = () => id
  } catch { /* keep the document fallback */ }
  DAB_LANG = dabLocale()
  try {
    disposers.push(dabInjectStyles())
  } catch { /* styling must never break activation */ }
  const store = createBoardStore(ctx)
  const page = dabMakePage(store, ctx)
  const icon = dabMakeIcon(store)
  try {
    const slots = ctx.get?.('slots') ?? ctx.slots
    if (slots === undefined || typeof slots.register !== 'function') throw new Error('slots service unavailable')
    disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: DAB_PANEL_ID }, page)))
    disposers.push(slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist', id: DAB_PANEL_ID, order: 11, label: () => dabT('title'),
    }, icon)))
  } catch (error) {
    // The shell fails the whole boot when a plugin apply throws: never rethrow.
    console.error('[dsh-agent-board] panel registration failed', error)
  }
  store.start()
  const dispose = () => {
    for (const disposer of disposers.splice(0).reverse()) {
      try { disposer?.() } catch { /* ignore */ }
    }
    store.destroy()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}
