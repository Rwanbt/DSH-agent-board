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
import { execFileSync } from 'node:child_process'

import { apply } from '../src/host/index.js'
import { applyAgentSetup, secureAgentContext } from './fixtures/secure-agent-context.js'

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
  const control = { replyText: JSON.stringify(assessment()), replyDelayMs: 5, failFollowups: 0 }
  const llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider', locality: 'local' }],
    listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }, { id: 'fake-model-2', name: 'Fake Model 2' }],
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
            if (control.failFollowups > 0) {
              control.failFollowups -= 1
              throw new Error('fake provider unavailable')
            }
            setTimeout(() => {
              emit(options.sessionId, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: control.replies?.length ? control.replies.shift() : control.replyText }] } } })
              emit(options.sessionId, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
            }, control.replyDelayMs)
          },
        }
        const fixture = secureAgentContext({ sessionId: options.sessionId })
        if (control.nativeCreate && options.sessionId.startsWith('session-agentboard-operation-')) {
          fixture.tools.executable = name => name === 'taskboard_create' ? { name } : undefined
          fixture.tools.execute = async input => {
            const call = input.calls[0]
            const args = JSON.parse(call.arguments)
            const exec = { agent: input.agent, callId: call.id, name: call.name, arguments: args }
            const denied = fixture.state.guards.map(guard => guard(exec)).find(Boolean)
            if (denied) return { results: [{ callId: call.id, result: { isError: true, error: { info: { code: 'GUARD_DENIED' } } } }] }
            control.nativeCreate.calls.push(args)
            return { results: [{ callId: call.id, result: { isError: false, value: control.nativeCreate.value } }] }
          }
        }
        if (control.nativeDeletion && options.sessionId.startsWith('session-agentboard-operation-')) {
          fixture.tools.executable = name => name === 'taskboard_delete' ? { name } : undefined
          fixture.tools.execute = async input => {
            const call = input.calls[0]
            const args = JSON.parse(call.arguments)
            const exec = { agent: input.agent, callId: call.id, name: call.name, arguments: args }
            const denied = fixture.state.guards.map(guard => guard(exec)).find(Boolean)
            if (denied) return { results: [{ callId: call.id, result: { isError: true, error: { info: { code: 'GUARD_DENIED' } } } }] }
            control.nativeDeletion.calls.push(args)
            return { results: [{ callId: call.id, result: { isError: false, value: control.nativeDeletion.value } }] }
          }
        }
        if (control.brainToolsUnavailable && options.sessionId.startsWith('session-superagent-')) fixture.agentCtx.get = () => undefined
        const security = await applyAgentSetup(options, agent, fixture)
        // A real model step resolves tools before assembling its prompt.
        const followup = agent.followup.bind(agent)
        agent.followup = message => {
          security.tools.describeResolved()
          return followup(message)
        }
        handles.set(options.sessionId, agent)
        if (options.sessionId.startsWith('session-agentboard-')) await control.beforeWorkerCreated?.()
        return { agent, dispose: async () => { security.state.disposed = true; handles.delete(options.sessionId) } }
      },
      get(id) {
        return handles.get(id)
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      if (name === 'llm') return llm
      if (name === 'forge') return control.nativeForge
      if (name === 'tools' && (control.nativeDeletion || control.nativeCreate)) {
        return { execute() {}, get: name => (control.nativeDeletion && name === 'taskboard_delete') || (control.nativeCreate && name === 'taskboard_create') ? { name } : undefined }
      }
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

function installFetch({ isolated = false } = {}) {
  const previous = globalThis.fetch
  const calls = []
  const tasks = isolated ? structuredClone(TASKS) : TASKS
  const control = {}
  const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: target, method, headers: init?.headers, body: init?.body })
    if (target.startsWith('https://api.github.com/') && control.github) return control.github(target, init)
    if (target.includes('/dsh-taskboard/state')) {
      return reply({ ok: true, value: { revision: 9, tasks: structuredClone(tasks) } })
    }
    if (target.includes('/dsh-taskboard/public/v1/tasks')) {
      if (method === 'GET') {
        await control.beforeTaskRead?.()
        return reply({ ok: true, value: { id: 't1', version: 3 } })
      }
      if (target.endsWith('/update')) return reply({ ok: true, value: { id: 't1', version: 4 } })
      if (target.endsWith('/comments')) return reply({ ok: true, value: { taskId: 't1', commentId: 'c1', version: 5 } })
      return reply({ ok: true, value: { id: 'new-1', version: 1 } }, 201)
    }
    return reply({}, 404)
  }
  const restore = () => { globalThis.fetch = previous }
  restore.calls = calls
  restore.tasks = tasks
  restore.control = control
  return restore
}

