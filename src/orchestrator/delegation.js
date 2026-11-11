/**
 * Super Orchestrator delegation gate (pure).
 *
 * The supervision layer may only NARROW what the board is already allowed to
 * do: this module never grants a permission, a route or a workspace. It adds
 * the supervision policy limits on top of the existing authorization choke
 * point (`authorizeLaunch` / `authorizeHandoff` stay the single authority):
 *
 *   - `supervision.enabled`              — the layer must be switched on;
 *   - `maxConcurrentDelegations`         — board-launched assignments in flight;
 *   - `maxDelegationsPerHour`            — real delegation starts, sliding hour;
 *   - `maxDelegationDepth`               — a delegated launch may not delegate
 *                                          again beyond the recorded depth;
 *   - `allowCrossProjectDelegation`      — a subtask in another project needs an
 *                                          explicit opt-in;
 *   - dependency cycles                  — a task that can never become ready is
 *                                          refused, never launched;
 *   - the existing mandate/permission/route refusals.
 *
 * Honesty rules:
 *   - a refusal is an explicit reason code, never a silent downgrade;
 *   - `delegationDepthOf` reads `assignment.delegation.depth` from the recorded
 *     journal; it never infers a depth from a timer, a session count or a
 *     parent guess;
 *   - a refused delegation must not consume a lease or create a session — the
 *     caller checks this BEFORE acquiring anything.
 *
 * @module dsh-agent-board/orchestrator/delegation
 */

import { DEFAULT_POLICY, MODES, allowedPermissionOf, normalizeSupervision } from '../contracts/model.js'
import { mandateCheck } from './dag.js'
import { HOURLY_WINDOW_MS } from '../routing/budget.js'

/** Assignment statuses that mean "this delegation is still in flight". */
export const ACTIVE_DELEGATION_STATUSES = Object.freeze(['starting', 'running', 'recovering'])

/** Guard against a pathological ledger; a cycle beyond it is not enumerated. */
const CYCLE_SCAN_LIMIT = 2000

/**
 * The normalized supervision policy slice for any policy shape.
 *
 * A policy written before this field existed (or a partial `POST /policy`) reads
 * as the documented defaults: the layer is enabled, with the bounded limits.
 *
 * @param {object|null} policy
 * @returns {{enabled:boolean, emblem:'crown'|'bolt', maxConcurrentDelegations:number,
 *   maxDelegationsPerHour:number, maxDelegationDepth:number, allowCrossProjectDelegation:boolean}}
 */
export function supervisionConfigOf(policy) {
  const slice = policy !== null && typeof policy === 'object' ? policy.supervision : null
  return normalizeSupervision(slice ?? {}, DEFAULT_POLICY.supervision)
}

/**
 * The REAL delegation depth recorded on an assignment.
 *
 * The host writes `assignment.delegation = { depth, rootTaskId,
 * parentAssignmentId, projectId, requestedBy }` when a launch is decided. A
 * record without that field (legacy state, or a root launch) is depth 0 — never
 * a guessed value.
 *
 * @param {object|null} assignment
 * @returns {number} non-negative integer
 */
export function delegationDepthOf(assignment) {
  const depth = Number(assignment?.delegation?.depth)
  if (!Number.isFinite(depth) || depth < 0) return 0
  return Math.trunc(depth)
}

/** Count the in-flight board delegations (the concurrency ceiling input). */
export function countActiveDelegations(assignments) {
  return (Array.isArray(assignments) ? assignments : [])
    .filter(assignment => ACTIVE_DELEGATION_STATUSES.includes(assignment?.status)).length
}

/**
 * Delegation starts inside the sliding hour.
 *
 * Preference order: explicit `usage.launches` timestamps (the host records
 * them), then the budget counter's `usage.tasks`, then the durable assignments
 * themselves (a handoff continuation carries `previousSessionId` and is NOT a
 * new delegation — it continues the one it was created for).
 *
 * @param {object|null} usage
 * @param {object[]} assignments
 * @param {number} now
 * @returns {number[]}
 */
function launchesWithinHour(usage, assignments, now) {
  const cutoff = now - HOURLY_WINDOW_MS
  const source = Array.isArray(usage?.launches)
    ? usage.launches
    : (Array.isArray(usage?.tasks) ? usage.tasks : null)
  if (source !== null) {
    return source
      .map(Number)
      .filter(at => Number.isFinite(at) && at > cutoff)
  }
  return (Array.isArray(assignments) ? assignments : [])
    .filter(assignment => assignment?.previousSessionId === null || assignment?.previousSessionId === undefined)
    .map(assignment => Number(assignment?.startedAt))
    .filter(at => Number.isFinite(at) && at > cutoff)
}

