/**
 * Lot 5 — the technical concurrency ceilings are configurable.
 *
 * The product claim is "one developer, fifty AI sessions": these tests pin that
 * the board can actually launch fifty, that the ONLY serialisation left is the
 * working tree, that a provider ceiling QUEUES work instead of failing it, and
 * that an existing policy keeps its numbers.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  CONCURRENCY_HARD_CEILING,
  concurrencyReached,
  effectiveConcurrencyOf,
  normalizeConcurrencyLimit,
  normalizeProviderConcurrency,
  providerCeilingOf,
  providerLoadOf,
} from '../src/contracts/concurrency.js'
import { DEFAULT_POLICY, normalizePolicy, normalizeSupervision } from '../src/contracts/model.js'
import { selectDispatchable } from '../src/orchestrator/dag.js'
import { workingTreeKeyOf, workItemReadinessOf } from '../src/orchestrator/project-work.js'
import { apply } from '../src/host/index.js'
import { resolveBudgetLimits } from '../src/routing/budget.js'
import { setupAgentHandle } from './fixtures/secure-agent-context.js'

/**
 * The machine these tests are ABOUT is the tree lock, not the host's RAM: pin a
 * generous box so the load model of Lot 11 never becomes the reason for a queue
 * (`freemem()` differs on every CI runner).
 */
const FIFTY_SESSIONS_BOX = { parallelism: 64, freeBytes: 64 * 1024 ** 3 }

function mandateFor(projectIds, overrides = {}) {
  return {
    version: 2,
    scopeMode: 'selected',
    selectedWorkspaces: projectIds,
    allConsent: null,
    level: 'L4',
    actions: { launch: true, delegate: true, comment: true, create_task: true, update_task: true },
    projects: Object.fromEntries(projectIds.map(id => [id, { enabled: true, level: 'L4', budget: { maxTasksPerHour: 100 } }])),
    requiresConfiguration: false,
    ...overrides,
  }
}

test('the limits are configurable and the defaults do not move', () => {
  // Documented defaults, unchanged from 0.1.0.
  const defaults = normalizePolicy({})
  assert.equal(defaults.maxConcurrent, 2)
  assert.equal(defaults.supervision.maxConcurrentDelegations, 2)
  assert.equal(defaults.supervision.maxDelegationsPerHour, 6)
  assert.deepEqual(defaults.superagent, { maxConcurrentAgents: 2, cyclesPerHour: 6, modelCallsPerHour: 12 })
  assert.deepEqual(defaults.providerConcurrency, {})

  // A raised ceiling is honoured instead of clamped to 8/16.
  const wide = normalizePolicy({ maxConcurrent: 50, supervision: { maxConcurrentDelegations: 50, maxDelegationsPerHour: 400 }, superagent: { maxConcurrentAgents: 60, cyclesPerHour: 120, modelCallsPerHour: 600 } })
  assert.equal(wide.maxConcurrent, 50)
  assert.equal(wide.supervision.maxConcurrentDelegations, 50)
  assert.equal(wide.supervision.maxDelegationsPerHour, 400)
  assert.deepEqual(wide.superagent, { maxConcurrentAgents: 60, cyclesPerHour: 120, modelCallsPerHour: 600 })

  // `null` = unlimited, `0` = a real zero (freeze), never the other way round.
  assert.equal(normalizeConcurrencyLimit(null, 2), null)
  assert.equal(normalizeConcurrencyLimit(0, 2), 0)
  assert.equal(normalizePolicy({ maxConcurrent: null }).maxConcurrent, null)
  assert.equal(normalizePolicy({ maxConcurrent: 0 }).maxConcurrent, 0)
  assert.equal(normalizeSupervision({ maxDelegationsPerHour: 0 }).maxDelegationsPerHour, 0)
  assert.equal(concurrencyReached(0, 0), true, 'zero delegations means zero')
  assert.equal(concurrencyReached(500, null), false, 'unlimited never refuses')

  // The anti-typo guard only catches a typing mistake.
  assert.equal(normalizeConcurrencyLimit(100_000), CONCURRENCY_HARD_CEILING)
  assert.equal(CONCURRENCY_HARD_CEILING >= 50, true)

  // An existing policy keeps its numbers (migration is not a behaviour change).
  assert.equal(normalizePolicy({ maxConcurrent: 8 }).maxConcurrent, 8)
  assert.equal(resolveBudgetLimits({ maxConcurrent: 8 }).maxConcurrent, 8)
  assert.equal(DEFAULT_POLICY.maxConcurrent, 2)
})

test('the effective global value combines board and supervision, including unlimited', () => {
  assert.equal(effectiveConcurrencyOf({ global: 8, supervisorConcurrent: 3 }).effective, 3)
  assert.equal(effectiveConcurrencyOf({ global: null, supervisorConcurrent: 4 }).effective, 4)
  assert.equal(effectiveConcurrencyOf({ global: 6, supervisorConcurrent: null }).effective, 6)
  const free = effectiveConcurrencyOf({ global: null, supervisorConcurrent: null, running: 12 })
  assert.equal(free.effective, null)
  assert.equal(free.unlimited, true)
  assert.equal(free.running, 12)
  // A disabled supervision layer contributes no ceiling of its own.
  assert.equal(effectiveConcurrencyOf({ global: 5, supervisorConcurrent: 2, supervisionEnabled: false }).effective, 5)
})

