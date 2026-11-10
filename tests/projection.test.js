import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProjection, classifyStatus, flattenVisible, compactRows, ancestorsOf, normalizeModelInfo, resolveNodeModel } from '../src/supervisor/projection.js'
import { STATUS, STATUS_VALUES } from '../src/contracts/model.js'

const baseList = {
  phase: 'ready',
  ids: ['p', 'c', 'lost'],
  byId: {
    p: { id: 'p', displayTitle: 'Parent session', running: true, cwd: 'D:\\App\\proj' },
    c: { id: 'c', parentId: 'p', displayTitle: 'Child agent', origin: 'subagent', cwd: 'D:\\App\\proj' },
    lost: { id: 'lost', parentId: 'gone', displayTitle: 'Orphan', origin: 'subagent', cwd: 'D:\\App\\proj' },
  },
  projectionsBySession: {},
}

test('a running parent stays running even after an older completed turn', () => {
  const projection = buildProjection({
    list: baseList,
    statusMap: new Map(),
    hostState: { turnEnd: { p: { at: 1000, kind: 'completed' } }, acks: { p: { seenAt: 2000 } }, previews: {} },
    now: 5000,
  })
  const parent = projection.byId.get('p')
  assert.equal(parent.status, STATUS.RUNNING)
})

test('pendingInteraction wins over running (waiting for the user)', () => {
  const projection = buildProjection({
    list: baseList,
    statusMap: new Map([['c', { running: true, pendingInteraction: { kind: 'approval' } }]]),
    hostState: {},
  })
  const child = projection.byId.get('c')
  assert.equal(child.status, STATUS.WAITING_USER)
  assert.equal(child.expectedAction, 'approval')
})

test('finished turn is unread until the read cursor passes it, then read', () => {
  const list = { ...baseList, byId: { ...baseList.byId, p: { id: 'p', displayTitle: 'P', running: false } } }
  const unread = buildProjection({
    list,
    statusMap: new Map(),
    hostState: { turnEnd: { p: { at: 1000, kind: 'completed' } }, acks: { p: { seenAt: 500 } } },
  }).byId.get('p')
  assert.equal(unread.status, STATUS.FINISHED_UNREAD)
  const read = buildProjection({
    list,
    statusMap: new Map(),
    hostState: { turnEnd: { p: { at: 1000, kind: 'completed' } }, acks: { p: { seenAt: 1500 } } },
  }).byId.get('p')
  assert.equal(read.status, STATUS.FINISHED_READ)
})

test('an error turn is failed, never finished', () => {
  const list = { ...baseList, byId: { ...baseList.byId, p: { id: 'p', displayTitle: 'P', running: false } } }
  const node = buildProjection({
    list,
    statusMap: new Map(),
    hostState: { turnEnd: { p: { at: 1000, kind: 'error', error: 'boom' } }, acks: {} },
  }).byId.get('p')
  assert.equal(node.status, STATUS.FAILED)
  assert.equal(node.unread, false)
})

test('elapsed time alone never produces running or finished', () => {
  const list = { ids: ['x'], byId: { x: { id: 'x', displayTitle: 'Old', updatedAt: 1 } } }
  const node = buildProjection({ list, statusMap: new Map(), hostState: {}, now: 10_000_000 }).byId.get('x')
  assert.equal(node.status, STATUS.IDLE)
})

test('a missing row is unknown, not finished', () => {
  const node = buildProjection({
    list: { ids: [], byId: {}, projectionsBySession: { p: { values: { subagentCatalog: [{ sessionId: 'ghost', title: 'Ghost' }] } } } },
    statusMap: new Map(),
    hostState: {},
  }).byId.get('ghost')
  assert.equal(node.status, STATUS.UNKNOWN)
  assert.equal(node.parentId, 'p')
})

test('tree linking: sub-agent under parent, orphan promoted to root, collapse hides children', () => {
  const projection = buildProjection({ list: baseList, statusMap: new Map(), hostState: {} })
  assert.deepEqual(projection.byId.get('p').children, ['c'])
  assert.equal(projection.byId.get('c').parentId, 'p')
  const roots = projection.roots.map(node => node.id).sort()
  assert.deepEqual(roots, ['lost', 'p'])
  const expanded = flattenVisible(projection.roots, projection.byId, new Set())
  assert.equal(expanded.length, 3)
  const collapsed = flattenVisible(projection.roots, projection.byId, new Set(['p']))
  assert.equal(collapsed.length, 2)
  assert.deepEqual(ancestorsOf(projection.byId, 'c'), ['p'])
})

