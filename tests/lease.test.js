import test from 'node:test'
import assert from 'node:assert/strict'

import { acquireLease, ensureAssignment, leaseValid, reconcileAfterRestart, assignmentKey } from '../src/orchestrator/lease.js'

test('a live lease held by another owner is refused, never taken over', () => {
  const existing = { lease: { owner: 'other', expiresAt: 5000, ttlMs: 1000 }, fencingToken: 3 }
  const result = acquireLease(existing, { owner: 'me', now: 1000, ttlMs: 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'lease_held')
  assert.equal(result.holder, 'other')
})

test('an expired lease can be acquired and the fencing token moves forward', () => {
  const existing = { lease: { owner: 'other', expiresAt: 500, ttlMs: 1000 }, fencingToken: 3 }
  assert.equal(leaseValid(existing.lease, 600), false)
  const result = acquireLease(existing, { owner: 'me', now: 600, ttlMs: 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.fencingToken, 4)
  assert.ok(result.lease.expiresAt > 600)
})

test('one assignment per idempotency key: a repeated event does not create a second one', () => {
  const assignments = []
  const draft = { taskId: 't1', revision: 7, workspaceId: 'w1', model: { provider: 'p', model: 'm' } }
  const first = ensureAssignment(assignments, draft)
  assert.equal(first.created, true)
  assignments.push(first.assignment)
  const second = ensureAssignment(assignments, draft)
  assert.equal(second.created, false)
  assert.equal(second.assignment.id, first.assignment.id)
  assert.equal(assignments.length, 1)
})

test('a new attempt has its own idempotency key', () => {
  assert.notEqual(
    assignmentKey({ taskId: 't1', revision: 7, attempt: 0 }),
    assignmentKey({ taskId: 't1', revision: 7, attempt: 1 }),
  )
})

test('restart reconciliation never relaunches: it marks interrupted unless the agent is live', () => {
  const assignments = [
    { id: 'a1', taskId: 't1', sessionId: 's1', status: 'running' },
    { id: 'a2', taskId: 't2', sessionId: 's2', status: 'running' },
  ]
  const changes = reconcileAfterRestart(assignments, { now: 10_000, isLive: assignment => assignment.sessionId === 's1' })
  assert.equal(assignments[0].status, 'running')
  assert.equal(assignments[1].status, 'interrupted')
  assert.equal(assignments[1].lease, null)
  assert.deepEqual(changes, [{ assignmentId: 'a2', taskId: 't2', status: 'interrupted' }])
})
