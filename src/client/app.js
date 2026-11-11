/**
 * Agent Board panel entry (React via plain createElement, no JSX build).
 *
 * Composition (responsive cockpit):
 *   AgentBoard (this file)        state, store subscription, routing
 *   ├─ DabToolbar                 ui/toolbar.js    header + filter bar + controls
 *   ├─ DabSuperOrchestratorBar    ui/superbar.js   real supervision band
 *   ├─ DabOverviewStats           ui/overview.js   four runtime indicators
 *   ├─ DabGlobalOverview          ui/overview.js   attention-first adaptive grid
 *   ├─ DabHierarchyView           ui/hierarchy.js  workspace → project → teams
 *   ├─ DabProjectGroup            ui/tree.js       tree / compact projects view
 *   ├─ DabInspector               ui/inspector.js  desktop drawer / mobile sheet
 *   ├─ DabAgentPreview            ui/preview.js    inspector content
 *   └─ DabHistoryDrawer           ui/history.js    history drawer
 *
 * Pure logic lives in supervisor/projection.js (status, project, parentage),
 * board/view.js (visibility, sorting, history), board/overview.js (cockpit
 * sections and indicator buckets) and board/interaction.js (click arbitration).
 *
 * This file is concatenated into the browser artifact by scripts/build-client.mjs.
 *
 * @module dsh-agent-board/client/app
 */

const DAB_PANEL_ID = 'dsh-agent-board'
const DAB_UI_KEY = 'dsh-agent-board:ui:v2'
const DAB_VIEW_MODES = Object.freeze(['global', 'projects', 'hierarchy'])

/** UI state survives a panel remount (navigation to a session and back). */
const DAB_MEMORY = { scrollTop: 0, selectedId: null }

function dabDefaultUi() {
  return {
    // The cockpit is the default presentation (GOAL 5). The previous default,
    // the projects tree, stays one click away and keeps its saved preference.
    viewMode: 'global',
    filter: 'attention', query: '', project: null, compact: false,
    folded: [], expanded: [], collapsed: [], dismissed: [], treeLimit: {},
    // GOAL 4 additive preferences (validated and bounded on read).
    roleFilter: null, statusFilter: null, taskStateFilter: null, supervisionOpen: false,
  }
}