test('fifty assignments on ten projects are all dispatched', () => {
  const projectIds = Array.from({ length: 10 }, (_, index) => `p${index}`)
  const tasks = Array.from({ length: 50 }, (_, index) => ({
    id: `t${index}`, title: `Task ${index}`, status: 'todo', urgency: 'normal',
    workspaceId: projectIds[index % projectIds.length], dependsOn: [], priority: 5,
  }))
  const result = selectDispatchable({
    tasks,
    assignments: [],
    policy: { mode: 'autonomous', maxConcurrent: null, autonomyBudget: { maxTasksPerHour: 1000 } },
    now: 1_000,
  })
  assert.equal(result.actions.length, 50, JSON.stringify(result.skipped).slice(0, 300))
  // Ten projects, five items each: the round-robin interleave keeps every project
  // moving instead of draining one.
  const perProject = {}
  for (const action of result.actions) perProject[action.task.workspaceId] = (perProject[action.task.workspaceId] ?? 0) + 1
  assert.deepEqual(Object.values(perProject), [5, 5, 5, 5, 5, 5, 5, 5, 5, 5])

  // The old default (2) still serialises: the change is configuration, not policy.
  const narrow = selectDispatchable({ tasks, assignments: [], policy: { mode: 'autonomous', maxConcurrent: 2 }, now: 1_000 })
  assert.equal(narrow.actions.length, 2)
  // A freeze is still a freeze.
  const frozen = selectDispatchable({ tasks, assignments: [], policy: { mode: 'autonomous', maxConcurrent: 0 }, now: 1_000 })
  assert.equal(frozen.actions.length, 0)
})

test('the working tree is the lock: worktrees run in parallel, the shared tree does not', () => {
  const item = { id: 'work-a', projectId: 'p', source: 'todo', title: 'A', fingerprint: 'wf2-a' }
  const shared = [{ id: 'asg-1', taskId: 'other', workspaceId: 'p', status: 'running', startedAt: 1, isolation: 'none' }]
  const worktree = [{ id: 'asg-2', taskId: 'other', workspaceId: 'p', status: 'running', startedAt: 1, isolation: 'worktree' }]
  assert.equal(workItemReadinessOf(item, { assignments: shared, now: 10 }).reason, 'project_work_in_progress')
  assert.equal(workItemReadinessOf(item, { assignments: worktree, now: 10 }).reason, 'ready')
  assert.equal(workingTreeKeyOf(shared[0]), 'shared:p')
  assert.equal(workingTreeKeyOf(worktree[0]), 'worktree:p:asg-2')
  // Two different worktrees never contend.
  const two = [
    { id: 'asg-3', taskId: 'a', workspaceId: 'p', status: 'running', startedAt: 1, isolation: 'worktree' },
    { id: 'asg-4', taskId: 'b', workspaceId: 'p', status: 'running', startedAt: 1, isolation: 'worktree' },
  ]
  assert.equal(workItemReadinessOf({ ...item, id: 'work-c' }, { assignments: two, now: 10 }).reason, 'ready')
})

test('a provider ceiling queues the work instead of failing it', () => {
  const limits = normalizeProviderConcurrency({ 'p/model': 1, q: 4, '': 9, bad: 'x' })
  assert.deepEqual(limits, { 'p/model': 1, q: 4 })
  const assignments = [
    { status: 'running', model: { provider: 'p', model: 'model' } },
    { status: 'running', model: { provider: 'q', model: 'other' } },
    { status: 'done', model: { provider: 'p', model: 'model' } },
  ]
  const load = providerLoadOf(assignments)
  assert.equal(load.p, 1)
  assert.equal(load['p/model'], 1)
  assert.equal(load.q, 1)
  assert.deepEqual(providerCeilingOf(limits, { provider: 'p', model: 'model' }), { key: 'p/model', limit: 1 })
  assert.deepEqual(providerCeilingOf(limits, { provider: 'q', model: 'other' }), { key: 'q', limit: 4 })
  assert.equal(providerCeilingOf(limits, { provider: 'unknown', model: 'm' }), null)
})

// ------------------------------------------------------------------ host level
function makeCtx({ projectIds }) {
  const listeners = new Map()
  const routes = new Map()
  const created = []
  const handles = new Map()
  const workspaceOf = id => (projectIds.includes(id) ? { id, path: process.cwd(), attachSession: async () => {} } : undefined)
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: { get: workspaceOf, list: () => projectIds.map(id => ({ id, title: id, path: process.cwd() })) },
    agents: {
      async create(options) {
        created.push(options)
        const agent = { id: options.sessionId, inject() {}, followup() {}, cancel() {} }
        handles.set(options.sessionId, agent)
        return setupAgentHandle(options, { agent, dispose: async () => { handles.delete(options.sessionId) } })
      },
      get: id => handles.get(id),
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'model' }) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, routes, created }
}