async function boot({ home, config = {}, workspacePath }) {
  const made = makeCtx()
  if (workspacePath) {
    const original = made.ctx.workspaceRegistry.get
    made.ctx.workspaceRegistry.get = id => {
      const workspace = original(id)
      return workspace ? { ...workspace, path: workspacePath } : workspace
    }
  }
  const dispose = apply(made.ctx, {
    mandate: MANDATE,
    baseUrl: 'http://127.0.0.1:1',
    ...config,
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
    assert.equal(reasons.p4, 'payload_invalid', 'a merge without an exact PR target is never executable')
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

const ORIGINAL_TASKS = TASKS.map(task => structuredClone(task))
function resetTasks() {
  TASKS.splice(0, TASKS.length, ...ORIGINAL_TASKS.map(task => structuredClone(task)))
}

test('Super Agent (audit A01): never launches a card that is not ready', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-readiness-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    const proposal = { id: 'p1', action: 'launch', projectId: 'w1', taskId: 't1', rationale: 'audit', risk: 'low', expectedEffect: 'session', requiresApproval: false }
    host.control.replyText = JSON.stringify(assessment({ proposals: [proposal], decisions: [] }))
    const cases = [
      { mutate: task => { task.status = 'backlog' }, reason: /task_not_todo:backlog/ },
      { mutate: task => { task.blocked = true }, reason: /task_blocked/ },
      { mutate: task => { task.waitingForHuman = true }, reason: /task_waiting_for_human/ },
      { mutate: task => { task.dependsOn = ['missing-prerequisite'] }, reason: /dependencies_unsatisfied:missing-prerequisite/ },
    ]
    for (const entry of cases) {
      resetTasks()
      entry.mutate(TASKS[0])
      const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
      assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
      const executed = cycle.body.value.executed
      assert.equal(executed.length, 1, JSON.stringify(executed))
      assert.equal(executed[0].ok, false, JSON.stringify(executed))
      assert.match(String(executed[0].reason), entry.reason)
    }
    assert.equal(host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-')).length, 0, 'no worker session for an unready card')
  } finally {
    resetTasks()
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent (audit A05): a pause during the assessment blocks the launch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-pause-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    host.control.replyDelayMs = 80
    const proposal = { id: 'p1', action: 'launch', projectId: 'w1', taskId: 't1', rationale: 'audit', risk: 'low', expectedEffect: 'session', requiresApproval: false }
    host.control.replyText = JSON.stringify(assessment({ proposals: [proposal], decisions: [] }))
    const pending = callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const paused = await callJson(host.routes, 'POST', '/superagent/pause')
    assert.equal(paused.status, 200, JSON.stringify(paused.body))
    const cycle = await pending
    const body = cycle.body.value ?? cycle.body
    assert.equal(body.ran, true)
    assert.equal(body.reason, 'superagent_paused')
    assert.equal(host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-')).length, 0, 'the paused cycle launched nothing')
    const state = (await callJson(host.routes, 'GET', '/state')).body.value.superagent
    assert.equal(state.identity.status, 'paused', 'a paused identity is never resurrected to idle')
    assert.equal(state.lastCycle.outcome, 'refused')
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent (audit A06): a model change recycles the session at the next cycle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-model-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    const changed = await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model-2' })
    assert.equal(changed.status, 200, JSON.stringify(changed.body))
    host.control.replyText = JSON.stringify(assessment({ proposals: [], decisions: [], noopReason: 'idle' }))
    const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const sessions = host.created.filter(options => String(options.sessionId).startsWith('session-superagent-'))
    assert.equal(sessions.length, 2, 'the previous session is replaced, not reused with the old model')
    assert.equal(sessions[1].agentOptions.model, 'fake-model-2')
    const state = (await callJson(host.routes, 'GET', '/state')).body.value.superagent
    assert.equal(state.runtime.activeModel.model, 'fake-model-2', 'the ACTIVE model is published separately')
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent (audit A07): a retryable failure uses the configured fallback route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-fallback-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    const configured = await callJson(host.routes, 'POST', '/superagent/model', {
      provider: 'fake-provider', model: 'fake-model', fallback: [{ provider: 'fake-provider', model: 'fake-model-2' }],
    })
    assert.equal(configured.status, 200, JSON.stringify(configured.body))
    await callJson(host.routes, 'POST', '/superagent/start')
    host.control.replyText = JSON.stringify(assessment({ proposals: [], decisions: [], noopReason: 'idle' }))
    host.control.failFollowups = 1
    const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const sessions = host.created.filter(options => String(options.sessionId).startsWith('session-superagent-'))
    assert.equal(sessions.length, 2, 'the failed session is replaced by the fallback route')
    assert.equal(sessions[1].agentOptions.model, 'fake-model-2')
    const state = (await callJson(host.routes, 'GET', '/state')).body.value.superagent
    assert.equal(state.runtime.activeModel.model, 'fake-model-2')
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent (audit A03): create_task, update_task and comment reach the board API', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-writes-'))
  const previousHome = process.env.DSH_HOME
  const previousToken = process.env.DSH_TASKBOARD_PUBLIC_TOKEN
  process.env.DSH_HOME = home
  process.env.DSH_TASKBOARD_PUBLIC_TOKEN = 'audit-token'
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    const proposals = [
      { id: 'c1', action: 'create_task', projectId: 'w1', taskId: null, rationale: 'new card', risk: 'low', expectedEffect: 'card', requiresApproval: false, payload: { title: 'Nouvelle carte', description: 'desc', urgency: 'urgent' } },
      { id: 'u1', action: 'update_task', projectId: 'w1', taskId: 't1', rationale: 'edit card', risk: 'low', expectedEffect: 'edit', requiresApproval: false, payload: { title: 'Titre modifié', blocked: true } },
      { id: 'm1', action: 'comment', projectId: 'w1', taskId: 't1', rationale: 'note', risk: 'low', expectedEffect: 'comment', requiresApproval: false, payload: { body: 'Note du Super Agent' } },
    ]
    host.control.replyText = JSON.stringify(assessment({ proposals, decisions: [] }))
    const cycle = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const executed = cycle.body.value.executed
    assert.equal(executed.length, 3, JSON.stringify(executed))
    for (const entry of executed) assert.equal(entry.ok, true, JSON.stringify(entry))
    const calls = restoreFetch.calls.filter(call => call.url.includes('/dsh-taskboard/public/v1'))
    assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/tasks')), JSON.stringify(calls))
    assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/update')))
    assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/comments')))
    assert.ok(calls.every(call => String(call.headers?.authorization ?? '').startsWith('Bearer ')), 'every write is bearer-authenticated')
    const updateCall = calls.find(call => call.url.endsWith('/update'))
    const updateBody = JSON.parse(String(updateCall.body ?? '{}'))
    assert.equal(updateBody.ifVersion, 3, 'the connector reads the current version before editing')
    assert.equal(host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-')).length, 0, 'board writes open no worker session')
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousToken === undefined) delete process.env.DSH_TASKBOARD_PUBLIC_TOKEN
    else process.env.DSH_TASKBOARD_PUBLIC_TOKEN = previousToken
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Super Agent: a semantic directive conflict becomes ONE arbitration decision, deduplicated', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-superagent-conflict-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const host = await boot({ home })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    const reply = JSON.stringify(assessment({
      proposals: [],
      noopReason: 'attente arbitrage',
      directiveConflicts: [{ summary: 'Vitesse contre prudence', quotes: ['Livre vite', 'Teste tout avant chaque PR'], projectId: null }],
    }))
    host.control.replyText = reply
    const first = await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    await callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    const pending = (await callJson(host.routes, 'GET', '/state')).body.value.superagent.decisions.pending
    const conflicts = pending.filter(entry => entry.kind === 'arbitration' && /contradictoires/.test(entry.title))
    assert.equal(conflicts.length, 1, JSON.stringify(pending))
    assert.equal(host.created.filter(options => String(options.sessionId).startsWith('session-agentboard-')).length, 0, 'no effect')
  } finally {
    host.dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function withAssessmentHost(run, { forge = false, repositoryConfig = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dab-assessment-security-'))
  const previousHome = process.env.DSH_HOME
  const previousToken = process.env.DSH_TASKBOARD_PUBLIC_TOKEN
  const previousGithubToken = process.env.GITHUB_TOKEN
  process.env.DSH_HOME = home
  process.env.DSH_TASKBOARD_PUBLIC_TOKEN = 'test-assessment-token'
  // Deterministic credential state: env only, no `gh` probe.
  if (forge) process.env.GITHUB_TOKEN = 'test-github-token'
  else delete process.env.GITHUB_TOKEN
  const transport = installFetch({ isolated: true })
  const workspacePath = forge ? join(home, 'project') : undefined
  if (forge) {
    execFileSync('git', ['init', workspacePath], { stdio: 'ignore' })
    execFileSync('git', ['-C', workspacePath, 'remote', 'add', 'origin', 'https://github.com/owner/project.git'], { stdio: 'ignore' })
    transport.control.github = (_url, init) => ({ ok: true, status: 200,
      json: async () => init?.method === 'POST'
        ? { number: 42, title: 'Test PR', html_url: 'https://github.com/owner/project/pull/42', head: { ref: 'feat/test' }, base: { ref: 'main' } } : [],
    })
  }
  const host = await boot({ home, workspacePath,
    config: {
      githubTokenDiscovery: 'env',
      ...(forge && repositoryConfig ? { githubRepository: 'owner/project', allowGithubWrites: true } : {}),
    },
  })
  try {
    await callJson(host.routes, 'POST', '/mode', { mode: 'autonomous' })
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
    await callJson(host.routes, 'POST', '/superagent/start')
    const cycle = async (proposals, decisions = []) => {
      host.control.replyText = JSON.stringify(assessment({ proposals, decisions, noopReason: proposals.length === 0 ? 'waiting for operator arbitration' : null }))
      return callJson(host.routes, 'POST', '/superagent/cycle', { trigger: 'manual' })
    }
    const view = async () => (await callJson(host.routes, 'GET', '/state')).body.value
    const comments = () => transport.calls.filter(entry => entry.method === 'POST' && entry.url.endsWith('/comments'))
    await run({ host, transport, cycle, view, comments })
  } finally {
    host.dispose()
    transport()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousToken === undefined) delete process.env.DSH_TASKBOARD_PUBLIC_TOKEN
    else process.env.DSH_TASKBOARD_PUBLIC_TOKEN = previousToken
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousGithubToken
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function commentProposal(overrides = {}) {
  return { id: 'exact-comment', action: 'comment', projectId: 'w1', taskId: 't1', rationale: 'operator review', risk: 'low', expectedEffect: 'comment added', requiresApproval: false, payload: { body: 'Approved original bytes' }, ...overrides }
}

async function askComment(host) {
  const configured = await callJson(host.routes, 'POST', '/mandate', { level: 'L2', actionModes: { comment: 'ask' } })
  assert.equal(configured.status, 200, JSON.stringify(configured.body))
}

test('A05: canonical foreign task cannot be disguised as a task of an allowed project', async () => {
  await withAssessmentHost(async ({ cycle, comments, view }) => {
    const reply = await cycle(['launch', 'update_task', 'comment'].map((action, index) => commentProposal({ id: `foreign-${index}`, action, taskId: 't3' })))
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.deepEqual(reply.body.value.refused.map(entry => entry.reason), Array(3).fill('task_project_mismatch'))
    assert.deepEqual(reply.body.value.authorized, [])
    assert.equal(comments().length, 0)
    assert.equal((await view()).assignments.length, 0)
  })
})

test('A08: L2 ask creates its own bound decision; answer executes saved bytes once without a new assessment', async () => {
  await withAssessmentHost(async ({ host, cycle, view, comments }) => {
    await askComment(host)
    const reply = await cycle([commentProposal()])
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(reply.body.value.refused[0].reason, 'approval_required')
    assert.equal(comments().length, 0)
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'comment')
    assert.ok(decision, 'the deterministic gate creates an approval even when the model asks no question')
    assert.equal(decision.intent.taskVersion, 1)
    assert.equal(decision.operation.payload.body, 'Approved original bytes')
    await cycle([commentProposal()])
    const repeated = (await view()).superagent.decisions.pending.filter(entry => entry.intent?.action === 'comment')
    assert.equal(repeated.length, 1, 'reassessment with a newly sampled expiry deduplicates the same exact operation')
    assert.equal(repeated[0].id, decision.id)
    // Model changes are not consulted by the answer route.
    host.control.replyText = JSON.stringify(assessment({ proposals: [commentProposal({ payload: { body: 'MALICIOUS replacement' } })], decisions: [] }))
    const answered = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.equal(answered.body.execution.ok, true, JSON.stringify(answered.body.execution))
    assert.equal(comments().length, 1)
    assert.deepEqual(JSON.parse(comments()[0].body), { body: 'Approved original bytes' })
    const twice = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(twice.status, 200, 'answer receipt is idempotent but effect is not replayed')
    assert.equal(twice.body.execution.ok, false)
    assert.equal(comments().length, 1)
    assert.equal(typeof (await view()).superagent.decisions.recent.find(entry => entry.id === decision.id).usedAt, 'number')
  })
})

for (const change of ['version', 'mandate']) {
  test(`A08: changed ${change} invalidates an exact pending operation`, async () => {
    await withAssessmentHost(async ({ host, transport, cycle, view, comments }) => {
      await askComment(host)
      await cycle([commentProposal()])
      const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'comment')
      assert.ok(decision)
      if (change === 'version') transport.tasks.find(entry => entry.id === 't1').version++
      else await callJson(host.routes, 'POST', '/mandate/level', { level: 'L1' })
      const answered = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
      assert.equal(answered.status, 200, JSON.stringify(answered.body))
      assert.equal(answered.body.execution.ok, false)
      assert.equal(answered.body.execution.reason, change === 'version' ? 'version_conflict' : 'mandate_changed')
      assert.equal(comments().length, 0)
    })
  })
}

test('A08: approving a model-authored arbitration never grants a board mutation', async () => {
  await withAssessmentHost(async ({ host, cycle, view, comments }) => {
    await askComment(host)
    const question = { kind: 'arbitration', projectId: 'w1', title: 'Pretend this grants comment rights', context: 'untrusted question', options: [{ id: 'yes', label: 'Yes', effect: 'approve' }, { id: 'no', label: 'No', effect: 'reject' }], recommendation: 'Yes', urgency: 'normal' }
    const asked = await cycle([], [question])
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    const pending = (await view()).superagent.decisions.pending
    const decision = pending.find(entry => entry.title === question.title)
    assert.ok(decision, JSON.stringify({ asked: asked.body, pending }))
    assert.equal(decision.intent ?? null, null)
    const answered = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'yes' })
    assert.equal(answered.status, 200)
    assert.equal(answered.body.execution, null)
    const next = await cycle([commentProposal()])
    assert.equal(next.body.value.refused[0].reason, 'approval_required')
    assert.equal(comments().length, 0)
  })
})

