/**
 * Supervision band and hierarchy view (presentational, pure props).
 *
 * `DabSupervisionBand` renders the host supervision LAYER (not an agent): the
 * super-orchestrator mascot, the real mode, the aggregate counts, the blocking
 * items, the cross-project dependency count, the recommendations (explicitly
 * tagged "proposal — not applied") and the capability matrix, where every
 * unavailable capability shows its reason. It is collapsible, keyboard
 * reachable, and stacks on narrow panels.
 *
 * `DabHierarchyView` renders workspace -> project -> orchestrator -> agents. A
 * project without a DECLARED orchestrator shows an explicit gap: the board never
 * creates an agent. Grouped compact cards reuse `DabAgentCard`; there is no
 * full-width connector line and no raw HTML sink anywhere.
 *
 * @module dsh-agent-board/client/ui/hierarchy
 */

const DAB_SUPERVISION_BODY_ID = 'dab-supervision-body'

/** The seven capabilities of the supervision contract, in display order. */
const DAB_CAPABILITY_ROWS = Object.freeze([
  ['observe', 'capObserve'],
  ['recommend', 'capRecommend'],
  ['delegate', 'capDelegate'],
  ['reassign', 'capReassign'],
  ['priority', 'capPriority'],
  ['receiveOrchestratorReports', 'capReceiveReports'],
  ['kanbanWrite', 'capKanbanWrite'],
])

/**
 * Map one capability value to a visible state and an explicit reason. An absent
 * value is unavailable, never assumed available. The host's own reason (a real
 * code such as `taskboard_write_api_unavailable`) wins over a generic label.
 */
function dabCapabilityEntry(key, capabilities, reasons) {
  const missing = capabilities === null || capabilities === undefined
  const value = missing ? undefined : capabilities[key]
  const hosted = reasons !== null && reasons !== undefined && typeof reasons[key] === 'string' && reasons[key] !== ''
    ? reasons[key]
    : null
  const withReason = (labelKey, available, fallbackKey) => ({ labelKey, available, reasonKey: hosted === null ? fallbackKey : null, reason: hosted })
  if (value === true) return { labelKey: 'capabilityAvailable', available: true, reasonKey: null, reason: null }
  if (value === 'gated') return withReason('capabilityGated', true, 'capReasonGated')
  if (value === 'proposal_only') return withReason('capabilityProposalOnly', false, 'capReasonProposalOnly')
  if (value === 'unavailable' || value === false) {
    if (key === 'kanbanWrite') return withReason('capabilityUnavailable', false, 'capReasonReadOnly')
    if (key === 'receiveOrchestratorReports') return withReason('capabilityUnavailable', false, 'capReasonNoChannel')
    if (key === 'delegate') return withReason('capabilityUnavailable', false, 'capReasonDisabled')
    if (key === 'reassign' || key === 'priority') return withReason('capabilityUnavailable', false, 'capReasonProposalOnly')
    return withReason('capabilityUnavailable', false, 'capReasonDisabled')
  }
  return {
    labelKey: 'capabilityUnavailable',
    available: false,
    reasonKey: missing ? 'capReasonSupervisionUnavailable' : 'capReasonUnknown',
    reason: null,
  }
}

function dabCounter(h, key, tone, value, label) {
  if (!(value > 0)) return null
  return h('span', { key, className: 'dab-counter', title: `${value} ${label}`, 'aria-label': `${value} ${label}` },
    h('span', { className: 'dab-dot', 'data-tone': tone }), h('b', null, value))
}

/** Translated singular/plural label for a count (never "1 projets"). */
function dabCountText(count, singularKey, pluralKey) {
  return typeof dabCountLabel === 'function'
    ? dabCountLabel(count, singularKey, pluralKey)
    : `${Number(count) || 0} ${dabT(Math.abs(Number(count)) === 1 ? singularKey : pluralKey)}`
}

/** Noun only, for counters that render the number themselves. */
function dabCountNounText(count, singularKey, pluralKey) {
  return typeof dabCountNoun === 'function'
    ? dabCountNoun(count, singularKey, pluralKey)
    : dabT(Math.abs(Number(count)) === 1 ? singularKey : pluralKey)
}

function dabModeLabel(mode) {
  if (mode === 'off' || mode === 'supervised' || mode === 'autonomous') return dabT(mode)
  return null
}

