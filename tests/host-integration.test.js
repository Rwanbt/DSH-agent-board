import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'

const TASK = {
  id: 't-test-1',
  title: 'Delegate a real task to a real session',
  status: 'todo',
  urgency: 'urgent',
  workspaceId: 'w1',
  dependsOn: [],
  revision: 1,
}

function makeCtx() {
  const created = []
  const injected = []
  const cancelled = []
  const listeners = new Map()
  const routeRef = { current: null }
  const routes = new Map()
  const effects = []
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
      effects.push(dispose)
      return () => { dispose?.() }
    },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: 'D:\\App\\DSH-agent-board', attachSession: async () => {} } : undefined),
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
        return {
          cancel: cause => cancelled.push({ sessionId: id, cause }),
        }
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
  return { ctx, created, injected, cancelled, listeners, routeRef, routes, effects }
}

function installFetch(tasksRef) {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { rev: 1, tasks: tasksRef.tasks } }) }
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

test('supervised mode proposes, approval launches a real session, duplicate dispatch is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const restoreFetch = installFetch(tasksRef)
  const { ctx, created, injected, listeners, routeRef } = makeCtx()
  const dispose = apply(ctx)
  try {
    assert.equal(routeRef.current.path, '/dsh-agent-board/api/v2')

    let state = await callJson(routeRef.current.handler, 'GET', '/state')
    assert.equal(state.status, 200)
    assert.equal(state.body.value.mode, 'off')
    assert.ok(Array.isArray(state.body.value.adapters.adapters))
    assert.ok(state.body.value.adapters.adapters.some(adapter => adapter.id === 'dsh-taskboard'))

    const mode = await callJson(routeRef.current.handler, 'POST', '/mode', { mode: 'supervised' })
    assert.equal(mode.body.value.mode, 'supervised')

    const tick = await callJson(routeRef.current.handler, 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(created.length, 0, 'supervised must not launch before approval')

    state = await callJson(routeRef.current.handler, 'GET', '/state')
    const proposal = state.body.value.proposals[0]
    assert.equal(proposal.taskId, TASK.id)

    const decide = await callJson(routeRef.current.handler, 'POST', `/proposals/${proposal.id}/decide`, { approve: true })
    assert.equal(decide.status, 200)
    assert.equal(created.length, 1)
    assert.equal(created[0].meta.cwd, 'D:\\App\\DSH-agent-board')
    assert.ok(created[0].sessionId.startsWith('session-agentboard-'))
    const messageText = injected.map(message => message.content[0].text).join('\n')
    assert.ok(messageText.includes(TASK.id))
    assert.ok(messageText.includes('in_review'))
    assert.ok(messageText.includes('NEVER move it to done'))

    const duplicate = await callJson(routeRef.current.handler, 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.reason, 'duplicate_assignment')
    assert.equal(created.length, 1, 'a duplicate dispatch must not start a second session')

    // A completed turn settles the assignment; the task itself is left to the
    // agent and to the human (the board never writes the ledger).
    const listener = listeners.get('session/event')
    assert.equal(typeof listener, 'function')
    listener({ id: created[0].sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    await waitFor(() => created.length > 0)
    state = await callJson(routeRef.current.handler, 'GET', '/state')
    assert.equal(state.body.value.assignments[0].status, 'done')
  } finally {
    dispose()
    restoreFetch()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('autonomous mode launches; a 503 after work started switches provider with a checkpoint handoff; stop cancels', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [structuredClone(TASK)] }
  const restoreFetch = installFetch(tasksRef)
  const { ctx, created, cancelled, listeners, routeRef } = makeCtx()
  const dispose = apply(ctx)
  try {
    await callJson(routeRef.current.handler, 'GET', '/state')
    await callJson(routeRef.current.handler, 'POST', '/policy', {
      policy: {
        routeChain: [
          { provider: 'primary', model: 'big' },
          { provider: 'backup', model: 'medium' },
        ],
        maxSwitches: 2,
      },
    })
    await callJson(routeRef.current.handler, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(routeRef.current.handler, 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(created.length, 1)

    const firstSession = created[0].sessionId
    const listener = listeners.get('session/event')
    // Output was already produced during this turn -> the router must NOT replay
    // the same request, it must checkpoint and hand off.
    listener({ id: firstSession }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: 'Partial work done before the failure.' }] } },
    })
    listener({ id: firstSession }, {
      type: 'turn/end',
      time: Date.now(),
      data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } },
    })
    assert.ok(await waitFor(() => created.length === 2), 'the router must open a handoff session')

    const state = await callJson(routeRef.current.handler, 'GET', '/state')
    const assignments = state.body.value.assignments
    assert.equal(assignments[0].status, 'superseded')
    assert.equal(assignments[0].checkpoint.sessionId, firstSession)
    const handoff = assignments.find(assignment => assignment.previousSessionId === firstSession)
    assert.ok(handoff !== undefined, 'the new assignment links to the previous session')
    assert.equal(handoff.status, 'running')
    assert.equal(handoff.backend, 'board')
    assert.ok(handoff.lease !== null && Number(handoff.lease.expiresAt) > Date.now(), 'the handed-off session holds a live lease')
    assert.equal(handoff.model.provider, 'backup')
    assert.ok(state.body.value.routeEvents.some(event => event.action === 'handoff' || event.action === 'switch'))

    const stop = await callJson(routeRef.current.handler, 'POST', '/stop', {})
    assert.equal(stop.status, 200)
    assert.ok(stop.body.value.stopped.length >= 1)
    assert.ok(cancelled.length >= 1, 'stop must actually cancel live agents')
  } finally {
    dispose()
    restoreFetch()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('restart reconciliation exposes an interrupted assignment instead of relaunching it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(join(home, 'agent-board'), { recursive: true })
  await writeFile(join(home, 'agent-board', 'state.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'autonomous',
    assignments: [{
      id: 'asg-old', taskId: 't-old', sessionId: 's-gone', status: 'running', idempotencyKey: 'k', lease: { owner: 'x', expiresAt: Date.now() + 100000 },
    }],
  }))
  const tasksRef = { tasks: [] }
  const restoreFetch = installFetch(tasksRef)
  const { ctx, created, routeRef } = makeCtx()
  const dispose = apply(ctx)
  try {
    let value = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await callJson(routeRef.current.handler, 'GET', '/state')
      value = res.body?.value ?? null
      if (value?.assignments?.[0]?.status === 'interrupted') break
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.equal(created.length, 0, 'a restart must never relaunch automatically')
    assert.equal(value.assignments[0].status, 'interrupted')
    assert.ok(value.reconcileNotes.length >= 1)
  } finally {
    dispose()
    restoreFetch()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})


test('unload disposes the HTTP route so a later activation does not collide', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks: [] }
  const restoreFetch = installFetch(tasksRef)
  const { ctx, routes, effects } = makeCtx()
  const dispose = apply(ctx)
  try {
    assert.equal(routes.has('/dsh-agent-board/api/v2'), true)
    dispose()
    for (const run of effects) run()
    assert.equal(routes.has('/dsh-agent-board/api/v2'), false, 'the route must be removed on unload')
    const again = apply(ctx)
    assert.equal(routes.has('/dsh-agent-board/api/v2'), true, 're-activation registers cleanly')
    again()
  } finally {
    restoreFetch()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})


