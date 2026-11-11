/**
 * Supervision hierarchy builder (pure) tests. The fixtures are synthetic (the
 * same shape as the client projection) and never live data.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProjection } from '../src/supervisor/projection.js'
import { aggregateSubtrees, buildBoardView } from '../src/board/view.js'
import {
  GENERIC_ROLE_FILTER,
  buildHierarchyView,
  countLabelFor,
  filterBoardViewByAgent,
  normalizeHierarchyFilters,
  pluralKeyFor,
  projectCountLabel,
  resolveNodeRoles,
  taskStateIndex,
} from '../src/board/hierarchy.js'
import { NOW, photoScenario, row } from './fixtures/sessions.js'

function build(viewOptions = {}) {
  const scenario = photoScenario()
  const projection = buildProjection({ ...scenario, now: NOW })
  const view = buildBoardView(projection, { now: NOW, ...viewOptions })
  return { projection, view }
}

/** Two real projects plus an unassigned agent, with declared roles and tasks. */
function roleScenario() {
  const byId = {}
  const ids = []
  const add = entry => { byId[entry.id] = entry; ids.push(entry.id) }
  add(row('alpha-orch', {
    displayTitle: 'Alpha orchestrator', running: true, cwd: 'D:\\App\\alpha', updatedAt: NOW - 1000,
    values: { agentTeam: { members: [{ id: 'alpha-orch', name: 'orchestrator', role: 'teammate' }] } },
  }))
  add(row('alpha-dev', {
    displayTitle: 'Implement the card', parentId: 'alpha-orch', origin: 'subagent', running: true,
    cwd: 'D:\\App\\alpha', updatedAt: NOW - 2000,
    values: { agentTeam: { members: [{ id: 'alpha-dev', name: 'dev', role: 'teammate' }] }, subagent: { label: 'Implement the card' } },
  }))
  add(row('alpha-ui', { displayTitle: 'Polish the UI', cwd: 'D:\\App\\alpha', updatedAt: NOW - 3000 }))
  add(row('beta-lead', {
    displayTitle: 'Beta lead', cwd: 'D:\\App\\beta', updatedAt: NOW - 4000,
    values: {
      agentTeam: { members: [{ id: 'beta-lead', name: 'lead', role: 'teammate' }] },
      userQuestions: { active: [{ question: 'Which scope?' }], settled: [] },
    },
  }))
  add(row('beta-scout', {
    displayTitle: 'Scout report', cwd: 'D:\\App\\beta', updatedAt: NOW - 5000,
    values: { agentTeam: { members: [{ id: 'beta-scout', name: 'scout', role: 'teammate' }] } },
  }))
  add(row('beta-plain', {
    displayTitle: 'Plain idle', cwd: 'D:\\App\\beta', updatedAt: NOW - 6000,
    values: { mobilePushLifecycle: null },
  }))
  add(row('beta-stop', {
    displayTitle: 'Stopped launch', cwd: 'D:\\App\\beta', updatedAt: NOW - 7000,
    values: { mobilePushLifecycle: null },
  }))
  add(row('nowhere', { displayTitle: 'Unknown directory', running: true, cwd: 'E:\\Nowhere' }))

  const scenario = {
    list: { phase: 'ready', ids, byId, projectionsBySession: {} },
    statusMap: new Map(ids.map(id => [id, { running: byId[id].running === true, completionUnread: false }])),
    hostState: {
      turnEnd: {
        'alpha-ui': { at: NOW - 3000, kind: 'completed' },
        'beta-scout': { at: NOW - 5000, kind: 'completed' },
      },
      acks: {},
      previews: {},
      assignments: [
        { id: 'as-alpha', sessionId: 'alpha-dev', status: 'running', taskId: 'task-a' },
        { id: 'as-scout', sessionId: 'beta-scout', status: 'done', taskId: 'task-b' },
        { id: 'as-stop', sessionId: 'beta-stop', status: 'interrupted', endedAt: NOW - 7000 },
      ],
    },
    workspaces: {
      items: [
        { workspaceId: 'w-alpha', title: 'Alpha', path: 'D:\\App\\alpha', sessionIds: ['alpha-orch', 'alpha-dev', 'alpha-ui'] },
        { workspaceId: 'w-beta', title: 'Beta', path: 'D:\\App\\beta', sessionIds: ['beta-lead', 'beta-scout', 'beta-plain', 'beta-stop'] },
      ],
      archivedSessionIds: [],
    },
  }
  return scenario
}

