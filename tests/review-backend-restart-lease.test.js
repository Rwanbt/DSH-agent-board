/**
 * INDEPENDENT REVIEW — restart / durable contract lease (tests/review-backend-*.test.js).
 *
 * Non-regression test for finding R3: a contract assignment that survives a host
 * restart must release the Task Board lease it held. On the reviewed commit the
 * restart reconciliation calls `releaseContractLease` BEFORE the new process has
 * negotiated the contract, so the client refuses locally (`not_negotiated`) and
 * the canonical execution stays attached to a session that no longer exists.
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
          inject() {},
          followup() {},
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
    on() {},
    destroy() {},
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

/** Boot one host on an existing home; the caller owns the home and the board. */
function bootHost({ home, board }) {
  const harness = makeCtx()
  const dispose = apply(harness.ctx, { baseUrl: board.url })
  const handlerOf = () => harness.routes.get('/dsh-agent-board/api/v2').handler
  const state = async () => (await callJson(handlerOf(), 'GET', '/state')).body.value
  return {
    harness,
    dispose,
    handlerOf,
    state,
    tick: () => callJson(handlerOf(), 'POST', '/tick', {}),
    post: (path, body) => callJson(handlerOf(), 'POST', path, body),
  }
}

test('FINDING R3: a contract lease that survives a restart is released', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-review-restart-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const board = await startSimulatedTaskBoard({ tasks: [simulatedTask({ isolation: 'none' })] })
  const policy = {
    mode: 'autonomous',
    executionBackend: 'contract',
    routeChain: [{ provider: 'primary', model: 'big', locality: 'remote' }],
    maxConcurrent: 2,
    maxRetries: 0,
    maxSwitches: 2,
    allowedPermissions: ['read-only', 'workspace-write'],
    allowedWorkspaces: ['w1'],
  }
  let first = null
  let second = null
  try {
    first = bootHost({ home, board })
    await callJson(first.handlerOf(), 'POST', '/policy', { policy })
    const ready = await waitFor(async () => (await first.state()).contract?.writes === true)
    assert.equal(ready, true, 'the first host must negotiate the contract')
    await first.tick()
    assert.ok(await waitFor(() => first.harness.created.length === 1))
    const running = await waitFor(async () => (await first.state()).assignments.some(entry => entry.status === 'running'))
    assert.equal(running, true)
    const before = (await first.state()).assignments[0]
    assert.equal(typeof before.leaseId, 'string')
    assert.equal(board.state().leases[0].state, 'attached')

    // Graceful restart: the host persists its document and releases the lock.
    first.dispose()
    first = null

    // A NEW process: it knows the persisted assignment but not the session.
    second = bootHost({ home, board })
    const loaded = await second.state()
    const restored = loaded.assignments.find(entry => entry.leaseId === before.leaseId)
    assert.ok(restored !== undefined, 'the contract leaseId must survive the restart')
    assert.equal(restored.status, 'interrupted')
    // Give the release attempt (and the contract probe) time to settle.
    const audited = await waitFor(async () => (await second.state()).audit.some(entry => entry.type === 'contract_released'), 3000)
    const view = await second.state()
    const released = board.state().leases.every(lease => lease.state === 'released')
    assert.equal(released, true, `the lease must be released after restart, leases=${JSON.stringify(board.state().leases.map(lease => lease.state))} audit=${JSON.stringify(view.audit.filter(entry => /contract_release/.test(entry.type)))}`)
    assert.equal(audited, true, 'the release must be recorded as done, not as a local refusal')
  } finally {
    try { first?.dispose() } catch { /* already disposed */ }
    try { second?.dispose() } catch { /* already disposed */ }
    await board.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
