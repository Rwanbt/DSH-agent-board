/**
 * GOAL 6 — P0 gate: a mandate that is empty/absent/migrated authorizes NOTHING,
 * even in autonomous mode, even after a restart; the dry-run writes nothing; the
 * published capabilities never promise an action the gate would refuse; a secret
 * integration token is never published.
 *
 * These tests use the REAL host `apply()` with a fake DSH context and a fake
 * Task Board ledger, like the existing governance suite.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { StateStore } from '../src/orchestrator/journal.js'
import { TEST_MANDATE } from './goal6-helpers.js'

const TASK = {
  id: 't-gate-1',
  title: 'Gate task',
  status: 'todo',
  urgency: 'normal',
  workspaceId: 'w1',
  dependsOn: [],
  version: 1,
  permission: 'workspace-write',
  isolation: 'none',
  execution: { mode: 'claim' },
}

function makeCtx() {
  const created = []
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:1',
      register: route => { routes.set(route.path, route); return () => routes.delete(route.path) },
    },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
      list: () => [{ id: 'w1', title: 'Projet Test', path: process.cwd() }],
    },
    agents: {
      async create(options) {
        created.push(options)
        return {
          agent: { id: options.sessionId, inject: () => {}, followup: () => {}, cancel: () => {} },
          dispose: async () => {},
        }
      },
      get(id) {
        return created.some(options => options.sessionId === id) ? { cancel: () => {} } : undefined
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, created, listeners, routes }
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
  while (res.body === '' && Date.now() - started < 4000) await new Promise(resolve => setTimeout(resolve, 10))
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

function installFetch(tasks = [TASK]) {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 7, tasks } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return () => { globalThis.fetch = previous }
}

async function withHost({ mandate, stateDocument, tasks } = {}, run) {
  const home = await mkdtemp(join(tmpdir(), 'dab-goal6-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  if (stateDocument !== undefined) {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'agent-board'), { recursive: true })
    await writeFile(join(home, 'agent-board', 'state.json'), JSON.stringify(stateDocument), 'utf8')
  }
  const restoreFetch = installFetch(tasks)
  const made = makeCtx()
  const dispose = apply(made.ctx, mandate === undefined ? {} : { mandate })
  try {
    await callJson(made.routes, 'GET', '/state')
    await run({ ...made, home })
  } finally {
    dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

test('no mandate + autonomous mode: no launch, no proposal, no session', async () => {
  await withHost({}, async ({ routes, created }) => {
    const mode = await callJson(routes, 'POST', '/mode', { mode: 'autonomous' })
    assert.equal(mode.status, 200)
    const tick = await callJson(routes, 'POST', '/tick', {})
    assert.equal(tick.status, 200)
    assert.equal(tick.body.actions.length, 0)
    assert.equal(tick.body.reason, 'requires_configuration')
    assert.equal(created.length, 0, 'no session may be created without a mandate')

    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(state.mandate.scopeMode, 'none')
    assert.equal(state.mandate.requiresConfiguration, true)
    assert.equal(state.capabilities.launch.state, 'unavailable')
    assert.equal(state.capabilities.launch.reason, 'scope_none')
    assert.equal(state.mandate.actions.launch, false)
  })
})

test('scope none stays inert even after a restart and an explicit L4 level', async () => {
  await withHost({ stateDocument: {
    schemaVersion: 2,
    mode: 'autonomous',
    stoppedAt: null,
    policy: { mode: 'autonomous', maxConcurrent: 2, allowedWorkspaces: [] },
    mandate: {
      version: 2,
      scopeMode: 'none',
      selectedWorkspaces: [],
      level: 'L4',
      actions: { launch: true, create_task: true, comment: true },
      projects: { w1: { enabled: true, level: 'L4' } },
      requiresConfiguration: false,
    },
    assignments: [],
  } }, async ({ routes, created, home }) => {
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(state.mandate.scopeMode, 'none')
    assert.equal(state.mandate.level, 'L4')
    const tick = await callJson(routes, 'POST', '/tick', {})
    assert.equal(tick.body.actions.length, 0)
    assert.equal(created.length, 0)
    let persisted = null
    assert.ok(await waitFor(async () => {
      persisted = JSON.parse(await readFile(join(home, 'agent-board', 'state.json'), 'utf8'))
      return persisted.schemaVersion === 2
    }), 'a v2 document must be persisted as v2, never downgraded')
    assert.equal(persisted.mandate.scopeMode, 'none')  })
})

test('v1 migration: empty allow-list + autonomous becomes inert and audited', async () => {
  await withHost({ stateDocument: {
    schemaVersion: 1,
    mode: 'autonomous',
    stoppedAt: null,
    policy: { mode: 'autonomous', maxConcurrent: 2, allowedWorkspaces: [], autonomyBudget: { maxTasksPerHour: 6 } },
    assignments: [],
  } }, async ({ routes, created, home }) => {
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(state.mandate.scopeMode, 'none')
    assert.equal(state.mandate.level, 'L1')
    assert.equal(state.mandate.requiresConfiguration, true)
    assert.ok(state.audit.some(entry => entry.type === 'mandate_migrated'))
    const tick = await callJson(routes, 'POST', '/tick', {})
    assert.equal(tick.body.actions.length, 0)
    assert.equal(created.length, 0, 'the historical "[] means everything" defect must be gone')
    let persisted = null
    assert.ok(await waitFor(async () => {
      persisted = JSON.parse(await readFile(join(home, 'agent-board', 'state.json'), 'utf8'))
      return persisted.schemaVersion === 2
    }), 'the migrated document must be persisted as v2')
    assert.equal(persisted.mandate.scopeMode, 'none')
  })
})

test('v1 migration: a non-empty selection is kept but still inert until confirmed', async () => {
  await withHost({ stateDocument: {
    schemaVersion: 1,
    mode: 'autonomous',
    stoppedAt: null,
    policy: { mode: 'autonomous', maxConcurrent: 2, allowedWorkspaces: ['w1'] },
    assignments: [],
  } }, async ({ routes, created }) => {
    const migrated = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(migrated.mandate.scopeMode, 'selected')
    assert.deepEqual(migrated.mandate.selectedWorkspaces, ['w1'])
    assert.equal(migrated.mandate.requiresConfiguration, true)
    assert.equal(migrated.mandate.actions.launch, false)
    const refused = await callJson(routes, 'POST', '/tick', {})
    assert.equal(refused.body.actions.length, 0)
    assert.equal(created.length, 0)

    // The operator now confirms a real mandate through the API.
    const confirmed = await callJson(routes, 'POST', '/mandate', { mandate: {
      scopeMode: 'selected',
      selectedWorkspaces: ['w1'],
      level: 'L3',
      actions: { launch: true },
      projects: { w1: { enabled: true } },
    } })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.value.requiresConfiguration, false)

    // The host restarted in autonomous mode: the durable resume gate still needs
    // an explicit resume before delegating (existing product rule).
    const resumed = await callJson(routes, 'POST', '/resume', {})
    assert.equal(resumed.status, 200)
    const tick = await callJson(routes, 'POST', '/tick', {})
    assert.equal(tick.body.actions.length, 1, JSON.stringify(tick.body))
    assert.equal(created.length, 1, JSON.stringify(tick.body))
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.ok(state.audit.some(entry => entry.type === 'mandate_confirmed'))
    // The launched card is in progress; it is never declared done by the board.
    assert.equal(state.assignments.length, 1)
  })
})

test('dry-run writes nothing: no session, no tick, no ledger mutation', async () => {
  await withHost({ mandate: TEST_MANDATE }, async ({ routes, created }) => {
    await callJson(routes, 'POST', '/mode', { mode: 'autonomous' })
    const before = (await callJson(routes, 'GET', '/state')).body.value
    const dry = await callJson(routes, 'GET', '/dry-run')
    assert.equal(dry.status, 200)
    assert.equal(dry.body.value.writes, 0)
    assert.equal(dry.body.value.candidateCount, 1)
    assert.equal(dry.body.value.allowedCount, 1)
    assert.equal(created.length, 0, 'a simulation never creates a session')

    const after = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(after.assignments.length, 0)
    assert.equal(after.lastTick, before.lastTick)
    assert.equal(after.proposals.length, 0)
  })
})

test('capabilities are truthful in OFF and after a Stop', async () => {
  await withHost({ mandate: TEST_MANDATE }, async ({ routes }) => {
    const off = (await callJson(routes, 'GET', '/state')).body.value
    // No adapter exists for these actions at all, so the reason is structural,
    // not a temporary mode refusal: nothing pretends they are available.
    assert.equal(off.capabilities.delegate.state, 'unavailable')
    assert.equal(off.capabilities.delegate.reason, 'no_adapter_for_action')
    assert.equal(off.capabilities.open_pr.reason, 'no_adapter_for_action')
    assert.equal(off.capabilities.create_task.reason, 'no_adapter_for_action')
    assert.equal(off.capabilities.launch.reason, 'mode_off')

    await callJson(routes, 'POST', '/mode', { mode: 'autonomous' })
    const running = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(running.capabilities.launch.state, 'available', JSON.stringify(running.capabilities.launch))

    await callJson(routes, 'POST', '/stop', {})
    const stopped = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(stopped.capabilities.launch.state, 'unavailable')
    assert.equal(stopped.capabilities.launch.reason, 'stopped_by_operator')

    // Stop is not a brick: resume restores the effective capability.
    const resumed = await callJson(routes, 'POST', '/resume', {})
    assert.equal(resumed.status, 200)
    const after = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(after.capabilities.launch.state, 'available')
  })
})

test('"all projects" requires an explicit confirmation; without it the scope stays none', async () => {
  await withHost({}, async ({ routes }) => {
    const refused = await callJson(routes, 'POST', '/mandate/scope', { scopeMode: 'all' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'all_scope_requires_confirmation')
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(state.mandate.scopeMode, 'none')

    const accepted = await callJson(routes, 'POST', '/mandate/scope', { scopeMode: 'all', confirm: 'ALL_PROJECTS' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.value.scopeMode, 'all')
    assert.equal(accepted.body.value.allConsent.text, 'ALL_PROJECTS')
    assert.ok(accepted.body.value.allConsent.at > 0)
  })
})

test('a selected scope requires at least one existing workspace', async () => {
  await withHost({}, async ({ routes }) => {
    const empty = await callJson(routes, 'POST', '/mandate/scope', { scopeMode: 'selected', selectedWorkspaces: [] })
    assert.equal(empty.status, 409)
    const unknown = await callJson(routes, 'POST', '/mandate/project', { projectId: 'not-a-project', enabled: true })
    assert.equal(unknown.status, 404)
  })
})

test('the Task Board public token is never published nor logged into the state', async () => {
  const token = 'tok-super-secret-value'
  const previousToken = process.env.DSH_TASKBOARD_PUBLIC_TOKEN
  process.env.DSH_TASKBOARD_PUBLIC_TOKEN = token
  try {
    await withHost({}, async ({ routes }) => {
      const res = call(routes, 'GET', '/state')
      const started = Date.now()
      while (res.body === '' && Date.now() - started < 4000) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(res.body.includes(token), false, 'the token must never appear in a published payload')
      const value = JSON.parse(res.body).value
      assert.equal(value.host.taskboardPublic.configured, true)
      assert.equal(value.host.taskboardPublic.reason, null)
      assert.equal(JSON.stringify(value.host.taskboardPublic).includes(token), false)
    })
  } finally {
    if (previousToken === undefined) delete process.env.DSH_TASKBOARD_PUBLIC_TOKEN
    else process.env.DSH_TASKBOARD_PUBLIC_TOKEN = previousToken
  }
})

test('model discovery is honest when the host has no llm service', async () => {
  await withHost({}, async ({ routes }) => {
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(state.host.build.schemaVersion, 2)
    assert.equal(state.host.build.features.includes('mandate'), true)
    assert.equal(state.host.models.discovered, false)
    assert.equal(state.host.models.reason, 'llm_service_unavailable')
    assert.deepEqual(state.host.models.providers, [])
  })
})

test('a handoff/retry obeys the NEW mandate: removing the project suppresses it', async () => {
  await withHost({ mandate: TEST_MANDATE }, async ({ routes, created, listeners }) => {
    await callJson(routes, 'POST', '/policy', {
      policy: {
        mode: 'autonomous',
        routeChain: [{ provider: 'primary', model: 'big' }, { provider: 'backup', model: 'medium' }],
        maxRetries: 0,
        maxSwitches: 2,
        maxConcurrent: 2,
      },
    })
    await callJson(routes, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(routes, 'POST', '/tick', {})
    assert.equal(tick.body.actions.length, 1, JSON.stringify(tick.body))
    const sessionId = created[0].sessionId
    assert.ok(sessionId)

    // The operator removes w1 from the mandate while the run is active.
    const scoped = await callJson(routes, 'POST', '/mandate/scope', { scopeMode: 'selected', selectedWorkspaces: ['w2'] })
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body))

    const listener = listeners.get('session/event')
    listener({ id: sessionId }, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
    listener({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: '503 service unavailable' } } } })
    await new Promise(resolve => setTimeout(resolve, 120))

    assert.equal(created.length, 1, 'the handoff must pass through the new mandate gate')
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.match(state.assignments[0].error, /handoff_suppressed:project_not_selected/, JSON.stringify(state.assignments[0]))
    assert.ok(state.audit.some(entry => entry.type === 'handoff_suppressed' && entry.reason === 'project_not_selected'))
  })
})

test('a decision approval authorizes ONE launch, then is consumed', async () => {
  const now = Date.now()
  const approval = {
    id: 'dec-1',
    kind: 'approval',
    projectId: 'w1',
    title: 'Approuver le lancement de t-gate-1',
    context: 'La tâche est prête et le mandat est en L2.',
    action: 'launch',
    taskIds: ['t-gate-1'],
    options: [{ id: 'approve', label: 'Approuver', effect: 'approve' }, { id: 'reject', label: 'Refuser', effect: 'reject' }],
    recommendation: 'Approuver',
    urgency: 'normal',
    status: 'answered',
    createdAt: now - 10_000,
    answeredAt: now - 5_000,
    answer: { optionId: 'approve', by: 'operator', at: now - 5_000 },
    expiresAt: now + 3_600_000,
    provenance: 'superagent',
    fingerprint: 'fp-approval-1',
    dedupeKey: 'fp-approval-1',
    askedCount: 1,
  }
  await withHost({
    stateDocument: {
      schemaVersion: 2,
      mode: 'autonomous',
      stoppedAt: null,
      policy: { mode: 'autonomous', maxConcurrent: 2, maxRetries: 0, retryCooldownMs: 0, maxAttemptsPerRevision: 9 },
      mandate: {
        version: 2,
        scopeMode: 'selected',
        selectedWorkspaces: ['w1'],
        level: 'L2',
        actions: { launch: true },
        projects: { w1: { enabled: true, budget: { maxTasksPerHour: 20 } } },
        requiresConfiguration: false,
      },
      superagent: { identity: { agentId: 'super-agent-test', createdAt: now - 60_000, level: 'L2' }, decisions: [approval] },
      assignments: [],
    },
  }, async ({ routes, created, listeners }) => {
    await callJson(routes, 'POST', '/resume', {})
    const first = await callJson(routes, 'POST', '/tick', {})
    assert.equal(first.body.actions.length, 1, JSON.stringify(first.body))
    assert.equal(created.length, 1, 'the approval authorizes the first launch')

    // The session ends without moving the card (visible in the real E2E): the
    // card is still todo, so the next tick would relaunch it — and must NOT,
    // because the approval was consumed.
    listeners.get('session/event')({ id: created[0].sessionId }, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 60))

    const second = await callJson(routes, 'POST', '/tick', {})
    assert.equal(created.length, 1, 'the SAME approval must not authorize a second launch')
    assert.equal(second.body.actions.length, 1, JSON.stringify(second.body))
    assert.equal(second.body.actions[0].ok, false)
    assert.equal(second.body.actions[0].reason, 'approval_required', JSON.stringify(second.body))
    const state = (await callJson(routes, 'GET', '/state')).body.value
    assert.equal(typeof state.superagent.decisions.recent[0].usedAt, 'number', 'the consumed marker survives a cycle/normalization')
  })
})

test('project model and hourly budget are effective, not decorative', async () => {
  const secondTask = { ...TASK, id: 't-gate-2', title: 'Deuxième tâche' }
  await withHost({
    mandate: {
      ...TEST_MANDATE,
      projects: { w1: { enabled: true, level: 'L4', budget: { maxTasksPerHour: 1 }, model: { provider: 'primary', model: 'project-model' } } },
    },
    tasks: [TASK, secondTask],
  }, async ({ routes, created }) => {
    await callJson(routes, 'POST', '/mode', { mode: 'autonomous' })
    const tick = await callJson(routes, 'POST', '/tick', {})
    assert.equal(created.length, 1, 'the per-project hourly budget allows exactly one launch')
    assert.equal(tick.body.actions.length, 2)
    assert.equal(tick.body.actions[0].ok, true)
    assert.equal(tick.body.actions[1].ok, false)
    assert.equal(tick.body.actions[1].reason, 'project_budget_exhausted')
    assert.equal(created[0].agentOptions.model, 'project-model', 'the project model is used for the session')
    assert.equal(created[0].agentOptions.provider, 'primary')
  })
})

test('an unknown state schemaVersion is preserved, never overwritten with defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dab-schema-v3-'))
  const previousHome = process.env.DSH_HOME
  try {
    await mkdir(join(dir, 'agent-board'), { recursive: true })
    const original = { schemaVersion: 3, sentinel: 'KEEP-ME', mode: 'autonomous' }
    await writeFile(join(dir, 'agent-board', 'state.json'), JSON.stringify(original), 'utf8')
    const store = new StateStore({ dir: join(dir, 'agent-board'), now: () => 4242 })
    const initial = await store.init({ schemaVersion: 2, mode: 'off', mandate: null })
    assert.equal(initial.mode, 'off', 'the host runs on defaults')
    const files = await readdir(join(dir, 'agent-board'))
    const preserved = files.find(name => name.startsWith('state.json.unsupported-'))
    assert.ok(preserved !== undefined, `the unknown document must be set aside, got ${files.join(',')}`)
    const kept = JSON.parse(await readFile(join(dir, 'agent-board', preserved), 'utf8'))
    assert.equal(kept.sentinel, 'KEEP-ME')
    assert.equal(kept.schemaVersion, 3)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
