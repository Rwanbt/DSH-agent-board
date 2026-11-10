/**
 * Status completeness for the supervision cockpit: every new status must come
 * from a REAL input, and the forbidden ones must be impossible to produce.
 *
 *   - interrupted          <- assignment/lease facts already in hostState
 *   - provider_unavailable  <- an injected provider-health table, in cooldown
 *   - recentlyFinished      <- a real turn-end timestamp, a VIEW flag only
 *   - deleted / unavailable <- unknown/unavailable with a reason, never finished
 *   - waiting_agent         <- deliberately absent: no trustworthy native signal
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProjection,
  classifyStatusDetailed,
  providerOutageOf,
  RECENT_FINISHED_MS,
} from '../src/supervisor/projection.js'
import { STATUS, STATUS_VALUES } from '../src/contracts/model.js'
import { buildBoardView, boardCounts, isAttention } from '../src/board/view.js'

const NOW = 1_800_000_000_000

function session(id, extra = {}) {
  return { id, displayTitle: id, running: false, updatedAt: NOW - 60_000, cwd: 'D:\\App\\proj', ...extra }
}

function project(input) {
  return buildProjection({ list: { ids: [], byId: {}, projectionsBySession: {} }, statusMap: new Map(), hostState: {}, now: NOW, ...input })
}

function single(row, extra = {}) {
  return project({
    list: { ids: [row.id], byId: { [row.id]: row }, projectionsBySession: {} },
    statusMap: extra.statusMap ?? new Map(),
    hostState: extra.hostState ?? {},
  }).byId.get(row.id)
}

const NATIVE_MODEL = { modelSelection: { lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } }

test('every terminal-negative assignment status becomes interrupted with its own reason', () => {
  for (const status of ['interrupted', 'failed', 'stopped', 'superseded']) {
    const node = single(session('s'), {
      hostState: {
        assignments: [{ id: 'a1', sessionId: 's', status, reason: 'lease_expired', startedAt: NOW - 5000, endedAt: NOW - 1000 }],
      },
    })
    assert.equal(node.status, STATUS.INTERRUPTED, `${status} is interrupted, never finished/idle`)
    assert.equal(node.interrupted, true)
    assert.equal(node.statusSource, 'assignment')
    assert.equal(node.statusAt, NOW - 1000)
    assert.match(node.statusReason, new RegExp(`assignment:${status}:lease_expired`))
  }
})

test('a turn end NEWER than the assignment wins: a resumed session is not interrupted', () => {
  const node = single(session('s'), {
    hostState: {
      assignments: [{ id: 'a1', sessionId: 's', status: 'interrupted', endedAt: NOW - 5000 }],
      turnEnd: { s: { at: NOW - 1000, kind: 'completed' } },
    },
  })
  assert.equal(node.status, STATUS.FINISHED_UNREAD)
})

test('provider_unavailable comes only from an injected cooldown, with reason and deadline', () => {
  const hostState = {
    turnEnd: { s: { at: NOW - 2000, kind: 'error', error: 'rate limited' } },
    health: {
      'opencode-go': { failures: 2, lastFailureKind: 'rate_limit', lastFailureAt: NOW - 2000, cooldownUntil: NOW + 60_000 },
    },
  }
  const node = single(session('s', { updatedAt: NOW - 3000, projectionValues: NATIVE_MODEL }), { hostState })
  assert.equal(node.status, STATUS.PROVIDER_UNAVAILABLE)
  assert.equal(node.providerUnavailable, true)
  assert.equal(node.statusSource, 'host_health')
  assert.match(node.statusReason, /^provider_cooldown:opencode-go:rate_limit:until:/)
  assert.ok(node.statusReason.includes(new Date(NOW + 60_000).toISOString()), 'the reason carries cooldownUntil')
  assert.equal(node.statusAt, NOW - 2000)
  assert.equal(node.healthUntil, NOW + 60_000)
})

test('without health, or outside the cooldown, a failed turn stays failed', () => {
  const turnEnd = { s: { at: NOW - 2000, kind: 'error', error: 'boom' } }
  const row = session('s', { projectionValues: NATIVE_MODEL })
  assert.equal(single(row, { hostState: { turnEnd } }).status, STATUS.FAILED, 'no health table injected')
  assert.equal(
    single(row, { hostState: { turnEnd, health: { 'opencode-go': { cooldownUntil: NOW - 1, lastFailureAt: NOW - 3000 } } } }).status,
    STATUS.FAILED,
    'an expired cooldown is not an outage',
  )
  assert.equal(
    single(row, { hostState: { turnEnd, health: { 'other-provider': { cooldownUntil: NOW + 60_000 } } } }).status,
    STATUS.FAILED,
    'a cooldown on another provider does not apply',
  )
  // The session moved on after the outage was observed -> not blocked by it.
  const moved = single(session('s', { updatedAt: NOW - 500, projectionValues: NATIVE_MODEL }), {
    hostState: { turnEnd, health: { 'opencode-go': { cooldownUntil: NOW + 60_000, lastFailureAt: NOW - 5000 } } },
  })
  assert.equal(moved.status, STATUS.FAILED)
  // Unknown provider cannot be attributed to any cooling provider.
  assert.equal(
    single(session('s'), { hostState: { turnEnd, health: { 'opencode-go': { cooldownUntil: NOW + 60_000, lastFailureAt: NOW - 2000 } } } }).status,
    STATUS.FAILED,
  )
})

test('providerOutageOf is defensive: no table, no provider, stale cooldown, newer activity', () => {
  assert.equal(providerOutageOf(null, 'p', { now: NOW }), null)
  assert.equal(providerOutageOf({}, 'p', { now: NOW }), null)
  assert.equal(providerOutageOf({ p: { cooldownUntil: NOW + 1 } }, null, { now: NOW }), null)
  assert.equal(providerOutageOf({ p: { cooldownUntil: NOW } }, 'p', { now: NOW }), null, 'a cooldown that ends now is over')
  assert.equal(providerOutageOf({ p: { cooldownUntil: NOW + 1000, lastFailureAt: NOW - 10 } }, 'p', { now: NOW, sessionAt: NOW }), null)
  const outage = providerOutageOf({ p: { cooldownUntil: NOW + 1000 } }, 'p', { now: NOW })
  assert.equal(outage.kind, 'unknown')
  assert.equal(outage.at, null)
})

test('recentlyFinished is a bounded view flag from a real turn end, never a status', () => {
  const completed = (at) => single(session('s'), { hostState: { turnEnd: { s: { at, kind: 'completed' } } } })
  const recent = completed(NOW - 30_000)
  assert.equal(recent.recentlyFinished, true)
  assert.equal(recent.finishedAt, NOW - 30_000)
  assert.equal(recent.status, STATUS.FINISHED_UNREAD, 'the status comes from the ack, not from the flag')
  assert.equal(completed(NOW - RECENT_FINISHED_MS - 1).recentlyFinished, false, 'outside the window')
  assert.equal(completed(NOW - 30_000).recentlyFinished, true)
  assert.equal(
    project({
      list: { ids: ['s'], byId: { s: session('s') }, projectionsBySession: {} },
      statusMap: new Map(),
      hostState: { turnEnd: { s: { at: NOW - 90_000, kind: 'completed' } } },
      recentWindowMs: 60_000,
    }).byId.get('s').recentlyFinished,
    false,
    'the window is configurable and bounded',
  )
  // An error/aborted/absent turn is not a finish.
  assert.equal(single(session('s'), { hostState: { turnEnd: { s: { at: NOW - 1000, kind: 'error' } } } }).recentlyFinished, false)
  assert.equal(single(session('s'), { hostState: { turnEnd: { s: { at: NOW - 1000, kind: 'aborted' } } } }).recentlyFinished, false)
  assert.equal(single(session('s')).recentlyFinished, false)
  // A native-only turn end has no timestamp: it can never be "recent".
  const nativeOnly = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 1, reason: 'completed' } } } }))
  assert.equal(nativeOnly.status, STATUS.FINISHED_READ)
  assert.equal(nativeOnly.recentlyFinished, false, 'elapsed time alone never makes a card "recent"')
  // Reading it does not turn the flag off: it is a view fact, not the status.
  const read = single(session('s'), { hostState: { turnEnd: { s: { at: NOW - 30_000, kind: 'completed' } }, acks: { s: { seenAt: NOW - 10_000 } } } })
  assert.equal(read.status, STATUS.FINISHED_READ)
  assert.equal(read.recentlyFinished, true)
  assert.equal(STATUS_VALUES.includes('recentlyFinished'), false)
})

test('a deleted session is unknown with a reason, never finished', () => {
  // The runtime row is gone but the host journal still holds a turn end and the
  // native status map still says "unread".
  const list = { ids: ['p'], byId: { p: session('p') }, projectionsBySession: { p: { values: { subagentCatalog: [{ sessionId: 's' }] } } } }
  const statusMap = new Map([['s', { completionUnread: true }]])
  const hostState = { turnEnd: { s: { at: NOW - 2000, kind: 'completed' } } }
  const ghost = project({ list, statusMap, hostState }).byId.get('s')
  assert.equal(ghost.status, STATUS.UNKNOWN)
  assert.equal(ghost.statusReason.includes('finished'), false)
  assert.equal(ghost.seen, true)
  // With the explicit host fact, the reason says it is gone.
  const gone = project({ list, statusMap, hostState: { ...hostState, gone: { s: NOW - 1000 } } }).byId.get('s')
  assert.equal(gone.status, STATUS.UNKNOWN)
  assert.equal(gone.statusReason, 'session_gone')
  assert.equal(gone.statusSource, 'host_registry')
  assert.equal(gone.statusAt, NOW - 1000)
  assert.equal(gone.gone, true)
})

test('an unavailable agent is unavailable even after a completed turn, never finished', () => {
  const node = single(session('s', { agentAvailable: false }), {
    hostState: { turnEnd: { s: { at: NOW - 1000, kind: 'completed' } } },
  })
  assert.equal(node.status, STATUS.UNAVAILABLE)
  assert.equal(node.statusReason, 'agent_not_available')
  assert.equal(node.unread, false)
  assert.equal(node.recentlyFinished, true, 'the historical fact is still exposed')
})

test('waiting_agent is impossible by construction: the native sources carry no such signal', () => {
  assert.equal(STATUS_VALUES.includes('waiting_agent'), false, 'the status vocabulary stays closed')
  // A parent awaiting children is still `running` in every native source.
  const parent = single(session('p', { running: true }), {
    list: {
      ids: ['p', 'c'],
      byId: {
        p: session('p', { running: true }),
        c: session('c', { parentId: 'p', origin: 'subagent', running: true }),
      },
      projectionsBySession: { p: { values: { subagentCatalog: [{ sessionId: 'c', status: 'running' }] } } },
    },
    statusMap: new Map([['p', { running: true }], ['c', { running: true }]]),
  })
  assert.equal(parent.status, STATUS.RUNNING)
  assert.notEqual(parent.status, 'waiting_agent')
  // No fabricated status field can produce it either: no branch reads one.
  for (const live of [
    { running: true },
    { waitingForAgent: { sessionId: 'c' } },
    { waitingChildren: ['c'] },
    { subagentWait: true },
    { pendingInteraction: { kind: 'question' } },
    {},
  ]) {
    const detail = classifyStatusDetailed({ row: session('p'), live, turnEnd: null, ack: null, assignment: null })
    assert.notEqual(detail.status, 'waiting_agent')
    assert.ok(STATUS_VALUES.includes(detail.status), `${detail.status} is a documented status`)
  }
})

test('an acknowledged interrupted launch leaves the home view but keeps its status', () => {
  const list = { ids: ['s'], byId: { s: session('s') }, projectionsBySession: {} }
  const assignments = [{ id: 'a1', sessionId: 's', status: 'stopped', reason: 'stopped_by_operator', endedAt: NOW - 1000 }]
  const unread = project({ list, statusMap: new Map(), hostState: { assignments } }).byId.get('s')
  assert.equal(unread.status, STATUS.INTERRUPTED)
  assert.equal(unread.seen, false)
  assert.equal(isAttention(unread), true)
  const acked = project({ list, statusMap: new Map(), hostState: { assignments, acks: { s: { seenAt: NOW - 500 } } } })
  assert.equal(acked.byId.get('s').status, STATUS.INTERRUPTED, 'reading is not finishing')
  assert.equal(acked.byId.get('s').seen, true)
  assert.equal(isAttention(acked.byId.get('s')), false)
  const view = buildBoardView(acked, { now: NOW })
  assert.equal(view.projects.length, 0, 'nothing left to treat on the home view')
})

test('a native turn end the host missed wins over a stale completed host end', () => {
  const stale = { s: { at: NOW - 90_000, kind: 'completed' } }
  // A native failure is never hidden by the stale completion.
  const failed = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 7, reason: 'error' } } } }), { hostState: { turnEnd: stale } })
  assert.equal(failed.status, STATUS.FAILED)
  assert.equal(failed.statusReason, 'native_turn_end:error')
  assert.equal(failed.seen, false)
  // Neither is a native non-completion (it is history, not a fresh result).
  for (const reason of ['aborted', 'blocked']) {
    const node = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 7, reason } } } }), { hostState: { turnEnd: stale } })
    assert.equal(node.status, STATUS.IDLE, `native ${reason} must not inherit the stale completion`)
    assert.match(node.statusReason, new RegExp(`native_turn_ended:${reason}`))
    assert.equal(node.recentlyFinished, false)
  }
  // An explicit ack covers a native-only failure (there is no timestamp to compare).
  const acked = single(session('s', { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 7, reason: 'error' } } } }), {
    hostState: { turnEnd: stale, acks: { s: { seenAt: NOW, lastTurnEnd: null } } },
  })
  assert.equal(acked.status, STATUS.FAILED)
  assert.equal(acked.seen, true)
})

test('the new statuses are attention, counted apart from history, and ordered deterministically', () => {
  const byId = {
    interrupted: session('interrupted'),
    outage: session('outage', { projectionValues: NATIVE_MODEL, updatedAt: NOW - 3000 }),
    unread: session('unread'),
    read: session('read'),
  }
  const projection = project({
    list: { ids: Object.keys(byId), byId, projectionsBySession: {} },
    statusMap: new Map(),
    hostState: {
      assignments: [{ id: 'a', sessionId: 'interrupted', status: 'stopped', reason: 'stopped_by_operator', endedAt: NOW - 1000 }],
      turnEnd: {
        outage: { at: NOW - 2000, kind: 'error' },
        unread: { at: NOW - 1000, kind: 'completed' },
        read: { at: NOW - 5000, kind: 'completed' },
      },
      acks: { read: { seenAt: NOW - 4000 } },
      health: { 'opencode-go': { cooldownUntil: NOW + 60_000, lastFailureAt: NOW - 2000 } },
    },
  })
  assert.equal(projection.byId.get('interrupted').status, STATUS.INTERRUPTED)
  assert.equal(projection.byId.get('outage').status, STATUS.PROVIDER_UNAVAILABLE)
  for (const id of ['interrupted', 'outage']) {
    assert.equal(isAttention(projection.byId.get(id)), true, `${id} demands attention`)
  }
  const counts = boardCounts(projection)
  assert.equal(counts.interrupted, 1)
  assert.equal(counts.provider_unavailable, 1)
  assert.equal(counts.history, 1, 'the read session is the only history entry')
  assert.equal(projection.counts.interrupted, 1)
  assert.equal(projection.counts.provider_unavailable, 1)
  const view = buildBoardView(projection, { now: NOW })
  const shown = view.projects.flatMap(entry => entry.trees).map(tree => tree.node.id)
  assert.ok(shown.includes('interrupted'))
  assert.ok(shown.includes('outage'))
  assert.ok(!shown.includes('read'), 'a read result stays history')
})
