/**
 * Lot 11d — the host enforces the load model and publishes what it measured.
 *
 * The pure contract is tested in `load-budget.test.js`; this file proves the two
 * things only the real host can prove: a spent token pool QUEUES a card instead
 * of launching it, and the tokens it reports come from `ctx.tokenMeter`, never
 * from an estimate. The reset is the only way to start a new wave.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { setupAgentHandle } from './fixtures/secure-agent-context.js'

const MEASURED = { inputTokens: 900, outputTokens: 300 }

/** A pinned machine so the token pool is what binds, whatever the runner has. */
const TEST_BOX = { parallelism: 64, freeBytes: 64 * 1024 ** 3 }

function mandateFor(projectIds) {
  return {
    version: 2,
    scopeMode: 'selected',
    selectedWorkspaces: projectIds,
    allConsent: null,
    level: 'L4',
    actions: { launch: true, delegate: true, comment: true, create_task: true, update_task: true },
    projects: Object.fromEntries(projectIds.map(id => [id, { enabled: true, level: 'L4', budget: { maxTasksPerHour: 100 } }])),
    requiresConfiguration: false,
  }
}

function makeCtx({ projectIds, withMeter = true }) {
  const listeners = new Map()
  const routes = new Map()
  const created = []
  const handles = new Map()
  const workspaceOf = id => (projectIds.includes(id) ? { id, path: process.cwd(), attachSession: async () => {} } : undefined)
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: { get: workspaceOf, list: () => projectIds.map(id => ({ id, title: id, path: process.cwd() })) },
    agents: {
      async create(options) {
        created.push(options)
        const agent = { id: options.sessionId, session: { id: options.sessionId }, inject() {}, followup() {}, cancel() {} }
        handles.set(options.sessionId, agent)
        return setupAgentHandle(options, { agent, dispose: async () => { handles.delete(options.sessionId) } })
      },
      get: id => handles.get(id),
    },
    // Optional DSH services are reachable only through the inject-free read.
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'model' }) }
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'tokenMeter') return withMeter ? { measure: () => ({ totalTokens: 9_999, baseline: { kind: 'usage', tokens: 1_200, usage: { ...MEASURED } } }) } : undefined
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  // Cordis THROWS on an undeclared service, so a direct `ctx.tokenMeter` read is
  // exactly what killed the Host at startup. `tokenMeter` is not in the plugin's
  // `inject`, so only the inject-free `ctx.get('tokenMeter')` may reach it.
  Object.defineProperty(ctx, 'tokenMeter', {
    configurable: true,
    get() { throw new Error('cannot get property "tokenMeter" without inject') },
  })
  return { ctx, routes, created, listeners }
}

function call(routes, method, path, body) {
  const handler = routes.get('/dsh-agent-board/api/v2').handler
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
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
  }
  handler(req, res)
  return res
}

