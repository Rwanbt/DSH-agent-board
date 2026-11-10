/**
 * Contract-resilience regressions (independent review findings R12/R13).
 *
 * R12: a handoff whose fresh Task Board read fails must NOT continue the card
 *      "unverified" — resuming a trashed/moved/foreign-claimed card on a network
 *      blip is exactly the dangerous-resume class the review targeted.
 * R13: a settle/release that fails when an attempt ends is retried by a bounded
 *      durable sweep at the next safe boundary (a tick), never lost.
 *
 * Both drive the real host HTTP API against the SIMULATED Task Board extension
 * (`x-simulated-contract: true`), so they prove host behaviour, not a live
 * Task Board integration.
 *
 * @module dsh-agent-board/tests/contract-resilience
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
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) {
        created.push(options)
        return {
          agent: { id: options.sessionId, inject() {}, followup() {}, cancel: () => cancelled.push(options.sessionId) },
          dispose: async () => {},
        }
      },
      get(id) {
        return created.some(options => options.sessionId === id) ? { cancel: () => cancelled.push(id) } : undefined
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, created, cancelled, listeners, routes }
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
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return false
}

async function callJson(handler, method, path, body) {
  const res = call(handler, method, path, body)
  await waitFor(() => res.body !== '')
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

async function boot({ settlementRetryMs = 60_000 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-resilience-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const board = await startSimulatedTaskBoard({ tasks: [simulatedTask({ isolation: 'none' }), simulatedTask({ id: 't-other', title: 'Other', version: 1, isolation: 'none', execution: { mode: 'scheduled' } })] })
  // The host captures `fetch` when it builds its clients, so the fault injection
  // must be installed BEFORE `apply` and driven through a mutable control object.
  const previousFetch = globalThis.fetch
  const control = { stateDown: false, failSettleOnce: false }
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (control.stateDown && target.includes('/dsh-taskboard/state')) throw new Error('network down')
    if (control.failSettleOnce && target.endsWith('/settle')) {
      control.failSettleOnce = false
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'internal', message: 'transient' } }) }
    }
    return previousFetch(url, init)
  }
  const harness = makeCtx()
  const dispose = apply(harness.ctx, { baseUrl: board.url })
  const handler = () => harness.routes.get('/dsh-agent-board/api/v2').handler
  const state = async () => (await callJson(handler(), 'GET', '/state')).body.value
  const ready = async () => {
    await callJson(handler(), 'POST', '/policy', {
      policy: {
        mode: 'autonomous',
        executionBackend: 'contract',
        routeChain: [{ provider: 'primary', model: 'big', locality: 'remote' }, { provider: 'backup', model: 'small', locality: 'remote' }],
        maxConcurrent: 2,
        maxRetries: 0,
        maxSwitches: 2,
        allowedPermissions: ['read-only', 'workspace-write'],
        allowedWorkspaces: ['w1'],
        settlementRetryMs,
      },
    })
    const started = Date.now()
    while (Date.now() - started < 5000) {
      const probe = await callJson(handler(), 'GET', '/contract')
      if (probe.body?.value?.writes === true) return state()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return state()
  }
  return {
    board,
    harness,
    control,
    state,
    ready,
    tick: () => callJson(handler(), 'POST', '/tick', {}),
    emit: (sessionId, event) => harness.listeners.get('session/event')({ id: sessionId }, event),
    async launch() {
      await this.tick()
      assert.ok(await waitFor(() => harness.created.length === 1), 'the card must launch')
      const sessionId = harness.created[0].sessionId
      assert.ok(await waitFor(async () => (await state()).assignments.some(entry => entry.sessionId === sessionId && entry.status === 'running')))
      return sessionId
    },
    async close() {
      try { dispose?.() } catch { /* teardown */ }
      await board.close()
      globalThis.fetch = previousFetch
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 })
    },
  }
}
test('R12: a handoff is suppressed when the Task Board ledger cannot be read (never continued unverified)', async () => {
  const host = await boot()
  try {
    await host.ready()
    const sessionId = await host.launch()
    const leaseCallsBefore = host.board.calls.filter(entry => entry.path.endsWith('/executions/lease')).length
    // The ownership proof is now unavailable for every read.
    host.control.stateDown = true
    host.emit(sessionId, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '429 Too Many Requests', status: 429 } } } })
    const suppressed = await waitFor(async () => {
      const assignment = (await host.state()).assignments.find(entry => entry.sessionId === sessionId)
      return typeof assignment?.error === 'string' && assignment.error.startsWith('handoff_suppressed:ledger_unreadable')
    })
    const view = await host.state()
    const assignment = view.assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(suppressed, true, `the handoff must be suppressed, got ${assignment?.status}/${assignment?.error}`)
    assert.equal(assignment.status, 'interrupted')
    assert.equal(host.harness.created.length, 1, 'no second session on an unverified handoff')
    assert.equal(host.board.calls.filter(entry => entry.path.endsWith('/executions/lease')).length, leaseCallsBefore, 'no second lease either')
    assert.ok(view.audit.some(entry => entry.type === 'recovery_suppressed'))
  } finally {
    await host.close()
  }
})

test('R13: a failed settlement is retried by the bounded sweep and closed once', async () => {
  const host = await boot({ settlementRetryMs: 0 })
  try {
    await host.ready()
    const sessionId = await host.launch()
    host.control.failSettleOnce = true
    host.emit(sessionId, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    const failedSettle = await waitFor(async () => {
      const assignment = (await host.state()).assignments.find(entry => entry.sessionId === sessionId)
      return typeof assignment?.settleError === 'string'
    })
    assert.equal(failedSettle, true, 'the first settlement must fail visibly')
    let assignment = (await host.state()).assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(assignment.status, 'done')
    assert.equal(assignment.settlement?.attempts, 1)
    assert.equal(host.board.task('t-contract-1').status, 'in_progress')

    // The next safe boundary (a tick) retries and closes the canonical record.
    await host.tick()
    const settled = await waitFor(() => host.board.task('t-contract-1').status === 'in_review')
    assert.equal(settled, true, 'the sweep must close the execution')
    assignment = (await host.state()).assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(assignment.settleError, null)
    assert.equal(typeof assignment.settledAt, 'number')
    assert.equal(assignment.settlement, null)
    // The failed attempt was intercepted before reaching the board, so the board
    // sees exactly one settle request (the retry); the audit records both facts.
    assert.equal(host.board.calls.filter(entry => entry.path.endsWith('/settle')).length, 1, 'one settle reaches the board (the retry)')
    const audit = (await host.state()).audit
    assert.equal(audit.filter(entry => entry.type === 'contract_settle_failed').length, 1)
    assert.equal(audit.filter(entry => entry.type === 'contract_settled').length, 1)
    const task = host.board.task('t-contract-1')
    assert.equal(task.executions[0].outcome, 'succeeded')
    assert.equal(typeof task.executions[0].report?.summary, 'string')
  } finally {
    await host.close()
  }
})