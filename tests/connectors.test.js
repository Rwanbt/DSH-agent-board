import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskboardAdapter } from '../src/connectors/taskboard.js'
import { createGithubAdapter } from '../src/connectors/github.js'
import { buildCheckpoint, handoffPrompt, reconcileCheckpoint } from '../src/recovery/checkpoint.js'

const stateBody = {
  ok: true,
  value: {
    rev: 174,
    tasks: [
      { id: 't1', title: 'Real task', status: 'todo', urgency: 'urgent', workspaceId: 'w1', dependsOn: [], revision: 3 },
      { id: 't2', title: 'Blocked', status: 'todo', urgency: 'normal', workspaceId: 'w1', dependsOn: ['t1'] },
      { id: 't3', title: 'Trashed', status: 'todo', workspaceId: 'w1', trashedAt: 5 },
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

test('task board adapter normalizes tasks and keeps only read capabilities', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, status: 200, json: async () => stateBody }))
  const adapter = createTaskboardAdapter({ baseUrl: 'http://127.0.0.1:62337', fetchImpl })
  const listed = await adapter.list()
  assert.equal(listed.items.length, 3)
  const first = listed.items[0]
  assert.equal(first.id, 't1')
  assert.equal(first.canonicalId, 'dsh-taskboard:t1')
  assert.equal(first.revision, 3)
  assert.equal(listed.items[1].revision, 174, 'falls back to the ledger revision when the task has none')
  assert.equal(listed.meta.ledgerRevision, 174)
  const caps = adapter.describe().capabilities
  assert.deepEqual(Object.keys(caps).filter(key => caps[key]).sort(), ['get', 'list'])
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:62337/dsh-taskboard/state')
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
  assert.deepEqual(Object.keys(caps).filter(key => caps[key]).sort(), ['get', 'list'])
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
