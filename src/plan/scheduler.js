/**
 * Fair multi-project scheduling — pure ordering helpers.
 *
 * Fairness rule (deterministic, testable):
 *   1. the operator's explicit priority wins (0 = highest);
 *   2. among equal priorities, the project that has waited the LONGEST since it
 *      was last served goes first (anti-starvation);
 *   3. then the project served the fewest times in the sliding hour;
 *   4. then the project id, for a stable total order.
 *
 * This module never decides whether work may run: it only orders candidates the
 * host has already authorized. `nextPlanActions` reports why nothing can happen
 * instead of inventing a task.
 *
 * @module dsh-agent-board/plan/scheduler
 */

export const SCHEDULER_LIMITS = Object.freeze({
  maxActions: 8,
  windowMs: 60 * 60 * 1000,
})

function servedOf(project) {
  const value = Number(project?.servedThisHour)
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function waitedOf(project, now) {
  const last = Number(project?.lastServedAt)
  if (!Number.isFinite(last) || last <= 0) return Number.MAX_SAFE_INTEGER
  return Math.max(0, now - last)
}

/** The fair, stable total order of projects. */
export function fairOrder(projects = [], now = Date.now()) {
  return [...projects].sort((left, right) => {
    const priorityLeft = Number.isFinite(Number(left?.priority)) ? Number(left.priority) : 5
    const priorityRight = Number.isFinite(Number(right?.priority)) ? Number(right.priority) : 5
    if (priorityLeft !== priorityRight) return priorityLeft - priorityRight
    const waitedLeft = waitedOf(left, now)
    const waitedRight = waitedOf(right, now)
    if (waitedLeft !== waitedRight) return waitedRight - waitedLeft
    const servedLeft = servedOf(left)
    const servedRight = servedOf(right)
    if (servedLeft !== servedRight) return servedLeft - servedRight
    return String(left?.projectId ?? '').localeCompare(String(right?.projectId ?? ''))
  })
}

/**
 * Turn the portfolio + current assignments into the next planned actions.
 *
 * @param {object} input
 * @param {object} input.portfolio        buildPortfolio() result
 * @param {Array}  [input.assignments]    live board assignments
 * @param {number} [input.maxActions]
 * @param {number} [input.maxConcurrent]
 * @param {number} [input.now]
 * @returns {{actions:object[], idleReason:string|null, order:string[]}}
 */
export function nextPlanActions({
  portfolio,
  assignments = [],
  maxActions = SCHEDULER_LIMITS.maxActions,
  maxConcurrent = Number.POSITIVE_INFINITY,
  now = Date.now(),
} = {}) {
  const projects = Array.isArray(portfolio?.projects) ? portfolio.projects : []
  const running = (assignments ?? []).filter(assignment => ['starting', 'running', 'recovering'].includes(assignment?.status))
  const slots = Math.max(0, Number(maxConcurrent) - running.length)
  const runningByProject = new Map()
  for (const assignment of running) {
    const projectId = String(assignment?.workspaceId ?? assignment?.projectId ?? '')
    if (projectId === '') continue
    runningByProject.set(projectId, (runningByProject.get(projectId) ?? 0) + 1)
  }

  const ordered = fairOrder(projects.filter(project => project?.selected === true), now)
  const order = ordered.map(project => project.projectId)
  if (order.length === 0) return { actions: [], idleReason: 'no_selected_projects', order }

  const enabled = ordered.filter(project => project.enabled === true)
  if (enabled.length === 0) return { actions: [], idleReason: 'no_enabled_projects', order }

  const withWork = enabled.filter(project => Number(project?.taskCounts?.todo) > 0)
  if (withWork.length === 0) return { actions: [], idleReason: 'no_ready_work', order }

  if (slots === 0) return { actions: [], idleReason: 'concurrency_full', order }

  // Round-robin over the fair order so one project cannot monopolize the slots.
  const actions = []
  let index = 0
  while (actions.length < Math.min(maxActions, slots) && index < withWork.length * SCHEDULER_LIMITS.maxActions) {
    const project = withWork[index % withWork.length]
    const alreadyRunning = runningByProject.get(project.projectId) ?? 0
    // `serializeSameWorkspace`-like fairness: a project with a live assignment
    // yields to a project that has none, when another one can run.
    if (alreadyRunning === 0 || withWork.every(candidate => (runningByProject.get(candidate.projectId) ?? 0) > 0)) {
      actions.push({
        projectId: project.projectId,
        priority: project.priority ?? 5,
        effectiveLevel: project.effectiveLevel,
        // The host fills the exact card; the plan only says "one unit here".
        kind: 'consider_project',
      })
    }
    index += 1
  }
  return {
    actions: actions.slice(0, Math.min(maxActions, slots)),
    idleReason: actions.length === 0 ? 'no_slot_available_by_fairness' : null,
    order,
  }
}
