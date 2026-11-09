import test from 'node:test'
import assert from 'node:assert/strict'

import { selectDispatchable, readinessOf, dependencyReport, stopPlan, mandateCheck } from '../src/orchestrator/dag.js'
import { MODES, normalizePolicy } from '../src/contracts/model.js'

const tasks = [
  { id: 'a', title: 'A', status: 'todo', urgency: 'urgent', workspaceId: 'w1' },
  { id: 'b', title: 'B', status: 'todo', urgency: 'normal', workspaceId: 'w1', dependsOn: ['a'] },
  { id: 'c', title: 'C', status: 'todo', urgency: 'normal', workspaceId: 'w1', dependsOn: ['z'] },
  { id: 'done', title: 'D', status: 'done', urgency: 'relaxed', workspaceId: 'w1' },
  { id: 'review', title: 'R', status: 'in_review', urgency: 'normal', workspaceId: 'w1' },
]

const byId = new Map(tasks.map(task => [task.id, task]))

test('OFF creates nothing at all', () => {
  const plan = selectDispatchable({ tasks, assignments: [], proposals: [], policy: normalizePolicy({ mode: MODES.OFF }) })
  assert.deepEqual(plan.actions, [])
  assert.equal(plan.mode, MODES.OFF)
})

test('dependencies must be human-confirmed done, never in_review', () => {
  assert.equal(dependencyReport(byId.get('b'), byId).blocked, true)
  assert.equal(dependencyReport(byId.get('c'), byId).missing.length, 1)
  assert.equal(readinessOf({ id: 'x', status: 'todo', dependsOn: ['done'] }, byId).ready, true)
  assert.equal(readinessOf({ id: 'x', status: 'todo', dependsOn: ['review'] }, byId).reason, 'blocked_by:review')
})

test('supervised proposes, it does not launch', () => {
  const plan = selectDispatchable({
    tasks,
    assignments: [],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.SUPERVISED, maxConcurrent: 2 }),
  })
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.actions[0].kind, 'proposal')
  assert.equal(plan.actions[0].taskId, 'a')
})

test('a task the Task Board already runs, claims or schedules is never launched twice', () => {
  const owned = [
    { id: 'run', title: 'Running elsewhere', status: 'todo', urgency: 'normal', workspaceId: 'w1', activeExecution: true },
    { id: 'claimed', title: 'Claimed', status: 'todo', urgency: 'normal', workspaceId: 'w1', claimedBy: 'session-x' },
    { id: 'sched', title: 'Scheduled', status: 'todo', urgency: 'normal', workspaceId: 'w1', execution: { mode: 'scheduled' } },
    { id: 'wt', title: 'Worktree', status: 'todo', urgency: 'normal', workspaceId: 'w1', isolation: 'worktree' },
    { id: 'ok', title: 'Free', status: 'todo', urgency: 'normal', workspaceId: 'w1' },
  ]
  const plan = selectDispatchable({
    tasks: owned,
    assignments: [],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 4 }),
  })
  assert.deepEqual(plan.actions.map(action => action.taskId), ['ok'])
  const reasons = new Map(plan.skipped.map(entry => [entry.taskId, entry.reason]))
  assert.equal(reasons.get('run'), 'already_running_in_taskboard')
  assert.equal(reasons.get('claimed'), 'claimed_by_another_session')
  assert.equal(reasons.get('sched'), 'owned_by_taskboard_scheduler')
  assert.equal(reasons.get('wt'), 'worktree_isolation_not_supported')
})

