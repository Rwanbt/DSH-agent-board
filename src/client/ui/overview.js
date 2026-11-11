/**
 * Global cockpit view: the four runtime indicators and the adaptive grid of
 * supervision cards.
 *
 * Everything is a projection of `board/overview.js` (pure, unit-tested): this
 * module only renders it. It never computes a status, a count or an ordering
 * from what is displayed: the sections and the counts come from the model, which
 * reads the real projection.
 *
 * Identity rules (GOAL 4, unchanged): the mascot carries the ROLE; the status is
 * a separate dot plus a text word (colour is never the only signal). A role the
 * runtime did not declare is shown as deduced, exactly like the other views.
 *
 * @module dsh-agent-board/client/ui/overview
 */

const DAB_OVERVIEW_BUCKETS = Object.freeze([
  ['active', 'statActive', 'running'],
  ['attention', 'statAttention', 'waiting'],
  ['review', 'statReview', 'reviewing'],
  ['other', 'statOther', 'idle'],
])

/** The three sections of the cockpit, always in this order (attention first). */
const DAB_OVERVIEW_SECTIONS = Object.freeze([
  ['attention', 'sectionAttention', 'waiting'],
  ['running', 'sectionRunning', 'running'],
  ['other', 'sectionOther', 'idle'],
])

/** Statuses whose card must state the status in words, not only in colour. */
const DAB_CARD_STATUS_WORDS = Object.freeze([
  'waiting_user', 'failed', 'interrupted', 'provider_unavailable', 'finished_unread',
])

function dabOverviewStatusWord(node) {
  if (node === null || node === undefined || !DAB_CARD_STATUS_WORDS.includes(node.status)) return null
  if (node.status === 'finished_unread') return dabT('statusNewResult')
  return dabStatusLabel(node.status)
}

/**
 * Four interactive indicators. `focus` is owned by the caller; clicking the
 * active one clears it. Values are the real, mutually exclusive buckets of the
 * overview model (never derived from the rendered cards).
 */
function DabOverviewStats({ counts, focus, onFocus, reviewAvailable, reviewReason, compact }) {
  const h = React.createElement
  const value = bucket => Number(counts?.[bucket]) || 0
  return h('div', { className: 'dab-stats', role: 'group', 'aria-label': dabT('indicators') },
    DAB_OVERVIEW_BUCKETS.map(([bucket, labelKey, tone]) => {
      const review = bucket === 'review'
      const disabled = review && reviewAvailable !== true
      const pressed = focus === bucket
      const title = disabled
        ? (typeof reviewReason === 'string' && reviewReason !== '' ? reviewReason : dabT('statReviewUnavailable'))
        : `${dabT(labelKey)} : ${disabled ? '—' : value(bucket)}${pressed ? ` · ${dabT('focusClear')}` : ''}`
      const inner = [
        h('span', { key: 'dot', className: 'dab-stat-dot', 'data-tone': tone, 'aria-hidden': 'true' }),
        h('strong', { key: 'n', className: 'dab-stat-value' }, disabled ? '—' : String(value(bucket))),
        h('span', { key: 'label', className: 'dab-stat-label' }, dabT(labelKey)),
      ]
      if (disabled) {
        return h('div', { key: bucket, className: 'dab-stat', 'data-bucket': bucket, 'data-disabled': 'true', title }, inner)
      }
      return h('button', {
        key: bucket,
        type: 'button',
        className: 'dab-stat',
        'data-bucket': bucket,
        'aria-pressed': pressed ? 'true' : 'false',
        title,
        onClick: () => onFocus(pressed ? null : bucket),
      }, inner)
    }))
}

/**
 * The third card line: a REAL task/activity fact, never a runtime code.
 * Order: linked Task Board title, task id, the waiting detail or the error that
 * explains an intervention. `goal` and `statusReason` are deliberately excluded:
 * they can carry internal codes (`turn_end:…`, `assignment:…`) that are not a
 * task and must not be presented as one. No task is an explicit text, not a
 * blank line.
 */
