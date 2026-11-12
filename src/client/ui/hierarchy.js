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
 *
 * GOAL 6: the v2 payload may publish `{ state, reason, source }` per entry
 * instead of a bare string. Both shapes are read. `context` carries the real
 * refusal facts (mode, Stop, empty scope, pause) so a `gated` value can NEVER
 * be painted green while the mandate actually refuses (F2).
 */
const DAB_CONTEXT_GATED_CAPABILITIES = Object.freeze(['delegate', 'reassign', 'priority'])
// A payload may still mark an entry `gated` while carrying a refusal code as
// its reason (contract §1.4 vocabulary). A refusal can never render as available.
const DAB_REFUSAL_REASON_CODES = Object.freeze([
  'mode_off', 'scope_none', 'project_not_selected', 'project_disabled',
  'paused_by_operator', 'stopped_by_operator', 'level_too_low', 'action_disabled',
  'approval_required', 'decision_missing', 'decision_expired',
  'critical_action_not_granted', 'budget_exhausted', 'project_budget_exhausted',
  'integration_unavailable', 'concurrency_limit', 'no_candidate_work',
  'requires_configuration',
])

function dabCapabilityRejection(context, key) {
  if (context === null || context === undefined) return null
  if (!DAB_CONTEXT_GATED_CAPABILITIES.includes(key)) return null
  if (context.stopped === true) return 'stopped_by_operator'
  if (context.mode === 'off') return 'mode_off'
  if (context.paused === true) return 'paused_by_operator'
  if (context.requiresConfiguration === true) return 'requires_configuration'
  if (context.scopeMode === 'none') return 'scope_none'
  return null
}

function dabCapabilityEntry(key, capabilities, reasons, context) {
  const rejection = dabCapabilityRejection(context, key)
  const missing = capabilities === null || capabilities === undefined
  const raw = missing ? undefined : capabilities[key]
  const hostedReasons = reasons !== null && reasons !== undefined && typeof reasons[key] === 'string' && reasons[key] !== ''
    ? reasons[key]
    : null
  const asObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const payloadState = asObject === null ? raw : asObject.state
  const payloadReason = asObject === null
    ? hostedReasons
    : (typeof asObject.reason === 'string' && asObject.reason !== '' ? asObject.reason : hostedReasons)
  const withReason = (labelKey, available, fallbackKey) => ({
    labelKey, available, reasonKey: payloadReason === null ? fallbackKey : null, reason: payloadReason,
  })
  // The real state wins over the payload claim: a refused action is refused.
  if (rejection !== null) return { labelKey: 'capabilityUnavailable', available: false, reasonKey: null, reason: rejection }
  if (payloadState === true || payloadState === 'available') {
    return { labelKey: 'capabilityAvailable', available: true, reasonKey: null, reason: null }
  }
  if (payloadState === 'gated') {
    if (payloadReason !== null && DAB_REFUSAL_REASON_CODES.includes(payloadReason)) {
      return { labelKey: 'capabilityUnavailable', available: false, reasonKey: null, reason: payloadReason }
    }
    return withReason('capabilityGated', true, 'capReasonGated')
  }
  if (payloadState === 'proposal_only') return withReason('capabilityProposalOnly', false, 'capReasonProposalOnly')
  if (payloadState === 'unavailable' || payloadState === false) {
    if (key === 'kanbanWrite') return withReason('capabilityUnavailable', false, 'capReasonReadOnly')
    if (key === 'receiveOrchestratorReports') return withReason('capabilityUnavailable', false, 'capReasonNoChannel')
    if (key === 'delegate') return withReason('capabilityUnavailable', false, 'capReasonDisabled')
    if (key === 'reassign' || key === 'priority') return withReason('capabilityUnavailable', false, 'capReasonProposalOnly')
    return withReason('capabilityUnavailable', false, 'capReasonDisabled')
  }
  if (asObject !== null) {
    // Unknown `state` string in an object entry: unavailable, with the reason.
    return { labelKey: 'capabilityUnavailable', available: false, reasonKey: payloadReason === null ? 'capReasonUnknown' : null, reason: payloadReason }
  }
  return {
    labelKey: 'capabilityUnavailable',
    available: false,
    reasonKey: missing ? 'capReasonSupervisionUnavailable' : 'capReasonUnknown',
    reason: null,
  }
}

/**
 * Normalize the payload capability matrix into display rows. Used by the band's
 * shared body and by the Super Agent inspector, so both never disagree.
 */
