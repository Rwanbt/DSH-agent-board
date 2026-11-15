/**
 * The attention economy: one queue, silence by default.
 *
 * A human can follow about five AI sessions by watching them. This module exists
 * so that watching is never the job: with fifty sessions running, the operator
 * must only see what genuinely needs a HUMAN, grouped by root cause, ranked by
 * what unblocks the most work, and self-explanatory enough to decide in seconds.
 *
 * Everything here is a PURE function of durable facts (decisions, assignments,
 * blocks, conflicts, budget). Nothing is inferred from silence: a healthy session
 * produces no entry at all.
 *
 * @module dsh-agent-board/supervisor/attention
 */

/** Severities, most urgent first. The rank is the sort key. */
export const ATTENTION_SEVERITY = Object.freeze({
  BLOCKING: 'blocking',
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
})

export const ATTENTION_SEVERITY_RANK = Object.freeze({
  [ATTENTION_SEVERITY.BLOCKING]: 0,
  [ATTENTION_SEVERITY.HIGH]: 1,
  [ATTENTION_SEVERITY.NORMAL]: 2,
  [ATTENTION_SEVERITY.LOW]: 3,
})

/** Reason codes (stable: the UI maps them to one sentence). */
export const ATTENTION_REASONS = Object.freeze({
  decisionPending: 'decision_pending',
  workNotVerified: 'work_not_verified',
  permissionBlocked: 'permission_blocked',
  treeConflict: 'tree_conflict',
  budgetExceeded: 'budget_exceeded',
  // A launch queued because of the real-time load (machine or token pool). It is
  // NOT `budget_exceeded`: there is no sliding hour to wait for any more.
  loadExhausted: 'load_exhausted',
  providerUnavailable: 'provider_unavailable',
})

/** One-line suggested action per reason (never a dead end). */
const SUGGESTED_ACTION = Object.freeze({
  [ATTENTION_REASONS.decisionPending]: 'Approve or reject the pending decision.',
  [ATTENTION_REASONS.workNotVerified]: 'Re-run the item, or open the session and finish it.',
  [ATTENTION_REASONS.permissionBlocked]: 'Grant the permission for this project, or narrow the work.',
  [ATTENTION_REASONS.treeConflict]: 'Wait for the running attempt, or give the item its own worktree.',
  [ATTENTION_REASONS.budgetExceeded]: 'Raise the budget, or wait for the window to free a slot.',
  [ATTENTION_REASONS.loadExhausted]: 'Free the load: raise the token pool, start a new wave, or wait for a session to finish.',
  [ATTENTION_REASONS.providerUnavailable]: 'Switch the route for this project, or wait for the cooldown.',
})

/** Coarse effort estimate, in seconds, of ONE human decision. */
const COST_SECONDS = Object.freeze({
  [ATTENTION_REASONS.decisionPending]: 30,
  [ATTENTION_REASONS.workNotVerified]: 120,
  [ATTENTION_REASONS.permissionBlocked]: 45,
  [ATTENTION_REASONS.treeConflict]: 20,
  [ATTENTION_REASONS.budgetExceeded]: 10,
  [ATTENTION_REASONS.loadExhausted]: 15,
  [ATTENTION_REASONS.providerUnavailable]: 15,
})

/** Bounded queue: the operator never faces an unbounded wall of rows. */
export const ATTENTION_QUEUE_LIMIT = 50

/**
 * From this many live agents the cockpit defaults to "exceptions only": below it,
 * watching a handful of sessions is cheaper than filtering them.
 */
export const EXCEPTION_MODE_THRESHOLD = 8

/** A trimmed notification policy: only these wake the operator. */
export const NOTIFY_SEVERITIES = Object.freeze([ATTENTION_SEVERITY.BLOCKING, ATTENTION_SEVERITY.HIGH])

