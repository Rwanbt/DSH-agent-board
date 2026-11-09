/**
 * Resilience tests: restart, duplicate/out-of-order events, ghost leases,
 * concurrent ticks and the single-writer takeover.
 *
 * These exercise the real `apply()` with a fake DSH context and REAL temp state
 * files (the only real disk in the suite), so the durability paths are tested
 * without restarting the user's DSH host.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'

const TASK = {
  id: 't-res-1',
  title: 'Resilient task',
  status: 'todo',
  urgency: 'normal',
  workspaceId: 'w1',
  dependsOn: [],
  version: 1,
}

function makeCtx({ createGate = null, fetchDelayMs = 0, liveIds = new Set() } = {}) {
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
    effect(fn) {
      const dispose = fn()
      return () => { dispose?.() }
    },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: 'D:\\App\\DSH-agent-board', attachSession: async () => {} } : undefined),
      list: () => [],
    },
    agents: {
      async create(options) {
        created.push(options)
        liveIds.add(options.sessionId)
        if (createGate !== null) await createGate
        const agent = {
          id: options.sessionId,
          inject: () => {},
          followup: () => {},
          cancel: cause => cancelled.push({ sessionId: options.sessionId, cause }),
        }
        return { agent, dispose: async () => {} }
      },
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
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  }
  return { ctx, created, cancelled, listeners, routeRef, routes, liveIds }
}

function installFetch(tasksRef, delayMs = 0) {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 3, tasks: tasksRef.tasks } }) }
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

async function withHome(run, { seed = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-res-'))
  if (seed !== null) {
    await mkdir(join(home, 'agent-board'), { recursive: true })
    await writeFile(join(home, 'agent-board', 'state.json'), JSON.stringify(seed), 'utf8')
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return { home, previousHome, cleanup: async () => { process.env.DSH_HOME = previousHome; await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } }
}

test('a turn/end that lands while the session is still being created settles the assignment', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { home, previousHome, cleanup } = await withHome(async () => {})
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const restoreFetch = installFetch(tasksRef)
  const made = makeCtx({ createGate: gate })
  const dispose = apply(made.ctx)
  try {
    const handler = () => made.routeRef.current.handler
    await callJson(handler(), 'GET', '/state')
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    const tickPromise = callJson(handler(), 'POST', '/tick', {})
    assert.ok(await waitFor(() => made.created.length === 1))
    const sessionId = made.created[0].sessionId
    // The session id is known BEFORE `ctx.agents.create` resolves, so an early
    // turn/end can be attributed to the assignment.
    const listener = made.listeners.get('session/event')
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    release()
    const tick = await tickPromise
    assert.equal(tick.status, 200)
    const state = await callJson(handler(), 'GET', '/state')
    const assignment = state.body.value.assignments[0]
    assert.equal(assignment.status, 'done', 'a completed turn must not be flipped back to running')
    assert.ok(state.body.value.audit.some(entry => entry.type === 'launch_settled_early'))
  } finally {
    dispose()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})

test('duplicate turn/end events settle once and an unknown session is ignored', async () => {
  const { home, previousHome, cleanup } = await withHome(async () => {})
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const restoreFetch = installFetch(tasksRef)
  const made = makeCtx()
  const dispose = apply(made.ctx)
  try {
    const handler = () => made.routeRef.current.handler
    await callJson(handler(), 'GET', '/state')
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    const sessionId = made.created[0].sessionId
    const listener = made.listeners.get('session/event')
    listener({ id: 'unknown-session' }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error' } } })
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    const state = await callJson(handler(), 'GET', '/state')
    assert.equal(state.body.value.assignments.length, 1)
    assert.equal(state.body.value.assignments[0].status, 'done')
    assert.equal(state.body.value.audit.filter(entry => entry.type === 'turn_done').length, 1)
  } finally {
    dispose()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})

test('the lease watchdog frees a slot when the live agent disappears', async () => {
  const seed = {
    schemaVersion: 1,
    mode: 'supervised',
    stoppedAt: null,
    policy: { mode: 'supervised', autoResumeOnRestart: true },
    acks: {},
    previews: {},
    turnEnd: {},
    proposals: [],
    routeEvents: [],
    audit: [],
    health: {},
    assignments: [{
      id: 'asg-live',
      taskId: 't-old',
      sessionId: 's-live',
      workspaceId: 'w1',
      status: 'running',
      idempotencyKey: 'old-key',
      lease: { owner: 'agent-board', acquiredAt: Date.now() - 60_000, expiresAt: Date.now() - 1000 },
      fencingToken: 1,
      startedAt: Date.now() - 60_000,
      routeHistory: [],
    }],
  }
  const { home, previousHome, cleanup } = await withHome(async () => {}, { seed })
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [] }
  const restoreFetch = installFetch(tasksRef)
  const liveIds = new Set(['s-live'])
  const made = makeCtx({ liveIds })
  const dispose = apply(made.ctx)
  try {
    const handler = () => made.routeRef.current.handler
    let state = await callJson(handler(), 'GET', '/state')
    assert.equal(state.body.value.assignments[0].status, 'running', 'a live agent is kept at boot')
    // The agent dies without emitting turn/end; the lease is already expired.
    made.liveIds.delete('s-live')
    await callJson(handler(), 'POST', '/tick', {})
    state = await callJson(handler(), 'GET', '/state')
    assert.equal(state.body.value.assignments[0].status, 'interrupted')
    assert.ok(state.body.value.audit.some(entry => entry.type === 'assignment_interrupted'))
  } finally {
    dispose()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})

test('a restart in autonomous mode requires an explicit resume before delegating', async () => {
  const seed = {
    schemaVersion: 1,
    mode: 'autonomous',
    stoppedAt: null,
    policy: { mode: 'autonomous', autoResumeOnRestart: false },
    acks: {},
    previews: {},
    turnEnd: {},
    proposals: [],
    routeEvents: [],
    audit: [],
    health: {},
    assignments: [],
  }
  const { home, previousHome, cleanup } = await withHome(async () => {}, { seed })
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const restoreFetch = installFetch(tasksRef)
  const made = makeCtx()
  const dispose = apply(made.ctx)
  try {
    const handler = () => made.routeRef.current.handler
    let state = await callJson(handler(), 'GET', '/state')
    assert.notEqual(state.body.value.stoppedAt, null)
    assert.ok(state.body.value.audit.some(entry => entry.type === 'resume_requires_confirmation'))
    const refused = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.reason, 'stopped_by_operator')
    assert.equal(made.created.length, 0)
    const resumed = await callJson(handler(), 'POST', '/resume', {})
    assert.equal(resumed.status, 200)
    const launched = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(launched.status, 200, JSON.stringify(launched.body))
    assert.equal(made.created.length, 1)
  } finally {
    dispose()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})

test('overlapping ticks coalesce and concurrent dispatches start exactly one session', async () => {
  const { home, previousHome, cleanup } = await withHome(async () => {})
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [] }
  const restoreFetch = installFetch(tasksRef, 60)
  const made = makeCtx()
  const dispose = apply(made.ctx)
  try {
    const handler = () => made.routeRef.current.handler
    await callJson(handler(), 'GET', '/state')
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    tasksRef.tasks = [structuredClone(TASK)]
    const [tickA, tickB] = await Promise.all([
      callJson(handler(), 'POST', '/tick', {}),
      callJson(handler(), 'POST', '/tick', {}),
    ])
    assert.equal(tickA.status, 200)
    assert.equal(tickB.status, 200)
    assert.equal(made.created.length, 1, 'a coalesced tick must not launch twice')

    tasksRef.tasks = [{ ...structuredClone(TASK), id: 't-res-2', version: 2 }]
    const [a, b] = await Promise.all([
      callJson(handler(), 'POST', '/dispatch', { taskId: 't-res-2' }),
      callJson(handler(), 'POST', '/dispatch', { taskId: 't-res-2' }),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [200, 409], 'one dispatch wins, the duplicate is refused')
    assert.equal(made.created.length, 2)
  } finally {
    dispose()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})

test('a stale lock from a dead process is taken over instead of blocking the board', async () => {
  const { home, previousHome, cleanup } = await withHome(async () => {})
  process.env.DSH_HOME = home
  await mkdir(join(home, 'agent-board'), { recursive: true })
  await writeFile(join(home, 'agent-board', 'instance.lock'), JSON.stringify({
    ownerId: 'ghost-owner',
    pid: 999999,
    acquiredAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
  }), 'utf8')
  const tasksRef = { tasks: [] }
  const restoreFetch = installFetch(tasksRef)
  const made = makeCtx()
  const dispose = apply(made.ctx)
  try {
    const state = await callJson(made.routeRef.current.handler, 'GET', '/state')
    assert.equal(state.body.value.instance.primary, true)
    assert.ok(state.body.value.reconcileNotes.some(note => note.type === 'stale_lock_taken_over'))
  } finally {
    dispose()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})

test('a second instance on the same state directory is read-only and cannot mutate', async () => {
  const { home, previousHome, cleanup } = await withHome(async () => {})
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [] }
  const restoreFetch = installFetch(tasksRef)
  const primary = makeCtx()
  const disposePrimary = apply(primary.ctx)
  let follower = null
  let disposeFollower = () => {}
  try {
    // Wait until the primary owns the lock before starting the follower.
    const primaryState = await callJson(primary.routeRef.current.handler, 'GET', '/state')
    assert.equal(primaryState.body.value.instance.primary, true)
    await callJson(primary.routeRef.current.handler, 'POST', '/mode', { mode: 'supervised' })

    follower = makeCtx()
    disposeFollower = apply(follower.ctx)
    const followerState = await callJson(follower.routeRef.current.handler, 'GET', '/state')
    assert.equal(followerState.body.value.instance.primary, false)
    assert.ok(followerState.body.value.reconcileNotes.some(note => note.type === 'secondary_instance'))

    const journalPath = join(home, 'agent-board', 'audit.jsonl')
    await new Promise(resolve => setTimeout(resolve, 100))
    const before = existsSync(journalPath) ? (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean).length : 0
    const refused = await callJson(follower.routeRef.current.handler, 'POST', '/mode', { mode: 'autonomous' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'not_primary')
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = existsSync(journalPath) ? (await readFile(journalPath, 'utf8')).split('\n').filter(Boolean).length : 0
    assert.equal(after, before, 'a follower must not append to the owner journal')

    const afterState = await callJson(primary.routeRef.current.handler, 'GET', '/state')
    assert.equal(afterState.body.value.mode, 'supervised', 'the follower must not mutate the primary state')
  } finally {
    disposeFollower()
    disposePrimary()
    restoreFetch()
    await cleanup()
    process.env.DSH_HOME = previousHome
  }
})