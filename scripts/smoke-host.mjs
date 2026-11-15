#!/usr/bin/env node
/**
 * Dependency-free smoke check.
 *
 * Projects a synthetic session snapshot through the real supervisor and runs
 * one real orchestration tick decision against a synthetic Task Board ledger.
 * It is a fast "did the modules still load and agree" check — the full suite is
 * `node --test tests/`.
 */

import assert from 'node:assert/strict'

import { buildProjection } from '../src/supervisor/projection.js'
import { selectDispatchable } from '../src/orchestrator/dag.js'
import { normalizePolicy, normalizePolicy as normalizeConc, MODES, STATUS } from '../src/contracts/model.js'

const projection = buildProjection({
  list: {
    phase: 'ready',
    ids: ['root', 'child'],
    byId: {
      root: { id: 'root', displayTitle: 'Root session', running: true, cwd: 'D:\\App\\demo' },
      child: { id: 'child', parentId: 'root', displayTitle: 'Child agent', origin: 'subagent', cwd: 'D:\\App\\demo' },
    },
    projectionsBySession: { root: { values: { subagentCatalog: [{ sessionId: 'child' }] } } },
  },
  statusMap: new Map([['child', { pendingInteraction: { kind: 'question' } }]]),
  hostState: { previews: { root: { text: 'Working on it.', at: 1 } } },
  workspaces: { items: [{ id: 'w', title: 'Demo', path: 'D:\\App\\demo', sessionIds: ['root', 'child'] }] },
  now: 10,
})
assert.equal(projection.byId.get('root').status, STATUS.RUNNING)
assert.equal(projection.byId.get('child').status, STATUS.WAITING_USER)
assert.equal(projection.byId.get('child').parentId, 'root')
assert.equal(projection.projects.length, 1)

const tasks = [
  { id: 'a', title: 'A', status: 'todo', workspaceId: 'w', dependsOn: [] },
  { id: 'b', title: 'B', status: 'todo', workspaceId: 'w', dependsOn: ['a'] },
]
const plan = selectDispatchable({
  tasks,
  assignments: [],
  proposals: [],
  policy: normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 1 }),
})
assert.equal(plan.actions.length, 1)
assert.equal(plan.actions[0].taskId, 'a')


// ---------------------------------------------------- release invariants (Lot 9)
import { decodeDecisions } from '../src/contracts/decisions-schema.js'
import { classifyTurnEnd, MAX_CONTINUATIONS, parseStructuredResult, workEvidenceOf } from '../src/host/turn-outcome.js'
import { effectiveAutonomyOf } from '../src/contracts/mandate.js'
import { CONCURRENCY_HARD_CEILING, concurrencyReached, effectiveConcurrencyOf } from '../src/contracts/concurrency.js'
import { buildAttentionQueue, exceptionsOnlyOf } from '../src/supervisor/attention.js'
import { workingTreeKeyOf } from '../src/orchestrator/project-work.js'

// The decisions contract: one decoder, two published shapes.
const legacy = decodeDecisions([{ id: 'd1', status: 'pending' }, { id: 'd2', status: 'answered' }])
assert.deepEqual(legacy.pending.map(entry => entry.id), ['d1'])
assert.equal(decodeDecisions({ pending: [{ id: 'd3', status: 'pending' }], recent: [], summary: { pending: 1 } }).pending[0].id, 'd3')
assert.equal(decodeDecisions(null).pending.length, 0)

// Turn end is not work done.
assert.equal(classifyTurnEnd({ kind: 'max-tokens', continuations: 0 }).outcome, 'needs_continuation')
assert.equal(classifyTurnEnd({ kind: 'max-tokens', continuations: MAX_CONTINUATIONS }).outcome, 'failed')
assert.equal(classifyTurnEnd({ kind: 'completed', evidence: workEvidenceOf({ startHead: 'aaa', git: { head: 'aaa' } }) }).outcome, 'needs_continuation')
const proven = workEvidenceOf({ structured: parseStructuredResult({ status: 'done', summary: 'ok', testsRun: ['suite: pass'] }) })
assert.equal(classifyTurnEnd({ kind: 'completed', evidence: proven }).outcome, 'verified_done')

// One effective autonomy level, only ever lowered.
const mandate = { scopeMode: 'selected', selectedWorkspaces: ['w'], level: 'L3', actions: { launch: true }, projects: { w: { enabled: true, level: 'L1' } }, requiresConfiguration: false }
assert.equal(effectiveAutonomyOf({ mandate, projectId: 'w' }).level, 'L1')
assert.equal(effectiveAutonomyOf({ mandate }).level, 'L3')

// Unlimited concurrency is explicit, and the tree is the lock.
assert.equal(normalizeConc({ maxConcurrent: null }).maxConcurrent, null)
assert.equal(concurrencyReached(999, null), false)
assert.equal(effectiveConcurrencyOf({ global: null, supervisorConcurrent: 3 }).effective, 3)
assert.equal(CONCURRENCY_HARD_CEILING >= 50, true)
assert.notEqual(workingTreeKeyOf({ projectId: 'p', isolation: 'worktree', id: 'a' }), workingTreeKeyOf({ projectId: 'p', isolation: 'worktree', id: 'b' }))
assert.equal(workingTreeKeyOf({ projectId: 'p', isolation: 'none' }), workingTreeKeyOf({ projectId: 'p' }))

// The attention queue stays silent for healthy work.
const quiet = buildAttentionQueue({ assignments: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, workspaceId: 'p', status: 'running' })), now: 1 })
assert.equal(quiet.items.length, 0)
assert.equal(exceptionsOnlyOf(20), true)

console.log('smoke: OK — projection, DAG, decisions contract, turn outcome, autonomy, concurrency and attention agree')