const ACTIVE_ASSIGNMENT_STATUSES = Object.freeze(['starting', 'running', 'recovering'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function finiteOr(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * The root cause of an entry. Two entries with the same key are ONE operator
 * decision: ten sessions blocked by the same missing permission must not become
 * ten rows.
 */
function rootCauseOf({ reason, projectId, action, detail }) {
  return [reason, projectId ?? '*', action ?? '*', detail ?? ''].join('|')
}

/**
 * Build the attention queue from durable facts.
 *
 * @param {object} input
 * @param {object[]} [input.decisions]     pending decisions (already decoded)
 * @param {object[]} [input.assignments]   board assignments
 * @param {{taskId?: string, projectId?: string, reason: string}[]} [input.blocks]
 * @param {{projectId?: string, taskId?: string, tree?: string}[]} [input.treeConflicts]
 * @param {{scope: string, at?: number}[]} [input.budgetEvents] budget/provider refusals
 * @param {number} [input.now]
 * @returns {{items: object[], counters: object, dropped: number}}
 */
export function buildAttentionQueue({
  decisions = [],
  assignments = [],
  blocks = [],
  treeConflicts = [],
  budgetEvents = [],
  now = 0,
} = {}) {
  const at = finiteOr(now, 0)
  const groups = new Map()
  const add = ({ reason, severity, projectId = null, taskId = null, title, detail = null, since = null, payload = null }) => {
    const key = rootCauseOf({ reason, projectId, action: payload?.action ?? null, detail })
    const existing = groups.get(key)
    if (existing !== undefined) {
      existing.occurrences += 1
      if (taskId !== null && !existing.taskIds.includes(taskId) && existing.taskIds.length < 20) existing.taskIds.push(taskId)
      if (Number.isFinite(Number(since)) && (existing.since === null || Number(since) < existing.since)) existing.since = Number(since)
      return
    }
    groups.set(key, {
      id: `att-${groups.size + 1}-${reason}`,
      reason,
      severity,
      projectId,
      taskIds: taskId !== null ? [taskId] : [],
      title: textOf(title) || reason,
      detail,
      since: Number.isFinite(Number(since)) ? Number(since) : null,
      payload,
      occurrences: 1,
    })
  }

  // 1. A pending decision blocks whatever waits behind it.
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!isRecord(decision) || decision.status !== 'pending') continue
    add({
      reason: ATTENTION_REASONS.decisionPending,
      severity: decision.urgency === 'urgent' ? ATTENTION_SEVERITY.BLOCKING : ATTENTION_SEVERITY.HIGH,
      projectId: typeof decision.projectId === 'string' ? decision.projectId : null,
      taskId: Array.isArray(decision.taskIds) && decision.taskIds.length > 0 ? String(decision.taskIds[0]) : null,
      title: textOf(decision.title) || 'Pending decision',
      detail: textOf(decision.action) || null,
      since: decision.createdAt,
      payload: { decisionId: decision.id, action: textOf(decision.action) || null, kind: textOf(decision.kind) || null },
    })
  }

  // 2. Work an attempt could not prove. The assignment itself carries the proof.
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    if (!isRecord(assignment)) continue
    const needsHuman = assignment.needsHuman === true
      || (assignment.status === 'failed' && assignment.workVerified === false)
    if (!needsHuman) continue
    add({
      reason: ATTENTION_REASONS.workNotVerified,
      severity: ATTENTION_SEVERITY.HIGH,
      projectId: textOf(assignment.workspaceId) || null,
      taskId: textOf(assignment.taskId) || null,
      title: `Work not verified: ${textOf(assignment.taskTitle) || textOf(assignment.taskId)}`,
      detail: textOf(assignment.error) || null,
      since: assignment.endedAt,
      payload: {
        assignmentId: textOf(assignment.id) || null,
        evidence: isRecord(assignment.evidence) ? assignment.evidence : null,
        continuations: finiteOr(assignment.continuations, 0),
      },
    })
  }

  // 3. Explicit blocks (a permission refusal, a provider outage declared by the
  //    gate). One entry per cause, however many sessions it holds.
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isRecord(block)) continue
    const reason = textOf(block.reason)
    if (reason === '') continue
    // A load block is named for what it is. It stops EVERY launch, so it ranks
    // above a permission refusal — the operator cannot work around it per card.
    if (reason.startsWith('load_')) {
      add({
        reason: ATTENTION_REASONS.loadExhausted,
        severity: ATTENTION_SEVERITY.HIGH,
        projectId: textOf(block.projectId) || null,
        taskId: textOf(block.taskId) || null,
        title: textOf(block.title) || 'Launch queued: no load left',
        detail: reason,
        since: block.at,
      })
      continue
    }
    const mapped = reason.includes('permission')
      ? ATTENTION_REASONS.permissionBlocked
      : (reason.includes('provider') ? ATTENTION_REASONS.providerUnavailable : ATTENTION_REASONS.budgetExceeded)
    add({
      reason: mapped,
      severity: mapped === ATTENTION_REASONS.permissionBlocked ? ATTENTION_SEVERITY.HIGH : ATTENTION_SEVERITY.NORMAL,
      projectId: textOf(block.projectId) || null,
      taskId: textOf(block.taskId) || null,
      title: textOf(block.title) || reason,
      detail: reason,
      since: block.at,
    })
  }

  // 4. Two attempts competing for one working tree is a real operator choice
  //    (wait, or give the item its own worktree).
  for (const conflict of Array.isArray(treeConflicts) ? treeConflicts : []) {
    if (!isRecord(conflict)) continue
    add({
      reason: ATTENTION_REASONS.treeConflict,
      severity: ATTENTION_SEVERITY.NORMAL,
      projectId: textOf(conflict.projectId) || null,
      taskId: textOf(conflict.taskId) || null,
      title: `Working tree already busy: ${textOf(conflict.tree) || textOf(conflict.projectId)}`,
      detail: textOf(conflict.tree) || null,
      since: conflict.at,
    })
  }

  // 5. Budget / provider refusals the scheduler reported.
  for (const event of Array.isArray(budgetEvents) ? budgetEvents : []) {
    if (!isRecord(event)) continue
    const reason = textOf(event.scope) || 'budget'
    add({
      reason: ATTENTION_REASONS.budgetExceeded,
      severity: ATTENTION_SEVERITY.NORMAL,
      projectId: textOf(event.projectId) || null,
      title: `Budget exhausted: ${reason}`,
      detail: reason,
      since: event.at,
    })
  }

  const items = [...groups.values()].map(entry => {
    const ageMs = entry.since === null ? null : Math.max(0, at - entry.since)
    return {
      ...entry,
      // What is waiting BEHIND this entry: the sort tie-breaker that makes the
      // operator fix the blocking cause first.
      blockedCount: entry.taskIds.length + (entry.occurrences - 1),
      suggestedAction: SUGGESTED_ACTION[entry.reason] ?? 'Open the session and decide.',
      costToResolveSeconds: COST_SECONDS[entry.reason] ?? 60,
      ageMs,
      notify: NOTIFY_SEVERITIES.includes(entry.severity),
    }
  })
  items.sort((left, right) => {
    const severity = ATTENTION_SEVERITY_RANK[left.severity] - ATTENTION_SEVERITY_RANK[right.severity]
    if (severity !== 0) return severity
    if (right.blockedCount !== left.blockedCount) return right.blockedCount - left.blockedCount
    const leftAge = left.ageMs ?? -1
    const rightAge = right.ageMs ?? -1
    if (rightAge !== leftAge) return rightAge - leftAge
    return left.id < right.id ? -1 : 1
  })
  const bounded = items.slice(0, ATTENTION_QUEUE_LIMIT)
  return {
    items: bounded,
    dropped: Math.max(0, items.length - bounded.length),
    counters: {
      total: items.length,
      blocking: items.filter(entry => entry.severity === ATTENTION_SEVERITY.BLOCKING).length,
      high: items.filter(entry => entry.severity === ATTENTION_SEVERITY.HIGH).length,
      notify: items.filter(entry => entry.notify).length,
      // What the operator is asked to spend, in seconds, if they clear the queue.
      costSeconds: items.reduce((total, entry) => total + entry.costToResolveSeconds, 0),
    },
  }
}