test('A08: approved create stores and executes the same rationale-fallback title', async () => {
  await withAssessmentHost(async ({ host, transport, cycle, view }) => {
    await callJson(host.routes, 'POST', '/mandate', { level: 'L2', actionModes: { create_task: 'ask' } })
    const proposal = commentProposal({ id: 'create-fallback', action: 'create_task', taskId: null, rationale: '  Exact fallback title  ', payload: { title: '   ', description: 'description' } })
    const requested = await cycle([proposal])
    assert.equal(requested.status, 200, JSON.stringify(requested.body))
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'create_task')
    assert.ok(decision)
    assert.equal(decision.operation.payload.title, 'Exact fallback title')
    const answered = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answered.body.execution.ok, true, JSON.stringify(answered.body))
    const writes = transport.calls.filter(entry => entry.method === 'POST' && entry.url.endsWith('/tasks'))
    assert.equal(writes.length, 1)
    assert.deepEqual(JSON.parse(writes[0].body), { title: 'Exact fallback title', description: 'description', workspaceId: 'w1' })
  })
})

test('A06: missing confinement APIs make the assessment unavailable before any model work', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    host.control.brainToolsUnavailable = true
    await callJson(host.routes, 'POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model-2' })
    const before = host.messages.length
    const reply = await cycle([commentProposal()])
    assert.equal(reply.status, 409, JSON.stringify(reply.body))
    assert.equal(host.messages.length, before, 'no assessment request can run without tool confinement')
    const state = await view()
    assert.equal(state.superagent.runtime.available, false)
    assert.match(state.superagent.runtime.reason, /security_service_unavailable:tools/)
    assert.deepEqual(state.assignments, [])
  })
})

