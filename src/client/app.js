/**
 * Agent Board panel entry (React via plain createElement, no JSX build).
 *
 * Composition:
 *   AgentBoard (this file)       state, store subscription, routing
 *   ├─ DabToolbar                ui/toolbar.js
 *   ├─ DabProjectGroup           ui/tree.js  → DabAgentTree → DabAgentCard (ui/card.js)
 *   ├─ DabAgentPreview           ui/preview.js
 *   └─ DabHistoryDrawer          ui/history.js
 * Pure logic lives in supervisor/projection.js (status, project, parentage),
 * board/view.js (visibility, sorting, history) and board/interaction.js
 * (click/double-click arbitration).
 *
 * This file is concatenated into the browser artifact by scripts/build-client.mjs.
 *
 * @module dsh-agent-board/client/app
 */

const DAB_PANEL_ID = 'dsh-agent-board'
const DAB_UI_KEY = 'dsh-agent-board:ui:v2'

/** UI state survives a panel remount (navigation to a session and back). */
const DAB_MEMORY = { scrollTop: 0, selectedId: null }

function dabDefaultUi() {
  return { filter: 'attention', query: '', project: null, compact: false, folded: [], expanded: [], collapsed: [], treeLimit: {} }
}

function dabReadUi() {
  const base = dabDefaultUi()
  try {
    const raw = globalThis.localStorage?.getItem(DAB_UI_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw)
    return {
      ...base,
      filter: VIEW_FILTERS.includes(parsed.filter) ? parsed.filter : base.filter,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      compact: parsed.compact === true,
      folded: Array.isArray(parsed.folded) ? parsed.folded.slice(0, 200) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.slice(0, 200) : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.slice(0, 200) : [],
    }
  } catch {
    return base
  }
}

function dabWriteUi(ui) {
  try {
    const { query: _query, treeLimit: _limit, ...persisted } = ui
    globalThis.localStorage?.setItem(DAB_UI_KEY, JSON.stringify(persisted))
  } catch { /* private mode */ }
}

