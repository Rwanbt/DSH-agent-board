/**
 * Backlog triage: which `backlog` cards may leave the backlog without a human.
 *
 * The Task Board treats `backlog` as "not authorized to execute", and the Super
 * Agent may never invent an authorization. Maximum autonomy (L4) adds exactly
 * ONE narrow, deterministic capability: moving a card whose work is already
 * unblocked from `backlog` to `todo`, so the normal launch path can pick it up.
 * It is never a promotion to `done` (human-only), never a bypass of a
 * prerequisite, and never applied to a card a human explicitly parked.
 *
 * The model decides WHICH card looks like routine work; this module decides
 * whether the promotion is even representable. Pure, deterministic, no clock.
 *
 * @module dsh-agent-board/orchestrator/triage
 */

/** How many cards one assessment cycle may promote. */
export const PROMOTION_LIMIT_PER_CYCLE = 3

/**
 * A card that was just promoted and pushed back to the backlog is not promoted
 * again before this delay: the agent must not fight the operator or its own
 * rejected attempt in a loop.
 */
export const PROMOTION_COOLDOWN_MS = 6 * 60 * 60 * 1000

/** Stable reason codes, one per condition. */
export const TRIAGE_REASONS = Object.freeze({
  invalid: 'invalid_task',
  trashed: 'task_trashed',
  notBacklog: 'task_not_backlog',
  blocked: 'task_blocked',
  waitingHuman: 'task_waiting_for_human',
  needsHumanDecision: 'needs_human_decision',
  dependencies: 'dependencies_unsatisfied',
  claimed: 'claimed_by_another_session',
  running: 'already_running_in_taskboard',
  cooldown: 'promotion_cooldown',
  ready: 'ready',
})

const URGENCY_RANK = Object.freeze({ urgent: 0, normal: 1, relaxed: 2 })

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Can this card leave the backlog without a human decision?
 *
 * The checks are ordered from "this card is not even a candidate" to the ones a
 * human explicitly set: the reported reason is therefore the real first cause,
 * never a later detail.
 *
 * @param {object|null} task
 * @param {Map<string, object>} [tasksById] every known card, for prerequisites
 * @returns {{promotable: boolean, reason: string, pending?: string[]}}
 */
export function backlogReadinessOf(task, tasksById = new Map()) {
  if (!isRecord(task) || typeof task.id !== 'string' || task.id === '') {
    return { promotable: false, reason: TRIAGE_REASONS.invalid }
  }
  if (typeof task.title === 'string' && task.title.trim() === '') {
    return { promotable: false, reason: TRIAGE_REASONS.invalid }
  }
  if (task.trashedAt !== undefined && task.trashedAt !== null) {
    return { promotable: false, reason: TRIAGE_REASONS.trashed }
  }
  const status = typeof task.status === 'string' ? task.status : 'unknown'
  if (status !== 'backlog') {
    return { promotable: false, reason: `${TRIAGE_REASONS.notBacklog}:${status}` }
  }
  if (task.blocked === true) return { promotable: false, reason: TRIAGE_REASONS.blocked }
  if (task.waitingForHuman === true) return { promotable: false, reason: TRIAGE_REASONS.waitingHuman }
  // An explicit card-level marker wins over any model judgement: the owner said
  // this card needs a human decision.
  if (task.needsHumanDecision === true) {
    return { promotable: false, reason: TRIAGE_REASONS.needsHumanDecision }
  }
  if (typeof task.claimedBy === 'string' && task.claimedBy !== '') {
    return { promotable: false, reason: TRIAGE_REASONS.claimed }
  }
  if (task.activeExecution === true) return { promotable: false, reason: TRIAGE_REASONS.running }
  const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []
  const index = tasksById instanceof Map ? tasksById : new Map()
  const pending = dependsOn.filter(dependency => {
    const prerequisite = index.get(dependency)
    return prerequisite === undefined || prerequisite.status !== 'done'
  })
  if (pending.length > 0) {
    return { promotable: false, reason: `${TRIAGE_REASONS.dependencies}:${pending.slice(0, 5).join(',')}`, pending }
  }
  return { promotable: true, reason: TRIAGE_REASONS.ready }
}

/**
 * Deterministic candidate order and cooldown.
 *
 * `promotions` is the durable journal of already promoted cards
 * (`{[taskId]: {at}}`). A card inside the cooldown window is skipped, not
 * returned with a flag: the caller must never propose it again by accident.
 *
 * @param {object[]} tasks
 * @param {object} [options]
 * @param {Map<string, object>} [options.tasksById]
 * @param {Record<string, {at?: number}>} [options.promotions]
 * @param {number} [options.now]
 * @param {number} [options.limit]
 * @returns {{candidates: object[], skipped: {taskId: string, reason: string}[]}}
 */
export function selectPromotionCandidates(tasks, { tasksById = new Map(), promotions = {}, now = Date.now(), limit = PROMOTION_LIMIT_PER_CYCLE } = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const journal = isRecord(promotions) ? promotions : {}
  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : PROMOTION_LIMIT_PER_CYCLE
  const candidates = []
  const skipped = []
  for (const task of list) {
    if (!isRecord(task) || typeof task.id !== 'string') continue
    const readiness = backlogReadinessOf(task, tasksById)
    if (!readiness.promotable) continue
    const promoted = journal[task.id]
    const at = Number(promoted?.at)
    if (Number.isFinite(at) && now - at >= 0 && now - at < PROMOTION_COOLDOWN_MS) {
      skipped.push({ taskId: task.id, reason: TRIAGE_REASONS.cooldown })
      continue
    }
    candidates.push(task)
  }
  candidates.sort((left, right) => {
    const leftUrgency = URGENCY_RANK[String(left?.urgency ?? 'normal')] ?? 1
    const rightUrgency = URGENCY_RANK[String(right?.urgency ?? 'normal')] ?? 1
    if (leftUrgency !== rightUrgency) return leftUrgency - rightUrgency
    const leftAt = Number(left?.updatedAt ?? left?.createdAt ?? 0) || 0
    const rightAt = Number(right?.updatedAt ?? right?.createdAt ?? 0) || 0
    if (leftAt !== rightAt) return leftAt - rightAt
    return String(left.id).localeCompare(String(right.id))
  })
  return { candidates: candidates.slice(0, cap), skipped }
}