test('a task asking for a permission outside the mandate is skipped with a reason', () => {
  const withPermission = [
    { id: 'p1', title: 'Needs full access', status: 'todo', workspaceId: 'w1', permission: 'danger-full-access' },
    { id: 'p2', title: 'Read only', status: 'todo', workspaceId: 'w1', permission: 'read-only' },
  ]
  const policy = normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 4 })
  const plan = selectDispatchable({ tasks: withPermission, assignments: [], proposals: [], policy })
  assert.deepEqual(plan.actions.map(action => action.taskId), ['p2'])
  assert.ok(plan.skipped.some(entry => entry.taskId === 'p1' && entry.reason === 'permission_not_allowed:danger-full-access'))
  const widened = selectDispatchable({
    tasks: withPermission,
    assignments: [],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 4, allowedPermissions: ['read-only', 'danger-full-access'] }),
  })
  assert.deepEqual(widened.actions.map(action => action.taskId).sort(), ['p1', 'p2'])
})

test('automatic retries are bounded: cooldown then max attempts per revision', () => {
  const task = { id: 'r1', title: 'Retry me', status: 'todo', workspaceId: 'w1', version: 2 }
  const failed = [{ id: 'a1', taskId: 'r1', revision: 2, attempt: 0, status: 'failed', startedAt: 1000, endedAt: 2000 }]
  const policy = normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 2, retryCooldownMs: 300_000, maxAttemptsPerRevision: 3 })
  const cooling = selectDispatchable({ tasks: [task], assignments: failed, proposals: [], policy, now: 10_000 })
  assert.deepEqual(cooling.actions, [])
  assert.ok(cooling.skipped.some(entry => entry.reason === 'retry_cooldown'))
  const afterCooldown = selectDispatchable({ tasks: [task], assignments: failed, proposals: [], policy, now: 400_000 })
  assert.equal(afterCooldown.actions.length, 1)

  const exhausted = [0, 1, 2].map(attempt => ({ id: `a${attempt}`, taskId: 'r1', revision: 2, attempt, status: 'failed', startedAt: attempt * 1000, endedAt: attempt * 1000 + 500 }))
  const capped = selectDispatchable({ tasks: [task], assignments: exhausted, proposals: [], policy, now: 9_000_000 })
  assert.deepEqual(capped.actions, [])
  assert.ok(capped.skipped.some(entry => entry.reason === 'max_attempts_reached'))

  // A new revision (the human rewrote the card) resets the automatic budget.
  const newRevision = selectDispatchable({ tasks: [{ ...task, version: 3 }], assignments: exhausted, proposals: [], policy, now: 9_000_000 })
  assert.equal(newRevision.actions.length, 1)
})

test('a stopped task is not automatically relaunched during the cooldown', () => {
  const task = { id: 's1', title: 'Stopped', status: 'todo', workspaceId: 'w1', version: 1 }
  const stopped = [{ id: 'a1', taskId: 's1', revision: 1, attempt: 0, status: 'stopped', startedAt: 1000, endedAt: 2000 }]
  const policy = normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 2 })
  const plan = selectDispatchable({ tasks: [task], assignments: stopped, proposals: [], policy, now: 5000 })
  assert.deepEqual(plan.actions, [])
  assert.ok(plan.skipped.some(entry => entry.reason === 'retry_cooldown'))
})

test('serializeSameWorkspace keeps one running agent per workspace when asked', () => {
  const sameProject = [
    { id: 'x', title: 'X', status: 'todo', urgency: 'normal', workspaceId: 'w1' },
    { id: 'y', title: 'Y', status: 'todo', urgency: 'normal', workspaceId: 'w1' },
    { id: 'z', title: 'Z', status: 'todo', urgency: 'normal', workspaceId: 'w2' },
  ]
  const policy = normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 4, serializeSameWorkspace: true })
  const plan = selectDispatchable({ tasks: sameProject, assignments: [], proposals: [], policy })
  // One task per workspace per plan: w1 emits x, w1/y is reserved out, w2 emits z.
  assert.deepEqual(plan.actions.map(action => action.taskId).sort(), ['x', 'z'])
  assert.ok(plan.skipped.some(entry => entry.taskId === 'y' && entry.reason === 'workspace_busy'))
  const first = plan.actions[0]
  const withBusy = selectDispatchable({
    tasks: sameProject,
    assignments: [{ id: 'asg', taskId: 'other', workspaceId: first.workspaceId, status: 'running' }],
    proposals: [],
    policy,
  })
  assert.ok(!withBusy.actions.some(action => action.workspaceId === first.workspaceId))
  assert.ok(withBusy.skipped.some(entry => entry.reason === 'workspace_busy'))
})