function dabMakePage(store, ctx) {
  return function AgentBoardPage() {
    const h = React.createElement
    DAB_LANG = dabResolveLocale(ctx)
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const [ui, setUiState] = React.useState(dabReadUi)
    const [selectedId, setSelectedId] = React.useState(DAB_MEMORY.selectedId)
    const [historyOpen, setHistoryOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')
    const [openError, setOpenError] = React.useState('')
    const [narrow, setNarrow] = React.useState(false)
    const [nowBucket, setNowBucket] = React.useState(() => Math.floor(Date.now() / 60000))
    const rootRef = React.useRef(null)
    const scrollRef = React.useRef(null)

    const host = snapshot.host ?? {}
    const projection = snapshot.projection
    const aggregates = snapshot.aggregates

    const setUi = React.useCallback(patch => {
      setUiState(current => {
        const next = { ...current, ...patch }
        dabWriteUi(next)
        return next
      })
    }, [])

    // Lifecycle: start the store; a coarse minute tick refreshes relative ages.
    React.useEffect(() => {
      store.start()
      const tick = setInterval(() => setNowBucket(Math.floor(Date.now() / 60000)), 60000)
      return () => clearInterval(tick)
    }, [])

    // Width-driven layout (the panel may be narrow inside a wide window).
    React.useEffect(() => {
      const element = rootRef.current
      if (element === null || typeof ResizeObserver !== 'function') return undefined
      const observer = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect?.width ?? element.clientWidth
        setNarrow(width > 0 && width <= 720)
      })
      observer.observe(element)
      return () => observer.disconnect()
    }, [])

    // Restore and remember the scroll position across remounts.
    React.useEffect(() => {
      const element = scrollRef.current
      if (element !== null) element.scrollTop = DAB_MEMORY.scrollTop
      return () => { if (element !== null) DAB_MEMORY.scrollTop = element.scrollTop }
    }, [])
    React.useEffect(() => { DAB_MEMORY.selectedId = selectedId }, [selectedId])

    const expandedSet = React.useMemo(() => new Set(ui.expanded), [ui.expanded])
    const collapsedSet = React.useMemo(() => new Set(ui.collapsed), [ui.collapsed])
    const foldedSet = React.useMemo(() => new Set(ui.folded), [ui.folded])

    const view = React.useMemo(() => buildBoardView(projection, {
      filter: ui.filter, query: ui.query, project: ui.project, expanded: expandedSet, collapsed: collapsedSet, now: nowBucket * 60000 + 60000, aggregates,
    }), [projection, aggregates, ui.filter, ui.query, ui.project, expandedSet, collapsedSet, nowBucket])
    const counts = React.useMemo(() => boardCounts(projection), [projection])
    const projectList = React.useMemo(() => projectOptions(projection), [projection])

    // Phone / narrow panel: one project at a time.
    const activeProjectId = narrow && ui.project === null ? (view.projects[0]?.id ?? null) : ui.project
    const shownProjects = narrow && activeProjectId !== null ? view.projects.filter(project => project.id === activeProjectId) : view.projects

    const selectedNode = selectedId !== null ? projection.byId.get(selectedId) ?? null : null
    const parentNode = selectedNode && selectedNode.parentId && !selectedNode.orphan && !selectedNode.parentCycle
      ? projection.byId.get(selectedNode.parentId) ?? null
      : null

    const nodeRef = React.useRef(projection)
    nodeRef.current = projection

    const acknowledge = React.useCallback(id => {
      const node = nodeRef.current.byId.get(id)
      if (node && (node.status === 'finished_unread' || (node.status === 'failed' && node.seen !== true))) void store.ack(id)
    }, [])

    const openSession = React.useCallback(id => {
      setOpenError('')
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (typeof uiWorkspace?.openSession !== 'function') throw new Error('uiWorkspace.openSession unavailable')
        const scroll = scrollRef.current
        if (scroll !== null) DAB_MEMORY.scrollTop = scroll.scrollTop
        DAB_MEMORY.selectedId = id
        uiWorkspace.openSession(id)
        acknowledge(id)
      } catch (error) {
        setSelectedId(id)
        setOpenError(`${dabT('openFailed')} (${String(error?.message ?? error)})`)
      }
    }, [acknowledge])

    const selectNode = React.useCallback(id => {
      setOpenError('')
      setSelectedId(id)
      acknowledge(id)
    }, [acknowledge])

    const arbiter = React.useMemo(() => createClickArbiter({ onSelect: selectNode, onOpen: openSession }), [selectNode, openSession])
    React.useEffect(() => () => arbiter.cancel(), [arbiter])

    const onToggleBranch = React.useCallback((id, collapsed) => {
      setUiState(current => {
        const collapsedNext = new Set(current.collapsed)
        const expandedNext = new Set(current.expanded)
        if (collapsed) collapsedNext.delete(id)
        else { collapsedNext.add(id); expandedNext.delete(id) }
        const next = { ...current, collapsed: [...collapsedNext], expanded: [...expandedNext] }
        dabWriteUi(next)
        return next
      })
    }, [])
    const onRevealHidden = React.useCallback(id => {
      setUiState(current => {
        const next = { ...current, expanded: [...new Set([...current.expanded, id])], collapsed: current.collapsed.filter(entry => entry !== id) }
        dabWriteUi(next)
        return next
      })
    }, [])
    const onFold = React.useCallback(id => {
      setUiState(current => {
        const folded = new Set(current.folded)
        if (folded.has(id)) folded.delete(id)
        else folded.add(id)
        const next = { ...current, folded: [...folded] }
        dabWriteUi(next)
        return next
      })
    }, [])
    const onMoreTrees = React.useCallback(id => {
      setUiState(current => ({ ...current, treeLimit: { ...current.treeLimit, [id]: (current.treeLimit[id] ?? DEFAULT_TREE_LIMIT) + DEFAULT_TREE_LIMIT } }))
    }, [])

    const act = async (label, operation) => {
      if (busy) return
      setBusy(true)
      try {
        const result = await operation()
        setNotice(result?.ok === true ? '' : `${label}: ${result?.payload?.error ?? result?.error ?? result?.status ?? 'failed'}`)
      } finally {
        setBusy(false)
      }
    }

    const mode = typeof host.mode === 'string' ? host.mode : 'off'
    const hostDown = snapshot.hostError !== null && snapshot.hostError !== undefined && host.sync === null
    const canStop = (host.assignments ?? []).some(assignment => assignment.status === 'running' || assignment.status === 'starting')
    const ctxValue = { selectedId, arbiter, onToggleBranch, onRevealHidden, nowBucket }

    const empty = shownProjects.length === 0
      ? h('div', { className: 'dab-empty' },
        h('div', null, ui.query !== '' ? dabT('emptySearch') : dabT('emptyAttention')),
        ui.query === '' ? h('div', { className: 'dab-muted' }, dabT('emptyHint')) : null,
        ui.query === '' ? h('button', { type: 'button', className: 'dab-btn', onClick: () => setHistoryOpen(true) }, `🕘 ${dabT('history')}`) : null)
      : null

    const tabs = narrow && view.projects.length > 1 && ui.project === null
      ? h('div', { className: 'dab-tabs', role: 'tablist', 'aria-label': dabT('projects') },
        view.projects.map(project => h('button', {
          key: project.id, type: 'button', role: 'tab', className: 'dab-btn', 'aria-selected': project.id === activeProjectId, 'aria-pressed': project.id === activeProjectId,
          onClick: () => setUi({ project: project.id }),
        }, `${project.unassigned ? dabT('unassigned') : project.title} · ${project.visibleAgents}`)))
      : null

    return h('div', { className: 'dab-root', ref: rootRef, 'data-dsh-agent-board': '', 'data-narrow': narrow ? 'true' : 'false' },
      h(DabToolbar, {
        counts, visibleCount: view.visibleCount, mode, busy, hostDown, canStop, ui, setUi, projects: projectList, narrow,
        onMode: value => act('mode', () => store.setMode(value)),
        onStop: () => act('stop', () => store.stop()),
        onRefresh: () => { void store.refreshHost(); void act('refresh', () => store.refreshHost()) },
        onHistory: () => setHistoryOpen(true),
      }),
      h('div', { className: 'dab-main' },
        h('div', { className: 'dab-scroll', ref: scrollRef, onScroll: event => { DAB_MEMORY.scrollTop = event.currentTarget.scrollTop } },
          notice !== '' ? h('div', { className: 'dab-alert', role: 'status', style: { marginBottom: '8px' } }, notice) : null,
          h(DabExecutionList, { host, onApprove: id => act('approve', () => store.decide(id, true)), onReject: id => act('reject', () => store.decide(id, false)) }),
          tabs,
          empty,
          h('div', { className: 'dab-projects' }, shownProjects.map(project => h(DabProjectGroup, {
            key: project.id, project, ctx: ctxValue, compact: ui.compact,
            // "Unassigned" starts folded (opt-in), every real project starts open.
            folded: project.unassigned
              ? !foldedSet.has(`open:${project.id}`) && ui.query === '' && ui.project !== project.id
              : foldedSet.has(project.id),
            onFold: id => onFold(project.unassigned ? `open:${id}` : id),
            treeLimit: ui.treeLimit[project.id] ?? DEFAULT_TREE_LIMIT,
            onMoreTrees,
          }))),
          h(DabOrchestratorState, { host, hostError: snapshot.hostError })),
        selectedNode !== null
          ? h(DabAgentPreview, { node: selectedNode, parent: parentNode, onOpen: openSession, onSelect: selectNode, onClose: () => setSelectedId(null), openError })
          : null),
      historyOpen
        ? h(DabHistoryDrawer, { projection, project: ui.project, selectedId, arbiter, onClose: () => setHistoryOpen(false) })
        : null,
    )
  }
}