function dabEffectiveCapabilities(capabilities, context) {
  const rows = []
  for (const [key, labelKey] of DAB_CAPABILITY_ROWS) {
    const entry = dabCapabilityEntry(key, capabilities, null, context)
    rows.push({ key, labelKey, stateLabelKey: entry.labelKey, available: entry.available, reasonKey: entry.reasonKey, reason: entry.reason })
  }
  return rows
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

function dabCapabilityMatrix(h, capabilities, reasons, context) {
  const rows = reasons === null || reasons === undefined
    ? dabEffectiveCapabilities(capabilities, context)
    : DAB_CAPABILITY_ROWS.map(([key, labelKey]) => {
      const entry = dabCapabilityEntry(key, capabilities, reasons, context)
      return { key, labelKey, stateLabelKey: entry.labelKey, available: entry.available, reasonKey: entry.reasonKey, reason: entry.reason }
    })
  return h('div', { className: 'dab-cap-grid', role: 'list', 'aria-label': dabT('supervisionCapabilities') },
    rows.map(entry => dabCapabilityRow(h, entry, context)))
}

/** Codes the band already states once (mode line), hidden from each cell. */
function dabCapabilityReasonShown(entry, context) {
  if (entry.reason === 'mode_off' && context?.mode === 'off') return false
  if (entry.reason === 'stopped_by_operator' && context?.stopped === true) return false
  return !(entry.reasonKey === null && entry.reason === null)
}

function dabCapabilityRow(h, entry, context) {
  return h('div', {
      key: entry.key, role: 'listitem', className: 'dab-cap-row',
      'data-available': entry.available ? 'true' : 'false',
      'data-capability': entry.key,
      ...(entry.available ? {} : { 'data-refused': 'true' }),
    },
    h('span', { className: 'dab-cap-label' }, dabT(entry.labelKey)),
    h('span', { className: 'dab-cap-value', 'data-available': entry.available ? 'true' : 'false' }, dabT(entry.stateLabelKey)),
    !dabCapabilityReasonShown(entry, context)
      ? null
      : h('span', { className: 'dab-cap-reason', title: entry.reason ?? undefined },
        entry.reason === null ? dabT(entry.reasonKey) : dabReasonText(entry.reason)))
}

/**
 * The supervision LAYER body: capabilities, recommendations, blocks,
 * cross-project dependencies, Task Board availability and delegation limits.
 * Shared by `DabSupervisionBand` (hierarchy view) and the compact
 * `DabSuperOrchestratorBar` (cockpit), so the same real facts are never
 * rendered twice with two different meanings.
 */
function DabSupervisionBody({ workspace, totals, projects, id = DAB_SUPERVISION_BODY_ID, hidden = false, context = null }) {
  const h = React.createElement
  // F4: in Arrêt / stopped, dozens of inapplicable delegation recommendations
  // are noise. The real count stays visible, the list becomes ONE explicit line.
  const modeBlocked = context !== null && context !== undefined && (context.stopped === true || context.mode === 'off')
  const recommendationCount = Array.isArray(workspace.recommendations) ? workspace.recommendations.length : 0
  const blockCount = Array.isArray(workspace.blocks) ? workspace.blocks.length : 0
  const dependencyCount = Number(totals.dependencies) || 0
  // Nothing to show in the three lists: one line says so (and why, when the
  // mode blocks every action) instead of three empty "(0)" sections.
  const quietBody = recommendationCount === 0 && blockCount === 0 && dependencyCount === 0
  return h('div', { className: 'dab-band-body', id, hidden },
    workspace.available ? null : h('div', { className: 'dab-band-notice' }, dabT('supervisionUnavailable')),
    // A Task Board that cannot be read is REPORTED here, not silently missing.
    workspace.taskboard !== null && workspace.taskboard !== undefined && workspace.taskboard.available === false
      ? h('div', { className: 'dab-band-notice', title: String(workspace.taskboard.reason ?? '') },
        `${dabT('taskboardUnavailable')}${workspace.taskboard.reason ? ` — ${dabReasonText(String(workspace.taskboard.reason))}` : ''}`)
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
    quietBody
      ? h('div', { className: 'dab-band-quiet', role: 'note' }, modeBlocked
        ? (context.stopped === true ? dabReasonText('stopped_by_operator') : dabT('supervisionStopNoAction'))
        : dabT('supervisionNothingToReport'))
      : null,
    quietBody ? null : h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionRecommendations')} (${recommendationCount})`),
      modeBlocked
        ? h('div', { className: 'dab-band-notice', 'data-refused': 'true', role: 'note' },
          context.stopped === true ? dabReasonText('stopped_by_operator') : dabT('supervisionStopNoAction'))
        : dabRecommendationList(h, workspace.recommendations, projects)),
    quietBody ? null : h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionBlocks')} (${blockCount})`),
      dabBlockList(h, workspace.blocks)),
    quietBody ? null : h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionDependencies')} (${dependencyCount})`),
      dabDependencyList(h, workspace.crossProjectDependencies, projects)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, dabT('supervisionCapabilities')),
      dabCapabilityMatrix(h, workspace.capabilities, workspace.capabilityReasons, context)))
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
  const body = h(DabSupervisionBody, { workspace, totals, projects, hidden: !open, context: { mode: workspace.mode } })

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

