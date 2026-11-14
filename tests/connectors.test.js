import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskboardAdapter } from '../src/connectors/taskboard.js'
import { createGithubAdapter } from '../src/connectors/github.js'
import { buildCheckpoint, handoffPrompt, reconcileCheckpoint } from '../src/recovery/checkpoint.js'

// Fixture mirrors the REAL dsh-taskboard 0.10.2 ledger contract:
// `value.revision` (global) and a per-task `version`, plus executions[] and the
// claim/isolation fields. See dsh-taskboard src/shared/protocol.ts (TaskRecord).
const stateBody = {
  ok: true,
  value: {
    revision: 174,
    tasks: [
      {
        id: 't1', title: 'Real task', status: 'todo', urgency: 'urgent', workspaceId: 'w1', dependsOn: [],
        version: 3, execution: { mode: 'claim' }, isolation: 'none', permission: 'workspace-write',
        executions: [{ id: 'e0', outcome: 'succeeded', trigger: 'manual' }],
      },
      { id: 't2', title: 'Blocked', status: 'todo', urgency: 'normal', workspaceId: 'w1', dependsOn: ['t1'], version: 1, execution: { mode: 'claim' } },
      { id: 't3', title: 'Trashed', status: 'todo', workspaceId: 'w1', trashedAt: 5 },
      { id: 't4', title: 'Claimed', status: 'in_progress', workspaceId: 'w1', version: 7, claimedBy: 'session-x', claimedAt: 10, execution: { mode: 'claim' } },
      {
        id: 't5', title: 'Isolated running', status: 'todo', workspaceId: 'w1', version: 2, isolation: 'worktree',
        executions: [{ id: 'e1', outcome: 'running', trigger: 'manual' }],
      },
    ],
    doneCount: 0,
  },
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

test('task board adapter normalizes tasks and declares its real capabilities', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, status: 200, json: async () => stateBody }))
  const adapter = createTaskboardAdapter({ baseUrl: 'http://127.0.0.1:62337', fetchImpl, token: () => 'test-token' })
  const listed = await adapter.list()
  assert.equal(listed.items.length, 5)
  const first = listed.items[0]
  assert.equal(first.id, 't1')
  assert.equal(first.canonicalId, 'dsh-taskboard:t1')
  // Per-task `version` is the optimistic-concurrency revision, NOT the global ledger revision.
  assert.equal(first.revision, 3)
  assert.equal(first.version, 3)
  assert.equal(first.activeExecution, false)
  assert.equal(first.lastExecutionOutcome, 'succeeded')
  assert.equal(first.execution.mode, 'claim')
  assert.equal(first.permission, 'workspace-write')
  assert.equal(first.isolation, 'none')
  assert.equal(listed.meta.ledgerRevision, 174, 'the ledger revision is exposed in meta only')
  assert.equal(listed.items[1].revision, 1)
  // A task without a version must NOT borrow the global ledger revision: that
  // silently re-keyed the idempotency key on every unrelated ledger write.
  assert.equal(listed.items[2].revision, null)
  // Claim + execution truth is visible to the orchestrator.
  assert.equal(listed.items[3].claimedBy, 'session-x')
  assert.equal(listed.items[4].activeExecution, true)
  assert.equal(listed.items[4].activeExecutionId, 'e1')
  const caps = adapter.describe().capabilities
  // Board-content writes are real (public API) when the token resolver answers;
  // transition/move/delete remain absent: `done` is never an adapter action.
  assert.deepEqual(Object.keys(caps).filter(key => caps[key]).sort(), ['comment', 'create', 'get', 'list', 'run', 'update'])
  assert.equal(typeof adapter.runTask, 'function')
  assert.equal(typeof adapter.create, 'function')
  assert.equal(typeof adapter.update, 'function')
  assert.equal(typeof adapter.comment, 'function')
  assert.equal(adapter.writesReady(), true)
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:62337/dsh-taskboard/state')
})

test('task board adapter accepts the legacy `rev` alias and never invents a task revision', async () => {
  const legacy = {
    ok: true,
    value: { rev: 9, tasks: [{ id: 't9', title: 'No version', status: 'todo', workspaceId: 'w1' }] },
  }
  const adapter = createTaskboardAdapter({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: fakeFetch(async () => ({ ok: true, status: 200, json: async () => legacy })),
  })
  const listed = await adapter.list()
  assert.equal(listed.meta.ledgerRevision, 9)
  assert.equal(listed.items[0].revision, null, 'no per-task version -> null, not the ledger revision')
})

