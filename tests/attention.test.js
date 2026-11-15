/**
 * Lot 5b — the attention economy.
 *
 * The product metric is not "how many sessions can run" but "how many human
 * interventions per session per hour, and how long each costs". These tests pin
 * the queue (silence by default, one entry per root cause, ranked by what it
 * unblocks), the grouped approval (single-use preserved), the digest, the trust
 * suggestion and the KPIs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTENTION_REASONS,
  ATTENTION_SEVERITY,
  EXCEPTION_MODE_THRESHOLD,
  approvalTrustOf,
  attentionDigestOf,
  attentionKpisOf,
  buildAttentionQueue,
  exceptionsOnlyOf,
} from '../src/supervisor/attention.js'
import { answerDecision, approvalFor, proposeDecision } from '../src/superagent/decisions.js'

const NOW = 1_800_000_000_000

function running(projectId, index) {
  return { id: `asg-${projectId}-${index}`, taskId: `t-${projectId}-${index}`, workspaceId: projectId, status: 'running', startedAt: NOW }
}

test('fifty sessions, forty-seven healthy: the queue holds only the three exceptions', () => {
  const healthy = Array.from({ length: 47 }, (_, index) => running(`p${index % 10}`, index))
  const exceptions = [
    { id: 'asg-bad-1', taskId: 't-bad-1', workspaceId: 'p1', status: 'failed', workVerified: false, needsHuman: true, error: 'continuations_exhausted', endedAt: NOW - 60_000, taskTitle: 'Card A' },
    { id: 'asg-bad-2', taskId: 't-bad-2', workspaceId: 'p2', status: 'failed', workVerified: false, needsHuman: true, error: 'max_tokens:continuations_exhausted', endedAt: NOW - 5_000, taskTitle: 'Card B' },
  ]
  const decisions = [{
    id: 'dec-1', kind: 'approval', status: 'pending', projectId: 'p3', title: 'Approve the launch', action: 'launch',
    taskIds: ['t-9'], urgency: 'urgent', createdAt: NOW - 120_000, options: [],
  }]
  const queue = buildAttentionQueue({ decisions, assignments: [...healthy, ...exceptions], now: NOW })
  assert.equal(queue.items.length, 3)
  assert.equal(queue.counters.total, 3)
  // The urgent decision ranks first, then the failures by age.
  assert.equal(queue.items[0].reason, ATTENTION_REASONS.decisionPending)
  assert.equal(queue.items[0].severity, ATTENTION_SEVERITY.BLOCKING)
  assert.deepEqual(queue.items.slice(1).map(entry => entry.projectId).sort(), ['p1', 'p2'])
  // A healthy session NEVER appears: silence by default.
  assert.equal(queue.items.some(entry => entry.severity === ATTENTION_SEVERITY.LOW && entry.projectId === 'p0'), false)
  // Every entry is self-contained enough to decide.
  for (const entry of queue.items) {
    assert.equal(typeof entry.suggestedAction, 'string')
    assert.ok(entry.costToResolveSeconds > 0)
    assert.ok(entry.ageMs === null || entry.ageMs >= 0)
    assert.ok(entry.severity in { blocking: 1, high: 1, normal: 1, low: 1 })
  }
})

test('ten sessions blocked by the same cause are ONE entry', () => {
  const blocks = Array.from({ length: 10 }, (_, index) => ({
    taskId: `t${index}`, projectId: 'pX', reason: 'permission_not_allowed:danger-full-access', title: 'Permission refused', at: NOW - 1_000,
  }))
  const queue = buildAttentionQueue({ blocks, now: NOW })
  assert.equal(queue.items.length, 1, 'one root cause, one row')
  assert.equal(queue.items[0].occurrences, 10)
  assert.equal(queue.items[0].reason, ATTENTION_REASONS.permissionBlocked)
  assert.equal(queue.items[0].severity, ATTENTION_SEVERITY.HIGH)
  assert.equal(queue.counters.high, 1)
})

test('the rank is severity, then what it unblocks, then age', () => {
  const decisions = [
    { id: 'd-old', kind: 'approval', status: 'pending', projectId: 'p1', title: 'Old normal', action: 'comment', taskIds: ['a'], urgency: 'normal', createdAt: NOW - 900_000 },
    { id: 'd-new', kind: 'approval', status: 'pending', projectId: 'p2', title: 'New normal', action: 'comment', taskIds: ['b'], urgency: 'normal', createdAt: NOW - 1_000 },
  ]
  const queue = buildAttentionQueue({ decisions, now: NOW })
  assert.deepEqual(queue.items.map(entry => entry.payload.decisionId), ['d-old', 'd-new'], 'older first at equal severity')

  const blocking = buildAttentionQueue({
    decisions,
    assignments: [{ id: 'asg', taskId: 't', workspaceId: 'p3', status: 'failed', workVerified: false, needsHuman: true, endedAt: NOW }],
    now: NOW,
  })
  // Both are HIGH severity, so the AGE decides: the old decision still leads.
  assert.equal(blocking.items[0].reason, ATTENTION_REASONS.decisionPending)
  assert.equal(blocking.items[0].severity, ATTENTION_SEVERITY.HIGH)
  assert.ok(blocking.items.some(entry => entry.reason === ATTENTION_REASONS.workNotVerified))

  // A BLOCKING decision (urgent) outranks every HIGH entry, whatever the age.
  const urgent = buildAttentionQueue({
    decisions: [{ id: 'd-urgent', kind: 'approval', status: 'pending', projectId: 'p9', title: 'Urgent', action: 'launch', taskIds: [], urgency: 'urgent', createdAt: NOW }],
    assignments: [{ id: 'asg', taskId: 't', workspaceId: 'p3', status: 'failed', workVerified: false, needsHuman: true, endedAt: NOW - 900_000 }],
    now: NOW,
  })
  assert.equal(urgent.items[0].severity, ATTENTION_SEVERITY.BLOCKING)
  assert.equal(urgent.items[0].payload.decisionId, 'd-urgent')
})

test('the exceptions-only mode switches at a named threshold', () => {
  assert.equal(EXCEPTION_MODE_THRESHOLD, 8)
  assert.equal(exceptionsOnlyOf(7), false)
  assert.equal(exceptionsOnlyOf(8), true)
  assert.equal(exceptionsOnlyOf(50), true)
  assert.equal(exceptionsOnlyOf(0), false)
})

test('the digest is per project and exportable', () => {
  const assignments = [
    { workspaceId: 'p1', status: 'done', workVerified: true },
    { workspaceId: 'p1', status: 'running' },
    { workspaceId: 'p1', status: 'failed', needsHuman: true },
    { workspaceId: 'p2', status: 'done', workVerified: true },
  ]
  const attention = [{ projectId: 'p1', costToResolveSeconds: 30 }]
  const digest = attentionDigestOf({ assignments, attention, projectIds: ['p2', 'p1'] })
  assert.deepEqual(digest.projects.map(entry => entry.projectId), ['p1', 'p2'])
  assert.deepEqual(digest.projects[0], { projectId: 'p1', verifiedDone: 1, running: 1, blocked: 1, attention: 1, costSeconds: 30 })
  assert.equal(digest.totals.verifiedDone, 2)
  assert.equal(digest.totals.blocked, 1)
  assert.match(digest.text, /p1: 1 verified, 1 running, 1 blocked/)
})

test('the KPIs are computed from real events only', () => {
  const kpis = attentionKpisOf({
    interventionAt: [NOW - 10 * 60_000, NOW - 20 * 60_000, NOW - 30 * 60_000],
    decisionLatencyMs: [10_000, 30_000, 20_000, 60_000],
    running: 50,
    itemsBlockedOnHuman: 3,
    windowMs: 3_600_000,
    now: NOW,
  })
  assert.equal(kpis.interventionsPerHour, 3, 'three interventions in the observed hour')
  assert.equal(kpis.decisionCount, 4)
  assert.equal(kpis.medianTimeToDecisionMs, 25_000)
  assert.equal(kpis.sessionsPerOperator, 50)
  assert.equal(kpis.itemsBlockedOnHuman, 3)
  // An intervention older than the window is not counted.
  const stale = attentionKpisOf({ interventionAt: [NOW - 7_200_000], now: NOW })
  assert.equal(stale.interventionsPerHour, 0)
  assert.equal(stale.medianTimeToDecisionMs, null)
})

test('graded trust proposes a promotion, it never promotes', () => {
  const decision = (index, outcome) => ({
    id: `d${index}`, kind: 'approval', projectId: 'p1', action: 'comment', outcome,
    options: [{ id: 'yes', label: 'Yes', effect: 'approve' }],
    answer: { optionId: 'yes' },
  })
  const trusted = approvalTrustOf({ decisions: [decision(1), decision(2), decision(3)] })
  assert.deepEqual(trusted, [{ projectId: 'p1', action: 'comment', approvals: 3, incidents: 0, suggested: true }])
  const withIncident = approvalTrustOf({ decisions: [decision(1), decision(2), decision(3, 'failed')] })
  assert.equal(withIncident[0].suggested, false, 'one incident disqualifies the suggestion')
  const thin = approvalTrustOf({ decisions: [decision(1)] })
  assert.equal(thin[0].suggested, false)
})

test('a grouped approval keeps every grant single-use', () => {
  const intent = (taskId) => ({
    action: 'launch', projectId: 'p1', taskId, taskVersion: 1,
    payloadHash: 'a'.repeat(64), mandateRevision: 1, expiry: NOW + 3_600_000,
  })
  const propose = taskId => proposeDecision([], {
    kind: 'approval', projectId: 'p1', title: `Approve ${taskId}`, action: 'launch', taskIds: [taskId],
    options: [{ id: 'approve', label: 'Approve', effect: 'approve' }, { id: 'reject', label: 'Reject', effect: 'reject' }],
    intent: intent(taskId),
  }, { now: NOW })
  const first = propose('t1')
  const second = proposeDecision(first.inbox, {
    kind: 'approval', projectId: 'p1', title: 'Approve t2', action: 'launch', taskIds: ['t2'],
    options: [{ id: 'approve', label: 'Approve', effect: 'approve' }, { id: 'reject', label: 'Reject', effect: 'reject' }],
    intent: intent('t2'),
  }, { now: NOW })
  assert.equal(second.inbox.length, 2)

  // One gesture answers both…
  let inbox = second.inbox
  for (const decision of inbox) {
    const answered = answerDecision(inbox, decision.id, { optionId: 'approve', by: 'operator', now: NOW + 100 })
    assert.equal(answered.ok, true)
    inbox = answered.inbox
  }
  // …and each grant authorizes exactly ONE occurrence.
  const t1 = approvalFor(inbox, { action: 'launch', projectId: 'p1', taskIds: ['t1'], intent: intent('t1'), now: NOW + 200 })
  const t2 = approvalFor(inbox, { action: 'launch', projectId: 'p1', taskIds: ['t2'], intent: intent('t2'), now: NOW + 200 })
  assert.ok(t1 !== null)
  assert.ok(t2 !== null)
  const consumed = inbox.map(decision => ({ ...decision, usedAt: NOW + 300 }))
  assert.equal(approvalFor(consumed, { action: 'launch', projectId: 'p1', taskIds: ['t1'], intent: intent('t1'), now: NOW + 400 }), null)
  assert.equal(approvalFor(consumed, { action: 'launch', projectId: 'p1', taskIds: ['t2'], intent: intent('t2'), now: NOW + 400 }), null)
})
