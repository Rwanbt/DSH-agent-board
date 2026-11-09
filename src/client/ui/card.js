/**
 * AgentCard: one compact card per agent. Pointer and keyboard go through the
 * shared click arbiter (single click = inspect, double click / Enter = open).
 * The branch toggle and the quick "open" button stop propagation so they never
 * trigger inspection or acknowledgement.
 *
 * @module dsh-agent-board/client/ui/card
 */

function dabCardSignature(props) {
  const node = props.node
  return [
    node.id, node.status, node.seen, node.title, node.role, node.updatedAt, node.expectedAction, node.waitingDetail,
    node.model?.model, node.model?.provider, node.taskId, node.error, node.orphan, node.parentCycle,
    props.selected, props.root, props.hiddenChildren, props.totalChildren, props.collapsed, props.expanded, props.groupActive,
    props.depth, props.compact, props.nowBucket,
  ].join('|')
}

function DabAgentCardImpl(props) {
  const { node, selected, root, arbiter, onToggleBranch, onRevealHidden, hiddenChildren, totalChildren, collapsed, expanded, groupActive, depth, compact } = props
  const h = React.createElement
  const model = dabModelText(node.model)
  const age = dabFormatAge(node.updatedAt)
  const statusText = dabStatusLabel(node.status)
  const calm = !(node.status === 'running' || node.status === 'waiting_user' || node.status === 'finished_unread' || (node.status === 'failed' && node.seen !== true))
  const label = [node.title, statusText, node.role, groupActive ? dabT('groupActive') : null].filter(Boolean).join(' — ')

  const stop = event => { event.stopPropagation() }
  const children = []
  children.push(h(
    'div', { className: 'dab-card-top', key: 'top' },
    h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', role: 'img', 'aria-label': statusText, title: statusText }),
    h('span', { className: 'dab-name', title: node.title }, node.title),
    h('button', {
      type: 'button', className: 'dab-icon-btn dab-quick', title: dabT('openSession'), 'aria-label': `${dabT('openSession')} : ${node.title}`,
      onClick: event => { stop(event); arbiter.open(node.id) },
      onDoubleClick: stop, onKeyDown: stop,
    }, '↗'),
  ))
  const meta = []
  if (node.role) meta.push(h('span', { key: 'role', className: 'dab-role' }, node.role))
  if (model !== null && (root || !node.role)) meta.push(h('span', { key: 'model', title: dabModelTitle(node.model) }, model))
  if (node.taskId) meta.push(h('span', { key: 'task', className: 'dab-mono', title: `${dabT('task')} ${node.taskId}` }, node.taskId))
  if (age !== '') meta.push(h('span', { key: 'age', title: node.updatedAt ? new Date(node.updatedAt).toLocaleString() : '' }, age))
  if (node.orphan) meta.push(h('span', { key: 'orphan', title: dabT('orphan') }, `⚠ ${dabT('orphan')}`))
  if (node.parentCycle) meta.push(h('span', { key: 'cycle', title: dabT('cycle') }, `⚠ ${dabT('cycle')}`))
  const metaWithSeps = []
  meta.forEach((item, index) => {
    if (index > 0) metaWithSeps.push(h('span', { key: `sep-${index}`, className: 'dab-sep', 'aria-hidden': 'true' }))
    metaWithSeps.push(item)
  })
  if (metaWithSeps.length > 0) children.push(h('div', { className: 'dab-meta', key: 'meta' }, metaWithSeps))
  if (node.status === 'waiting_user') {
    children.push(h('div', { className: 'dab-wait', key: 'wait', title: node.waitingDetail ?? '' }, node.waitingDetail ?? dabWaitingLabel(node.expectedAction)))
  }
  if (node.status === 'failed' && node.seen !== true) {
    children.push(h('div', { className: 'dab-err', key: 'err', title: node.error ?? '' }, node.error ?? dabStatusLabel('failed')))
  }

  const foot = []
  if (!compact && totalChildren > 0) {
    if (hiddenChildren > 0 && !collapsed) {
      foot.push(h('button', {
        key: 'reveal', type: 'button', className: 'dab-pill', 'data-tone': groupActive ? 'running' : undefined,
        'aria-label': `${dabT('expand')} : ${hiddenChildren} ${dabT('hidden')}`,
        onClick: event => { stop(event); onRevealHidden(node.id) },
        onDoubleClick: stop, onKeyDown: stop,
      }, groupActive ? h('span', { className: 'dab-group-ring', 'aria-hidden': 'true' }) : null, `+${hiddenChildren} ${dabT('hidden')}`))
    }
    foot.push(h('button', {
      key: 'toggle', type: 'button', className: 'dab-pill', 'aria-expanded': !collapsed,
      'aria-label': `${collapsed ? dabT('expand') : dabT('collapse')} (${totalChildren} ${dabT('children')})`,
      title: collapsed ? dabT('expand') : dabT('collapse'),
      onClick: event => { stop(event); onToggleBranch(node.id, collapsed, expanded) },
      onDoubleClick: stop, onKeyDown: stop,
    }, collapsed ? `▸ ${totalChildren}` : (expanded ? '▾ −' : `▾ ${totalChildren}`)))
  } else if (groupActive) {
    foot.push(h('span', { key: 'grp', className: 'dab-muted' }, h('span', { className: 'dab-group-ring', 'aria-hidden': 'true' }), dabT('groupActive')))
  }
  if (foot.length > 0) children.push(h('div', { className: 'dab-card-foot', key: 'foot' }, foot))

  return h('div', {
    className: 'dab-card',
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    'aria-pressed': selected ? 'true' : 'false',
    'data-node-id': node.id,
    'data-status': node.status,
    'data-seen': node.seen === true ? 'true' : 'false',
    'data-root': root ? 'true' : 'false',
    'data-selected': selected ? 'true' : 'false',
    'data-calm': calm ? 'true' : 'false',
    'data-depth': String(depth ?? 0),
    title: dabT('keyboardHint'),
    onClick: event => arbiter.click(node.id, event.detail),
    onDoubleClick: event => { event.preventDefault(); arbiter.doubleClick(node.id) },
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (arbiter.key(node.id, event.key)) event.preventDefault()
    },
  }, children)
}

const DabAgentCard = React.memo(DabAgentCardImpl, (a, b) => dabCardSignature(a) === dabCardSignature(b) && a.arbiter === b.arbiter)
