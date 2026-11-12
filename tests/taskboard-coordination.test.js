/**
 * Task Board coordination read model — pure unit tests.
 *
 * Nothing here contacts a Task Board or a socket (except the ONE integration
 * test that reads the SIMULATED fixture server over GETs to prove the real read
 * path feeds the mapper). The mapper is tested purely: no clock, no fetch, no
 * write. No ledger is read or written and the real plugin is untouched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as coordinationModule from '../src/connectors/taskboard-coordination.js'
import {
  buildCoordinationProposal,
  COORDINATION_CAPABILITIES,
  COORDINATION_LIMITS,
  COORDINATION_NOTES,
  PROPOSED_COORDINATION_ENDPOINTS,
  readCoordinationModel,
} from '../src/connectors/taskboard-coordination.js'
import { createTaskboardAdapter } from '../src/connectors/taskboard.js'
import { startSimulatedTaskBoard } from './fixtures/fake-taskboard-server.mjs'

// A realistic `/dsh-taskboard/state` value: per-task `version`, `claimedBy`,
// `dependsOn`, `executions[]`. `priority`/`milestone` are NOT in the real
// 0.10/0.11 TaskRecord; they are present here only to prove the mapper passes a
// future board's fields through untouched.
const STATE = {
  revision: 42,
  tasks: [
    {
      id: 't-alpha', title: 'Alpha', status: 'todo', urgency: 'urgent',
      workspaceId: 'w-alpha', version: 3, dependsOn: ['t-beta'], updatedAt: 111,
      priority: 'high', milestone: 'M1', execution: { mode: 'claim' }, executions: [],
    },
    {
      id: 't-beta', title: 'Beta', status: 'done', workspaceId: 'w-beta', version: 9,
      claimedBy: 'session-beta', updatedAt: 222, executions: [],
    },
    {
      id: 't-gamma', title: 'Gamma', status: 'in_progress', workspaceId: 'w-alpha', version: 5,
      claimedBy: 'session-gamma', dependsOn: ['t-alpha', 't-alpha', 't-missing', 42], updatedAt: 333,
      executions: [],
    },
    { id: 't-trash', title: 'Trashed', status: 'todo', workspaceId: 'w-alpha', trashedAt: 5 },
  ],
  doneCount: 1,
  capabilities: { archiveSessions: false },
  queue: null,
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

function stateOf(tasks) {
  return { ok: true, value: { revision: 1, tasks, doneCount: 0 } }
}

test('maps a realistic state: fields, project identity, assignee, revision', () => {
  const model = readCoordinationModel(STATE)

  assert.equal(model.available, true)
  assert.equal(model.reason, null)
  assert.equal(model.source, 'live')
  assert.equal(model.notes, COORDINATION_NOTES)
  assert.deepEqual(model.capabilities, COORDINATION_CAPABILITIES)
  assert.equal(model.capabilities.read, true)

  // Trashed cards are excluded and tasks are ordered by id, not by payload order.
  assert.deepEqual(model.tasks.map(task => task.id), ['t-alpha', 't-beta', 't-gamma'])

  const alpha = model.tasks[0]
  assert.equal(alpha.title, 'Alpha')
  assert.equal(alpha.status, 'todo')
  assert.equal(alpha.priority, 'high', 'a future priority field is passed through')
  assert.equal(alpha.workspaceId, 'w-alpha')
  // The real TaskRecord has no separate projectId; the owning project is the
  // workspaceId. The model normalizes that, the adapter's projectId stays raw.
  assert.equal(alpha.projectId, 'w-alpha')
  assert.deepEqual(alpha.dependsOn, ['t-beta'])
  assert.equal(alpha.assignee, null)
  assert.equal(alpha.revision, 3)

  const beta = model.tasks[1]
  assert.equal(beta.status, 'done')
  assert.equal(beta.assignee, 'session-beta', 'assignee comes from claimedBy')
  assert.equal(beta.projectId, 'w-beta')
  assert.equal(beta.revision, 9)

  const gamma = model.tasks[2]
  assert.equal(gamma.assignee, 'session-gamma')
  // Duplicate and non-string prerequisites are dropped; order is normalized.
  assert.deepEqual(gamma.dependsOn, ['t-alpha', 't-missing'])
  assert.equal(gamma.revision, 5)

  // Exactly the declared edges, sorted, with cross-project truth.
  assert.deepEqual(model.dependencies, [
    { taskId: 't-alpha', dependsOnTaskId: 't-beta', crossProject: true },
    { taskId: 't-gamma', dependsOnTaskId: 't-alpha', crossProject: false },
    { taskId: 't-gamma', dependsOnTaskId: 't-missing', crossProject: false },
  ])
})

test('accepts the state envelope, the adapter list() output and a bare task array', () => {
  assert.deepEqual(readCoordinationModel({ ok: true, value: STATE }), readCoordinationModel(STATE))
  assert.deepEqual(
    readCoordinationModel({ items: STATE.tasks, meta: { ledgerRevision: 42 } }),
    readCoordinationModel(STATE),
  )
  // The host may hand over `list().items` directly instead of the whole snapshot.
  assert.deepEqual(readCoordinationModel(STATE.tasks), readCoordinationModel(STATE))
})

test('cross-project edges: different projects true, same/unresolved false', () => {
  const model = readCoordinationModel({
    tasks: [
      { id: 'a', title: 'A', status: 'todo', workspaceId: 'w1', version: 1, dependsOn: ['b', 'c', 'z'] },
      { id: 'b', title: 'B', status: 'todo', workspaceId: 'w2', version: 1 },
      { id: 'c', title: 'C', status: 'todo', workspaceId: 'w1', version: 1 },
      { id: 'd', title: 'D', status: 'todo', projectId: 'explicit-p', version: 1 },
      { id: 'e', title: 'E', status: 'todo', workspaceId: 'w3', version: 1, dependsOn: ['d'] },
    ],
  })
  const edge = (taskId, dep) => model.dependencies.find(entry => entry.taskId === taskId && entry.dependsOnTaskId === dep)
  assert.equal(edge('a', 'b').crossProject, true)
  assert.equal(edge('a', 'c').crossProject, false)
  assert.equal(edge('a', 'z').crossProject, false, 'an unresolved prerequisite is not a cross-project claim')
  assert.equal(edge('e', 'd').crossProject, true, 'a raw projectId wins over workspaceId')
  assert.equal(model.tasks.find(task => task.id === 'd').projectId, 'explicit-p')
})

test('absent or unreachable Task Board: available false, empty arrays, explicit reason', () => {
  for (const [state, meta, expectedReason] of [
    [null, { reason: 'taskboard_unreachable' }, 'taskboard_unreachable'],
    [undefined, undefined, 'taskboard_absent'],
    [null, { source: 'absent', reason: 'taskboard_absent' }, 'taskboard_absent'],
  ]) {
    const model = readCoordinationModel(state, meta)
    assert.equal(model.available, false)
    assert.equal(model.reason, expectedReason)
    assert.equal(model.source, 'absent')
    assert.deepEqual(model.tasks, [])
    assert.deepEqual(model.dependencies, [])
    assert.equal(model.capabilities.read, false)
    assert.equal(model.capabilities.writeKanban, false)
    assert.equal(model.notes, COORDINATION_NOTES)
  }
  // The mapper never throws on garbage input.
  const garbage = readCoordinationModel('not a state')
  assert.equal(garbage.available, false)
  assert.equal(garbage.reason, 'taskboard_malformed')
})

test('malformed/partial state degrades safely and never invents a field', () => {
  assert.equal(readCoordinationModel({}).reason, 'taskboard_malformed')
  assert.equal(readCoordinationModel({ tasks: 'nope' }).reason, 'taskboard_malformed')
  assert.equal(readCoordinationModel({ ok: false, error: { code: 'x' } }).reason, 'taskboard_malformed')

  const model = readCoordinationModel({
    tasks: [
      null,
      'not an object',
      { title: 'No id' },
      { id: '', title: 'Empty id' },
      { id: 't-min' },
      { id: 't-min', title: 'Duplicate id (first wins)' },
      { id: 't-partial', title: 7, status: 42, workspaceId: 9, version: '3', dependsOn: ['ok', null, 2, 'ok'] },
    ],
  })
  assert.equal(model.available, true)
  assert.deepEqual(model.tasks.map(task => task.id), ['t-min', 't-partial'])
  assert.equal(model.tasks[0].title, '')
  assert.equal(model.tasks[0].status, 'unknown')
  assert.equal(model.tasks[0].priority, null)
  assert.equal(model.tasks[0].workspaceId, '')
  assert.equal(model.tasks[0].projectId, null)
  assert.equal(model.tasks[0].assignee, null)
  assert.equal(model.tasks[0].revision, null)
  assert.deepEqual(model.tasks[0].dependsOn, [])
  assert.equal(model.tasks[1].title, '')
  assert.equal(model.tasks[1].revision, null, 'a non-integer version is not a revision')
  assert.deepEqual(model.tasks[1].dependsOn, ['ok'])

  // A non-object `meta` is tolerated, and an explicit `source` is honored.
  assert.equal(readCoordinationModel(STATE, 'oops').source, 'live')
  assert.equal(readCoordinationModel(STATE, { source: 'simulated' }).source, 'simulated')
  assert.equal(readCoordinationModel(STATE, { source: 'banana' }).source, 'live')
})

test('a simulated source is detected from the fixture shape without claiming live', () => {
  const simulated = {
    ok: true,
    value: {
      revision: 1,
      tasks: [{ id: 't1', title: 'T', status: 'todo', workspaceId: 'w1', version: 1 }],
      meta: { simulated: true, ledgerRevision: 1 },
    },
  }
  const model = readCoordinationModel(simulated)
  assert.equal(model.available, true)
  assert.equal(model.source, 'simulated')
})

test('output is bounded and deterministic', () => {
  const many = Array.from({ length: 550 }, (_, index) => ({
    id: `t-${String(index).padStart(4, '0')}`,
    title: `Task ${index}`,
    status: 'todo',
    workspaceId: 'w1',
    version: 1,
  }))
  const bounded = readCoordinationModel({ tasks: many })
  assert.equal(bounded.tasks.length, COORDINATION_LIMITS.tasks)
  assert.equal(bounded.tasks[0].id, 't-0000')
  assert.equal(bounded.tasks.at(-1).id, 't-0499')
  assert.match(bounded.notes, /bounded to 500 of 550 tasks/)

  const wide = Array.from({ length: 40 }, (_, index) => ({
    id: `w-${String(index).padStart(4, '0')}`,
    title: '',
    status: 'todo',
    workspaceId: 'w1',
    version: 1,
    dependsOn: Array.from({ length: 40 }, (_, dep) => `d-${dep}`),
  }))
  const edges = readCoordinationModel({ tasks: wide })
  assert.equal(edges.dependencies.length, COORDINATION_LIMITS.dependencies)
  assert.equal(edges.tasks[0].dependsOn.length, COORDINATION_LIMITS.dependsOnPerTask)
  assert.match(edges.notes, /Dependency edges bounded to 1000/)

  // Same facts, different payload order -> byte-identical output.
  const first = readCoordinationModel(STATE)
  const reversed = readCoordinationModel({ ...STATE, tasks: [...STATE.tasks].reverse() })
  assert.equal(JSON.stringify(first), JSON.stringify(reversed))
  const reorderedDeps = readCoordinationModel({
    tasks: STATE.tasks.map(task => (task.id === 't-gamma'
      ? { ...task, dependsOn: ['t-missing', 't-alpha'] }
      : task)),
  })
  assert.equal(JSON.stringify(first), JSON.stringify(reorderedDeps))
})

test('a delegate proposal is a local recommendation: applies:false, stable id, bounded evidence', () => {
  const model = readCoordinationModel(STATE)
  const request = {
    kind: 'delegate',
    taskId: 't-alpha',
    reason: '  ready task, no assignee  ',
    evidence: { rule: 'unassigned_ready', score: 2, nested: { note: 'x'.repeat(900), ignored: undefined } },
  }
  const result = buildCoordinationProposal(model, request)
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.proposal).sort(), [
    'applies', 'evidence', 'id', 'kind', 'projectId', 'reason', 'status', 'taskId',
  ])
  assert.equal(result.proposal.id, 'dsh-agent-board:coordination:delegate:t-alpha')
  assert.equal(result.proposal.kind, 'delegate')
  assert.equal(result.proposal.taskId, 't-alpha')
  assert.equal(result.proposal.projectId, 'w-alpha')
  assert.equal(result.proposal.reason, 'ready task, no assignee')
  assert.equal(result.proposal.applies, false, 'a proposal is never applied by this module')
  assert.equal(result.proposal.status, 'proposed')
  assert.equal(result.proposal.evidence.rule, 'unassigned_ready')
  assert.equal(result.proposal.evidence.nested.note.length, 500, 'evidence strings are bounded')

  // Deterministic and idempotent in shape.
  assert.deepEqual(buildCoordinationProposal(model, request).proposal, result.proposal)

  // `unblock` is also a local recommendation (proceed once prerequisites are
  // done), never a Task Board write.
  const unblock = buildCoordinationProposal(model, { kind: 'unblock', taskId: 't-gamma', reason: 'prerequisites done' })
  assert.equal(unblock.ok, true)
  assert.equal(unblock.proposal.kind, 'unblock')
  assert.equal(unblock.proposal.applies, false)
  assert.equal(unblock.proposal.status, 'proposed')

  const longReason = buildCoordinationProposal(model, { kind: 'delegate', taskId: 't-alpha', reason: 'r'.repeat(900) })
  assert.equal(longReason.proposal.reason.length, 500)
})

test('an unknown task is refused and no proposal is emitted', () => {
  const model = readCoordinationModel(STATE)
  const missing = buildCoordinationProposal(model, { kind: 'delegate', taskId: 't-nope', reason: 'x' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'task_not_found')
  assert.equal('proposal' in missing, false)
  assert.equal(buildCoordinationProposal(model, { kind: 'reassign', taskId: 't-nope', reason: 'x' }).code, 'task_not_found')

  const unavailable = buildCoordinationProposal(readCoordinationModel(null, { reason: 'taskboard_unreachable' }), {
    kind: 'delegate', taskId: 't-alpha', reason: 'x',
  })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.code, 'taskboard_unavailable')
  assert.match(unavailable.message, /taskboard_unreachable/)
})

test('every write kind is refused with writes_unavailable and the PROPOSED endpoint', () => {
  const model = readCoordinationModel(STATE)
  const cases = [
    ['reassign', 'proposeReassignment', '/dsh-taskboard/tasks/:id/coordination/reassign'],
    ['reassignment', 'proposeReassignment', '/dsh-taskboard/tasks/:id/coordination/reassign'],
    ['priority', 'proposePriority', '/dsh-taskboard/tasks/:id/coordination/priority'],
    ['blocked', 'proposeBlocked', '/dsh-taskboard/tasks/:id/coordination/block'],
    ['move', 'writeKanban', '/dsh-taskboard/tasks/:id/coordination/column'],
    ['review', 'requestReview', '/dsh-taskboard/tasks/:id/coordination/review'],
  ]
  for (const [kind, capability, path] of cases) {
    const refused = buildCoordinationProposal(model, { kind, taskId: 't-alpha', reason: 'evidence' })
    assert.equal(refused.ok, false, kind)
    assert.equal(refused.code, 'writes_unavailable', kind)
    assert.equal('proposal' in refused, false, kind)
    assert.equal(COORDINATION_CAPABILITIES[capability], false, `${capability} is not implemented`)
    assert.equal(PROPOSED_COORDINATION_ENDPOINTS[capability].status, 'proposed')
    assert.equal(PROPOSED_COORDINATION_ENDPOINTS[capability].path, path)
    assert.deepEqual(refused.expectedEndpoints, [`POST ${path}`])
    assert.match(refused.message, /no board-facing write API/)
    assert.match(refused.message, /PROPOSED/)
  }
})

test('a forged read-model capability can never unlock a write', () => {
  const model = readCoordinationModel(STATE)
  const forged = {
    ...model,
    capabilities: {
      ...model.capabilities,
      proposeReassignment: true,
      proposePriority: true,
      proposeBlocked: true,
      writeKanban: true,
      requestReview: true,
    },
  }
  for (const kind of ['reassign', 'priority', 'blocked', 'move', 'review']) {
    const refused = buildCoordinationProposal(forged, { kind, taskId: 't-alpha', reason: 'x' })
    assert.equal(refused.ok, false, kind)
    assert.equal(refused.code, 'writes_unavailable', kind)
  }
})

test('invalid requests and unknown kinds are explicit codes, never a silent proposal', () => {
  const model = readCoordinationModel(STATE)
  assert.equal(buildCoordinationProposal(model, null).code, 'invalid_request')
  assert.equal(buildCoordinationProposal(model, { kind: '', taskId: 't-alpha', reason: 'x' }).code, 'invalid_request')
  assert.equal(buildCoordinationProposal(model, { kind: 'delegate', taskId: '', reason: 'x' }).code, 'invalid_request')
  assert.equal(buildCoordinationProposal(model, { kind: 'delegate', taskId: 't-alpha' }).code, 'invalid_request')
  assert.equal(buildCoordinationProposal(model, { kind: 'nonsense', taskId: 't-alpha', reason: 'x' }).code, 'invalid_kind')
})

test('the module is pure: no write export, no fetch call, no network', () => {
  const functions = Object.entries(coordinationModule)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .sort()
  assert.deepEqual(functions, ['buildCoordinationProposal', 'readCoordinationModel'])
  for (const name of functions) assert.doesNotMatch(name, /write|create|update|delete|move|post|put|patch|fetch|run/i)
  assert.equal(typeof coordinationModule.buildCoordinationProposal, 'function', 'it only recommends')

  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('network access is forbidden in the pure mapper')
  }
  try {
    const model = readCoordinationModel(STATE)
    buildCoordinationProposal(model, { kind: 'delegate', taskId: 't-alpha', reason: 'x' })
    buildCoordinationProposal(model, { kind: 'reassign', taskId: 't-alpha', reason: 'x' })
    readCoordinationModel(null, { reason: 'taskboard_unreachable' })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 0, 'the coordination module never performs a request')
})

test('task board read model stays additive; only the documented writes exist', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      value: {
        revision: 12,
        tasks: [
          {
            id: 't1', title: 'One', status: 'in_progress', urgency: 'urgent', workspaceId: 'w1',
            version: 4, claimedBy: 'session-1', updatedAt: 123, dependsOn: ['t0'],
            priority: 'high', milestone: { id: 'm1', title: 'M1' },
            executions: [{ id: 'e1', outcome: 'succeeded', trigger: 'manual' }],
          },
          { id: 't2', title: 'Two', status: 'todo', workspaceId: 'w2' },
        ],
      },
    }),
  }))
  const adapter = createTaskboardAdapter({ baseUrl: 'http://127.0.0.1:62337', fetchImpl, token: () => undefined })
  const listed = await adapter.list()
  const [first, second] = listed.items

  // Additive read fields; every pre-existing field is still here.
  assert.equal(first.updatedAt, 123)
  assert.equal(first.assignee, 'session-1')
  assert.deepEqual(first.dependsOn, ['t0'])
  assert.equal(first.priority, 'high')
  assert.deepEqual(first.milestone, { id: 'm1', title: 'M1' })
  assert.equal(first.claimedBy, 'session-1')
  assert.equal(first.claim, 'session-1')
  assert.equal(first.revision, 4)
  assert.equal(first.executionsTotal, 1)
  assert.equal(first.lastExecutionOutcome, 'succeeded')
  // `projectId` keeps its historical raw-only meaning; `project` is the
  // normalized identity, and workspaceId remains the owning project.
  assert.equal(first.projectId, null)
  assert.deepEqual(first.project, { id: 'w1', workspaceId: 'w1', source: 'workspaceId' })

  // Documented defaults: absent stays null, never a guessed value.
  assert.equal(second.priority, null)
  assert.equal(second.milestone, null)
  assert.equal(second.updatedAt, null)
  assert.equal(second.assignee, null)
  assert.equal(second.projectId, null)
  assert.deepEqual(second.project, { id: 'w2', workspaceId: 'w2', source: 'workspaceId' })
  assert.deepEqual(second.dependsOn, [])

  // With no public token the board-content writes are UNAVAILABLE (honest),
  // while the read path keeps working. No transition/move/delete method exists:
  // `done` is never an adapter action.
  const described = adapter.describe()
  assert.deepEqual(Object.keys(described.capabilities).filter(key => described.capabilities[key]).sort(), ['get', 'list', 'run'])
  for (const capability of ['create', 'update', 'comment', 'transition']) {
    assert.equal(described.capabilities[capability], false, capability)
  }
  for (const method of ['create', 'update', 'comment']) {
    assert.equal(typeof adapter[method], 'function', `the adapter implements ${method}`)
  }
  for (const method of ['transition', 'move', 'delete']) {
    assert.equal(typeof adapter[method], 'undefined', `the adapter has no ${method} method`)
  }
  assert.equal(described.validatedLive, false)

  const { createConnectors } = await import('../src/connectors/registry.js')
  const taskboard = createConnectors({ baseUrl: 'http://127.0.0.1:1' })
    .describe().adapters.find(entry => entry.id === 'dsh-taskboard')
  assert.deepEqual(taskboard.declaredCapabilities.slice().sort(), ['comment', 'create', 'get', 'list', 'run', 'update'])
})

test('the real read path feeds the mapper and performs GETs only (simulated fixture)', async t => {
  const server = await startSimulatedTaskBoard({
    tasks: [
      { id: 't-a', title: 'A', status: 'todo', workspaceId: 'w1', version: 1, dependsOn: [] },
      { id: 't-b', title: 'B', status: 'todo', workspaceId: 'w2', version: 1, dependsOn: [] },
    ],
  })
  t.after(async () => {
    await server.close()
  })
  const adapter = createTaskboardAdapter({ baseUrl: server.url })
  const listed = await adapter.list()
  const model = readCoordinationModel(listed, { source: 'simulated' })
  assert.equal(model.available, true)
  assert.equal(model.source, 'simulated')
  assert.deepEqual(model.tasks.map(task => task.id), ['t-a', 't-b'])
  assert.equal(server.calls.filter(call => call.method !== 'GET').length, 0, 'no write request is ever made')
  assert.equal(server.calls.every(call => call.path === '/dsh-taskboard/state'), true)
})
