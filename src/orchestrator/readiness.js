/**
 * The ONE readiness rule for starting a Task Board card.
 *
 * The deterministic scheduler, the Super Agent cycle and the launch gate all
 * need the same answer, and a card that is not ready must never open a worker
 * session. Keeping the rule pure and shared prevents the "the scheduler
 * filters it but the LLM path does not" class of defect.
 *
 * A card is ready only when:
 *   - it is not trashed;
 *   - it is `todo` (backlog is not an authorization to execute);
 *   - it is not blocked;
 *   - it is not explicitly waiting for a human decision;
 *   - every prerequisite it declares is human-approved `done`.
 *
 * `done` is the Task Board's human acceptance state: `in_review` is finished
 * work awaiting review, not a satisfied prerequisite.
 *
 * @module dsh-agent-board/orchestrator/readiness
 */

/** Stable reason codes, one per failed condition. */
export const READINESS_REASONS = Object.freeze({
  invalid: 'invalid_task',
  trashed: 'task_trashed',
  notTodo: 'task_not_todo',
  blocked: 'task_blocked',
  waitingHuman: 'task_waiting_for_human',
  dependencies: 'dependencies_unsatisfied',
  ready: 'ready',
})

/**
 * @param {object|null} task           the Task Board card (normalized or raw)
 * @param {Map<string, object>} [tasksById]  every known card, for prerequisites
 * @returns {{ready: boolean, reason: string, pending?: string[]}}
 */
export function taskReadinessOf(task, tasksById = new Map()) {
  if (task === null || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '') {
    return { ready: false, reason: READINESS_REASONS.invalid }
  }
  if (task.trashedAt !== undefined && task.trashedAt !== null) {
    return { ready: false, reason: READINESS_REASONS.trashed }
  }
  const status = typeof task.status === 'string' ? task.status : 'unknown'
  if (status !== 'todo') {
    return { ready: false, reason: `${READINESS_REASONS.notTodo}:${status}` }
  }
  if (task.blocked === true) return { ready: false, reason: READINESS_REASONS.blocked }
  if (task.waitingForHuman === true) return { ready: false, reason: READINESS_REASONS.waitingHuman }
  const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []
  const index = tasksById instanceof Map ? tasksById : new Map()
  const pending = dependsOn.filter(dependency => {
    const prerequisite = index.get(dependency)
    return prerequisite === undefined || prerequisite.status !== 'done'
  })
  if (pending.length > 0) {
    return { ready: false, reason: `${READINESS_REASONS.dependencies}:${pending.slice(0, 5).join(',')}`, pending }
  }
  return { ready: true, reason: READINESS_REASONS.ready }
}
