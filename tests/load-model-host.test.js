/**
 * Lot 11c — the load model replaces the hourly throttle, ONCE, on upgrade.
 *
 * A document written by 0.1.0 carries `maxConcurrentDelegations: 2` and
 * `maxDelegationsPerHour: 6`, which is exactly the throttling the operator no
 * longer wants. The migration lifts those two documented defaults to `null` (the
 * load model decides), keeps a deliberate value, publishes the load slice, and
 * never runs twice. The legacy hourly field stays an ACTIVE advanced valve.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { emptyMandate } from '../src/contracts/mandate.js'

function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [{ id: 'w1', title: 'Project w1', path: process.cwd() }],
    },
    agents: { async create(options) { throw new Error(`no session may be created by this test: ${options.sessionId}`) }, get: () => undefined },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      if (name === 'llm') return { listProviders: () => [], listModels: async () => [] }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
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

async function callJson(routes, method, path, body) {
  const res = call(routes, method, path, body)
  const started = Date.now()
  while (res.body === '' && Date.now() - started < 8000) await new Promise(resolve => setTimeout(resolve, 10))
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

/** Boot the real host on a temp DSH_HOME, optionally seeded with a 0.1.0 document. */
async function boot({ home = null, seed = null } = {}) {
  const dir = home ?? await mkdtemp(join(tmpdir(), 'dab-load-'))
  if (seed !== null) {
    await mkdir(join(dir, 'agent-board'), { recursive: true })
    await writeFile(join(dir, 'agent-board', 'state.json'), JSON.stringify(seed), 'utf8')
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const made = makeCtx()
  const dispose = apply(made.ctx, { baseUrl: 'http://127.0.0.1:1' })
  const state = await callJson(made.routes, 'GET', '/state')
  assert.equal(state.status, 200, JSON.stringify(state.body))
  return {
    home: dir,
    routes: made.routes,
    state: state.body.value,
    async readState() {
      return (await callJson(made.routes, 'GET', '/state')).body.value
    },
    async close({ keepHome = false } = {}) {
      dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (keepHome !== true) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

/** A document 0.1.0 would have written: schema v2, a mandate, the old ceilings. */
function legacyDocument({ maxConcurrentDelegations = 2, maxDelegationsPerHour = 6 } = {}) {
  return {
    schemaVersion: 2,
    mode: 'off',
    mandate: emptyMandate(),
    policy: {
      mode: 'off',
      supervision: { enabled: true, maxConcurrentDelegations, maxDelegationsPerHour },
    },
  }
}

async function waitForAudit(home, type) {
  const started = Date.now()
  while (Date.now() - started < 4000) {
    try {
      const text = await readFile(join(home, 'agent-board', 'audit.jsonl'), 'utf8')
      if (text.includes(type)) return text
    } catch (error) {
      // The journal is created by the first append: only a missing file is
      // expected while polling; anything else is a real failure.
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return ''
}

test('a 0.1.0 ceiling is lifted to explicit unlimited, once, and the load slice is published', async () => {
  let migratedAt = null
  const first = await boot({ seed: legacyDocument() })
  try {
    const state = await first.readState()
    assert.equal(state.policy.supervision.maxConcurrentDelegations, null, 'no ceiling of its own: the load model decides')
    assert.equal(state.policy.supervision.maxDelegationsPerHour, null, 'the hourly throttle is lifted')
    assert.deepEqual(state.policy.load, { tokenBudget: null, tokensPerTurn: null, hardware: null }, 'no pool is invented for the operator')
    const migrated = state.audit.filter(entry => entry.type === 'load_model_migrated')
    assert.equal(migrated.length, 1, 'the lift is auditable, not silent')
    assert.equal(migrated[0].from.maxConcurrentDelegations, 2)
    assert.equal(migrated[0].from.maxDelegationsPerHour, 6)
    migratedAt = migrated[0].at
    assert.match(await waitForAudit(first.home, 'load_model_migrated'), /load_model_migrated/)
  } finally {
    await first.close({ keepHome: true })
  }

  // A restart on the same document must not migrate (or audit) a second time.
  const second = await boot({ home: first.home })
  try {
    const state = await second.readState()
    assert.equal(state.policy.supervision.maxDelegationsPerHour, null)
    const migrated = state.audit.filter(entry => entry.type === 'load_model_migrated')
    assert.equal(migrated.length, 1, 'the persisted entry is the only one')
    assert.equal(migrated[0].at, migratedAt, 'no second migration happened on restart')
    // ... and the advanced field is still an ACTIVE valve after the migration.
    const patched = await callJson(second.routes, 'POST', '/policy', { policy: { supervision: { maxDelegationsPerHour: 3 } } })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal((await second.readState()).policy.supervision.maxDelegationsPerHour, 3)
  } finally {
    await second.close()
  }
})

test('a deliberate ceiling survives the migration', async () => {
  const host = await boot({ seed: legacyDocument({ maxConcurrentDelegations: 20, maxDelegationsPerHour: 200 }) })
  try {
    const state = await host.readState()
    assert.equal(state.policy.supervision.maxConcurrentDelegations, 20, 'an operator who typed 20 meant 20')
    assert.equal(state.policy.supervision.maxDelegationsPerHour, 200)
  } finally {
    await host.close()
  }
})

test('a fresh board starts unlimited and declares no token pool', async () => {
  const host = await boot()
  try {
    const state = await host.readState()
    assert.equal(state.policy.supervision.maxConcurrentDelegations, null)
    assert.equal(state.policy.supervision.maxDelegationsPerHour, null)
    assert.deepEqual(state.policy.load, { tokenBudget: null, tokensPerTurn: null, hardware: null })
  } finally {
    await host.close()
  }
})
