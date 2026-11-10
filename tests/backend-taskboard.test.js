/**
 * Task Board execution backend.
 *
 * The board can either create the session itself (`executionBackend: 'board'`,
 * model-level failover) or delegate execution to the Task Board's own executor
 * (`'taskboard'`: real execution record, worktree isolation, but the model is
 * pinned on the card, so no model-level failover). These tests pin the second
 * path against a fake Task Board HTTP API.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'

const TASK = {
  id: 't-tb-1',
  title: 'Task Board owned execution',
  description: 'Runs in a worktree',
  status: 'todo',
  urgency: 'normal',
  workspaceId: 'w1',
  dependsOn: [],
  version: 4,
  isolation: 'worktree',
  execution: { mode: 'claim' },
}

function makeCtx(liveIds) {
  const created = []
  const cancelled = []
  const listeners = new Map()
  const routeRef = { current: null }
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register: route => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        routeRef.current = route
        return () => { routes.delete(route.path) }
      },
    },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: 'D:\\App\\DSH-agent-board', attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) { created.push(options); return { agent: { id: options.sessionId }, dispose: async () => {} } },
      get(id) {
        if (!liveIds.has(id)) return undefined
        return { cancel: cause => cancelled.push({ sessionId: id, cause }) }
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, created, cancelled, listeners, routeRef }
}

function installFetch({ tasksRef, runStatus = 202, runBody = null, runDelayMs = 0 }) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null })
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 5, tasks: tasksRef.tasks } }) }
    }
    if (/\/dsh-taskboard\/tasks\/[^/]+\/run$/.test(String(url))) {
      if (runDelayMs > 0) await new Promise(resolve => setTimeout(resolve, runDelayMs))
      if (runStatus >= 400) {
        return { ok: false, status: runStatus, json: async () => ({ ok: false, error: { code: 'invalid_input', message: 'execution service unavailable' } }) }
      }
      const body = runBody ?? { ok: true, executionId: 'exec-1', sessionId: 'tb-session-1' }
      return { ok: true, status: runStatus, json: async () => ({ ok: true, value: body }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { restore: () => { globalThis.fetch = previous }, calls }
}

function call(handler, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = `/dsh-agent-board/api/v2${path}`
  req.headers = {}
  const res = {
    status: 0, body: '',
    writeHead(code) { this.status = code },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    on() {}, destroy() {},
  }
  handler(req, res)
  return res
}

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

async function callJson(handler, method, path, body) {
  const res = call(handler, method, path, body)
  await waitFor(() => res.body !== '')
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

async function withBoard(run, fetchOptions = {}, liveIds = new Set(['tb-session-1'])) {
  const home = await mkdtemp(join(tmpdir(), 'dab-tb-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const fetchState = installFetch({ tasksRef, ...fetchOptions })
  const made = makeCtx(liveIds)
  const dispose = apply(made.ctx)
  try {
    await callJson(made.routeRef.current.handler, 'GET', '/state')
    await run({ ...made, tasksRef, fetchState })
  } finally {
    dispose()
    fetchState.restore()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('taskboard backend: a worktree card is executed by the Task Board executor, not by the board', async () => {
  await withBoard(async ({ routeRef, created, tasksRef, fetchState }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', { policy: { executionBackend: 'taskboard' } })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(handler(), 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(created.length, 0, 'the board must not create its own session on this backend')
    const runCall = fetchState.calls.find(entry => entry.url.endsWith(`/dsh-taskboard/tasks/${TASK.id}/run`))
    assert.ok(runCall !== undefined, 'the Task Board run endpoint must be called')
    assert.equal(runCall.method, 'POST')
    const state = await callJson(handler(), 'GET', '/state')
    const assignment = state.body.value.assignments[0]
    assert.equal(assignment.backend, 'taskboard')
    assert.equal(assignment.executionId, 'exec-1')
    assert.equal(assignment.sessionId, 'tb-session-1')
    assert.equal(assignment.status, 'running')
    assert.equal(state.body.value.policy.executionBackend, 'taskboard')
    assert.ok(state.body.value.audit.some(entry => entry.type === 'launch' && entry.backend === 'taskboard' && entry.executionId === 'exec-1'))
    assert.equal(tasksRef.tasks[0].id, TASK.id)
  })
})

test('taskboard backend: a refused run fails the assignment without creating a session', async () => {
  await withBoard(async ({ routeRef, created }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', { policy: { executionBackend: 'taskboard' } })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(handler(), 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(created.length, 0)
    const state = await callJson(handler(), 'GET', '/state')
    const assignment = state.body.value.assignments[0]
    assert.equal(assignment.status, 'failed')
    assert.match(assignment.error, /HTTP 501/)
    assert.ok(state.body.value.audit.some(entry => entry.type === 'launch_failed' && entry.backend === 'taskboard'))
  }, { runStatus: 501 })
})

test('taskboard backend: a provider error is visible and never opens a handoff session', async () => {
  await withBoard(async ({ routeRef, created, listeners }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', {
      policy: { executionBackend: 'taskboard', routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }] },
    })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    const listener = listeners.get('session/event')
    listener({ id: 'tb-session-1' }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '429 too many requests' } } } })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(created.length, 0, 'the Task Board backend cannot switch the model of a pinned card')
    const state = await callJson(handler(), 'GET', '/state')
    const assignment = state.body.value.assignments[0]
    assert.equal(assignment.status, 'interrupted')
    assert.match(assignment.error, /backend_no_failover/)
    assert.ok(state.body.value.audit.some(entry => entry.type === 'recovery_unavailable'))
  })
})

test('taskboard backend: Stop cancels the Task Board session and marks the assignment stopped', async () => {
  await withBoard(async ({ routeRef, cancelled }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', { policy: { executionBackend: 'taskboard' } })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    const stop = await callJson(handler(), 'POST', '/stop', {})
    assert.equal(stop.status, 200)
    assert.ok(cancelled.some(entry => entry.sessionId === 'tb-session-1'))
    const state = await callJson(handler(), 'GET', '/state')
    assert.equal(state.body.value.assignments[0].status, 'stopped')
  })
})

test('policy: an unknown execution backend falls back to board', async () => {
  await withBoard(async ({ routeRef }) => {
    const handler = () => routeRef.current.handler
    const policy = await callJson(handler(), 'POST', '/policy', { policy: { executionBackend: 'nonsense' } })
    assert.equal(policy.body.value.executionBackend, 'board')
  })
})