test('workspace grouping uses the workspace item session membership', () => {
  const projection = buildProjection({
    list: baseList,
    statusMap: new Map(),
    hostState: {},
    workspaces: { items: [{ id: 'w1', title: 'Project One', path: 'D:\\App\\proj', sessionIds: ['p', 'c', 'lost'] }] },
  })
  assert.equal(projection.projects.length, 1)
  assert.equal(projection.projects[0].title, 'Project One')
  assert.equal(projection.projects[0].nodes.length, 3)
})

test('preview is the host-captured final answer only once the turn ended', () => {
  const finished = { ...baseList, byId: { ...baseList.byId, p: { ...baseList.byId.p, running: false } } }
  const projection = buildProjection({
    list: finished,
    statusMap: new Map(),
    hostState: { previews: { p: { text: 'Implemented the adapter and ran tests.', at: 42 } }, turnEnd: { p: { at: 50, kind: 'completed' } } },
  })
  assert.equal(projection.byId.get('p').preview.text, 'Implemented the adapter and ran tests.')
  assert.equal(projection.byId.get('p').preview.final, true)
  // While the turn is still running, a mid-turn segment is NOT a final answer.
  const running = buildProjection({
    list: baseList,
    statusMap: new Map(),
    hostState: { previews: { p: { text: 'Let me call a tool…', at: 42 } } },
  })
  assert.equal(running.byId.get('p').preview.final, false)
  assert.equal(running.byId.get('p').preview.text, '')
})

test('classifyStatus is total over the documented vocabulary', () => {
  for (const input of [
    { row: undefined, live: undefined },
    { row: { running: true }, live: undefined },
    { row: {}, live: { pendingInteraction: { kind: 'question' } } },
    { row: {}, live: { completionUnread: true } },
    { row: {}, live: undefined },
  ]) {
    assert.ok(Object.values(STATUS).includes(classifyStatus(input)))
  }
})

test('compact rows keep every node, sorted by project then status rank', () => {
  const projection = buildProjection({ list: baseList, statusMap: new Map(), hostState: {} })
  const rows = compactRows(projection)
  assert.equal(rows.length, 3)
})

test('a failure known only from the native lifecycle stays visible and unread', () => {
  const list = {
    ids: ['n'],
    byId: {
      n: {
        id: 'n',
        displayTitle: 'Native failure',
        running: false,
        updatedAt: 500,
        projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 2, reason: 'error' } } },
      },
    },
    projectionsBySession: {},
  }
  const node = buildProjection({ list, statusMap: new Map(), hostState: {} }).byId.get('n')
  assert.equal(node.status, STATUS.FAILED)
  assert.equal(node.seen, false, 'a failure the host never acked must not be marked seen')
  assert.equal(node.statusSource, 'session_projection')
  assert.match(node.statusReason, /native_turn_end:error/)
})

test('an explicit ack after a host-recorded failure marks it seen', () => {
  const list = { ...baseList, byId: { ...baseList.byId, p: { id: 'p', displayTitle: 'P', running: false } } }
  const node = buildProjection({
    list,
    statusMap: new Map(),
    hostState: { turnEnd: { p: { at: 1000, kind: 'error', error: 'boom' } }, acks: { p: { seenAt: 1200 } } },
  }).byId.get('p')
  assert.equal(node.status, STATUS.FAILED)
  assert.equal(node.seen, true)
})

test('a preview from an errored turn is partial, never "the final answer"', () => {
  const list = { ...baseList, byId: { ...baseList.byId, p: { id: 'p', displayTitle: 'P', running: false } } }
  const node = buildProjection({
    list,
    statusMap: new Map(),
    hostState: {
      previews: { p: { text: 'I started to call a tool', at: 42 } },
      turnEnd: { p: { at: 50, kind: 'error', error: 'boom' } },
    },
  }).byId.get('p')
  assert.equal(node.preview.final, false)
  assert.equal(node.preview.partial, true)
  assert.equal(node.preview.turnEndKind, 'error')
  assert.equal(node.status, STATUS.FAILED)
})

test('a recovering assignment is shown as recovering with its reason', () => {
  const list = { ids: ['r'], byId: { r: { id: 'r', displayTitle: 'Recovering', running: false } }, projectionsBySession: {} }
  const node = buildProjection({
    list,
    statusMap: new Map(),
    hostState: {
      assignments: [{
        id: 'asg-1',
        sessionId: 'r',
        status: 'recovering',
        taskId: 't1',
        reason: 'partial_output_handoff:server_error',
        recoveringAt: 900,
        routeHistory: [{ from: 'primary/big', to: 'backup/medium', reason: 'switch_after_server_error' }],
      }],
    },
  }).byId.get('r')
  assert.equal(node.status, STATUS.RECOVERING)
  assert.match(node.statusReason, /partial_output_handoff/)
  assert.equal(node.statusAt, 900)
  assert.equal(node.assignmentStatus, 'recovering')
  assert.equal(node.routeHistory.length, 1)
})

