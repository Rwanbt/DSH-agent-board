/**
 * The PUBLIC decisions contract, version 1.
 *
 * One question always had two shapes in this plugin, and the cockpit lost the
 * inbox because of it: the host published `{ pending, recent, summary }` while
 * every client helper read `Array.isArray(superagent.decisions)`. This module is
 * the single owner of the shape, so the emitter and the readers can never drift
 * again.
 *
 * Rules it enforces:
 *   - the emitter is STRICT (`decisionsPayloadOf`): explicit field construction,
 *     bounded lists, an effect that is never promoted to `approve` by default;
 *   - the reader is TOLERANT (`decodeDecisions`): the versioned object, the
 *     legacy flat array (a pre-0.2.0 host), and anything else, which must read as
 *     an empty inbox rather than throw inside a render pass.
 *
 * A decision entry is a PUBLIC VIEW: only the fields the operator needs to
 * decide are copied, so a host that grows an internal field does not leak it
 * through the panel.
 *
 * Pure: no clock, no I/O, no randomness. Inputs are never mutated.
 *
 * @module dsh-agent-board/contracts/decisions-schema
 */

/** Version of the payload this module emits. Bumped only on a breaking change. */
export const DECISIONS_SCHEMA_VERSION = 1

/**
 * Bounded list sizes. The host used to hard-code `.slice(0, 20)` / `.slice(-10)`
 * at the call site; naming them here keeps the emitter and the decoder in sync.
 */
export const DECISIONS_PAYLOAD_LIMITS = Object.freeze({
  pending: 20,
  recent: 10,
  options: 8,
  taskIds: 20,
})