// -------------------------------------------------------------- Super Agent facts
/**
 * Two distinct states, never merged (contract §5): `supervision` is the
 * synthetic host layer, `superagent` is the durable AI session. These helpers
 * derive the AI-session facts with every field guarded, so an old host payload
 * (no `superagent`) renders an explicit "non disponible" instead of crashing.
 */
const DAB_SUPERAGENT_STATE_TEXT = {
  unavailable: 'superStateUnavailable',
  notStarted: 'superStateNotStarted',
  stopped: 'superStateStopped',
  dormant: 'superStateDormant',
  thinking: 'superStateThinking',
  waiting: 'superStateWaiting',
  active: 'superStateActive',
  error: 'superStateError',
}

function dabSuperagentStateLabelKey(stateKey) {
  return DAB_SUPERAGENT_STATE_TEXT[stateKey] ?? 'superStateUnavailable'
}

function dabSuperagentFacts(superagent, mandate, context = {}) {
  const sa = superagent !== null && typeof superagent === 'object' && !Array.isArray(superagent) ? superagent : null
  const identity = sa?.identity !== null && typeof sa?.identity === 'object' ? sa.identity : null
  const session = sa?.session !== null && typeof sa?.session === 'object' ? sa.session : null
  const runtime = sa?.runtime !== null && typeof sa?.runtime === 'object' ? sa.runtime : null
  const plan = sa?.plan !== null && typeof sa?.plan === 'object' ? sa.plan : null
  const decisions = Array.isArray(sa?.decisions) ? sa.decisions.filter(entry => entry !== null && typeof entry === 'object') : []
  const directives = Array.isArray(sa?.directives) ? sa.directives.filter(entry => entry !== null && typeof entry === 'object') : []
  const activity = Array.isArray(sa?.activity) ? sa.activity.filter(entry => entry !== null && typeof entry === 'object') : []
  const pendingDecisions = decisions.filter(entry => entry.status === 'pending')
  const model = identity?.model !== null && typeof identity?.model === 'object' ? identity.model : null
  const stopped = context !== null && context !== undefined && context.stopped === true
  const sessionStatus = typeof session?.active === 'boolean' ? session.active : null
  const identityStatus = typeof identity?.status === 'string' ? identity.status : null
  let stateKey = 'unavailable'
  if (sa !== null) {
    if (sessionStatus === true) {
      stateKey = identityStatus === 'thinking' ? 'thinking'
        : identityStatus === 'waiting_human' ? 'waiting'
          : identityStatus === 'paused' ? 'dormant'
            : identityStatus === 'error' ? 'error'
              : 'active'
    } else if (stopped || identityStatus === 'stopped') {
      stateKey = 'stopped'
    } else {
      stateKey = 'notStarted'
    }
  }
  const stateReason = sa === null
    ? 'hôte : superagent non publié'
    : (runtime?.available === false && typeof runtime?.reason === 'string' ? runtime.reason : (typeof session?.lastError === 'string' ? session.lastError : null))
  const policies = mandate !== null && typeof mandate === 'object' && mandate.projects !== null && typeof mandate.projects === 'object' && !Array.isArray(mandate.projects)
    ? mandate.projects
    : {}
  const policyIds = Object.keys(policies)
  const enabledProjects = policyIds.filter(id => policies[id]?.enabled === true).length
  const totalProjects = policyIds.length
  const lastActivity = activity.length > 0 ? activity[activity.length - 1] : null
  return {
    available: sa !== null,
    identity,
    session,
    sessionActive: sessionStatus === true,
    sessionStatus,
    identityStatus,
    stateKey,
    stateLabelKey: dabSuperagentStateLabelKey(stateKey),
    stateReason,
    sessionId: typeof session?.sessionId === 'string' ? session.sessionId : null,
    generation: Number.isFinite(Number(identity?.generation)) ? Number(identity.generation) : null,
    model,
    modelText: model !== null && typeof model.model === 'string'
      ? `${typeof model.provider === 'string' ? `${model.provider}/` : ''}${model.model}`
      : null,
    fallbackModels: Array.isArray(model?.fallback) ? model.fallback.filter(entry => entry !== null && typeof entry === 'object') : [],
    level: typeof identity?.level === 'string' ? identity.level : (typeof mandate?.level === 'string' ? mandate.level : null),
    enabledProjects,
    totalProjects,
    decisions,
    pendingDecisions,
    pendingCount: pendingDecisions.length,
    pendingApprovals: pendingDecisions.filter(entry => entry.kind === 'approval').length,
    directives: directives.filter(entry => entry.status !== 'revoked'),
    revokedDirectives: directives.filter(entry => entry.status === 'revoked'),
    activity,
    lastActivity,
    activitySummary: typeof lastActivity?.summary === 'string' ? lastActivity.summary : null,
    plan,
    budget: sa?.budget !== null && typeof sa?.budget === 'object' ? sa.budget : null,
    runtime,
    nextWakeAt: Number.isFinite(Number(sa?.nextWakeAt)) ? Number(sa.nextWakeAt) : null,
    lastCycle: sa?.lastCycle !== null && typeof sa?.lastCycle === 'object' ? sa.lastCycle : null,
    memory: sa?.memory !== null && typeof sa?.memory === 'object' ? sa.memory : null,
    paused: context?.paused === true || mandate?.paused === true || identityStatus === 'paused',
  }
}