test('an unavailable agent is distinct from unknown and from idle', () => {
  const list = {
    ids: ['u', 'i'],
    byId: {
      u: { id: 'u', displayTitle: 'Gone', running: false, agentAvailable: false },
      i: { id: 'i', displayTitle: 'Idle', running: false, agentAvailable: true },
    },
    projectionsBySession: {},
  }
  const projection = buildProjection({ list, statusMap: new Map(), hostState: {} })
  assert.equal(projection.byId.get('u').status, STATUS.UNAVAILABLE)
  assert.equal(projection.byId.get('i').status, STATUS.IDLE)
  const ghost = buildProjection({
    list: { ids: [], byId: {}, projectionsBySession: { p: { values: { subagentCatalog: [{ sessionId: 'ghost' }] } } } },
    statusMap: new Map(),
    hostState: {},
  }).byId.get('ghost')
  assert.equal(ghost.status, STATUS.UNKNOWN)
})

test('a session open in the native main view is reported as being viewed', () => {
  const list = {
    ids: ['v'],
    byId: { v: { id: 'v', displayTitle: 'Viewed', running: false, retainedBy: { mainView: 1 } } },
    projectionsBySession: {},
  }
  const node = buildProjection({ list, statusMap: new Map(), hostState: {} }).byId.get('v')
  assert.equal(node.viewing, true)
})

test('an ack newer than native unread activity clears the native-only pill', () => {
  const list = {
    ids: ['c'],
    byId: { c: { id: 'c', displayTitle: 'Native unread', running: false, updatedAt: 1000 } },
    projectionsBySession: {},
  }
  const unread = buildProjection({
    list,
    statusMap: new Map([['c', { completionUnread: true }]]),
    hostState: { acks: { c: { seenAt: 500 } } },
  }).byId.get('c')
  assert.equal(unread.status, STATUS.FINISHED_UNREAD)
  const read = buildProjection({
    list,
    statusMap: new Map([['c', { completionUnread: true }]]),
    hostState: { acks: { c: { seenAt: 1500 } } },
  }).byId.get('c')
  assert.equal(read.status, STATUS.FINISHED_READ)
})

test('the model chip is a fact: native projection or assignment, never a guess', () => {
  const list = {
    ids: ['native', 'unknown', 'assigned'],
    byId: {
      native: { id: 'native', projectionValues: { modelSelection: { lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
      // These plausible fields are NOT the model projection.
      unknown: { id: 'unknown', model: { provider: 'default', model: 'deployment-default' }, header: { model: 'deployment-default' } },
      assigned: { id: 'assigned', projectionValues: { modelSelection: { lastUsed: { provider: 'native-p', model: 'native-m' } } } },
    },
    projectionsBySession: {},
  }
  const projection = buildProjection({
    list,
    statusMap: new Map(),
    hostState: { assignments: [{ id: 'a', sessionId: 'assigned', status: 'running', model: { provider: 'backup', model: 'medium' } }] },
  })
  assert.deepEqual(projection.byId.get('native').model, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: null, source: 'native' })
  assert.deepEqual(projection.byId.get('unknown').model, { provider: null, model: null, reasoningEffort: null, source: 'unknown' })
  assert.equal(projection.byId.get('unknown').modelSource, 'unknown')
  assert.equal(projection.byId.get('assigned').model.provider, 'backup')
  assert.equal(projection.byId.get('assigned').modelSource, 'assignment')
  assert.deepEqual(normalizeModelInfo({ provider: '', model: '' }), null)
  assert.equal(resolveNodeModel({ sessionId: 'x', row: { id: 'x' } }).source, 'unknown')
})

test('the status vocabulary is closed: no invented waiting_agent', () => {
  assert.ok(Object.values(STATUS).includes(STATUS.INTERRUPTED))
  assert.ok(Object.values(STATUS).includes(STATUS.PROVIDER_UNAVAILABLE))
  assert.equal(STATUS_VALUES.includes('waiting_agent'), false)
  // A parent with a running child stays running: the child lifecycle is not a
  // parent-wait signal (see the module comment for the investigated sources).
  const projection = buildProjection({
    list: {
      ids: ['p', 'c'],
      byId: {
        p: { id: 'p', displayTitle: 'Parent', running: true },
        c: { id: 'c', parentId: 'p', origin: 'subagent', displayTitle: 'Child', running: true },
      },
      projectionsBySession: { p: { values: { subagentCatalog: [{ sessionId: 'c', status: 'running' }] } } },
    },
    statusMap: new Map(),
    hostState: {},
  })
  assert.equal(projection.byId.get('p').status, STATUS.RUNNING)
})
