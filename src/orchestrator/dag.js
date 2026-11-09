/**
 * Orchestrator policy: modes, mandate, DAG readiness, capacity, budgets.
 *
 * Pure functions only — the host service owns side effects. This is the file
 * the unit tests pin, because a scheduler bug here is what launches the wrong
 * task twice or launches a blocked task.
 *
 * @module dsh-agent-board/orchestrator/dag
 */

import { MODES } from '../contracts/model.js'

const ACTIVE_ASSIGNMENT_STATUSES = Object.freeze(['starting', 'running'])
const URGENCY_WEIGHT = Object.freeze({ urgent: 0, normal: 1, relaxed: 2 })

export function taskStatusOf(task) {
  if (task?.trashedAt !== undefined && task.trashedAt !== null) return 'trashed'
  return typeof task?.status === 'string' ? task.status : 'unknown'
}

export function dependenciesOf(task) {
  return Array.isArray(task?.dependsOn) ? task.dependsOn.map(String) : []
}

/**
 * Dependency state against the human-confirmed ledger: only a task whose
 * status is `done` (never `in_review`) satisfies a prerequisite.
 */
export function dependencyReport(task, tasksById) {
  const blockers = []
  const missing = []
  for (const dependencyId of dependenciesOf(task)) {
    const dependency = tasksById instanceof Map ? tasksById.get(dependencyId) : tasksById?.[dependencyId]
    if (dependency === undefined) {
      missing.push(dependencyId)
      continue
    }
    if (taskStatusOf(dependency) !== 'done') blockers.push(dependencyId)
  }
  return { blocked: blockers.length > 0 || missing.length > 0, blockers, missing }
}

export function readinessOf(task, tasksById) {
  const status = taskStatusOf(task)
  if (status === 'trashed') return { ready: false, reason: 'trashed' }
  if (status !== 'todo') return { ready: false, reason: `status:${status}` }
  const dependency = dependencyReport(task, tasksById)
  if (dependency.missing.length > 0) return { ready: false, reason: `unknown_prerequisite:${dependency.missing.join(',')}` }
  if (dependency.blocked) return { ready: false, reason: `blocked_by:${dependency.blockers.join(',')}` }
  return { ready: true, reason: 'ready' }
}

/** Depth in the DAG (longest prerequisite chain), for a stable launch order. */
export function dagDepth(task, tasksById, seen = new Set()) {
  if (seen.has(task.id)) return 0
  seen.add(task.id)
  let depth = 0
  for (const dependencyId of dependenciesOf(task)) {
    const dependency = tasksById instanceof Map ? tasksById.get(dependencyId) : tasksById?.[dependencyId]
    if (dependency === undefined) continue
    depth = Math.max(depth, dagDepth(dependency, tasksById, seen) + 1)
  }
  return depth
}

export function orderCandidates(tasks, tasksById) {
  return [...tasks].sort((a, b) => {
    const urgency = (URGENCY_WEIGHT[a.urgency] ?? 1) - (URGENCY_WEIGHT[b.urgency] ?? 1)
    if (urgency !== 0) return urgency
    const depth = dagDepth(a, tasksById) - dagDepth(b, tasksById)
    if (depth !== 0) return depth
    return String(a.id).localeCompare(String(b.id))
  })
}

export function countRunning(assignments) {
  return (assignments ?? []).filter(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status)).length
}

/**
 * Mandate check: what the operator actually authorized. An empty workspace
 * allow-list means "every workspace the board can see" (the default the UI
 * shows), not "no restriction on actions".
 */
export function mandateCheck(task, policy) {
  const allowed = Array.isArray(policy?.allowedWorkspaces) ? policy.allowedWorkspaces : []
  if (allowed.length > 0) {
    const workspaceId = String(task?.workspaceId ?? '')
    if (!allowed.includes(workspaceId)) return { ok: false, reason: `workspace_not_in_mandate:${workspaceId}` }
  }
  if (policy?.mode === MODES.OFF) return { ok: false, reason: 'mode_off' }
  return { ok: true, reason: 'allowed' }
}