/** Portfolio rows from the real payload sources, in that precedence order. */
function dabSuperagentPortfolio(host, superagent) {
  const sources = [
    superagent?.portfolio,
    host?.portfolio,
    host?.projects,
    host?.workspaces,
    Array.isArray(superagent?.plan?.objectives)
      ? superagent.plan.objectives.map(objective => ({ id: objective?.projectId, title: objective?.projectId }))
      : null,
  ]
  const seen = new Map()
  const add = raw => {
    if (raw === null || raw === undefined) return
    if (Array.isArray(raw)) { for (const entry of raw) add(entry); return }
    if (typeof raw !== 'object') return
    const id = typeof raw.id === 'string' ? raw.id : (typeof raw.projectId === 'string' ? raw.projectId : (typeof raw.workspaceId === 'string' ? raw.workspaceId : null))
    if (id === null || id === '' || seen.has(id)) return
    seen.set(id, {
      id,
      title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : (typeof raw.name === 'string' && raw.name !== '' ? raw.name : id),
      source: typeof raw.source === 'string' && raw.source !== ''
        ? raw.source
        : (typeof raw.canonicalSource === 'string' && raw.canonicalSource !== '' ? raw.canonicalSource : null),
      raw,
    })
  }
  for (const source of sources) add(source)
  return [...seen.values()]
}

/** Per-project policy rows: toggle, level, priority, budget, inherited model. */
const DAB_AUTONOMY_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4'])

function dabProjectPolicyRows(host, superagent, mandate) {
  const portfolio = dabSuperagentPortfolio(host, superagent)
  const policies = mandate !== null && typeof mandate === 'object' && mandate.projects !== null && typeof mandate.projects === 'object' && !Array.isArray(mandate.projects)
    ? mandate.projects
    : {}
  const selectedWorkspaces = Array.isArray(mandate?.selectedWorkspaces) ? mandate.selectedWorkspaces : []
  const scopeMode = typeof mandate?.scopeMode === 'string' ? mandate.scopeMode : 'none'
  const identityModel = superagent?.identity?.model !== null && typeof superagent?.identity?.model === 'object' ? superagent.identity.model : null
  const known = new Set(portfolio.map(entry => entry.id))
  const extra = Object.keys(policies).filter(id => !known.has(id)).map(id => ({ id, title: id, source: null, raw: null }))
  return [...portfolio, ...extra].map(entry => {
    const policy = policies[entry.id] !== null && typeof policies[entry.id] === 'object' ? policies[entry.id] : {}
    const selected = scopeMode === 'all' || (scopeMode === 'selected' && selectedWorkspaces.includes(entry.id))
    const enabled = policy.enabled === true
    let reason = null
    if (scopeMode === 'none') reason = 'scope_none'
    else if (!selected) reason = 'project_not_selected'
    else if (!enabled) reason = 'project_disabled'
    const model = policy.model !== null && typeof policy.model === 'object' ? policy.model : identityModel
    return {
      id: entry.id,
      title: entry.title,
      source: entry.source,
      enabled,
      selected,
      level: DAB_AUTONOMY_LEVELS.includes(policy.level) ? policy.level : null,
      effectiveLevel: DAB_AUTONOMY_LEVELS.includes(policy.level) ? policy.level : (DAB_AUTONOMY_LEVELS.includes(mandate?.level) ? mandate.level : 'L0'),
      inheritedLevel: DAB_AUTONOMY_LEVELS.includes(mandate?.level) ? mandate.level : 'L0',
      modelInherited: policy.model === null || typeof policy.model !== 'object',
      priority: Number.isFinite(Number(policy.priority)) ? Number(policy.priority) : 5,
      model,
      budget: policy.budget !== null && typeof policy.budget === 'object' ? policy.budget : null,
      reason,
    }
  })
}