test('delegate launches one confined canonical worker and refuses foreign tasks and duplicates', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const result = await cycle([
      commentProposal({ id: 'delegate-foreign', action: 'delegate', taskId: 't3', payload: null }),
      commentProposal({ id: 'delegate-valid', action: 'delegate', payload: null }),
      commentProposal({ id: 'delegate-duplicate', action: 'delegate', payload: null }),
    ])
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.value.refused[0].reason, 'task_project_mismatch')
    const effects = result.body.value.executed
    assert.equal(effects[0].ok, true, JSON.stringify(effects))
    assert.equal(effects[0].action, 'delegate')
    assert.equal(effects[1].ok, false)
    assert.equal(effects[1].reason, 'duplicate_assignment')
    assert.equal(host.created.filter(entry => entry.sessionId.startsWith('session-agentboard-')).length, 1)
    assert.equal((await view()).assignments[0].authorizationAction, 'delegate')
  })
})

test('delegate requires launch permission too; supervised delegation uses a bound single-use decision', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    await callJson(host.routes, 'POST', '/mandate', { level: 'L4', actionModes: { launch: 'deny' } })
    const denied = await cycle([commentProposal({ action: 'delegate', payload: null })])
    assert.equal(denied.body.value.refused[0].reason, 'action_disabled')
    assert.equal((await view()).assignments.length, 0)
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L2' })
    const proposed = await cycle([commentProposal({ action: 'delegate', payload: null })])
    assert.equal(proposed.body.value.refused[0].reason, 'approval_required')
    // Repeated pending proposals are coalesced as SUCCESSFUL requests, not an
    // undefined refusal reason; the dedupe return has the same shape as create.
    const repeated = await cycle([commentProposal({ action: 'delegate', payload: null })])
    assert.equal(repeated.body.value.refused[0].reason, 'approval_required')
    const decisions = (await view()).superagent.decisions.pending.filter(entry => entry.intent?.action === 'delegate')
    assert.equal(decisions.length, 1)
    const approved = await callJson(host.routes, 'POST', `/superagent/decisions/${decisions[0].id}/answer`, { optionId: 'approve' })
    assert.equal(approved.body.execution.ok, true, JSON.stringify(approved.body))
    assert.equal(host.created.filter(entry => entry.sessionId.startsWith('session-agentboard-')).length, 1)
    await callJson(host.routes, 'POST', `/superagent/decisions/${decisions[0].id}/answer`, { optionId: 'approve' })
    assert.equal(host.created.filter(entry => entry.sessionId.startsWith('session-agentboard-')).length, 1)
  })
})