function dabWorkspaceStatusChip(h, workspace) {
  return h('span', {
    className: 'dab-sup-status',
    'data-status': workspace.status,
    title: workspace.statusReason === null || workspace.statusReason === undefined
      ? dabSupervisionStatusLabel(workspace.status)
      : `${dabSupervisionStatusLabel(workspace.status)} · ${workspace.statusReason}`,
  }, h('span', { className: 'dab-dot', 'data-tone': 'idle', 'aria-hidden': 'true' }),
  dabSupervisionStatusLabel(workspace.status))
}

function dabBlockList(h, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return h('div', { className: 'dab-muted' }, dabT('supervisionNoBlocks'))
  return h('ul', { className: 'dab-list dab-band-list' }, blocks.slice(0, 20).map(block => h('li', { key: String(block.id) },
    h('span', { className: 'dab-tag', title: block.source ?? '' }, String(block.source ?? '?')),
    h('span', { className: 'dab-grow' }, String(block.reason ?? '')),
    block.taskId ? h('span', { className: 'dab-mono' }, String(block.taskId)) : null,
    block.agentId ? h('span', { className: 'dab-mono' }, String(block.agentId)) : null)))
}

function dabDependencyList(h, dependencies, projects) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) return h('div', { className: 'dab-muted' }, dabT('supervisionNoDependencies'))
  const titleOf = id => projects.find(project => project.id === id)?.title ?? String(id)
  return h('ul', { className: 'dab-list dab-band-list' }, dependencies.slice(0, 20).map(dependency => h('li', { key: String(dependency.id) },
    h('span', { className: 'dab-grow dab-mono' },
      `${titleOf(dependency.fromProjectId)} (${String(dependency.fromTaskId)}) → ${titleOf(dependency.toProjectId)} (${String(dependency.toTaskId)})`))))
}

function dabRecommendationList(h, recommendations, projects) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return h('div', { className: 'dab-muted' }, dabT('supervisionNoRecommendations'))
  const titleOf = id => projects.find(project => project.id === id)?.title ?? String(id)
  return h('ul', { className: 'dab-list dab-band-list' }, recommendations.slice(0, 20).map(recommendation => h('li', { key: String(recommendation.id) },
    // Never an action: a recommendation is a proposal the host would have to
    // apply, and it states so explicitly.
    h('span', { className: 'dab-tag', 'data-tone': 'proposal', title: dabT('recommendationNotApplied') }, dabT('recommendationNotApplied')),
    h('span', { className: 'dab-grow' },
      `${dabRecommendationLabel(recommendation.kind)} · ${titleOf(recommendation.projectId)}`,
      recommendation.reason ? h('span', { className: 'dab-muted' }, ` — ${String(recommendation.reason)}`) : null),
    recommendation.taskId ? h('span', { className: 'dab-mono' }, String(recommendation.taskId)) : null)))
}

function dabCapabilityMatrix(h, capabilities, reasons) {
  return h('div', { className: 'dab-cap-grid', role: 'list', 'aria-label': dabT('supervisionCapabilities') },
    DAB_CAPABILITY_ROWS.map(([key, labelKey]) => {
      const entry = dabCapabilityEntry(key, capabilities, reasons)
      return h('div', {
        key, role: 'listitem', className: 'dab-cap-row',
        'data-available': entry.available ? 'true' : 'false',
        'data-capability': key,
      },
      h('span', { className: 'dab-cap-label' }, dabT(labelKey)),
      h('span', { className: 'dab-cap-value', 'data-available': entry.available ? 'true' : 'false' }, dabT(entry.labelKey)),
      entry.reasonKey === null && entry.reason === null
        ? null
        : h('span', { className: 'dab-cap-reason' }, h('span', { className: 'dab-cap-reason-label' }, `${dabT('supervisionCapabilityReason')} : `), entry.reason ?? dabT(entry.reasonKey)))
    }))
}

/**
 * The supervision band (host supervision layer). Collapsed by default when a
 * single project exists: the caller owns the persisted open state.
 */
