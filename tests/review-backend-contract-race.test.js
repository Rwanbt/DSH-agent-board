/**
 * INDEPENDENT REVIEW — contract backend races (tests/review-backend-*.test.js).
 *
 * These are non-regression tests for findings in docs/REVIEW-GOAL3-BACKEND.md.
 * They assert the DESIRED behaviour, so they FAIL on the reviewed commit
 * (ad4dccf) until the finding is fixed. They drive the real host HTTP API
 * against the SIMULATED Task Board extension (tests/fixtures/fake-taskboard-server.mjs).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'
import { TEST_MANDATE } from './goal6-helpers.js'
import { startSimulatedTaskBoard, simulatedTask } from './fixtures/fake-taskboard-server.mjs'

function makeCtx({ createGate = null } = {}) {
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
        if (createGate !== null) await createGate
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
    on() {},
    destroy() {},
  }
  handler(req, res)
  return res
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
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

/** Delay only the `.../release` POST so the handoff's fire-and-forget loses. */
function installDelayedRelease(delayMs = 150) {
  const previous = globalThis.fetch
  const releases = []
  const log = []
  globalThis.fetch = async (url, init) => {
    log.push(`${Date.now()} enter ${String(url)}`)
    if (String(url).includes('/executions/') && String(url).endsWith('/release')) {
      releases.push(String(url))
      await new Promise(resolve => setTimeout(resolve, delayMs))
      log.push(`${Date.now()} send release`)
    }
    return previous(url, init)
  }
  return { restore: () => { globalThis.fetch = previous }, releases, log }
}

/** Delay only the `.../attach` POST so a Stop can land while it is in flight. */
function installDelayedAttach(delayMs = 120) {
  const previous = globalThis.fetch
  const probe = { started: false }
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/attach')) {
      probe.started = true
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
    return previous(url, init)
  }
  return { restore: () => { globalThis.fetch = previous }, probe }
}

/** Delay only the LEASE POST so a Stop can land before the leaseId is known. */
function installDelayedLease(delayMs = 120) {
  const previous = globalThis.fetch
  const probe = { started: false }
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/executions/lease')) {
      probe.started = true
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
    return previous(url, init)
  }
  return { restore: () => { globalThis.fetch = previous }, probe }
}

