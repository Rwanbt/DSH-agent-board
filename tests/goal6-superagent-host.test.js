/**
 * GOAL 6 — P1 gate on the REAL host `apply()`:
 *   a real DSH session is created for the Super Agent, the assessment is
 *   validated, the deterministic gate authorizes/refuses each proposal, a
 *   refused proposal has NO effect, a directive is persisted, and the identity
 *   + directives + memory survive a host restart.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'

const TASKS = [
  { id: 't1', title: 'Tâche autorisée', status: 'todo', workspaceId: 'w1', dependsOn: [], version: 1, permission: 'workspace-write', isolation: 'none', execution: { mode: 'claim' } },
  { id: 't2', title: 'Projet désactivé', status: 'todo', workspaceId: 'w2', dependsOn: [], version: 1, isolation: 'none', execution: { mode: 'claim' } },
  { id: 't3', title: 'Projet hors périmètre', status: 'todo', workspaceId: 'w3', dependsOn: [], version: 1, isolation: 'none', execution: { mode: 'claim' } },
]

const MANDATE = {
  scopeMode: 'selected',
  selectedWorkspaces: ['w1', 'w2'],
  level: 'L3',
  actions: { launch: true, comment: true, create_task: true, update_task: true, schedule: true },
  projects: {
    w1: { enabled: true, budget: { maxTasksPerHour: 20 } },
    w2: { enabled: false, budget: { maxTasksPerHour: 20 } },
  },
  requiresConfiguration: false,
}

function assessment(overrides = {}) {
  return {
    schemaVersion: 1,
    situation: 'Une tâche prête dans w1 ; deux propositions refusables et un arbitrage.',
    findings: [],
    proposals: [
      { id: 'p1', action: 'launch', projectId: 'w1', taskId: 't1', rationale: 'tâche prête', risk: 'low', expectedEffect: 'session', requiresApproval: false },
      { id: 'p2', action: 'launch', projectId: 'w2', taskId: 't2', rationale: 'mauvaise idée', risk: 'low', expectedEffect: 'session', requiresApproval: false },
      { id: 'p3', action: 'launch', projectId: 'w3', taskId: 't3', rationale: 'hors périmètre', risk: 'low', expectedEffect: 'session', requiresApproval: false },
      { id: 'p4', action: 'merge', projectId: 'w1', taskId: 't1', rationale: 'fusionner', risk: 'high', expectedEffect: 'merge', requiresApproval: false },
    ],
    decisions: [{
      kind: 'arbitration',
      projectId: 'w1',
      title: 'Faut-il changer la priorité de w1 ?',
      context: 'Deux objectifs incompatibles dans le même projet.',
      options: [
        { id: 'approve', label: 'Oui, prioriser w1', effect: 'approve' },
        { id: 'reject', label: 'Non, garder l’ordre', effect: 'reject' },
      ],
      recommendation: 'Oui, prioriser w1',
      urgency: 'normal',
    }],
    directiveEcho: [],
    noopReason: null,
    ...overrides,
  }
}

function makeCtx() {
  const created = []
  const messages = []
  const handles = new Map()
  const listeners = new Map()
  const routes = new Map()
  const control = { replyText: JSON.stringify(assessment()) }
  const llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider', locality: 'local' }],
    listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
  }
  function emit(sessionId, event) {
    listeners.get('session/event')?.({ id: sessionId }, event)
  }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (['w1', 'w2', 'w3'].includes(id) ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => ['w1', 'w2', 'w3'].map(id => ({ id, title: `Projet ${id}`, path: process.cwd() })),
    },
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          id: options.sessionId,
          inject: () => {},
          cancel: () => {},
          followup(message) {
            messages.push({ sessionId: options.sessionId, text: message?.content?.[0]?.text ?? '' })
            setTimeout(() => {
              emit(options.sessionId, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: control.replies?.length ? control.replies.shift() : control.replyText }] } } })
              emit(options.sessionId, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
            }, 5)
          },
        }
        handles.set(options.sessionId, agent)
        return { agent, dispose: async () => {} }
      },
      get(id) {
        return handles.get(id)
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      if (name === 'llm') return llm
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, created, messages, routes, control, llm }
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

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

function installFetch() {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 9, tasks: structuredClone(TASKS) } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return () => { globalThis.fetch = previous }
}

async function boot({ home }) {
  const made = makeCtx()
  const dispose = apply(made.ctx, {
    mandate: MANDATE,
    baseUrl: 'http://127.0.0.1:1',
  })
  await callJson(made.routes, 'GET', '/state')
  await waitFor(async () => (await callJson(made.routes, 'GET', '/state')).body?.value?.host?.models?.discovered === true)
  return { ...made, dispose }
}

test('Super Agent: real session, validated assessment, gate enforced, no effect for refusals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    const model = await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    assert.equal(model.status, 200, JSON.stringify(model.body))

    const directive = await callJson(host.routes, 'POST', '/superagent/directives', {
      text: 'Toujours privilégier les tests qui échouent avant les nouvelles fonctionnalités.',
      scope: 'global',
    })
    assert.equal(directive.status, 200, JSON.stringify(directive.body))
    assert.equal(directive.body.value.directives.length, 1)

    const started = await callJson(host.routes, 'POST', '/superagent/start')
    assert.equal(started.status, 200, JSON.stringify(started.body))
    const identity = started.body.value.identity
    assert.match(identity.agentId, /^super-agent-/)
    assert.equal(started.body.value.session.active, true)

    const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const value = cycle.body.value
    assert.equal(value.ran, true)
    assert.equal(value.authorized.length, 1, JSON.stringify(value.authorized))
    assert.equal(value.authorized[0].taskId, 't1')
    const reasons = Object.fromEntries(value.refused.map(entry => [entry.id, entry.reason]))
    assert.equal(reasons.p2, 'project_disabled')
    assert.equal(reasons.p3, 'project_not_selected')
    assert.equal(reasons.p4, 'level_too_low', 'merge needs L4 before any grant is even considered')
    assert.equal(value.executed.filter(entry => entry.ok === true).length, 1)
    assert.equal(value.decisions, 1)

    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    // Exactly one task session was created (plus the Super Agent session).
    const taskSessions = host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-'))
    assert.equal(taskSessions.length, 1, 'a refused proposal must never create a session')
    assert.equal(state.assignments.length, 1)
    assert.equal(state.assignments[0].taskId, 't1')
    assert.equal(state.superagent.decisions.pending.length, 1)
    assert.equal(state.superagent.identity.status, 'idle')
    assert.equal(state.superagent.lastCycle.outcome, 'applied')
    assert.equal(state.superagent.lastCycle.refused, 3)
    // The prompt really carried the directive as an operator instruction.
    const promptText = host.messages.map(message => message.text).join('\n')
    assert.match(promptText, /Toujours privilégier les tests/)

    // A second cycle with the same assessment does not duplicate the decision.
    const again = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    const after = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(after.superagent.decisions.pending.length, 1, 'the same question is never asked twice')
    assert.equal(after.superagent.decisions.summary.pending, 1)
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent identity, directives and memory survive a host restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-restart-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  let first = null
  try {
    first = await boot({ home })
    await callJson(first.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(first.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(first.routes, 'POST', '/superagent/directives', { text: 'Directive durable de redémarrage.', scope: 'project', projectId: 'w1' })
    await callJson(first.routes, 'POST', '/superagent/start')
    const cycle = await callJson(first.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const before = (await callJson(first.routes, 'GET', '/state')).body.value.superagent
    assert.equal(before.directives.length, 1)
    assert.ok(before.memory.decisions >= 1)
    const agentId = before.identity.agentId
    first.dispose()
    first = null

    // Same DSH_HOME: the durable document is reloaded.
    const second = await boot({ home })
    try {
      const after = (await callJson(second.routes, 'GET', '/state')).body.value.superagent
      assert.equal(after.identity.agentId, agentId, 'the identity is durable, the session is not')
      assert.equal(after.session.active, false, 'a restart never pretends the old session is live')
      assert.equal(after.directives.length, 1)
      assert.match(after.directives[0].text, /Directive durable/)
      assert.ok(after.memory.decisions >= 1, 'memory survives the restart')
      assert.equal(after.identity.model.model, 'fake-model')
    } finally {
      second.dispose()
    }
  } finally {
    if (first !== null) first.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent: concurrent cycles coalesce; a failed assessment stops the scheduled loop', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-concurrent-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')

    const [first, second] = await Promise.all([
      callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' }),
      callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' }),
    ])
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.deepEqual(first.body.value.executed, second.body.value.executed, 'two wake-ups share ONE cycle result')
    assert.equal(first.body.value.executed.filter(entry => entry.ok === true).length, 1, 'one task session, not two')
    assert.equal(host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-')).length, 1)

    host.control.replyText = 'Je vais tout lancer sans JSON.'
    const failed = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(failed.status, 409)
    const state = (await callJson(host.routes, 'GET', '/state')).body.value.superagent
    assert.equal(state.lastCycle.outcome, 'invalid_assessment')
    assert.equal(state.dirty, false, 'a failed answer must not keep the scheduled loop awake')
    assert.equal(state.failureCount, 1)
    assert.ok(state.nextWakeAt > Date.now(), 'an exponential backoff is scheduled')
    assert.ok(state.nextWakeAt - Date.now() >= 9 * 60 * 1000)
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent: an invalid LLM answer has no effect at all', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-invalid-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    host.control.replyText = 'Bien sûr ! Je vais lancer la tâche t1 tout de suite.'
    const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 409, JSON.stringify(cycle.body))
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-')).length, 0)
    assert.equal(state.assignments.length, 0)
    assert.equal(state.superagent.lastCycle.outcome, 'invalid_assessment')
    assert.equal(state.superagent.decisions.pending.length, 0)
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent: one repair round recovers an answer missing schemaVersion, still strictly validated', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-repair-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    const broken = assessment()
    delete broken.schemaVersion
    delete broken.directiveEcho
    host.control.replies = [JSON.stringify(broken)]
    const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const prompts = host.messages.map(entry => entry.text)
    assert.ok(prompts.some(text => text.includes('rejected by the validator') && text.includes('schema_version_unsupported')), 'repair prompt names the errors')
    const state = (await callJson(host.routes, 'GET', '/state')).body.value.superagent
    assert.notEqual(state.lastCycle.outcome, 'invalid_assessment')
    assert.equal(state.failureCount ?? 0, 0)
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
