/**
 * Independent review tests for the GOAL 3 supervision/UI surface.
 *
 * Two kinds of tests live here:
 *
 *   1. NON-REGRESSION tests (plain `test`) that lock the behaviours the review
 *      confirmed as correct: read-state, model identity, filiation, preview
 *      honesty for the host path, click arbitration, store lifecycle.
 *
 *   2. REPRODUCTIONS of review findings, declared with `{ todo: ... }`. They
 *      assert the behaviour the docs REQUIRE, so they fail on the reviewed
 *      build; `todo` keeps the suite green while the failure text is the
 *      evidence (run `node --test tests/review-supervision-behaviour.test.js`
 *      and read the TODO block). Remove the `todo` flag when the finding is
 *      fixed.
 *
 * Nothing here writes to src/**; the artifact check is in
 * review-supervision-artifact.test.js.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProjection,
  classifyStatusDetailed,
  modelHistoryOf,
  previewOf,
  resolveNodeModel,
  trackModelChange,
} from '../src/supervisor/projection.js'
import { buildBoardView, includedByFilter, isAttention } from '../src/board/view.js'
import { createBoardStore } from '../src/client/core.js'
import { createClickArbiter } from '../src/board/interaction.js'
import { STATUS } from '../src/contracts/model.js'

const NOW = 1_800_000_000_000

function session(id, extra = {}) {
  return { id, displayTitle: id, running: false, updatedAt: NOW - 60_000, cwd: 'D:\\App\\proj', ...extra }
}

function project(input) {
  return buildProjection({ list: { ids: [], byId: {}, projectionsBySession: {} }, statusMap: new Map(), hostState: {}, now: NOW, ...input })
}

function listOf(rows) {
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return { ids: rows.map(row => row.id), byId, projectionsBySession: {} }
}

function single(row, extra = {}) {
  return project({ list: listOf([row]), statusMap: extra.statusMap ?? new Map(), hostState: extra.hostState ?? {}, workspaces: extra.workspaces }).byId.get(row.id)
}

const SELECTION = (provider, model) => ({ modelSelection: { lastUsed: { provider, model } } })

// ---------------------------------------------------------------- non-regression

test('age alone never produces running/finished, and a gone session is unknown even with a turn end', () => {
  const idle = single(session('idle', { updatedAt: 1 }))
  assert.equal(idle.status, STATUS.IDLE)
  assert.equal(idle.recentlyFinished, false)
  const gone = project({
    list: listOf([session('g')]),
    hostState: { gone: { g: NOW - 1000 }, turnEnd: { g: { at: NOW - 500, kind: 'completed' } } },
  }).byId.get('g')
  assert.equal(gone.status, STATUS.UNKNOWN)
  assert.equal(gone.statusReason, 'session_gone')
})

test('read-state: board ack clears the unread result, keeps a failure visible until acked', () => {
  const unread = single(session('u'), { hostState: { turnEnd: { u: { at: NOW - 1000, kind: 'completed' } } } })
  assert.equal(unread.status, STATUS.FINISHED_UNREAD)
  assert.equal(isAttention(unread), true)
  const acked = single(session('u'), { hostState: { turnEnd: { u: { at: NOW - 1000, kind: 'completed' } }, acks: { u: { seenAt: NOW - 500 } } } })
  assert.equal(acked.status, STATUS.FINISHED_READ)
  assert.equal(isAttention(acked), false)
  const failure = single(session('f'), { hostState: { turnEnd: { f: { at: NOW - 1000, kind: 'error', error: 'x' } } } })
  assert.equal(failure.status, STATUS.FAILED)
  assert.equal(failure.seen, false)
  assert.equal(isAttention(failure), true)
  const ackedFailure = single(session('f'), { hostState: { turnEnd: { f: { at: NOW - 1000, kind: 'error', error: 'x' } }, acks: { f: { seenAt: NOW - 500 } } } })
  assert.equal(ackedFailure.status, STATUS.FAILED)
  assert.equal(ackedFailure.seen, true)
  assert.equal(isAttention(ackedFailure), false)
})

test('model identity: unknown stays unknown, an assignment only decorates its own session, one card per session', () => {
  const rows = [
    session('native', { projectionValues: SELECTION('p', 'm1') }),
    session('unknown', { model: { provider: 'default', model: 'deployment-default' } }),
    session('assigned', { projectionValues: SELECTION('native-p', 'native-m') }),
  ]
  const projection = project({
    list: listOf(rows),
    hostState: { assignments: [{ id: 'a', sessionId: 'assigned', status: 'running', model: { provider: 'backup', model: 'medium' } }] },
  })
  assert.deepEqual(projection.byId.get('unknown').model, { provider: null, model: null, reasoningEffort: null, source: 'unknown' })
  assert.equal(projection.byId.get('native').model.source, 'native')
  assert.equal(projection.byId.get('assigned').model.source, 'assignment')
  assert.equal(projection.nodes.filter(node => node.id === 'assigned').length, 1)
})

test('trackModelChange keeps one bounded history per session and bounds the memory', () => {
  const memory = new Map()
  assert.equal(trackModelChange(memory, 's', { provider: 'p', model: 'm1' }, NOW), null)
  const change = trackModelChange(memory, 's', { provider: 'p', model: 'm2' }, NOW + 1)
  assert.deepEqual(change, { from: 'p/m1', to: 'p/m2', at: NOW + 1, reason: 'model_change', source: 'native' })
  assert.equal(trackModelChange(memory, 's', { provider: 'p', model: 'm2' }, NOW + 2), null)
  assert.equal(trackModelChange(memory, 's', { provider: null, model: null }, NOW + 3), null)
  for (let index = 0; index < 20; index += 1) trackModelChange(memory, 's', { provider: 'p', model: `x${index}` }, NOW + 10 + index)
  assert.equal(memory.get('s').entries.length, 8)
  assert.deepEqual(Object.keys(modelHistoryOf(memory)), ['s'])
  const bounded = new Map()
  for (let index = 0; index < 520; index += 1) trackModelChange(bounded, `s${index}`, { provider: 'p', model: 'm' }, NOW)
  assert.ok(bounded.size <= 512, `the session memory is bounded (${bounded.size})`)
})

test('filiation: depth-3 tree, orphan and cycle flagged roots, no silent re-parenting', () => {
  const rows = [
    session('root'),
    session('child', { parentId: 'root', origin: 'subagent' }),
    session('grandchild', { parentId: 'child', origin: 'subagent' }),
    session('leaf', { parentId: 'grandchild', origin: 'subagent' }),
    session('orphan', { parentId: 'ghost', origin: 'subagent' }),
    session('cyc-a', { parentId: 'cyc-b' }),
    session('cyc-b', { parentId: 'cyc-a' }),
  ]
  const projection = project({ list: listOf(rows) })
  assert.deepEqual(projection.byId.get('root').children, ['child'])
  assert.deepEqual(projection.byId.get('child').children, ['grandchild'])
  assert.deepEqual(projection.byId.get('grandchild').children, ['leaf'])
  assert.equal(projection.byId.get('orphan').parentId, 'ghost')
  assert.equal(projection.byId.get('orphan').orphan, true)
  const cycleRoots = projection.roots.filter(node => node.id === 'cyc-a' || node.id === 'cyc-b')
  assert.equal(cycleRoots.length, 1)
  assert.equal(cycleRoots[0].parentCycle, true)
})

test('preview: a host segment of an errored or aborted turn is partial, never final', () => {
  for (const kind of ['error', 'aborted', 'blocked', 'unknown']) {
    const node = single(session('s'), {
      hostState: { previews: { s: { text: 'I was doing something', at: NOW - 2000 } }, turnEnd: { s: { at: NOW - 1000, kind } } },
    })
    assert.equal(node.preview.final, false, `${kind} is not final`)
    assert.equal(node.preview.partial, true, `${kind} is partial`)
  }
})

test('click arbitration: single click selects, double click opens once, Space previews, Enter opens', () => {
  let clock = 0
  const timers = new Map()
  let next = 1
  const log = []
  const arbiter = createClickArbiter({
    onSelect: id => log.push(['select', id]),
    onOpen: id => log.push(['open', id]),
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: clock + ms }); return id },
    clearTimer: id => timers.delete(id),
    now: () => clock,
  })
  const advance = ms => { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn() } }
  arbiter.click('a', 1)
  assert.deepEqual(log, [], 'the single click waits for a possible double click')
  advance(300)
  assert.deepEqual(log, [['select', 'a']])
  arbiter.click('b', 1)
  arbiter.click('b', 2)
  arbiter.doubleClick('b')
  arbiter.doubleClick('b')
  advance(1000)
  assert.deepEqual(log, [['select', 'a'], ['open', 'b']], 'the double click opens exactly once')
  assert.equal(arbiter.key('c', ' '), true)
  assert.equal(arbiter.key('c', 'Enter'), true)
  assert.deepEqual(log.at(-2), ['select', 'c'])
  assert.deepEqual(log.at(-1), ['open', 'c'])
})

test('store lifecycle: destroy closes the EventSource, unsubscribes and stops notifying', async () => {
  const listeners = new Set()
  let created = null
  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; created = this }
    addEventListener() {}
    close() { this.closed = true }
  }
  const ctx = {
    get(name) {
      if (name !== 'sessions') return undefined
      return { list: { getSnapshot: () => ({ phase: 'ready', ids: ['s'], byId: { s: { id: 's', displayTitle: 'S' } }, projectionsBySession: {} }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } } }
    },
  }
  const store = createBoardStore(ctx, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { mode: 'off', acks: {}, previews: {}, turnEnd: {}, assignments: [], gone: {}, health: {} } }) }),
    EventSourceImpl: FakeEventSource,
    notifyWindowMs: 0,
  })
  let notified = 0
  store.subscribe(() => { notified += 1 })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(listeners.size, 1, 'one native subscription while alive')
  store.getSnapshot()
  store.destroy()
  assert.equal(created.closed, true, 'destroy closes the stream')
  assert.equal(listeners.size, 0, 'destroy unsubscribes from the native sources')
  const before = notified
  for (const listener of [...listeners]) listener()
  assert.equal(notified, before, 'no notification after destroy')
})

test('store: a native notification storm is coalesced into one rebuild per window', async () => {
  const listeners = new Set()
  const ctx = {
    get(name) {
      if (name !== 'sessions') return undefined
      return { list: { getSnapshot: () => ({ phase: 'ready', ids: ['s'], byId: { s: { id: 's', displayTitle: 'S' } }, projectionsBySession: {} }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } } }
    },
  }
  const store = createBoardStore(ctx, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { mode: 'off', acks: {}, previews: {}, turnEnd: {}, assignments: [] } }) }),
    EventSourceImpl: undefined,
    notifyWindowMs: 25,
  })
  let notified = 0
  store.subscribe(() => { notified += 1; store.getSnapshot() })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  store.getSnapshot()
  const notifiedBefore = notified
  const rebuildsBefore = store.getStats().rebuilds
  for (let index = 0; index < 200; index += 1) for (const listener of listeners) listener()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(notified - notifiedBefore, 1, 'one notification for the burst')
  assert.equal(store.getStats().rebuilds - rebuildsBefore, 1, 'one projection rebuild for the burst')
  store.destroy()
})

// ------------------------------------------------------- review reproductions

test('BUG P1: the native turnOutline of an errored turn is labelled final', { todo: 'preview honesty: outline fallback ignores the turn-end kind' }, () => {
  const node = single(session('s', { projectionValues: { turnOutline: [{ turn: 1, response: 'I started the refactor and the provider failed' }] } }), {
    hostState: { turnEnd: { s: { at: NOW - 1000, kind: 'error', error: 'boom' } } },
  })
  assert.equal(node.status, STATUS.FAILED)
  assert.equal(node.preview.final, false, 'a response from an errored turn is not a final answer')
})

test('BUG P1: a failed/interrupted assignment checkpoint is labelled final', { todo: 'preview honesty: the checkpoint fallback never checks the assignment outcome' }, () => {
  const node = single(session('s'), {
    hostState: {
      assignments: [{
        id: 'a', sessionId: 's', status: 'failed', endedAt: NOW - 1000,
        checkpoint: { lastText: 'half done, calling a tool...', at: NOW - 2000 },
      }],
    },
  })
  assert.equal(node.status, STATUS.INTERRUPTED)
  assert.equal(node.preview.final, false, 'a mid-run checkpoint is not a final answer')
})

test('BUG P1: a native-only aborted/blocked turn becomes finished_read instead of idle', { todo: 'ARCHITECTURE 72-73: aborted/blocked turns are idle, never finished' }, () => {
  for (const reason of ['aborted', 'blocked']) {
    const node = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 2, reason } } } }))
    assert.equal(node.status, STATUS.IDLE, `native-only ${reason} must be idle, got ${node.status}`)
  }
})

test('BUG P1: a failure the host missed (stale completed end + native error) is shown as a green unread result', { todo: 'status honesty: native error must win over a stale host turn end' }, () => {
  const node = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 7, reason: 'error' } } } }), {
    hostState: { turnEnd: { s: { at: NOW - 90_000, kind: 'completed' } } },
  })
  assert.equal(node.status, STATUS.FAILED, 'the newer native failure must not be hidden by an older completed end')
})

test('BUG P1: an unknown or recovered turn end becomes a green finished_unread result', { todo: 'status honesty: only a completed turn end can be an unread result' }, () => {
  const unknownKind = single(session('s'), { hostState: { turnEnd: { s: { at: NOW - 1000, kind: 'unknown' } } } })
  assert.notEqual(unknownKind.status, STATUS.FINISHED_UNREAD, 'kind unknown is not a completed result')
  assert.equal(unknownKind.unread, false)
  const recovered = single(session('s'), { hostState: { turnEnd: { s: { at: NOW - 5000, kind: 'error', recoveredAt: NOW - 1000 } } } })
  assert.notEqual(recovered.status, STATUS.FINISHED_UNREAD, 'a recovered error is not a completed result')
})

test('BUG P2: a native-only failure can never be acknowledged (seen stays false forever)', { todo: 'the host persists acks[id].lastTurnEnd but the projection never reads it for native ends' }, () => {
  const node = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 1, reason: 'error' } } } }), {
    hostState: { acks: { s: { seenAt: NOW, lastTurnEnd: null } } },
  })
  assert.equal(node.status, STATUS.FAILED)
  assert.equal(node.seen, true, 'an explicit ack must clear the attention flag')
})

test('BUG P2: a native completionUnread cannot be acked when the row has no updatedAt', { todo: 'ack must clear the green pill without requiring a timestamp on the row' }, () => {
  const node = single({ id: 's', displayTitle: 's', running: false }, {
    statusMap: new Map([['s', { completionUnread: true }]]),
    hostState: { acks: { s: { seenAt: NOW } } },
  })
  assert.notEqual(node.status, STATUS.FINISHED_UNREAD, 'the persisted ack must clear the native unread flag')
})

test('BUG P2: an interrupted assignment without timestamps can never be seen', { todo: 'ack must clear an interrupted card even without endedAt/startedAt' }, () => {
  const node = single(session('s'), {
    hostState: { assignments: [{ id: 'a', sessionId: 's', status: 'stopped', reason: 'operator' }], acks: { s: { seenAt: NOW } } },
  })
  assert.equal(node.status, STATUS.INTERRUPTED)
  assert.equal(node.seen, true)
})

test('BUG P2: a board assignment route change is recorded as a NATIVE model change', { todo: 'model history provenance: assignment route changes are not native model/selection events' }, () => {
  const memory = new Map()
  const row = session('s', { projectionValues: SELECTION('p', 'm1') })
  trackModelChange(memory, 's', resolveNodeModel({ sessionId: 's', row }), NOW)
  const assignment = { model: { provider: 'backup', model: 'm2' } }
  const entry = trackModelChange(memory, 's', resolveNodeModel({ sessionId: 's', row, assignment }), NOW + 1)
  assert.ok(entry === null || entry.source === 'assignment', `a board route is not a native model change (got ${JSON.stringify(entry)})`)
})

test('BUG P2: resolveNodeModel ignores the documented native-first precedence', { todo: 'contract conflict: the function doc says native then assignment; code and existing tests do the opposite' }, () => {
  const row = session('s', { projectionValues: SELECTION('native-p', 'native-m') })
  const resolved = resolveNodeModel({ sessionId: 's', row, assignment: { model: { provider: 'backup', model: 'm2' } } })
  assert.equal(resolved.source, 'native', 'documented precedence is injected/native first, assignment second')
  assert.equal(resolved.model, 'native-m')
})

test('BUG P2: an archived unread result stays on the default attention view', { todo: 'board/view.js policy says archived is history, but isAttention/includedByFilter ignore it' }, () => {
  const node = single(session('arch'), {
    hostState: { turnEnd: { arch: { at: NOW - 500, kind: 'completed' } } },
    workspaces: { items: [], archivedSessionIds: ['arch'] },
  })
  assert.equal(node.archived, true)
  assert.equal(includedByFilter(node, 'attention', NOW), false, 'an archived session is history, not attention')
})

test('BUG P2: a stale gone tombstone keeps a resurrected live session unknown', { todo: 'gone is never expired/reconciled against a live row' }, () => {
  const node = project({
    list: listOf([session('s', { running: true, updatedAt: NOW })]),
    statusMap: new Map([['s', { running: true }]]),
    hostState: { gone: { s: NOW - 60_000 } },
  }).byId.get('s')
  assert.notEqual(node.status, STATUS.UNKNOWN, 'a live running row is stronger evidence than an old removal fact')
})

test('BUG P2: a valid JSON SSE frame that is not a host state replaces (or crashes) the store', { todo: 'applyStreamFrame accepts any object; buildProjection then iterates assignments' }, async () => {
  const listeners = new Set()
  let created = null
  class FakeEventSource { constructor() { created = this } addEventListener() {} close() {} }
  const ctx = {
    get(name) {
      if (name !== 'sessions') return undefined
      return { list: { getSnapshot: () => ({ phase: 'ready', ids: ['s'], byId: { s: { id: 's', displayTitle: 'S' } }, projectionsBySession: {} }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } } }
    },
  }
  const hostState = { mode: 'supervised', acks: { s: { seenAt: 1 } }, previews: {}, turnEnd: { s: { at: 5, kind: 'completed' } }, assignments: [], health: {}, gone: {} }
  const store = createBoardStore(ctx, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: hostState }) }),
    EventSourceImpl: FakeEventSource,
    notifyWindowMs: 0,
  })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(store.getSnapshot().projection.byId.get('s').status, STATUS.FINISHED_READ)
  created.onmessage({ data: '{"hello":1}' })
  assert.equal(store.getHost().mode, 'supervised', 'an unrelated JSON object must not replace the host state')
  created.onmessage({ data: '{"assignments":{}}' })
  assert.doesNotThrow(() => store.getSnapshot(), 'a malformed frame must never break the projection')
  store.destroy()
})
