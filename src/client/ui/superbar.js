/**
 * Cockpit band: the synthetic supervision layer AND the Super Agent AI session.
 *
 * These are two DISTINCT states (contract §5): the layer is the host policy
 * engine (`synthetic`), the Super Agent is a durable session with its own model,
 * level and decision inbox. The band renders both, never one as the other:
 *
 *   - the layer keeps its mascot, real workspace status and mode, and opens the
 *     shared supervision body (capabilities / recommendations / blocks);
 *   - the AI session has its own chip derived from `state.superagent.session`:
 *     "session non démarrée", "en veille", "réfléchit", "en attente de décision".
 *     `session.active === false` can NEVER render as active.
 *
 * Pause / Stop / Reprendre are siblings of the band toggle, never inside the
 * collapsible body, so they stay reachable on a 360 px bottom sheet.
 *
 * @module dsh-agent-board/client/ui/superbar
 */

const DAB_SUPER_BODY_ID = 'dab-super-body'

/** A short, real status word for the band (never a made-up status). */
function dabSuperStatusLabel(status, facts) {
  if (facts?.stopped === true && facts?.inFlight !== true) {
    return typeof dabT === 'function' ? dabT('supervisionStatusStopped') : 'Stopped (observing)'
  }
  if (typeof dabSupervisionStatusLabel === 'function') return dabSupervisionStatusLabel(status)
  return status === 'active' || status === 'idle' || status === 'blocked' ? status : dabT('statusUnknown')
}

function dabSuperControl(h, props) {
  const { key, action, label, title, disabled, onClick, danger, primary } = props
  return h('button', {
    key,
    type: 'button',
    className: 'dab-super-ctrl',
    'data-action': action,
    'data-danger': danger === true ? 'true' : undefined,
    'data-primary': primary === true ? 'true' : undefined,
    'aria-label': title,
    title,
    disabled: disabled === true,
    onClick,
  }, label)
}

