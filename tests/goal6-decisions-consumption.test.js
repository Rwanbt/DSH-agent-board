/**
 * GOAL 6 — single-use human approval.
 *
 * The host consumes an answered decision by setting `usedAt` on the stored
 * object. `expireDecisions`/`answerDecision` rebuild the inbox from normalized
 * copies, so the marker must survive normalization — otherwise one approval
 * could authorize several launches until its expiry.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { answerDecision, approvalFor, expireDecisions, normalizeDecision, proposeDecision } from '../src/superagent/decisions.js'

const NOW = 1_800_000_000_000

function proposal() {
  return proposeDecision([], {
    kind: 'approval',
    projectId: 'w1',
    title: 'Approuver le lancement de t1',
    context: 'La tâche est prête.',
    action: 'launch',
    taskIds: ['t1'],
    options: [
      { id: 'approve', label: 'Approuver', effect: 'approve' },
      { id: 'reject', label: 'Refuser', effect: 'reject' },
    ],
    recommendation: 'Approuver',
    urgency: 'normal',
  }, { now: NOW })
}

test('an answered approval is found once, then the consumed marker survives normalization', () => {
  const proposed = proposal()
  assert.ok(proposed.decision !== null)
  const id = proposed.decision.id
  const answered = answerDecision(proposed.inbox, id, { optionId: 'approve', by: 'operator', now: NOW + 10 })
  assert.equal(answered.ok, true, answered.reason)
  const match = { action: 'launch', projectId: 'w1', taskIds: ['t1'], now: NOW + 20 }
  assert.ok(approvalFor(answered.inbox, match) !== null, 'a fresh approval authorizes')

  // The host consumes it (this is exactly what authorizeLaunch does).
  const consumed = answered.inbox.map(decision => (decision.id === id ? { ...decision, usedAt: NOW + 20 } : decision))
  const stillApprovable = approvalFor(consumed.filter(decision => typeof decision.usedAt !== 'number'), match)
  assert.equal(stillApprovable, null, 'a consumed approval must not be selectable again')

  // Normalization paths used by the runtime must preserve the marker.
  const expired = expireDecisions(consumed, { now: NOW + 30 }).inbox
  const afterExpiry = expired.find(decision => decision.id === id)
  assert.equal(afterExpiry.usedAt, NOW + 20, 'expireDecisions must not erase usedAt')
  assert.equal(normalizeDecision(afterExpiry, { now: NOW + 31 }).usedAt, NOW + 20)

  // Answering ANOTHER decision rebuilds the inbox too.
  const second = proposeDecision(expired, {
    kind: 'arbitration',
    projectId: 'w1',
    title: 'Deuxième question',
    context: 'Contexte.',
    options: [{ id: 'yes', label: 'Oui', effect: 'approve' }, { id: 'no', label: 'Non', effect: 'reject' }],
    recommendation: 'Oui',
    urgency: 'normal',
  }, { now: NOW + 40 })
  const answeredSecond = answerDecision(second.inbox, second.decision.id, { optionId: 'no', by: 'operator', now: NOW + 50 })
  const afterSecondAnswer = answeredSecond.inbox.find(decision => decision.id === id)
  assert.equal(afterSecondAnswer.usedAt, NOW + 20, 'answering another question must not resurrect a consumed approval')
  assert.equal(approvalFor(answeredSecond.inbox.filter(decision => typeof decision.usedAt !== 'number'), match), null)
})

test('expiry still wins over a stale approval', () => {
  const proposed = proposal()
  const id = proposed.decision.id
  const answered = answerDecision(proposed.inbox, id, { optionId: 'approve', by: 'operator', now: NOW + 10 })
  const later = NOW + 30 * 24 * 60 * 60 * 1000
  assert.equal(approvalFor(answered.inbox, { action: 'launch', projectId: 'w1', taskIds: ['t1'], now: later }), null)
})