const DECISION_STATUSES = Object.freeze(['pending', 'answered', 'expired', 'superseded'])
const PENDING_STATUS = 'pending'
const DEFAULT_OPTION_EFFECT = 'reject'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A bounded non-negative integer, or null. Strings are never coerced. */
function finiteIntOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function countOf(value) {
  const parsed = finiteIntOrNull(value)
  return parsed === null || parsed < 0 ? 0 : parsed
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * One option. A missing/unknown `effect` becomes `reject`: only an explicit
 * `approve` carried by the host may authorize anything, and the reader must not
 * invent one from a corrupt frame.
 */
function decodeOption(raw) {
  if (!isRecord(raw)) return null
  const id = textOf(raw.id)
  if (id === '') return null
  const effect = textOf(raw.effect)
  return {
    id,
    label: textOf(raw.label) || id,
    effect: effect === '' ? DEFAULT_OPTION_EFFECT : effect,
  }
}

function decodeAnswer(raw) {
  if (!isRecord(raw)) return null
  const optionId = textOf(raw.optionId)
  if (optionId === '') return null
  return {
    optionId,
    by: textOf(raw.by) || 'operator',
    at: finiteIntOrNull(raw.at),
    note: textOrNull(raw.note),
  }
}

/** The persisted approval binding. Without a payload hash it authorizes nothing. */
function decodeIntent(raw) {
  if (!isRecord(raw)) return null
  const payloadHash = textOf(raw.payloadHash)
  if (payloadHash === '') return null
  return {
    action: textOrNull(raw.action),
    projectId: textOrNull(raw.projectId),
    taskId: textOrNull(raw.taskId),
    taskVersion: finiteIntOrNull(raw.taskVersion),
    payloadHash,
    mandateRevision: finiteIntOrNull(raw.mandateRevision),
    expiry: finiteIntOrNull(raw.expiry),
  }
}

function decodeTaskIds(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (out.length >= DECISIONS_PAYLOAD_LIMITS.taskIds) break
    const id = textOf(entry)
    if (id === '' || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * One decision, as the cockpit is allowed to see it.
 *
 * Returns null when the entry cannot be displayed at all (not a record, or no
 * usable id): a corrupt entry is DROPPED, never rendered as an empty question
 * whose "approve" button would carry an undefined id.
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
export function decodeDecision(raw) {
  if (!isRecord(raw)) return null
  const id = textOf(raw.id)
  if (id === '') return null
  const options = []
  for (const entry of Array.isArray(raw.options) ? raw.options : []) {
    if (options.length >= DECISIONS_PAYLOAD_LIMITS.options) break
    const option = decodeOption(entry)
    if (option !== null) options.push(option)
  }
  return {
    id,
    kind: textOf(raw.kind) || 'unknown',
    title: textOf(raw.title),
    context: textOf(raw.context),
    action: textOf(raw.action),
    projectId: textOrNull(raw.projectId),
    taskIds: decodeTaskIds(raw.taskIds),
    options,
    recommendation: textOf(raw.recommendation),
    urgency: textOf(raw.urgency).toLowerCase() === 'urgent' ? 'urgent' : 'normal',
    status: DECISION_STATUSES.includes(raw.status) ? raw.status : PENDING_STATUS,
    createdAt: finiteIntOrNull(raw.createdAt),
    answeredAt: finiteIntOrNull(raw.answeredAt),
    expiresAt: finiteIntOrNull(raw.expiresAt),
    // Single-use marker: the whole guarantee that one human answer authorizes
    // exactly one action. It must survive decoding.
    usedAt: finiteIntOrNull(raw.usedAt),
    risk: textOrNull(raw.risk),
    impact: textOrNull(raw.impact),
    expectedEffect: textOrNull(raw.expectedEffect),
    answer: decodeAnswer(raw.answer),
    // Replayed after the answer, so the operator must be able TO READ it. It is
    // already canonical and size-bounded by the host (`normalizeApprovalOperation`).
    operation: isRecord(raw.operation) ? raw.operation : null,
    intent: decodeIntent(raw.intent),
    provenance: textOrNull(raw.provenance),
    resumeHint: textOrNull(raw.resumeHint),
  }
}

function decodeList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    const decision = decodeDecision(entry)
    if (decision !== null) out.push(decision)
  }
  return out
}

function decodeSummary(raw) {
  if (!isRecord(raw)) return { pending: 0, urgent: 0, answered: 0, oldestAt: null }
  return {
    pending: countOf(raw.pending),
    urgent: countOf(raw.urgent),
    answered: countOf(raw.answered),
    oldestAt: finiteIntOrNull(raw.oldestAt),
  }
}

/** Counters derived from the entries actually received (legacy/partial frames). */
function summaryOf(decisions) {
  let pending = 0
  let urgent = 0
  let answered = 0
  let oldestAt = null
  for (const decision of decisions) {
    if (decision.status === 'answered') answered += 1
    if (decision.status !== PENDING_STATUS) continue
    pending += 1
    if (decision.urgency === 'urgent') urgent += 1
    const createdAt = decision.createdAt
    if (createdAt === null) continue
    if (oldestAt === null || createdAt < oldestAt) oldestAt = createdAt
  }
  return { pending, urgent, answered, oldestAt }
}

/** An empty, well-formed payload (safe to render, safe to spread). */
export function emptyDecisionsPayload() {
  return {
    schemaVersion: DECISIONS_SCHEMA_VERSION,
    pending: [],
    recent: [],
    summary: { pending: 0, urgent: 0, answered: 0, oldestAt: null },
  }
}

/**
 * Decode any historical/foreign `decisions` value into the v1 payload.
 *
 * Accepted inputs:
 *   - the v1 object `{ schemaVersion?, pending, recent, summary? }`;
 *   - the legacy flat array (a host that published the whole inbox);
 *   - anything else (`null`, a string, a number, a partial object) → empty.
 *
 * The result always has the same shape, so a caller can read `.pending`,
 * `.recent` and `.summary` without a guard.
 *
 * @param {unknown} raw
 * @returns {{schemaVersion: number, pending: object[], recent: object[], summary: object}}
 */
export function decodeDecisions(raw) {
  if (Array.isArray(raw)) {
    const all = decodeList(raw)
    return {
      schemaVersion: DECISIONS_SCHEMA_VERSION,
      pending: all.filter(decision => decision.status === PENDING_STATUS).slice(0, DECISIONS_PAYLOAD_LIMITS.pending),
      recent: all.filter(decision => decision.status !== PENDING_STATUS).slice(-DECISIONS_PAYLOAD_LIMITS.recent),
      summary: summaryOf(all),
    }
  }
  if (!isRecord(raw)) return emptyDecisionsPayload()
  const pending = decodeList(raw.pending).slice(0, DECISIONS_PAYLOAD_LIMITS.pending)
  const recent = decodeList(raw.recent).slice(-DECISIONS_PAYLOAD_LIMITS.recent)
  return {
    schemaVersion: DECISIONS_SCHEMA_VERSION,
    pending,
    recent,
    // A valid host summary counts the WHOLE inbox, which is larger than the two
    // bounded lists: prefer it. Only a missing/corrupt one is derived locally.
    summary: isRecord(raw.summary) ? decodeSummary(raw.summary) : summaryOf([...pending, ...recent]),
  }
}

/**
 * The only pending decisions. This is what the inbox badge counts, so it must be
 * derived from the published payload and never from an `Array.isArray` guess.
 *
 * @param {unknown} raw
 * @returns {object[]}
 */
export function pendingDecisionsOfPayload(raw) {
  return decodeDecisions(raw).pending.filter(decision => decision.status === PENDING_STATUS)
}

/**
 * Build the published payload (host side). Strict on purpose: unknown keys of an
 * input decision never reach the wire, and every list is bounded here.
 *
 * @param {{pending?: unknown, recent?: unknown, summary?: unknown}} [input]
 * @returns {{schemaVersion: number, pending: object[], recent: object[], summary: object}}
 */
export function decisionsPayloadOf({ pending = [], recent = [], summary = null } = {}) {
  const decodedPending = decodeList(pending).slice(0, DECISIONS_PAYLOAD_LIMITS.pending)
  const decodedRecent = decodeList(recent).slice(-DECISIONS_PAYLOAD_LIMITS.recent)
  return {
    schemaVersion: DECISIONS_SCHEMA_VERSION,
    pending: decodedPending,
    recent: decodedRecent,
    summary: isRecord(summary) ? decodeSummary(summary) : summaryOf([...decodedPending, ...decodedRecent]),
  }
}
