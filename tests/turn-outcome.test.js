/**
 * Turn end is not work done.
 *
 * These tests pin the verdict itself, including the two ways an agent can try to
 * be believed without proving anything: a bare `{"status":"done"}` report, and a
 * `completed` turn in a project nothing changed in.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CONTINUATIONS,
  TURN_OUTCOME,
  classifyTurnEnd,
  continuationPromptOf,
  extractStructuredReport,
  parseStructuredResult,
  workEvidenceOf,
} from '../src/host/turn-outcome.js'

const COMMIT_GIT = { head: 'bbb222', branch: 'task/x', changedFiles: ['src/a.js'] }

test('max-tokens is a continuation, never a completion', () => {
  const first = classifyTurnEnd({ kind: 'max-tokens', continuations: 0 })
  assert.equal(first.outcome, TURN_OUTCOME.NEEDS_CONTINUATION)
  assert.equal(first.reason, 'max_tokens')
  assert.equal(first.exhausted, false)
  // Even with a proof, a truncated answer cannot be a completion verdict: the
  // model was cut off, so the reported work is at best partial.
  const withProof = classifyTurnEnd({
    kind: 'max-tokens',
    evidence: { verified: true, proof: { kind: 'commit', head: 'abc' } },
    continuations: 0,
  })
  assert.equal(withProof.outcome, TURN_OUTCOME.NEEDS_CONTINUATION)
})

test('the continuation budget is bounded and then fails', () => {
  const verdicts = []
  let continuations = 0
  for (let index = 0; index <= MAX_CONTINUATIONS; index += 1) {
    const verdict = classifyTurnEnd({ kind: 'max-tokens', continuations })
    verdicts.push(verdict.outcome)
    continuations = verdict.continuations + (verdict.outcome === TURN_OUTCOME.NEEDS_CONTINUATION ? 1 : 0)
  }
  assert.deepEqual(verdicts, [...Array(MAX_CONTINUATIONS).fill(TURN_OUTCOME.NEEDS_CONTINUATION), TURN_OUTCOME.FAILED])
  const exhausted = classifyTurnEnd({ kind: 'max-tokens', continuations: MAX_CONTINUATIONS })
  assert.equal(exhausted.reason, 'max_tokens:continuations_exhausted')
  assert.equal(exhausted.exhausted, true)
})

test('a completed turn without evidence is a continuation, not a completion', () => {
  // Same HEAD as the launch baseline: nothing was committed during the attempt.
  const verdict = classifyTurnEnd({
    kind: 'completed',
    evidence: workEvidenceOf({ startHead: 'bbb222', git: COMMIT_GIT, structured: null }),
  })
  assert.equal(verdict.outcome, TURN_OUTCOME.NEEDS_CONTINUATION)
  assert.equal(verdict.reason, 'completed_without_evidence')
})

test('a completed turn with a new commit is verified done', () => {
  const evidence = workEvidenceOf({ startHead: 'aaa111', git: COMMIT_GIT })
  assert.equal(evidence.verified, true)
  assert.equal(evidence.proof.kind, 'commit')
  const verdict = classifyTurnEnd({ kind: 'completed', evidence })
  assert.equal(verdict.outcome, TURN_OUTCOME.VERIFIED_DONE)
  assert.equal(verdict.reason, 'evidence:commit')
})

test('a completed turn with a validated structured result is verified done', () => {
  const structured = parseStructuredResult('```json\n{"status":"done","summary":"fixed the parser","testsRun":["node --test tests/: 708 pass"]}\n```')
  assert.ok(structured !== null)
  assert.equal(structured.commit, null)
  const evidence = workEvidenceOf({ startHead: null, git: null, structured })
  assert.equal(evidence.proof.kind, 'structured_result')
  assert.equal(classifyTurnEnd({ kind: 'completed', evidence }).outcome, TURN_OUTCOME.VERIFIED_DONE)
})

test('a structured report with nothing verifiable inside it is not a proof', () => {
  // The exact shape an agent types when it wants to look finished.
  assert.equal(parseStructuredResult({ status: 'done', summary: 'all good' }), null)
  assert.equal(parseStructuredResult({ status: 'done' }), null)
  assert.equal(parseStructuredResult({ status: 'in_progress', summary: 'x', testsRun: ['t'] }), null)
  assert.equal(parseStructuredResult('{"status":"done","summary":"x","testsRun":[]}'), null)
  // A commit alone is enough to make the report verifiable.
  const withCommit = parseStructuredResult({ status: 'done', summary: 'shipped', commit: 'abc123' })
  assert.equal(withCommit.commit, 'abc123')
})

test('a malformed or foreign report is no structured result at all', () => {
  assert.equal(extractStructuredReport('no json here'), null)
  assert.equal(extractStructuredReport('```json\n{not json}\n```'), null)
  assert.equal(extractStructuredReport(['not', 'a', 'record']), null)
  assert.equal(parseStructuredResult('{"status":"done","summary":"x","commit":"abc"} trailing text'), null)
})

test('a moved Task Board card is a proof, an unchanged one is not', () => {
  const moved = workEvidenceOf({ startCardStatus: 'todo', cardStatus: 'in_review' })
  assert.equal(moved.proof.kind, 'card_moved')
  const unchanged = workEvidenceOf({ startCardStatus: 'todo', cardStatus: 'todo' })
  assert.equal(unchanged.verified, false)
  assert.ok(unchanged.reasons.includes('card_unchanged'))
})

test('failing and unknown turn kinds never verify anything', () => {
  for (const kind of ['error', 'failed', 'cancelled', 'canceled', 'aborted-ish']) {
    const verdict = classifyTurnEnd({ kind, evidence: { verified: true, proof: { kind: 'commit' } } })
    assert.equal(verdict.outcome, TURN_OUTCOME.FAILED, kind)
  }
  const unknown = classifyTurnEnd({ kind: 'something-new', evidence: { verified: true, proof: { kind: 'commit' } } })
  assert.equal(unknown.outcome, TURN_OUTCOME.FAILED)
  assert.equal(unknown.reason, 'unknown_turn_kind:something-new')
})

test('a missing baseline can never prove a commit happened', () => {
  const noBaseline = workEvidenceOf({ startHead: null, git: COMMIT_GIT })
  assert.equal(noBaseline.verified, false)
  assert.ok(noBaseline.reasons.includes('no_git_baseline'))
  const sameHead = workEvidenceOf({ startHead: 'bbb222', git: COMMIT_GIT })
  assert.equal(sameHead.verified, false)
  assert.ok(sameHead.reasons.includes('no_new_commit'))
})

test('the continuation prompt demands the machine-readable report', () => {
  const text = continuationPromptOf({ reason: 'max_tokens', attempt: 2, taskId: 't-1' })
  assert.match(text, /TRUNCATED/)
  assert.match(text, /continuation 2 of at most 3/)
  assert.match(text, /"status":"done"/)
  assert.match(text, /Do not claim completion/)
  assert.match(continuationPromptOf({ reason: 'completed_without_evidence' }), /without a verifiable proof/)
})
