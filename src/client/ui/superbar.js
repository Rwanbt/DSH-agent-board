/**
 * Super Orchestrator band of the responsive cockpit.
 *
 * This is a PRESENTATIONAL component over the host supervision payload: it
 * shows the crowned (or bolt) mascot of the workspace layer, the real workspace
 * status and supervision mode, the real supervised-project count, and the mini
 * avatars of the project orchestrators the projection actually found. Clicking a
 * mini avatar inspects that agent; clicking the band expands the SHARED
 * supervision body (capabilities, recommendations, blocks, dependencies) from
 * ui/hierarchy.js. It never creates an agent or an orchestration engine: when no
 * project orchestrator is declared, the band says so instead of inventing one.
 *
 * @module dsh-agent-board/client/ui/superbar
 */

const DAB_SUPER_BODY_ID = 'dab-super-body'

/** A short, real status word for the band (never a made-up status). */
function dabSuperStatusLabel(status) {
  if (typeof dabSupervisionStatusLabel === 'function') return dabSupervisionStatusLabel(status)
  return status === 'active' || status === 'idle' || status === 'blocked' ? status : dabT('statusUnknown')
}

function DabSuperOrchestratorBarImpl({ workspace, totals, projects, orchestrators: orchestratorList, mode, open, onToggle, onSelect, compact }) {
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

  return h('div', { className: 'dab-super', 'data-status': workspace?.status ?? 'unknown', 'data-available': workspace?.available === true ? 'true' : 'false' },
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
          h('span', { className: 'dab-dot', 'data-tone': workspace?.status === 'active' ? 'running' : workspace?.status === 'blocked' ? 'failed' : 'idle', 'aria-hidden': 'true' }),
          dabSuperStatusLabel(workspace?.status))),
      h('span', { className: 'dab-super-sub' },
        projectText,
        h('span', { className: 'dab-super-sep', 'aria-hidden': 'true' }, '·'),
        h('span', { className: 'dab-super-orch-count' }, orchestratorsText),
        modeLabel === null ? null : h('span', { className: 'dab-tag' }, `${dabT('supervisionMode')} : ${modeLabel}`))),
    h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸')),

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

    h(DabSupervisionBody, { workspace, totals, projects: projects ?? [], id: DAB_SUPER_BODY_ID, hidden: !open }))
}

/**
 * Memoized on the facts that actually change: the supervision signature, the
 * open state and the orchestrator identities. A projection tick that leaves the
 * layer unchanged never re-renders the band.
 */
const DabSuperOrchestratorBar = React.memo(DabSuperOrchestratorBarImpl, (a, b) => (
  a.open === b.open
  && a.compact === b.compact
  && a.mode === b.mode
  && a.onSelect === b.onSelect
  && a.onToggle === b.onToggle
  && a.workspace?.status === b.workspace?.status
  && a.workspace?.available === b.workspace?.available
  && a.workspace?.emblem === b.workspace?.emblem
  && a.totals?.projects === b.totals?.projects
  && a.totals?.agents === b.totals?.agents
  && a.orchestrators === b.orchestrators
  && a.projects === b.projects
))