/**
 * The two counters the host passes to {@link evaluateDelegation}: in-flight
 * board delegations and the real launch timestamps of the sliding hour.
 *
 * @param {object[]} assignments
 * @param {number} [now]
 * @returns {{inFlight:number, launches:number[]}}
 */
export function delegationUsageOf(assignments, now = Date.now()) {
  return {
    inFlight: countActiveDelegations(assignments),
    launches: launchesWithinHour(null, assignments, now),
  }
}

/**
 * Decide whether one board-owned delegation may happen.
 *
 * Pure: no lease, no session, no write. Every refusal is a stable reason code:
 *   `supervision_disabled`, `invalid_task`, `mode_off`,
 *   `workspace_not_in_mandate:<id>`, `permission_not_allowed:<level>`,
 *   `route_policy_conflict`, `duplicate_assignment`, `delegation_cycle`,
 *   `cross_project_not_allowed`, `delegation_depth_exceeded`,
 *   `delegation_concurrency_exceeded`, `delegation_budget_exhausted`.
 *
 * @param {object} input
 * @param {object} input.policy                normalized board policy
 * @param {object} input.task                  Task Board task to delegate
 * @param {object|null} [input.taskboard]      Task Board coordination read model
 * @param {object[]} [input.assignments]       durable board assignments
 * @param {object|null} [input.usage]          `{ inFlight, launches, depth, parentAssignment, parentProjectId }`
 * @param {number} [input.now]
 * @returns {{allow:boolean, reason:string}}
 */
export function evaluateDelegation({ policy = {}, task = null, taskboard = null, assignments = [], usage = null, now = Date.now() } = {}) {
  const config = supervisionConfigOf(policy)
  if (config.enabled !== true) return refusal('supervision_disabled')
  if (task === null || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '') {
    return refusal('invalid_task')
  }
  // Existing authorization refusals: the supervision layer adds no right, so a
  // delegation it allows is still refused by the host gates. Checking them here
  // keeps the decision explicit (and testable) instead of "allowed then refused".
  if (policy?.mode === MODES.OFF) return refusal('mode_off')
  const mandate = mandateCheck(task, policy)
  if (!mandate.ok) return refusal(mandate.reason)
  const requestedPermission = typeof task.permission === 'string' ? task.permission : ''
  if (requestedPermission !== '' && allowedPermissionOf(policy, requestedPermission) === null) {
    return refusal(`permission_not_allowed:${requestedPermission}`)
  }
  if (policy?.providersConflict === true) return refusal('route_policy_conflict')
  // One LIVE delegation per task: a duplicate tick/approval/dispatch must not
  // start a second session.
  const taskId = String(task.id)
  const duplicate = (Array.isArray(assignments) ? assignments : [])
    .some(assignment => String(assignment?.taskId) === taskId && ACTIVE_DELEGATION_STATUSES.includes(assignment?.status))
  if (duplicate) return refusal('duplicate_assignment')

  const tasks = tasksIn(taskboard)
  const tasksById = new Map(tasks.map(entry => [entry.id, entry]))
  const cycle = detectDependencyCycles(tasks)
  if (cycle.cycles.length > 0 && reachesCycle(taskId, tasksById, cycle.cycles)) {
    return refusal('delegation_cycle')
  }

  const parent = usage?.parentAssignment !== null && typeof usage?.parentAssignment === 'object'
    ? usage.parentAssignment
    : null
  const depth = Number.isFinite(Number(usage?.depth))
    ? Math.max(0, Math.trunc(Number(usage.depth)))
    : (parent === null ? 0 : delegationDepthOf(parent) + 1)
  if (depth > config.maxDelegationDepth) return refusal('delegation_depth_exceeded')

  const taskProject = projectIdentityOf(task)
  const parentProject = typeof usage?.parentProjectId === 'string' && usage.parentProjectId !== ''
    ? projectIdentityOf({ workspaceId: usage.parentProjectId })
    : (parent !== null ? projectIdentityOf({ workspaceId: parent.workspaceId, projectId: parent.projectId }) : null)
  const declaredParent = typeof task.parentId === 'string' ? tasksById.get(task.parentId) : undefined
  const parentTaskProject = declaredParent !== undefined ? projectIdentityOf(declaredParent) : null
  const crossProject = (parentProject !== null && projectsDiffer(parentProject, taskProject))
    || (parentTaskProject !== null && projectsDiffer(parentTaskProject, taskProject))
  if (crossProject && config.allowCrossProjectDelegation !== true) return refusal('cross_project_not_allowed')

  const inFlight = Number.isFinite(Number(usage?.inFlight))
    ? Math.max(0, Math.trunc(Number(usage.inFlight)))
    : countActiveDelegations(assignments)
  if (inFlight >= config.maxConcurrentDelegations) return refusal('delegation_concurrency_exceeded')

  const launches = launchesWithinHour(usage, assignments, now)
  if (launches.length >= config.maxDelegationsPerHour) return refusal('delegation_budget_exhausted')

  return { allow: true, reason: 'allowed' }
}