function supervisionPayload() {
  return {
    version: 1,
    at: NOW,
    workspace: {
      id: 'workspace:supervision',
      synthetic: true,
      role: 'super_orchestrator',
      emblem: 'crown',
      mode: 'supervised',
      status: 'active',
      reason: 'mode_supervised',
      counts: {},
      delegation: { depthLimit: 1, concurrentLimit: 2, hourlyLimit: 6, usedThisHour: 1, inFlight: 1 },
    },
    projects: [],
    blocks: [
      { id: 'b-alpha', kind: 'agent_failed', projectId: 'ws:w-alpha', agentId: 'alpha-ui', reason: 'turn failed', at: NOW - 100, source: 'projection' },
      { id: 'b-beta', kind: 'task_blocked', projectId: 'ws:w-beta', taskId: 'task-b', reason: 'unsatisfied prerequisite', at: NOW - 200, source: 'taskboard' },
    ],
    crossProjectDependencies: [
      { id: 'dep-1', fromTaskId: 'task-a', fromProjectId: 'ws:w-alpha', toTaskId: 'task-b', toProjectId: 'ws:w-beta', source: 'taskboard' },
    ],
    recommendations: [
      { id: 'rec-1', kind: 'unblock', taskId: 'task-b', projectId: 'ws:w-beta', reason: 'prerequisite finished', evidence: ['task-a done'], status: 'proposed', applies: false },
    ],
    capabilities: {
      observe: true,
      recommend: true,
      delegate: 'gated',
      reassign: 'proposal_only',
      priority: 'proposal_only',
      receiveOrchestratorReports: 'unavailable',
      kanbanWrite: 'unavailable',
    },
    taskboard: {
      available: true,
      reason: null,
      tasks: [
        { id: 'task-a', status: 'done' },
        { id: 'task-b', status: 'blocked' },
        { id: 'task-c', status: 'in_progress' },
      ],
      capabilities: { read: true, writeKanban: false },
    },
  }
}

function roleHierarchy(options = {}) {
  const scenario = roleScenario()
  const projection = buildProjection({ ...scenario, now: NOW })
  const view = buildBoardView(projection, { now: NOW, filter: options.filter ?? 'all', ...options.viewOptions })
  const supervision = options.supervision === undefined ? supervisionPayload() : options.supervision
  const hierarchy = buildHierarchyView(projection, view, supervision, options.options)
  return { projection, view, hierarchy }
}

function agentIds(hierarchy) {
  return hierarchy.projects.flatMap(project => project.teams.flatMap(team => team.agents.map(node => node.id)))
}

test('one project: workspace level, real counts, missing orchestrator is an honest null', () => {
  const { projection, view } = build()
  const hierarchy = buildHierarchyView(projection, view, null)
  assert.equal(hierarchy.workspace.role, 'super_orchestrator')
  assert.equal(hierarchy.workspace.synthetic, true)
  assert.equal(hierarchy.workspace.emblem, 'crown')
  assert.equal(hierarchy.workspace.agent, null, 'no real super-orchestrator agent is fabricated')
  assert.equal(hierarchy.workspace.mode, null, 'no mode is invented without the host payload')
  // The Ravum project declares no orchestrator: the slot stays null.
  const ravum = hierarchy.projects.find(project => project.id === 'ws:w-ravum')
  assert.ok(ravum, 'project present')
  assert.equal(ravum.orchestrator, null)
  // Teams reuse the board view trees in order.
  assert.deepEqual(ravum.teams.map(team => team.root.id), view.projects.find(project => project.id === 'ws:w-ravum').trees.map(tree => tree.node.id))
  // Counts are real: every node of the project, visible or not.
  const realNodes = projection.nodes.filter(node => node.projectId === 'ws:w-ravum')
  assert.equal(ravum.counts.agents, realNodes.length)
  assert.equal(hierarchy.totals.agents, projection.nodes.length)
  assert.equal(hierarchy.totals.projects, projection.projects.length)
  // No fake node: every rendered agent exists in the projection.
  assert.ok(agentIds(hierarchy).every(id => projection.byId.has(id)))
})

