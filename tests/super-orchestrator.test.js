/**
 * Super Orchestrator supervision projection tests.
 *
 * The module is pure: real facts in (projection + durable host facts + Task
 * Board read model), a proposal/report out. These tests pin the honesty rules:
 * a synthetic supervision LAYER (never an agent), statuses derived from facts
 * only, blocks with provenance, proposals that never apply, explicit
 * unavailable capabilities, stable bounded events, and no fabricated agent.
 *
 * @module dsh-agent-board/tests/super-orchestrator
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  MAX_SUPERVISION_EVENTS,
  buildSupervision,
  mergeSupervisionEvents,
  supervisionEvents,
} from '../src/supervisor/super-orchestrator.js'
import { readinessOf } from '../src/orchestrator/dag.js'
import { apply } from '../src/host/index.js'

const NOW = 1_000_000

function agent(overrides = {}) {
  return {
    id: 'a1',
    title: 'Agent',
    projectId: 'p1',
    projectTitle: 'Project One',
    parentId: null,
    role: null,
    status: 'idle',
    statusReason: 'no_activity',
    statusSource: 'session_row',
    statusAt: null,
    taskId: null,
    assignmentId: null,
    assignmentStatus: null,
    healthUntil: null,
    updatedAt: null,
    children: [],
    ...overrides,
  }
}

function projectionOf(nodes) {
  return { nodes, byId: new Map(nodes.map(node => [node.id, node])), roots: nodes.filter(node => node.parentId === null), projects: [], counts: {} }
}

function task(overrides = {}) {
  return {
    id: 't1',
    title: 'Task',
    status: 'todo',
    priority: null,
    workspaceId: 'w1',
    projectId: 'p1',
    dependsOn: [],
    assignee: null,
    revision: 1,
    updatedAt: NOW,
    blocked: false,
    ...overrides,
  }
}

function modelOf(tasks, overrides = {}) {
  return {
    available: true,
    reason: null,
    source: 'live',
    tasks,
    capabilities: { read: true, proposeReassignment: false, proposePriority: false, proposeBlocked: false, writeKanban: false, requestReview: false },
    notes: 'Task Board remains the source of truth; this adapter never writes.',
    ...overrides,
  }
}

function hostStateOf(overrides = {}) {
  return {
    mode: 'autonomous',
    stoppedAt: null,
    policy: {},
    assignments: [],
    proposals: [],
    instance: { primary: true, holder: null },
    ...overrides,
  }
}

function build({ nodes = [], tasks = [], hostState = {}, taskboard } = {}) {
  return buildSupervision({
    projection: projectionOf(nodes),
    hostState: hostStateOf(hostState),
    taskboard: taskboard === undefined ? modelOf(tasks) : taskboard,
    now: NOW,
  })
}

test('the workspace node is a synthetic supervision LAYER, counts aggregate every project', () => {
  const out = build({
    nodes: [
      agent({ id: 'p1-orch', title: 'Orchestrator', projectId: 'p1', projectTitle: 'Project One', role: 'orchestrator', status: 'running', statusReason: 'turn_in_progress' }),
      agent({ id: 'p1-worker', title: 'Worker', projectId: 'p1', projectTitle: 'Project One', role: 'worker', status: 'failed', statusReason: 'turn_end:error', statusAt: 900 }),
      agent({ id: 'p2-planner', title: 'Planner', projectId: 'p2', projectTitle: 'Project Two', role: 'planner', status: 'waiting_user', statusReason: 'pending_interaction:question' }),
      agent({ id: 'p2-unread', title: 'Researcher', projectId: 'p2', projectTitle: 'Project Two', role: 'researcher', status: 'finished_unread', statusReason: 'turn_end:completed_not_acknowledged' }),
    ],
  })
  assert.equal(out.version, 1)
  assert.equal(out.at, NOW)
  assert.equal(out.workspace.id, 'workspace:supervision')
  assert.equal(out.workspace.synthetic, true, 'the layer is explicitly synthetic, never a real agent')
  assert.equal(out.workspace.role, 'super_orchestrator')
  assert.equal(out.workspace.emblem, 'crown')
  assert.equal(out.workspace.mode, 'autonomous')
  assert.equal(out.workspace.status, 'active')
  assert.equal(out.workspace.reason, 'supervision_active')
  assert.equal(out.workspace.agent, null, 'no declared super-orchestrator agent: null, never fabricated')
  assert.deepEqual(out.workspace.counts, {
    projects: 2,
    agents: 4,
    running: 1,
    waiting: 1,
    unread: 1,
    failed: 1,
    interrupted: 0,
    blocked: 1,
  })
  assert.equal(out.projects.length, 2)
  const one = out.projects.find(project => project.id === 'p1')
  const two = out.projects.find(project => project.id === 'p2')
  assert.equal(one.counts.agents, 2)
  assert.equal(one.counts.failed, 1)
  assert.equal(one.orchestrator.id, 'p1-orch')
  assert.equal(two.orchestrator, null, 'a project without a declared orchestrator shows the gap')
  assert.equal(one.agents.length, 2)
})

test('a declared super-orchestrator agent is exposed; a declared orchestrator is per project', () => {
  const out = build({
    nodes: [
      agent({ id: 'super-1', title: 'Supervisor', projectId: 'p1', role: 'super-orchestrator', status: 'running', updatedAt: 5 }),
      agent({ id: 'orch-1', title: 'Project lead', projectId: 'p1', role: 'team-lead' }),
      agent({ id: 'worker-1', title: 'Worker', projectId: 'p1', role: 'dev' }),
    ],
  })
  assert.equal(out.workspace.agent.id, 'super-1')
  assert.equal(out.workspace.agent.role, 'super_orchestrator')
  assert.equal(out.projects[0].orchestrator.id, 'orch-1', 'the lead alias resolves to orchestrator')
  assert.notEqual(out.projects[0].orchestrator.id, 'super-1', 'the workspace layer is not a project orchestrator')
})

test('cross-project dependsOn become real edges and block while unsatisfied', () => {
  const tasks = [
    task({ id: 't-p1', projectId: 'p1', workspaceId: 'w1', dependsOn: ['t-p2'] }),
    task({ id: 't-p2', projectId: 'p2', workspaceId: 'w2', status: 'in_progress' }),
  ]
  const out = build({
    nodes: [agent({ id: 'p1-agent', projectId: 'p1', projectTitle: 'Project One' })],
    tasks,
  })
  assert.equal(out.crossProjectDependencies.length, 1)
  const edge = out.crossProjectDependencies[0]
  assert.deepEqual({
    fromTaskId: edge.fromTaskId,
    fromProjectId: edge.fromProjectId,
    toTaskId: edge.toTaskId,
    toProjectId: edge.toProjectId,
    source: edge.source,
    satisfied: edge.satisfied,
  }, {
    fromTaskId: 't-p1',
    fromProjectId: 'p1',
    toTaskId: 't-p2',
    toProjectId: 'p2',
    source: 'taskboard',
    satisfied: false,
  })
  const block = out.blocks.find(entry => entry.kind === 'cross_project_prerequisite')
  assert.ok(block, 'an unsatisfied cross-project prerequisite is a blocking fact')
  assert.equal(block.taskId, 't-p1')
  assert.equal(block.blockedByTaskId, 't-p2')
  assert.equal(block.source, 'taskboard')
  assert.equal(block.at, NOW)
  assert.equal(out.projects.find(project => project.id === 'p1').crossProjectDependencies.length, 1)

  const satisfied = build({ tasks: [tasks[0], { ...tasks[1], status: 'done' }] })
  assert.equal(satisfied.crossProjectDependencies[0].satisfied, true)
  assert.equal(satisfied.blocks.some(entry => entry.kind === 'cross_project_prerequisite'), false)
})

test('blocks come from real facts only, each with a source and a timestamp', () => {
  const out = build({
    nodes: [
      agent({ id: 'failed', status: 'failed', statusReason: 'turn_end:error', statusSource: 'host_turn_end', statusAt: 111 }),
      agent({ id: 'interrupted', status: 'interrupted', statusReason: 'assignment:failed:x', statusSource: 'assignment', statusAt: 222 }),
      agent({ id: 'cooling', status: 'provider_unavailable', statusReason: 'provider_cooldown:p:429:until:...', statusSource: 'host_health', healthUntil: 999_999 }),
    ],
    tasks: [task({ id: 'blocked-task', status: 'blocked', updatedAt: 333 })],
  })
  const kinds = out.blocks.map(block => block.kind).sort()
  assert.deepEqual(kinds, ['agent_failed', 'agent_interrupted', 'provider_cooldown', 'task_blocked'])
  for (const block of out.blocks) {
    assert.equal(typeof block.source, 'string')
    assert.ok(block.source !== '')
    assert.equal(typeof block.at, 'number')
    assert.ok(Number.isFinite(block.at))
    assert.equal(typeof block.id, 'string')
    assert.equal(typeof block.projectId, 'string')
  }
  assert.equal(out.blocks.find(block => block.kind === 'provider_cooldown').source, 'host_health')
  assert.equal(out.blocks.find(block => block.kind === 'provider_cooldown').until, 999_999)
  assert.equal(out.blocks.find(block => block.kind === 'task_blocked').at, 333)
})

test('mode off reports idle (observing), never active', () => {
  const out = build({
    hostState: { mode: 'off' },
    nodes: [agent({ id: 'failed', status: 'failed', statusReason: 'turn_end:error' })],
  })
  assert.equal(out.workspace.status, 'idle')
  assert.equal(out.workspace.reason, 'mode_off')
  assert.equal(out.workspace.counts.failed, 1, 'counting a failure does not make the layer active')
})

test('Stop blocks the layer; a secondary instance is blocked too', () => {
  const stopped = build({ hostState: { mode: 'autonomous', stoppedAt: 5000 } })
  assert.equal(stopped.workspace.status, 'blocked')
  assert.equal(stopped.workspace.reason, 'stopped_by_operator')

  const secondary = build({ hostState: { mode: 'autonomous', instance: { primary: false, holder: { pid: 42 } } } })
  assert.equal(secondary.workspace.status, 'blocked')
  assert.equal(secondary.workspace.reason, 'secondary_instance')
})

test('recommendations are local proposals: applies:false, status proposed, no write', () => {
  const tasks = [
    task({ id: 'ready', projectId: 'p1', status: 'todo' }),
    task({ id: 'blocked-done', projectId: 'p1', status: 'blocked', dependsOn: ['done-dep'] }),
    task({ id: 'done-dep', projectId: 'p1', status: 'done' }),
    task({ id: 'claimed', projectId: 'p2', status: 'todo', assignee: 'someone' }),
    task({ id: 'not-ready', projectId: 'p2', status: 'todo', dependsOn: ['later'] }),
    task({ id: 'later', projectId: 'p2', status: 'in_progress' }),
    task({ id: 'stale', projectId: 'p2', status: 'in_progress' }),
  ]
  const out = build({
    tasks,
    hostState: {
      assignments: [{
        id: 'asg-stale',
        taskId: 'stale',
        status: 'failed',
        delegation: { depth: 0, rootTaskId: 'stale', parentAssignmentId: null, projectId: 'p2', requestedBy: 'board:tick' },
      }],
    },
  })
  const kinds = out.recommendations.map(recommendation => recommendation.kind)
  assert.ok(kinds.includes('delegate'))
  assert.ok(kinds.includes('unblock'))
  assert.ok(kinds.includes('reassign'), 'a failed delegation on an in_progress card is a real reassign proposal')
  for (const recommendation of out.recommendations) {
    assert.equal(recommendation.status, 'proposed')
    assert.equal(recommendation.applies, false, 'a proposal is never applied by this module')
    assert.equal(typeof recommendation.taskId, 'string')
    assert.equal(typeof recommendation.projectId, 'string')
    assert.equal(typeof recommendation.reason, 'string')
    assert.equal(typeof recommendation.id, 'string')
    assert.deepEqual(recommendation.evidence !== undefined, true)
  }
  // A card already owned elsewhere is not proposed for delegation.
  assert.equal(out.recommendations.some(recommendation => recommendation.taskId === 'claimed'), false)
  // An unready card is not proposed for delegation.
  assert.equal(out.recommendations.some(recommendation => recommendation.kind === 'delegate' && recommendation.taskId === 'not-ready'), false)
  // No priority proposal without a Task Board priority field.
  assert.equal(kinds.includes('priority'), false)
  assert.equal(out.capabilities.priority, 'unavailable')
  assert.equal(out.capabilityReasons.priority, 'taskboard_priorities_unavailable')
  assert.equal(out.capabilities.reassign, 'proposal_only')
  assert.equal(out.capabilityReasons.reassign, 'taskboard_write_api_unavailable')
})

test('priority is proposal_only when the Task Board exposes priorities, and needs real project contention', () => {
  const tasks = [
    task({ id: 'a', projectId: 'p1', dependsOn: ['b'], priority: 'high' }),
    task({ id: 'b', projectId: 'p2', priority: 'low' }),
    task({ id: 'c', projectId: 'p2', dependsOn: ['d'], priority: 'normal' }),
    task({ id: 'd', projectId: 'p1', priority: 'urgent' }),
  ]
  const out = build({ tasks })
  assert.equal(out.capabilities.priority, 'proposal_only')
  const priority = out.recommendations.find(recommendation => recommendation.kind === 'priority')
  assert.ok(priority, 'two projects blocked on one another is a real priority contention')
  assert.equal(priority.applies, false)
  assert.equal(priority.status, 'proposed')
  assert.deepEqual(priority.evidence.projects, ['p1', 'p2'])
})

test('the readiness rule matches orchestrator/dag.js (no drift between the two implementations)', () => {
  const tasks = [
    task({ id: 'ready', status: 'todo', dependsOn: ['done'] }),
    task({ id: 'done', status: 'done' }),
    task({ id: 'waiting-prereq', status: 'todo', dependsOn: ['in-review'] }),
    task({ id: 'in-review', status: 'in_review' }),
    task({ id: 'unknown-prereq', status: 'todo', dependsOn: ['ghost'] }),
    task({ id: 'not-todo', status: 'in_progress' }),
  ]
  const byId = new Map(tasks.map(entry => [entry.id, entry]))
  const out = build({ tasks })
  const proposed = new Set(out.recommendations.filter(recommendation => recommendation.kind === 'delegate').map(recommendation => recommendation.taskId))
  for (const entry of tasks) {
    const dag = readinessOf(entry, byId)
    assert.equal(proposed.has(entry.id), dag.ready, `${entry.id}: both implementations must agree (dag=${dag.reason})`)
  }
})

test('an absent Task Board is explicit: unavailable, empty, no recommendation', () => {
  const out = build({ nodes: [agent({ id: 'a1', status: 'running' })], taskboard: null })
  assert.equal(out.taskboard.available, false)
  assert.equal(out.taskboard.reason, 'taskboard_unavailable')
  assert.deepEqual(out.taskboard.tasks, [])
  assert.deepEqual(out.crossProjectDependencies, [])
  assert.deepEqual(out.recommendations, [])
  assert.equal(out.capabilities.priority, 'unavailable')
  assert.equal(out.capabilityReasons.priority, 'taskboard_unavailable')
  assert.equal(out.capabilities.delegate, 'gated', 'the delegated path still exists; only the read model is absent')
})

test('capabilities that do not exist are explicit, with a reason', () => {
  const out = build()
  assert.equal(out.capabilities.observe, true)
  assert.equal(out.capabilities.recommend, true)
  assert.equal(out.capabilities.delegate, 'gated')
  assert.equal(out.capabilities.receiveOrchestratorReports, 'unavailable')
  assert.equal(out.capabilities.kanbanWrite, 'unavailable')
  assert.equal(out.capabilityReasons.receiveOrchestratorReports, 'no_inbound_orchestrator_report_channel')
  assert.equal(out.capabilityReasons.kanbanWrite, 'taskboard_write_api_unavailable')
  // The emblem is a visual variant of the SAME role, taken from the policy.
  assert.equal(build({ hostState: { policy: { supervision: { emblem: 'bolt' } } } }).workspace.emblem, 'bolt')
  assert.equal(build({ hostState: { policy: { supervision: { emblem: 'not-an-emblem' } } } }).workspace.emblem, 'crown')
  // A disabled layer reports its gate unavailable instead of pretending.
  const disabled = build({ hostState: { policy: { supervision: { enabled: false } } } })
  assert.equal(disabled.capabilities.delegate, 'unavailable')
  assert.equal(disabled.capabilityReasons.delegate, 'supervision_disabled')
  assert.equal(disabled.capabilities.recommend, false)
  assert.deepEqual(disabled.recommendations, [])
})

test('no fake agent: an empty projection yields no project, no agent, no block', () => {
  const out = build({ nodes: [], tasks: [] })
  assert.deepEqual(out.projects, [])
  assert.equal(out.workspace.agent, null)
  assert.equal(out.workspace.counts.agents, 0)
  assert.equal(out.workspace.counts.projects, 0)
  assert.deepEqual(out.blocks, [])
  assert.deepEqual(out.recommendations, [])
})

test('events are real diffs with stable ids; a newly observed agent fabricates nothing', () => {
  const before = build({ nodes: [agent({ id: 'a1', status: 'idle' }), agent({ id: 'a2', status: 'idle' })], tasks: [] })
  const after = build({
    nodes: [
      agent({ id: 'a1', status: 'running', statusReason: 'turn_in_progress' }),
      agent({ id: 'a2', status: 'idle' }),
      agent({ id: 'a3', status: 'running' }),
    ],
    tasks: [],
  })
  const events = supervisionEvents(before, after, 7000)
  const byType = kind => events.filter(event => event.type === kind)
  assert.deepEqual(byType('agent.status.changed').map(event => event.entityId), ['a1'])
  assert.deepEqual(byType('agent.started').map(event => event.entityId), ['a1'])
  assert.equal(events.some(event => event.entityId === 'a3'), false, 'an agent first OBSERVED running is not a fabricated start')
  for (const event of events) assert.equal(event.id, `${event.type}|${event.entityId}|${event.at}`)
  assert.equal(new Set(events.map(event => event.id)).size, events.length)
  // Same fact, same id: recomputing the transition at the same timestamp is stable.
  assert.deepEqual(supervisionEvents(before, after, 7000), events)
  // No previous payload => no baseline => no event.
  assert.deepEqual(supervisionEvents(null, after, 7000), [])
  // No diff => no event.
  assert.deepEqual(supervisionEvents(after, after, 8000), [])
})

test('events cover task, project and assignment transitions only when they really changed', () => {
  const first = build({
    nodes: [agent({ id: 'a1', status: 'running', taskId: 't1', assignmentId: 'asg1', assignmentStatus: 'running', statusReason: 'turn_in_progress' })],
    tasks: [task({ id: 't1', status: 'todo', assignee: 'session-1' })],
  })
  const second = build({
    nodes: [agent({ id: 'a1', status: 'finished_read', taskId: 't1', assignmentId: 'asg1', assignmentStatus: 'done', statusReason: 'ack_after_turn:completed' })],
    tasks: [task({ id: 't1', status: 'in_review', assignee: null })],
  })
  const events = supervisionEvents(first, second, 9000).map(event => event.type)
  assert.ok(events.includes('agent.status.changed'))
  assert.ok(events.includes('agent.task.completed'))
  assert.ok(events.includes('project.status.changed'), 'a running project becomes idle')
  assert.ok(events.includes('task.status.changed'))
  assert.ok(events.includes('task.assignee.changed'))
  assert.equal(events.includes('agent.started'), false)
  assert.equal(events.includes('agent.blocked'), false)

  const reassigned = build({
    nodes: [agent({ id: 'a1', status: 'running', taskId: 't2', assignmentId: 'asg2', assignmentStatus: 'running', statusReason: 'turn_in_progress' })],
    tasks: [],
  })
  assert.ok(supervisionEvents(second, reassigned, 9001).some(event => event.type === 'agent.task.assigned'))
})

test('agent.delegated reports a real new delegation, never a handoff continuation', () => {
  const assignmentOf = (id, delegation) => ({ id, taskId: 't1', status: 'running', delegation })
  const snapshot = assignmentId => build({
    nodes: [agent({ id: 'a1', status: 'running', taskId: 't1', assignmentId, assignmentStatus: 'running' })],
    hostState: {
      assignments: [assignmentOf(assignmentId, {
        depth: assignmentId === 'asg-child' ? 1 : 0,
        rootTaskId: 't1',
        parentAssignmentId: assignmentId === 'asg-child' ? 'asg-root' : null,
        projectId: 'w1',
        requestedBy: assignmentId === 'asg-hop' ? 'board:handoff' : 'board:tick',
      })],
    },
  })
  const root = snapshot('asg-root')
  const handoff = snapshot('asg-hop')
  const nested = snapshot('asg-child')
  assert.equal(supervisionEvents(root, handoff, 11_000).some(event => event.type === 'agent.delegated'), false, 'a handoff continues the same delegation')
  assert.equal(supervisionEvents(root, nested, 12_000).some(event => event.type === 'agent.delegated'), true, 'a nested delegation is a real new record')
})

test('events are bounded to 50 and merged without duplicates, order tolerant', () => {
  const idleAgents = Array.from({ length: 60 }, (_, index) => agent({ id: `a${String(index).padStart(3, '0')}`, status: 'idle' }))
  const runningAgents = idleAgents.map(entry => ({ ...entry, status: 'running' }))
  const before = build({ nodes: idleAgents, tasks: [] })
  const after = build({ nodes: runningAgents, tasks: [] })
  const events = supervisionEvents(before, after, 10_000)
  assert.equal(events.length, MAX_SUPERVISION_EVENTS)
  assert.equal(new Set(events.map(event => event.id)).size, events.length)

  const merged = mergeSupervisionEvents([], events)
  assert.equal(merged.length, MAX_SUPERVISION_EVENTS)
  const again = mergeSupervisionEvents(merged, events)
  assert.equal(again.length, MAX_SUPERVISION_EVENTS, 'duplicates are dropped by stable id')
  assert.deepEqual(again.map(event => event.id), merged.map(event => event.id), 'order is preserved')
  const reversed = mergeSupervisionEvents([...events].reverse(), [])
  assert.equal(reversed.length, events.length, 'a different arrival order cannot duplicate an event')
})

test('recommendations declare applies:false and never mutate the Task Board model', () => {
  const tasks = [task({ id: 'ready', status: 'todo' }), task({ id: 'blocked', status: 'blocked', dependsOn: ['ready'] })]
  const model = modelOf(tasks)
  const snapshot = JSON.stringify(model)
  const out = build({ tasks, taskboard: model })
  assert.ok(out.recommendations.length > 0)
  for (const recommendation of out.recommendations) {
    assert.equal(recommendation.applies, false)
    assert.equal(recommendation.status, 'proposed')
  }
  assert.equal(JSON.stringify(model), snapshot, 'the read model is never written by the proposal builder')
})

test('host publishes supervision and bounded events; a disabled supervision gate refuses delegation explicitly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-supervision-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousFetch = globalThis.fetch
  const created = []
  const listeners = new Map()
  const routes = new Map()
  const tasksRef = [{
    id: 't-host-1',
    title: 'Delegated task',
    status: 'todo',
    urgency: 'normal',
    workspaceId: 'w1',
    dependsOn: [],
    version: 1,
  }]
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 3, tasks: tasksRef } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { fn(); return () => {} },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) {
        created.push(options)
        return { agent: { id: options.sessionId, inject: () => {}, followup: () => {}, cancel: () => {} }, dispose: async () => {} }
      },
      get(id) {
        return created.some(options => options.sessionId === id) ? { cancel: () => {} } : undefined
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  const call = (method, path, body) => {
    const handler = routes.get('/dsh-agent-board/api/v2').handler
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = `/dsh-agent-board/api/v2${path}`
    req.headers = {}
    const res = {
      status: 0,
      body: '',
      writeHead(code) { this.status = code },
      write(chunk) { this.body += String(chunk) },
      end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    }
    handler(req, res)
    return res
  }
  const waitFor = async predicate => {
    const started = Date.now()
    while (Date.now() - started < 4000) {
      if (predicate()) return true
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    return false
  }
  const callJson = async (method, path, body) => {
    const res = call(method, path, body)
    await waitFor(() => res.body !== '')
    return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
  }
  const dispose = apply(ctx)
  try {
    const first = await callJson('GET', '/state')
    assert.equal(first.status, 200)
    assert.ok(first.body.value.supervision, 'the public state publishes the supervision payload')
    assert.equal(first.body.value.supervision.workspace.synthetic, true)
    assert.equal(first.body.value.supervision.workspace.mode, 'off')
    assert.equal(first.body.value.supervision.workspace.status, 'idle')
    assert.ok(Array.isArray(first.body.value.events))
    assert.equal(first.body.value.events.length <= MAX_SUPERVISION_EVENTS, true)

    await callJson('POST', '/mode', { mode: 'autonomous' })
    const limited = await callJson('POST', '/policy', { policy: { supervision: { maxDelegationsPerHour: 0 } } })
    assert.equal(limited.status, 200)
    assert.equal(limited.body.value.supervision.maxDelegationsPerHour, 0, 'the additive policy slice round-trips')

    const refused = await callJson('POST', '/dispatch', { taskId: 't-host-1' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.reason, 'delegation_budget_exhausted', 'the supervision gate is additively enforced')
    assert.equal(created.length, 0, 'a refused delegation creates no session')
    let state = (await callJson('GET', '/state')).body.value
    assert.ok(state.audit.some(entry => entry.type === 'delegation_refused' && entry.reason === 'delegation_budget_exhausted'))
    // The host read the Task Board coordination model once for this dispatch and
    // passed it into the supervision payload (contract C consumes D's model).
    assert.equal(state.supervision.taskboard.available, true)
    assert.equal(state.supervision.taskboard.count, 1)
    assert.equal(state.supervision.taskboard.tasks[0].id, 't-host-1')

    await callJson('POST', '/policy', { policy: { supervision: { maxDelegationsPerHour: 6 } } })
    const launched = await callJson('POST', '/dispatch', { taskId: 't-host-1' })
    assert.equal(launched.status, 200, JSON.stringify(launched.body))
    assert.equal(created.length, 1)
    state = (await callJson('GET', '/state')).body.value
    assert.ok(state.audit.some(entry => entry.type === 'delegation_allowed'))
    const assignment = state.assignments.find(entry => entry.sessionId === created[0].sessionId)
    assert.equal(assignment.delegation.depth, 0)
    assert.equal(assignment.delegation.rootTaskId, 't-host-1')
    assert.equal(assignment.delegation.parentAssignmentId, null)
    assert.equal(assignment.delegation.projectId, 'w1')
    assert.equal(assignment.delegation.requestedBy, 'board:dispatch')
    assert.equal(state.supervision.workspace.delegation.depthLimit, 1)
    assert.equal(state.supervision.workspace.delegation.hourlyLimit, 6)
  } finally {
    dispose()
    globalThis.fetch = previousFetch
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