function DabSupervisionBand({ workspace, totals, projects, open, onToggle }) {
  const h = React.createElement
  const mode = dabModeLabel(workspace.mode)
  const counters = [
    dabCounter(h, 'projects', 'idle', totals.projects, dabCountNounText(totals.projects, 'projectSingular', 'projectPlural')),
    dabCounter(h, 'agents', 'idle', totals.agents, dabCountNounText(totals.agents, 'agentSingular', 'agentPlural')),
    dabCounter(h, 'running', 'running', totals.running, dabT('running')),
    dabCounter(h, 'waiting', 'waiting', totals.waiting, dabT('waiting')),
    dabCounter(h, 'unread', 'unread', totals.unread, dabCountNounText(totals.unread, 'unreadSingular', 'unreadPlural')),
    dabCounter(h, 'failed', 'failed', totals.failed, dabT('failed')),
    dabCounter(h, 'interrupted', 'waiting', totals.interrupted, dabCountNounText(totals.interrupted, 'interruptedSingular', 'interruptedPlural')),
    dabCounter(h, 'blocked', 'failed', totals.blocked, dabCountNounText(totals.blocked, 'blockedSingular', 'blockedPlural')),
  ].filter(Boolean)
  const header = h('button', {
    type: 'button',
    className: 'dab-band-head',
    'aria-expanded': open,
    'aria-controls': DAB_SUPERVISION_BODY_ID,
    title: open ? dabT('supervisionCollapse') : dabT('supervisionExpand'),
    onClick: onToggle,
  },
  h('span', { className: 'dab-band-mascot', 'aria-hidden': 'true' },
    dabMascot(h, {
      role: 'super_orchestrator', emblem: workspace.emblem, name: dabT('superOrchestrator'),
      // The supervision layer has no agent status: the dot stays neutral and
      // the real layer status is the separate chip below.
      status: 'unknown', size: 34, variant: 'compact', decorative: true,
    })),
  h('span', { className: 'dab-band-ident' },
    h('span', { className: 'dab-band-title' }, dabT('supervision'), workspace.synthetic ? h('span', { className: 'dab-tag' }, dabT('supervisionLayer')) : null),
    h('span', { className: 'dab-band-sub' }, mode === null ? null : h('span', { className: 'dab-tag' }, `${dabT('supervisionMode')} : ${mode}`), dabWorkspaceStatusChip(h, workspace))),
  h('span', { className: 'dab-band-counters' }, counters),
  h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'))

  // The body is ALWAYS rendered (hidden when collapsed): `aria-controls` must
  // never point at a missing element, and the hidden attribute is enough.
  const body = h('div', { className: 'dab-band-body', id: DAB_SUPERVISION_BODY_ID, hidden: !open },
    workspace.available ? null : h('div', { className: 'dab-band-notice' }, dabT('supervisionUnavailable')),
    // A Task Board that cannot be read is REPORTED here, not silently missing.
    workspace.taskboard !== null && workspace.taskboard !== undefined && workspace.taskboard.available === false
      ? h('div', { className: 'dab-band-notice', title: String(workspace.taskboard.reason ?? '') },
        `${dabT('taskboardUnavailable')}${workspace.taskboard.reason ? ` — ${String(workspace.taskboard.reason)}` : ''}`)
      : null,
    h('div', { className: 'dab-muted' }, dabT('supervisionSynthetic')),
    workspace.agent !== null && workspace.agent !== undefined
      ? h('div', { className: 'dab-band-agent' },
        h('span', { className: 'dab-label' }, `${dabT('superOrchestrator')} : `),
        h('span', null, String(workspace.agent.name ?? workspace.agent.id ?? '')),
        workspace.agent.status ? h('span', { className: 'dab-tag' }, dabStatusLabel(workspace.agent.status)) : null)
      : null,
    workspace.delegation === null || workspace.delegation === undefined
      ? null
      : h('div', { className: 'dab-muted' }, dabT('supervisionDelegation', {
        inFlight: Number(workspace.delegation.inFlight) || 0,
        depth: workspace.delegation.depthLimit ?? '?',
        concurrent: workspace.delegation.concurrentLimit ?? '?',
        hourly: workspace.delegation.hourlyLimit ?? '?',
      })),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionRecommendations')} (${Array.isArray(workspace.recommendations) ? workspace.recommendations.length : 0})`),
      dabRecommendationList(h, workspace.recommendations, projects)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionBlocks')} (${Array.isArray(workspace.blocks) ? workspace.blocks.length : 0})`),
      dabBlockList(h, workspace.blocks)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionDependencies')} (${Number(totals.dependencies) || 0})`),
      dabDependencyList(h, workspace.crossProjectDependencies, projects)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, dabT('supervisionCapabilities')),
      dabCapabilityMatrix(h, workspace.capabilities, workspace.capabilityReasons)))

  return h('section', {
    className: 'dab-band',
    'data-available': workspace.available ? 'true' : 'false',
    'data-status': workspace.status,
    'aria-label': dabT('supervision'),
  }, header, body)
}