test('many projects: stable order, orchestrators from DECLARED roles only, blocks and cross-project dependencies', () => {
  const first = roleHierarchy()
  const second = roleHierarchy()
  const hierarchy = first.hierarchy
  assert.deepEqual(hierarchy.projects.map(project => project.id), first.view.projects.map(project => project.id), 'board view order is kept')
  assert.deepEqual(
    hierarchy.projects.map(project => project.teams.map(team => team.agents.map(node => node.id))),
    second.hierarchy.projects.map(project => project.teams.map(team => team.agents.map(node => node.id))),
    'stable order across builds',
  )
  const alpha = hierarchy.projects.find(project => project.id === 'ws:w-alpha')
  const beta = hierarchy.projects.find(project => project.id === 'ws:w-beta')
  const unassigned = hierarchy.projects.find(project => project.id === 'unassigned')
  assert.equal(alpha.orchestrator?.id, 'alpha-orch', 'explicit orchestrator role')
  assert.equal(beta.orchestrator?.id, 'beta-lead', 'declared alias "lead" resolves to orchestrator')
  assert.equal(unassigned.orchestrator, null, 'no declared orchestrator: gap, never a fake node')
  assert.deepEqual(alpha.counts, { agents: 3, running: 2, waiting: 0, unread: 1, failed: 0, interrupted: 0 })
  assert.deepEqual(beta.counts, { agents: 4, running: 0, waiting: 1, unread: 1, failed: 0, interrupted: 1 })
  assert.equal(hierarchy.totals.agents, 8)
  assert.equal(alpha.blocks.map(block => block.id).join(','), 'b-alpha')
  assert.equal(beta.blocks.map(block => block.id).join(','), 'b-beta')
  assert.equal(alpha.crossProjectDependencies[0].id, 'dep-1')
  assert.equal(beta.crossProjectDependencies[0].id, 'dep-1')
  assert.equal(hierarchy.workspace.blocks.length, 2)
  assert.equal(hierarchy.workspace.counts.blocked, 2)
  assert.equal(hierarchy.workspace.counts.dependencies, 1)
  assert.equal(hierarchy.workspace.counts.projects, 3)
  assert.equal(hierarchy.workspace.crossProjectDependencies.length, 1)
  assert.equal(hierarchy.workspace.capabilityReasons, null)
  assert.equal(hierarchy.workspace.recommendations[0].status, 'proposed')
  assert.equal(hierarchy.workspace.recommendations[0].applies, false)
})

test('host capability reasons are preserved verbatim; an absent supervision keeps them null', () => {
  const payload = supervisionPayload()
  payload.capabilityReasons = { kanbanWrite: 'taskboard_write_api_unavailable' }
  const withReasons = roleHierarchy({ supervision: payload })
  assert.deepEqual(withReasons.hierarchy.workspace.capabilityReasons, { kanbanWrite: 'taskboard_write_api_unavailable' })
  const without = roleHierarchy({ supervision: null })
  assert.equal(without.hierarchy.workspace.capabilityReasons, null)
  assert.equal(withReasons.hierarchy.workspace.capabilities.kanbanWrite, 'unavailable')
})

