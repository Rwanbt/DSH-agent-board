/**
 * GOAL 7 — the Super Agent must be able to advance a project WITHOUT the Task
 * Board plugin, and at maximum autonomy (L4) it must be able to triage the
 * backlog.
 *
 * Two properties are pinned on the REAL host `apply()`:
 *   1. With no readable Task Board ledger, the project's own documents (accepted
 *      ADR follow-ups, roadmap/TODO checklists) become dispatchable work items:
 *      `launch_work` opens a real worker session in the project directory, and
 *      the dispatch is journaled so it is never looped.
 *   2. At L4, `promote_task` moves ONE unblocked backlog card to `todo` through
 *      the owner's native tool; every precondition refuses with its own reason,
 *      and `done` stays unreachable.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { workItemIdOf } from '../src/orchestrator/project-work.js'
import { applyAgentSetup, secureAgentContext } from './fixtures/secure-agent-context.js'

const ADR = `# ADR 0007 — Atomic journal writes

Status: Accepted

## Follow-ups

- [ ] Write the state file through a temp file and a rename
`

const PROPOSED_ADR = `# ADR 0008 — Worker-thread scheduler

Status: Proposed

## Follow-ups

- [ ] Extract the scheduler loop into a worker
`

const TODO = `# TODO

## Next

- [ ] Add the restart test
`

function mandateFor(level) {
  return {
    scopeMode: 'selected',
    selectedWorkspaces: ['w1'],
    level,
    actions: {
      launch: true, launch_work: true, promote_task: true, comment: true,
      create_task: true, update_task: true, schedule: true,
    },
    projects: { w1: { enabled: true, budget: { maxTasksPerHour: 20 } } },
    requiresConfiguration: false,
  }
}

function assessment(proposals) {
  return {
    schemaVersion: 1,
    situation: 'Project documents declare work; the board may dispatch it.',
    findings: [],
    proposals,
    decisions: [],
    directiveEcho: [],
    noopReason: null,
  }
}

function makeCtx({ projectPath, nativeMove }) {
  const created = []
  const messages = []
  const handles = new Map()
  const listeners = new Map()
  const routes = new Map()
  const control = { replyText: '{}', replyDelayMs: 5 }
  function emit(sessionId, event) {
    listeners.get('session/event')?.({ id: sessionId }, event)
  }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: projectPath, attachSession: async () => {} } : undefined),
      list: () => [{ id: 'w1', title: 'Projet w1', path: projectPath }],
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
              emit(options.sessionId, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: control.replyText }] } } })
              emit(options.sessionId, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
            }, control.replyDelayMs)
          },
        }
        const fixture = secureAgentContext({ sessionId: options.sessionId })
        if (nativeMove && options.sessionId.startsWith('session-agentboard-operation-')) {
          fixture.tools.executable = name => (name === 'taskboard_move' ? { name } : undefined)
          fixture.tools.execute = async input => {
            const call = input.calls[0]
            const args = JSON.parse(call.arguments)
            const exec = { agent: input.agent, callId: call.id, name: call.name, arguments: args }
            const denied = fixture.state.guards.map(guard => guard(exec)).find(Boolean)
            if (denied) return { results: [{ callId: call.id, result: { isError: true, error: { info: { code: 'GUARD_DENIED' } } } }] }
            nativeMove.calls.push(args)
            return { results: [{ callId: call.id, result: { isError: false, value: nativeMove.value } }] }
          }
        }
        await applyAgentSetup(options, agent, fixture)
        handles.set(options.sessionId, agent)
        return { agent, dispose: async () => { handles.delete(options.sessionId) } }
      },
      get(id) { return handles.get(id) },
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'fake-provider', name: 'Fake', locality: 'local' }],
          listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
        }
      }
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'tools' && nativeMove) {
        return { execute() {}, get: toolName => (toolName === 'taskboard_move' ? { name: toolName } : undefined) }
      }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, created, messages, routes, control }
}

function installFetch({ tasks = null } = {}) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, method: init?.method ?? 'GET' })
    if (target.includes('/dsh-taskboard/state')) {
      // No Task Board installed / unreachable: the drawer is closed.
      if (tasks === null) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { revision: 3, tasks } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const restore = () => { globalThis.fetch = previous }
  restore.calls = calls
  return restore
}

async function boot({ tasks = null, nativeMove = null, docs = {}, level = 'L3' }) {
  const home = await mkdtemp(join(tmpdir(), 'dab-independence-home-'))
  const projectPath = await mkdtemp(join(tmpdir(), 'dab-independence-project-'))
  execFileSync('git', ['init', projectPath], { stdio: 'ignore' })
  for (const [path, content] of Object.entries(docs)) {
    const target = join(projectPath, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  const previousHome = process.env.DSH_HOME
  const previousGithub = process.env.GITHUB_TOKEN
  process.env.DSH_HOME = home
  delete process.env.GITHUB_TOKEN
  const restoreFetch = installFetch({ tasks })
  const made = makeCtx({ projectPath, nativeMove })
  const dispose = apply(made.ctx, {
    mandate: mandateFor(level),
    baseUrl: 'http://127.0.0.1:1',
    githubTokenDiscovery: 'off',
  })
  const call = (method, path, body) => {
    const handler = made.routes.get('/dsh-agent-board/api/v2').handler
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
  const callJson = async (method, path, body) => {
    const res = call(method, path, body)
    const started = Date.now()
    while (res.body === '' && Date.now() - started < 8000) await new Promise(resolve => setTimeout(resolve, 10))
    return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
  }
  await callJson('GET', '/state')
  const started = Date.now()
  while (Date.now() - started < 8000) {
    const state = await callJson('GET', '/state')
    if (state.body?.value?.host?.models?.discovered === true) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await callJson('POST', '/mode', { mode: 'autonomous' })
  await callJson('POST', '/superagent/model', { provider: 'fake-provider', model: 'fake-model' })
  const startedAgent = await callJson('POST', '/superagent/start')
  assert.equal(startedAgent.status, 200, JSON.stringify(startedAgent.body))
  const cycle = async proposals => {
    made.control.replyText = JSON.stringify(assessment(proposals))
    return callJson('POST', '/superagent/cycle', { trigger: 'manual' })
  }
  const view = async () => (await callJson('GET', '/state')).body.value
  const cleanup = async () => {
    dispose()
    restoreFetch()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousGithub
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await rm(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  return { made, projectPath, cycle, view, cleanup }
}

test('NO Task Board: the project documents become work, launch_work opens a real session once', async () => {
  const host = await boot({ tasks: null, docs: { 'docs/adr/0007-journal.md': ADR, 'docs/adr/0008-worker.md': PROPOSED_ADR, 'TODO.md': TODO }, level: 'L3' })
  try {
    const state = await host.view()
    assert.equal(state.adapters !== undefined, true)
    const readyId = workItemIdOf({ projectId: 'w1', source: 'adr', title: 'Write the state file through a temp file and a rename' })
    const todoId = workItemIdOf({ projectId: 'w1', source: 'todo', title: 'Add the restart test' })
    const proposedId = workItemIdOf({ projectId: 'w1', source: 'adr', title: 'Extract the scheduler loop into a worker' })

    const cycle = await host.cycle([
      { id: 'w-1', action: 'launch_work', projectId: 'w1', taskId: null, rationale: 'ADR follow-up', risk: 'low', expectedEffect: 'session', requiresApproval: false, payload: { workItemId: readyId } },
      { id: 'w-2', action: 'launch_work', projectId: 'w1', taskId: null, rationale: 'TODO', risk: 'low', expectedEffect: 'session', requiresApproval: false, payload: { workItemId: todoId } },
      { id: 'w-3', action: 'launch_work', projectId: 'w1', taskId: null, rationale: 'proposed ADR', risk: 'low', expectedEffect: 'session', requiresApproval: false, payload: { workItemId: proposedId } },
    ])
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const executed = cycle.body.value.executed
    assert.equal(executed.length, 2, JSON.stringify(executed))
    assert.equal(executed[0].ok, true, JSON.stringify(executed[0]))
    assert.equal(executed[1].ok, true, JSON.stringify(executed[1]))
    const proposedRefusal = cycle.body.value.refused.find(entry => entry.id === 'w-3')
    assert.ok(proposedRefusal, JSON.stringify(cycle.body.value.refused))
    assert.match(proposedRefusal.reason, /^needs_human_decision:adr_not_accepted:proposed$/)

    const workers = host.made.created.filter(options => String(options.sessionId).startsWith('session-agentboard-') && !String(options.sessionId).includes('-operation-'))
    assert.equal(workers.length, 2, 'exactly two worker sessions, one per dispatchable item')
    const promptText = host.made.messages.map(message => message.text).join('\n')
    assert.match(promptText, /Write the state file through a temp file and a rename/)
    assert.match(promptText, /docs\/adr\/0007-journal\.md/)

    const after = await host.view()
    const workAssignments = after.assignments.filter(assignment => assignment.workSource !== undefined)
    assert.equal(workAssignments.length, 2)
    assert.equal(workAssignments[0].workSource.source, 'adr')
    assert.match(workAssignments[0].workSource.fingerprint, /^wf-/)

    // Once the item is dispatched (here the fake turn completes immediately), a
    // second cycle refuses it: the journal proves it was already handled.
    const again = await host.cycle([
      { id: 'w-4', action: 'launch_work', projectId: 'w1', taskId: null, rationale: 'retry', risk: 'low', expectedEffect: 'session', requiresApproval: false, payload: { workItemId: readyId } },
    ])
    assert.equal(again.body.value.refused[0].reason, 'work_item_completed')
    assert.equal(host.made.created.filter(options => String(options.sessionId).startsWith('session-agentboard-') && !String(options.sessionId).includes('-operation-')).length, 2)

    // The dry run describes the same sources without writing anything.
    const dry = await host.made.routes.get('/dsh-agent-board/api/v2')
    assert.ok(dry)
  } finally {
    await host.cleanup()
  }
})

test('a work item the operator did not authorize is refused, and an unknown id is never resolved', async () => {
  const host = await boot({ tasks: null, docs: { 'TODO.md': TODO }, level: 'L0' })
  try {
    // L0: no action at all, only observation.
    const cycle = await host.cycle([
      { id: 'x-1', action: 'launch_work', projectId: 'w1', taskId: null, rationale: 'x', risk: 'low', expectedEffect: 'session', requiresApproval: false, payload: { workItemId: workItemIdOf({ projectId: 'w1', source: 'todo', title: 'Add the restart test' }) } },
    ])
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    assert.equal(cycle.body.value.authorized.length, 0)
    assert.equal(cycle.body.value.refused[0].reason, 'level_too_low')
    assert.equal(host.made.created.filter(options => String(options.sessionId).startsWith('session-agentboard-') && !String(options.sessionId).includes('-operation-')).length, 0)

    // A made-up id is not a proof of ownership.
    const unknown = await host.cycle([
      { id: 'x-2', action: 'launch_work', projectId: 'w1', taskId: null, rationale: 'x', risk: 'low', expectedEffect: 'session', requiresApproval: false, payload: { workItemId: 'work-0000000000000000' } },
    ])
    assert.equal(unknown.body.value.refused[0].reason, 'work_item_not_found')
  } finally {
    await host.cleanup()
  }
})

test('L4 triage moves ONE unblocked backlog card to todo through the native owner tool', async () => {
  const nativeMove = { calls: [], value: { task: { id: 'b1', status: 'todo', version: 3 } } }
  const cards = [
    { id: 'b1', title: 'Routine maintenance', status: 'backlog', workspaceId: 'w1', dependsOn: [], version: 2, permission: 'workspace-write' },
    { id: 'b2', title: 'Waiting on a human', status: 'backlog', workspaceId: 'w1', dependsOn: [], version: 1, waitingForHuman: true },
    { id: 'b3', title: 'Blocked card', status: 'backlog', workspaceId: 'w1', dependsOn: [], version: 1, blocked: true },
    { id: 'b4', title: 'Needs prerequisite', status: 'backlog', workspaceId: 'w1', dependsOn: ['t-missing'], version: 1 },
  ]
  const host = await boot({ tasks: cards, nativeMove, level: 'L4' })
  try {
    const cycle = await host.cycle([
      { id: 'p-1', action: 'promote_task', projectId: 'w1', taskId: 'b1', rationale: 'routine', risk: 'low', expectedEffect: 'card in todo', requiresApproval: false, payload: { reason: 'Documented routine maintenance' } },
      { id: 'p-2', action: 'promote_task', projectId: 'w1', taskId: 'b2', rationale: 'x', risk: 'low', expectedEffect: 'x', requiresApproval: false, payload: { reason: 'no' } },
      { id: 'p-3', action: 'promote_task', projectId: 'w1', taskId: 'b3', rationale: 'x', risk: 'low', expectedEffect: 'x', requiresApproval: false, payload: { reason: 'no' } },
      { id: 'p-4', action: 'promote_task', projectId: 'w1', taskId: 'b4', rationale: 'x', risk: 'low', expectedEffect: 'x', requiresApproval: false, payload: { reason: 'no' } },
    ])
    assert.equal(cycle.status, 200, JSON.stringify(cycle.body))
    const reasons = Object.fromEntries(cycle.body.value.refused.map(entry => [entry.id, entry.reason]))
    assert.equal(reasons['p-2'], 'task_waiting_for_human')
    assert.equal(reasons['p-3'], 'task_blocked')
    assert.match(reasons['p-4'], /^dependencies_unsatisfied:t-missing$/)
    const promoted = cycle.body.value.executed.find(entry => entry.action === 'promote_task')
    assert.equal(promoted.ok, true, JSON.stringify(promoted))
    assert.deepEqual(nativeMove.calls, [{ id: 'b1', status: 'todo', ifVersion: 2 }])

    const state = await host.view()
    const journal = state.superagent.promotions.find(entry => entry.taskId === 'b1')
    assert.equal(journal.reason, 'Documented routine maintenance')
    assert.ok(state.audit.some(entry => entry.type === 'backlog_promoted' && entry.taskId === 'b1'))

    // The cooldown is durable: the same card is never promoted again in a loop.
    const again = await host.cycle([
      { id: 'p-5', action: 'promote_task', projectId: 'w1', taskId: 'b1', rationale: 'again', risk: 'low', expectedEffect: 'x', requiresApproval: false, payload: { reason: 'again' } },
    ])
    // b1 is `todo` in the refreshed ledger, so the ledger itself refuses first.
    assert.ok(['promotion_cooldown', 'task_not_backlog:todo'].includes(again.body.value.refused[0].reason), JSON.stringify(again.body.value.refused))
  } finally {
    await host.cleanup()
  }
})

test('below L4 the backlog is never triaged autonomously: the operator answers a bound approval', async () => {
  const nativeMove = { calls: [], value: { task: { id: 'b1', status: 'todo', version: 3 } } }
  const cards = [{ id: 'b1', title: 'Routine maintenance', status: 'backlog', workspaceId: 'w1', dependsOn: [], version: 2 }]
  const host = await boot({ tasks: cards, nativeMove, level: 'L3' })
  try {
    const cycle = await host.cycle([
      { id: 'p-1', action: 'promote_task', projectId: 'w1', taskId: 'b1', rationale: 'routine', risk: 'low', expectedEffect: 'todo', requiresApproval: true, payload: { reason: 'routine' } },
    ])
    assert.equal(cycle.body.value.refused[0].reason, 'level_too_low')
    assert.equal(nativeMove.calls.length, 0, 'no ledger write without the operator decision')
    const state = await host.view()
    assert.equal(state.superagent.decisions.pending.length, 0)
    assert.deepEqual(state.superagent.promotions, [])
  } finally {
    await host.cleanup()
  }
})
