/**
 * AgentCard: one compact card per agent. Pointer and keyboard go through the
 * shared click arbiter (single click = inspect, double click / Enter = open).
 * The branch toggle and the quick "open" button stop propagation so they never
 * trigger inspection or acknowledgement.
 *
 * Identity is expressed by the official mascot (`DabAgentAvatar`, from
 * ui/avatar.js) and the resolved DECLARED role; status stays on the existing
 * mark and dot, never on the role colour. The real activity (turn/step counters
 * the runtime reports) is shown as text when present: there is deliberately no
 * bar or percentage, because no reliable completion measure exists.
 *
 * @module dsh-agent-board/client/ui/card
 */

/**
 * Render the mascot when the avatar module is part of the bundle. `typeof` on an
 * undeclared global is safe, so a partial build never throws at render time.
 */
function dabMascot(h, props) {
  return typeof DabAgentAvatar === 'function' ? h(DabAgentAvatar, props) : null
}

function dabCardRole(node, resolved) {
  if (resolved !== null && resolved !== undefined) return resolved
  if (typeof dabResolveAgentRole === 'function') return dabResolveAgentRole(node.role)
  return { roleId: null, roleLabel: null, family: null, source: 'generic', raw: node.role ?? null }
}

function dabCardSignature(props) {
  const node = props.node
  const role = dabCardRole(node, props.role)
  return [
    node.id, node.status, node.seen, node.title, node.role, node.updatedAt, node.expectedAction, node.waitingDetail,
    node.model?.model, node.model?.provider, node.model?.reasoningEffort, node.model?.source, node.recentlyFinished,
    node.taskId, node.error, node.orphan, node.parentCycle, node.parentReason, node.interrupted, node.providerUnavailable,
    node.projectId, node.projectTitle, node.origin,
    node.activity?.turns, node.activity?.steps,
    role?.roleId, role?.roleLabel, role?.family, role?.source,
    props.selected, props.root, props.hiddenChildren, props.totalChildren, props.collapsed, props.expanded, props.groupActive,
    props.depth, props.compact, props.nowBucket, props.taskState, props.groupedProject,
  ].join('|')
}