test('supervision null: structure and counts stay real, capabilities are unavailable (never faked)', () => {
  const scenario = roleScenario()
  const projection = buildProjection({ ...scenario, now: NOW })
  const view = buildBoardView(projection, { now: NOW, filter: 'all' })
  const hierarchy = buildHierarchyView(projection, view, null, { mode: 'supervised' })
  assert.equal(hierarchy.workspace.available, false)
  assert.equal(hierarchy.workspace.capabilities, null)
  assert.equal(hierarchy.workspace.status, 'unknown')
  assert.equal(hierarchy.workspace.statusReason, 'supervision_unavailable')
  assert.equal(hierarchy.workspace.mode, 'supervised', 'the host mode is still displayed')
  assert.deepEqual(hierarchy.workspace.blocks, [])
  assert.deepEqual(hierarchy.workspace.recommendations, [])
  assert.equal(hierarchy.workspace.taskboard, null)
  assert.equal(hierarchy.totals.supervisionAvailable, false)
  assert.equal(hierarchy.totals.taskStateAvailable, false)
  assert.equal(hierarchy.workspace.counts.agents, 8, 'counts come from the projection')
  // Orchestrators are still projected: they are projection facts, not supervision ones.
  assert.equal(hierarchy.projects.find(project => project.id === 'ws:w-alpha').orchestrator?.id, 'alpha-orch')
})

test('unknown declared roles stay generic; the resolver is injectable and cached per declared role', () => {
  const scenario = roleScenario()
  const projection = buildProjection({ ...scenario, now: NOW })
  const view = buildBoardView(projection, { now: NOW, filter: 'all' })
  const hierarchy = buildHierarchyView(projection, view, supervisionPayload())
  assert.equal(hierarchy.roles.get('alpha-ui').roleId, null)
  assert.equal(hierarchy.roles.get('alpha-ui').source, 'generic')
  assert.equal(hierarchy.roles.get('alpha-dev').roleId, 'worker', 'alias "dev" -> worker')
  assert.equal(hierarchy.roles.get('alpha-dev').source, 'alias')
  assert.equal(hierarchy.roles.get('beta-scout').roleId, 'researcher')
  assert.equal(hierarchy.roles.size, projection.nodes.length, 'one resolved role per node')

  const seen = []
  const stub = value => {
    seen.push(value)
    return value === 'dev'
      ? { roleId: 'verifier', source: 'explicit', raw: value, role: { label: 'Stubbed', family: 'validation' } }
      : { roleId: null, source: 'generic', raw: value, role: null }
  }
  const stubbed = buildHierarchyView(projection, view, supervisionPayload(), { resolveRole: stub })
  assert.equal(stubbed.roles.get('alpha-dev').roleId, 'verifier', 'injected resolver wins')
  assert.equal(stubbed.roles.get('alpha-dev').roleLabel, 'Stubbed')
  assert.equal(stubbed.projects.find(project => project.id === 'ws:w-alpha').orchestrator, null, 'stub no longer declares an orchestrator')
  // Called once per DISTINCT declared role, not once per node.
  assert.equal(new Set(seen).size, seen.length, 'resolver calls are cached per declared role')
  assert.ok(seen.length < projection.nodes.length)
  assert.deepEqual([...new Set(seen)].sort(), ['dev', 'lead', 'orchestrator', 'scout'])
})

test('role, status and Task Board state filters narrow the rendered teams without touching real counts', () => {
  const byRole = roleHierarchy({ options: { filters: { role: 'orchestrator' } } })
  assert.deepEqual(agentIds(byRole.hierarchy).sort(), ['alpha-orch', 'beta-lead'])
  assert.equal(byRole.hierarchy.projects.find(project => project.id === 'ws:w-alpha').counts.agents, 3, 'counts stay real')
  assert.equal(byRole.hierarchy.filters.role, 'orchestrator')

  const generic = roleHierarchy({ options: { filters: { role: GENERIC_ROLE_FILTER } } })
  assert.deepEqual(agentIds(generic.hierarchy).sort(), ['alpha-ui', 'beta-plain', 'beta-stop', 'nowhere'])
  assert.equal(generic.hierarchy.projects.find(project => project.id === 'ws:w-beta').orchestrator?.id, 'beta-lead', 'the orchestrator slot is identity, not an agent filter')

  const running = roleHierarchy({ options: { filters: { status: 'running' } } })
  assert.deepEqual(agentIds(running.hierarchy).sort(), ['alpha-dev', 'alpha-orch', 'nowhere'])

  const blockedTask = roleHierarchy({ options: { filters: { taskState: 'blocked' } } })
  assert.deepEqual(agentIds(blockedTask.hierarchy), ['beta-scout'])
  assert.equal(blockedTask.hierarchy.filters.taskStateAvailable, true)

  // The integration is absent: the task filter is reported unavailable and NOT
  // applied silently as "matches nothing".
  const unavailable = roleHierarchy({ supervision: null, options: { filters: { taskState: 'blocked' } } })
  assert.equal(unavailable.hierarchy.filters.taskStateAvailable, false)
  assert.equal(unavailable.hierarchy.filters.taskState, null)
  assert.equal(agentIds(unavailable.hierarchy).length, 8, 'no agent is hidden by an unavailable integration')
})

