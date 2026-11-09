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
import { normalizePolicy, MODES, STATUS } from '../src/contracts/model.js'

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

console.log('smoke: OK — projection statuses, tree, and one DAG dispatch decision agree')
