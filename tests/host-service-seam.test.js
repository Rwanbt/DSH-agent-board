/**
 * Lot 12b — the board must survive a Host that does not offer what it probes.
 *
 * This is a regression suite for a real incident: the first load-model wiring
 * read an optional Cordis service as a PROPERTY. A Cordis context throws on an
 * undeclared service, the throw escaped a `/state` route promise and took the
 * whole Host down while the plugin was live in a user's session.
 *
 * The strongest test here builds a context with REAL Cordis semantics — any
 * undeclared property read throws — so a future regression fails in CI instead of
 * in the operator's application. A static guard then proves the host never reads
 * an optional service as a property in the first place.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'

/** Services the host is allowed to READ AS PROPERTIES (its own `inject` list). */
const DECLARED = new Set(['agents', 'connection', 'effect', 'get', 'inject', 'logger', 'on', 'webServer', 'workspaceRegistry'])

function routesOf(ctx) {
  const routes = new Map()
  ctx.webServer = { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } }
  return routes
}

/**
 * A context with Cordis semantics: reading an undeclared service throws, exactly
 * like the real Host. `provided` are the services `ctx.get` answers.
 */
function cordisLikeCtx({ provided = {}, getThrows = false } = {}) {
  const listeners = new Map()
  const backing = {
    logger: { warn() {}, info() {}, error() {} },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    inject: [],
    on(event, listener) { listeners.set(event, listener); return () => {} },
    get(name) {
      if (getThrows) throw new Error(`cannot get property "${name}" without inject`)
      return provided[name]
    },
    agents: {
      async create(options) { throw new Error(`no session may be created by this test: ${options.sessionId}`) },
      get: () => undefined,
    },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [{ id: 'w1', title: 'Project w1', path: process.cwd() }],
    },
  }
  routesOf(backing)
  return new Proxy(backing, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      if (property in target) return Reflect.get(target, property, receiver)
      // Cordis: an undeclared service is not silently `undefined`, it THROWS.
      throw new Error(`cannot get property "${property}" without inject`)
    },
    has(target, property) {
      return property in target
    },
  })
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

async function callJson(routes, method, path, body, timeoutMs = 20_000) {
  const res = call(routes, method, path, body)
  const started = Date.now()
  while (res.body === '' && Date.now() - started < timeoutMs) await new Promise(resolve => setTimeout(resolve, 10))
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

async function bootWith(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'dab-seam-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dispose = apply(ctx, { mandate: {
    version: 2, scopeMode: 'selected', selectedWorkspaces: ['w1'], allConsent: null, level: 'L4',
    actions: { launch: true, delegate: true, comment: true, create_task: true, update_task: true },
    projects: { w1: { enabled: true, level: 'L4', budget: { maxTasksPerHour: 100 } } },
    requiresConfiguration: false,
  } })
  return {
    ctx,
    async readState() { return (await callJson(ctx.__routes ?? [], 'GET', '/state')).body },
    async close() {
      dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

test('a Cordis context that throws on undeclared services still serves /state', async () => {
  // The exact production failure: `ctx.tokenMeter` threw during a /state.
  const ctx = cordisLikeCtx()
  const routes = ctx.webServer ? null : null
  const home = await mkdtemp(join(tmpdir(), 'dab-seam-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const made = new Map()
  ctx.webServer = { getOrigin: () => 'http://127.0.0.1:1', register: route => { made.set(route.path, route); return () => made.delete(route.path) } }
  const dispose = apply(ctx, {})
  try {
    const state = await callJson(made, 'GET', '/state')
    assert.equal(state.status, 200, JSON.stringify(state.body).slice(0, 600))
    const value = state.body.value
    // The load model is still published, and says honestly that it cannot bill.
    assert.ok(value.load !== undefined, 'the load report is published even without a meter')
    assert.equal(value.load.tokens.measurable, false)
    assert.equal(value.load.tokens.measured, 0)
    // It binds on the machine, never on an invented pool.
    assert.equal(value.load.tokens.budget, null)
  } finally {
    dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  assert.equal(routes, null)
})

test('a meter that throws is skipped with a warning, never fatal', async () => {
  const ctx = cordisLikeCtx({ provided: { tokenMeter: { measure() { throw new Error('meter exploded') } } } })
  const made = new Map()
  ctx.webServer = { getOrigin: () => 'http://127.0.0.1:1', register: route => { made.set(route.path, route); return () => made.delete(route.path) } }
  const home = await mkdtemp(join(tmpdir(), 'dab-seam-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dispose = apply(ctx, {})
  try {
    const first = await callJson(made, 'GET', '/state')
    const second = await callJson(made, 'GET', '/state')
    assert.equal(first.status, 200)
    assert.equal(second.status, 200, 'a broken meter never takes the host down')
    assert.equal(second.body.value.load.tokens.measurable, true, 'the service EXISTS, it just fails per session')
  } finally {
    dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a ctx.get that throws is reported, not propagated', async () => {
  const ctx = cordisLikeCtx({ getThrows: true })
  const made = new Map()
  ctx.webServer = { getOrigin: () => 'http://127.0.0.1:1', register: route => { made.set(route.path, route); return () => made.delete(route.path) } }
  const home = await mkdtemp(join(tmpdir(), 'dab-seam-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dispose = apply(ctx, {})
  try {
    const state = await callJson(made, 'GET', '/state')
    assert.equal(state.status, 200, JSON.stringify(state.body).slice(0, 400))
    assert.equal(state.body.value.load.tokens.measurable, false)
  } finally {
    dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the host never reads an optional service as a property', async () => {
  // Static guard for the incident class: in EVERY host module, a `ctx.<name>`
  // read must be one of the DECLARED services; anything else goes through the
  // guarded `optionalServiceOf`/`serviceOf` probes.
  const names = ['index.js', 'native-tools.js', 'native-forge.js', 'security.js']
  const found = new Set()
  for (const name of names) {
    const source = await readFile(new URL(`../src/host/${name}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/\bctx\??\.([A-Za-z_$][\w$]*)/g)) found.add(match[1])
  }
  const undeclared = [...found].filter(name => !DECLARED.has(name))
  assert.deepEqual(undeclared, [], `read these through optionalServiceOf instead: ${undeclared.join(', ')}`)
  assert.ok(found.size >= 5, 'the scan is not vacuous')
  // And the inject-free, throw-safe read really is what the optional meter uses.
  const host = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8')
  assert.match(host, /optionalServiceOf\(ctx, 'tokenMeter'\)|ctx\.get\('tokenMeter'\)/)
})