function call(routes, method, path, body) {
  const handler = routes.get('/dsh-agent-board/api/v2').handler
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = `/dsh-agent-board/api/v2${path}`
  req.headers = {}
  const res = {
    status: 0, body: '',
    writeHead(code) { this.status = code },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    on() {},
  }
  handler(req, res)
  return res
}

async function callJson(routes, method, path, body, timeoutMs = 15000) {
  const res = call(routes, method, path, body)
  const started = Date.now()
  while (res.body === '' && Date.now() - started < timeoutMs) await new Promise(resolve => setTimeout(resolve, 10))
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

test('fifty real assignments across ten projects are launched under the TREE lock', async () => {
  const projectIds = Array.from({ length: 10 }, (_, index) => `p${index}`)
  const tasks = Array.from({ length: 50 }, (_, index) => ({
    id: `t${index}`, title: `Task ${index}`, status: 'todo', workspaceId: projectIds[index % 10],
    dependsOn: [], version: 1, permission: 'workspace-write', isolation: 'none',
  }))
  const home = await mkdtemp(join(tmpdir(), 'dab-fifty-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => (String(url).includes('/dsh-taskboard/state')
    ? { ok: true, status: 200, json: async () => ({ ok: true, value: { rev: 1, tasks: structuredClone(tasks) } }) }
    : { ok: false, status: 404, json: async () => ({}) })
  const made = makeCtx({ projectIds })
  const dispose = apply(made.ctx, { mandate: mandateFor(projectIds) })
  try {
    await callJson(made.routes, 'GET', '/state')
    // Everything that used to cap the board is lifted explicitly.
    const policy = await callJson(made.routes, 'POST', '/policy', {
      policy: { maxConcurrent: null, supervision: { maxConcurrentDelegations: null, maxDelegationsPerHour: 1000 }, autonomyBudget: { maxTasksPerHour: 1000 }, load: { hardware: FIFTY_SESSIONS_BOX } },
    })
    assert.equal(policy.status, 200, JSON.stringify(policy.body))
    assert.equal(policy.body.value.maxConcurrent, null)
    await callJson(made.routes, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(made.routes, 'POST', '/tick', {}, 90_000)
    assert.equal(tick.status, 200, JSON.stringify(tick.body).slice(0, 400))
    const state = (await callJson(made.routes, 'GET', '/state')).body.value
    assert.equal(state.policy.maxConcurrent, null, 'the ceiling is really lifted, not clamped')
    // These cards share their project directory (`isolation:'none'`), so the TREE
    // lock allows exactly one per project — ten parallel sessions, not fifty.
    assert.equal(made.created.length, 10, JSON.stringify(tick.body).slice(0, 1500))
    const queued = tick.body.actions.filter(action => action.ok === false)
    assert.equal(queued.length, 40)
    assert.ok(queued.every(action => action.reason === 'project_work_in_progress'), JSON.stringify(queued[0]))
    assert.equal(state.assignments.filter(entry => entry.status === 'running' || entry.status === 'starting').length, 10)
  } finally {
    dispose()
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a provider ceiling queues the second launch instead of failing it', async () => {
  // Two DIFFERENT projects, so the tree lock cannot be the reason for the queue.
  const projectIds = ['p0', 'p1']
  const tasks = [0, 1].map(index => ({
    id: `t${index}`, title: `Task ${index}`, status: 'todo', workspaceId: projectIds[index],
    dependsOn: [], version: 1, permission: 'workspace-write', isolation: 'none',
  }))
  const home = await mkdtemp(join(tmpdir(), 'dab-provider-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => (String(url).includes('/dsh-taskboard/state')
    ? { ok: true, status: 200, json: async () => ({ ok: true, value: { rev: 1, tasks: structuredClone(tasks) } }) }
    : { ok: false, status: 404, json: async () => ({}) })
  const made = makeCtx({ projectIds })
  const dispose = apply(made.ctx, { mandate: mandateFor(projectIds) })
  try {
    await callJson(made.routes, 'GET', '/state')
    await callJson(made.routes, 'POST', '/policy', {
      policy: { maxConcurrent: null, supervision: { maxConcurrentDelegations: null }, providerConcurrency: { 'p/model': 1 }, load: { hardware: FIFTY_SESSIONS_BOX } },
    })
    await callJson(made.routes, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(made.routes, 'POST', '/tick', {}, 60_000)
    assert.equal(tick.status, 200)
    assert.equal(made.created.length, 1, 'only one session may run on that provider/model')
    const refused = tick.body.actions.find(action => action.ok === false)
    assert.ok(refused !== undefined, JSON.stringify(tick.body).slice(0, 400))
    assert.equal(refused.reason, 'provider_concurrency_limit')
    // Queued, not failed: the second card is untouched and still todo.
    const state = (await callJson(made.routes, 'GET', '/state')).body.value
    assert.equal(state.assignments.length, 1)
    assert.equal(state.policy.providerConcurrency['p/model'], 1)
  } finally {
    dispose()
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