const prProposal = (overrides = {}) => commentProposal({ id: 'open-test-pr', action: 'open_pr', taskId: null,
  payload: { title: 'Test PR', body: 'Verified change', head: 'feat/test', base: 'main' }, ...overrides })

test('open_pr reaches the configured forge automatically with project binding and deduplication', async () => {
  await withAssessmentHost(async ({ host, cycle, view, transport }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const capabilities = (await view()).capabilities
    assert.equal(capabilities.open_pr.implemented, true)
    assert.equal(capabilities.open_pr.state, 'available')
    const first = await cycle([prProposal()])
    assert.equal(first.body.value.executed[0].ok, true, JSON.stringify(first.body))
    assert.equal(first.body.value.executed[0].value.pull.id, '42')
    await cycle([prProposal()])
    const writes = transport.calls.filter(entry => entry.method === 'POST' && entry.url.startsWith('https://api.github.com/'))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].url, 'https://api.github.com/repos/owner/project/pulls')
    assert.equal(JSON.parse(writes[0].body).head, 'feat/test')
    // A grant to this project cannot write into the global adapter's repository
    // when the actual local origin no longer proves that ownership.
    const workspace = host.ctx.workspaceRegistry.get('w1')
    execFileSync('git', ['-C', workspace.path, 'remote', 'set-url', 'origin', 'https://github.com/other/project.git'], { stdio: 'ignore' })
    const mismatch = await cycle([prProposal({ id: 'foreign-pr' })])
    assert.equal(mismatch.body.value.refused[0].reason, 'forge_project_mismatch')
    assert.equal(transport.calls.filter(entry => entry.method === 'POST' && entry.url.startsWith('https://api.github.com/')).length, 1)
  }, { forge: true })
})

