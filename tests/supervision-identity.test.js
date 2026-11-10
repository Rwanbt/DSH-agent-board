/**
 * Agent identity and hierarchy anomalies.
 *
 *   - one card per SESSION id: a model change updates the chip and appends to
 *     the visible route history, it never creates a second card;
 *   - a model is a fact: native `modelSelection` or the board assignment that
 *     launched the card. Nothing is guessed from the deployment default;
 *   - orphan / cycle / two-catalog claims are deterministic and flagged, never
 *     silently re-parented.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProjection,
  classifyStatusDetailed,
  flattenVisible,
  mergeRouteHistory,
  modelHistoryOf,
  modelLabelOf,
  nativeModelOf,
  normalizeModelInfo,
  resolveNodeModel,
  trackModelChange,
} from '../src/supervisor/projection.js'
import { createBoardStore } from '../src/client/core.js'
import { STATUS } from '../src/contracts/model.js'

const NOW = 1_800_000_000_000

function session(id, extra = {}) {
  return { id, displayTitle: id, running: false, updatedAt: NOW - 60_000, cwd: 'D:\\App\\proj', ...extra }
}

function project(input) {
  return buildProjection({ list: { ids: [], byId: {}, projectionsBySession: {} }, statusMap: new Map(), hostState: {}, now: NOW, ...input })
}

function listOf(row, extra = {}) {
  return { ids: [row.id], byId: { [row.id]: row }, projectionsBySession: {}, ...extra }
}

const SELECTION = (provider, model, reasoningEffort) => ({ modelSelection: { lastUsed: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } } })

test('native modelSelection is the only native source; nothing else is used as a guess', () => {
  const known = project({ list: listOf(session('s', { projectionValues: SELECTION('opencode-go', 'deepseek-v4.1-flash', 'high') })) })
  assert.deepEqual(known.byId.get('s').model, { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', source: 'native' })
  assert.equal(known.byId.get('s').modelSource, 'native')

  // These fields exist on real rows but are NOT the model projection: a card
  // must stay unknown instead of showing a plausible-looking default.
  const unknown = project({ list: listOf(session('s', {
    model: { provider: 'default', model: 'deployment-default' },
    header: { model: 'deployment-default' },
    projectionValues: { modelSelection: { lastUsed: null, next: { provider: 'next', model: 'pending' } } },
  })) })
  assert.deepEqual(unknown.byId.get('s').model, { provider: null, model: null, reasoningEffort: null, source: 'unknown' })
  assert.equal(unknown.byId.get('s').modelSource, 'unknown')

  // The projectionsBySession channel carries the same native projection value.
  const viaProjection = project({
    list: { ids: ['s'], byId: { s: session('s') }, projectionsBySession: { s: { values: { modelSelection: { lastUsed: { provider: 'p', model: 'm' } } } } } },
  })
  assert.equal(viaProjection.byId.get('s').model.model, 'm')
})

test('a board assignment supplies the model of a board card, never of a native session', () => {
  const assignment = { id: 'a', sessionId: 's', status: 'done', model: { provider: 'backup', model: 'medium' } }
  const boardCard = project({
    list: listOf(session('s', { projectionValues: SELECTION('native-p', 'native-m') })),
    hostState: { assignments: [assignment] },
  }).byId.get('s')
  assert.equal(boardCard.model.provider, 'backup')
  assert.equal(boardCard.model.source, 'assignment', 'the launched route is a real fact about this card')

  // Another session's assignment must not leak onto a native card.
  const nativeCard = project({
    list: { ids: ['s', 'other'], byId: { s: session('s', { projectionValues: SELECTION('native-p', 'native-m') }), other: session('other') }, projectionsBySession: {} },
    hostState: { assignments: [{ ...assignment, sessionId: 'other' }] },
  }).byId.get('s')
  assert.equal(nativeCard.model.provider, 'native-p')
  assert.equal(nativeCard.model.source, 'native')
})

test('an injected modelOf resolver is authoritative, and its absence/failure means unknown', () => {
  const row = session('s', { projectionValues: SELECTION('native-p', 'native-m') })
  const injected = project({ list: listOf(row), modelOf: (sessionId) => (sessionId === 's' ? { provider: 'host-p', model: 'host-m' } : null) })
  assert.deepEqual(injected.byId.get('s').model, { provider: 'host-p', model: 'host-m', reasoningEffort: null, source: 'native' })
  // The resolver receives the id first and the row second.
  const seen = []
  project({ list: listOf(row), modelOf: (sessionId, sessionRow) => { seen.push([sessionId, sessionRow?.id]); return null } })
  assert.deepEqual(seen, [['s', 's']])
  // null does not fall back to the row value: the host said "unknown".
  assert.equal(project({ list: listOf(row), modelOf: () => null }).byId.get('s').modelSource, 'unknown')
  // A throwing resolver must not break the board.
  assert.equal(project({ list: listOf(row), modelOf: () => { throw new Error('boom') } }).byId.get('s').modelSource, 'unknown')
})

test('normalizeModelInfo accepts the documented shapes and rejects garbage', () => {
  assert.deepEqual(normalizeModelInfo('a/b'), { provider: 'a', model: 'b', reasoningEffort: null })
  assert.deepEqual(normalizeModelInfo({ provider: 'a', model: 'b' }), { provider: 'a', model: 'b', reasoningEffort: null })
  assert.deepEqual(normalizeModelInfo({ id: 'b' }), { provider: null, model: 'b', reasoningEffort: null })
  assert.equal(normalizeModelInfo(null), null)
  assert.equal(normalizeModelInfo({}), null)
  assert.equal(normalizeModelInfo({ provider: '', model: '' }), null)
  assert.equal(normalizeModelInfo(42), null)
  assert.deepEqual(nativeModelOf({ projectionValues: SELECTION('p', 'm') }), { provider: 'p', model: 'm', reasoningEffort: null })
  assert.equal(nativeModelOf({}), null)
  assert.equal(modelLabelOf({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(modelLabelOf({ provider: null, model: null }), null)
})

test('resolveNodeModel: assignment first for board cards, native otherwise, null when unknown', () => {
  const native = resolveNodeModel({ sessionId: 's', row: session('s', { projectionValues: SELECTION('p', 'm') }) })
  assert.equal(native.source, 'native')
  const assigned = resolveNodeModel({ sessionId: 's', row: session('s'), assignment: { model: { provider: 'x', model: 'y' } } })
  assert.equal(assigned.source, 'assignment')
  const unknown = resolveNodeModel({ sessionId: 's', row: session('s') })
  assert.equal(unknown.source, 'unknown')
  assert.equal(unknown.provider, null)
})

test('a model change keeps ONE card and appends to its visible route history', () => {
  const first = project({ list: listOf(session('s', { projectionValues: SELECTION('p', 'm1') })) })
  assert.equal(first.nodes.length, 1)
  assert.equal(first.byId.get('s').model.model, 'm1')
  assert.deepEqual(first.byId.get('s').routeHistory, [])

  const change = { from: 'p/m1', to: 'p/m2', at: NOW - 1000, reason: 'model_change', source: 'native' }
  const second = project({
    list: listOf(session('s', { projectionValues: SELECTION('p', 'm2') })),
    modelHistory: { s: [change] },
  })
  assert.equal(second.nodes.length, 1, 'identity is the session id, not the model')
  assert.equal(second.byId.get('s').id, 's')
  assert.equal(second.byId.get('s').model.model, 'm2')
  assert.deepEqual(second.byId.get('s').routeHistory, [change])
})

test('board route history and native model changes are merged without duplicates', () => {
  const skipped = { from: 'p/m1', to: 'p/m2', at: NOW - 1000, reason: 'switch_after_server_error' }
  const node = project({
    list: listOf(session('s', { projectionValues: SELECTION('p', 'm2') })),
    hostState: { assignments: [{ id: 'a', sessionId: 's', status: 'running', routeHistory: [skipped] }] },
    modelHistory: { s: [skipped, { from: 'p/m2', to: 'q/m3', at: NOW, reason: 'model_change' }] },
  }).byId.get('s')
  assert.equal(node.routeHistory.length, 2)
  assert.equal(node.routeHistory[0].reason, 'switch_after_server_error')
  assert.equal(node.routeHistory[1].to, 'q/m3')
  assert.deepEqual(mergeRouteHistory([skipped], [skipped]), [skipped])
})

test('trackModelChange records only real transitions, bounded, and never changes identity', () => {
  const memory = new Map()
  assert.equal(trackModelChange(memory, 's', { provider: 'p', model: 'm1' }, NOW), null, 'the first observation is not a change')
  const entry = trackModelChange(memory, 's', { provider: 'p', model: 'm2' }, NOW + 1)
  assert.deepEqual(entry, { from: 'p/m1', to: 'p/m2', at: NOW + 1, reason: 'model_change', source: 'native' })
  assert.equal(trackModelChange(memory, 's', { provider: 'p', model: 'm2' }, NOW + 2), null, 're-observing the same model is not a change')
  assert.equal(trackModelChange(memory, 's', { provider: null, model: null }, NOW + 3), null, 'unknown is not a model change')
  for (let index = 0; index < 20; index += 1) trackModelChange(memory, 's', { provider: 'p', model: `m${index + 10}` }, NOW + 10 + index)
  assert.equal(memory.get('s').entries.length, 8, 'the visible history is bounded')
  assert.equal(memory.get('s').last, 'p/m29')
  assert.deepEqual(Object.keys(modelHistoryOf(memory)), ['s'])
  assert.deepEqual(modelHistoryOf(null), {})
})

test('client store: a native model change updates the chip and the history of the same card', async () => {
  const state = {
    current: {
      phase: 'ready',
      ids: ['s'],
      byId: { s: { id: 's', displayTitle: 'Agent', running: false, projectionValues: SELECTION('p', 'm1') } },
      projectionsBySession: {},
    },
  }
  const listeners = new Set()
  const ctx = {
    get(name) {
      if (name !== 'sessions') return undefined
      return {
        list: {
          getSnapshot: () => state.current,
          subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        },
      }
    },
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) })
  const store = createBoardStore(ctx, { fetchImpl, notifyWindowMs: 0 })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const first = store.getSnapshot().projection
  assert.equal(first.nodes.length, 1)
  assert.equal(first.byId.get('s').model.model, 'm1')
  assert.deepEqual(first.byId.get('s').routeHistory, [])

  // Same session id, new native selection -> SAME card, new chip, new history entry.
  state.current = {
    ...state.current,
    byId: { s: { id: 's', displayTitle: 'Agent', running: false, projectionValues: SELECTION('p', 'm2') } },
  }
  for (const listener of listeners) listener()
  const second = store.getSnapshot().projection
  assert.equal(second.nodes.length, 1, 'no duplicate card after a model change')
  assert.equal(second.byId.get('s').id, 's')
  assert.equal(second.byId.get('s').model.model, 'm2')
  const history = second.byId.get('s').routeHistory
  assert.equal(history.length, 1)
  assert.equal(history[0].from, 'p/m1')
  assert.equal(history[0].to, 'p/m2')
  assert.equal(history[0].reason, 'model_change')
  store.destroy()
})

test('orphan: unknown parent is kept and flagged, never silently re-parented', () => {
  const projection = project({
    list: { ids: ['child'], byId: { child: session('child', { parentId: 'ghost', origin: 'subagent' }) }, projectionsBySession: {} },
  })
  const child = projection.byId.get('child')
  assert.equal(child.parentId, 'ghost')
  assert.equal(child.orphan, true)
  assert.equal(child.parentSource, 'session_row')
  assert.equal(child.parentReason, 'orphan_parent')
  assert.match(child.statusReason, /orphan_parent$/)
  assert.deepEqual(projection.roots.map(node => node.id), ['child'])
  assert.deepEqual(flattenVisible(projection.roots, projection.byId).map(entry => entry.node.id), ['child'])
})

test('cycle: broken deterministically at the smallest id, whatever the input order', () => {
  const run = ids => {
    const byId = { 'cyc-a': session('cyc-a', { parentId: 'cyc-b' }), 'cyc-b': session('cyc-b', { parentId: 'cyc-a' }) }
    return project({ list: { ids, byId, projectionsBySession: {} } })
  }
  for (const ids of [['cyc-a', 'cyc-b'], ['cyc-b', 'cyc-a']]) {
    const projection = run(ids)
    const a = projection.byId.get('cyc-a')
    const b = projection.byId.get('cyc-b')
    assert.equal(a.parentCycle, true, 'the smallest id of the cycle is the break point')
    assert.equal(a.parentId, 'cyc-b', 'the claim is kept, not re-parented')
    assert.equal(a.parentReason, 'cycle_detected')
    assert.match(a.statusReason, /cycle_detected$/)
    assert.equal(b.parentCycle, undefined)
    assert.deepEqual(projection.roots.map(node => node.id), ['cyc-a'])
    assert.deepEqual(a.children, ['cyc-b'])
    assert.deepEqual(flattenVisible(projection.roots, projection.byId).map(entry => entry.node.id), ['cyc-a', 'cyc-b'])
  }
  // A self-parent is a one-node cycle.
  const self = project({ list: { ids: ['loop'], byId: { loop: session('loop', { parentId: 'loop' }) }, projectionsBySession: {} } })
  assert.equal(self.byId.get('loop').parentCycle, true)
  assert.equal(self.byId.get('loop').parentId, 'loop')
  assert.equal(self.byId.get('loop').children.length, 0)
})

test('two catalogs claiming one child: deterministic parent, contested flag, no duplicate card', () => {
  const build = (order) => {
    const projectionsBySession = {}
    for (const parent of order) projectionsBySession[parent] = { values: { subagentCatalog: [{ sessionId: 'c', title: `from ${parent}` }] } }
    return project({
      list: { ids: ['p1', 'p2'], byId: { p1: session('p1'), p2: session('p2') }, projectionsBySession },
    })
  }
  for (const order of [['p1', 'p2'], ['p2', 'p1']]) {
    const projection = build(order)
    const child = projection.byId.get('c')
    assert.equal(projection.nodes.filter(node => node.id === 'c').length, 1, 'one card, not one per catalog')
    assert.equal(child.parentId, 'p1', 'the smallest claiming parent is chosen deterministically')
    assert.equal(child.parentSource, 'subagent_catalog')
    assert.equal(child.parentContested, true)
    assert.deepEqual(child.parentCandidates, ['p1', 'p2'])
    assert.equal(child.parentReason, 'contested_parents')
    assert.match(child.statusReason, /contested_parents$/)
    assert.deepEqual(projection.byId.get('p1').children, ['c'])
    assert.deepEqual(projection.byId.get('p2').children, [])
  }
})

test('a row and a catalog disagreeing is flagged, and the session row wins', () => {
  const projection = project({
    list: {
      ids: ['p1', 'p2', 'c'],
      byId: { p1: session('p1'), p2: session('p2'), c: session('c', { parentId: 'p1', origin: 'subagent' }) },
      projectionsBySession: { p2: { values: { subagentCatalog: [{ sessionId: 'c' }] } } },
    },
  })
  const child = projection.byId.get('c')
  assert.equal(child.parentId, 'p1')
  assert.equal(child.parentSource, 'session_row')
  assert.equal(child.parentContested, true)
  assert.deepEqual(child.parentCandidates, ['p2'])
})

test('hierarchy linking stays linear on a deep chain (2000 nodes)', () => {
  const count = 2000
  const ids = []
  const byId = {}
  for (let index = 0; index < count; index += 1) {
    const id = `n${String(index).padStart(4, '0')}`
    ids.push(id)
    byId[id] = session(id, index === 0 ? {} : { parentId: `n${String(index - 1).padStart(4, '0')}`, origin: 'subagent' })
  }
  const started = performance.now()
  const projection = project({ list: { ids, byId, projectionsBySession: {} } })
  const elapsed = performance.now() - started
  assert.equal(projection.nodes.length, count)
  assert.equal(projection.roots.length, 1)
  assert.equal(projection.roots[0].id, 'n0000')
  assert.equal(flattenVisible(projection.roots, projection.byId).length, count)
  assert.ok(elapsed < 1500, `a 2000-deep chain took ${elapsed.toFixed(1)} ms`)
})

test('a status is still decided only by real inputs after the hierarchy pass', () => {
  const detail = classifyStatusDetailed({ row: session('s', { running: true }), live: undefined, turnEnd: null, ack: null, assignment: null })
  assert.equal(detail.status, STATUS.RUNNING)
})
