/**
 * HistoryDrawer: on-demand, searchable, paginated list of every calm session
 * (idle, viewed, archived). It is computed only while open, from the in-memory
 * projection — no extra fetch, nothing deleted or archived.
 *
 * @module dsh-agent-board/client/ui/history
 */

const DAB_HISTORY_PAGE = 30

function DabHistoryDrawer({ projection, project, selectedId, arbiter, onClose, roles, taskStates }) {
  const h = React.createElement
  const [query, setQuery] = React.useState('')
  const [limit, setLimit] = React.useState(DAB_HISTORY_PAGE)
  const inputRef = React.useRef(null)
  React.useEffect(() => { inputRef.current?.focus?.() }, [])
  React.useEffect(() => { setLimit(DAB_HISTORY_PAGE) }, [query, project])
  const page = React.useMemo(() => historyPage(projection, { query, project, offset: 0, limit }), [projection, query, project, limit])
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
  const roleOf = node => {
    const resolved = roles instanceof Map ? roles.get(node.id) : null
    const text = resolved?.roleLabel ?? (typeof node.role === 'string' && node.role !== '' ? node.role : null)
    return text
  }
  const taskStateOf = node => {
    if (node.taskId === null || node.taskId === undefined || !(taskStates instanceof Map)) return null
    return typeof dabTaskStateLabel === 'function' ? dabTaskStateLabel(taskStates.get(String(node.taskId))) : null
  }
  return h('div', { className: 'dab-drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': dabT('historyTitle'), onKeyDown: onKey },
    h('div', { className: 'dab-drawer-head' },
      h('div', { className: 'dab-bar' },
        h('strong', { style: { fontSize: '14px' } }, dabT('historyTitle')),
        h('span', { className: 'dab-muted' }, `${page.total}`),
        h('span', { className: 'dab-grow' }),
        h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', onClick: onClose, 'aria-label': dabT('close') }, '✕')),
      h('input', { ref: inputRef, type: 'search', className: 'dab-input', style: { maxWidth: 'none' }, placeholder: dabT('search'), 'aria-label': dabT('search'), value: query, onChange: event => setQuery(event.target.value) }),
      h('div', { className: 'dab-muted' }, dabT('historyHint'))),
    h('ul', { className: 'dab-drawer-list' },
      page.items.map(node => h('li', {
        key: node.id, className: 'dab-hist', tabIndex: 0, role: 'button', 'data-node-id': node.id,
        'data-selected': selectedId === node.id ? 'true' : 'false',
        'aria-label': [node.title, dabStatusLabel(node.status), roleOf(node)].filter(Boolean).join(' — '),
        onClick: event => arbiter.click(node.id, event.detail),
        onDoubleClick: () => arbiter.doubleClick(node.id),
        onKeyDown: event => { if (event.target === event.currentTarget && arbiter.key(node.id, event.key)) event.preventDefault() },
      },
      h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', 'aria-hidden': 'true' }),
      h('span', { className: 'dab-hist-main' },
        h('span', { className: 'dab-hist-title', title: node.title }, node.title),
        h('span', { className: 'dab-muted' }, [
          node.projectId === 'unassigned' ? dabT('unassigned') : node.projectTitle,
          roleOf(node),
          taskStateOf(node),
          node.children.length > 0 ? `${node.children.length} ${dabT('children')}` : null,
          node.archived ? dabT('archived') : null,
          dabFormatAge(node.updatedAt),
        ].filter(Boolean).join(' · '))))),
      page.hasMore
        ? h('li', { style: { padding: '8px' } }, h('button', { type: 'button', className: 'dab-btn', onClick: () => setLimit(value => value + DAB_HISTORY_PAGE) }, `${dabT('loadMore')} (${page.total - page.items.length})`))
        : null),
  )
}