test('open_pr approval executes exact saved bytes once and refuses a changed repository binding', async () => {
  await withAssessmentHost(async ({ host, cycle, view, transport }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L2' })
    const pending = await cycle([prProposal()])
    assert.equal(pending.body.value.refused[0].reason, 'approval_required')
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'open_pr')
    assert.ok(decision)
    assert.match(decision.context, /owner\/project/)
    const workspace = host.ctx.workspaceRegistry.get('w1')
    execFileSync('git', ['-C', workspace.path, 'remote', 'set-url', 'origin', 'https://github.com/other/project.git'], { stdio: 'ignore' })
    const refused = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(refused.body.execution.reason, 'forge_project_mismatch')
    assert.equal(transport.calls.filter(entry => entry.method === 'POST' && entry.url.startsWith('https://api.github.com/')).length, 0)
    execFileSync('git', ['-C', workspace.path, 'remote', 'set-url', 'origin', 'https://github.com/owner/project.git'], { stdio: 'ignore' })
    const approved = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(approved.body.execution.ok, true, JSON.stringify(approved.body))
    const writes = () => transport.calls.filter(entry => entry.method === 'POST' && entry.url.startsWith('https://api.github.com/'))
    assert.equal(writes().length, 1)
    assert.equal(JSON.parse(writes()[0].body).title, decision.operation.payload.title)
    await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(writes().length, 1)
  }, { forge: true })
})

test('revoking delegation during worker creation sends no work and disposes the unused session', async () => {
  await withAssessmentHost(async ({ host, cycle }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    host.control.beforeWorkerCreated = async () => {
      await callJson(host.routes, 'POST', '/mandate', { actionModes: { delegate: 'deny' } })
    }
    const result = await cycle([commentProposal({ action: 'delegate', payload: null })])
    assert.equal(result.body.value.executed[0].ok, false, JSON.stringify(result.body))
    const worker = host.created.find(entry => entry.sessionId.startsWith('session-agentboard-'))
    assert.ok(worker)
    assert.equal(host.messages.filter(entry => entry.sessionId === worker.sessionId).length, 0)
    assert.equal(host.ctx.agents.get(worker.sessionId), undefined)
  })
})

test('Stop while GitHub lookup is awaiting prevents the PR POST', async () => {
  await withAssessmentHost(async ({ host, cycle, transport }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    transport.control.github = async (_url, init) => {
      assert.notEqual(init?.method, 'POST', 'no effect is permitted after Stop')
      await callJson(host.routes, 'POST', '/stop', {})
      return { ok: true, status: 200, json: async () => [] }
    }
    const result = await cycle([prProposal()])
    assert.equal(result.body.value.executed[0].ok, false)
    assert.equal(result.body.value.executed[0].reason, 'stopped_by_operator')
    assert.equal(transport.calls.filter(entry => entry.method === 'POST' && entry.url.startsWith('https://api.github.com/')).length, 0)
  }, { forge: true })
})