function DabSuperOrchestratorBarImpl({
  workspace, totals, projects, orchestrators: orchestratorList, mode, open, onToggle, onSelect, compact,
  superagent, mandate, capabilities, busy, stopped, onStart, onPause, onStop, onResume, onOpenSuperagent, onOpenDecisions, onOpenProjects,
}) {
  const h = React.createElement
  // Prefer the real, filter-independent orchestrator list from the hierarchy.
  // The fallback keeps the component usable with only the visible projects.
  const orchestrators = Array.isArray(orchestratorList)
    ? orchestratorList
    : (Array.isArray(projects) ? projects.filter(project => project?.orchestrator !== null && project?.orchestrator !== undefined)
      .map(project => ({ projectId: project.id, projectTitle: project.title, orchestrator: project.orchestrator })) : [])
  const visible = orchestrators.slice(0, 6)
  const extra = orchestrators.length - visible.length
  const projectCount = Number(totals?.projects) || 0
  const modeLabel = mode === 'off' ? dabT('modeObserve') : (typeof dabModeLabel === 'function' ? dabModeLabel(mode) : null)
  const miniSize = compact === true ? 22 : 26
  const countText = (count, singular, plural) => (typeof dabCountText === 'function'
    ? dabCountText(count, singular, plural)
    : `${count} ${dabT(count === 1 ? singular : plural)}`)
  const projectText = countText(projectCount, 'projectSingular', 'projectPlural')
  const orchestratorsText = countText(orchestrators.length, 'orchestratorSingular', 'orchestratorPlural')

  // Real Stop state: `stoppedAt` survives a restart, so the fact comes from the
  // host payload, never from the rendered status alone.
  const context = {
    mode,
    stopped: stopped === true,
    paused: mandate?.paused === true,
    scopeMode: typeof mandate?.scopeMode === 'string' ? mandate.scopeMode : null,
    requiresConfiguration: mandate?.requiresConfiguration === true,
  }
  const stoppedByOperator = stopped === true || superagent?.identity?.status === 'stopped'
  const facts = dabSuperagentFacts(superagent, mandate, context)
  const inFlight = Number(facts?.budget?.concurrentAgents) || Number(workspace?.delegation?.inFlight) || 0
  const layerStatusLabel = dabSuperStatusLabel(workspace?.status, { stopped: stoppedByOperator, inFlight: inFlight > 0 })
  const layerTone = stoppedByOperator ? 'waiting' : (workspace?.status === 'active' ? 'running' : workspace?.status === 'blocked' ? 'failed' : 'idle')

  const canPause = facts.sessionActive === true && facts.paused !== true
  const canResume = stoppedByOperator || facts.paused === true
  const canStart = facts.sessionActive === false && !canResume
  // No pinned model means the runtime uses the DSH default model (host contract).
  const modelText = facts.modelText ?? (facts.available ? dabT('superModelHostDefault') : null)
  const totalProjects = facts.totalProjects > 0 ? facts.totalProjects : projectCount
  const needsProjects = facts.available && facts.enabledProjects === 0 && totalProjects > 0
  const levelText = facts.level === null ? dabT('superLevelUnavailable') : dabT('superLevel', { level: facts.level })
  const projectsText = totalProjects > 0
    ? dabT('superProjectsEnabled', { enabled: facts.enabledProjects, total: totalProjects })
    : (facts.available ? dabT('superProjectsUnavailable') : null)
  const activityText = facts.activitySummary !== null
    ? facts.activitySummary
    : (facts.available ? dabT('superNoActivity') : dabT('superUnavailable'))

  const controls = h('span', { className: 'dab-super-controls', role: 'group', 'aria-label': dabT('superControls') },
    // The start action is explicit when no session runs: the band never fakes
    // an active agent (contract §7).
    // Exactly one primary action for the current state: Start, Resume or Pause.
    canResume
      ? dabSuperControl(h, {
        key: 'resume', action: 'resume', label: `▶ ${dabT('resume')}`, title: dabT('superResume'), primary: true, disabled: busy === true, onClick: onResume,
      })
      : null,
    canStart
      ? dabSuperControl(h, {
        key: 'start', action: 'start', label: `▶ ${dabT('superStartShort')}`, title: dabT('superStart'), primary: true,
        disabled: busy === true, onClick: onStart,
      })
      : null,
    canPause
      ? dabSuperControl(h, {
        key: 'pause', action: 'pause', label: `⏸ ${dabT('superPauseShort')}`, title: dabT('superPause'),
        disabled: busy === true, onClick: onPause,
      })
      : null,
    dabSuperControl(h, {
      key: 'stop', action: 'stop', label: `⏹ ${dabT('superStopShort')}`, title: dabT('superStop'), danger: true,
      disabled: busy === true, onClick: onStop,
    }),
    onOpenSuperagent !== undefined && onOpenSuperagent !== null
      ? dabSuperControl(h, {
        key: 'details', action: 'details', label: dabT('superDetailsShort'), title: dabT('superDetailsOpen'),
        onClick: onOpenSuperagent,
      })
      : null)

  return h('div', {
    className: 'dab-super',
    'data-status': workspace?.status ?? 'unknown',
    'data-available': workspace?.available === true ? 'true' : 'false',
    'data-session-state': facts.stateKey,
  },
  h('button', {
    type: 'button',
    className: 'dab-super-main',
    'aria-expanded': open,
    'aria-controls': DAB_SUPER_BODY_ID,
    title: open ? dabT('supervisionCollapse') : dabT('supervisionExpand'),
    onClick: onToggle,
  },
  h('span', { className: 'dab-super-mascot', 'aria-hidden': 'true' },
    dabMascot(h, {
      role: 'super_orchestrator',
      emblem: workspace?.emblem === 'bolt' ? 'bolt' : 'crown',
      name: dabT('superOrchestrator'),
      status: 'unknown',
      size: compact === true ? 34 : 42,
      variant: 'full',
      decorative: true,
    })),
  h('span', { className: 'dab-super-ident' },
    h('span', { className: 'dab-super-title' },
      dabT('superOrchestrator'),
      h('span', { className: 'dab-super-state', 'data-status': workspace?.status ?? 'unknown' },
        h('span', { className: 'dab-dot', 'data-tone': layerTone, 'aria-hidden': 'true' }),
        h('span', { className: 'dab-super-state-text' }, layerStatusLabel)),
      h('span', { className: 'dab-super-layer', title: dabT('supervisionLayer') }, dabT('supervision'))),
    h('span', { className: 'dab-super-sub' },
      projectText,
      h('span', { className: 'dab-super-sep', 'aria-hidden': 'true' }, '·'),
      h('span', { className: 'dab-super-orch-count' }, orchestratorsText),
      modeLabel === null ? null : h('span', { className: 'dab-tag' }, `${dabT('supervisionMode')} : ${modeLabel}`))),
  h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸')),

  // ---- Super Agent AI session: visually distinct from the layer above.
  h('span', {
    className: 'dab-super-ai',
    'data-session-state': facts.stateKey,
    'data-session-active': facts.sessionActive ? 'true' : 'false',
    'data-available': facts.available ? 'true' : 'false',
    role: 'status',
    'aria-label': `${dabT('superAgent')} : ${dabT(facts.stateLabelKey)}`,
    title: facts.stateReason ?? dabT(facts.stateLabelKey),
  },
  h('span', { className: 'dab-super-ai-dot', 'data-tone': facts.sessionActive ? 'running' : facts.stateKey === 'error' ? 'failed' : 'idle', 'aria-hidden': 'true' }),
  h('span', { className: 'dab-super-ai-text' },
    h('span', { className: 'dab-super-ai-name' }, dabT('superAgent')),
    h('span', { className: 'dab-super-ai-sep', 'aria-hidden': 'true' }, ' · '),
    h('span', { className: 'dab-super-ai-state' }, dabT(facts.stateLabelKey))),
  facts.available ? null : h('span', { className: 'dab-super-ai-reason', title: facts.stateReason ?? undefined }, facts.stateReason === null ? dabT('superUnavailableReason') : dabReasonText(facts.stateReason))),

  facts.available
    ? h('span', { className: 'dab-super-facts' },
      h('span', { className: 'dab-super-fact dab-super-model', title: modelText ?? dabT('superModelUnavailable') },
        h('span', { className: 'dab-super-fact-label' }, dabT('model')), modelText ?? dabT('superModelUnavailable')),
      h('span', { className: 'dab-super-fact dab-super-level' }, h('span', { className: 'dab-super-fact-label' }, dabT('superLevelLabel')), levelText),
      projectsText === null ? null : h('span', { className: 'dab-super-fact dab-super-enabled' }, projectsText),
      h('span', { className: 'dab-super-fact dab-super-activity', title: activityText }, activityText),
      facts.pendingCount > 0
        ? h('button', {
          type: 'button',
          className: 'dab-super-decisions',
          'data-count': String(facts.pendingCount),
          'aria-label': dabT('superDecisionsPending', { n: facts.pendingCount }),
          title: dabT('superDecisionsPending', { n: facts.pendingCount }),
          onClick: onOpenDecisions ?? onOpenSuperagent,
        },
        h('span', { className: 'dab-super-decisions-dot', 'aria-hidden': 'true' }),
        dabT('superDecisionsPending', { n: facts.pendingCount }))
        : null)
    : null,

  controls,

  needsProjects
    ? h('button', {
      type: 'button',
      className: 'dab-super-cta',
      'data-cta': 'choose-projects',
      title: dabT('superChooseProjectsHint'),
      onClick: () => (onOpenProjects ?? onOpenSuperagent)?.(),
    }, dabT('superChooseProjects'))
    : null,

  // Mini orchestrator avatars: real agents only. A project without a declared
  // orchestrator is not rendered as a fake avatar.
  orchestrators.length === 0
    ? h('span', { className: 'dab-super-none' }, dabT('superNoOrchestrator'))
    : h('span', { className: 'dab-super-orchs', role: 'group', 'aria-label': orchestratorsText },
      visible.map(entry => h('button', {
        key: entry.orchestrator.id,
        type: 'button',
        className: 'dab-super-orch',
        title: `${entry.orchestrator.name} · ${entry.projectTitle}${entry.orchestrator.source === 'inferred' ? ` · ${dabT('roleInferred')}` : ''}`,
        'aria-label': `${dabT('inspectorTitle')} : ${entry.orchestrator.name} (${entry.projectTitle})`,
        onClick: () => onSelect(entry.orchestrator.id),
      }, dabMascot(h, {
        role: entry.orchestrator.roleId,
        resolvedRole: entry.orchestrator,
        name: entry.orchestrator.name,
        status: entry.orchestrator.status,
        size: miniSize,
        variant: 'compact',
        decorative: true,
      }))),
      extra > 0 ? h('span', { className: 'dab-super-more', title: `${extra}` }, `+${extra}`) : null),

  h(DabSupervisionBody, { workspace, totals, projects: projects ?? [], id: DAB_SUPER_BODY_ID, hidden: !open, context }))
}

/**
 * Memoized on the facts that actually change: the supervision signature, the
 * open state, the AI-session facts and the orchestrator identities. A projection
 * tick that leaves the layer unchanged never re-renders the band.
 */
const DabSuperOrchestratorBar = React.memo(DabSuperOrchestratorBarImpl, (a, b) => (
  a.open === b.open
  && a.compact === b.compact
  && a.mode === b.mode
  && a.busy === b.busy
  && a.onSelect === b.onSelect
  && a.onToggle === b.onToggle
  && a.onStart === b.onStart
  && a.onPause === b.onPause
  && a.onStop === b.onStop
  && a.onResume === b.onResume
  && a.onOpenSuperagent === b.onOpenSuperagent
  && a.onOpenDecisions === b.onOpenDecisions
  && a.onOpenProjects === b.onOpenProjects
  && a.superagent === b.superagent
  && a.mandate === b.mandate
  && a.capabilities === b.capabilities
  && a.stopped === b.stopped
  && a.workspace?.status === b.workspace?.status
  && a.workspace?.available === b.workspace?.available
  && a.workspace?.emblem === b.workspace?.emblem
  && a.workspace?.stopped === b.workspace?.stopped
  && a.totals?.projects === b.totals?.projects
  && a.totals?.agents === b.totals?.agents
  && a.orchestrators === b.orchestrators
  && a.projects === b.projects
))
