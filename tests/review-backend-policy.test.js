import { setupAgentHandle } from './fixtures/secure-agent-context.js'
/**
 * INDEPENDENT REVIEW — layer policy and budget honesty (tests/review-backend-*.test.js).
 *
 * Non-regression tests for findings R5–R8 in docs/REVIEW-GOAL3-BACKEND.md.
 * They assert the DESIRED behaviour and FAIL on the reviewed commit (ad4dccf).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../src/host/index.js'
import { TEST_MANDATE } from './goal6-helpers.js'
import { planRoute } from '../src/routing/router.js'

const TASK_A = {
  id: 't-policy-a',
  title: 'Policy task A',
  status: 'todo',
  urgency: 'normal',
  workspaceId: 'w1',
  dependsOn: [],
  version: 1,
}
const TASK_B = { ...TASK_A, id: 't-policy-b', title: 'Policy task B', version: 1 }

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
        return setupAgentHandle(options, {
          agent: { id: options.sessionId, inject() {}, followup() {}, cancel: cause => cancelled.push({ sessionId: options.sessionId, cause }) },
          dispose: async () => {},
        })
      },
      get(id) {
        const match = created.find(options => options.sessionId === id)
        return match === undefined ? undefined : { cancel: cause => cancelled.push({ sessionId: id, cause }) }
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deployment-default', model: 'big' }) }
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

async function withBoard(tasks, run) {
  const home = await mkdtemp(join(tmpdir(), 'dab-review-policy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tasksRef = { tasks: tasks.map(task => structuredClone(task)) }
  const restoreFetch = installFetch(tasksRef)
  const harness = makeCtx()
  const dispose = apply(harness.ctx, { mandate: TEST_MANDATE })
  const handler = () => harness.routes.get('/dsh-agent-board/api/v2').handler
  try {
    await callJson(handler(), 'GET', '/state')
    await run({ handler, harness, tasksRef })
  } finally {
    dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

// FINDING R5 (P1): a local-only PROJECT layer must not launch on the remote
// primary just because the filtered chain came back empty.
test('FINDING R5: a local-only project layer must not launch a remote route', async () => {
  await withBoard([TASK_A], async ({ handler, harness }) => {
    const policy = {
      mode: 'autonomous',
      routeChain: [{ provider: 'cloud', model: 'big', locality: 'remote' }],
      projectPolicies: { w1: { locality: 'local' } },
    }
    await callJson(handler(), 'POST', '/policy', { policy })
    const tick = await callJson(handler(), 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(harness.created.length, 0, `a local-only project must not reach the cloud; created=${JSON.stringify(harness.created.map(entry => entry.agentOptions))}`)
    // Refused for the POLICY reason, not for an unrelated one (mode, mandate...).
    const after = (await callJson(handler(), 'GET', '/state')).body.value
    const refusal = after.lastTick.actions.find(entry => entry.kind === 'launch')
    assert.match(String(refusal?.reason), /local_only|no_route_allowed/, `unexpected refusal: ${JSON.stringify(refusal)}`)
  })
})

// FINDING R6 (P1): a denied provider must not be usable through a card-pinned
// model (the card is DATA; the operator's deny-list is the mandate).
test('FINDING R6: a denied provider must not be reached through a pinned card model', async () => {
  const pinned = { ...TASK_A, model: { provider: 'cloud', model: 'big' } }
  await withBoard([pinned], async ({ handler, harness }) => {
    const policy = {
      mode: 'autonomous',
      routeChain: [{ provider: 'local', model: 'small', locality: 'local' }],
      projectPolicies: { w1: { deniedProviders: ['cloud'] } },
    }
    await callJson(handler(), 'POST', '/policy', { policy })
    const tick = await callJson(handler(), 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(harness.created.length, 0, `a denied provider must not launch; created=${JSON.stringify(harness.created.map(entry => entry.agentOptions))}`)
    const after = (await callJson(handler(), 'GET', '/state')).body.value
    const refusal = after.lastTick.actions.find(entry => entry.kind === 'launch')
    assert.match(String(refusal?.reason), /provider_denied|provider_not_allowed/, `unexpected refusal: ${JSON.stringify(refusal)}`)
  })
})

// CLEAN: the same local-only layer still launches a local route (the refusal is
// not "everything is blocked").
test('CLEAN: a local-only project layer launches a local route', async () => {
  await withBoard([TASK_A], async ({ handler, harness }) => {
    const policy = {
      mode: 'autonomous',
      routeChain: [{ provider: 'local', model: 'small', locality: 'local' }],
      projectPolicies: { w1: { locality: 'local' } },
    }
    await callJson(handler(), 'POST', '/policy', { policy })
    const tick = await callJson(handler(), 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(harness.created.length, 1, JSON.stringify((await callJson(handler(), 'GET', '/state')).body.value.lastTick))
    assert.equal(harness.created[0].agentOptions.provider, 'local')
  })
})

// FINDING R7 (P2): a cross-provider HANDOFF bypasses the switch budget.
test('FINDING R7: a cross-provider handoff respects the exhausted switch budget', () => {
  const primary = { provider: 'primary', model: 'big', locality: 'remote' }
  const backup = { provider: 'backup', model: 'small', locality: 'remote' }
  const failure = { kind: 'partial_stream', retryable: false, switchable: true, requiresHandoff: true, notModel: false }
  for (const maxSwitches of [0, 1]) {
    const plan = planRoute({
      failure,
      retries: 0,
      switches: maxSwitches,
      currentRoute: primary,
      chain: [primary, backup],
      policy: { maxSwitches },
      now: 1000,
    })
    assert.notEqual(plan.action, 'handoff', `switches=${maxSwitches}/${maxSwitches} must not hand off to another provider (got ${plan.action} -> ${JSON.stringify(plan.nextRoute)})`)
  }
})

// FINDING R8 (P2): the budget snapshot claims requestsPerHour is enforceable,
// but the host never records a single request against it.
test('FINDING R8: an enforceable request ceiling must actually be metered', async () => {
  await withBoard([TASK_A], async ({ handler }) => {
    const policy = { mode: 'autonomous', requestsPerHour: 1, tasksPerHour: 100, maxConcurrent: 4 }
    await callJson(handler(), 'POST', '/policy', { policy })
    const dispatched = await callJson(handler(), 'POST', '/dispatch', { taskId: TASK_A.id })
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body))
    const state = (await callJson(handler(), 'GET', '/state')).body.value
    assert.equal(state.budget.limits.requestsPerHour, 1)
    assert.ok(
      state.budget.enforceable.requestsPerHour === false || state.budget.used.requestsLastHour >= 1,
      `the snapshot advertises an enforceable request ceiling but metered ${state.budget.used.requestsLastHour} request(s) for one launch`,
    )
  })
})

