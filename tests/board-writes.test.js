/**
 * Board-content payload contract.
 *
 * Two layers protect the same invariant:
 *   1. the model payload is normalized at ingestion (`superagent/brain.js`);
 *   2. the host re-applies an allowlist before ANY board write, including the
 *      bytes captured in an approval and replayed later.
 * Owner fields (`permission`, `model`, `execution`, `isolation`, `status`) must
 * never travel through a brain write: granting `update_task` must not grant
 * `danger-full-access`, another model, a different isolation, or `done`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { BOARD_PAYLOAD_ACTIONS, BOARD_PAYLOAD_FIELDS, sanitizeBoardPayload } from '../src/contracts/board-writes.js'
import { validateAssessment } from '../src/superagent/brain.js'

const OWNER_FIELDS = ['permission', 'model', 'execution', 'isolation', 'status', 'presetId', 'ifVersion', 'id', 'version']

test('board payload allowlist covers exactly the three board-content writes', () => {
  assert.deepEqual([...BOARD_PAYLOAD_ACTIONS], ['create_task', 'update_task', 'comment'])
  assert.deepEqual([...BOARD_PAYLOAD_FIELDS.update_task.booleans], ['blocked', 'waitingForHuman'])
  // `status` is deliberately absent: `done` stays a human action.
  for (const spec of Object.values(BOARD_PAYLOAD_FIELDS)) {
    assert.equal(Object.hasOwn(spec.text, 'status'), false)
    assert.equal(Object.hasOwn(spec.text, 'permission'), false)
    assert.equal(Object.hasOwn(spec.text, 'model'), false)
  }
})

test('allowed fields are canonicalized, bounded and never invented', () => {
  const create = sanitizeBoardPayload('create_task', { title: '  T  ', description: 'd', urgency: 'urgent' })
  assert.deepEqual(create, { ok: true, payload: { title: '  T  ', description: 'd', urgency: 'urgent' } })

  const update = sanitizeBoardPayload('update_task', { title: 't', blocked: true, waitingForHuman: false })
  assert.deepEqual(update, { ok: true, payload: { title: 't', blocked: true, waitingForHuman: false } })

  // Wrong JSON types are ignored, not coerced.
  const ignored = sanitizeBoardPayload('update_task', { title: 42, blocked: 'yes', waitingForHuman: 1 })
  assert.deepEqual(ignored, { ok: true, payload: {} })

  const bounded = sanitizeBoardPayload('comment', { body: 'x'.repeat(10_000) })
  assert.equal(bounded.ok, true)
  assert.equal(bounded.payload.body.length, 4000)

  assert.deepEqual(sanitizeBoardPayload('comment', null), { ok: true, payload: {} })
  assert.deepEqual(sanitizeBoardPayload('comment', undefined), { ok: true, payload: {} })
})

test('owner fields are refused with their names, not silently dropped', () => {
  for (const field of OWNER_FIELDS) {
    const result = sanitizeBoardPayload('update_task', { title: 't', [field]: 'x' })
    assert.equal(result.ok, false, field)
    assert.equal(result.reason, 'payload_field_forbidden')
    assert.deepEqual(result.fields, [field])
  }
  const many = sanitizeBoardPayload('create_task', { title: 't', permission: 'danger-full-access', model: { provider: 'p', model: 'm' } })
  assert.deepEqual(many, { ok: false, reason: 'payload_field_forbidden', fields: ['model', 'permission'] })
  // Nested objects never reach the adapter, even under an allowed key name.
  const nested = sanitizeBoardPayload('update_task', { description: { permission: 'danger-full-access' } })
  assert.deepEqual(nested, { ok: true, payload: {} })
})

test('malformed payloads and foreign actions are refused, never guessed', () => {
  assert.deepEqual(sanitizeBoardPayload('update_task', []), { ok: false, reason: 'payload_invalid' })
  assert.deepEqual(sanitizeBoardPayload('update_task', 'title'), { ok: false, reason: 'payload_invalid' })
  assert.deepEqual(sanitizeBoardPayload('merge', { title: 't' }), { ok: false, reason: 'no_adapter_for_action' })
})

test('the brain payload normalizer strips owner fields before they ever reach a proposal', () => {
  const assessment = {
    schemaVersion: 1,
    situation: 'proposal with smuggled owner fields',
    findings: [],
    proposals: [{
      id: 'p1', action: 'update_task', projectId: 'w1', taskId: 't1', risk: 'low',
      payload: {
        title: 'Legit title', permission: 'danger-full-access', model: { provider: 'p', model: 'm' },
        execution: { mode: 'scheduled' }, isolation: 'worktree', status: 'done', ifVersion: 99,
      },
    }],
    decisions: [],
    directiveEcho: [],
    noopReason: null,
  }
  const result = validateAssessment(assessment)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.assessment.proposals[0].payload, { title: 'Legit title' })
  // And the host would refuse the raw object if it ever appeared anyway.
  const refused = sanitizeBoardPayload('update_task', assessment.proposals[0].payload)
  assert.equal(refused.ok, false)
  assert.deepEqual(refused.fields, ['execution', 'ifVersion', 'isolation', 'model', 'permission', 'status'])
})
