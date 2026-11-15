/**
 * P0-A — the decisions inbox, end to end through the PUBLIC payload.
 *
 * The host used to publish `decisions` as `{ pending, recent, summary }` while
 * the client decoded it as an array: the badge was always 0 and the panel always
 * empty. These tests boot the real `apply()` host, read `/api/v2/state` and feed
 * that payload to the SAME store helper the cockpit uses, so the seam is
 * exercised exactly where it used to break.
 *
 * A seeded `state.json` is used instead of a model cycle: the contract under test
 * is the payload, not the assessment.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { proposeDecision } from '../src/superagent/decisions.js'
import { createBoardStore, pendingDecisionCountOf, superagentOf } from '../src/client/core.js'
import { decodeDecisions } from '../src/contracts/decisions-schema.js'

const NOW = Date.now()

function seededDecision({ id = 'dec-1', expiresAt = NOW + 3_600_000, kind = 'approval' } = {}) {
  const proposed = proposeDecision([], {
    kind,
    projectId: 'w1',
    title: 'Approve the launch of t1',
    context: 'The card is ready and the project is enabled.',
    action: 'launch',
    taskIds: ['t1'],
    options: [
      { id: 'approve', label: 'Approve', effect: 'approve' },
      { id: 'reject', label: 'Reject', effect: 'reject' },
    ],
    recommendation: 'Approve',
    urgency: 'normal',
    expiresAt,
  }, { now: NOW })
  return { ...proposed.decision, id }
}

/**
 * An already-overdue decision. Built by hand because `proposeDecision` refuses to
 * create one with a deadline in the past (it always grants a real window).
 */
function expiredDecision({ id = 'dec-old' } = {}) {
  return {
    ...seededDecision({ id }),
    expiresAt: NOW - 1_000,
  }
}

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

/** Boot the real host on a temp DSH_HOME, optionally with a seeded state. */
async function bootWith({ decisions = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-decisions-'))
  if (decisions !== null) {
    const dir = join(home, 'agent-board')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 2, superagent: { decisions } }), 'utf8')
  }
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const made = makeCtx()
  const dispose = apply(made.ctx, { baseUrl: 'http://127.0.0.1:1' })
  const state = await callJson(made.routes, 'GET', '/state')
  assert.equal(state.status, 200, JSON.stringify(state.body))
  return {
    home,
    routes: made.routes,
    state: state.body.value,
    /** `keepHome` leaves the durable document for a restart test. */
    async close({ keepHome = false } = {}) {
      dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (keepHome !== true) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

test('the host publishes the versioned decisions object and the cockpit counter sees it', async () => {
  const host = await bootWith({ decisions: [seededDecision({ id: 'dec-live' })] })
  try {
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    const published = state.superagent.decisions
    assert.equal(published.schemaVersion, 1, 'the payload is versioned')
    assert.equal(Array.isArray(published.pending), true, 'pending is a list, not an object')
    assert.equal(published.pending.length, 1)
    assert.equal(published.pending[0].id, 'dec-live')
    assert.equal(published.summary.pending, 1)

    // Exactly what the cockpit does: host payload -> store helper -> badge.
    assert.equal(pendingDecisionCountOf(superagentOf(state)), 1)
    assert.deepEqual(decodeDecisions(published).pending.map(entry => entry.id), ['dec-live'])

    // And through the real store, which is what the panel subscribes to.
    const store = createBoardStore({ get: () => undefined }, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: state }) }),
      notifyWindowMs: 0,
    })
    store.start()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(pendingDecisionCountOf(store.getSnapshot().superagent), 1, 'the inbox badge is not empty any more')
    store.destroy()
  } finally {
    await host.close()
  }
})

test('answering a decision removes it from pending and keeps it in recent', async () => {
  const host = await bootWith({ decisions: [seededDecision({ id: 'dec-answer' })] })
  try {
    const answered = await callJson(host.routes, 'POST', '/superagent/decisions/dec-answer/answer', { optionId: 'approve', note: 'ok' })
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.equal(answered.body.value.decisions.pending.length, 0)
    const recent = answered.body.value.decisions.recent.find(entry => entry.id === 'dec-answer')
    assert.ok(recent !== undefined, 'an answered decision is still readable in recent')
    assert.equal(recent.status, 'answered')
    assert.equal(recent.answer.optionId, 'approve')

    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(pendingDecisionCountOf(superagentOf(state)), 0)
    assert.equal(state.superagent.decisions.summary.pending, 0)

    // Answering again with the same option is idempotent, never a second grant.
    const again = await callJson(host.routes, 'POST', '/superagent/decisions/dec-answer/answer', { optionId: 'approve' })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.value.decisions.recent.filter(entry => entry.id === 'dec-answer').length, 1)
  } finally {
    await host.close()
  }
})

test('an approval is single-use: a spent marker is published and never resurrected', async () => {
  const spent = seededDecision({ id: 'dec-once' })
  const host = await bootWith({
    decisions: [{
      ...spent,
      status: 'answered',
      answeredAt: NOW + 10,
      answer: { optionId: 'approve', by: 'operator', at: NOW + 10, note: null },
      usedAt: NOW + 20,
    }],
  })
  try {
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(pendingDecisionCountOf(superagentOf(state)), 0, 'a spent approval is not pending')
    const decoded = decodeDecisions(state.superagent.decisions)
    const entry = decoded.recent.find(candidate => candidate.id === 'dec-once')
    assert.ok(entry !== undefined)
    assert.equal(entry.usedAt, NOW + 20, 'the single-use marker survives the public contract')
    assert.equal(state.superagent.decisions.summary.pending, 0)
  } finally {
    await host.close()
  }
})

test('an expired decision cannot be answered any more', async () => {
  const host = await bootWith({ decisions: [expiredDecision({ id: 'dec-old' })] })
  try {
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    // The deadline is published, so the panel can say WHY it is dead.
    assert.equal(state.superagent.decisions.pending[0].expiresAt, NOW - 1_000)
    const refused = await callJson(host.routes, 'POST', '/superagent/decisions/dec-old/answer', { optionId: 'approve' })
    assert.equal(refused.status, 409, JSON.stringify(refused.body))
    assert.equal(refused.body.error, 'decision_expired')
    const after = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(after.superagent.decisions.pending.length, 1, 'the refused answer mutates nothing')
  } finally {
    await host.close()
  }
})

test('the inbox survives a host restart, still readable through the contract', async () => {
  const first = await bootWith({ decisions: [seededDecision({ id: 'dec-durable' })] })
  const home = first.home
  let second = null
  try {
    await first.close({ keepHome: true })
    // Same DSH_HOME: reload instead of seeding again.
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const made = makeCtx()
    const dispose = apply(made.ctx, { baseUrl: 'http://127.0.0.1:1' })
    second = {
      async close() {
        dispose()
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      },
    }
    const state = (await callJson(made.routes, 'GET', '/state')).body.value
    const pending = decodeDecisions(state.superagent.decisions).pending
    assert.deepEqual(pending.map(entry => entry.id), ['dec-durable'])
    assert.equal(pendingDecisionCountOf(superagentOf(state)), 1)
  } finally {
    await second?.close()
  }
})