test('autonomous launches only ready tasks and respects concurrency', () => {
  const plan = selectDispatchable({
    tasks,
    assignments: [],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 1 }),
  })
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.actions[0].kind, 'launch')
  assert.equal(plan.actions[0].taskId, 'a')
  const skipped = new Map(plan.skipped.map(entry => [entry.taskId, entry.reason]))
  assert.equal(skipped.get('b'), 'blocked_by:a')
})

test('a task already running is never launched twice', () => {
  const plan = selectDispatchable({
    tasks,
    assignments: [{ id: 'asg', taskId: 'a', status: 'running' }],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 2 }),
  })
  assert.equal(plan.actions.length, 0)
  assert.equal(plan.skipped.find(entry => entry.taskId === 'a').reason, 'already_running')
})

test('a pending proposal blocks a second proposal for the same task', () => {
  const plan = selectDispatchable({
    tasks,
    assignments: [],
    proposals: [{ id: 'p1', taskId: 'a', status: 'pending' }],
    policy: normalizePolicy({ mode: MODES.SUPERVISED }),
  })
  assert.equal(plan.actions.length, 0)
})

test('workspace mandate excludes tasks outside the allow-list', () => {
  const plan = selectDispatchable({
    tasks,
    assignments: [],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 2, allowedWorkspaces: ['other'] }),
  })
  assert.equal(plan.actions.length, 0)
  assert.ok(plan.skipped.some(entry => entry.reason.startsWith('workspace_not_in_mandate')))
  assert.equal(mandateCheck({ workspaceId: 'w1' }, { mode: MODES.AUTONOMOUS, allowedWorkspaces: ['other'] }).ok, false)
})

test('autonomy budget stops new launches inside the hour', () => {
  const now = Date.now()
  const plan = selectDispatchable({
    tasks,
    assignments: [{ id: 'old', taskId: 'done', status: 'done', startedAt: now - 1000 }],
    proposals: [],
    policy: normalizePolicy({ mode: MODES.AUTONOMOUS, autonomyBudget: { maxTasksPerHour: 1 } }),
    now,
  })
  assert.equal(plan.actions.length, 0)
  assert.ok(plan.skipped.some(entry => entry.reason === 'autonomy_budget_exhausted'))
})

test('stop plan only targets in-flight assignments', () => {
  const plan = stopPlan([
    { id: '1', taskId: 'a', sessionId: 's1', status: 'running' },
    { id: '2', taskId: 'b', sessionId: 's2', status: 'done' },
  ])
  assert.deepEqual(plan, [{ assignmentId: '1', taskId: 'a', sessionId: 's1' }])
})

test('a done assignment whose card is still todo is bound like a failure', () => {
  const task = { id: 'd1', title: 'Did not claim', status: 'todo', workspaceId: 'w1', version: 1 }
  const done = [{ id: 'a1', taskId: 'd1', revision: 1, attempt: 0, status: 'done', startedAt: 1000, endedAt: 2000 }]
  const policy = normalizePolicy({ mode: MODES.AUTONOMOUS, maxConcurrent: 2, maxAttemptsPerRevision: 2 })
  const cooling = selectDispatchable({ tasks: [task], assignments: done, proposals: [], policy, now: 10_000 })
  assert.deepEqual(cooling.actions, [])
  assert.ok(cooling.skipped.some(entry => entry.reason === 'retry_cooldown'))
  const exhausted = selectDispatchable({ tasks: [task], assignments: [...done, { ...done[0], id: 'a2', attempt: 1 }], proposals: [], policy, now: 9_000_000 })
  assert.deepEqual(exhausted.actions, [])
  assert.ok(exhausted.skipped.some(entry => entry.reason === 'max_attempts_reached'))
})