async function boot({ contractMode = 'full', task = simulatedTask({ isolation: 'none' }), gate = null, delayRelease = 0, delayAttach = 0, delayLease = 0 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-review-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const board = await startSimulatedTaskBoard({
    contractMode,
    tasks: [task, simulatedTask({ id: 't-contract-other', title: 'Other task', version: 1, isolation: 'none', execution: { mode: 'scheduled' } })],
  })
  let releaseGate = () => {}
  let gatePromise = null
  if (gate === 'create') {
    gatePromise = new Promise(resolve => { releaseGate = resolve })
  }
  const delayed = delayRelease > 0 ? installDelayedRelease(delayRelease) : null
  const attachProbe = delayAttach > 0 ? installDelayedAttach(delayAttach) : null
  const leaseProbe = delayLease > 0 ? installDelayedLease(delayLease) : null
  const harness = makeCtx({ createGate: gatePromise })
  const dispose = apply(harness.ctx, { baseUrl: board.url, mandate: TEST_MANDATE })
  const handlerOf = () => harness.routes.get('/dsh-agent-board/api/v2').handler
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
    releaseGate: () => releaseGate(),
    releases: delayed?.releases ?? [],
    fetchLog: delayed?.log ?? null,
    attachProbe: attachProbe?.probe ?? null,
    leaseProbe: leaseProbe?.probe ?? null,
    emit: (sessionId, event) => {
      const listener = harness.listeners.get('session/event')
      assert.equal(typeof listener, 'function')
      listener({ id: sessionId }, event)
    },
    async close() {
      try { dispose?.() } catch { /* teardown */ }
      await board.close()
      delayed?.restore()
      attachProbe?.restore()
      leaseProbe?.restore()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

function turnEnd(kind, extra = {}) {
  return { type: 'turn/end', time: Date.now(), data: { reason: { kind, ...extra } } }
}

// FINDING R2 (P2): a Stop that lands while the contract ATTACH is in flight is
// reported as an attach refusal and the already-settled lease is released again.
test('FINDING R2: Stop during attach must report `stopped` and close the lease exactly once', async () => {
  const host = await boot({ gate: 'create', delayAttach: 120 })
  try {
    await host.ready()
    const tickPromise = host.tick()
    assert.ok(await waitFor(() => host.harness.created.length === 1))
    const sessionId = host.harness.created[0].sessionId
    // Hold the launch inside ctx.agents.create, then let it run into the
    // delayed ATTACH round-trip so a Stop can land while it is in flight.
    host.releaseGate()
    assert.ok(await waitFor(() => host.attachProbe.started))
    const stop = await host.post('/stop', {})
    assert.equal(stop.status, 200)
    await tickPromise
    await waitFor(async () => (await host.state()).assignments[0]?.settledAt !== undefined)
    const view = await host.state()
    const assignment = view.assignments[0]
    const cancels = host.harness.cancelled.filter(entry => entry.sessionId === sessionId).length
    assert.equal(assignment.status, 'stopped', `a stopped attempt must stay stopped, got ${assignment.status} (${assignment.error})`)
    assert.equal(cancels, 1, `the session must be cancelled once, got ${cancels}`)
    const releaseCalls = host.board.calls.filter(entry => entry.path.endsWith('/release')).length
    assert.equal(releaseCalls, 0, 'a settled execution must not also be released')
    assert.equal(view.audit.some(entry => entry.type === 'contract_release_failed'), false, 'no release-after-settle noise')
  } finally {
    await host.close()
  }
})

// FINDING R10 (P1, introduced by the decide-early fix in 0964333): a Stop that
// lands while the LEASE request is still in flight leaves the canonical execution
// leased: `decidedEarly` returns before the old fencing path that released it.
test('FINDING R10: Stop during the lease request must release the lease', async () => {
  const host = await boot({ delayLease: 120 })
  try {
    await host.ready()
    const tickPromise = host.tick()
    assert.ok(await waitFor(() => host.leaseProbe.started), 'the lease request must be in flight')
    const stop = await host.post('/stop', {})
    assert.equal(stop.status, 200)
    await tickPromise
    await new Promise(resolve => setTimeout(resolve, 100))
    const view = await host.state()
    const assignment = view.assignments[0]
    const leases = host.board.state().leases
    assert.equal(leases.every(lease => lease.state === 'released'), true, `the lease must not stay attached after a Stop, leases=${JSON.stringify(leases.map(lease => lease.state))} assignment=${JSON.stringify({ status: assignment.status, error: assignment.error, leaseId: assignment.leaseId })}`)
    assert.ok(['stopped', 'interrupted'].includes(assignment.status), `unexpected status ${assignment.status}`)
    assert.equal(host.board.task('t-contract-1').status, 'todo', 'the card must not stay in_progress on a stopped attempt')
  } finally {
    await host.close()
  }
})

// FINDING R1 (P1): the previous attempt's lease release is fire-and-forget, so a
// failover can race it and be refused with lease_conflict.
test('FINDING R1: a handoff must not race the release of the previous lease', async () => {
  const host = await boot({ delayRelease: 150 })
  try {
    await host.ready()
    await host.tick()
    assert.ok(await waitFor(() => host.harness.created.length === 1))
    const firstSession = host.harness.created[0].sessionId
    assert.ok(await waitFor(async () => (await host.state()).assignments.some(entry => entry.sessionId === firstSession && entry.status === 'running')))

    host.emit(firstSession, turnEnd('error', { error: { message: '429 Too Many Requests', status: 429 } }))

    const failovered = await waitFor(() => host.harness.created.length === 2, 2500)
    // Let the new attempt finish its attach round-trip before reading its state.
    await waitFor(async () => {
      const entry = (await host.state()).assignments.find(candidate => candidate.previousSessionId === firstSession)
      return entry !== undefined && entry.status !== 'recovering'
    }, 2500)
    const view = await host.state()
    const next = view.assignments.find(entry => entry.previousSessionId === firstSession)
    assert.equal(host.releases.length, 1, 'the previous lease must be released')
    assert.equal(failovered, true, `failover must survive the release race; next=${JSON.stringify(next?.error)} leases=${JSON.stringify(host.board.state().leases.map(lease => lease.state))}`)
    assert.equal(next.status, 'running')
    assert.equal(next.backend, 'contract')
  } finally {
    await host.close()
  }
})

// FINDING R4 (P1): a completed turn that settles the attempt while the contract
// launch is still finishing is rewritten to `interrupted` by the fencing branch
// (checkFencing reads the terminal status as "lease_released").
test('FINDING R4: a settled attempt must not be rewritten by the post-create fencing check', async () => {
  const host = await boot({ gate: 'create' })
  try {
    await host.ready()
    const tickPromise = host.tick()
    assert.ok(await waitFor(() => host.harness.created.length === 1))
    const sessionId = host.harness.created[0].sessionId
    // The session is created (createSession is blocked in ctx.agents.create) and
    // its turn ends before the launch path resumes.
    host.emit(sessionId, turnEnd('completed'))
    assert.ok(await waitFor(async () => (await host.state()).assignments[0]?.settledAt !== undefined))
    host.releaseGate()
    await tickPromise
    await new Promise(resolve => setTimeout(resolve, 50))
    const view = await host.state()
    const assignment = view.assignments[0]
    assert.equal(assignment.status, 'done', `the settled attempt must stay done, got ${assignment.status} (${assignment.error})`)
    assert.equal(assignment.outcome, 'completed')
    assert.equal(host.harness.cancelled.length, 0, 'a session whose turn already completed must not be cancelled')
    assert.equal(host.board.task('t-contract-1').status, 'in_review')
    assert.equal(host.board.calls.filter(entry => entry.path.endsWith('/release')).length, 0, 'no release after a settle')
  } finally {
    await host.close()
  }
})
