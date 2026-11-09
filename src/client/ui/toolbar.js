/**
 * Toolbar (counters, search, project filter, view filters, orchestrator
 * controls) and the orchestrator side panels (proposals/executions, adapters).
 * The orchestrator controls are the pre-existing ones; when the host API is
 * unreachable they are disabled and say so instead of pretending to work.
 *
 * @module dsh-agent-board/client/ui/toolbar
 */

function DabToolbar(props) {
  const h = React.createElement
  const { counts, visibleCount, mode, busy, hostDown, canStop, stopped, secondary, onMode, onStop, onResume, onRefresh, ui, setUi, projects, onHistory, narrow } = props
  const counter = (tone, value, label) => value > 0
    ? h('span', { className: 'dab-counter', key: tone, title: `${value} ${label}` }, h('span', { className: 'dab-dot', 'data-tone': tone }), h('b', null, value), ` ${label}`)
    : null
  const modeNotice = mode === 'off' ? dabT('offNotice') : mode === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice')
  const notice = secondary ? dabT('secondaryInstance') : stopped ? dabT('stoppedNotice') : modeNotice
  return h('header', { className: 'dab-toolbar' },
    h('div', { className: 'dab-bar' },
      h('h1', { className: 'dab-title' }, dabT('title')),
      counter('running', counts.running, dabT('running')),
      counter('waiting', counts.waiting, dabT('waiting')),
      counter('unread', counts.unread, dabT('unread')),
      counter('failed', counts.failed, dabT('failed')),
      h('span', { className: 'dab-muted', title: `${visibleCount} ${dabT('shown')} ${dabT('of')} ${counts.total}` }, `${visibleCount}/${counts.total} ${dabT('shown')}`),
      h('span', { className: 'dab-grow' }),
      h('span', { className: 'dab-label' }, dabT('mode')),
      h('div', { className: 'dab-seg', role: 'group', 'aria-label': dabT('mode'), title: hostDown ? dabT('orchestratorDown') : modeNotice },
        ['off', 'supervised', 'autonomous'].map(value => h('button', {
          key: value, type: 'button', className: 'dab-btn', 'aria-pressed': mode === value, disabled: busy || hostDown || secondary,
          onClick: () => onMode(value),
        }, dabT(value)))),
      stopped && mode !== 'off' && !secondary
        ? h('button', { type: 'button', className: 'dab-btn', 'data-tone': 'resume', disabled: busy || hostDown, onClick: onResume, title: dabT('stoppedNotice') }, `▶ ${dabT('resume')}`)
        : null,
      h('button', { type: 'button', className: 'dab-btn', 'data-danger': 'true', disabled: busy || hostDown || !canStop || secondary, onClick: onStop, title: hostDown ? dabT('orchestratorDown') : (canStop ? dabT('stop') : dabT('stopNone')) }, `■ ${dabT('stop')}`),
      h('button', { type: 'button', className: 'dab-btn', onClick: onRefresh, disabled: busy, title: dabT('refresh'), 'aria-label': dabT('refresh') }, narrow ? '⟳' : `⟳ ${dabT('refresh')}`)),
    h('div', { className: 'dab-bar' },
      h('input', {
        type: 'search', className: 'dab-input', placeholder: dabT('search'), 'aria-label': dabT('search'), value: ui.query,
        onChange: event => setUi({ query: event.target.value }),
        onKeyDown: event => { if (event.key === 'Escape') setUi({ query: '' }) },
      }),
      h('select', { className: 'dab-select', 'aria-label': dabT('projects'), value: ui.project ?? '', onChange: event => setUi({ project: event.target.value === '' ? null : event.target.value }) },
        h('option', { value: '' }, dabT('allProjects')),
        projects.map(project => h('option', { key: project.id, value: project.id }, `${project.id === 'unassigned' ? dabT('unassigned') : project.title} (${project.agents})`))),
      h('div', { className: 'dab-seg', role: 'group', 'aria-label': 'Filtre' },
        [['attention', 'filterAttention'], ['recent', 'filterRecent'], ['all', 'filterAll']].map(([value, key]) => h('button', {
          key: value, type: 'button', className: 'dab-btn', 'aria-pressed': ui.filter === value, onClick: () => setUi({ filter: value }),
        }, dabT(key)))),
      h('div', { className: 'dab-seg', role: 'group', 'aria-label': 'Vue' },
        h('button', { type: 'button', className: 'dab-btn', 'aria-pressed': !ui.compact, onClick: () => setUi({ compact: false }) }, dabT('treeView')),
        h('button', { type: 'button', className: 'dab-btn', 'aria-pressed': ui.compact, onClick: () => setUi({ compact: true }) }, dabT('compact'))),
      h('button', { type: 'button', className: 'dab-btn', onClick: onHistory, 'aria-haspopup': 'dialog' }, `🕘 ${dabT('history')}`),
      h('span', { className: 'dab-grow' }),
      h('span', { className: 'dab-notice' }, secondary || stopped ? h('span', { className: 'dab-alert' }, notice) : (hostDown ? h('span', { className: 'dab-alert' }, dabT('orchestratorDown')) : modeNotice))),
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
  return h('details', { className: 'dab-panel' },
    h('summary', null, dabT('orchestratorState')),
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
  )
}