test('filterBoardViewByAgent prunes explicit non-matches and keeps the ancestor chain', () => {
  const scenario = roleScenario()
  const projection = buildProjection({ ...scenario, now: NOW })
  const view = buildBoardView(projection, { now: NOW, filter: 'all' })
  const untouched = filterBoardViewByAgent(view, {}, { projection })
  assert.equal(untouched, view, 'no filter -> same object, no rebuild')

  const running = filterBoardViewByAgent(view, { status: 'running' }, { projection })
  assert.deepEqual(running.projects.map(project => project.id), ['ws:w-alpha', 'unassigned'])
  const alphaIds = running.projects[0].trees.flatMap(tree => [tree.node.id, ...tree.children.map(child => child.node.id)])
  assert.deepEqual(alphaIds.sort(), ['alpha-dev', 'alpha-orch'])
  assert.equal(running.visibleCount, 3)
  assert.equal(running.projects[0].visibleAgents, 2, 'the project head count follows the filtered view')
  // The filter never mutates the source view.
  assert.ok(view.projects.some(project => project.id === 'ws:w-beta'))
})

test('normalizeHierarchyFilters bounds persisted values; taskStateIndex requires an available integration', () => {
  assert.deepEqual(normalizeHierarchyFilters({ role: 'worker', status: 'running', taskState: 'blocked' }), { role: 'worker', status: 'running', taskState: 'blocked' })
  assert.deepEqual(normalizeHierarchyFilters({ role: '', status: 'bogus', taskState: 'nope' }), { role: null, status: null, taskState: null })
  assert.deepEqual(normalizeHierarchyFilters(null), { role: null, status: null, taskState: null })
  assert.deepEqual(normalizeHierarchyFilters({ role: 'all', status: 'running' }), { role: null, status: 'running', taskState: null })
  // A stale/removed role id must never hide every agent behind a silent filter.
  assert.deepEqual(normalizeHierarchyFilters({ role: 'not-a-role' }), { role: null, status: null, taskState: null })
  assert.deepEqual(normalizeHierarchyFilters({ role: 'super_orchestrator' }), { role: 'super_orchestrator', status: null, taskState: null })
  assert.deepEqual(normalizeHierarchyFilters({ role: 'generic' }), { role: 'generic', status: null, taskState: null })

  assert.equal(taskStateIndex(null), null)
  assert.equal(taskStateIndex({ taskboard: { available: false, tasks: [{ id: 't', status: 'done' }] } }), null)
  assert.equal(taskStateIndex({ taskboard: { available: true, tasks: [] } })?.size, 0)
  const index = taskStateIndex({ taskboard: { available: true, tasks: [{ id: 't', status: 'done' }, { id: 5, status: 'todo' }, { id: 'x' }] } })
  assert.deepEqual([...index.entries()], [['t', 'done']])
})

test('resolveNodeRoles tolerates a projection without nodes and never mutates role data', () => {
  const empty = resolveNodeRoles({ nodes: [] })
  assert.equal(empty.size, 0)
  const scenario = roleScenario()
  const projection = buildProjection({ ...scenario, now: NOW })
  const before = projection.nodes.map(node => node.role)
  resolveNodeRoles(projection)
  assert.deepEqual(projection.nodes.map(node => node.role), before)
})

