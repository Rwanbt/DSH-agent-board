/**
 * Unified execution backend (`executionBackend:'contract'`) — host level.
 *
 * The Task Board owns the canonical execution record; the board creates the
 * session (so model/provider failover stays possible) and ATTACHES it to the
 * leased execution. These tests drive the real host HTTP API against the
 * SIMULATED Task Board extension (tests/fixtures/fake-taskboard-server.mjs):
 * every response of that fixture is stamped `x-simulated-contract: true`, so
 * nothing here is evidence of a live Task Board integration.
 *
 * @module dsh-agent-board/tests/unified-backend
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'
import { startSimulatedTaskBoard, simulatedTask } from './fixtures/fake-taskboard-server.mjs'

function makeCtx() {
  const created = []
  const cancelled = []
  const injected = []
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register: route => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    connection: { requestRejection: () => undefined },
    effect(fn) {
      const dispose = fn()
      return () => { dispose?.() }
    },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          id: options.sessionId,
          inject: message => injected.push(message),
          followup: message => injected.push(message),
          cancel: cause => cancelled.push({ sessionId: options.sessionId, cause }),
        }
        return { agent, dispose: async () => {} }
      },
      get(id) {
        const match = created.find(options => options.sessionId === id)
        if (match === undefined) return undefined
        return { cancel: cause => cancelled.push({ sessionId: id, cause }) }
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  }
  return { ctx, created, cancelled, injected, listeners, routes }
}

function call(handler, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = `/dsh-agent-board/api/v2${path}`
  req.headers = {}
  const res = {
    status: 0,
    body: '',
    writeHead(code) { this.status = code },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
  }
  handler(req, res)
  return res
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return false
}

async function callJson(handler, method, path, body) {
  const res = call(handler, method, path, body)
  await waitFor(() => res.body !== '')
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

const ROUTE_CHAIN = [
  { provider: 'primary', model: 'big', locality: 'remote' },
  { provider: 'backup', model: 'small', locality: 'remote' },
]

/** Boot one host against one simulated Task Board, with the contract backend. */
async function boot({ contractMode = 'full', task = simulatedTask({ isolation: 'none' }) } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-unified-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const board = await startSimulatedTaskBoard({
    contractMode,
    tasks: [task, simulatedTask({ id: 't-contract-other', title: 'Other task', version: 1, isolation: 'none', execution: { mode: 'scheduled' } })],
  })
  const harness = makeCtx()
  const dispose = apply(harness.ctx, { baseUrl: board.url })
  const handlerOf = () => {
    const route = harness.routes.get('/dsh-agent-board/api/v2')
    return route.handler
  }
  const state = async () => (await callJson(handlerOf(), 'GET', '/state')).body.value
  const policy = {
    mode: 'autonomous',
    executionBackend: 'contract',
    routeChain: ROUTE_CHAIN,
    maxConcurrent: 2,
    maxRetries: 0,
    maxSwitches: 2,
    allowedPermissions: ['read-only', 'workspace-write'],
    allowedWorkspaces: ['w1'],
  }
  const ready = async () => {
    await callJson(handlerOf(), 'POST', '/policy', { policy })
    // The policy handler negotiates asynchronously: poll the contract endpoint
    // until the real verdict is published (the panel does the same).
    const started = Date.now()
    while (Date.now() - started < 5000) {
      const probe = await callJson(handlerOf(), 'GET', '/contract')
      if (probe.body?.value?.writes === true) return state()
      if (probe.body?.value?.at !== undefined && probe.body.value.absent === true) return state()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return state()
  }
  return {
    board,
    harness,
    dispose,
    home,
    state,
    ready,
    tick: () => callJson(handlerOf(), 'POST', '/tick', {}),
    post: (path, body) => callJson(handlerOf(), 'POST', path, body),
    emit: (sessionId, event) => {
      const listener = harness.listeners.get('session/event')
      assert.equal(typeof listener, 'function', 'the host must subscribe to session/event')
      listener({ id: sessionId }, event)
    },
    async close() {
      try { dispose?.() } catch { /* teardown must not mask the assertion */ }
      await board.close()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    },
  }
}

function turnEnd(kind, extra = {}) {
  return { type: 'turn/end', time: Date.now(), data: { reason: { kind, ...extra } } }
}

test('contract backend: lease -> session -> attach -> settle succeeded, report attached, card in_review (never done)', async () => {
  const host = await boot()
  try {
    const current = await host.ready()
    assert.equal(current.contract.writes, true, `contract must be negotiated: ${JSON.stringify(current.contract)}`)
    assert.equal(current.contract.simulated, true, 'the fixture is a simulation and must say so')

    const tick = await host.tick()
    assert.equal(tick.status, 200)
    assert.ok(await waitFor(() => host.harness.created.length === 1), 'the board must create exactly one session')
    const sessionId = host.harness.created[0].sessionId

    const running = await waitFor(async () => (await host.state()).assignments.some(entry => entry.sessionId === sessionId && entry.status === 'running'))
    assert.equal(running, true, 'the assignment must be running after attach')
    let view = await host.state()
    const assignment = view.assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(assignment.backend, 'contract')
    assert.equal(typeof assignment.executionId, 'string')
    assert.equal(typeof assignment.leaseId, 'string')

    // The canonical record is running with this session attached.
    let task = host.board.task('t-contract-1')
    assert.equal(task.status, 'in_progress')
    assert.equal(task.executions.length, 1)
    assert.equal(task.executions[0].sessionId, sessionId)
    assert.equal(task.executions[0].outcome, 'running')

    host.emit(sessionId, turnEnd('completed'))
    await waitFor(async () => (await host.state()).assignments.every(entry => entry.status !== 'running'))
    await waitFor(() => host.board.task('t-contract-1').status === 'in_review')
    view = await host.state()

    task = host.board.task('t-contract-1')
    assert.equal(task.status, 'in_review', 'a succeeded execution requests review, never done')
    assert.notEqual(task.status, 'done')
    assert.equal(task.executions[0].outcome, 'succeeded')
    assert.equal(typeof task.executions[0].report?.summary, 'string')
    assert.ok(task.executions[0].report.summary.length > 0)
    // The claim is released by the settle: the next buyer is not blocked.
    assert.equal(task.claimedBy, undefined)
    const settled = view.assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(settled.outcome, 'completed')
    assert.equal(typeof settled.settledAt, 'number')
    assert.equal(settled.settleError, null)
    // The whole dance really happened over HTTP, in order.
    const order = host.board.calls.filter(c => c.method === 'POST').map(c => c.path)
    assert.deepEqual(order.slice(0, 3), [
      '/dsh-taskboard/tasks/t-contract-1/executions/lease',
      `/dsh-taskboard/executions/${assignment.leaseId}/attach`,
      `/dsh-taskboard/executions/${assignment.leaseId}/settle`,
    ])
    assert.ok(!host.board.calls.some(c => c.body?.outcome === 'done'), 'the board must never settle a task to done')
  } finally {
    await host.close()
  }
})

test('contract backend: a 429 after launch switches route and records a SECOND attempt linked to the first', async () => {
  const host = await boot()
  try {
    await host.ready()
    await host.tick()
    assert.ok(await waitFor(() => host.harness.created.length === 1))
    const firstSession = host.harness.created[0].sessionId
    await waitFor(async () => (await host.state()).assignments.some(entry => entry.sessionId === firstSession && entry.status === 'running'))
    const first = (await host.state()).assignments.find(entry => entry.sessionId === firstSession)

    host.emit(firstSession, turnEnd('error', { error: { message: '429 Too Many Requests', status: 429 } }))
    // Handoff: a new attempt, a new session on the fallback route.
    assert.ok(await waitFor(() => host.harness.created.length === 2), 'failover must create a new session')
    const second = host.harness.created[1]
    assert.equal(second.agentOptions?.provider, 'backup')
    assert.equal(second.agentOptions?.model, 'small')

    await waitFor(async () => (await host.state()).assignments.some(entry => entry.sessionId === second.sessionId && entry.status === 'running'))
    const view = await host.state()
    const next = view.assignments.find(entry => entry.sessionId === second.sessionId)
    assert.equal(next.previousSessionId, firstSession)
    assert.equal(next.attempt, 1)
    assert.equal(next.switches, 1)
    assert.equal(next.backend, 'contract')
    // Fencing tokens genuinely advance across attempts (a stale writer of the
    // first attempt can never be mistaken for the second one).
    assert.equal(first.fencingToken, 1)
    assert.equal(next.fencingToken, 2)

    // The first execution is closed as cancelled, the second one links back to it.
    const task = host.board.task('t-contract-1')
    assert.equal(task.executions.length, 2)
    assert.equal(task.executions[0].outcome, 'cancelled')
    assert.equal(task.executions[1].outcome, 'running')
    assert.equal(task.executions[1].sessionId, second.sessionId)
    const leases = host.board.state().leases
    assert.equal(leases.length, 2)
    assert.equal(leases[1].previousExecutionId, leases[0].executionId ?? task.executions[0].id)
    // The handoff must RELEASE before it LEASES the next attempt: a fire-and-forget
    // release races a slow Task Board into `lease_conflict`.
    const writes = host.board.calls.filter(entry => entry.method === 'POST').map(entry => entry.path)
    const releaseAt = writes.indexOf(`/dsh-taskboard/executions/${leases[0].id}/release`)
    const secondLeaseAt = writes.indexOf('/dsh-taskboard/tasks/t-contract-1/executions/lease', 1)
    assert.ok(releaseAt >= 0, 'the first lease must be released on handoff')
    assert.ok(secondLeaseAt >= 0, 'the second attempt must be leased')
    assert.ok(releaseAt < secondLeaseAt, `release (${releaseAt}) must precede the second lease (${secondLeaseAt})`)

    // A LATE event from the superseded session must not settle the new attempt:
    // the old assignment is no longer the live owner of that session id.
    host.emit(firstSession, turnEnd('completed'))
    await new Promise(resolve => setTimeout(resolve, 80))
    const afterLate = (await host.state()).assignments
    assert.equal(afterLate.find(entry => entry.sessionId === second.sessionId).status, 'running')
    assert.equal(afterLate.find(entry => entry.sessionId === firstSession).status, 'superseded')
    assert.equal(host.board.task('t-contract-1').executions[1].outcome, 'running')

    // A completed turn on the fallback route records the PRIMARY RETURN decision.
    host.emit(second.sessionId, turnEnd('completed'))
    await waitFor(() => host.board.task('t-contract-1').status === 'in_review')
    const done = (await host.state()).assignments.find(entry => entry.sessionId === second.sessionId)
    assert.equal(done.outcome, 'completed')
    assert.equal(done.primaryReturn?.eligible, true, 'the next attempt may come back to the primary route')
    assert.equal(host.board.task('t-contract-1').executions[1].outcome, 'succeeded')
  } finally {
    await host.close()
  }
})

test('contract backend: absent extension refuses the launch instead of faking an execution', async () => {
  const host = await boot({ contractMode: 'absent' })
  try {
    await host.ready()
    const tick = await host.tick()
    assert.equal(tick.status, 200)
    const view = await host.state()
    assert.equal(view.contract.writes, false)
    assert.equal(view.contract.absent, true)
    assert.equal(host.harness.created.length, 0, 'no session may be created without a contract')
    const action = view.lastTick.actions.find(entry => entry.kind === 'launch')
    assert.equal(action.ok, false)
    assert.equal(action.reason, 'contract_unavailable')
    const task = host.board.task('t-contract-1')
    assert.equal(task.status, 'todo')
    assert.equal(task.executions.length, 0)
    assert.equal(host.board.calls.some(c => c.method === 'POST'), false, 'an absent contract means zero POSTs')
  } finally {
    await host.close()
  }
})

test('contract backend: a worktree card is refused when the lease returns no prepared directory', async () => {
  const host = await boot({ task: simulatedTask({ isolation: 'worktree' }) })
  try {
    await host.ready()
    await host.tick()
    const settled = await waitFor(async () => {
      const view = await host.state()
      return view.assignments.some(entry => entry.error === 'worktree_isolation_unavailable')
    })
    assert.equal(settled, true, 'an isolated card must never run in the shared workspace')
    assert.equal(host.harness.created.length, 0, 'no session for a card whose worktree is missing')
    const task = host.board.task('t-contract-1')
    assert.equal(task.executions[0]?.outcome, 'cancelled')
    assert.equal(task.status, 'todo')
  } finally {
    await host.close()
  }
})

test('contract backend: Stop cancels the session and closes the canonical execution as cancelled', async () => {
  const host = await boot()
  try {
    await host.ready()
    await host.tick()
    assert.ok(await waitFor(() => host.harness.created.length === 1))
    const sessionId = host.harness.created[0].sessionId
    await waitFor(async () => (await host.state()).assignments.some(entry => entry.sessionId === sessionId && entry.status === 'running'))

    const stop = await host.post('/stop', {})
    assert.equal(stop.status, 200)
    assert.equal(host.harness.cancelled.some(entry => entry.sessionId === sessionId), true, 'the agent must be cancelled')

    const settled = await waitFor(() => host.board.task('t-contract-1').executions[0]?.outcome === 'cancelled')
    assert.equal(settled, true, 'the execution record must not stay running')
    const view = await host.state()
    const assignment = view.assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(assignment.status, 'stopped')
    assert.equal(host.board.task('t-contract-1').status, 'todo')
  } finally {
    await host.close()
  }
})