function dabGlobalTaskLine(entry, node) {
  const title = typeof entry?.taskTitle === 'string' && entry.taskTitle !== '' ? entry.taskTitle : null
  if (title !== null) return { text: title, real: true }
  if (typeof node.taskId === 'string' && node.taskId !== '') return { text: node.taskId, real: true }
  if (node.status === 'waiting_user' && typeof node.waitingDetail === 'string' && node.waitingDetail !== '') return { text: node.waitingDetail, real: true }
  if (typeof node.error === 'string' && node.error !== '') return { text: node.error, real: true }
  return { text: dabT('taskLineNone'), real: false }
}

function DabGlobalCardImpl({ entry, ctx, compact, selected }) {
  const h = React.createElement
  const node = entry.node
  const role = entry.role ?? dabCardRole(node, null)
  const statusWord = dabOverviewStatusWord(node)
  const projectText = node.projectId === 'unassigned'
    ? dabT('unassigned')
    : (typeof entry.projectTitle === 'string' && entry.projectTitle !== '' ? entry.projectTitle : (typeof node.projectTitle === 'string' ? node.projectTitle : null))
  const descendants = Number(entry.descendants) || 0
  const failover = Array.isArray(node.routeHistory) && node.routeHistory.length > 0
  const statusText = dabStatusLabel(node.status)
  const taskLine = dabGlobalTaskLine(entry, node)
  const parentText = typeof entry.parentTitle === 'string' && entry.parentTitle !== '' ? entry.parentTitle : null
  const label = [
    node.title, statusText, role.roleLabel, role.source === 'inferred' ? dabT('roleInferred') : null,
    projectText, parentText === null ? null : `${dabT('parent')} : ${parentText}`, taskLine.real ? taskLine.text : null,
    descendants > 0 ? dabT('subagentsCount', { n: descendants }) : null,
  ].filter(Boolean).join(' — ')

  const mascot = dabMascot(h, {
    role: role.roleId ?? node.role,
    resolvedRole: role.roleId === null || role.roleId === undefined ? null : role,
    name: node.title,
    status: node.status,
    size: compact === true ? 36 : 46,
    variant: compact === true ? 'compact' : 'full',
    decorative: true,
  })

  const stop = event => { event.stopPropagation() }
  return h('div', {
    className: 'dab-gcard',
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    'aria-pressed': selected ? 'true' : 'false',
    'data-node-id': node.id,
    'data-status': node.status,
    'data-seen': node.seen === true ? 'true' : 'false',
    'data-selected': selected ? 'true' : 'false',
    'data-calm': node.status === 'running' || node.status === 'recovering' || statusWord !== null ? 'false' : 'true',
    'data-role': role.roleId ?? 'generic',
    'data-role-resolution': role.source ?? 'generic',
    'data-depth': String(Number(entry.depth) || 0),
    'data-compact': compact === true ? 'true' : 'false',
    'data-task-state': entry.taskState === null || entry.taskState === undefined ? undefined : entry.taskState,
    onClick: event => ctx.arbiter.click(node.id, event.detail),
    onDoubleClick: event => { event.preventDefault(); ctx.arbiter.doubleClick(node.id) },
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
      event.preventDefault()
      // Inspect, never navigate: opening the session is the explicit button.
      if (typeof ctx.arbiter.select === 'function') ctx.arbiter.select(node.id)
      else ctx.arbiter.key(node.id, event.key)
    },
  },
  h('span', { className: 'dab-gcard-mascot', 'aria-hidden': 'true' }, mascot),
  h('span', { className: 'dab-gcard-ident' },
    h('span', { className: 'dab-gcard-row' },
      h('span', { className: 'dab-gcard-name', title: node.title }, node.title),
      failover
        ? h('span', { className: 'dab-gcard-failover', title: dabT('failoverMark'), 'aria-hidden': 'true' }, '⇄')
        : null),
    h('span', { className: 'dab-gcard-project' },
      projectText === null ? null : h('span', { className: 'dab-gcard-project-name', title: projectText }, projectText),
      statusWord === null ? null : h('span', {
        className: 'dab-gcard-state',
        'data-tone': node.status === 'waiting_user' || node.status === 'interrupted' ? 'waiting' : node.status === 'finished_unread' ? 'unread' : 'failed',
      }, statusWord)),
    // The task line exists only when the runtime/ledger really has one: an
    // "Aucune tâche liée" line on every card would be noise, not information.
    taskLine.real ? h('span', { className: 'dab-gcard-task', title: taskLine.text }, taskLine.text) : null),
  descendants > 0
    ? h('span', { className: 'dab-gcard-badge', title: dabT('subagentsCount', { n: descendants }), 'aria-hidden': 'true' }, `↳ ${descendants}`)
    : null,
  h('button', {
    type: 'button',
    className: 'dab-icon-btn dab-gcard-open',
    title: `${dabT('openSession')} : ${node.title}`,
    'aria-label': `${dabT('openSession')} : ${node.title}`,
    onClick: event => { stop(event); ctx.arbiter.open(node.id) },
    onDoubleClick: stop,
    onKeyDown: stop,
  }, '↗'))
}