function dabMakeIcon(store) {
  return function AgentBoardIcon() {
    const h = React.createElement
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const counts = snapshot.projection?.counts ?? {}
    const unread = counts.finished_unread ?? 0
    const waiting = counts.waiting_user ?? 0
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', position: 'relative' }, 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 2.5, y: 3, width: 7, height: 5.4, rx: 1.4 }),
        h('rect', { x: 14.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
        h('rect', { x: 2.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
        h('path', { d: 'M6 8.4v3.1a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 1 1.5 1.5v1.1' }),
        h('path', { d: 'M3.2 15.6v-2.1A1.5 1.5 0 0 1 4.7 12h2.1' })),
      unread + waiting > 0
        ? h('span', {
          style: {
            position: 'absolute', top: '-6px', right: '-8px', minWidth: '13px', height: '13px', borderRadius: '999px',
            fontSize: '9px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: waiting > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
            color: 'var(--dsw-alias-bg-base)', padding: '0 3px',
          },
        }, String(unread + waiting))
        : null)
  }
}

/** Client plugin entry: styles + store + slot registrations. */
export function apply(ctx) {
  const disposers = []
  DAB_LANG = dabResolveLocale(ctx)
  try {
    const locale = ctx.get?.('locale')
    if (typeof locale?.subscribe === 'function') disposers.push(locale.subscribe(() => { DAB_LANG = dabResolveLocale(ctx) }))
  } catch { /* keep the resolved language */ }
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