/**
 * Does the cockpit switch to "exceptions only"? Below the threshold, watching a
 * handful of sessions is cheaper than filtering them.
 *
 * @param {number} liveAgents
 * @returns {boolean}
 */
export function exceptionsOnlyOf(liveAgents) {
  return finiteOr(liveAgents, 0) >= EXCEPTION_MODE_THRESHOLD
}

/**
 * Per-project digest of what happened — exportable, and never one notification
 * per session.
 *
 * @param {object} input
 * @param {object[]} [input.assignments]
 * @param {object[]} [input.attention] queue items
 * @param {{projectId?: string}[]} [input.projectIds]
 * @returns {{projects: object[], totals: object, text: string}}
 */
export function attentionDigestOf({ assignments = [], attention = [], projectIds = [] } = {}) {
  const ids = new Set()
  for (const id of Array.isArray(projectIds) ? projectIds : []) if (typeof id === 'string' && id !== '') ids.add(id)
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const id = textOf(assignment?.workspaceId)
    if (id !== '') ids.add(id)
  }
  const projects = [...ids].sort().map(projectId => {
    const mine = (Array.isArray(assignments) ? assignments : []).filter(assignment => textOf(assignment?.workspaceId) === projectId)
    const verified = mine.filter(assignment => assignment.status === 'done' && assignment.workVerified !== false).length
    const running = mine.filter(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)).length
    const blocked = mine.filter(assignment => assignment.needsHuman === true || assignment.status === 'failed').length
    const entries = (Array.isArray(attention) ? attention : []).filter(entry => entry.projectId === projectId)
    return {
      projectId,
      verifiedDone: verified,
      running,
      blocked,
      attention: entries.length,
      costSeconds: entries.reduce((total, entry) => total + finiteOr(entry.costToResolveSeconds), 0),
    }
  })
  const totals = projects.reduce((accumulator, project) => ({
    verifiedDone: accumulator.verifiedDone + project.verifiedDone,
    running: accumulator.running + project.running,
    blocked: accumulator.blocked + project.blocked,
    attention: accumulator.attention + project.attention,
  }), { verifiedDone: 0, running: 0, blocked: 0, attention: 0 })
  const text = projects.map(project => `${project.projectId}: ${project.verifiedDone} verified, ${project.running} running, ${project.blocked} blocked`).join('\n')
  return { projects, totals, text }
}

