/**
 * GOAL 6 test helpers.
 *
 * `TEST_MANDATE` is the explicit operator mandate a test host is allowed to act
 * under. It is deliberately a *fixture*, not a default: a host without it (or
 * without POST /mandate) must refuse every launch, and the dedicated
 * `goal6-host-gate` tests prove that.
 */

const TEST_PROJECTS = ['w1', 'w2', 'ws-a', 'ws-b']

export const TEST_MANDATE = Object.freeze({
  scopeMode: 'selected',
  selectedWorkspaces: TEST_PROJECTS,
  level: 'L4',
  actions: Object.freeze({
    comment: true,
    create_task: true,
    update_task: true,
    launch: true,
    schedule: true,
    push_branch: true,
    delegate: true,
    open_pr: true,
    merge: false,
    protected_branch_write: false,
    delete_task: false,
    secrets: false,
    policy_change: false,
  }),
  projects: Object.freeze(Object.fromEntries(TEST_PROJECTS.map(projectId => [projectId, {
    enabled: true,
    level: 'L4',
    priority: 5,
    budget: { maxTasksPerHour: 100 },
  }]))),
  requiresConfiguration: false,
})

/** The same shape, usable as a POST /mandate body. */
export function testMandate(body = {}) {
  return { mandate: { ...TEST_MANDATE, ...body } }
}
