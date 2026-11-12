/**
 * Host-level supervision facts: a session the runtime REMOVED is a fact, not an
 * inference. It must be recorded (`state.gone`), the projection must be able to
 * say `unknown/session_gone` instead of `finished`, and a live assignment bound
 * to that session must become `interrupted` (releasing its Task Board lease when
 * the contract backend owns one).
 *
 * @module dsh-agent-board/tests/host-supervision
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'
import { TEST_MANDATE } from './goal6-helpers.js'
import { buildProjection } from '../src/supervisor/projection.js'

const TASK = {
  id: 't-gone-1', title: 'Dispose me', status: 'todo', urgency: 'normal',
  workspaceId: 'w1', dependsOn: [], version: 1,
}

function makeCtx(initialSessions = null) {
  const created = []
  const listeners = new Map()
  const routes = new Map()
  let sessionList = initialSessions ?? { phase: 'ready', ids: [], byId: {}, projectionsBySession: {} }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { fn(); return () => {} },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) {
        created.push(options)
        return {
          agent: { id: options.sessionId, inject: () => {}, followup: () => {}, cancel: () => {} },
          dispose: async () => {},
        }
      },
      get(id) {
        return created.some(options => options.sessionId === id) ? { cancel: () => {} } : undefined
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      if (name === 'sessions') return { list: () => sessionList }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, created, listeners, routes, setSessions: next => { sessionList = next } }
}

function installFetch(tasks) {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 1, tasks } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return () => { globalThis.fetch = previous }
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
  }
  handler(req, res)
  return res
}

async function waitFor(predicate, timeoutMs = 4000) {
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

async function boot(tasks = [structuredClone(TASK)], initialSessions = null) {
  const home = await mkdtemp(join(tmpdir(), 'dab-gone-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restore = installFetch(tasks)
  const harness = makeCtx(initialSessions)
  const dispose = apply(harness.ctx, { mandate: TEST_MANDATE })
  const handler = () => harness.routes.get('/dsh-agent-board/api/v2').handler
  const state = async () => (await callJson(handler(), 'GET', '/state')).body.value
  return {
    ...harness,
    state,
    handler,
    async launch() {
      await callJson(handler(), 'POST', '/policy', { policy: { mode: 'autonomous' } })
      const tick = await callJson(handler(), 'POST', '/tick', {})
      assert.equal(tick.status, 200)
      assert.ok(await waitFor(() => harness.created.length === 1), 'the card must launch')
      return harness.created[0].sessionId
    },
    async close() {
      dispose?.()
      restore()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 })
    },
  }
}

test('a disposed session is recorded and interrupts its live assignment', async () => {
  const host = await boot()
  try {
    const sessionId = await host.launch()
    await waitFor(async () => (await host.state()).assignments.some(entry => entry.sessionId === sessionId && entry.status === 'running'))

    const disposed = host.listeners.get('session/disposed')
    assert.equal(typeof disposed, 'function', 'the host must subscribe to session/disposed')
    disposed({ id: sessionId })

    const recorded = await waitFor(async () => (await host.state()).gone?.[sessionId] !== undefined)
    assert.equal(recorded, true, 'the removal fact must reach the host state')
    const view = await host.state()
    const assignment = view.assignments.find(entry => entry.sessionId === sessionId)
    assert.equal(assignment.status, 'interrupted', 'a disposed session must not stay running')
    assert.equal(assignment.error, 'session_disposed')
    assert.ok(view.audit.some(entry => entry.type === 'session_gone'))
    // The projection can now say `unknown/session_gone`, never `finished`.
    const projection = buildProjection({
      list: { phase: 'ready', ids: [], byId: {}, projectionsBySession: {} },
      statusMap: new Map(),
      hostState: view,
      workspaces: {},
      now: Date.now(),
    })
    assert.equal(projection.byId.size, 0, 'no native row is invented for the disposed session')
  } finally {
    await host.close()
  }
})

test('api-session/removed is the same fact as session/disposed', async () => {
  const host = await boot()
  try {
    const sessionId = await host.launch()
    const removed = host.listeners.get('api-session/removed')
    assert.equal(typeof removed, 'function', 'the host must subscribe to api-session/removed')
    removed(sessionId)
    assert.equal(await waitFor(async () => (await host.state()).gone?.[sessionId] !== undefined), true)
  } finally {
    await host.close()
  }
})

test('the gone map is bounded: a long history cannot grow the state document', async () => {
  const host = await boot()
  try {
    const disposed = host.listeners.get('session/disposed')
    for (let index = 0; index < 600; index += 1) disposed({ id: `session-gone-${index}` })
    const view = await host.state()
    const keys = Object.keys(view.gone ?? {})
    assert.ok(keys.length <= 500, `gone must stay bounded, got ${keys.length}`)
    // The most recent removals survive, the oldest are evicted.
    assert.ok(keys.includes('session-gone-599'))
    assert.equal(keys.includes('session-gone-0'), false)
  } finally {
    await host.close()
  }
})

test('supervision is built eagerly: /state reports the real agents before any 15 s timer', async () => {
  const sessions = {
    phase: 'ready',
    ids: ['s-live'],
    byId: { 's-live': { id: 's-live', displayTitle: 'Live agent', running: true, updatedAt: Date.now() } },
    projectionsBySession: {},
  }
  const host = await boot([structuredClone(TASK)], sessions)
  try {
    const view = await host.state()
    assert.ok(view.supervision, 'the supervision payload must be part of /state')
    assert.equal(view.supervision.workspace.counts.agents, 1, 'the eager projection must count the live agent')
    assert.equal(view.supervision.workspace.status, 'idle', 'mode off observes, never active')
    assert.ok(Array.isArray(view.supervision.projects))
    assert.ok(view.supervision.capabilities && view.supervision.capabilities.observe === true)
  } finally {
    await host.close()
  }
})