/** Project head counters: the REAL counts, not the visible-card count. */
function dabProjectCounters(h, counts) {
  return h('span', { className: 'dab-hier-counts' },
    dabCounter(h, 'r', 'running', counts.running, dabT('running')),
    dabCounter(h, 'w', 'waiting', counts.waiting, dabT('waiting')),
    dabCounter(h, 'u', 'unread', counts.unread, dabCountNounText(counts.unread, 'unreadSingular', 'unreadPlural')),
    dabCounter(h, 'f', 'failed', counts.failed, dabT('failed')),
    dabCounter(h, 'i', 'waiting', counts.interrupted, dabCountNounText(counts.interrupted, 'interruptedSingular', 'interruptedPlural')))
}

function dabHierarchyCard(h, entry, ctx, compact) {
  const node = entry.node
  return h(DabAgentCard, {
    key: node.id,
    node,
    depth: entry.depth,
    root: false,
    compact: compact === true,
    selected: ctx.selectedId === node.id,
    arbiter: ctx.arbiter,
    hiddenChildren: entry.hiddenChildren,
    totalChildren: entry.totalChildren,
    collapsed: entry.collapsed,
    expanded: entry.expanded,
    groupActive: entry.groupActive,
    onToggleBranch: ctx.onToggleBranch,
    onRevealHidden: ctx.onRevealHidden,
    nowBucket: ctx.nowBucket,
    role: ctx.roles instanceof Map ? ctx.roles.get(node.id) ?? null : null,
    taskState: node.taskId !== null && node.taskId !== undefined && ctx.taskStates instanceof Map
      ? ctx.taskStates.get(String(node.taskId)) ?? null
      : null,
    groupedProject: true,
  })
}

function DabHierarchyTeam({ team, ctx, compact }) {
  const h = React.createElement
  const rootIncluded = team.agents.some(node => node.id === team.root.id)
  const caption = rootIncluded ? null : h('div', { className: 'dab-hier-team-title' }, dabT('hierarchyTeamOf', { name: team.root.title }))
  return h('div', { className: 'dab-hier-team', 'data-root-id': team.root.id },
    caption,
    team.hidden > 0 ? h('div', { className: 'dab-hier-team-note' }, dabT('hierarchyHiddenByFilter', { n: team.hidden })) : null,
    h('div', { className: 'dab-hier-cards' }, team.entries.map(entry => dabHierarchyCard(h, entry, ctx, compact))))
}

function DabHierarchyProject({ project, ctx, compact, filtersActive }) {
  const h = React.createElement
  const title = project.unassigned ? dabT('unassigned') : project.title
  const orchestrator = project.orchestrator
  // Real counts stay real; when the board view displays fewer (attention policy
  // or filters), the head says both instead of showing one view's number only.
  const shownAgents = project.teams.reduce((sum, team) => sum + team.agents.length, 0)
  const countLabel = typeof projectCountLabel === 'function'
    ? projectCountLabel(project.counts, shownAgents, dabT)
    : `${dabCountText(project.counts.agents, 'agentSingular', 'agentPlural')}${project.counts.agents === shownAgents ? '' : ` · ${dabCountText(shownAgents, 'shownSingular', 'shownPlural')}`}`
  return h('section', { className: 'dab-hier-project', 'data-project-id': project.id, 'aria-label': title },
    h('button', {
      type: 'button', className: 'dab-hier-project-head', 'aria-expanded': !project.folded,
      title: project.folded ? dabT('expand') : dabT('collapse'),
      onClick: () => ctx.onFoldProject(project),
    },
    h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, project.folded ? '▸' : '▾'),
    h('span', { className: 'dab-hier-project-title' }, title),
    h('span', { className: 'dab-project-count' }, countLabel),
    orchestrator === null || orchestrator === undefined
      ? h('span', {
        className: 'dab-hier-orch',
        'data-gap': 'true',
        title: dabT('hierarchyOrchestratorMissingHint'),
      }, h('span', { className: 'dab-gap-dot', 'aria-hidden': 'true' }), dabT('hierarchyOrchestratorMissing'))
      : h('span', { className: 'dab-hier-orch', title: `${dabT('orchestratorLabel')} : ${orchestrator.name}${orchestrator.source === 'inferred' ? ` · ${dabT('roleInferred')}` : ''}` },
        dabMascot(h, { role: orchestrator.roleId, resolvedRole: orchestrator, name: orchestrator.name, status: orchestrator.status, size: 20, variant: 'compact', decorative: true }),
        h('span', null, orchestrator.name),
        orchestrator.source === 'inferred' ? h('span', { className: 'dab-role-inferred' }, dabT('roleInferred')) : null),
    dabProjectCounters(h, project.counts)),
    project.folded ? null : h('div', { className: 'dab-hier-body' },
      project.teams.length === 0
        ? h('div', { className: 'dab-muted' }, filtersActive ? dabT('hierarchyEmpty') : dabT('hierarchyNoAgents'))
        : project.teams.map(team => h(DabHierarchyTeam, { key: team.root.id, team, ctx, compact })),
      project.blocks.length > 0
        ? h('div', { className: 'dab-hier-notes' },
          h('div', { className: 'dab-label' }, `${dabT('supervisionBlocks')} (${project.blocks.length})`),
          dabBlockList(h, project.blocks))
        : null,
      project.crossProjectDependencies.length > 0
        ? h('div', { className: 'dab-hier-notes' },
          h('div', { className: 'dab-label' }, `${dabT('supervisionDependencies')} (${project.crossProjectDependencies.length})`),
          dabDependencyList(h, project.crossProjectDependencies, [] ))
        : null))
}

