/**
 * Decision inbox: the only channel through which a human unblocks the Super
 * Agent. A decision is a question with bounded options; an answered question
 * with an `approve` option may authorize ONE action matching its scope, never
 * a policy change, and never after it expired.
 *
 * Pure and deterministic: `now` is always injected, ids are derived from
 * content, and no function mutates its input. Duplicate questions are refused
 * (same `dedupeKey`/`fingerprint` pending, or answered within 24h) so the
 * operator is never asked twice.
 *
 * @module dsh-agent-board/superagent/decisions
 */

/** Frozen limits used by the inbox (bounded state, no unbounded growth). */
export const DECISION_LIMITS = Object.freeze({
  inbox: 200,
  options: 4,
  taskIds: 20,
  duplicateWindowMs: 86400000,
  urgentExpiryMs: 86400000,
  normalExpiryMs: 259200000,
  title: 200,
  context: 800,
  recommendation: 200,
  note: 400,
})

const DECISION_KINDS = Object.freeze(['approval', 'arbitration', 'missing_access', 'high_impact'])
const DECISION_STATUSES = Object.freeze(['pending', 'answered', 'expired', 'superseded'])
const APPROVAL_EFFECT = 'approve'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, max = 400) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function finiteInt(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return fallback
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  }
  return fallback
}

