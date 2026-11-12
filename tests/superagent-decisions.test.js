import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DECISION_LIMITS,
  answerDecision,
  approvalFor,
  emptyInbox,
  expireDecisions,
  inboxSummary,
  pendingDecisions,
  proposeDecision,
} from '../src/superagent/decisions.js'

const NOW = 1_700_000_000_000

function approvalInput(overrides = {}) {
  return {
    kind: 'approval',
    projectId: 'ws1',
    action: 'launch',
    taskIds: ['task-1'],
    title: 'Launch task-1',
    context: 'The agent wants to start task-1.',
    options: [
      { id: 'yes', label: 'Approve', effect: 'approve' },
      { id: 'no', label: 'Reject', effect: 'reject' },
    ],
    urgency: 'urgent',
    ...overrides,
  }
}

test('proposeDecision dedupes by fingerprint and never touches the existing decision', () => {
  const first = proposeDecision(emptyInbox(), approvalInput(), { now: NOW })
  assert.equal(first.duplicate, false)
  assert.equal(first.inbox.length, 1)
  assert.equal(first.decision.status, 'pending')
  assert.equal(first.decision.expiresAt, NOW + DECISION_LIMITS.urgentExpiryMs)
  assert.equal(first.decision.askedCount, 1)

  const second = proposeDecision(first.inbox, approvalInput(), { now: NOW + 1000 })
  assert.equal(second.duplicate, true)
  assert.equal(second.decision.id, first.decision.id)
  assert.deepEqual(second.decision, first.decision, 'the existing decision is returned untouched')
  assert.equal(second.inbox.length, 1)

  const rewordedTitle = proposeDecision(first.inbox, approvalInput({ title: 'Other title' }), { now: NOW + 2000 })
  assert.equal(rewordedTitle.duplicate, false, 'a different question is not a duplicate')

  const explicitKey = proposeDecision(
    first.inbox,
    approvalInput({ title: 'Explicit key question', dedupeKey: 'operator-visible-key' }),
    { now: NOW + 3000 },
  )
  const sameKey = proposeDecision(
    explicitKey.inbox,
    approvalInput({ title: 'Completely different wording', dedupeKey: 'operator-visible-key' }),
    { now: NOW + 4000 },
  )
  assert.equal(sameKey.duplicate, true)
  assert.equal(sameKey.decision.id, explicitKey.decision.id)
})

test('a decision answered within 24h is not re-asked, but an older one may be', () => {
  const proposed = proposeDecision(emptyInbox(), approvalInput({ urgency: 'normal' }), { now: NOW })
  const answered = answerDecision(proposed.inbox, proposed.decision.id, { optionId: 'yes', by: 'operator', now: NOW + 10 })
  assert.equal(answered.ok, true)

  const recent = proposeDecision(answered.inbox, approvalInput({ urgency: 'normal' }), { now: NOW + DECISION_LIMITS.duplicateWindowMs })
  assert.equal(recent.duplicate, true)
  assert.equal(recent.inbox.length, 1)

  const afterWindow = proposeDecision(
    answered.inbox,
    approvalInput({ urgency: 'normal' }),
    { now: NOW + DECISION_LIMITS.duplicateWindowMs + 11 },
  )
  assert.equal(afterWindow.duplicate, false)
  assert.equal(afterWindow.inbox.length, 2)
  assert.notEqual(afterWindow.decision.id, proposed.decision.id)

  const expired = expireDecisions([{ ...proposed.inbox[0], status: 'pending', answer: null }], { now: NOW + 10 ** 12 })
  const renewed = proposeDecision(expired.inbox, approvalInput({ urgency: 'normal' }), { now: NOW + 10 ** 12 })
  assert.equal(renewed.duplicate, false, 'expired questions may be asked again')
})

test('proposal options, urgency and deadlines are bounded, with hostile input tolerated', () => {
  const proposed = proposeDecision(emptyInbox(), {
    action: 'launch',
    title: 'Bounded options',
    urgency: 'insane',
    options: Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, label: `option ${index}`, effect: 'approve' })),
  }, { now: NOW })
  assert.equal(proposed.decision.options.length, DECISION_LIMITS.options)
  assert.equal(proposed.decision.urgency, 'normal')
  assert.equal(proposed.decision.options[0].effect, 'approve')
  assert.equal(proposed.decision.expiresAt, NOW + DECISION_LIMITS.normalExpiryMs)
  assert.equal(proposed.decision.answeredAt, null)
  assert.equal(proposed.decision.answer, null)

  const hostileInput = proposeDecision(null, JSON.parse('{"__proto__":{"polluted":true},"title":"x","expiresAt":1}'), { now: NOW })
  assert.equal(hostileInput.decision.options.length, 2, 'default approve/reject options are always available')
  assert.equal(hostileInput.decision.expiresAt > NOW, true, 'a past explicit deadline falls back to a future one')
  assert.equal({}.polluted, undefined)

  const noOptions = proposeDecision(emptyInbox(), { title: 'No options' }, { now: NOW })
  assert.deepEqual(noOptions.decision.options.map(option => option.effect), ['approve', 'reject'])
})

