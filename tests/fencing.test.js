import test from 'node:test'
import assert from 'node:assert/strict'

import { acquireLease, checkFencing, nextFencingToken } from '../src/orchestrator/lease.js'

function liveAssignment(overrides = {}) {
  return {
    id: 'asg-1',
    taskId: 't1',
    sessionId: 'sess-1',
    status: 'running',
    fencingToken: 2,
    lease: { owner: 'sess-1', acquiredAt: 1000, expiresAt: 5000, ttlMs: 4000 },
    ...overrides,
  }
}

test('nextFencingToken moves forward from the stored token', () => {
  assert.equal(nextFencingToken({ fencingToken: 3 }), 4)
  assert.equal(nextFencingToken({ fencingToken: '2' }), 3)
  assert.equal(nextFencingToken({}), 1)
  assert.equal(nextFencingToken(null), 1)
  assert.equal(nextFencingToken(undefined), 1)
  // A takeover through acquireLease and nextFencingToken agree on the token.
  const existing = { lease: { owner: 'other', expiresAt: 500, ttlMs: 1000 }, fencingToken: 3 }
  const acquired = acquireLease(existing, { owner: 'me', now: 600, ttlMs: 1000 })
  assert.equal(nextFencingToken(existing), acquired.fencingToken)
})

test('a live assignment with the current token is accepted', () => {
  const assignment = liveAssignment()
  assert.deepEqual(checkFencing({ assignment, token: 2, now: 2000 }), { ok: true, reason: 'ok' })
  // The optional owner check accepts the matching owner and stays optional.
  assert.equal(checkFencing({ assignment, token: 2, now: 2000, owner: 'sess-1' }).ok, true)
})

test('a stale fencing token is refused (the newest token wins)', () => {
  assert.deepEqual(
    checkFencing({ assignment: liveAssignment(), token: 1, now: 2000 }),
    { ok: false, reason: 'stale_fencing_token' },
  )
  // A stale writer stays refused even if its lease would have expired.
  const expired = liveAssignment({ lease: { owner: 'sess-1', expiresAt: 500, ttlMs: 1000 } })
  assert.equal(checkFencing({ assignment: expired, token: 1, now: 2000 }).reason, 'stale_fencing_token')
})

test('an unknown assignment or an invalid token is refused', () => {
  assert.deepEqual(checkFencing({ assignment: null, token: 1, now: 1 }), { ok: false, reason: 'unknown_assignment' })
  assert.deepEqual(checkFencing({ assignment: 'asg', token: 1, now: 1 }), { ok: false, reason: 'unknown_assignment' })
  assert.deepEqual(checkFencing({}), { ok: false, reason: 'unknown_assignment' })
  assert.deepEqual(
    checkFencing({ assignment: liveAssignment(), token: 'two', now: 2000 }),
    { ok: false, reason: 'invalid_fencing_token' },
  )
  assert.deepEqual(
    checkFencing({ assignment: liveAssignment({ fencingToken: undefined }), token: 1, now: 2000 }),
    { ok: false, reason: 'invalid_fencing_token' },
  )
})

test('an expired or released lease is refused', () => {
  assert.deepEqual(
    checkFencing({ assignment: liveAssignment(), token: 2, now: 5000 }),
    { ok: false, reason: 'lease_expired' },
  )
  assert.deepEqual(
    checkFencing({ assignment: liveAssignment({ lease: null }), token: 2, now: 2000 }),
    { ok: false, reason: 'lease_released' },
  )
  // A terminal assignment with a leftover lease is still not writable.
  assert.deepEqual(
    checkFencing({ assignment: liveAssignment({ status: 'done' }), token: 2, now: 2000 }),
    { ok: false, reason: 'lease_released' },
  )
})

test('a wrong owner is refused when the host supplies the expected owner', () => {
  const assignment = liveAssignment()
  assert.deepEqual(
    checkFencing({ assignment, token: 2, now: 2000, owner: 'sess-2' }),
    { ok: false, reason: 'wrong_owner' },
  )
  assert.equal(checkFencing({ assignment, token: 2, now: 2000, owner: 'sess-1' }).ok, true)
  assert.equal(checkFencing({ assignment, token: 2, now: 2000 }).ok, true)
})

test('checkFencing is a pure decision: it never mutates the assignment', () => {
  const assignment = liveAssignment()
  const snapshot = JSON.stringify(assignment)
  checkFencing({ assignment, token: 2, now: 2000, owner: 'sess-1' })
  checkFencing({ assignment, token: 1, now: 2000 })
  assert.equal(JSON.stringify(assignment), snapshot)
})
