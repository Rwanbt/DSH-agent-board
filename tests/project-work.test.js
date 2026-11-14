/**
 * Project work sources: the Agent Board must pilot a project without the Task
 * Board plugin, using the documents the project itself declares (accepted ADRs,
 * roadmap/TODO checklists) and its open issues.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORK_ATTEMPT_LIMIT, WORK_READINESS_REASONS, WORK_RETRY_DELAY_MS,
  discoverDocWork, parseAdrFile, parseChecklistItems, workItemFromIssue, workItemIdOf, workItemReadinessOf, workPromptOf,
} from '../src/orchestrator/project-work.js'

const ADR = `# ADR 0007 — Persist the board journal atomically

Status: Accepted

## Context

The journal is rewritten on every settle.

## Follow-ups

- [ ] Write the state file through a temp file and a rename
- [ ] Add a restart test that replays a half-written document
`

const PROPOSED_ADR = `# ADR 0008 — Move the scheduler to a worker thread

**Status**: Proposed

## Follow-ups

- [ ] Extract the scheduler loop into a worker
`

test('checklists: only unchecked items, with their section, line and clean title', () => {
  const items = parseChecklistItems([
    '# Roadmap',
    '## Now',
    '- [ ] Ship the ADR triage',
    '* [x] Already done',
    '1. [ ] Second item',
    '  - [ ] Nested item',
    '- [ ] `code` and **bold** [link](https://x)',
  ].join('\n'))
  assert.deepEqual(items.map(item => item.title), [
    'Ship the ADR triage', 'Second item', 'Nested item', 'code and bold link',
  ])
  assert.equal(items[0].heading, 'Now')
  assert.equal(items[0].line, 3)
})

test('an accepted ADR yields follow-up work; a proposed ADR yields a human decision', () => {
  const accepted = parseAdrFile(ADR, { path: 'docs/adr/0007-journal.md' })
  assert.equal(accepted.status, 'accepted')
  assert.match(accepted.title, /Persist the board journal/)
  assert.equal(accepted.items.length, 2)

  const proposed = parseAdrFile(PROPOSED_ADR, { path: 'docs/adr/0008-worker.md' })
  assert.equal(proposed.status, 'proposed')
  assert.equal(proposed.items.length, 1)

  const superseded = parseAdrFile('# Old\nStatus: Superseded\n\n## Follow-ups\n- [ ] Never do this\n', { path: 'docs/adr/0001-old.md' })
  assert.equal(superseded.status, 'inactive')
  assert.deepEqual(superseded.items, [])

  const unknown = parseAdrFile('# Opened\n\n- [ ] Something', { path: 'docs/adr/0002-x.md' })
  assert.equal(unknown.status, 'unknown')
})

test('document work discovery is deterministic, deduplicated and bounded', () => {
  const files = [
    { path: 'docs/adr/0007-journal.md', content: ADR },
    { path: 'docs/adr/0008-worker.md', content: PROPOSED_ADR },
    { path: 'TODO.md', content: '# TODO\n\n## Next\n- [ ] Ship the ADR triage\n- [ ] [decision] Choose the queue backend\n' },
    { path: 'ROADMAP.md', content: '# Roadmap\n- [ ] Ship the ADR triage\n' },
    { path: 'src/index.js', content: '- [ ] Not a document source' },
  ]
  const first = discoverDocWork({ projectId: 'w1', files })
  const second = discoverDocWork({ projectId: 'w1', files: [...files].reverse() })
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id), 'input order never changes the result')

  const titles = first.map(item => item.title)
  assert.equal(new Set(first.map(item => item.id)).size, first.length, 'no duplicate id')
  assert.ok(titles.includes('Ship the ADR triage'))
  assert.equal(titles.filter(title => title === 'Ship the ADR triage').length, 1, 'the same intent is one item')

  const proposed = first.find(item => item.title === 'Extract the scheduler loop into a worker')
  assert.equal(proposed.source, 'adr')
  assert.equal(proposed.needsHumanDecision, true)
  assert.match(proposed.decisionReason, /adr_not_accepted:proposed/)

  const marked = first.find(item => item.title === 'Choose the queue backend')
  assert.equal(marked.needsHumanDecision, true)
  assert.equal(marked.decisionReason, 'decision_marker')

  const adrWork = first.find(item => item.title.startsWith('Write the state file'))
  assert.equal(adrWork.source, 'adr')
  assert.equal(adrWork.needsHumanDecision, false)
  assert.match(adrWork.ref, /^docs\/adr\/0007-journal\.md:\d+$/)

  assert.equal(discoverDocWork({ projectId: 'w1', files, limit: 2 }).length, 2)
  assert.deepEqual(discoverDocWork({ projectId: '', files }), [])
})

test('issues are work, except pull requests, assigned issues and decision labels', () => {
  const issue = { number: 12, title: 'Flaky restart test', body: 'The journal test fails twice a day.', labels: [{ name: 'bug' }] }
  const item = workItemFromIssue(issue, { projectId: 'w1' })
  assert.equal(item.source, 'issue')
  assert.equal(item.ref, '#12')
  assert.equal(item.needsHumanDecision, false)
  assert.equal(workItemFromIssue({ ...issue, pull_request: {} }, { projectId: 'w1' }), null)
  const assigned = workItemFromIssue({ ...issue, assignees: [{ login: 'someone' }] }, { projectId: 'w1' })
  assert.equal(assigned.needsHumanDecision, true)
  assert.equal(assigned.decisionReason, 'issue_assigned')
  const labelled = workItemFromIssue({ ...issue, labels: [{ name: 'needs-decision' }] }, { projectId: 'w1' })
  assert.equal(labelled.needsHumanDecision, true)
  assert.equal(labelled.decisionReason, 'issue_label:needs-decision')
  assert.equal(workItemFromIssue({ number: 0, title: 'x' }, { projectId: 'w1' }), null)
})

test('a work item is dispatchable once, retried with a delay, and never looped', () => {
  const item = {
    id: workItemIdOf({ projectId: 'w1', source: 'adr', title: 'Write the state file atomically' }),
    projectId: 'w1', source: 'adr', title: 'Write the state file atomically', fingerprint: 'wf-1', needsHumanDecision: false,
  }
  assert.deepEqual(workItemReadinessOf(item, { assignments: [] }).reason, WORK_READINESS_REASONS.ready)

  const done = [{ taskId: item.id, status: 'done', startedAt: 1, endedAt: 2, workSource: { fingerprint: 'wf-1' } }]
  assert.equal(workItemReadinessOf(item, { assignments: done, now: 10 }).reason, WORK_READINESS_REASONS.completed)
  // A changed document (new fingerprint) is new intent: dispatchable again.
  assert.equal(workItemReadinessOf({ ...item, fingerprint: 'wf-2' }, { assignments: done, now: 10 }).reason, WORK_READINESS_REASONS.ready)

  const running = [{ taskId: item.id, status: 'running', startedAt: 5 }]
  assert.equal(workItemReadinessOf(item, { assignments: running, now: 10 }).reason, WORK_READINESS_REASONS.inProgress)

  const failedRecently = [{ taskId: item.id, status: 'failed', startedAt: 5, endedAt: 6 }]
  assert.equal(workItemReadinessOf(item, { assignments: failedRecently, now: 10 }).reason, WORK_READINESS_REASONS.retryWait)
  assert.equal(workItemReadinessOf(item, { assignments: failedRecently, now: 6 + WORK_RETRY_DELAY_MS + 1 }).reason, WORK_READINESS_REASONS.ready)
  const exhausted = Array.from({ length: WORK_ATTEMPT_LIMIT }, (_, index) => ({ taskId: item.id, status: 'failed', startedAt: index, endedAt: index }))
  assert.equal(workItemReadinessOf(item, { assignments: exhausted, now: 100 * WORK_RETRY_DELAY_MS }).reason, WORK_READINESS_REASONS.attemptsExhausted)

  assert.equal(workItemReadinessOf({ ...item, needsHumanDecision: true, decisionReason: 'adr_not_accepted:proposed' }).reason,
    `${WORK_READINESS_REASONS.needsHumanDecision}:adr_not_accepted:proposed`)
})

test('the work prompt states the source, the project rules and the completion gesture', () => {
  const prompt = workPromptOf({
    id: 'work-1', projectId: 'w1', source: 'adr', ref: 'docs/adr/0007.md:12',
    title: 'Write the state file atomically', description: 'ADR « Journal » — statut accepté',
  }, { directives: ['Toujours ajouter un test de redémarrage'], projectTitle: 'Board' })
  assert.match(prompt, /work-1/)
  assert.match(prompt, /docs\/adr\/0007\.md:12/)
  assert.match(prompt, /accepted ADRs|ADR/i)
  assert.match(prompt, /Toujours ajouter un test de redémarrage/)
  assert.match(prompt, /- \[ \]` -> `- \[x\]/)
  assert.match(prompt, /STOP and say precisely which decision is needed/)
})
