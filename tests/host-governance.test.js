import { setupAgentHandle } from './fixtures/secure-agent-context.js'
/**
 * Governance tests for the host half: the single launch choke point.
 *
 * These pin the behaviours that were only documented before: OFF and Stop stop
 * DELEGATION (including approval, manual dispatch and failover recovery), a
 * stop that lands during a launch wins the race, a stopped attempt can be
 * relaunched as a new attempt, and a card cannot escalate its permission beyond
 * the operator's mandate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'
import { TEST_MANDATE } from './goal6-helpers.js'

const TASK = {
  id: 't-gov-1',
  title: 'Governed task',
  status: 'todo',
  urgency: 'urgent',
  workspaceId: 'w1',
  dependsOn: [],
  version: 1,
}

function makeCtx({ createDelayMs = 0, permissionPresets = [] } = {}) {
  const created = []
  const injected = []
  const cancelled = []
  const presets = []
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
        if (createDelayMs > 0) await new Promise(resolve => setTimeout(resolve, createDelayMs))
        const agent = {
          id: options.sessionId,
          inject: message => injected.push(message),
          followup: message => injected.push(message),
          cancel: cause => cancelled.push({ sessionId: options.sessionId, cause }),
        }
        return setupAgentHandle(options, { agent, dispose: async () => {} }, { onPermission: (session, preset) => { presets.push({ session, preset }); permissionPresets.push(preset) } })
      },
      get(id) {
        const match = created.find(options => options.sessionId === id)
        if (match === undefined) return undefined
        return { cancel: cause => cancelled.push({ sessionId: id, cause }) }
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      // A created session is visible through the native session table, which is
      // what permissionPresets/rename are applied to.
      if (name === 'sessions') return { get: id => (created.some(option => option.sessionId === id) ? { id } : undefined) }
      if (name === 'permissionPresets') {
        return { set: (session, preset) => { presets.push({ session, preset }); permissionPresets.push(preset) } }
      }
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  }
  return { ctx, created, injected, cancelled, presets, listeners, routeRef, routes }
}

function installFetch(tasksRef) {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 7, tasks: tasksRef.tasks } }) }
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

async function withBoard(tasks, run, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-gov-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks }
  const restoreFetch = installFetch(tasksRef)
  const made = makeCtx(options)
  const dispose = apply(made.ctx, { mandate: TEST_MANDATE })
  try {
    await callJson(made.routeRef.current.handler, 'GET', '/state')
    await run({ ...made, tasksRef, dispose })
  } finally {
    dispose()
    restoreFetch()
    process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('OFF refuses new delegation: approval and manual dispatch create no session', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'supervised' })
    await callJson(handler(), 'POST', '/tick', {})
    const state = await callJson(handler(), 'GET', '/state')
    const proposal = state.body.value.proposals[0]
    assert.ok(proposal !== undefined)

    await callJson(handler(), 'POST', '/mode', { mode: 'off' })
    const decide = await callJson(handler(), 'POST', `/proposals/${proposal.id}/decide`, { approve: true })
    assert.equal(decide.status, 404, 'a pending proposal is made dormant by OFF')
    assert.equal(created.length, 0)

    const dispatch = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(dispatch.status, 409)
    assert.equal(dispatch.body.reason, 'mode_off')
    assert.equal(created.length, 0, 'dispatch in OFF must not start a session')
  })
})

test('Stop blocks new delegation and cancels live agents', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, cancelled }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(handler(), 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(created.length, 1)

    const stop = await callJson(handler(), 'POST', '/stop', {})
    assert.equal(stop.status, 200)
    assert.ok(cancelled.length >= 1, 'stop must cancel the live agent')

    const dispatch = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(dispatch.status, 409)
    assert.equal(dispatch.body.reason, 'stopped_by_operator')
    assert.equal(created.length, 1)

    const state = await callJson(handler(), 'GET', '/state')
    assert.equal(state.body.value.stoppedAt !== null, true)
    assert.equal(state.body.value.assignments[0].status, 'stopped')
  })
})

test('a stop that lands during a launch wins the race: the new session is cancelled', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, cancelled }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    const tickPromise = callJson(handler(), 'POST', '/tick', {})
    // Wait until ctx.agents.create has been entered, then stop while it is in flight.
    assert.ok(await waitFor(() => created.length === 1))
    const stop = await callJson(handler(), 'POST', '/stop', {})
    assert.equal(stop.status, 200)
    const tick = await tickPromise
    assert.equal(tick.status, 200)
    const state = await callJson(handler(), 'GET', '/state')
    const assignment = state.body.value.assignments[0]
    assert.ok(['stopped', 'interrupted'].includes(assignment.status), `unexpected status ${assignment.status}`)
    assert.ok(cancelled.length >= 1, 'the session created during the stop must be cancelled')
  }, { createDelayMs: 120 })
})

test('leaving autonomous mode suppresses failover recovery: no handoff session is created', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, listeners }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', {
      policy: {
        routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }],
        maxSwitches: 2,
      },
    })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 1)
    const sessionId = created[0].sessionId
    await callJson(handler(), 'POST', '/mode', { mode: 'off' })
    const listener = listeners.get('session/event')
    listener({ id: sessionId }, {
      type: 'assistant/message',
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: 'partial work' }] } },
    })
    listener({ id: sessionId }, {
      type: 'turn/end',
      time: Date.now(),
      data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(created.length, 1, 'OFF must not create a recovery session')
    const state = await callJson(handler(), 'GET', '/state')
    assert.equal(state.body.value.assignments[0].status, 'interrupted')
    assert.ok(state.body.value.audit.some(entry => entry.type === 'recovery_suppressed'))
  })
})

test('a stopped attempt can be relaunched as a new attempt (Stop is not a permanent brick)', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 1)
    await callJson(handler(), 'POST', '/stop', {})
    const resume = await callJson(handler(), 'POST', '/resume', {})
    assert.equal(resume.status, 200)
    const dispatch = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(dispatch.status, 200, JSON.stringify(dispatch.body))
    assert.equal(created.length, 2)
    const state = await callJson(handler(), 'GET', '/state')
    const attempts = state.body.value.assignments.map(assignment => assignment.attempt).sort()
    assert.deepEqual(attempts, [0, 1])
    assert.ok(state.body.value.audit.some(entry => entry.type === 'launch' && entry.source === 'dispatch'))
  })
})

test('a card cannot escalate to danger-full-access beyond the operator mandate', async () => {
  const task = { ...structuredClone(TASK), permission: 'danger-full-access' }
  await withBoard([task], async ({ routeRef, created, presets }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 0, 'a permission outside the mandate must be refused before launching')
    assert.equal(presets.length, 0)
    const state = await callJson(handler(), 'GET', '/state')
    const reasons = state.body.value.lastTick.skipped.map(entry => entry.reason)
    assert.ok(reasons.includes('permission_not_allowed:danger-full-access'), JSON.stringify(reasons))
    assert.equal(state.body.value.lastTick.actions.length, 0)
  })
})

test('a permission explicitly allowed by the mandate is applied', async () => {
  const task = { ...structuredClone(TASK), permission: 'read-only' }
  await withBoard([task], async ({ routeRef, created, presets }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/policy', { policy: { allowedPermissions: ['read-only', 'workspace-write'] } })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 1)
    assert.deepEqual(presets.map(entry => entry.preset), ['read-only'])
  })
})

test('a worktree-isolated card is not silently run in the shared workspace', async () => {
  const task = { ...structuredClone(TASK), isolation: 'worktree' }
  await withBoard([task], async ({ routeRef, created }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 0, 'a worktree task must not run unisolated')
    const state = await callJson(handler(), 'GET', '/state')
    const reasons = state.body.value.lastTick.skipped.map(entry => entry.reason)
    assert.ok(reasons.includes('worktree_isolation_not_supported'), JSON.stringify(reasons))
  })
})

test('the SSE stream uses the named `state` event the client subscribes to', async () => {
  await withBoard([], async ({ routeRef }) => {
    const res = call(routeRef.current.handler, 'GET', '/events')
    assert.ok(await waitFor(() => res.body !== ''))
    assert.match(res.body, /^event: state\ndata: \{/)
    res.destroy?.()
  })
})

test('switching mode does not lift an operator Stop: only /resume does', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 1)
    await callJson(handler(), 'POST', '/stop', {})
    // Clicking another mode is not consent to resume.
    const mode = await callJson(handler(), 'POST', '/mode', { mode: 'supervised' })
    assert.equal(mode.status, 200)
    assert.notEqual(mode.body.value.stoppedAt, null, 'the stop gate must survive a mode change')
    const dispatch = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK.id })
    assert.equal(dispatch.status, 409)
    assert.equal(dispatch.body.reason, 'stopped_by_operator')
    const resumed = await callJson(handler(), 'POST', '/resume', {})
    assert.equal(resumed.status, 200)
  })
})

test('a handoff is suppressed when the card was trashed during the run', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, listeners, tasksRef }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', {
      policy: { routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }], maxSwitches: 2 },
    })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 1)
    const sessionId = created[0].sessionId
    // The card is trashed while the session works.
    tasksRef.tasks[0] = { ...tasksRef.tasks[0], trashedAt: Date.now(), status: 'todo' }
    const listener = listeners.get('session/event')
    listener({ id: sessionId }, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } } })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(created.length, 1, 'a trashed card must not be continued in a new session')
    const state = await callJson(handler(), 'GET', '/state')
    const assignment = state.body.value.assignments[0]
    assert.equal(assignment.status, 'interrupted')
    assert.match(assignment.error, /handoff_suppressed:task_trashed/)
    assert.ok(state.body.value.audit.some(entry => entry.type === 'recovery_suppressed' && entry.source === 'handoff_gate'))
  })
})

test('a handoff obeys the workspace mandate enforced after the launch', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, listeners }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', {
      policy: { routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }], maxSwitches: 2 },
    })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    const sessionId = created[0].sessionId
    // The operator removes the workspace from the mandate while the run is active.
    await callJson(handler(), 'POST', '/policy', { policy: { allowedWorkspaces: ['w2'] } })
    const listener = listeners.get('session/event')
    listener({ id: sessionId }, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } } })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(created.length, 1, 'the handoff must not bypass the workspace mandate')
    const state = await callJson(handler(), 'GET', '/state')
    assert.match(state.body.value.assignments[0].error, /handoff_suppressed:(project_not_selected|workspace_not_in_mandate)/)
  })
})

test('a handoff accepts a claim held by an EARLIER board session of the same task', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, listeners, tasksRef }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', {
      policy: { routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }, { provider: 'third', model: 'small' }], maxSwitches: 3 },
    })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    assert.equal(created.length, 1)
    const session1 = created[0].sessionId
    // The ledger keeps pointing at the first session (the Task Board releases
    // the claim on its own turn/end; this simulates the race where it has not).
    tasksRef.tasks[0] = { ...tasksRef.tasks[0], status: 'in_progress', claimedBy: session1 }
    const listener = listeners.get('session/event')
    const fail = id => {
      listener({ id }, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
      listener({ id }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } } })
    }
    fail(session1)
    assert.ok(await waitFor(() => created.length === 2), 'first hop must be allowed')
    const session2 = created[1].sessionId
    // Second hop: the claim still names session1, not session2.
    fail(session2)
    assert.ok(await waitFor(() => created.length === 3), 'a claim held by a previous board session must not block the second hop')
    const state = await callJson(handler(), 'GET', '/state')
    assert.ok(!state.body.value.assignments.some(entry => /claimed_by_another_session/.test(entry.error ?? '')), 'no hop may be suppressed for our own claim chain')
  })
})

test('a handoff is suppressed when a FOREIGN session holds the claim', async () => {
  await withBoard([structuredClone(TASK)], async ({ routeRef, created, listeners, tasksRef }) => {
    const handler = () => routeRef.current.handler
    await callJson(handler(), 'POST', '/policy', {
      policy: { routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }], maxSwitches: 2 },
    })
    await callJson(handler(), 'POST', '/mode', { mode: 'autonomous' })
    await callJson(handler(), 'POST', '/tick', {})
    tasksRef.tasks[0] = { ...tasksRef.tasks[0], status: 'in_progress', claimedBy: 'foreign-session' }
    const sessionId = created[0].sessionId
    const listener = listeners.get('session/event')
    listener({ id: sessionId }, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } } })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(created.length, 1)
    const state = await callJson(handler(), 'GET', '/state')
    assert.match(state.body.value.assignments[0].error, /handoff_suppressed:claimed_by_another_session/)
  })
})
