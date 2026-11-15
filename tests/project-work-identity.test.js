/**
 * P1-C — identity is WHERE work is declared, content is WHAT it says.
 *
 * The v1 fingerprint hashed (projectId, source, title), so it was neither an
 * identity (a line moved by a document edit lost its history) nor a content hash
 * (a reworded line kept the old one). These tests pin the split, the migration of
 * a journal written by 0.1.0, and the two dispatch consequences.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORK_JOURNAL_SCHEMA_VERSION,
  WORK_READINESS_REASONS,
  discoverDocWork,
  migrateWorkJournalV1toV2,
  workItemContentFingerprintOf,
  workItemFromIssue,
  workItemIdentityOf,
  workItemIdOf,
  workItemReadinessOf,
} from '../src/orchestrator/project-work.js'

function docItems(content, path = 'TODO.md') {
  return discoverDocWork({ projectId: 'w1', files: [{ path, content }] })
}

test('identity comes from the locator, content from what the line says', () => {
  const identity = workItemIdentityOf({ projectId: 'w1', source: 'todo', ref: 'TODO.md:12' })
  // Same locator, different words: same item, different content.
  const rewording = workItemContentFingerprintOf({ title: 'Ship the ADR triage' })
  const otherWords = workItemContentFingerprintOf({ title: 'Ship the ADR triage now' })
  assert.equal(identity, workItemIdentityOf({ projectId: 'w1', source: 'todo', ref: 'TODO.md:12' }))
  assert.notEqual(visibilityOf(identity, 'TODO.md:12'), null)
  assert.notEqual(rewording, otherWords)
  // The content fingerprint does not depend on the locator at all.
  assert.equal(rewording, workItemContentFingerprintOf({ title: 'Ship the ADR triage' }))
  // Different files are different items even with the same words.
  assert.notEqual(
    workItemIdentityOf({ projectId: 'w1', source: 'todo', ref: 'TODO.md:12' }),
    workItemIdentityOf({ projectId: 'w1', source: 'todo', ref: 'ROADMAP.md:12' }),
  )
  // An issue is identified by its number.
  const first = workItemFromIssue({ number: 12, title: 'Flaky test', body: 'body' }, { projectId: 'w1' })
  const second = workItemFromIssue({ number: 13, title: 'Flaky test', body: 'body' }, { projectId: 'w1' })
  assert.notEqual(first.id, second.id, 'two issues with the same title are two items')
  assert.equal(first.id, workItemIdentityOf({ projectId: 'w1', source: 'issue', ref: '#12' }))
})

// Small helper so the assertion above reads as intent rather than an inline regex.
function visibilityOf(identity, ref) {
  return identity.startsWith('work-') && ref !== '' ? identity : null
}

test('the content fingerprint covers the objective, the criteria and the block', () => {
  const base = { title: 'Ship it', objective: 'why', criteria: ['a', 'b'], block: 'the referenced text' }
  const fingerprint = workItemContentFingerprintOf(base)
  assert.match(fingerprint, /^wf2-[a-f0-9]+$/)
  assert.equal(fingerprint, workItemContentFingerprintOf(base), 'deterministic')
  assert.equal(fingerprint, workItemContentFingerprintOf({ ...base, criteria: ['b', 'a'] }), 'criterion order is not content')
  assert.equal(fingerprint, workItemContentFingerprintOf({ ...base, block: 'the  referenced\ntext' }), 'whitespace is not content')
  assert.notEqual(fingerprint, workItemContentFingerprintOf({ ...base, objective: 'because' }))
  assert.notEqual(fingerprint, workItemContentFingerprintOf({ ...base, criteria: ['a', 'c'] }))
  assert.notEqual(fingerprint, workItemContentFingerprintOf({ ...base, block: 'different text' }))
})

test('two documents declaring the same line are two works, not one', () => {
  // 0.1.0 collapsed equal titles across files, so a distinct section was skipped
  // silently as "already done". Identity is the locator: two declarations are two
  // works, even word for word.
  const files = [
    { path: 'TODO.md', content: '# TODO\n- [ ] Ship the ADR triage\n' },
    { path: 'ROADMAP.md', content: '# Roadmap\n- [ ] Ship the ADR triage\n' },
  ]
  const items = discoverDocWork({ projectId: 'w1', files })
  assert.equal(items.length, 2)
  assert.equal(new Set(items.map(item => item.id)).size, 2, 'two locators, two ids')
  assert.deepEqual(items.map(item => item.ref).sort(), ['ROADMAP.md:2', 'TODO.md:2'])
  // Determinism is preserved: input order never changes the result.
  const reversed = discoverDocWork({ projectId: 'w1', files: [...files].reverse() })
  assert.deepEqual(reversed.map(item => item.id), items.map(item => item.id))
  // Progress is per declaration: proving one does not prove the other.
  const settled = [{ id: 'asg-1', taskId: items[0].id, status: 'done', workVerified: true, startedAt: 1, endedAt: 2, workSource: { fingerprint: items[0].fingerprint } }]
  const reasons = items.map(item => workItemReadinessOf(item, { assignments: settled, now: 10 }).reason).sort()
  assert.deepEqual(reasons, [WORK_READINESS_REASONS.ready, WORK_READINESS_REASONS.completed].sort())
})

test('a reworded line at the same place is a NEW revision of the same item', () => {
  const before = docItems('# TODO\n- [ ] Ship the ADR triage\n')[0]
  // Same line, stronger intent: the identity holds, the content moves.
  const after = docItems('# TODO\n- [ ] Ship the ADR triage with a rollback plan\n')[0]
  assert.equal(before.id, after.id, 'the locator did not move')
  assert.notEqual(before.fingerprint, after.fingerprint)

  const settled = [{
    id: 'asg-1', taskId: before.id, status: 'done', workVerified: true, startedAt: 1, endedAt: 2,
    workSource: { fingerprint: before.fingerprint },
  }]
  assert.equal(workItemReadinessOf(before, { assignments: settled, now: 10 }).reason, WORK_READINESS_REASONS.completed)
  // The document now asks for something else: the item is eligible again.
  assert.equal(workItemReadinessOf(after, { assignments: settled, now: 10 }).reason, WORK_READINESS_REASONS.ready)
})

test('a line that only moved keeps its proven state through the content fingerprint', () => {
  const before = docItems('# TODO\n\n- [ ] Ship the ADR triage\n')[0]
  // Two paragraphs inserted above: the locator changed, the content did not.
  const after = docItems('# TODO\n\nSome new prose.\n\nMore prose.\n\n- [ ] Ship the ADR triage\n')[0]
  assert.notEqual(before.id, after.id, 'the locator moved')
  assert.equal(before.fingerprint, after.fingerprint, 'the content did not')
  const settled = [{
    id: 'asg-1', taskId: before.id, status: 'done', workVerified: true, startedAt: 1, endedAt: 2,
    workSource: { fingerprint: before.fingerprint },
  }]
  assert.equal(
    workItemReadinessOf(after, { assignments: settled, now: 10 }).reason,
    WORK_READINESS_REASONS.completed,
    'finished work must not be re-dispatched because a line moved',
  )
})

test('an unverified done record still does not prove anything', () => {
  const item = docItems('# TODO\n- [ ] Ship the ADR triage\n')[0]
  const unverified = [{
    id: 'asg-1', taskId: item.id, status: 'done', workVerified: false, startedAt: 1, endedAt: 2,
    workSource: { fingerprint: item.fingerprint },
  }]
  assert.equal(workItemReadinessOf(item, { assignments: unverified, now: 10 }).reason, WORK_READINESS_REASONS.ready)
})

test('a v1 journal is migrated to v2 without inventing a content proof', () => {
  const legacy = [
    { id: 'asg-1', taskId: 'work-old-1', status: 'done', workSource: { fingerprint: 'wf-abc123', projectId: 'w1', source: 'todo' } },
    { id: 'asg-2', taskId: 't-card', status: 'done', workSource: null },
    { id: 'asg-3', taskId: 'work-old-2', status: 'running' },
  ]
  const first = migrateWorkJournalV1toV2(legacy, { at: 1_700_000_000_000 })
  assert.equal(first.migrated, 1, 'only the entry carrying a v1 work source is touched')
  assert.equal(first.legacy, 1)
  const migratedEntry = first.assignments[0]
  assert.equal(migratedEntry.workSource.schemaVersion, WORK_JOURNAL_SCHEMA_VERSION)
  assert.equal(migratedEntry.workSource.fingerprint, null, 'a title hash is never promoted to a content fingerprint')
  assert.equal(migratedEntry.workSource.legacyFingerprint, 'wf-abc123', 'the old value stays readable as evidence')
  assert.equal(migratedEntry.workJournalMigratedAt, 1_700_000_000_000)
  // Records without a work source are untouched (they belong to the Task Board).
  assert.equal(first.assignments[1], legacy[1])
  assert.equal(first.assignments[2], legacy[2])

  // Idempotent: a second pass changes nothing.
  const second = migrateWorkJournalV1toV2(first.assignments, { at: 1 })
  assert.equal(second.migrated, 0)
  assert.deepEqual(second.assignments, first.assignments)

  // A legacy record never marks a v2 item completed: there is no content proof.
  const item = docItems('# TODO\n- [ ] Ship the ADR triage\n')[0]
  const readiness = workItemReadinessOf(item, {
    assignments: [{ ...first.assignments[0], status: 'done', endedAt: 2 }],
    now: 10,
  })
  assert.equal(readiness.ready, true)
})

test('the v1 id derivation is still available for old journals', () => {
  // `workItemIdOf` keeps the title-based key when no locator is supplied: the
  // migration and any reader of a 0.1.0 journal depends on that value.
  const legacyId = workItemIdOf({ projectId: 'w1', source: 'todo', title: 'Ship the ADR triage' })
  assert.match(legacyId, /^work-[a-f0-9]+$/)
  assert.equal(legacyId, workItemIdOf({ projectId: 'w1', source: 'todo', title: '  Ship the ADR triage  ' }))
  // With a locator it is the identity, not a title hash.
  assert.equal(
    workItemIdOf({ projectId: 'w1', source: 'todo', ref: 'TODO.md:12' }),
    workItemIdentityOf({ projectId: 'w1', source: 'todo', ref: 'TODO.md:12' }),
  )
})