/** Assignments started inside the sliding hour, for the autonomy budget. */
export function startedWithinHour(assignments, now, windowMs = 60 * 60 * 1000) {
  return (assignments ?? []).filter(assignment => Number.isFinite(Number(assignment?.startedAt)) && now - Number(assignment.startedAt) < windowMs).length
}

/**
 * The single dispatch decision of one tick.
 *
 * @param {object} input
 * @param {object[]} input.tasks          Task Board tasks (authoritative shapes)
 * @param {object[]} input.assignments    board assignments (may include ended ones)
 * @param {object[]} input.proposals      supervised proposals
 * @param {object} input.policy           normalized policy
 * @param {number} input.now
 * @returns {{mode:string, slots:number, actions:object[], skipped:object[]}}
 */
export function selectDispatchable({ tasks, assignments = [], proposals = [], policy, now = Date.now() }) {
  const tasksById = new Map()
  for (const task of tasks ?? []) {
    if (task !== null && typeof task === 'object' && typeof task.id === 'string') tasksById.set(task.id, task)
  }
  const mode = policy?.mode ?? MODES.OFF
  const maxConcurrent = Math.max(0, Number(policy?.maxConcurrent) || 0)
  const slots = Math.max(0, maxConcurrent - countRunning(assignments))
  const actions = []
  const skipped = []

  if (mode === MODES.OFF) return { mode, slots, actions, skipped }

  const runningTaskIds = new Set(
    (assignments ?? [])
      .filter(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status))
      .map(assignment => String(assignment.taskId)),
  )
  const proposedTaskIds = new Set(
    (proposals ?? []).filter(proposal => proposal?.status === 'pending').map(proposal => String(proposal.taskId)),
  )

  const budget = policy?.autonomyBudget?.maxTasksPerHour
  if (Number.isFinite(budget) && budget > 0 && startedWithinHour(assignments, now) >= budget) {
    return { mode, slots, actions, skipped: (tasks ?? []).map(task => ({ taskId: task.id, reason: 'autonomy_budget_exhausted' })) }
  }

  const candidates = orderCandidates(
    (tasks ?? []).filter(task => taskStatusOf(task) === 'todo'),
    tasksById,
  )

  let remaining = slots
  for (const task of candidates) {
    const readiness = readinessOf(task, tasksById)
    if (!readiness.ready) {
      skipped.push({ taskId: task.id, reason: readiness.reason })
      continue
    }
    if (runningTaskIds.has(String(task.id))) {
      skipped.push({ taskId: task.id, reason: 'already_running' })
      continue
    }
    if (proposedTaskIds.has(String(task.id))) {
      skipped.push({ taskId: task.id, reason: 'awaiting_approval' })
      continue
    }
    const mandate = mandateCheck(task, policy)
    if (!mandate.ok) {
      skipped.push({ taskId: task.id, reason: mandate.reason })
      continue
    }
    const action = {
      task,
      taskId: String(task.id),
      workspaceId: String(task.workspaceId ?? ''),
      revision: task.revision ?? task.rev ?? null,
      urgency: task.urgency ?? 'normal',
      kind: mode === MODES.SUPERVISED ? 'proposal' : 'launch',
      reason: mode === MODES.SUPERVISED ? 'supervised_requires_approval' : 'autonomous_mandate',
    }
    if (mode === MODES.SUPERVISED) {
      actions.push(action)
      continue
    }
    if (remaining <= 0) {
      skipped.push({ taskId: task.id, reason: 'concurrency_limit' })
      continue
    }
    actions.push(action)
    remaining -= 1
  }

  return { mode, slots, actions, skipped }
}

/** Stop is independent from OFF: it cancels in-flight work, it does not just pause orders. */
export function stopPlan(assignments) {
  return (assignments ?? [])
    .filter(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status))
    .map(assignment => ({ assignmentId: assignment.id, taskId: assignment.taskId, sessionId: assignment.sessionId }))
}
