/**
 * Turn end is NOT work done.
 *
 * A `turn/end` event says the model stopped talking; it says nothing about
 * whether the work exists. The host used to treat `completed` and even
 * `max-tokens` (a truncated answer!) as `DONE` and settle the canonical
 * execution as `succeeded`, so a half-finished run reached the ledger looking
 * finished and nobody re-ran it.
 *
 * This module owns the decision, as a pure function of observable facts:
 *
 *   - `verified_done`      — the host holds a proof: a new commit on the working
 *                            branch, a validated structured result that carries
 *                            real evidence (tests run or a commit), or a Task
 *                            Board card the agent really moved;
 *   - `needs_continuation`  — the turn ended (or was truncated) without proof,
 *                            and the bounded continuation budget is not spent;
 *   - `failed`             — no proof and nothing left to try, or the turn
 *                            itself carried a failure.
 *
 * Nothing here reads the clock, performs I/O or mutates its input.
 *
 * @module dsh-agent-board/host/turn-outcome
 */

/** The three verdicts. Never a boolean: "not done" has two different repairs. */
export const TURN_OUTCOME = Object.freeze({
  VERIFIED_DONE: 'verified_done',
  NEEDS_CONTINUATION: 'needs_continuation',
  FAILED: 'failed',
})

/**
 * How many times a single assignment may be re-prompted after an unverified
 * ending before the host stops spending provider calls and asks a human.
 */
export const MAX_CONTINUATIONS = 3

/** Turn kinds that mean the turn ITSELF failed (never a completion). */
export const FAILED_TURN_KINDS = Object.freeze(['error', 'failed', 'cancelled', 'canceled'])

/** Turn kinds that carry no proof by construction (a truncated answer). */
export const TRUNCATED_TURN_KINDS = Object.freeze(['max-tokens'])

/** Turn kinds a completion verdict may be derived from. */
export const COMPLETION_TURN_KINDS = Object.freeze(['completed', ...TRUNCATED_TURN_KINDS])

/** Proof kinds, in the order the host tries them (cheapest first). */
export const PROOF_KINDS = Object.freeze(['structured_result', 'commit', 'card_moved'])