test('the adapter matrix never advertises a capability a skeleton does not implement', async () => {
  const { createConnectors } = await import('../src/connectors/registry.js')
  const { adapters } = createConnectors({ baseUrl: 'http://127.0.0.1:1' }).describe()
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]))
  const taskboard = byId.get('dsh-taskboard')
  assert.equal(taskboard.capabilities.list, true)
  assert.equal(taskboard.capabilities.get, true)
  // The board-content writes are implemented (public API); whether they are
  // USABLE depends on the local token and is reported per call.
  assert.ok(taskboard.declaredCapabilities.includes('create'))
  assert.ok(taskboard.declaredCapabilities.includes('update'))
  assert.ok(taskboard.declaredCapabilities.includes('comment'))
  assert.ok(!taskboard.declaredCapabilities.includes('transition'))
  for (const id of ['gitlab', 'forgejo', 'gitea', 'bitbucket', 'jira', 'linear']) {
    const adapter = byId.get(id)
    assert.equal(adapter.status, 'unavailable', id)
    assert.deepEqual(adapter.declaredCapabilities, [], id)
    assert.deepEqual(Object.values(adapter.capabilities).filter(Boolean), [], `${id} must not advertise capabilities`)
  }
  const github = byId.get('github')
  assert.equal(github.validatedLive, false, 'the GitHub adapter is not validated live')
})

test('task board adapter reports HTTP failures with a retryable flag', async () => {
  const adapter = createTaskboardAdapter({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: fakeFetch(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  })
  await assert.rejects(() => adapter.list(), error => error.code === 'http_503' && error.retryable === true)
})

test('task board adapter refuses an envelope without ok:true', async () => {
  const adapter = createTaskboardAdapter({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: fakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'nope' }) })),
  })
  await assert.rejects(() => adapter.list(), error => error.code === 'refused')
})

test('github adapter stays honest: disabled without a repository, read-only when configured', async () => {
  const disabled = createGithubAdapter({ repository: undefined, token: '' })
  assert.equal(disabled.status, 'disabled')
  assert.equal(disabled.describe().validatedLive, false)

  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => [{ number: 7, title: 'Issue', state: 'open', html_url: 'https://x/7' }],
  }))
  const enabled = createGithubAdapter({ repository: 'owner/name', token: 'token', fetchImpl })
  const listed = await enabled.list()
  assert.equal(listed.items[0].canonicalId, 'github:7')
  const caps = enabled.describe().capabilities
  assert.deepEqual(Object.keys(caps).filter(key => caps[key]).sort(), ['checks', 'get', 'list', 'listIssues'])
  assert.equal(caps.create, false, 'writes are opt-in, off by default')
  assert.equal(caps.merge, false, 'this build never merges')
  assert.equal(typeof enabled.runTask, 'undefined')
})

test('checkpoint captures git reality and the handoff prompt states the prohibitions', () => {
  const checkpoint = buildCheckpoint({
    assignment: { id: 'asg-1', taskId: 't1' },
    sessionId: 's-old',
    lastText: 'Implemented the connector.',
    git: { head: 'abc123', branch: 'main', status: ' M src/a.js', commits: ['abc123 feat'], changedFiles: ['src/a.js'] },
    tests: [{ name: 'node --test', outcome: 'pass' }],
    actions: [{ kind: 'taskboard_move', target: 't1', idempotent: false, effect: 'unknown' }],
    stepsDone: ['connector'],
    stepsRemaining: ['tests'],
    now: 1000,
  })
  assert.equal(checkpoint.taskId, 't1')
  assert.equal(checkpoint.git.head, 'abc123')
  const prompt = handoffPrompt(checkpoint, {
    task: { id: 't1', title: 'Task' },
    fromRoute: { provider: 'a', model: 'b' },
    toRoute: { provider: 'c', model: 'd' },
    reason: 'server_error',
  })
  assert.ok(prompt.includes('a/b -> c/d'))
  assert.ok(prompt.includes('Never replay an external action'))
  assert.ok(prompt.includes('`done` is reserved to the human operator'))
  assert.ok(prompt.includes('taskboard_move t1'))
})

test('checkpoint reconciliation reports drift and flags unknown external effects', () => {
  const checkpoint = buildCheckpoint({
    assignment: { id: 'a', taskId: 't' },
    sessionId: 's',
    git: { head: 'h1', branch: 'main', status: '', commits: [], changedFiles: [] },
    actions: [
      { kind: 'push', target: 'origin/main', idempotent: false, effect: 'unknown' },
      { kind: 'comment', target: 't', idempotent: true, effect: 'unknown' },
    ],
  })
  const reconciled = reconcileCheckpoint(checkpoint, { head: 'h2', status: ' M x' })
  assert.equal(reconciled.consistent, false)
  assert.deepEqual(reconciled.drift.sort(), ['git_head_changed', 'worktree_changed'])
  assert.deepEqual(reconciled.verify, ['push:origin/main'])
})
