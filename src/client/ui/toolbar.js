/**
 * Cockpit header and filter bar.
 *
 * Desktop: one 52–60 px header (title, live state, supervision mode, stop,
 * refresh, history, settings) and one 40–45 px filter bar (search, view filters,
 * view switch, filters popover). Narrow panel: the header collapses to a single
 * line and the secondary controls move into one menu; the stop control stays
 * directly reachable while executions are in flight.
 *
 * The existing orchestrator controls, the host state panel and the additive
 * GOAL 4 filters are preserved, never re-implemented: the toolbar only decides
 * where they are rendered.
 *
 * @module dsh-agent-board/client/ui/toolbar
 */

const DAB_ICONS = {
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  stop: ['M7 7h10v10H7z'],
  play: ['M8 5l11 7-11 7z'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'M16.2 16.2 21 21'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  settings: ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7', 'M12 3v2', 'M12 19v2', 'M4.2 7.5l1.7 1', 'M18.1 15.5l1.7 1', 'M4.2 16.5l1.7-1', 'M18.1 8.5l1.7-1'],
  globe: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  projects: ['M4 6h4', 'M11 6h9', 'M4 12h4', 'M11 12h9', 'M4 18h4', 'M11 18h9'],
  hierarchy: ['M12 4v4', 'M6 12h12', 'M4 16h4v4H4z', 'M10 16h4v4h-4z', 'M16 16h4v4h-4z', 'M6 12v4', 'M18 12v4'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
}

/** Existing agent statuses offered by the additive status filter. */
const DAB_FILTER_STATUSES = Object.freeze([
  'running', 'waiting_user', 'recovering', 'interrupted', 'provider_unavailable',
  'finished_unread', 'finished_read', 'failed', 'idle', 'unknown', 'unavailable',
])

/** Task Board workflow states (a SEPARATE vocabulary from agent statuses). */
const DAB_FILTER_TASK_STATES = Object.freeze(['todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'archived'])

const DAB_GENERIC_ROLE_FILTER = typeof GENERIC_ROLE_FILTER === 'string' ? GENERIC_ROLE_FILTER : 'generic'

const DAB_VIEW_OPTIONS = Object.freeze([
  ['global', 'viewGlobal', 'globe'],
  ['projects', 'viewProjects', 'projects'],
  ['hierarchy', 'viewHierarchy', 'hierarchy'],
])

function dabRoleFilterOptions() {
  const options = [['', dabT('roleAll')]]
  if (typeof AGENT_ROLES === 'object' && AGENT_ROLES !== null && typeof AGENT_ROLE_IDS !== 'undefined') {
    for (const roleId of AGENT_ROLE_IDS) options.push([roleId, AGENT_ROLES[roleId]?.label ?? roleId])
  }
  options.push([DAB_GENERIC_ROLE_FILTER, dabT('roleGeneric')])
  return options
}

function dabHierarchyFiltersActive(ui) {
  return (typeof ui.roleFilter === 'string' && ui.roleFilter !== '')
    || (typeof ui.statusFilter === 'string' && ui.statusFilter !== '')
    || (typeof ui.taskStateFilter === 'string' && ui.taskStateFilter !== '')
}

function dabIcon(name) {
  const h = React.createElement
  return h('svg', { className: 'dab-ico', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    (DAB_ICONS[name] ?? []).map((d, index) => h('path', { key: index, d })))
}

/** Themed dropdown (the native <select> popup cannot follow the plugin look). */
function DabSelect({ label, value, options, onChange, title, disabled, style }) {
  const h = React.createElement
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const rootRef = React.useRef(null)
  const listRef = React.useRef(null)
  const current = options.find(([optionValue]) => optionValue === value) ?? options[0]
  // HTML ids must not contain spaces: the translated label ("État Task Board")
  // would break aria-activedescendant.
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'select'
  React.useEffect(() => {
    if (!open) return undefined
    const close = event => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    listRef.current?.focus()
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const show = () => { setActive(Math.max(0, options.findIndex(([optionValue]) => optionValue === value))); setOpen(true) }
  const pick = index => { const option = options[index]; setOpen(false); rootRef.current?.querySelector('button')?.focus(); if (option && option[0] !== value) onChange(option[0]) }
  const onListKey = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(active) }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.stopPropagation(); setOpen(false); if (event.key === 'Escape') rootRef.current?.querySelector('button')?.focus() }
  }
  return h('div', { className: 'dab-dd', ref: rootRef, style },
    h('button', {
      type: 'button', className: 'dab-select', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': `${label} : ${current?.[1] ?? ''}`, title: title ?? label, disabled,
      onClick: () => (open ? setOpen(false) : show()),
      onKeyDown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } },
    }, h('span', { className: 'dab-dd-text' }, current?.[1] ?? '')),
    open
      ? h('ul', { className: 'dab-dd-pop', role: 'listbox', 'aria-label': label, tabIndex: -1, ref: listRef, onKeyDown: onListKey, 'aria-activedescendant': `dab-opt-${slug}-${active}` },
        options.map(([optionValue, text], index) => h('li', {
          key: optionValue, id: `dab-opt-${slug}-${index}`, role: 'option', className: 'dab-dd-opt', 'aria-selected': optionValue === value, 'data-active': index === active,
          onPointerEnter: () => setActive(index), onClick: () => pick(index),
        }, h('span', { className: 'dab-dd-text' }, text), optionValue === value ? h('span', { className: 'dab-dd-check', 'aria-hidden': 'true' }, '✓') : null)))
      : null)
}

/**
 * One popover menu: a trigger button and a panel that closes on outside click
 * and Escape. Used for the filters, the settings and the narrow-panel menu.
 */
function DabMenu({ label, icon, badge, open, setOpen, align = 'end', children, className, title }) {
  const h = React.createElement
  const ref = React.useRef(null)
  React.useEffect(() => {
    if (!open) return undefined
    const onDown = event => { if (ref.current !== null && !ref.current.contains(event.target)) setOpen(false) }
    const onKey = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])
  return h('div', { className: `dab-menu ${className ?? ''}`, ref },
    h('button', {
      type: 'button', className: 'dab-icon-btn dab-menu-btn', 'aria-haspopup': 'dialog', 'aria-expanded': open,
      'aria-label': label, title: title ?? label, onClick: () => setOpen(!open),
    }, dabIcon(icon),
    typeof badge === 'number' && badge > 0 ? h('span', { className: 'dab-menu-badge', 'aria-hidden': 'true' }, String(badge)) : null),
    open ? h('div', { className: 'dab-menu-pop', role: 'dialog', 'aria-label': label, 'data-align': align }, children) : null)
}

function DabToolbar(props) {
  const h = React.createElement
  const {
    counts, visibleCount, mode, busy, hostDown, canStop, stopped, secondary, onMode, onStop, onResume, onRefresh,
    ui, setUi, projects, onHistory, narrow, iconOnly, taskStateAvailable, taskStateUnavailableReason, onToggleCompact, agentTotal,
  } = props
  const modeNotice = mode === 'off' ? dabT('offNotice') : mode === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice')
  const notice = secondary ? dabT('secondaryInstance') : stopped ? dabT('stoppedNotice') : modeNotice
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const state = props.statePanel ?? null
  const hostAlert = secondary || stopped || hostDown
  const iconBtn = (icon, label, onClick, extra = {}) => h('button', { type: 'button', className: 'dab-icon-btn', onClick, 'aria-label': label, title: label, ...extra }, dabIcon(icon))
  const select = (label, value, options, onChange, extra = {}) => h(DabSelect, { label, value, options, onChange, title: extra.title, disabled: extra.disabled, style: extra.style })

  const projectSelect = select(dabT('projects'), ui.project ?? '',
    [['', dabT('allProjects')], ...projects.map(project => [project.id, `${project.id === 'unassigned' ? dabT('unassigned') : project.title} (${project.agents})`])],
    value => setUi({ project: value === '' ? null : value }), { style: narrow ? { flex: '1 1 auto', minWidth: 0 } : undefined })
  const roleSelect = select(dabT('role'), typeof ui.roleFilter === 'string' ? ui.roleFilter : '',
    dabRoleFilterOptions(), value => setUi({ roleFilter: value === '' ? null : value }))
  const statusSelect = select(dabT('statusFilterLabel'), typeof ui.statusFilter === 'string' ? ui.statusFilter : '',
    [['', dabT('statusAll')], ...DAB_FILTER_STATUSES.map(status => [status, dabStatusLabel(status)])],
    value => setUi({ statusFilter: value === '' ? null : value }))
  // The Task Board state filter is shown only when the integration reports it
  // available. When it is not, the control stays visible but DISABLED with the
  // real reason: a reachable ledger that has not been read yet must not look
  // like an absent feature.
  const taskStateSelect = taskStateAvailable === true
    ? select(dabT('taskStateFilterLabel'), typeof ui.taskStateFilter === 'string' ? ui.taskStateFilter : '',
      [['', dabT('taskStateAll')], ...DAB_FILTER_TASK_STATES.map(state => [state, dabTaskStateLabel(state) ?? state])],
      value => setUi({ taskStateFilter: value === '' ? null : value }))
    : select(dabT('taskStateFilterLabel'), '', [['', dabT('taskStateUnavailable')]], () => {},
      { disabled: true, title: taskStateUnavailableReason ?? dabT('taskStateUnavailable') })
  const filtersActive = dabHierarchyFiltersActive(ui) || ui.project !== null
  const activeFilterCount = (ui.project !== null ? 1 : 0)
    + (typeof ui.roleFilter === 'string' && ui.roleFilter !== '' ? 1 : 0)
    + (typeof ui.statusFilter === 'string' && ui.statusFilter !== '' ? 1 : 0)
    + (typeof ui.taskStateFilter === 'string' && ui.taskStateFilter !== '' ? 1 : 0)
  const clearFilters = filtersActive
    ? h('button', {
      type: 'button', className: 'dab-btn', 'data-variant': 'ghost',
      onClick: () => setUi({ roleFilter: null, statusFilter: null, taskStateFilter: null, project: null }),
    }, dabT('clearFilters'))
    : null
  const compactToggle = h('button', {
    type: 'button', className: 'dab-btn', 'data-variant': 'ghost', 'aria-pressed': ui.compact === true ? 'true' : 'false',
    onClick: () => onToggleCompact(),
  }, dabT('compact'))
  const stopText = stopped && mode !== 'off' && !secondary ? dabT('resume') : dabT('stopShort')
  const stopLabel = stopped && mode !== 'off' && !secondary ? dabT('resume') : (canStop ? dabT('stop') : dabT('stopNone'))
  const stopButton = h('button', {
    type: 'button', className: 'dab-btn dab-stop', 'data-danger': 'true', title: `${stopLabel} — ${notice}`, 'aria-label': stopLabel,
    disabled: busy || hostDown || (!canStop && !(stopped && mode !== 'off')) || secondary,
    onClick: stopped && mode !== 'off' && !secondary ? onResume : onStop,
  }, h('span', { 'aria-hidden': 'true' }, stopped && mode !== 'off' && !secondary ? '▶' : '■'), h('span', { className: 'dab-stop-text' }, stopText))

  const liveTone = hostDown ? 'failed' : secondary ? 'idle' : 'running'
  const liveText = hostDown ? dabT('liveDown') : secondary ? dabT('liveSecondary') : dabT('liveConnected')
  const liveChip = h('span', { className: 'dab-live', 'data-tone': liveTone, title: hostDown ? (props.hostError ?? dabT('orchestratorDown')) : notice },
    h('span', { className: 'dab-dot', 'data-tone': liveTone, 'aria-hidden': 'true' }),
    narrow ? null : h('span', { className: 'dab-live-text' }, liveText))

  const modeSeg = h('div', { className: 'dab-seg dab-mode', role: 'group', 'aria-label': dabT('orchestratorLabel') },
    ['off', 'supervised', 'autonomous'].map(value => h('button', {
      key: value,
      type: 'button',
      className: 'dab-seg-btn',
      'aria-pressed': mode === value ? 'true' : 'false',
      disabled: busy || hostDown || secondary,
      title: value === 'off' ? dabT('offNotice') : value === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice'),
      onClick: () => { if (mode !== value) onMode(value) },
    }, dabT(value === 'off' ? 'modeObserve' : value))))

  // Below the label breakpoint the three views become identical square icon
  // buttons: same width, same height, icon dead-centre. The label is dropped
  // from the DOM (not merely hidden by CSS) so no empty text node can shift the
  // icon, and the button keeps an explicit accessible name.
  const viewSwitch = h('div', {
    className: 'dab-seg dab-viewswitch', role: 'group', 'aria-label': dabT('viewLabel'),
    'data-icons': iconOnly === true ? 'true' : 'false',
  },
  DAB_VIEW_OPTIONS.map(([value, labelKey, icon]) => h('button', {
    key: value,
    type: 'button',
    className: 'dab-seg-btn',
    'aria-pressed': (ui.viewMode ?? 'global') === value ? 'true' : 'false',
    'aria-label': iconOnly === true ? dabT(labelKey) : undefined,
    title: dabT(labelKey),
    onClick: () => setUi({ viewMode: value }),
  }, dabIcon(icon), iconOnly === true ? null : h('span', { className: 'dab-seg-text' }, dabT(labelKey)))))

  const chips = h('div', { className: 'dab-chips', role: 'group', 'aria-label': dabT('filterLabel') },
    [['attention', 'filterActive'], ['all', 'filterAll'], ['action', 'filterAction']].map(([value, labelKey]) => h('button', {
      key: value,
      type: 'button',
      className: 'dab-chip-btn',
      'aria-pressed': ui.filter === value ? 'true' : 'false',
      onClick: () => setUi({ filter: value }),
    }, dabT(labelKey))),
    h('button', {
      type: 'button', className: 'dab-chip-btn dab-chip-history', 'aria-haspopup': 'dialog',
      onClick: onHistory, title: dabT('historyHint'),
    }, dabT('history')))

  const search = h('label', { className: 'dab-search' },
    h('span', { className: 'dab-search-ico', 'aria-hidden': 'true' }, dabIcon('search')),
    h('input', {
      type: 'search', className: 'dab-input', placeholder: narrow ? dabT('searchShort') : dabT('search'),
      'aria-label': dabT('search'), title: dabT('search'), value: ui.query,
      onChange: event => setUi({ query: event.target.value }),
      onKeyDown: event => { if (event.key === 'Escape') setUi({ query: '' }) },
    }))

  const filterPanel = h('div', { className: 'dab-filter-pop' },
    h('div', { className: 'dab-menu-row' }, projectSelect),
    h('div', { className: 'dab-menu-row' }, roleSelect),
    h('div', { className: 'dab-menu-row' }, statusSelect),
    h('div', { className: 'dab-menu-row' }, taskStateSelect),
    h('div', { className: 'dab-menu-row dab-menu-row-actions' }, compactToggle, h('span', { className: 'dab-grow' }), clearFilters),
    h('div', { className: 'dab-menu-note' }, `${visibleCount} ${dabT('shown')} ${dabT('of')} ${counts.total}`))

  // A single filters trigger, moved into the chip row on a narrow panel: it
  // sits immediately right of "History", on the same line, and its panel is
  // anchored to the toolbar so it can never open outside the panel.
  const filtersMenu = h(DabMenu, {
    label: dabT('filtersLabel'), icon: 'filter', badge: activeFilterCount,
    open: filtersOpen, setOpen: setFiltersOpen, className: narrow ? 'dab-menu-chips' : undefined,
    title: filtersActive ? `${activeFilterCount} ${dabT('filtersLabel')}` : dabT('noFiltersActive'),
  }, filterPanel)
  const chipRow = h('div', { className: 'dab-chiprow' }, chips, narrow ? filtersMenu : null)

  const settingsPanel = h('div', { className: 'dab-settings-pop' },
    h('div', { className: hostAlert ? 'dab-alert' : 'dab-notice' }, hostDown ? dabT('orchestratorDown') : notice),
    state,
    h('div', { className: 'dab-menu-row dab-menu-row-actions' },
      h('button', { type: 'button', className: 'dab-btn', onClick: onRefresh, disabled: busy }, dabT('refresh')),
      h('button', { type: 'button', className: 'dab-btn', onClick: () => setSettingsOpen(false) }, dabT('close'))))

  const headActions = h('div', { className: 'dab-head-actions' },
    liveChip,
    narrow ? null : modeSeg,
    narrow ? (canStop ? stopButton : null) : stopButton,
    narrow ? null : iconBtn('refresh', dabT('refresh'), onRefresh, { disabled: busy }),
    narrow ? null : iconBtn('history', dabT('history'), onHistory, { 'aria-haspopup': 'dialog' }),
    h(DabMenu, {
      label: dabT('settings'), icon: 'settings', open: settingsOpen, setOpen: setSettingsOpen, title: dabT('settings'),
    }, settingsPanel),
    narrow
      ? h(DabMenu, { label: dabT('moreControls'), icon: 'more', open: menuOpen, setOpen: setMenuOpen },
        h('div', { className: 'dab-narrow-menu' },
          h('div', { className: 'dab-menu-label' }, dabT('orchestratorLabel')),
          modeSeg,
          h('div', { className: 'dab-menu-row dab-menu-row-actions' }, stopButton, h('span', { className: 'dab-grow' }),
            h('button', { type: 'button', className: 'dab-btn', onClick: onRefresh, disabled: busy }, dabT('refresh')))))
      : null)

  return h('header', { className: 'dab-toolbar' },
    h('div', { className: 'dab-head' },
      h('div', { className: 'dab-head-ident' },
        h('span', { className: 'dab-head-mark', 'aria-hidden': 'true' }, '◈'),
        h('div', { className: 'dab-head-text' },
          h('h1', { className: 'dab-title' }, dabT('title')),
          h('div', { className: 'dab-subtitle' }, `${dabT('cockpitSubtitle')} · ${Number.isFinite(Number(agentTotal)) ? Number(agentTotal) : counts.total} ${dabT('agentPlural')}`))),
      headActions),
    h('div', { className: 'dab-filters' },
      search,
      chipRow,
      h('span', { className: 'dab-grow' }),
      narrow ? null : h('span', { className: 'dab-shown', title: `${visibleCount} ${dabT('shown')} ${dabT('of')} ${counts.total}` }, `${visibleCount}/${counts.total}`),
      viewSwitch,
      narrow ? null : filtersMenu))
}

function DabExecutionList({ host, onApprove, onReject }) {
  const h = React.createElement
  const proposals = Array.isArray(host.proposals) ? host.proposals : []
  const assignments = Array.isArray(host.assignments) ? host.assignments : []
  const active = assignments.filter(assignment => assignment.status === 'running' || assignment.status === 'starting').slice(-6)
  const interrupted = assignments.filter(assignment => assignment.status === 'interrupted').slice(-4)
  if (proposals.length === 0 && active.length === 0 && interrupted.length === 0) return null
  return h('div', { className: 'dab-panel' },
    h('div', { className: 'dab-label' }, dabT('executions')),
    h('ul', { className: 'dab-list' },
      proposals.map(proposal => h('li', { key: proposal.id },
        h('span', { className: 'dab-dot', 'data-tone': 'waiting' }),
        h('span', { className: 'dab-grow' }, `${dabT('proposals')} — ${proposal.title}`),
        h('span', { className: 'dab-tag dab-mono' }, proposal.taskId),
        h('button', { type: 'button', className: 'dab-btn', onClick: () => onApprove(proposal.id) }, dabT('approve')),
        h('button', { type: 'button', className: 'dab-btn', onClick: () => onReject(proposal.id) }, dabT('reject')))),
      active.map(assignment => h('li', { key: assignment.id },
        h('span', { className: 'dab-dot', 'data-tone': 'running' }),
        h('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        h('span', { className: 'dab-tag dab-mono' }, assignment.model ? `${assignment.model.provider}/${assignment.model.model}` : '?'))),
      interrupted.map(assignment => h('li', { key: `int-${assignment.id}` },
        h('span', { className: 'dab-dot', 'data-tone': 'failed' }),
        h('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        h('span', { className: 'dab-alert' }, dabT('resumed'))))),
  )
}

/** Host state, adapters and reconcile notes: the settings popover content. */
function DabOrchestratorStateContent({ host, hostError }) {
  const h = React.createElement
  const sync = host.sync
  const adapters = host.adapters?.adapters ?? []
  const healthy = sync?.ok === true && !hostError
  return h('div', { className: 'dab-state-content' },
    h('div', { className: 'dab-label' }, dabT('orchestratorState')),
    h('div', { className: 'dab-muted', style: { marginTop: '6px' } },
      sync === null || sync === undefined
        ? (hostError ? `${dabT('syncError')}: ${hostError}` : '…')
        : sync.ok === true
          ? `${dabT('syncOk')} · rev ${sync.ledgerRevision ?? '?'} · ${sync.tasksTotal ?? 0} · ${dabFormatAge(sync.at)}`
          : `${dabT('syncError')} — ${sync.error ?? ''}`),
    (host.reconcileNotes ?? []).length > 0
      ? h('ul', { className: 'dab-list' }, host.reconcileNotes.map(note => h('li', { key: note.assignmentId },
        h('span', { className: 'dab-tag' }, `${dabT('restore')} · ${note.status}`), h('span', { className: 'dab-mono' }, note.taskId))))
      : null,
    h('div', { className: 'dab-label', style: { marginTop: '8px' } }, `${dabT('adapters')} (${adapters.length})`),
    h('ul', { className: 'dab-list' }, adapters.map(adapter => h('li', { key: adapter.id },
      h('span', { className: 'dab-tag' }, adapter.kind ?? '?'),
      h('span', { className: 'dab-grow' }, adapter.title ?? adapter.id),
      h('span', { className: 'dab-tag' }, adapter.status ?? '?'),
      adapter.validatedLive === true ? null : h('span', { className: 'dab-tag' }, dabT('notLive'))))),
    healthy ? null : h('span', { className: 'dab-dot', 'data-tone': 'failed', 'aria-hidden': 'true' }))
}

/** Legacy details wrapper (kept for the hierarchy view). */
function DabOrchestratorState({ host, hostError }) {
  const h = React.createElement
  return h('details', { className: 'dab-state' },
    h('summary', { className: 'dab-btn', title: dabT('orchestratorState'), 'aria-label': dabT('orchestratorState') },
      h('span', { className: 'dab-dot', 'data-tone': (host.sync?.ok === true && !hostError) ? 'unread' : 'failed' }), dabT('stateShort')),
    h('div', { className: 'dab-state-pop' }, h(DabOrchestratorStateContent, { host, hostError })))
}