function DabAgentCardImpl(props) {
  const { node, selected, root, arbiter, onToggleBranch, onRevealHidden, hiddenChildren, totalChildren, collapsed, expanded, groupActive, depth, compact, taskState, groupedProject } = props
  const h = React.createElement
  const role = dabCardRole(node, props.role)
  const roleText = role.roleLabel ?? (typeof node.role === 'string' && node.role !== '' ? node.role : null)
  const genericRole = role.roleId === null || role.roleId === undefined
  const familyText = typeof dabFamilyLabel === 'function' ? dabFamilyLabel(role.family) : null
  const taskLabel = typeof dabTaskStateLabel === 'function' && typeof taskState === 'string' ? dabTaskStateLabel(taskState) : null
  const modelLabel = dabModelText(node.model)
  const age = dabFormatAge(node.updatedAt)
  const statusText = dabStatusLabel(node.status)
  const projectText = node.projectId === 'unassigned' ? dabT('unassigned') : (typeof node.projectTitle === 'string' ? node.projectTitle : null)
  const activity = node.activity !== null && node.activity !== undefined && (Number(node.activity.turns) > 0 || Number(node.activity.steps) > 0)
    ? { turns: Number(node.activity.turns) || 0, steps: Number(node.activity.steps) || 0 }
    : null
  const calm = !(node.status === 'running' || node.status === 'recovering' || node.status === 'waiting_user' || node.status === 'finished_unread' || node.status === 'interrupted' || node.status === 'provider_unavailable' || (node.status === 'failed' && node.seen !== true))
  const label = [node.title, statusText, roleText, projectText, taskLabel, groupActive ? dabT('groupActive') : null].filter(Boolean).join(' — ')

  const stop = event => { event.stopPropagation() }
  const mascot = dabMascot(h, {
    role: node.role,
    name: node.title,
    status: node.status,
    // The card renders its own linked-task chip in the meta row; the mascot
    // stays identity + status only (no duplicated task chip).
    taskState: null,
    size: compact ? 20 : 30,
    variant: compact ? 'compact' : 'full',
    decorative: true,
  })
  const top = h(
    'div', { className: 'dab-card-top', key: 'top' },
    h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', role: 'img', 'aria-label': statusText, title: statusText }),
    h('span', { className: 'dab-name', title: node.title }, node.title),
    h('button', {
      type: 'button', className: 'dab-icon-btn dab-quick', title: dabT('openSession'), 'aria-label': `${dabT('openSession')} : ${node.title}`,
      onClick: event => { stop(event); arbiter.open(node.id) },
      onDoubleClick: stop, onKeyDown: stop,
    }, '↗'),
  )
  const meta = []
  // Row 1 = identity: role (and the model chip for root cards). The family is
  // identity context too, but it is already part of the role tooltip and of the
  // inspector; keeping it out of the row leaves room for the model.
  // Role identity. A declared role that resolves to nothing gets ONE neutral
  // chip (never a guessed role, never a role colour); the raw declared string
  // stays in the tooltip. Compact cards only keep the raw name when present.
  if (genericRole) {
    if (compact !== true) {
      meta.push(h('span', {
        key: 'role',
        className: 'dab-role-chip',
        'data-resolution': 'generic',
        'data-role': 'generic',
        title: [dabT('role'), dabT('noDeclaredRole'), dabT('genericIdentity'),
          role.raw !== null && role.raw !== undefined && role.raw !== '' ? `(${role.raw})` : null]
          .filter(Boolean).join(' · '),
      }, dabT('noDeclaredRole')))
    } else if (roleText !== null) {
      meta.push(h('span', {
        key: 'role',
        className: 'dab-role-chip',
        'data-resolution': 'generic',
        'data-role': 'generic',
        title: [dabT('role'), roleText, dabT('genericIdentity')].filter(Boolean).join(' · '),
      }, roleText))
    }
  } else if (roleText !== null) {
    meta.push(h('span', {
      key: 'role',
      className: 'dab-role-chip',
      'data-resolution': role.source ?? 'generic',
      'data-role': role.roleId ?? 'generic',
      title: [dabT('role'), roleText, familyText, role.raw !== null && role.raw !== undefined && role.raw !== roleText ? `(${role.raw})` : null]
        .filter(Boolean).join(' · '),
    }, roleText))
  }
  // Compact model chip: the card's provider/model fact, never a guess. It shares
  // the identity row with the role, so the work facts keep their own row.
  if (root || roleText === null) {
    meta.push(h('span', {
      key: 'model',
      className: 'dab-chip',
      'data-source': typeof node.model?.source === 'string' ? node.model.source : 'unknown',
      title: dabModelTitle(node.model),
    }, modelLabel ?? dabT('noModel')))
  }
  // Row 2 = work facts: the project context (only when the card is not already
  // grouped inside that project), the linked task, its Task Board state and the
  // age. The row may wrap; it is never clipped mid-line.
  const work = []
  // The project is already the section title when the card is grouped inside its
  // project (tree, compact grid, hierarchy): the chip would only steal width
  // from the task/age facts. It stays in the aria-label and the inspector.
  if (projectText !== null && groupedProject !== true) {
    work.push(h('span', { key: 'project', className: 'dab-project-line', title: `${dabT('project')} : ${projectText}` }, projectText))
  }
  if (node.taskId) work.push(h('span', { key: 'task', className: 'dab-mono', title: `${dabT('task')} ${node.taskId}` }, node.taskId))
  // The linked Task Board state is a SEPARATE vocabulary from the agent status.
  // Rendered only when the integration really reported the state.
  if (taskLabel !== null) {
    work.push(h('span', {
      key: 'taskState',
      className: 'dab-task-chip',
      'data-state': taskState,
      'data-tone': typeof AGENT_TASK_STATE_TONE === 'object' ? AGENT_TASK_STATE_TONE[taskState] ?? 'idle' : 'idle',
      title: `${dabT('taskStateTitle')} — ${taskLabel}`,
    }, h('span', { className: 'dab-task-dot', 'aria-hidden': 'true' }), taskLabel))
  }
  if (age !== '') work.push(h('span', { key: 'age', title: node.updatedAt ? new Date(node.updatedAt).toLocaleString() : '' }, age))
  if (node.orphan) work.push(h('span', { key: 'orphan', title: dabT('orphan') }, `⚠ ${dabT('orphan')}`))
  if (node.parentCycle) work.push(h('span', { key: 'cycle', title: dabT('cycle') }, `⚠ ${dabT('cycle')}`))
  if (node.parentContested) work.push(h('span', { key: 'contested', title: `${dabT('cycle')} · ${(node.parentCandidates ?? []).join(', ')}` }, `⚠ ${dabT('contest')}`))
  const withSeparators = items => {
    const out = []
    items.forEach((item, index) => {
      if (index > 0) out.push(h('span', { key: `sep-${index}`, className: 'dab-sep', 'aria-hidden': 'true' }))
      out.push(item)
    })
    return out
  }
  const metaWithSeps = withSeparators(meta)
  const workWithSeps = withSeparators(work)

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
    }, collapsed ? `▸ ${totalChildren}` : `▾ ${totalChildren}`))
  } else if (groupActive) {
    foot.push(h('span', { key: 'grp', className: 'dab-muted' }, h('span', { className: 'dab-group-ring', 'aria-hidden': 'true' }), dabT('groupActive')))
  }
  // REAL activity only: the runtime counters, never a percentage or a bar.
  if (activity !== null) {
    const activityText = typeof dabTurnStepLabel === 'function'
      ? dabTurnStepLabel(activity.turns, activity.steps)
      : `${activity.turns} ${dabT('turns')} · ${activity.steps} ${dabT('steps')}`
    foot.push(h('span', {
      key: 'activity',
      className: 'dab-activity',
      title: dabT('activityReal', { activity: activityText }),
    }, activityText))
  }

  const ident = [top]
  if (metaWithSeps.length > 0) ident.push(h('div', { className: 'dab-meta', key: 'meta' }, metaWithSeps))
  if (workWithSeps.length > 0) ident.push(h('div', { className: 'dab-meta dab-meta-work', key: 'work' }, workWithSeps))
  if (node.status === 'waiting_user') {
    ident.push(h('div', { className: 'dab-wait', key: 'wait', title: node.waitingDetail ?? '' }, node.waitingDetail ?? dabWaitingLabel(node.expectedAction)))
  }
  if (node.status === 'failed' && node.seen !== true) {
    ident.push(h('div', { className: 'dab-err', key: 'err', title: node.error ?? '' }, node.error ?? dabStatusLabel('failed')))
  }
  if (foot.length > 0) ident.push(h('div', { className: 'dab-card-foot', key: 'foot' }, foot))

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
    'data-role': role.roleId ?? 'generic',
    'data-role-resolution': role.source ?? 'generic',
    'data-task-state': taskLabel === null ? undefined : taskState,
    // Non-status view hint: the turn really completed inside the recent window.
    'data-recent': node.recentlyFinished === true ? 'true' : 'false',
    'data-depth': String(depth ?? 0),
    title: dabT('keyboardHint'),
    onClick: event => arbiter.click(node.id, event.detail),
    onDoubleClick: event => { event.preventDefault(); arbiter.doubleClick(node.id) },
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (arbiter.key(node.id, event.key)) event.preventDefault()
    },
  },
  mascot === null
    ? ident
    : h('div', { className: 'dab-card-main' },
      h('span', { className: 'dab-card-mascot', 'aria-hidden': 'true' }, mascot),
      h('div', { className: 'dab-card-ident' }, ident)),
  )
}

const DabAgentCard = React.memo(DabAgentCardImpl, (a, b) => dabCardSignature(a) === dabCardSignature(b) && a.arbiter === b.arbiter)