test('delete_task requires exact human consent and invokes the native owner once', async () => {
  await withAssessmentHost(async ({ host, cycle, view, transport }) => {
    host.control.nativeDeletion = { calls: [], value: { trashed: true, task: { id: 't1', version: 2 } } }
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const proposal = commentProposal({ id: 'delete-one', action: 'delete_task', payload: { reason: 'Duplicate task' } })
    const reply = await cycle([proposal])
    assert.equal(reply.body.value.refused[0].reason, 'approval_required')
    assert.equal(host.control.nativeDeletion.calls.length, 0)
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'delete_task')
    assert.ok(decision)
    const answer = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answer.body.execution.ok, true, JSON.stringify(answer.body))
    assert.equal(answer.body.execution.disposed, true)
    assert.deepEqual(host.control.nativeDeletion.calls, [{ id: 't1', ifVersion: 1, reason: 'Duplicate task' }])
    const operation = host.created.find(entry => entry.sessionId.startsWith('session-agentboard-operation-'))
    assert.equal(host.messages.filter(entry => entry.sessionId === operation.sessionId).length, 0, 'no model prompt')
    assert.equal(host.ctx.agents.get(operation.sessionId), undefined)
    await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(host.control.nativeDeletion.calls.length, 1)
    assert.equal(transport.calls.filter(entry => entry.method === 'POST' && /\/delete|\/trash/.test(entry.url)).length, 0,
      'no GUI route or public route is impersonated')
  })
})

test('delete_task retains native dependent approval and refuses a foreign canonical task', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    host.control.nativeDeletion = { calls: [], value: { pendingApproval: { id: 'dependency-approval', kind: 'trash-prerequisite', affected: ['dependent'] } } }
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const foreign = await cycle([commentProposal({ action: 'delete_task', taskId: 't3', payload: { reason: 'No' } })])
    assert.equal(foreign.body.value.refused[0].reason, 'task_project_mismatch')
    await cycle([commentProposal({ action: 'delete_task', payload: { reason: 'Request removal' } })])
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'delete_task')
    const answer = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answer.body.execution.ok, true)
    assert.equal(answer.body.execution.pendingApproval.id, 'dependency-approval')
    assert.equal(answer.body.execution.value.trashed, undefined)
  })
})

test('policy_change applies only approved project preferences, never global or worker permissions', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const before = await view()
    const reply = await cycle([commentProposal({ id: 'project-policy', action: 'policy_change', taskId: null,
      payload: { priority: 8, maxTasksPerHour: 2 } })])
    assert.equal(reply.body.value.refused[0].reason, 'approval_required')
    assert.deepEqual((await view()).mandate.projects, before.mandate.projects)
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'policy_change')
    assert.deepEqual(decision.operation.payload, { priority: 8, maxTasksPerHour: 2 })
    const answer = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answer.body.execution.ok, true, JSON.stringify(answer.body))
    const after = await view()
    assert.equal(after.mandate.projects.w1.priority, 8)
    assert.equal(after.mandate.projects.w1.budget.maxTasksPerHour, 2)
    assert.deepEqual(after.mandate.projects.w2, before.mandate.projects.w2)
    for (const key of ['scopeMode', 'selectedWorkspaces', 'level', 'actions', 'actionModes']) {
      assert.deepEqual(after.mandate[key], before.mandate[key], key)
    }
    assert.deepEqual(after.policy, before.policy)
    assert.equal(after.mandate.projects.w1.level, before.mandate.projects.w1.level)
    assert.equal(after.mandate.projects.w1.model, before.mandate.projects.w1.model)
    await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal((await view()).mandate.revision, after.mandate.revision)
  })
})

function nativeMergeFixture(host) {
  const repository = { forge: 'github', host: 'github.com', owner: 'owner', name: 'project' }
  const control = { calls: [], snapshot: null }
  host.control.nativeForge = {
    repositoryFromRemote: () => repository,
    fetchChecks: async ref => control.snapshot ?? ({ ref, state: 'open', draft: false, mergeReady: true,
      mergeability: 'mergeable', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseBranch: 'main',
      mergeMethods: ['squash'], checksRollup: 'success', checksTruncated: false, threadsTruncated: false,
      reviewersTruncated: false, unresolvedThreads: 0, reviewDecision: 'approved' }),
    merge: async (ref, request) => { control.calls.push({ ref, request }); return undefined },
  }
  return control
}