test('answerDecision validates options and is idempotent only for the same option', () => {
  const proposed = proposeDecision(emptyInbox(), approvalInput(), { now: NOW })
  const id = proposed.decision.id

  assert.equal(answerDecision(proposed.inbox, 'missing', { optionId: 'yes', now: NOW }).ok, false)
  const unknownOption = answerDecision(proposed.inbox, id, { optionId: 'missing-option', now: NOW })
  assert.equal(unknownOption.reason, 'unknown_option')
  assert.equal(unknownOption.ok, false)
  assert.equal(unknownOption.decision.status, 'pending')
  assert.deepEqual(unknownOption.inbox, proposed.inbox, 'an unknown option never answers a decision')
  assert.equal(answerDecision(proposed.inbox, id, { now: NOW }).ok, false)

  const answered = answerDecision(proposed.inbox, id, { optionId: 'yes', by: 'operator', note: 'go', now: NOW + 5 })
  assert.equal(answered.ok, true)
  assert.equal(answered.reason, 'ok')
  assert.equal(answered.decision.status, 'answered')
  assert.deepEqual(answered.decision.answer, { optionId: 'yes', by: 'operator', at: NOW + 5, note: 'go' })

  const again = answerDecision(answered.inbox, id, { optionId: 'yes', now: NOW + 6 })
  assert.equal(again.ok, true)
  assert.equal(again.reason, 'already_answered')
  assert.deepEqual(again.decision, answered.decision, 'same option is idempotent')

  const flipped = answerDecision(answered.inbox, id, { optionId: 'no', now: NOW + 7 })
  assert.equal(flipped.ok, false)
  assert.equal(flipped.reason, 'already_answered')
  assert.deepEqual(flipped.inbox, answered.inbox, 'a different option never rewrites the answer')
})

test('expired questions lose the ability to answer and to authorize anything', () => {
  const urgent = proposeDecision(emptyInbox(), approvalInput(), { now: NOW })
  const expired = expireDecisions(urgent.inbox, { now: NOW + DECISION_LIMITS.urgentExpiryMs + 1 })
  assert.equal(expired.expired, 1)
  assert.equal(expired.inbox[0].status, 'expired')
  assert.equal(expired.inbox[0].answer, null)

  const refused = answerDecision(expired.inbox, urgent.decision.id, { optionId: 'yes', now: NOW + DECISION_LIMITS.urgentExpiryMs + 2 })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'decision_expired')
  assert.deepEqual(refused.inbox, expired.inbox, 'an expired decision is never mutated')

  assert.equal(approvalFor(expired.inbox, { action: 'launch', taskIds: ['task-1'], projectId: 'ws1', now: NOW + 10 ** 9 }), null)
  assert.equal(approvalFor(expired.inbox, { action: 'launch', taskIds: ['task-1'], projectId: 'ws1' }), null, 'no now means no proof of freshness')

  const stalePending = proposeDecision(emptyInbox(), approvalInput({ expiresAt: NOW + 100 }), { now: NOW })
  const late = answerDecision(stalePending.inbox, stalePending.decision.id, { optionId: 'yes', now: NOW + 200 })
  assert.equal(late.ok, false)
  assert.equal(late.reason, 'decision_expired')
  assert.equal(late.inbox[0].status, 'pending', 'answerDecision does not perform the expiry transition')

  assert.equal(approvalFor(expireDecisions(stalePending.inbox, { now: NOW + 200 }).inbox, { action: 'launch', taskIds: ['task-1'], projectId: 'ws1', now: NOW + 200 }), null)
})

test('approvalFor requires answered, approved, unexpired and scope-matching decisions', () => {
  const proposed = proposeDecision(emptyInbox(), approvalInput(), { now: NOW })
  const pendingApproval = approvalFor(proposed.inbox, { action: 'launch', taskIds: ['task-1'], projectId: 'ws1', now: NOW + 1 })
  assert.equal(pendingApproval, null, 'a pending question never authorizes')

  const rejected = answerDecision(proposed.inbox, proposed.decision.id, { optionId: 'no', now: NOW + 2 })
  assert.equal(approvalFor(rejected.inbox, { action: 'launch', taskIds: ['task-1'], projectId: 'ws1', now: NOW + 3 }), null)

  const approved = answerDecision(proposed.inbox, proposed.decision.id, { optionId: 'yes', now: NOW + 4 })
  const matching = { action: 'launch', taskIds: ['task-1'], projectId: 'ws1', now: NOW + 5 }
  assert.equal(approvalFor(approved.inbox, matching)?.id, proposed.decision.id)
  assert.equal(approvalFor(approved.inbox, { ...matching, action: 'merge' }), null)
  assert.equal(approvalFor(approved.inbox, { ...matching, projectId: 'ws2' }), null, 'project scope is strict')
  assert.equal(approvalFor(approved.inbox, { ...matching, taskIds: ['task-2'] }), null)
  assert.equal(approvalFor(approved.inbox, { ...matching, taskIds: [] }), null, 'a task-scoped decision needs an intersecting task')

  const globalQuestion = proposeDecision(emptyInbox(), approvalInput({ projectId: null, taskIds: [], title: 'Global approval' }), { now: NOW })
  const globalAnswered = answerDecision(globalQuestion.inbox, globalQuestion.decision.id, { optionId: 'yes', now: NOW + 6 })
  assert.equal(approvalFor(globalAnswered.inbox, { action: 'launch', taskIds: [], projectId: 'ws-other', now: NOW + 7 })?.id, globalAnswered.decision.id)
  assert.equal(approvalFor(globalAnswered.inbox, { action: 'launch', taskIds: ['any-task'], projectId: 'ws-other', now: NOW + 7 })?.id, globalAnswered.decision.id)

  assert.equal(approvalFor(globalAnswered.inbox, { ...matching, now: undefined }), null)
  const summary = inboxSummary(globalAnswered.inbox)
  assert.deepEqual(summary, { pending: 0, urgent: 0, answered: 1, oldestAt: null })
  assert.deepEqual(pendingDecisions(globalAnswered.inbox), [])
})
