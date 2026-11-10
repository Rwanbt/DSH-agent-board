/**
 * AgentPreview: the inspection panel opened by a single click. It shows the
 * last useful line of the agent's FINAL answer (never a tool call, a log line
 * or reasoning), "See more" for the bounded full excerpt, then secondary facts.
 *
 * @module dsh-agent-board/client/ui/preview
 */

function DabAgentPreview({ node, parent, onOpen, onSelect, onClose, openError, onDismiss, dismissed }) {
  const h = React.createElement
  const [more, setMore] = React.useState(false)
  React.useEffect(() => { setMore(false) }, [node?.id])
  if (node === null || node === undefined) return null
  const preview = node.preview ?? { text: '', final: false }
  const hasFinal = preview.final === true && typeof preview.text === 'string' && preview.text !== ''
  const line = hasFinal ? lastUsefulLine(preview.text) : ''
  const facts = []
  const fact = (key, label, value, mono) => {
    if (value === null || value === undefined || value === '') return
    facts.push(h('dt', { key: `${key}-t` }, label), h('dd', { key: `${key}-d`, className: mono ? 'dab-mono' : undefined }, value))
  }
  fact('project', dabT('project'), node.projectId === 'unassigned' ? dabT('unassigned') : node.projectTitle)
  fact('provider', dabT('provider'), node.model?.provider, true)
  fact('model', dabT('model'), node.model?.source === 'unknown' ? null : dabModelTitle(node.model), true)
  fact('modelSource', dabT('modelSource'), node.model?.source === 'unknown' ? null : (node.model.source === 'assignment' ? dabT('modelAssignment') : dabT('modelNative')))
  fact('task', dabT('task'), node.taskId, true)
  fact('goal', dabT('goal'), node.goal)
  if (parent !== null && parent !== undefined) {
    facts.push(h('dt', { key: 'parent-t' }, dabT('parent')), h('dd', { key: 'parent-d' },
      h('button', { type: 'button', className: 'dab-linkish', onClick: () => onSelect(parent.id) }, parent.title)))
  if (node.orphan) {
    fact('parent', dabT('parent'), `${dabT('orphan')} (${String(node.parentId).slice(-12)})`, true)
  } else if (node.parentCycle) {
    fact('parent', dabT('parent'), dabT('cycle'))
  } else if (node.parentContested) {
    fact('parent', dabT('parent'), `${dabT('contest')} (${(node.parentCandidates ?? []).join(', ')})`, true)
  }
  if (node.activity) fact('activity', dabT('activity'), `${node.activity.turns} ${dabT('turns')} · ${node.activity.steps} ${dabT('steps')}`)
  fact('cwd', dabT('directory'), node.cwd, true)
  fact('session', dabT('session'), node.id, true)
  // A route switch must stay visible: never show only the LAST provider.
  fact('previous', dabT('previousSession'), node.previousSessionId, true)
  const routes = Array.isArray(node.routeHistory) ? node.routeHistory : []
  if (routes.length > 0) {
    fact('routes', dabT('routeHistory'), routes.map(entry => `${entry.from ?? '?'} → ${entry.to ?? '?'}${entry.reason ? ` (${entry.reason})` : ''}`).join(' · '))
  }
  fact('reason', dabT('statusReason'), node.statusReason, true)
  if (node.status === 'recovering') {
    facts.push(h('dt', { key: 'rec-t' }, dabT('recovery')), h('dd', { key: 'rec-d', className: 'dab-alert' }, node.statusReason ?? ''))
  }
  if (node.status === 'interrupted') {
    facts.push(h('dt', { key: 'int-t' }, dabT('statusInterrupted')), h('dd', { key: 'int-d', className: 'dab-wait' }, node.statusReason ?? ''))
  }
  if (node.status === 'provider_unavailable') {
    facts.push(h('dt', { key: 'pu-t' }, dabT('statusProviderUnavailable')), h('dd', { key: 'pu-d', className: 'dab-alert' }, node.statusReason ?? ''))
  }

  return h('aside', { className: 'dab-inspector', 'aria-label': `${dabT('finalAnswer')} — ${node.title}`, 'data-inspector-for': node.id },
    h('div', { className: 'dab-insp-head' },
      h('h2', { className: 'dab-insp-title' }, node.title),
      h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', 'aria-label': dabT('close'), onClick: onClose }, '✕')),
    h('div', { className: 'dab-insp-status' },
      h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', 'aria-hidden': 'true' }),
      dabStatusLabel(node.status),
      // Compact provider/model chip, same tokens as the card. Unknown stays
      // explicit instead of borrowing the deployment default model.
      h('span', {
        className: 'dab-chip',
        'data-source': typeof node.model?.source === 'string' ? node.model.source : 'unknown',
        title: dabModelTitle(node.model),
      }, dabModelChipText(node.model) ?? dabT('noModel')),
      node.role ? h('span', { className: 'dab-tag' }, node.role) : null,
      node.origin === 'subagent' ? h('span', { className: 'dab-tag' }, dabT('subagent')) : null),
    node.status === 'waiting_user'
      ? h('div', { className: 'dab-wait', style: { whiteSpace: 'normal' } }, node.waitingDetail ?? dabWaitingLabel(node.expectedAction))
      : null,
    node.status === 'failed' && node.error ? h('div', { className: 'dab-alert' }, node.error) : null,
    h('div', { className: 'dab-label' }, dabT('finalAnswer')),
    h('p', { className: 'dab-answer', 'data-empty': hasFinal ? 'false' : 'true', 'data-testid': 'dab-answer' },
      hasFinal ? (more ? preview.text : line) : dabT('noFinal')),
    hasFinal && preview.text.trim() !== line
      ? h('button', { type: 'button', className: 'dab-linkish', 'aria-expanded': more, onClick: () => setMore(value => !value) }, more ? dabT('seeLess') : dabT('seeMore'))
      : null,
    !hasFinal && node.activity
      ? h('div', { className: 'dab-muted' }, `${dabT('activity')} : ${node.activity.turns} ${dabT('turns')} · ${node.activity.steps} ${dabT('steps')}`)
      : null,
    h('div', { className: 'dab-actions' },
      h('button', { type: 'button', className: 'dab-btn', 'aria-pressed': 'false', onClick: () => onOpen(node.id), 'data-testid': 'dab-open' }, `↗ ${dabT('openSession')}`),
      parent ? h('button', { type: 'button', className: 'dab-btn', onClick: () => onOpen(parent.id) }, dabT('openParent')) : null,
      node.status !== 'running' && typeof onDismiss === 'function'
        ? h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', title: dabT('dismissHint'), onClick: () => onDismiss(node.id, !dismissed) }, dismissed ? dabT('undismiss') : dabT('dismiss'))
        : null),
    openError ? h('div', { className: 'dab-alert', role: 'status' }, openError) : null,
    h('dl', { className: 'dab-dl' }, facts),
  )
}
