/**
 * P1-D — one effective autonomy level, published once.
 *
 * The cockpit used to read `identity.level` (a stored value `/mandate/level` never
 * updated) while the gate read the mandate, so the banner could show L0 while the
 * host acted at L3. The contract now computes the value and the host publishes it;
 * these tests pin the layering and the API step changes.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { effectiveAutonomyOf } from '../src/contracts/mandate.js'
import { apply } from '../src/host/index.js'
import { createBoardStore, pendingDecisionCountOf, superagentOf } from '../src/client/core.js'

function mandate(overrides = {}) {
  return {
    version: 2,
    scopeMode: 'selected',
    selectedWorkspaces: ['w1'],
    allConsent: null,
    level: 'L0',
    actions: { launch: true, comment: true },
    projects: { w1: { enabled: true, level: null, priority: 5, model: null, budget: { maxTasksPerHour: 6 }, note: '' } },
    requiresConfiguration: false,
    ...overrides,
  }
}

test('the level is global ∩ project ∩ integration, never an increase', () => {
  assert.equal(effectiveAutonomyOf({ mandate: mandate({ level: 'L0' }) }).level, 'L0')
  assert.equal(effectiveAutonomyOf({ mandate: mandate({ level: 'L3' }) }).level, 'L3')
  // A project override can only lower it.
  const capped = mandate({ level: 'L3', projects: { w1: { enabled: true, level: 'L1', budget: { maxTasksPerHour: 6 } } } })
  assert.equal(effectiveAutonomyOf({ mandate: capped, projectId: 'w1' }).level, 'L1')
  assert.equal(effectiveAutonomyOf({ mandate: capped }).level, 'L3', 'the global value is not capped by a project row')
  // An explicit project level above the global one is still the global one.
  const raised = mandate({ level: 'L1', projects: { w1: { enabled: true, level: 'L4', budget: { maxTasksPerHour: 6 } } } })
  assert.equal(effectiveAutonomyOf({ mandate: raised, projectId: 'w1' }).level, 'L1')
  // The integration ceiling participates without ever widening.
  const board = effectiveAutonomyOf({ mandate: mandate({ level: 'L3' }), integration: 'board' })
  const taskboard = effectiveAutonomyOf({ mandate: mandate({ level: 'L3' }), integration: 'taskboard', action: 'read' })
  assert.equal(board.level, 'L3')
  assert.equal(taskboard.level, 'L3')
  assert.equal(taskboard.integrationCeiling, 'L4')
  // The published fields the panels read.
  const full = effectiveAutonomyOf({ mandate: capped, projectId: 'w1' })
  assert.deepEqual(
    { level: full.level, scope: full.scope, globalLevel: full.globalLevel, projectLevel: full.projectLevel },
    { level: 'L1', scope: 'selected', globalLevel: 'L3', projectLevel: 'L1' },
  )
})

function makeCtx() {
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [{ id: 'w1', title: 'Project w1', path: process.cwd() }],
    },
    agents: { async create() { throw new Error('this test opens no session') }, get: () => undefined },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on() { return () => {} },
  }
  return { ctx, routes }
}

function call(routes, method, path, body) {
  const handler = routes.get('/dsh-agent-board/api/v2').handler
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = `/dsh-agent-board/api/v2${path}`
  req.headers = {}
  const res = {
    status: 0, body: '',
    writeHead(code) { this.status = code },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    on() {},
  }
  handler(req, res)
  return res
}

async function callJson(routes, method, path, body) {
  const res = call(routes, method, path, body)
  const started = Date.now()
  while (res.body === '' && Date.now() - started < 8000) await new Promise(resolve => setTimeout(resolve, 10))
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

test('L0 -> L3 -> L1: the published level and the cockpit follow every step', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-autonomy-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const made = makeCtx()
  const dispose = apply(made.ctx, {})

  const view = async () => (await callJson(made.routes, 'GET', '/state')).body.value
  const factsOf = async () => {
    const store = createBoardStore({ get: () => undefined }, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: await view() }) }),
      notifyWindowMs: 0,
    })
    store.start()
    await new Promise(resolve => setTimeout(resolve, 20))
    const snapshot = store.getSnapshot()
    store.destroy()
    return snapshot
  }
  try {
    // An empty mandate is L0 and `none` scope: the panel must say so.
    let state = await view()
    assert.equal(state.autonomy.level, 'L0')
    assert.equal(state.autonomy.scope, 'none')
    assert.equal(pendingDecisionCountOf(superagentOf(state)), 0)

    const scoped = await callJson(made.routes, 'POST', '/mandate/scope', { scopeMode: 'selected', selectedWorkspaces: ['w1'] })
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body))
    const l3 = await callJson(made.routes, 'POST', '/mandate/level', { level: 'L3' })
    assert.equal(l3.status, 200, JSON.stringify(l3.body))
    assert.equal(l3.body.value.autonomy.level, 'L3', 'the mandate view publishes the effective level')
    state = await view()
    assert.equal(state.autonomy.level, 'L3')
    assert.equal(state.superagent.autonomy.level, 'L3')
    assert.equal(state.superagent.identity.level, 'L3', 'the published identity no longer carries a stale copy')
    assert.equal(state.mandate.effectiveLevels.w1, 'L3')

    // The store sees the same value, so the banner, the inspector and the settings
    // row cannot disagree.
    const snapshot = await factsOf()
    assert.equal(snapshot.autonomy?.level ?? snapshot.host?.autonomy?.level ?? snapshot.host?.value?.autonomy?.level, state.autonomy.level)

    // A project override lowers the effective level for THAT project only.
    const project = await callJson(made.routes, 'POST', '/mandate/project', { projectId: 'w1', level: 'L1' })
    assert.equal(project.status, 200, JSON.stringify(project.body))
    state = await view()
    assert.equal(state.autonomy.level, 'L3', 'the global level is untouched')
    assert.equal(state.mandate.effectiveLevels.w1, 'L1', 'the project cap is published')
    const row = state.portfolio.find(entry => entry.projectId === 'w1')
    assert.equal(row.effectiveLevel, 'L1')
  } finally {
    dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