const DabGlobalCard = React.memo(DabGlobalCardImpl, (a, b) => {
  const x = a.entry
  const y = b.entry
  const n = x.node
  const m = y.node
  return a.selected === b.selected
    && a.compact === b.compact
    && a.ctx.arbiter === b.ctx.arbiter
    && a.ctx.nowBucket === b.ctx.nowBucket
    && n.id === m.id && n.status === m.status && n.seen === m.seen && n.title === m.title
    && n.updatedAt === m.updatedAt && n.taskId === m.taskId && n.goal === m.goal
    && n.role === m.role && n.projectTitle === m.projectTitle
    && n.routeHistory === m.routeHistory
    && x.taskState === y.taskState && x.taskTitle === y.taskTitle
    && x.descendants === y.descendants && x.depth === y.depth
    && x.role?.roleId === y.role?.roleId && x.role?.source === y.role?.source
})

/**
 * The cockpit grid: three ordered sections, each with a real count and a uniform
 * adaptive grid. Attention is always first; an empty section is not rendered.
 */
function DabGlobalOverview({ overview, ctx, compact, empty }) {
  const h = React.createElement
  const sections = Array.isArray(overview?.sections) ? overview.sections : []
  const shown = sections.filter(section => Array.isArray(section.entries) && section.entries.length > 0)
  if (shown.length === 0) return empty ?? null
  return h('div', { className: 'dab-overview', 'data-compact': compact === true ? 'true' : 'false' },
    shown.map(section => {
      const meta = DAB_OVERVIEW_SECTIONS.find(item => item[0] === section.id) ?? ['other', 'sectionOther', 'idle']
      return h('section', { key: section.id, className: 'dab-section', 'data-section': section.id, 'aria-label': dabT(meta[1]) },
        h('div', { className: 'dab-section-head' },
          h('span', { className: 'dab-section-dot', 'data-tone': meta[2], 'aria-hidden': 'true' }),
          h('h2', { className: 'dab-section-title' }, dabT(meta[1])),
          h('span', { className: 'dab-section-count' }, dabCountText(section.entries.length, 'agentSingular', 'agentPlural'))),
        h('div', { className: 'dab-agent-grid', role: 'list' },
          section.entries.map(entry => h('div', { key: entry.node.id, role: 'listitem', className: 'dab-agent-cell' },
            h(DabGlobalCard, {
              entry,
              ctx,
              compact: compact === true,
              selected: ctx.selectedId === entry.node.id,
            })))))
    }))
}