const DAB_ACTION_ROWS = Object.freeze([
  ['comment', 'actionComment'],
  ['create_task', 'actionCreateTask'],
  ['update_task', 'actionUpdateTask'],
  ['launch', 'actionLaunch'],
  ['delegate', 'actionDelegate'],
  ['schedule', 'actionSchedule'],
  ['push_branch', 'actionPushBranch'],
  ['open_pr', 'actionOpenPr'],
  ['merge', 'actionMerge'],
  ['protected_branch_write', 'actionProtectedBranch'],
  ['delete_task', 'actionDeleteTask'],
  ['secrets', 'actionSecrets'],
  ['policy_change', 'actionPolicyChange'],
])
const DAB_CRITICAL_ACTIONS = Object.freeze(['merge', 'protected_branch_write', 'delete_task', 'secrets', 'policy_change'])
const DAB_ACTION_MIN_LEVEL = Object.freeze({
  // `launch` is possible from L2, but only after a valid human approval; the
  // helper below therefore returns `approval_required` below L3.
  comment: 'L3', create_task: 'L3', update_task: 'L3', launch: 'L2', delegate: 'L4',
  schedule: 'L3', push_branch: 'L3', open_pr: 'L4', merge: 'L4', protected_branch_write: 'L4',
  delete_task: 'L4', secrets: 'L4', policy_change: 'L4',
})

function dabActionRefusalReason({ action, mandate, context = {} }) {
  const actions = mandate !== null && typeof mandate === 'object' && mandate.actions !== null && typeof mandate.actions === 'object' ? mandate.actions : {}
  const level = typeof context?.level === 'string' ? context.level : (typeof mandate?.level === 'string' ? mandate.level : 'L0')
  if (context?.stopped === true) return 'stopped_by_operator'
  if (context?.mode === 'off') return 'mode_off'
  if (context?.paused === true) return 'paused_by_operator'
  if (context?.requiresConfiguration === true) return 'requires_configuration'
  // The scope is a refusal reason of its own: a granted action in `scopeMode:
  // none` is NOT "Autorisée" (the server would answer scope_none).
  const scopeMode = typeof mandate?.scopeMode === 'string' ? mandate.scopeMode : 'none'
  if (scopeMode === 'none') return 'scope_none'
  const projectId = typeof context?.projectId === 'string' ? context.projectId : null
  if (scopeMode === 'selected' && projectId !== null) {
    const selected = Array.isArray(mandate?.selectedWorkspaces) ? mandate.selectedWorkspaces : []
    if (!selected.includes(projectId)) return 'project_not_selected'
  }
  if (context?.projectEnabled === false) return 'project_disabled'
  const rank = value => DAB_AUTONOMY_LEVELS.indexOf(value)
  const required = DAB_ACTION_MIN_LEVEL[action] ?? 'L4'
  const configuredMode = mandate?.actionModes?.[action]
  const mode = ['deny', 'ask', 'auto'].includes(configuredMode) ? configuredMode : (actions[action] === true ? 'auto' : 'deny')
  if (mode === 'deny') {
    return DAB_CRITICAL_ACTIONS.includes(action) ? 'critical_action_not_granted' : 'action_disabled'
  }
  if (mode === 'ask') {
    if (rank(level) < (DAB_CRITICAL_ACTIONS.includes(action) ? 4 : 2)) return 'level_too_low'
    return 'approval_required'
  }
  if (rank(level) < rank(required)) return 'level_too_low'
  // L2 executes a prepared action only after a human decision.
  if (rank(level) < rank('L3')) return 'approval_required'
  return null
}

/** Whether a real decision is pending (never implied by silence/expiry). */
function dabDecisionIsPending(decision) {
  return decision !== null && typeof decision === 'object' && decision.status === 'pending'
}

function dabDecisionGroups(decisions) {
  const pending = (Array.isArray(decisions) ? decisions : []).filter(dabDecisionIsPending)
  return {
    pending,
    approvals: pending.filter(entry => entry.kind === 'approval'),
    arbitrations: pending.filter(entry => entry.kind !== 'approval'),
  }
}
