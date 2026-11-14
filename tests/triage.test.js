/**
 * Backlog triage: at maximum autonomy a card may leave the backlog without a
 * human, but ONLY when it is unblocked, unassigned, unclaimed and has no unmet
 * prerequisite. These tests pin the reason codes the host reports.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROMOTION_COOLDOWN_MS, PROMOTION_LIMIT_PER_CYCLE, TRIAGE_REASONS, backlogReadinessOf, selectPromotionCandidates,
} from '../src/orchestrator/triage.js'

function card(overrides = {}) {
  return { id: 'c1', title: 'Routine card', status: 'backlog', workspaceId: 'w1', dependsOn: [], version: 3, urgency: 'normal', ...overrides }
}

test('a plain backlog card with satisfied prerequisites is promotable', () => {
  const task = card({ dependsOn: ['done-1'] })
  const byId = new Map([['done-1', { id: 'done-1', status: 'done' }]])
  assert.deepEqual(backlogReadinessOf(task, byId), { promotable: true, reason: TRIAGE_REASONS.ready })
})

test('every hard precondition has its own reason and blocks the promotion', () => {
  const doneById = new Map([['done-1', { id: 'done-1', status: 'done' }]])
  assert.equal(backlogReadinessOf(null).reason, TRIAGE_REASONS.invalid)
  assert.equal(backlogReadinessOf(card({ trashedAt: 1 })).reason, TRIAGE_REASONS.trashed)
  assert.equal(backlogReadinessOf(card()).promotable, true)
  assert.equal(backlogReadinessOf(card({ status: 'todo' })).reason, 'task_not_backlog:todo')
  assert.equal(backlogReadinessOf(card({ blocked: true })).reason, TRIAGE_REASONS.blocked)
  assert.equal(backlogReadinessOf(card({ waitingForHuman: true })).reason, TRIAGE_REASONS.waitingHuman)
  assert.equal(backlogReadinessOf(card({ needsHumanDecision: true })).reason, TRIAGE_REASONS.needsHumanDecision)
  assert.equal(backlogReadinessOf(card({ claimedBy: 'session-x' })).reason, TRIAGE_REASONS.claimed)
  assert.equal(backlogReadinessOf(card({ activeExecution: true })).reason, TRIAGE_REASONS.running)
  const pending = backlogReadinessOf(card({ dependsOn: ['done-1', 'not-done'] }), new Map([
    ...doneById, ['not-done', { id: 'not-done', status: 'in_progress' }],
  ]))
  assert.equal(pending.promotable, false)
  assert.match(pending.reason, /^dependencies_unsatisfied:not-done$/)
  assert.deepEqual(pending.pending, ['not-done'])
})

test('backlog is the ONLY status that can be promoted: never done, never a takeover', () => {
  for (const status of ['todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived']) {
    assert.equal(backlogReadinessOf(card({ status })).promotable, false, status)
  }
})

test('candidates are ordered, bounded and respect the post-promotion cooldown', () => {
  const now = 1_000_000
  const tasks = [
    card({ id: 'relaxed', urgency: 'relaxed', updatedAt: 10 }),
    card({ id: 'urgent', urgency: 'urgent', updatedAt: 30 }),
    card({ id: 'normal-old', urgency: 'normal', updatedAt: 5 }),
    card({ id: 'blocked', blocked: true }),
    card({ id: 'cooled', urgency: 'urgent' }),
  ]
  const { candidates, skipped } = selectPromotionCandidates(tasks, {
    now,
    promotions: { cooled: { at: now - 1000 } },
  })
  assert.deepEqual(candidates.map(task => task.id).slice(0, 2), ['urgent', 'normal-old'])
  assert.equal(candidates.length, Math.min(3, PROMOTION_LIMIT_PER_CYCLE))
  assert.deepEqual(skipped, [{ taskId: 'cooled', reason: TRIAGE_REASONS.cooldown }])

  // Past the cooldown the card is eligible again.
  const later = selectPromotionCandidates(tasks, { now: now + PROMOTION_COOLDOWN_MS + 1, promotions: { cooled: { at: now } } })
  assert.ok(later.candidates.some(task => task.id === 'cooled'))

  // A bounded cycle never returns more than the cap.
  const many = Array.from({ length: 10 }, (_, index) => card({ id: `c-${index}` }))
  assert.equal(selectPromotionCandidates(many, { now }).candidates.length, PROMOTION_LIMIT_PER_CYCLE)
  assert.equal(selectPromotionCandidates(many, { now, limit: 1 }).candidates.length, 1)
})