function dabReadUi() {
  const base = dabDefaultUi()
  try {
    const raw = globalThis.localStorage?.getItem(DAB_UI_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw)
    // Role/status/task filters are re-validated by the pure hierarchy module: an
    // unknown persisted value can never select an invisible pseudo-status.
    const filters = normalizeHierarchyFilters({
      role: parsed.roleFilter,
      status: parsed.statusFilter,
      taskState: parsed.taskStateFilter,
    })
    return {
      ...base,
      filter: VIEW_FILTERS.includes(parsed.filter) ? parsed.filter : base.filter,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      compact: parsed.compact === true,
      folded: Array.isArray(parsed.folded) ? parsed.folded.slice(0, 200) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.slice(0, 200) : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.slice(0, 200) : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.slice(-500) : [],
      viewMode: DAB_VIEW_MODES.includes(parsed.viewMode) ? parsed.viewMode : base.viewMode,
      roleFilter: filters.role,
      statusFilter: filters.status,
      taskStateFilter: filters.taskState,
      supervisionOpen: typeof parsed.supervisionOpen === 'boolean' ? parsed.supervisionOpen : base.supervisionOpen,
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
    const [focus, setFocus] = React.useState(null)
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
    const dismissedSet = React.useMemo(() => new Set(ui.dismissed), [ui.dismissed])

    const view = React.useMemo(() => buildBoardView(projection, {
      filter: ui.filter, query: ui.query, project: ui.project, expanded: expandedSet, collapsed: collapsedSet, dismissed: dismissedSet, now: nowBucket * 60000 + 60000, aggregates,
    }), [projection, aggregates, ui.filter, ui.query, ui.project, expandedSet, collapsedSet, dismissedSet, nowBucket])

    const counts = React.useMemo(() => boardCounts(projection), [projection])
    const projectList = React.useMemo(() => projectOptions(projection), [projection])

    const mode = typeof host.mode === 'string' ? host.mode : 'off'
    // The host publishes the supervision payload (GOAL 4). A missing/foreign
    // value is `null`: the hierarchy then renders structure and real counts only.
    const supervision = host.supervision !== null && typeof host.supervision === 'object' && !Array.isArray(host.supervision)
      ? host.supervision
      : null
    const taskStates = React.useMemo(() => (typeof taskStateIndex === 'function' ? taskStateIndex(supervision) : null), [supervision])
    const taskTitles = React.useMemo(() => (typeof taskTitleIndex === 'function' ? taskTitleIndex(supervision) : null), [supervision])
    const filters = React.useMemo(() => normalizeHierarchyFilters({
      role: ui.roleFilter, status: ui.statusFilter, taskState: ui.taskStateFilter,
    }), [ui.roleFilter, ui.statusFilter, ui.taskStateFilter])
    const filtersActive = filters.role !== null || filters.status !== null || filters.taskState !== null

    // Fold state of the rendered projects (computed identically for the board
    // and the hierarchy, so a fold is never out of sync between views).
    const foldedProjects = React.useMemo(() => {
      const set = new Set()
      for (const project of view.projects) {
        const folded = project.unassigned
          ? !foldedSet.has(`open:${project.id}`) && ui.query === '' && ui.project !== project.id
          : foldedSet.has(project.id)
        if (folded) set.add(project.id)
      }
      return set
    }, [view.projects, foldedSet, ui.query, ui.project])

    // Existing view, narrowed by the explicit agent filters. buildBoardView
    // still owns visibility, attention and ordering; this only removes entries
    // the operator filtered out.
    const filteredView = React.useMemo(() => filterBoardViewByAgent(view, filters, { projection, taskStates }),
      [view, projection, filters, taskStates])

    // The hierarchy is rebuilt only when its real inputs change: a compact-mode
    // toggle or a selection never rebuilds it.
    const hierarchy = React.useMemo(() => buildHierarchyView(projection, view, supervision, {
      filters, taskStates, foldedProjects, mode,
    }), [projection, view, supervision, filters, taskStates, foldedProjects, mode])

    // The cockpit model: flat, attention-first, from the same projection.
    const overview = React.useMemo(() => buildOverview(projection, {
      filter: ui.filter, query: ui.query, project: ui.project, dismissed: dismissedSet,
      roles: hierarchy.roles, taskStates, taskTitles, filters, focus, selectedId,
      now: nowBucket * 60000 + 60000, aggregates,
    }), [projection, aggregates, ui.filter, ui.query, ui.project, dismissedSet, hierarchy.roles, taskStates, taskTitles, filters, focus, selectedId, nowBucket])

    // Every width keeps the projects overview: all projects, each foldable.
    const shownProjects = React.useMemo(() => {
      if (ui.viewMode === 'hierarchy') return []
      return filteredView.projects.map(project => {
        const entry = hierarchy.projectsById.get(project.id)
        return entry === undefined
          ? project
          : { ...project, orchestrator: entry.orchestrator, hierarchyCounts: entry.counts }
      })
    }, [filteredView, hierarchy, ui.viewMode])

    const selectedNode = selectedId !== null ? projection.byId.get(selectedId) ?? null : null
    const parentNode = selectedNode && selectedNode.parentId && !selectedNode.orphan && !selectedNode.parentCycle
      ? projection.byId.get(selectedNode.parentId) ?? null
      : null

    const nodeRef = React.useRef(projection)
    nodeRef.current = projection

    const acknowledge = React.useCallback(id => {
      const node = nodeRef.current.byId.get(id)
      if (node && (node.status === 'finished_unread' || node.status === 'recovering' || ((node.status === 'failed' || node.status === 'interrupted') && node.seen !== true))) void store.ack(id, { source: 'board_click' })
    }, [])

    // Reading a session OUTSIDE the board (native main view) is still reading.
    // The key includes the session activity timestamp: a LATER turn that
    // completes while the same session is still open is acknowledged again,
    // and leaving the view clears the entry.
    const nativeAcked = React.useRef(new Map())
    React.useEffect(() => {
      const viewing = new Set()
      for (const node of projection.nodes) {
        if (node.viewing !== true) continue
        viewing.add(node.id)
        const activityKey = String(Number(node.updatedAt) || 0)
        if (nativeAcked.current.get(node.id) === activityKey) continue
        if (node.status === 'finished_unread' || ((node.status === 'failed' || node.status === 'interrupted') && node.seen !== true)) {
          nativeAcked.current.set(node.id, activityKey)
          void store.ack(node.id, { source: 'native_view' })
        }
      }
      for (const id of [...nativeAcked.current.keys()]) {
        if (!viewing.has(id)) nativeAcked.current.delete(id)
      }
    }, [projection])

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

    const onDismiss = React.useCallback((id, on) => {
      setUiState(current => {
        const rest = current.dismissed.filter(entry => entry !== id)
        const next = { ...current, dismissed: on ? [...rest, id] : rest }
        dabWriteUi(next)
        return next
      })
      if (on) { acknowledge(id); setSelectedId(null) }
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

    const hostDown = snapshot.hostError !== null && snapshot.hostError !== undefined && host.sync === null
    const canStop = (host.assignments ?? []).some(assignment => assignment.status === 'running' || assignment.status === 'starting')
    const ctxValue = {
      selectedId, arbiter, onToggleBranch, onRevealHidden, nowBucket,
      roles: hierarchy.roles,
      taskStates,
      onFoldProject: project => onFold(project.unassigned ? `open:${project.id}` : project.id),
    }
    // The supervision body is collapsed by default in the cockpit: the band is a
    // compact summary, the details are opt-in.
    const barOpen = ui.supervisionOpen === true

    const filtersActiveAll = filtersActive || ui.project !== null || focus !== null
    const empty = h('div', { className: 'dab-empty' },
      h('div', null, ui.query !== '' ? dabT('emptySearch') : (filtersActiveAll ? dabT('emptyFiltered') : dabT('emptyAttention'))),
      ui.query === '' && !filtersActiveAll ? h('div', { className: 'dab-muted' }, dabT('emptyHint')) : null,
      filtersActiveAll
        ? h('button', {
          type: 'button', className: 'dab-btn',
          onClick: () => { setUi({ roleFilter: null, statusFilter: null, taskStateFilter: null, project: null }); setFocus(null) },
        }, dabT('clearFilters'))
        : null,
      ui.query === '' && !filtersActiveAll ? h('button', { type: 'button', className: 'dab-btn', onClick: () => setHistoryOpen(true) }, dabIcon('history'), ` ${dabT('history')}`) : null)

    const globalView = h('div', { className: 'dab-global' },
      h(DabSuperOrchestratorBar, {
        workspace: hierarchy.workspace,
        totals: hierarchy.totals,
        projects: hierarchy.projects,
        orchestrators: hierarchy.orchestrators,
        mode,
        open: barOpen,
        compact: narrow,
        onToggle: () => setUi({ supervisionOpen: !barOpen }),
        onSelect: selectNode,
      }),
      h(DabOverviewStats, {
        counts: overview.counts,
        focus,
        onFocus: setFocus,
        reviewAvailable: overview.counts.reviewAvailable === true,
        reviewReason: hierarchy.workspace.taskboard !== null && hierarchy.workspace.taskboard !== undefined && hierarchy.workspace.taskboard.available === false
          ? String(hierarchy.workspace.taskboard.reason ?? dabT('taskStateUnavailable'))
          : dabT('statReviewUnavailable'),
        compact: narrow,
      }),
      h(DabGlobalOverview, {
        overview,
        ctx: ctxValue,
        compact: ui.compact === true,
        empty,
      }))

    const projectsView = h('div', { className: 'dab-global' },
      h(DabSuperOrchestratorBar, {
        workspace: hierarchy.workspace,
        totals: hierarchy.totals,
        projects: hierarchy.projects,
        orchestrators: hierarchy.orchestrators,
        mode,
        open: barOpen,
        compact: narrow,
        onToggle: () => setUi({ supervisionOpen: !barOpen }),
        onSelect: selectNode,
      }),
      h('div', { className: 'dab-projects' }, shownProjects.map(project => h(DabProjectGroup, {
        key: project.id, project, ctx: ctxValue, compact: ui.compact,
        // "Unassigned" starts folded (opt-in), every real project starts open.
        folded: project.unassigned
          ? !foldedSet.has(`open:${project.id}`) && ui.query === '' && ui.project !== project.id
          : foldedSet.has(project.id),
        onFold: id => onFold(project.unassigned ? `open:${id}` : id),
        treeLimit: ui.treeLimit[project.id] ?? DEFAULT_TREE_LIMIT,
        onMoreTrees,
      }))))

    return h('div', {
      className: 'dab-root', ref: rootRef, 'data-dsh-agent-board': '', 'data-narrow': narrow ? 'true' : 'false',
      'data-view': ui.viewMode ?? 'global', 'data-compact': ui.compact === true ? 'true' : 'false',
    },
    h(DabToolbar, {
      counts, visibleCount: overview.counts.shown, mode, busy, hostDown, canStop, stopped: host.stoppedAt !== null && host.stoppedAt !== undefined,
      secondary: host.instance?.primary === false, ui, setUi, projects: projectList, narrow,
      taskStateAvailable: hierarchy.totals.taskStateAvailable,
      taskStateUnavailableReason: hierarchy.workspace.taskboard !== null && hierarchy.workspace.taskboard !== undefined && hierarchy.workspace.taskboard.available === false
        ? (typeof hierarchy.workspace.taskboard.reason === 'string' ? hierarchy.workspace.taskboard.reason : null)
        : null,
      onMode: value => act('mode', () => store.setMode(value)),
      onStop: () => act('stop', () => store.stop()),
      onResume: () => act('resume', () => store.resume()),
      onRefresh: () => { void store.refreshHost(); void act('refresh', () => store.refreshHost()) },
      onHistory: () => setHistoryOpen(true),
      onToggleCompact: () => setUi({ compact: !ui.compact }),
      statePanel: h(DabOrchestratorStateContent, { host, hostError: snapshot.hostError }),
      hostError: snapshot.hostError,
    }),
    h('div', { className: 'dab-main' },
      h('div', { className: 'dab-scroll', ref: scrollRef, onScroll: event => { DAB_MEMORY.scrollTop = event.currentTarget.scrollTop } },
        notice !== '' ? h('div', { className: 'dab-alert', role: 'status', style: { marginBottom: '8px' } }, notice) : null,
        h(DabExecutionList, { host, onApprove: id => act('approve', () => store.decide(id, true)), onReject: id => act('reject', () => store.decide(id, false)) }),
        (ui.viewMode ?? 'global') === 'hierarchy'
          ? h(DabHierarchyView, { hierarchy, ctx: ctxValue, compact: ui.compact })
          : (ui.viewMode === 'projects' ? projectsView : globalView)),
      selectedNode !== null
        ? h(DabInspector, {
          node: selectedNode, parent: parentNode, onOpen: openSession, onSelect: selectNode, onClose: () => setSelectedId(null), openError, onDismiss,
          dismissed: dismissedSet.has(selectedNode.id),
          role: hierarchy.roles.get(selectedNode.id) ?? null,
          taskState: selectedNode.taskId !== null && selectedNode.taskId !== undefined && taskStates instanceof Map
            ? taskStates.get(String(selectedNode.taskId)) ?? null
            : null,
          narrow,
        })
        : null),
    historyOpen
      ? h(DabHistoryDrawer, { projection, project: ui.project, selectedId, arbiter, onClose: () => setHistoryOpen(false), roles: hierarchy.roles, taskStates })
      : null,
    )
  }
}

/** Tooltip matching the DSH shell bubble (same tokens as its native tooltips). */
function dabTipHide() {
  for (const node of document.querySelectorAll('[data-dab-tip]')) node.remove()
  // Bubbles left by an earlier plugin build (no marker): unclassed body-level tooltip divs.
  for (const node of document.querySelectorAll('body > div[role="tooltip"]:not([class])')) {
    if (String(node.getAttribute('style') ?? '').includes('--dsw-alias-tooltip-bg')) node.remove()
  }
  document.removeEventListener('pointermove', dabTipGuard, true)
  window.removeEventListener('blur', dabTipHide)
  window.removeEventListener('scroll', dabTipHide, true)
}
let dabTipAnchor = null
function dabTipGuard(event) {
  const anchor = dabTipAnchor
  if (anchor === null || !anchor.isConnected) return dabTipHide()
  const r = anchor.getBoundingClientRect()
  if (event.clientX < r.left - 2 || event.clientX > r.right + 2 || event.clientY < r.top - 2 || event.clientY > r.bottom + 2) dabTipHide()
}
function dabTipHandlers(text) {
  const hide = dabTipHide
  const show = event => {
    hide()
    const anchor = event.currentTarget
    dabTipAnchor = anchor
    const rect = anchor.getBoundingClientRect()
    const row = (anchor.closest('button') ?? anchor).getBoundingClientRect()
    const bubble = document.createElement('div')
    bubble.setAttribute('role', 'tooltip')
    bubble.setAttribute('data-dab-tip', '')
    bubble.textContent = text
    Object.assign(bubble.style, {
      display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', margin: '0', fontWeight: '400', fontFamily: 'inherit',
      position: 'fixed', zIndex: '1100', left: `${Math.round(rect.right + 8)}px`, top: `${Math.round(row.top + row.height / 2)}px`, transform: 'translateY(-50%)',
      width: 'max-content', maxWidth: 'min(50vw, calc(100vw - 24px))', padding: '3px 7px', borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-tooltip-bg)', color: 'var(--dsw-static-neutral-bluish-00)', fontSize: '13px', lineHeight: '20px',
      whiteSpace: 'pre-line', pointerEvents: 'none',
    })
    document.body.appendChild(bubble)
    document.addEventListener('pointermove', dabTipGuard, true)
    window.addEventListener('blur', dabTipHide)
    window.addEventListener('scroll', dabTipHide, true)
  }
  return { onPointerEnter: show, onPointerLeave: hide, onPointerDown: hide }
}

function dabMakeIcon(store) {
  return function AgentBoardIcon() {
    const h = React.createElement
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const counts = snapshot.projection?.counts ?? {}
    const running = counts.running ?? 0
    const waiting = counts.waiting_user ?? 0
    const unread = counts.finished_unread ?? 0
    const [wide, setWide] = React.useState(true)
    const ref = React.useRef(null)
    const statsRef = React.useRef(null)
    const placeRef = React.useRef(() => {})
    React.useLayoutEffect(() => { placeRef.current() })
    // Same pattern as the Task board entry: numbers at the row's right edge when
    // the sidebar is expanded, a small badge on the icon when it is collapsed.
    React.useLayoutEffect(() => {
      const button = ref.current?.closest('button')
      if (button == null || typeof ResizeObserver === 'undefined') return undefined
      if (getComputedStyle(button).position === 'static') button.style.position = 'relative'
      // Anchor the numbers on the ROW's vertical centre even when an inner
      // positioned wrapper (icon box) is the containing block.
      const place = () => {
        const stats = statsRef.current
        const parent = stats?.offsetParent
        if (!stats || !parent) return
        const b = button.getBoundingClientRect()
        const p = parent.getBoundingClientRect()
        stats.style.top = `${Math.round(b.top - p.top + b.height / 2)}px`
        stats.style.right = `${Math.round(p.right - b.right + 9)}px`
      }
      const measure = () => { setWide(button.clientWidth > 44); place() }
      measure()
      placeRef.current = place
      const observer = new ResizeObserver(measure)
      observer.observe(button)
      return () => observer.disconnect()
    }, [])
    const title = `${running} ${dabT('running')} | ${waiting} ${dabT('waiting')} | ${unread} ${dabT('unread')}`
    const stat = (value, color) => h('span', { style: { color } }, String(value))
    const sep = () => h('span', { style: { opacity: 0.5 } }, '|')
    return h('span', { ref, style: { display: 'inline-flex', alignItems: 'center' } },
      h('span', { style: { position: 'relative', display: 'inline-flex' }, 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 2.5, y: 3, width: 7, height: 5.4, rx: 1.4 }),
          h('rect', { x: 14.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
          h('rect', { x: 2.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
          h('path', { d: 'M6 8.4v3.1a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 1 1.5 1.5v1.1' }),
          h('path', { d: 'M3.2 15.6v-2.1A1.5 1.5 0 0 1 4.7 12h2.1' })),
        !wide && unread + waiting > 0
          ? h('span', {
            style: {
              position: 'absolute', top: '-5px', right: '-8px', minWidth: '13px', height: '13px', borderRadius: '7px', padding: '0 3px',
              fontSize: '9px', fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: waiting > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)',
            },
          }, String(unread + waiting))
          : null),
      wide && running + waiting + unread > 0
        ? h('span', {
          ref: statsRef, 'aria-label': title, ...dabTipHandlers(title),
          style: {
            position: 'absolute', right: '9px', top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '11px', lineHeight: 1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
          },
        },
          stat(running, 'var(--dsw-alias-state-info-primary, #3e63dd)'), sep(),
          stat(waiting, 'var(--dsw-alias-state-warn-primary, #e69842)'), sep(),
          stat(unread, 'var(--dsw-alias-state-success-primary, #2ea043)'))
        : null)
  }
}
/** Client plugin entry: styles + store + slot registrations. */
export function apply(ctx) {
  const disposers = []
  DAB_LANG = dabResolveLocale(ctx)
  try { dabTipHide() } catch { /* ignore */ }
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
    try { dabTipHide() } catch { /* ignore */ }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}