test('plural helpers pick the singular only for exactly one', () => {
  assert.equal(pluralKeyFor(1, 'one', 'many'), 'one')
  assert.equal(pluralKeyFor(-1, 'one', 'many'), 'one')
  assert.equal(pluralKeyFor(0, 'one', 'many'), 'many')
  assert.equal(pluralKeyFor(2, 'one', 'many'), 'many')
  assert.equal(pluralKeyFor('1', 'one', 'many'), 'one', 'a numeric string counts as one')
  assert.equal(pluralKeyFor('not-a-number', 'one', 'many'), 'many')
  assert.equal(pluralKeyFor(undefined, 'one', 'many'), 'many')

  const translate = key => ({ projectSingular: 'projet', projectPlural: 'projets' })[key] ?? key
  assert.equal(countLabelFor(1, 'projectSingular', 'projectPlural', translate), '1 projet')
  assert.equal(countLabelFor(3, 'projectSingular', 'projectPlural', translate), '3 projets')
  assert.equal(countLabelFor(0, 'projectSingular', 'projectPlural', translate), '0 projets')
  assert.equal(countLabelFor('2', 'projectSingular', 'projectPlural', translate), '2 projets')
  // No translator: the key is returned, never a crash.
  assert.equal(countLabelFor(1, 'turnSingular', 'turnPlural'), '1 turnSingular')
})

test('project head label keeps the real count and shows the displayed one when they differ', () => {
  const words = {
    agentSingular: 'agent', agentPlural: 'agents',
    shownSingular: 'affiché', shownPlural: 'affichés',
  }
  const translate = key => words[key] ?? key
  assert.equal(projectCountLabel({ agents: 4 }, 4, translate), '4 agents')
  assert.equal(projectCountLabel({ agents: 4 }, 3, translate), '4 agents · 3 affichés')
  assert.equal(projectCountLabel({ agents: 1 }, 1, translate), '1 agent')
  assert.equal(projectCountLabel({ agents: 1 }, 0, translate), '1 agent · 0 affichés')
  assert.equal(projectCountLabel({ agents: 0 }, 0, translate), '0 agents')
})

test('performance: a 150-agent hierarchy build stays well under the budget', () => {
  const byId = {}
  const ids = []
  const workspaces = []
  for (let index = 0; index < 6; index += 1) {
    workspaces.push({ workspaceId: `w${index}`, title: `Project ${index}`, path: `D:\\App\\p${index}`, sessionIds: [] })
  }
  for (let index = 0; index < 150; index += 1) {
    const project = `p${index % 6}`
    const entry = row(`agent-${index}`, {
      displayTitle: `Agent ${index}`,
      running: index % 3 === 0,
      cwd: `D:\\App\\${project}`,
      updatedAt: NOW - index * 1000,
      values: { agentTeam: { members: [{ id: `agent-${index}`, name: index % 7 === 0 ? 'orchestrator' : (index % 5 === 0 ? 'dev' : `member-${index}`), role: 'teammate' }] } },
    })
    byId[entry.id] = entry
    ids.push(entry.id)
  }
  const projection = buildProjection({
    list: { phase: 'ready', ids, byId, projectionsBySession: {} },
    statusMap: new Map(ids.map(id => [id, { running: byId[id].running }])),
    hostState: { turnEnd: {}, acks: {}, previews: {}, assignments: [] },
    workspaces: { items: workspaces, archivedSessionIds: [] },
    now: NOW,
  })
  const view = buildBoardView(projection, { now: NOW, filter: 'all', aggregates: aggregateSubtrees(projection) })
  const started = performance.now()
  const hierarchy = buildHierarchyView(projection, view, supervisionPayload())
  const elapsed = performance.now() - started
  assert.equal(hierarchy.totals.agents, 150)
  assert.equal(hierarchy.roles.size, 150)
  assert.ok(elapsed < 250, `150-agent hierarchy build took ${elapsed.toFixed(1)} ms`)
})