/**
 * The product KPIs: interventions per hour, median time to decide, sessions per
 * operator, items blocked on a human. Computed from REAL events only (a sampled
 * timestamp list), never from an estimate.
 *
 * @param {object} input
 * @param {number[]} [input.interventionAt]  when the operator actually acted
 * @param {number[]} [input.decisionLatencyMs] answer time - ask time
 * @param {number} [input.running]           concurrent sessions now
 * @param {number} [input.itemsBlockedOnHuman]
 * @param {number} [input.windowMs]
 * @param {number} [input.now]
 * @returns {{interventionsPerHour: number, decisionCount: number, medianTimeToDecisionMs: number|null,
 *            sessionsPerOperator: number, itemsBlockedOnHuman: number, windowMs: number}}
 */
export function attentionKpisOf({
  interventionAt = [],
  decisionLatencyMs = [],
  running = 0,
  itemsBlockedOnHuman = 0,
  windowMs = 3_600_000,
  now = 0,
} = {}) {
  const at = finiteOr(now, 0)
  const window = Math.max(60_000, finiteOr(windowMs, 3_600_000))
  const interventions = (Array.isArray(interventionAt) ? interventionAt : [])
    .map(entry => finiteOr(entry, NaN))
    .filter(entry => Number.isFinite(entry) && entry <= at && at - entry <= window)
  const latencies = (Array.isArray(decisionLatencyMs) ? decisionLatencyMs : [])
    .map(entry => finiteOr(entry, NaN))
    .filter(entry => Number.isFinite(entry) && entry >= 0)
    .sort((left, right) => left - right)
  const median = latencies.length === 0
    ? null
    : (latencies.length % 2 === 1
      ? latencies[(latencies.length - 1) / 2]
      : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2))
  return {
    // Extrapolated from the observed window, and labelled as such by the panel.
    interventionsPerHour: Math.round((interventions.length * 3_600_000) / window),
    decisionCount: latencies.length,
    medianTimeToDecisionMs: median,
    sessionsPerOperator: Math.max(0, finiteOr(running, 0)),
    itemsBlockedOnHuman: Math.max(0, finiteOr(itemsBlockedOnHuman, 0)),
    windowMs: window,
  }
}

/**
 * Graded trust: how many times an operator approved the same (project, action)
 * without incident. The UI may PROPOSE promoting it to `auto`; this function never
 * promotes anything by itself.
 *
 * @param {{decisions?: object[], minSamples?: number}} [input]
 * @returns {{projectId: string, action: string, approvals: number, incidents: number, suggested: boolean}[]}
 */
export function approvalTrustOf({ decisions = [], minSamples = 3 } = {}) {
  const groups = new Map()
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!isRecord(decision) || decision.kind !== 'approval') continue
    const action = textOf(decision.action)
    if (action === '') continue
    const projectId = textOf(decision.projectId) || '*'
    const key = `${projectId}|${action}`
    const entry = groups.get(key) ?? { projectId, action, approvals: 0, incidents: 0 }
    const option = Array.isArray(decision.options)
      ? decision.options.find(candidate => candidate?.id === decision.answer?.optionId)
      : null
    if (option?.effect === 'approve') entry.approvals += 1
    // A refused/failed attempt linked to the same decision is an incident.
    if (decision.outcome === 'failed' || decision.incident === true) entry.incidents += 1
    groups.set(key, entry)
  }
  return [...groups.values()]
    .map(entry => ({ ...entry, suggested: entry.approvals >= minSamples && entry.incidents === 0 }))
    .sort((left, right) => right.approvals - left.approvals)
}
