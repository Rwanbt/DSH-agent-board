/**
 * Super Orchestrator delegation gate tests.
 *
 * `evaluateDelegation` is pure: it can only NARROW what the existing
 * authorization gates allow, it explains every refusal with a stable reason
 * code, and a refusal must never consume a lease or create a session.
 *
 * @module dsh-agent-board/tests/delegation
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MODES, normalizePolicy } from '../src/contracts/model.js'
import {
  countActiveDelegations,
  delegationDepthOf,
  delegationUsageOf,
  detectDependencyCycles,
  evaluateDelegation,
  supervisionConfigOf,
} from '../src/orchestrator/delegation.js'

const NOW = 1_000_000
const HOUR = 3_600_000

function policy(overrides = {}) {
  return normalizePolicy({ mode: MODES.AUTONOMOUS, ...overrides })
}

function task(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Delegated task',
    status: 'todo',
    workspaceId: 'w1',
    projectId: 'p1',
    dependsOn: [],
    claimedBy: null,
    revision: 1,
    ...overrides,
  }
}

function taskboard(tasks = [], overrides = {}) {
  return { available: true, reason: null, source: 'live', tasks, capabilities: { read: true }, ...overrides }
}

function evaluate({ policy: boardPolicy = policy(), tasks = [task()], taskEntry, assignments = [], usage = null, now = NOW } = {}) {
  return evaluateDelegation({
    policy: boardPolicy,
    task: taskEntry ?? tasks[0],
    taskboard: taskboard(tasks),
    assignments,
    usage: usage === null ? { inFlight: 0, launches: [] } : usage,
    now,
  })
}

test('a delegation inside every limit is allowed and returns the exact contract shape', () => {
  const verdict = evaluate()
  assert.deepEqual(verdict, { allow: true, reason: 'allowed' })
  assert.equal(supervisionConfigOf(policy()).enabled, true)
  assert.equal(supervisionConfigOf({}).maxConcurrentDelegations, 2, 'a policy without the slice reads as the documented defaults')
})

test('the supervision layer must be enabled', () => {
  const verdict = evaluate({ policy: policy({ supervision: { enabled: false } }) })
  assert.deepEqual(verdict, { allow: false, reason: 'supervision_disabled' })
})

test('the existing mode / mandate / permission / route refusals are reused', () => {
  assert.equal(evaluate({ policy: normalizePolicy({ mode: MODES.OFF }) }).reason, 'mode_off')
  assert.equal(evaluate({ policy: policy({ allowedWorkspaces: ['other'] }) }).reason, 'workspace_not_in_mandate:w1')
  assert.equal(
    evaluate({ tasks: [task({ permission: 'danger-full-access' })] }).reason,
    'permission_not_allowed:danger-full-access',
  )
  assert.equal(evaluate({ tasks: [task({ permission: 'workspace-write' })] }).allow, true)
  const conflict = { ...policy(), providersConflict: true }
  assert.equal(evaluate({ policy: conflict }).reason, 'route_policy_conflict')
})

test('a duplicate live delegation for the same task is refused', () => {
  const verdict = evaluate({ assignments: [{ id: 'asg-1', taskId: 'task-1', status: 'running' }] })
  assert.deepEqual(verdict, { allow: false, reason: 'duplicate_assignment' })
  // An ENDED attempt no longer blocks a new delegation.
  assert.equal(evaluate({ assignments: [{ id: 'asg-1', taskId: 'task-1', status: 'failed' }] }).allow, true)
})

test('the concurrent delegation limit counts in-flight board assignments', () => {
  const twoActive = [
    { id: 'a', taskId: 'other-1', status: 'running' },
    { id: 'b', taskId: 'other-2', status: 'recovering' },
  ]
  assert.deepEqual(countActiveDelegations(twoActive), 2)
  assert.equal(evaluate({ assignments: twoActive, usage: {} }).reason, 'delegation_concurrency_exceeded')
  // Explicit usage wins when the host already computed it.
  assert.equal(evaluate({ usage: { inFlight: 2, launches: [] } }).reason, 'delegation_concurrency_exceeded')
  assert.equal(evaluate({ usage: { inFlight: 1, launches: [] } }).allow, true)
  // A zero concurrent limit means "no delegation", explicitly.
  assert.equal(
    evaluate({ policy: policy({ supervision: { maxConcurrentDelegations: 0 } }) }).reason,
    'delegation_concurrency_exceeded',
  )
})

test('the hourly delegation budget slides on real launch timestamps', () => {
  const limited = policy({ supervision: { maxDelegationsPerHour: 2 } })
  assert.equal(evaluate({ policy: limited, usage: { inFlight: 0, launches: [NOW - 1000, NOW - 2000] } }).reason, 'delegation_budget_exhausted')
  // One launch is out of the sliding hour: only one counts.
  assert.equal(evaluate({ policy: limited, usage: { inFlight: 0, launches: [NOW - HOUR, NOW - 1000] } }).allow, true)
  // The budget counter's task timestamps are accepted as well.
  assert.equal(evaluate({ policy: limited, usage: { inFlight: 0, tasks: [NOW - 5, NOW - 6] } }).reason, 'delegation_budget_exhausted')
  // Fallback: the durable assignments are the record when no timestamp list is passed.
  const sixRootLaunches = Array.from({ length: 6 }, (_, index) => ({ id: `asg-${index}`, taskId: `t-${index}`, status: 'done', startedAt: NOW - index }))
  assert.equal(evaluate({ policy: policy({ supervision: { maxDelegationsPerHour: 6 } }), usage: { inFlight: 0 }, assignments: sixRootLaunches }).reason, 'delegation_budget_exhausted')
  // A handoff continuation is NOT a new delegation.
  const handoffs = Array.from({ length: 6 }, (_, index) => ({
    id: `asg-${index}`, taskId: 'task-x', status: 'done', startedAt: NOW - index, previousSessionId: `session-${index - 1}`,
  }))
  assert.equal(evaluate({ policy: policy({ supervision: { maxDelegationsPerHour: 6 } }), usage: { inFlight: 0 }, assignments: handoffs }).allow, true)
})

test('the recorded depth gates nested delegations; nothing is inferred', () => {
  const depthOne = policy({ supervision: { maxDelegationDepth: 1 } })
  assert.equal(evaluate({ policy: depthOne, usage: { inFlight: 0, launches: [], depth: 0 } }).allow, true)
  assert.equal(evaluate({ policy: depthOne, usage: { inFlight: 0, launches: [], depth: 1 } }).allow, true)
  assert.equal(evaluate({ policy: depthOne, usage: { inFlight: 0, launches: [], depth: 2 } }).reason, 'delegation_depth_exceeded')
  // A parent assignment's RECORDED delegation is read, never guessed.
  assert.equal(
    evaluate({ policy: depthOne, usage: { inFlight: 0, launches: [], parentAssignment: { delegation: { depth: 1 } } } }).reason,
    'delegation_depth_exceeded',
  )
  assert.equal(
    evaluate({ policy: depthOne, usage: { inFlight: 0, launches: [], parentAssignment: { delegation: { depth: 0 } } } }).allow,
    true,
  )
  assert.equal(delegationDepthOf(null), 0)
  assert.equal(delegationDepthOf({}), 0)
  assert.equal(delegationDepthOf({ startedAt: NOW, sessionId: 's', parentTaskId: 'p' }), 0, 'a timer/session/guess is never a depth')
  assert.equal(delegationDepthOf({ delegation: { depth: 2 } }), 2)
  assert.equal(delegationDepthOf({ delegation: { depth: -1 } }), 0)
  assert.equal(delegationDepthOf({ delegation: { depth: 'not-a-number' } }), 0)
})

test('a cross-project delegation is refused unless explicitly allowed', () => {
  const parentProjectTask = task({ id: 'parent', projectId: 'p2', workspaceId: 'w2' })
  const child = task({ id: 'child', projectId: 'p1', workspaceId: 'w1', parentId: 'parent' })
  const tasks = [child, parentProjectTask]
  assert.equal(evaluate({ tasks, taskEntry: child }).reason, 'cross_project_not_allowed')
  assert.equal(
    evaluate({ tasks, taskEntry: child, policy: policy({ supervision: { allowCrossProjectDelegation: true } }) }).allow,
    true,
  )
  // Same project is not a cross-project delegation.
  const sameProject = [task({ id: 'parent', projectId: 'p1', workspaceId: 'w1' }), { ...child, parentId: 'parent' }]
  assert.equal(evaluate({ tasks: sameProject, taskEntry: sameProject[1] }).allow, true)
  // The parent project can also be given explicitly (e.g. from a journal record).
  assert.equal(evaluate({ usage: { inFlight: 0, launches: [], parentProjectId: 'w2' } }).reason, 'cross_project_not_allowed')
  assert.equal(evaluate({ usage: { inFlight: 0, launches: [], parentProjectId: 'w1' } }).allow, true)
  // A missing identity is never read as "a different project".
  assert.equal(evaluate({ tasks: [task({ id: 'x', projectId: null, workspaceId: '' })] }).allow, true)
})

test('a task that can never become ready (dependency cycle) is refused', () => {
  const a = task({ id: 'a', dependsOn: ['b'] })
  const b = task({ id: 'b', dependsOn: ['a'] })
  const c = task({ id: 'c', dependsOn: [] })
  const d = task({ id: 'd', dependsOn: ['a'] })
  const tasks = [a, b, c, d]
  assert.equal(evaluate({ tasks, taskEntry: a }).reason, 'delegation_cycle')
  assert.equal(evaluate({ tasks, taskEntry: d }).reason, 'delegation_cycle', 'depending on a cyclic task is equally hopeless')
  assert.equal(evaluate({ tasks, taskEntry: c }).allow, true, 'an unrelated task is not blocked by a distant cycle')
})

test('detectDependencyCycles is deterministic, deduplicated and order independent', () => {
  assert.deepEqual(detectDependencyCycles([]), { cycles: [], ok: true })
  assert.deepEqual(detectDependencyCycles([task({ id: 'solo', dependsOn: ['ghost'] })]), { cycles: [], ok: true })
  const a = task({ id: 'a', dependsOn: ['b'] })
  const b = task({ id: 'b', dependsOn: ['c'] })
  const c = task({ id: 'c', dependsOn: ['a'] })
  const forward = detectDependencyCycles([a, b, c])
  const shuffled = detectDependencyCycles([c, a, b])
  assert.equal(forward.ok, false)
  assert.deepEqual(forward.cycles, [['a', 'b', 'c']], 'the cycle is rotated to its smallest id')
  assert.deepEqual(shuffled.cycles, forward.cycles, 'input order never changes the result')
  assert.equal(detectDependencyCycles([task({ id: 'loop', dependsOn: ['loop'] })]).cycles.length, 1)
  // A dependency pointing at an unknown task cannot be a cycle.
  assert.equal(detectDependencyCycles([a, b, task({ id: 'c', dependsOn: ['ghost'] })]).ok, true)
})

test('a refusal is explicit and creates nothing: no lease, no session, no mutation', () => {
  const frozenTask = deepFreeze(task({ id: 'deep', parentId: 'parent' }))
  const frozenParent = deepFreeze(task({ id: 'parent', projectId: 'p2', workspaceId: 'w2' }))
  const frozenTaskboard = deepFreeze(taskboard([frozenParent, frozenTask]))
  const frozenAssignments = deepFreeze([])
  const verdict = evaluateDelegation({
    policy: deepFreeze(policy()),
    task: frozenTask,
    taskboard: frozenTaskboard,
    assignments: frozenAssignments,
    usage: deepFreeze({ inFlight: 0, launches: [], depth: 2 }),
    now: NOW,
  })
  assert.deepEqual(verdict, { allow: false, reason: 'delegation_depth_exceeded' })
  assert.deepEqual(Object.keys(verdict), ['allow', 'reason'], 'a refusal is a decision, not a mutated record')
  assert.equal(frozenAssignments.length, 0, 'a refused delegation consumes no lease slot')
  assert.equal('lease' in frozenTask, false)
  assert.equal('sessionId' in frozenTask, false)
  // Allowed path is equally pure.
  const allowed = evaluateDelegation({
    policy: deepFreeze(policy()),
    task: frozenTask,
    taskboard: deepFreeze(taskboard([task({ id: 'deep', projectId: 'p1', workspaceId: 'w1' })])),
    assignments: frozenAssignments,
    usage: deepFreeze({ inFlight: 0, launches: [] }),
    now: NOW,
  })
  assert.equal(allowed.allow, true)
  assert.equal(frozenAssignments.length, 0)
})

test('delegationUsageOf reads real in-flight and root launch facts only', () => {
  const assignments = [
    { id: 'a', taskId: 't1', status: 'running', startedAt: NOW - 10 },
    { id: 'b', taskId: 't1', status: 'done', startedAt: NOW - 20 },
    { id: 'c', taskId: 't1', status: 'recovering', startedAt: NOW - HOUR, previousSessionId: 's0' },
    { id: 'd', taskId: 't2', status: 'starting', startedAt: NOW + 5 },
  ]
  assert.deepEqual(delegationUsageOf(assignments, NOW), { inFlight: 3, launches: [NOW - 10, NOW - 20, NOW + 5] })
})

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}