/**
 * Dependency cycles in the Task Board graph.
 *
 * Deterministic and order-independent: tasks and dependencies are traversed in
 * sorted order, and each discovered cycle is rotated to start at its smallest
 * id. A self-dependency is a valid one-element cycle.
 *
 * @param {object[]} tasks Task Board tasks (`{ id, dependsOn }`)
 * @returns {{cycles: string[][], ok: boolean}}
 */
export function detectDependencyCycles(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const byId = new Map()
  for (const task of list) {
    if (task === null || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '') continue
    if (byId.size >= CYCLE_SCAN_LIMIT) break
    byId.set(task.id, task)
  }
  const color = new Map()
  const found = new Map()
  const stack = []
  const visit = id => {
    color.set(id, 1)
    stack.push(id)
    const dependencies = [...new Set(dependenciesOf(byId.get(id)))]
      .filter(dependency => byId.has(dependency))
      .sort()
    for (const dependency of dependencies) {
      const state = color.get(dependency) ?? 0
      if (state === 0) {
        visit(dependency)
        continue
      }
      if (state !== 1) continue
      const start = stack.indexOf(dependency)
      if (start === -1) continue
      const cycle = canonicalCycle(stack.slice(start))
      found.set(cycleKey(cycle), cycle)
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const id of [...byId.keys()].sort()) {
    if ((color.get(id) ?? 0) === 0) visit(id)
  }
  const cycles = [...found.values()].sort(compareCycles)
  return { cycles, ok: cycles.length === 0 }
}

function dependenciesOf(task) {
  return Array.isArray(task?.dependsOn) ? task.dependsOn.map(String) : []
}

/** Rotate the cycle so it starts at its smallest id (stable across input order). */
function canonicalCycle(cycle) {
  let index = 0
  for (let cursor = 1; cursor < cycle.length; cursor += 1) {
    if (cycle[cursor] < cycle[index]) index = cursor
  }
  return [...cycle.slice(index), ...cycle.slice(0, index)]
}

function cycleKey(cycle) {
  return cycle.join('>')
}

function compareCycles(left, right) {
  const size = Math.max(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Does the task itself, or anything it waits for, sit on a cycle? */
function reachesCycle(taskId, tasksById, cycles) {
  const cyclic = new Set(cycles.flat())
  if (cyclic.has(taskId)) return true
  const seen = new Set([taskId])
  const stack = [taskId]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const dependency of dependenciesOf(tasksById.get(current))) {
      if (cyclic.has(dependency)) return true
      if (seen.has(dependency)) continue
      seen.add(dependency)
      if (tasksById.has(dependency)) stack.push(dependency)
    }
  }
  return false
}

function tasksIn(taskboard) {
  if (taskboard === null || typeof taskboard !== 'object' || taskboard.available !== true) return []
  if (!Array.isArray(taskboard.tasks)) return []
  return taskboard.tasks.filter(task => task !== null && typeof task === 'object' && typeof task.id === 'string')
}

/** The two project facts used for the cross-project rule. */
function projectIdentityOf(task) {
  return {
    projectId: typeof task?.projectId === 'string' && task.projectId !== '' ? task.projectId : null,
    workspaceId: typeof task?.workspaceId === 'string' && task.workspaceId !== '' ? task.workspaceId : '',
  }
}

/**
 * Are these two real project identities different?
 *
 * Only a fact can prove a difference: two known `projectId`s that differ, or
 * (when neither task carries a `projectId`) two known workspaces that differ. A
 * missing identity is never read as "different".
 */
function projectsDiffer(left, right) {
  if (left === null || right === null) return false
  if (left.projectId !== null && right.projectId !== null) return left.projectId !== right.projectId
  if (left.workspaceId !== '' && right.workspaceId !== '') return left.workspaceId !== right.workspaceId
  return false
}

function refusal(reason) {
  return { allow: false, reason }
}