function clampInt(value, min, max, fallback) {
  const parsed = finiteInt(value, null)
  if (parsed === null) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function hashText(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

function normalizeKind(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return DECISION_KINDS.includes(text) ? text : 'approval'
}

function normalizeTaskIds(value) {
  const ids = []
  if (!Array.isArray(value)) return ids
  for (const entry of value) {
    if (ids.length >= DECISION_LIMITS.taskIds) break
    const id = boundedText(entry, 200)
    if (id === '' || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/**
 * Normalize options. An unknown/missing effect is coerced to `reject`, never
 * `approve`: only an explicit `effect: 'approve'` can authorize an action.
 */
function normalizeOptions(raw) {
  const options = []
  if (!Array.isArray(raw)) return options
  for (const entry of raw) {
    if (options.length >= DECISION_LIMITS.options) break
    if (typeof entry === 'string') {
      const label = boundedText(entry, 120)
      if (label === '') continue
      options.push({ id: `opt-${hashText(`option:${label}:${options.length}`)}`, label, effect: 'reject' })
      continue
    }
    if (!isRecord(entry)) continue
    const label = boundedText(entry.label, 120)
    const effectText = boundedText(entry.effect, 40).toLowerCase()
    const effect = effectText === '' ? 'reject' : effectText
    const idText = boundedText(entry.id, 80)
    options.push({
      id: idText !== '' ? idText : `opt-${hashText(`option:${label}:${effect}:${options.length}`)}`,
      label: label !== '' ? label : effect,
      effect,
    })
  }
  return options
}

function defaultOptions() {
  return [
    { id: 'opt-approve', label: 'Approve', effect: APPROVAL_EFFECT },
    { id: 'opt-reject', label: 'Reject', effect: 'reject' },
  ]
}

function decisionContentFingerprint(fields) {
  return `dec-fp-${hashText(JSON.stringify([
    fields.kind,
    fields.projectId ?? '',
    fields.action ?? '',
    Array.isArray(fields.taskIds) ? [...fields.taskIds].sort() : [],
    fields.title ?? '',
    fields.context ?? '',
    Array.isArray(fields.options) ? fields.options.map(option => [option.id, option.label, option.effect]) : [],
    fields.recommendation ?? '',
    fields.urgency ?? '',
  ]))}`
}

/**
 * Normalize one decision. A decision whose `answered` status lacks a valid
 * answer (unknown option id) is downgraded to `pending`: corrupted state can
 * never authorize anything.
 *
 * @param {unknown} raw
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function normalizeDecision(raw, { now } = {}) {
  const source = isRecord(raw) ? raw : {}
  const nowValue = finiteInt(now, 0) ?? 0
  const options = normalizeOptions(source.options)
  const kind = normalizeKind(source.kind)
  const projectIdText = boundedText(source.projectId, 200)
  const projectId = projectIdText === '' ? null : projectIdText
  const action = boundedText(source.action, 80)
  const taskIds = normalizeTaskIds(source.taskIds)
  const title = boundedText(source.title, DECISION_LIMITS.title) || 'Decision'
  const context = boundedText(source.context, DECISION_LIMITS.context)
  const recommendation = boundedText(source.recommendation, DECISION_LIMITS.recommendation)
  const urgency = boundedText(source.urgency, 20).toLowerCase() === 'urgent' ? 'urgent' : 'normal'
  const createdAt = finiteInt(source.createdAt, nowValue) ?? nowValue
  const fingerprint = boundedText(source.fingerprint, 80)
    || decisionContentFingerprint({ kind, projectId, action, taskIds, title, context, options, recommendation, urgency })
  const dedupeKey = boundedText(source.dedupeKey, 200) || fingerprint

  let statusText = boundedText(source.status, 20).toLowerCase()
  let status = DECISION_STATUSES.includes(statusText) ? statusText : 'pending'
  let answeredAt = finiteInt(source.answeredAt, null)
  let answer = null
  if (status === 'answered') {
    const rawAnswer = isRecord(source.answer) ? source.answer : null
    const optionId = rawAnswer === null ? '' : boundedText(rawAnswer.optionId, 80)
    const optionExists = optionId !== '' && options.some(option => option.id === optionId)
    if (!optionExists) {
      // No valid answer -> not answered -> cannot authorize.
      status = 'pending'
      answeredAt = null
    } else {
      const answerAt = finiteInt(rawAnswer.at, answeredAt ?? nowValue) ?? nowValue
      answeredAt = answeredAt ?? answerAt
      const note = boundedText(rawAnswer.note, DECISION_LIMITS.note)
      answer = {
        optionId,
        by: boundedText(rawAnswer.by, 80) || 'operator',
        at: answerAt,
        note: note === '' ? null : note,
      }
    }
  }

  const idText = boundedText(source.id, 200)
  return {
    id: idText !== '' ? idText : `dec-${hashText(`decision:${fingerprint}:${createdAt}`)}`,
    kind,
    projectId,
    title,
    context,
    action,
    taskIds,
    options,
    recommendation,
    urgency,
    expiresAt: finiteInt(source.expiresAt, null),
    provenance: boundedText(source.provenance, 120) || 'superagent',
    fingerprint,
    dedupeKey,
    status,
    createdAt,
    answeredAt,
    answer,
    // Single-use marker: the host sets it when an answered approval has been
    // spent. It MUST survive normalization, otherwise expireDecisions() would
    // erase it and one human answer could authorize several launches.
    usedAt: finiteInt(source.usedAt, null),
    resumeHint: boundedText(source.resumeHint, 200) || null,
    askedCount: clampInt(source.askedCount, 1, 99, 1),
  }
}

function normalizeInbox(inbox) {
  if (!Array.isArray(inbox)) return []
  return inbox.map(entry => normalizeDecision(entry, { now: 0 }))
}

/** Drop history before pending questions; pending questions are never dropped. */
function boundInbox(inbox) {
  if (inbox.length <= DECISION_LIMITS.inbox) return inbox
  const keep = [...inbox]
  while (keep.length > DECISION_LIMITS.inbox) {
    let index = keep.findIndex(decision => decision.status === 'expired' || decision.status === 'superseded')
    if (index < 0) index = keep.findIndex(decision => decision.status === 'answered')
    if (index < 0) index = 0
    keep.splice(index, 1)
  }
  return keep
}

/**
 * An empty inbox. Kept as a function so callers never share a mutable array.
 *
 * @returns {object[]}
 */
export function emptyInbox() {
  return []
}

function findDuplicate(inbox, { fingerprint, dedupeKey, at }) {
  for (let index = inbox.length - 1; index >= 0; index -= 1) {
    const decision = inbox[index]
    if (decision.dedupeKey !== dedupeKey && decision.fingerprint !== fingerprint) continue
    if (decision.status === 'pending') return decision
    if (decision.status === 'answered') {
      const answeredAt = finiteInt(decision.answeredAt, null)
      // Unknown answer time is treated as recent: refusing to re-ask is the
      // restrictive choice (never nag, never duplicate).
      if (answeredAt === null || at - answeredAt <= DECISION_LIMITS.duplicateWindowMs) return decision
    }
    // expired/superseded or answered longer than the window ago: re-asking is
    // legitimate (a new occurrence), so fall through.
  }
  return null
}

/**
 * Propose a decision. Returns the EXISTING decision untouched (`duplicate:true`)
 * when an identical question is pending or was answered within 24h.
 *
 * @param {unknown} inbox
 * @param {object} input
 * @param {{now?: number}} [options]
 * @returns {{inbox: object[], decision: object, duplicate: boolean}}
 */
export function proposeDecision(inbox, input, { now } = {}) {
  const current = normalizeInbox(inbox)
  const draft = isRecord(input) ? input : {}
  const at = finiteInt(now, 0) ?? 0
  const kind = normalizeKind(draft.kind)
  const projectId = boundedText(draft.projectId, 200) || null
  const action = boundedText(draft.action, 80)
  const taskIds = normalizeTaskIds(draft.taskIds)
  const title = boundedText(draft.title, DECISION_LIMITS.title)
    || (action === '' ? 'Approval required' : `Approve ${action}`)
  const context = boundedText(draft.context, DECISION_LIMITS.context)
  const urgency = boundedText(draft.urgency, 20).toLowerCase() === 'urgent' ? 'urgent' : 'normal'
  const requestedOptions = normalizeOptions(draft.options)
  const options = requestedOptions.length > 0 ? requestedOptions : defaultOptions()
  const recommendation = boundedText(draft.recommendation, DECISION_LIMITS.recommendation)
  const fingerprint = decisionContentFingerprint({
    kind,
    projectId,
    action,
    taskIds,
    title,
    context,
    options,
    recommendation,
    urgency,
  })
  const dedupeKey = boundedText(draft.dedupeKey, 200) || fingerprint

  const existing = findDuplicate(current, { fingerprint, dedupeKey, at })
  if (existing !== null) return { inbox: current, decision: existing, duplicate: true }

  const requestedExpiry = finiteInt(draft.expiresAt, null)
  const defaultExpiry = at + (urgency === 'urgent' ? DECISION_LIMITS.urgentExpiryMs : DECISION_LIMITS.normalExpiryMs)
  // `expiresAt: null` never authorizes forever: a question always expires.
  const expiresAt = requestedExpiry !== null && requestedExpiry > at ? requestedExpiry : defaultExpiry

  let id = `dec-${hashText(`decision:${fingerprint}:${at}:${current.length}`)}`
  let counter = 1
  while (current.some(decision => decision.id === id) && counter <= 1000) {
    id = `dec-${hashText(`decision:${fingerprint}:${at}:${current.length}:${counter}`)}`
    counter += 1
  }

  const decision = normalizeDecision(
    {
      id,
      kind,
      projectId,
      title,
      context,
      action,
      taskIds,
      options,
      recommendation,
      urgency,
      expiresAt,
      provenance: boundedText(draft.provenance, 120) || 'superagent',
      fingerprint,
      dedupeKey,
      status: 'pending',
      createdAt: at,
      answeredAt: null,
      answer: null,
      resumeHint: boundedText(draft.resumeHint, 200) || null,
      askedCount: 1,
    },
    { now: at },
  )
  return { inbox: boundInbox([...current, decision]), decision, duplicate: false }
}

/**
 * Answer a decision. Refuses unknown ids/options, expired or superseded
 * questions, and a different option after an answer. Answering twice with the
 * SAME option is idempotent (`ok:true`, state untouched).
 *
 * @param {unknown} inbox
 * @param {string} id
 * @param {{optionId?: string, note?: string, by?: string, now?: number}} [input]
 * @returns {{inbox: object[], decision: object|null, ok: boolean, reason: string}}
 */
export function answerDecision(inbox, id, { optionId, note, by, now } = {}) {
  const current = normalizeInbox(inbox)
  const at = finiteInt(now, 0) ?? 0
  const targetId = boundedText(id, 200)
  const index = current.findIndex(decision => decision.id === targetId)
  if (index < 0) return { inbox: current, decision: null, ok: false, reason: 'unknown_decision' }
  const decision = current[index]
  if (decision.status === 'expired') return { inbox: current, decision, ok: false, reason: 'decision_expired' }
  if (decision.status === 'superseded') return { inbox: current, decision, ok: false, reason: 'decision_superseded' }
  const expiresAt = finiteInt(decision.expiresAt, null)
  // A pending question past its deadline is expired in effect; refuse without
  // mutating it (expireDecisions owns the transition).
  if (decision.status === 'pending' && expiresAt !== null && expiresAt <= at) {
    return { inbox: current, decision, ok: false, reason: 'decision_expired' }
  }
  const optionIdText = boundedText(optionId, 80)
  const option = optionIdText === '' ? null : decision.options.find(entry => entry.id === optionIdText)
  if (option === undefined || option === null) {
    return { inbox: current, decision, ok: false, reason: 'unknown_option' }
  }
  if (decision.status === 'answered') {
    if (decision.answer !== null && decision.answer.optionId === optionIdText) {
      return { inbox: current, decision, ok: true, reason: 'already_answered' }
    }
    return { inbox: current, decision, ok: false, reason: 'already_answered' }
  }
  const noteText = boundedText(note, DECISION_LIMITS.note)
  const answered = normalizeDecision(
    {
      ...decision,
      status: 'answered',
      answeredAt: at,
      answer: {
        optionId: optionIdText,
        by: boundedText(by, 80) || 'operator',
        at,
        note: noteText === '' ? null : noteText,
      },
    },
    { now: at },
  )
  const next = current.slice()
  next[index] = answered
  return { inbox: next, decision: answered, ok: true, reason: 'ok' }
}

/**
 * Expire pending questions whose deadline elapsed. Deterministic and
 * non-mutating; an already expired decision is left exactly as it was.
 *
 * @param {unknown} inbox
 * @param {{now?: number}} [options]
 * @returns {{inbox: object[], expired: number}}
 */
export function expireDecisions(inbox, { now } = {}) {
  const current = normalizeInbox(inbox)
  const at = finiteInt(now, 0) ?? 0
  let expired = 0
  const next = current.map(decision => {
    if (decision.status !== 'pending') return decision
    const expiresAt = finiteInt(decision.expiresAt, null)
    if (expiresAt === null || expiresAt > at) return decision
    expired += 1
    return { ...decision, status: 'expired' }
  })
  return { inbox: next, expired }
}

/**
 * Pending questions (no expiry sweep here: that needs `now` and belongs to
 * `expireDecisions`).
 *
 * @param {unknown} inbox
 * @returns {object[]}
 */
export function pendingDecisions(inbox) {
  return normalizeInbox(inbox).filter(decision => decision.status === 'pending')
}

/**
 * Find the decision that authorizes one action occurrence, or null. Requires:
 * status `answered`, a finite future `expiresAt` (a null deadline never
 * authorizes), an option whose effect is exactly `approve`, the same action,
 * and a scope match (same project or a project-less decision; task ids
 * intersect, or the decision is task-agnostic).
 *
 * @param {unknown} inbox
 * @param {{action?: string, taskIds?: string[], projectId?: string|null, now?: number}} [input]
 * @returns {object|null}
 */
export function approvalFor(inbox, { action, taskIds, projectId, now } = {}) {
  const at = finiteInt(now, null)
  if (at === null) return null
  const actionText = boundedText(action, 80)
  if (actionText === '') return null
  const requestedProject = boundedText(projectId, 200) || null
  const requestedTaskIds = normalizeTaskIds(taskIds)
  let best = null
  for (const decision of normalizeInbox(inbox)) {
    if (decision.status !== 'answered' || decision.answer === null) continue
    if (decision.action !== actionText) continue
    const expiresAt = finiteInt(decision.expiresAt, null)
    if (expiresAt === null || expiresAt <= at) continue
    const option = decision.options.find(entry => entry.id === decision.answer.optionId)
    if (option === undefined || option.effect !== APPROVAL_EFFECT) continue
    if (decision.projectId !== null && decision.projectId !== requestedProject) continue
    if (decision.taskIds.length > 0) {
      if (requestedTaskIds.length === 0) continue
      if (!decision.taskIds.some(taskId => requestedTaskIds.includes(taskId))) continue
    }
    const answeredAt = finiteInt(decision.answeredAt, -1) ?? -1
    const bestAnsweredAt = best === null ? -1 : (finiteInt(best.answeredAt, -1) ?? -1)
    if (best === null || answeredAt > bestAnsweredAt || (answeredAt === bestAnsweredAt && decision.id < best.id)) {
      best = decision
    }
  }
  return best
}

/**
 * Compact counters for the cockpit.
 *
 * @param {unknown} inbox
 * @returns {{pending: number, urgent: number, answered: number, oldestAt: number|null}}
 */
export function inboxSummary(inbox) {
  let pending = 0
  let urgent = 0
  let answered = 0
  let oldestAt = null
  for (const decision of normalizeInbox(inbox)) {
    if (decision.status === 'answered') answered += 1
    if (decision.status !== 'pending') continue
    pending += 1
    if (decision.urgency === 'urgent') urgent += 1
    const createdAt = finiteInt(decision.createdAt, null)
    if (createdAt === null) continue
    if (oldestAt === null || createdAt < oldestAt) oldestAt = createdAt
  }
  return { pending, urgent, answered, oldestAt }
}
