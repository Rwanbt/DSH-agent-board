/**
 * Toolbar (counters, search, project filter, view filters, orchestrator
 * controls) and the orchestrator side panels (proposals/executions, adapters).
 * The orchestrator controls are the pre-existing ones; when the host API is
 * unreachable they are disabled and say so instead of pretending to work.
 *
 * @module dsh-agent-board/client/ui/toolbar
 */

const DAB_ICONS = {
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  stop: ['M7 7h10v10H7z'],
  play: ['M8 5l11 7-11 7z'],
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
    else if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); if (event.key === 'Escape') rootRef.current?.querySelector('button')?.focus() }
  }
  return h('div', { className: 'dab-dd', ref: rootRef, style },
    h('button', {
      type: 'button', className: 'dab-select', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': `${label} : ${current?.[1] ?? ''}`, title: title ?? label, disabled,
      onClick: () => (open ? setOpen(false) : show()),
      onKeyDown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } },
    }, h('span', { className: 'dab-dd-text' }, current?.[1] ?? '')),
    open
      ? h('ul', { className: 'dab-dd-pop', role: 'listbox', 'aria-label': label, tabIndex: -1, ref: listRef, onKeyDown: onListKey, 'aria-activedescendant': `dab-opt-${label}-${active}` },
        options.map(([optionValue, text], index) => h('li', {
          key: optionValue, id: `dab-opt-${label}-${index}`, role: 'option', className: 'dab-dd-opt', 'aria-selected': optionValue === value, 'data-active': index === active,
          onPointerEnter: () => setActive(index), onClick: () => pick(index),
        }, h('span', { className: 'dab-dd-text' }, text), optionValue === value ? h('span', { className: 'dab-dd-check', 'aria-hidden': 'true' }, '✓') : null)))
      : null)
}

function DabToolbar(props) {
  const h = React.createElement
  const { counts, visibleCount, mode, busy, hostDown, canStop, stopped, secondary, onMode, onStop, onResume, onRefresh, ui, setUi, projects, onHistory, narrow } = props
  const counter = (tone, value, label) => value > 0
    ? h('span', { className: 'dab-counter', key: tone, title: `${value} ${label}`, 'aria-label': `${value} ${label}` }, h('span', { className: 'dab-dot', 'data-tone': tone }), h('b', null, value))
    : null
  const modeNotice = mode === 'off' ? dabT('offNotice') : mode === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice')
  const notice = secondary ? dabT('secondaryInstance') : stopped ? dabT('stoppedNotice') : modeNotice
  const [menuOpen, setMenuOpen] = React.useState(false)
  const state = props.statePanel ?? null
  const alert = secondary || stopped || hostDown
  const iconBtn = (icon, label, onClick, extra = {}) => h('button', { type: 'button', className: 'dab-icon-btn', onClick, 'aria-label': label, title: label, ...extra }, dabIcon(icon))
  const select = (label, value, options, onChange, extra = {}) => h(DabSelect, { label, value, options, onChange, title: extra.title, disabled: extra.disabled, style: extra.style })

  const counters = h('span', { className: 'dab-counters' },
    counter('running', counts.running, dabT('running')),
    counter('waiting', counts.waiting, dabT('waiting')),
    counter('unread', counts.unread, dabT('unread')),
    counter('failed', counts.failed, dabT('failed')),
    narrow ? null : h('span', { className: 'dab-muted', title: `${visibleCount} ${dabT('shown')} ${dabT('of')} ${counts.total}` }, `${visibleCount}/${counts.total}`))

  const projectSelect = select(dabT('projects'), ui.project ?? '',
    [['', dabT('allProjects')], ...projects.map(project => [project.id, `${project.id === 'unassigned' ? dabT('unassigned') : project.title} (${project.agents})`])],
    value => setUi({ project: value === '' ? null : value }), { style: narrow ? { flex: '1 1 auto', minWidth: 0 } : undefined })
  const filterSelect = select(dabT('filterLabel'), ui.filter,
    [['attention', dabT('filterAttention')], ['recent', dabT('filterRecent')], ['all', dabT('filterAll')]], value => setUi({ filter: value }))
  const viewSelect = select(dabT('viewLabel'), ui.compact ? 'compact' : 'tree',
    [['tree', dabT('treeView')], ['compact', dabT('compact')]], value => setUi({ compact: value === 'compact' }))
  const modeSelect = select(dabT('orchestratorLabel'), mode,
    ['off', 'supervised', 'autonomous'].map(value => [value, `${dabT('orchestratorLabel')} : ${dabT(value)}`]), onMode,
    { disabled: busy || hostDown || secondary, title: hostDown ? dabT('orchestratorDown') : notice })
  const stopOrResume = stopped && mode !== 'off' && !secondary
    ? iconBtn('play', dabT('resume'), onResume, { disabled: busy || hostDown, 'data-tone': 'resume' })
    : iconBtn('stop', canStop ? dabT('stop') : dabT('stopNone'), onStop, { disabled: busy || hostDown || !canStop || secondary, 'data-danger': 'true' })
  const alertDot = alert ? h('span', { className: 'dab-dot', 'data-tone': 'failed', title: hostDown ? dabT('orchestratorDown') : notice, role: 'img', 'aria-label': hostDown ? dabT('orchestratorDown') : notice }) : null

  const search = h('input', {
    type: 'search', className: 'dab-input', placeholder: dabT('search'), 'aria-label': dabT('search'), value: ui.query,
    onChange: event => setUi({ query: event.target.value }),
    onKeyDown: event => { if (event.key === 'Escape') setUi({ query: '' }) },
  })
  const history = iconBtn('history', dabT('history'), onHistory, { 'aria-haspopup': 'dialog' })
  const refresh = iconBtn('refresh', dabT('refresh'), onRefresh, { disabled: busy })

  if (narrow) {
    return h('header', { className: 'dab-toolbar' },
      h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } },
        counters, projectSelect, alertDot, history, refresh,
        iconBtn('more', dabT('moreControls'), () => setMenuOpen(value => !value), { 'aria-expanded': menuOpen })),
      h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } }, search),
      menuOpen
        ? h('div', { className: 'dab-mobile-menu' },
          h('div', { className: 'dab-bar' }, filterSelect, viewSelect),
          h('div', { className: 'dab-bar' }, modeSelect, stopOrResume, h('span', { className: 'dab-grow' }), state),
          h('div', { className: alert ? 'dab-alert' : 'dab-notice' }, hostDown ? dabT('orchestratorDown') : notice))
        : null,
    )
  }

  return h('header', { className: 'dab-toolbar' },
    h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } },
      counters,
      h('div', { className: 'dab-search-wrap' }, search),
      projectSelect, filterSelect, viewSelect,
      h('span', { className: 'dab-grow' }),
      alertDot, modeSelect, stopOrResume, state, history, refresh),
  )
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

function DabOrchestratorState({ host, hostError }) {
  const h = React.createElement
  const sync = host.sync
  const adapters = host.adapters?.adapters ?? []
  const healthy = sync?.ok === true && !hostError
  return h('details', { className: 'dab-state' },
    h('summary', { className: 'dab-btn', title: dabT('orchestratorState'), 'aria-label': dabT('orchestratorState') },
      h('span', { className: 'dab-dot', 'data-tone': healthy ? 'unread' : 'failed' }), dabT('stateShort')),
    h('div', { className: 'dab-state-pop' },
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
    ),
  )
}
