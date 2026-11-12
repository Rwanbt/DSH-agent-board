import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalIntentPayload, intentPayloadHash, createApprovalIntent, approvalIntentFingerprint, normalizeDecision, proposeDecision, answerDecision, approvalFor, expireDecisions } from '../src/superagent/decisions.js'

const now = 1000
const make = (overrides = {}) => createApprovalIntent({ action: 'update_task', projectId: 'p', taskId: 't', taskVersion: 2, payload: { title: 'Approved' }, mandateRevision: 3, expiry: 5000, ...overrides })
function answered(intent = make()) {
  const proposed = proposeDecision([], { action: intent.action, projectId: intent.projectId, taskIds: ['t'], intent, expiresAt: intent.expiry }, { now })
  return answerDecision(proposed.inbox, proposed.decision.id, { optionId: 'opt-approve', now: now + 1 }).inbox
}
const lookup = (inbox, intent = make(), overrides = {}) => approvalFor(inbox, { action: 'update_task', projectId: 'p', taskIds: ['t'], now: now + 2, intent, ...overrides })

test('canonical JSON SHA256 matches node crypto, independent of key insertion order', () => {
  for (const payload of [null, '', 'é😀', { z: [1, true, null], a: { y: 4, x: 'x' } }, 'x'.repeat(1000)]) {
    assert.equal(intentPayloadHash(payload), createHash('sha256').update(canonicalIntentPayload(payload)).digest('hex'))
  }
  assert.equal(intentPayloadHash({ a: 1, b: 2 }), intentPayloadHash({ b: 2, a: 1 }))
  for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date(), [, 1]]) assert.throws(() => intentPayloadHash(value))
  const cyclic = {}; cyclic.self = cyclic
  assert.throws(() => intentPayloadHash(cyclic))
})

test('intent is detached, immutable, persisted, and fingerprinted exactly', () => {
  const source = { ...make() }
  const inbox = answered(source)
  source.payloadHash = '0'.repeat(64)
  const restored = expireDecisions(JSON.parse(JSON.stringify(inbox)), { now: 1200 }).inbox
  assert.deepEqual(restored[0].intent, make())
  assert.equal(Object.isFrozen(restored[0].intent), true)
  assert.ok(lookup(restored))
  assert.equal(approvalIntentFingerprint(restored[0].intent), approvalIntentFingerprint(make()))
})

test('strict lookup rejects changed payload, version, project, action, mandate and expiry', () => {
  const inbox = answered()
  for (const overrides of [{ payload: { title: 'Different' } }, { taskVersion: 3 }, { projectId: 'foreign' }, { action: 'comment' }, { mandateRevision: 4 }, { expiry: 4999 }, { taskId: 'other' }]) {
    assert.equal(lookup(inbox, make(overrides)), null, JSON.stringify(overrides))
  }
  assert.equal(lookup(inbox, null), null)
  assert.equal(lookup(inbox, make(), { now: 5000 }), null)
  assert.equal(lookup(inbox, make(), { projectId: 'foreign' }), null)
})

test('consumed approvals cannot replay after restart or normalization, including legacy lookup', () => {
  for (const usedAt of [0, 1100]) {
    const inbox = answered().map(d => ({ ...d, usedAt }))
    const restored = expireDecisions(JSON.parse(JSON.stringify(inbox)), { now: 1200 }).inbox
    assert.equal(normalizeDecision(restored[0]).usedAt, usedAt)
    assert.equal(lookup(restored), null)
    assert.equal(approvalFor(restored, { action: 'update_task', projectId: 'p', taskIds: ['t'], now: 1200 }), null)
  }
})

test('legacy approval lookup remains compatible but strict calls require bound approval kind', () => {
  const legacy = answered().map(d => ({ ...d, intent: null }))
  assert.ok(approvalFor(legacy, { action: 'update_task', projectId: 'p', taskIds: ['t'], now: 1200 }))
  assert.equal(lookup(legacy), null)
  assert.equal(lookup(answered().map(d => ({ ...d, kind: 'arbitration' }))), null)
})

test('saved exact operation survives restart detached and rejects tampered payload', () => {
  const intent = make()
  const operation = { action: intent.action, projectId: intent.projectId, taskId: intent.taskId, taskVersion: intent.taskVersion, payload: { title: 'Approved' } }
  const draft = { action: intent.action, projectId: intent.projectId, taskIds: ['t'], intent, operation }
  const proposed = proposeDecision([], draft, { now })
  operation.payload.title = 'Mutated later'
  const restored = normalizeDecision(JSON.parse(JSON.stringify(proposed.decision)))
  assert.deepEqual(restored.operation.payload, { title: 'Approved' })
  assert.equal(Object.isFrozen(restored.operation.payload), true)
  assert.equal(normalizeDecision({ ...restored, operation }).operation, null)
  assert.throws(() => proposeDecision([], { ...draft, operation }, { now }), /Invalid approval operation/)
  assert.equal(normalizeDecision({ ...restored, operation: { ...restored.operation, taskVersion: 4 } }).operation, null)
})

test('different exact intents are never deduplicated by a reused visible key', () => {
  const draft = { action: 'update_task', projectId: 'p', taskIds: ['t'], title: 'Approve', dedupeKey: 'same', intent: make() }
  const first = proposeDecision([], draft, { now })
  const second = proposeDecision(first.inbox, { ...draft, intent: make({ taskVersion: 3 }) }, { now })
  assert.equal(second.duplicate, false)
  assert.equal(second.inbox.length, 2)
  assert.equal(proposeDecision(first.inbox, draft, { now }).duplicate, true)
})
