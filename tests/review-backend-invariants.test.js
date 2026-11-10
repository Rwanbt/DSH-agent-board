/**
 * INDEPENDENT REVIEW — invariants that are CLEAN (tests/review-backend-*.test.js).
 *
 * These pin behaviour the review verified as correct on the reviewed commit, plus
 * the one journal bound that is wrong (finding R9). They are the "what I tried"
 * evidence for the areas reported as clean in docs/REVIEW-GOAL3-BACKEND.md.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'
import { compactState } from '../src/orchestrator/journal.js'

// CLEAN: the journal bound keeps every live assignment unconditionally.
test('compactState keeps live assignments when it bounds history', () => {
  const state = {
    assignments: [
      ...Array.from({ length: 250 }, (_, index) => ({ id: `ended-${index}`, taskId: `t-${index}`, status: 'done' })),
      { id: 'live-1', taskId: 't-live', status: 'running' },
      { id: 'live-2', taskId: 't-live2', status: 'recovering' },
      { id: 'live-3', taskId: 't-live3', status: 'starting' },
    ],
    previews: {},
    turnEnd: {},
    audit: [],
    proposals: [],
    acks: {},
  }
  compactState(state)
  assert.equal(state.assignments.length, 200)
  const live = state.assignments.filter(entry => ['starting', 'running', 'recovering'].includes(entry.status)).map(entry => entry.id)
  assert.deepEqual(live.sort(), ['live-1', 'live-2', 'live-3'])
})

// FINDING R9 (P2): the assignment bound is bypassed when the active count
// exceeds it — `slice(-0)` keeps EVERY ended assignment instead of none.
test('FINDING R9: compactState honours a bound smaller than the active count', () => {
  const state = {
    assignments: [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `ended-${index}`, status: 'done' })),
      { id: 'live-1', status: 'running' },
      { id: 'live-2', status: 'running' },
    ],
    previews: {},
    turnEnd: {},
    audit: [],
    proposals: [],
    acks: {},
  }
  compactState(state, { maxAssignments: 1 })
  assert.equal(state.assignments.filter(entry => entry.status === 'done').length, 0, `expected no ended assignment, kept ${state.assignments.filter(entry => entry.status === 'done').length}`)
  assert.equal(state.assignments.filter(entry => entry.status === 'running').length, 2)
})

// ------------------------------------------------------------- host harness
const TASK = {
  id: 't-budget-1',
  title: 'Budget task',
  status: 'todo',
  urgency: 'normal',
  workspaceId: 'w1',
  dependsOn: [],
  version: 1,
}

function makeCtx() {
  const created = []
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register: route => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) {
        created.push(options)
        return { agent: { id: options.sessionId, inject() {}, followup() {}, cancel() {} }, dispose: async () => {} }
      },
      get() { return undefined },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      return undefined
    },
    on() { return () => {} },
  }
  return { ctx, created, routes }
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

test('CLEAN: a refused launch consumes no budget; a durable launch consumes exactly one task slot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-review-budget-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 1, tasks: tasksRef.tasks } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const harness = makeCtx()
  const dispose = apply(harness.ctx)
  const handler = () => harness.routes.get('/dsh-agent-board/api/v2').handler
  try {
    await callJson(handler(), 'GET', '/state')
    // OFF: the launch is refused, nothing may be counted.
    const refused = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(refused.status, 409)
    let state = (await callJson(handler(), 'GET', '/state')).body.value
    assert.equal(state.budget.used.tasksLastHour, 0)
    // AUTONOMOUS: one durable launch, one slot.
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    const launched = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(launched.status, 200, JSON.stringify(launched.body))
    state = (await callJson(handler(), 'GET', '/state')).body.value
    assert.equal(state.budget.used.tasksLastHour, 1)
    assert.equal(harness.created.length, 1)
  } finally {
    dispose()
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