/**
 * Workspace -> project -> orchestrator -> agents. No full-width connector line,
 * no auto-created agent, no HTML sink.
 */
function DabHierarchyView({ hierarchy, ctx, compact }) {
  const h = React.createElement
  const workspace = hierarchy.workspace
  const mode = dabModeLabel(workspace.mode)
  const filters = hierarchy.filters ?? {}
  const filtersActive = (filters.role ?? null) !== null || (filters.status ?? null) !== null || (filters.taskState ?? null) !== null
  const workspaceHead = h('section', { className: 'dab-hier-ws', 'aria-label': dabT('supervisionWorkspace') },
    h('div', { className: 'dab-hier-ws-head' },
      h('span', { className: 'dab-hier-ws-mascot', 'aria-hidden': 'true' },
        dabMascot(h, { role: 'super_orchestrator', emblem: workspace.emblem, name: dabT('superOrchestrator'), status: 'unknown', size: 40, variant: 'compact', decorative: true })),
      h('div', { className: 'dab-hier-ws-text' },
        h('div', { className: 'dab-hier-ws-title' }, dabT('supervisionWorkspace'),
          h('span', { className: 'dab-tag' }, dabT('supervisionLayer')),
          mode === null ? null : h('span', { className: 'dab-tag' }, `${dabT('supervisionMode')} : ${mode}`),
          dabWorkspaceStatusChip(h, workspace)),
        h('div', { className: 'dab-hier-ws-sub' },
          h('span', null, `${dabCountText(hierarchy.totals.agents, 'agentSingular', 'agentPlural')} · ${dabCountText(hierarchy.totals.projects, 'projectSingular', 'projectPlural')}`),
          h('span', { className: 'dab-hier-counts' },
            dabCounter(h, 'r', 'running', hierarchy.totals.running, dabT('running')),
            dabCounter(h, 'w', 'waiting', hierarchy.totals.waiting, dabT('waiting')),
            dabCounter(h, 'u', 'unread', hierarchy.totals.unread, dabCountNounText(hierarchy.totals.unread, 'unreadSingular', 'unreadPlural')),
            dabCounter(h, 'f', 'failed', hierarchy.totals.failed, dabT('failed')))))),
    workspace.available ? null : h('div', { className: 'dab-band-notice' }, dabT('supervisionUnavailable')))

  const empty = hierarchy.projects.length === 0
    ? h('div', { className: 'dab-empty' }, filtersActive ? dabT('hierarchyEmpty') : dabT('hierarchyNoAgents'))
    : null

  return h('div', { className: 'dab-hier', 'data-compact': compact ? 'true' : 'false' },
    workspaceHead,
    empty,
    empty === null
      ? h('div', { className: 'dab-hier-projects' }, hierarchy.projects.map(project => h(DabHierarchyProject, { key: project.id, project, ctx, compact, filtersActive })))
      : null)
}