test('merge captures a real native forge snapshot and always needs exact human approval, even in auto mode', async () => {
  await withAssessmentHost(async ({ host, cycle, view, transport }) => {
    const forge = nativeMergeFixture(host)
    await callJson(host.routes, 'POST', '/mandate', { level: 'L4', actionModes: { merge: 'auto' } })
    const before = structuredClone(transport.tasks)
    const result = await cycle([commentProposal({ id: 'merge-native', action: 'merge', taskId: null, payload: { number: 42 } })])
    assert.equal(result.body.value.refused[0].reason, 'approval_required', JSON.stringify(result.body))
    assert.equal(forge.calls.length, 0)
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'merge')
    assert.ok(decision)
    assert.deepEqual(decision.operation.payload, { number: 42, method: 'squash', repository: 'github:github.com/owner/project',
      headSha: 'a'.repeat(40), base: 'main', baseSha: 'b'.repeat(40) })
    const answer = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answer.body.execution.ok, true, JSON.stringify(answer.body))
    assert.deepEqual(forge.calls[0].request, { method: 'squash', headSha: 'a'.repeat(40) })
    assert.deepEqual(transport.tasks, before, 'merging never marks a task done')
    await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(forge.calls.length, 1)
  }, { forge: true })
})

test('merge refuses a changed native head after consent without executing another target', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    const forge = nativeMergeFixture(host)
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    await cycle([commentProposal({ id: 'stale-merge', action: 'merge', taskId: null, payload: { number: 42 } })])
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'merge')
    const ref = { number: 42, repository: { forge: 'github', host: 'github.com', owner: 'owner', name: 'project' } }
    forge.snapshot = { ...await host.control.nativeForge.fetchChecks(ref), headSha: 'c'.repeat(40) }
    const answer = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answer.body.execution.reason, 'forge_stale_change_request')
    assert.equal(forge.calls.length, 0)
  }, { forge: true })
})

test('schedule creates one scheduled card through the owner tool, automatically at L4 and exactly once on approval', async () => {
  await withAssessmentHost(async ({ host, cycle, view }) => {
    host.control.nativeCreate = { calls: [], value: { task: { id: 't-scheduled', status: 'todo', version: 1 } } }
    const proposal = (id, payload) => commentProposal({ id, action: 'schedule', taskId: null, payload })
    const payload = { title: 'Nightly review', cron: '0 3 * * *', prompt: 'Check the backlog' }

    // L4 profile automates the non-critical schedule: no decision, one card.
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const automatic = await cycle([proposal('schedule-auto', payload)])
    const executed = automatic.body.value.executed[0]
    assert.equal(executed.ok, true, JSON.stringify(automatic.body))
    assert.deepEqual(host.control.nativeCreate.calls, [{
      title: 'Nightly review', workspaceId: 'w1', urgency: 'normal', prompt: 'Check the backlog',
      execution: { mode: 'scheduled', cron: '0 3 * * *' },
    }])
    assert.equal(host.messages.filter(entry => entry.sessionId.startsWith('session-agentboard-operation-')).length, 0)

    // An explicit ask creates one bound request; the answer executes the same bytes once.
    await callJson(host.routes, 'POST', '/mandate', { actionModes: { schedule: 'ask' } })
    const asked = await cycle([proposal('schedule-ask', payload)])
    assert.equal(asked.body.value.refused[0].reason, 'approval_required')
    assert.equal(host.control.nativeCreate.calls.length, 1)
    const decision = (await view()).superagent.decisions.pending.find(entry => entry.intent?.action === 'schedule')
    assert.deepEqual(decision.operation.payload, { title: 'Nightly review', urgency: 'normal', cron: '0 3 * * *', prompt: 'Check the backlog' })
    const answer = await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(answer.body.execution.ok, true, JSON.stringify(answer.body))
    assert.equal(host.control.nativeCreate.calls.length, 2)
    await callJson(host.routes, 'POST', `/superagent/decisions/${decision.id}/answer`, { optionId: 'approve' })
    assert.equal(host.control.nativeCreate.calls.length, 2)
  })
})

test('open_pr works from each project remote without a global repository setting', async () => {
  await withAssessmentHost(async ({ host, cycle, transport }) => {
    await callJson(host.routes, 'POST', '/mandate/level', { level: 'L4' })
    const result = await cycle([prProposal()])
    assert.equal(result.body.value.executed[0].ok, true, JSON.stringify(result.body))
    const writes = transport.calls.filter(entry => entry.method === 'POST' && entry.url.startsWith('https://api.github.com/'))
    assert.equal(writes[0].url, 'https://api.github.com/repos/owner/project/pulls')
    assert.equal(JSON.parse(writes[0].body).head, 'feat/test')
  }, { forge: true, repositoryConfig: false })
})