async function callJson(routes, method, path, body, timeoutMs = 60_000) {
  const res = call(routes, method, path, body)
  const started = Date.now()
  while (res.body === '' && Date.now() - started < timeoutMs) await new Promise(resolve => setTimeout(resolve, 10))
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

/** Boot the real host with a fake Task Board serving one ready card. */
async function boot({ budget, withMeter = true }) {
  const projectIds = ['p0']
  const tasks = [{ id: 't0', title: 'Task 0', status: 'todo', workspaceId: 'p0', dependsOn: [], version: 1, permission: 'workspace-write', isolation: 'none' }]
  const home = await mkdtemp(join(tmpdir(), 'dab-load-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => (String(url).includes('/dsh-taskboard/state')
    ? { ok: true, status: 200, json: async () => ({ ok: true, value: { rev: 1, tasks: structuredClone(tasks) } }) }
    : { ok: false, status: 404, json: async () => ({}) })
  const made = makeCtx({ projectIds, withMeter })
  const dispose = apply(made.ctx, { mandate: mandateFor(projectIds) })
  const state = await callJson(made.routes, 'GET', '/state')
  assert.equal(state.status, 200, JSON.stringify(state.body))
  const seeded = await callJson(made.routes, 'POST', '/policy', {
    policy: { maxConcurrent: null, supervision: { maxConcurrentDelegations: null }, load: { tokenBudget: budget, hardware: TEST_BOX } },
  })
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body))
  return {
    made,
    routes: made.routes,
    created: made.created,
    readState: async () => (await callJson(made.routes, 'GET', '/state')).body.value,
    async close() {
      dispose()
      globalThis.fetch = previousFetch
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

async function waitFor(check, label, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('a Host without the optional token meter still answers, unmeasured', async () => {
  const host = await boot({ budget: 10_000_000, withMeter: false })
  try {
    const state = await host.readState()
    assert.equal(state.load.tokens.measurable, false, 'an absent meter is "not measurable", never a guess')
    assert.equal(state.load.tokens.measured, 0)
    assert.equal(state.load.tokens.spent, 0)
  } finally {
    await host.close()
  }
})

test('a throwing service probe is reported, not fatal to the route', async () => {
  const host = await boot({ budget: null })
  try {
    // Route promises are detached: before the guard, a throw here became an
    // unhandled rejection and the Host child exited with code 1. A probe that
    // throws is now ABSORBED and reported as an unavailable capability, which is
    // strictly better than answering 500 for a diagnostic route.
    const reachable = host.made.ctx.get
    host.made.ctx.get = name => {
      if (name === 'tools') throw new Error('tools probe exploded')
      return reachable(name)
    }
    const res = await callJson(host.routes, 'GET', '/selftest')
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const checks = res.body.value.checks
    const toolsChecks = checks.filter(check => String(check.id).startsWith('tools.'))
    assert.ok(toolsChecks.length >= 3, 'the three tools checks are still reported')
    assert.ok(toolsChecks.every(check => check.ok === false && check.reason === 'runtime_unavailable'))
    // The board keeps serving everything else afterwards.
    const state = await callJson(host.routes, 'GET', '/state')
    assert.equal(state.status, 200)
  } finally {
    await host.close()
  }
})

test('a spent token pool queues the card and says which fact binds', async () => {
  const host = await boot({ budget: 0 })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(host.routes, 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(host.created.length, 0, 'no session may be created with an empty pool')
    const refused = tick.body.actions.find(action => action.ok === false)
    assert.ok(refused !== undefined, JSON.stringify(tick.body).slice(0, 800))
    assert.equal(refused.reason, 'load_exhausted')
    const state = await host.readState()
    assert.equal(state.load.ceiling, 0)
    assert.equal(state.load.blocked, true)
    assert.equal(state.load.binding, 'tokens')
    assert.equal(state.load.tokens.budget, 0)
    assert.equal(state.load.tokens.measurable, true, 'the meter exists, it simply has nothing to bill')
  } finally {
    await host.close()
  }
})

test('a load block reaches the attention queue as ONE named cause', async () => {
  const host = await boot({ budget: 0 })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/tick', {})
    const state = await host.readState()
    const attention = state.attention
    assert.ok(attention !== undefined, 'the attention payload is published')
    const loadEntry = attention.items.find(item => item.reason === 'load_exhausted')
    assert.ok(loadEntry !== undefined, JSON.stringify(attention.items).slice(0, 900))
    assert.equal(loadEntry.severity, 'high', 'it stops every launch: it must notify')
    assert.match(String(loadEntry.title), /tokens/i, 'the binding fact is named in the row')
    // One cause, however many cards it holds.
    assert.equal(attention.items.filter(item => item.reason === 'load_exhausted').length, 1)
    assert.match(String(loadEntry.suggestedAction), /pool|wave|session/i)
    assert.doesNotMatch(String(loadEntry.suggestedAction), /sliding hour/i)
  } finally {
    await host.close()
  }
})

test('the published usage is measured and a new wave can be started', async () => {
  const host = await boot({ budget: 10_000_000 })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(host.routes, 'POST', '/tick', {})
    assert.equal(host.created.length, 1, JSON.stringify(tick.body).slice(0, 800))
    // Live measurement: the provider billed 1 200 tokens on this session.
    await waitFor(async () => (await host.readState()).load.tokens.measured === 1_200, 'the live measurement')
    const live = await host.readState()
    assert.equal(live.load.tokens.spent, 1_200, 'spent = wave + live')
    assert.equal(live.load.tokens.measurable, true)
    assert.equal(live.load.tokens.sessions.length, 1)
    assert.equal(live.load.tokens.sessions[0].billedTokens, 1_200)
    // The pool is read in real time: 10M declared, 1 200 already billed, at the
    // documented fallback price of one turn. The published ceiling is the
    // smallest published reason, whatever the machine happens to be.
    const tokenReason = live.load.reasons.find(reason => reason.source === 'tokens')
    assert.equal(tokenReason.limit, Math.floor((10_000_000 - 1_200) / 60_000))
    const published = live.load.reasons.map(reason => reason.limit).filter(limit => limit !== null)
    assert.equal(live.load.ceiling, Math.min(...published))
    assert.ok(published.includes(live.load.ceiling), 'the binding reason is one of the published ones')

    // A new wave starts at zero and stays auditable.
    const reset = await callJson(host.routes, 'POST', '/load/reset', {})
    assert.equal(reset.status, 200, JSON.stringify(reset.body))
    assert.ok(reset.body.value.waveStartedAt > 0)
    const after = await host.readState()
    assert.ok(after.audit.some(entry => entry.type === 'load_wave_reset'), 'the reset is auditable')
  } finally {
    await host.close()
  }
})