const STRUCTURED_STATUSES = Object.freeze(['done'])
const MAX_SUMMARY = 600
const MAX_TESTS = 20
const MAX_TEST_TEXT = 200

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * Extract a JSON object carrying `"status"` from a message, tolerating a fenced
 * ```json block (what an agent naturally writes) or a bare object.
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
export function extractStructuredReport(raw) {
  if (isRecord(raw)) return raw
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return null
  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text)
  const candidate = fence?.[1] ?? (text.trim().startsWith('{') ? text.trim() : null)
  if (candidate === null) return null
  try {
    const parsed = JSON.parse(candidate)
    return isRecord(parsed) ? parsed : null
  } catch {
    // A malformed report is not a proof. It is reported as "no structured
    // result" and the other evidence sources still apply.
    return null
  }
}

/**
 * Validate an agent-authored completion report.
 *
 * `{ status: 'done', summary }` alone is NOT evidence: an agent can always type
 * it. At least one verifiable field must be present — the tests it ran, or the
 * commit it produced.
 *
 * @param {unknown} raw
 * @returns {{status: 'done', summary: string, testsRun: string[], commit: string|null}|null}
 */
export function parseStructuredResult(raw) {
  const record = extractStructuredReport(raw)
  if (record === null) return null
  const status = boundedText(record.status, 20).toLowerCase()
  if (!STRUCTURED_STATUSES.includes(status)) return null
  const summary = boundedText(record.summary, MAX_SUMMARY)
  if (summary === '') return null
  const testsRun = []
  const declaredTests = typeof record.testsRun === 'string' ? [record.testsRun] : record.testsRun
  if (Array.isArray(declaredTests)) {
    for (const entry of declaredTests) {
      if (testsRun.length >= MAX_TESTS) break
      const text = boundedText(entry, MAX_TEST_TEXT)
      if (text !== '') testsRun.push(text)
    }
  }
  const commit = boundedText(record.commit, 80) || null
  if (testsRun.length === 0 && commit === null) return null
  return { status: 'done', summary, testsRun, commit }
}

/**
 * Build the evidence facts from the observations the host actually has.
 *
 * Every source is OPTIONAL on purpose: a project that is not a git repository, a
 * ledger that cannot be read, or a message without a report all simply produce
 * less evidence — never a fabricated one.
 *
 * @param {object} input
 * @param {string|null} [input.startHead]        HEAD captured at launch
 * @param {{head?: string, branch?: string, changedFiles?: string[]}|null} [input.git]
 * @param {object|null} [input.structured]       parsed structured result
 * @param {string|null} [input.startCardStatus]  ledger status captured at launch
 * @param {string|null} [input.cardStatus]       ledger status read at turn end
 * @returns {{verified: boolean, proof: object|null, structured: object|null, commit: object|null, cardMoved: object|null, reasons: string[]}}
 */
export function workEvidenceOf({
  startHead = null,
  git = null,
  structured = null,
  startCardStatus = null,
  cardStatus = null,
} = {}) {
  const reasons = []
  const head = typeof git?.head === 'string' && git.head !== '' ? git.head : null
  let commit = null
  if (startHead === null) {
    reasons.push('no_git_baseline')
  } else if (head === null) {
    reasons.push('git_unavailable')
  } else if (head === startHead) {
    reasons.push('no_new_commit')
  } else {
    commit = { head, branch: typeof git?.branch === 'string' ? git.branch : null, changedFiles: Array.isArray(git?.changedFiles) ? git.changedFiles.slice(0, 50) : [] }
  }
  let cardMoved = null
  if (typeof startCardStatus === 'string' && typeof cardStatus === 'string' && startCardStatus !== cardStatus) {
    cardMoved = { from: startCardStatus, to: cardStatus }
  } else {
    reasons.push(cardMoved === null ? 'card_unchanged' : 'card_unchanged')
  }
  if (structured === null) reasons.push('no_structured_result')

  const proof = structured !== null
    ? { kind: 'structured_result', summary: structured.summary, testsRun: structured.testsRun, commit: structured.commit }
    : (commit !== null
        ? { kind: 'commit', head: commit.head, branch: commit.branch }
        : (cardMoved !== null ? { kind: 'card_moved', from: cardMoved.from, to: cardMoved.to } : null))
  return { verified: proof !== null, proof, structured, commit, cardMoved, reasons }
}

function continuationVerdict({ reason, continuations }) {
  const used = Number.isFinite(Number(continuations)) ? Math.max(0, Math.trunc(Number(continuations))) : 0
  if (used >= MAX_CONTINUATIONS) {
    return { outcome: TURN_OUTCOME.FAILED, reason: `${reason}:continuations_exhausted`, continuations: used, exhausted: true }
  }
  return { outcome: TURN_OUTCOME.NEEDS_CONTINUATION, reason, continuations: used, exhausted: false }
}

/**
 * Classify one turn ending.
 *
 * @param {object} input
 * @param {string} input.kind                      the `turn/end` reason kind
 * @param {object} [input.evidence]                `workEvidenceOf(...)` result
 * @param {number} [input.continuations]           continuations already spent
 * @returns {{outcome: string, reason: string, continuations: number, exhausted: boolean}}
 */
export function classifyTurnEnd({ kind, evidence = null, continuations = 0 } = {}) {
  const turnKind = boundedText(kind, 40).toLowerCase() || 'unknown'
  const verified = evidence?.verified === true
  const proofKind = evidence?.proof?.kind ?? null
  if (FAILED_TURN_KINDS.includes(turnKind)) {
    return { outcome: TURN_OUTCOME.FAILED, reason: `turn_kind:${turnKind}`, continuations: Number(continuations) || 0, exhausted: false }
  }
  if (TRUNCATED_TURN_KINDS.includes(turnKind)) {
    // A truncated answer cannot be a completion whatever the evidence says: the
    // model was cut off mid-sentence, so the work is at best partially reported.
    return continuationVerdict({ reason: 'max_tokens', continuations })
  }
  if (turnKind === 'completed') {
    if (verified) {
      return {
        outcome: TURN_OUTCOME.VERIFIED_DONE,
        reason: `evidence:${proofKind}`,
        continuations: Number(continuations) || 0,
        exhausted: false,
      }
    }
    return continuationVerdict({ reason: 'completed_without_evidence', continuations })
  }
  // An unknown ending is never a success: saying nothing is not proof.
  return { outcome: TURN_OUTCOME.FAILED, reason: `unknown_turn_kind:${turnKind}`, continuations: Number(continuations) || 0, exhausted: false }
}

/**
 * The message sent to the same session when the work is not proven. It must be
 * explicit about what is missing, otherwise the model repeats the same
 * unverifiable answer and burns the continuation budget.
 *
 * @param {{reason?: string, attempt?: number, taskId?: string}} [input]
 * @returns {string}
 */
export function continuationPromptOf({ reason = 'completed_without_evidence', attempt = 1, taskId = '' } = {}) {
  const header = reason === 'max_tokens'
    ? 'Your previous answer was TRUNCATED by the token limit.'
    : 'Your previous turn ended without a verifiable proof that the work is done.'
  const lines = [
    header,
    '',
    `This is continuation ${attempt} of at most ${MAX_CONTINUATIONS} for this attempt${taskId === '' ? '' : ` on task ${taskId}`}.`,
    'Before answering again:',
    '1. Finish the work in this session, in this project directory.',
    '2. Commit the result on the working branch (never push, never open a pull request).',
    '3. Run the relevant checks.',
    '4. End your answer with ONE fenced JSON report, and nothing after it:',
    '```json',
    '{"status":"done","summary":"<what changed>","testsRun":["<command>: <result>"],"commit":"<commit sha>"}',
    '```',
    'If the work cannot be finished, say exactly what blocks it and what a human must decide. Do not claim completion.',
  ]
  return lines.join('\n')
}
