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
