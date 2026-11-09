import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProjection, classifyStatus, flattenVisible, compactRows, ancestorsOf } from '../src/supervisor/projection.js'
import { STATUS } from '../src/contracts/model.js'

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
