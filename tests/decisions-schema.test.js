/**
 * The public decisions contract (v1).
 *
 * The inbox used to be published as an object and read as an array, so these
 * tests pin BOTH sides of the same seam: what the emitter puts on the wire and
 * what the decoder accepts (including a legacy host that still sends the flat
 * array).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECISIONS_PAYLOAD_LIMITS,
  DECISIONS_SCHEMA_VERSION,
  decodeDecision,
  decodeDecisions,
  decisionsPayloadOf,
  emptyDecisionsPayload,
  pendingDecisionsOfPayload,
} from '../src/contracts/decisions-schema.js'

function decision(overrides = {}) {
  return {
    id: 'dec-1',
    kind: 'approval',
    projectId: 'w1',
    title: 'Approve the launch',
    context: 'The card is ready.',
    action: 'launch',
    taskIds: ['t1'],
    options: [
      { id: 'approve', label: 'Approve', effect: 'approve' },
      { id: 'reject', label: 'Reject', effect: 'reject' },
    ],
    recommendation: 'Approve',
    urgency: 'normal',
    status: 'pending',
    createdAt: 1_000,
    answeredAt: null,
    expiresAt: 5_000,
    usedAt: null,
    answer: null,
    intent: null,
    operation: null,
    // An internal field the cockpit must never receive.
    dedupeKey: 'internal-dedupe-key',
    ...overrides,
  }
}

test('the v1 object is decoded field by field and stamped with the contract version', () => {
  const raw = {
    schemaVersion: 1,
    pending: [decision()],
    recent: [decision({ id: 'dec-2', status: 'answered', answeredAt: 2_000, answer: { optionId: 'approve', by: 'operator', at: 2_000, note: null } })],
    summary: { pending: 1, urgent: 0, answered: 1, oldestAt: 1_000 },
  }
  const decoded = decodeDecisions(raw)
  assert.equal(decoded.schemaVersion, DECISIONS_SCHEMA_VERSION)
  assert.equal(decoded.pending.length, 1)
  assert.equal(decoded.recent.length, 1)
  assert.equal(decoded.pending[0].id, 'dec-1')
  assert.equal(decoded.pending[0].options[0].effect, 'approve')
  assert.equal(decoded.recent[0].answer.optionId, 'approve')
  // The host's counters are authoritative: they cover the whole inbox, not the
  // two bounded lists.
  assert.deepEqual(decoded.summary, { pending: 1, urgent: 0, answered: 1, oldestAt: 1_000 })
  // Only the public view is copied.
  assert.equal(Object.hasOwn(decoded.pending[0], 'dedupeKey'), false)
})

test('a legacy flat array is split into pending and recent with derived counters', () => {
  const decoded = decodeDecisions([
    decision({ id: 'a' }),
    decision({ id: 'b', urgency: 'urgent', createdAt: 500 }),
    decision({ id: 'c', status: 'answered', answeredAt: 3_000 }),
    decision({ id: 'd', status: 'expired' }),
  ])
  assert.deepEqual(decoded.pending.map(entry => entry.id), ['a', 'b'])
  assert.deepEqual(decoded.recent.map(entry => entry.id), ['c', 'd'])
  assert.deepEqual(decoded.summary, { pending: 2, urgent: 1, answered: 1, oldestAt: 500 })
  assert.equal(decoded.schemaVersion, DECISIONS_SCHEMA_VERSION)
})

test('anything that is not a decision list decodes to an empty, well-formed payload', () => {
  const empty = emptyDecisionsPayload()
  for (const raw of [null, undefined, '', 'decisions', 42, true, [], {}, { pending: 'nope', recent: 7 }]) {
    const decoded = decodeDecisions(raw)
    assert.equal(decoded.schemaVersion, DECISIONS_SCHEMA_VERSION, String(raw))
    assert.deepEqual(decoded.pending, [], String(raw))
    assert.deepEqual(decoded.recent, [], String(raw))
    assert.deepEqual(decoded.summary, empty.summary, String(raw))
  }
})

test('a corrupt entry is dropped instead of becoming an anonymous approve button', () => {
  const decoded = decodeDecisions({
    pending: [null, 'dec-1', 42, {}, { id: '' }, decision({ id: 'ok' })],
    recent: [undefined, { id: 'used', status: 'answered' }],
  })
  assert.deepEqual(decoded.pending.map(entry => entry.id), ['ok'])
  assert.deepEqual(decoded.recent.map(entry => entry.id), ['used'])
  assert.equal(decodeDecision(null), null)
  assert.equal(decodeDecision({ id: 42 }), null)
})

test('a missing or unknown option effect never reads as approve', () => {
  const decoded = decodeDecision(decision({
    options: [{ id: 'yes', label: 'Yes' }, { id: 'no', effect: 'reject' }, 'not-an-option', { id: '' }],
  }))
  assert.deepEqual(decoded.options, [
    { id: 'yes', label: 'Yes', effect: 'reject' },
    { id: 'no', label: 'no', effect: 'reject' },
  ])
})

test('the single-use marker and the deadline survive decoding', () => {
  const decoded = decodeDecision(decision({ status: 'answered', usedAt: 4_000, answeredAt: 3_000 }))
  assert.equal(decoded.usedAt, 4_000)
  assert.equal(decoded.expiresAt, 5_000)
  assert.equal(decoded.status, 'answered')
})

test('decoding is idempotent, so the flattened list can be decoded again', () => {
  const once = decodeDecisions({ pending: [decision()], recent: [decision({ id: 'old', status: 'expired' })] })
  const flattened = [...once.pending, ...once.recent]
  const twice = decodeDecisions(flattened)
  assert.deepEqual(twice.pending, once.pending)
  assert.deepEqual(twice.recent, once.recent)
  assert.deepEqual(twice.summary.pending, 1)
  assert.deepEqual(decisionsPayloadOf(once), decodeDecisions(once))
})

test('the emitter bounds both lists and keeps an answered decision in recent', () => {
  const pending = Array.from({ length: DECISIONS_PAYLOAD_LIMITS.pending + 5 }, (_, index) => decision({ id: `p-${index}` }))
  const recent = Array.from({ length: DECISIONS_PAYLOAD_LIMITS.recent + 4 }, (_, index) => decision({ id: `r-${index}`, status: 'answered' }))
  const payload = decisionsPayloadOf({ pending, recent, summary: { pending: 99, urgent: 1, answered: 42, oldestAt: 7 } })
  assert.equal(payload.schemaVersion, DECISIONS_SCHEMA_VERSION)
  assert.equal(payload.pending.length, DECISIONS_PAYLOAD_LIMITS.pending)
  assert.equal(payload.recent.length, DECISIONS_PAYLOAD_LIMITS.recent)
  // The newest recent entries are kept.
  assert.equal(payload.recent[payload.recent.length - 1].id, `r-${recent.length - 1}`)
  assert.deepEqual(payload.summary, { pending: 99, urgent: 1, answered: 42, oldestAt: 7 })
})

test('the emitter derives the counters when the host supplies none', () => {
  const payload = decisionsPayloadOf({ pending: [decision({ urgency: 'urgent' })] })
  assert.deepEqual(payload.summary, { pending: 1, urgent: 1, answered: 0, oldestAt: 1_000 })
})

test('only pending decisions are counted, whatever shape the host published', () => {
  assert.equal(pendingDecisionsOfPayload({ pending: [decision(), decision({ id: 'x', status: 'answered' })] }).length, 1)
  assert.equal(pendingDecisionsOfPayload([decision(), decision({ id: 'y', status: 'expired' })]).length, 1)
  assert.equal(pendingDecisionsOfPayload(null).length, 0)
})
