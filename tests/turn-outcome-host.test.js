/**
 * P0-B / P1-E — a finished turn is not finished work, at the HOST level.
 *
 * The host settles an attempt from observable facts only. These tests drive real
 * `turn/end` events through the real `apply()` host and check the three verdicts
 * end to end: a truncated turn is continued (bounded) then escalated to the
 * inbox, a completion without proof never settles `done`, and a real commit does.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { MAX_CONTINUATIONS } from '../src/host/turn-outcome.js'
import { workItemReadinessOf } from '../src/orchestrator/project-work.js'
import { setupAgentHandle } from './fixtures/secure-agent-context.js'
import { TEST_MANDATE } from './goal6-helpers.js'

const TASK = {
  id: 't-turn-1',
  title: 'Prove the work before claiming it',
  status: 'todo',
  urgency: 'normal',
  workspaceId: 'w1',
  dependsOn: [],
  revision: 1,
}

function makeCtx({ workspacePath }) {
  const listeners = new Map()
  const routes = new Map()
  const created = []
  const followups = []
  const handles = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    connection: { requestRejection: () => undefined },
    effect(fn) { const dispose = fn(); return () => { dispose?.() } },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id, path: workspacePath, attachSession: async () => {} } : undefined),
      list: () => [{ id: 'w1', title: 'Project w1', path: workspacePath }],
    },
    agents: {
      async create(options) {
        created.push(options)
        const agent = {
          id: options.sessionId,
          inject: message => followups.push({ sessionId: options.sessionId, text: message?.content?.[0]?.text ?? '' }),
          followup: message => followups.push({ sessionId: options.sessionId, text: message?.content?.[0]?.text ?? '' }),
          cancel: () => {},
        }
        handles.set(options.sessionId, agent)
        return setupAgentHandle(options, { agent, dispose: async () => { handles.delete(options.sessionId) } })
      },
      get: id => handles.get(id),
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'primary', model: 'big' }) }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
    on(event, listener) { listeners.set(event, listener); return () => {} },
  }
  return { ctx, routes, created, followups, listeners }
}

function installFetch() {
  const previous = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url).includes('/dsh-taskboard/state')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { rev: 1, tasks: [structuredClone(TASK)] } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return () => { globalThis.fetch = previous }
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

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  return false
}

async function boot({ workspacePath }) {
  const home = await mkdtemp(join(tmpdir(), 'dab-turn-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const restoreFetch = installFetch()
  const made = makeCtx({ workspacePath })
  const dispose = apply(made.ctx, { mandate: TEST_MANDATE })
  await callJson(made.routes, 'GET', '/state')
  await callJson(made.routes, 'POST', '/mode', { mode: 'autonomous' })
  const tick = await callJson(made.routes, 'POST', '/tick', {})
  assert.equal(tick.status, 200, JSON.stringify(tick.body))
  const assignment = async () => (await callJson(made.routes, 'GET', '/state')).body.value.assignments[0]
  const emit = (sessionId, reason) => made.listeners.get('session/event')?.({ id: sessionId }, { type: 'turn/end', time: Date.now(), data: { reason } })
  return {
    made,
    routes: made.routes,
    assignment,
    emit,
    created: made.created,
    followups: made.followups,
    async close() {
      dispose()
      restoreFetch()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
}

test('max-tokens is continued, then escalated to the inbox — never settled done', async () => {
  const host = await boot({ workspacePath: process.cwd() })
  try {
    assert.equal(host.created.length, 1, 'the board launched one attempt')
    const sessionId = host.created[0].sessionId

    // The assignment carries the two DIFFERENT facts from the start.
    let current = await host.assignment()
    assert.equal(current.turnFinished, false)
    assert.equal(current.workVerified, false)

    // A truncated turn: no proof exists, so the host keeps the attempt alive and
    // asks for a bounded continuation instead of closing it as done.
    host.emit(sessionId, { kind: 'max-tokens' })
    assert.ok(await waitFor(async () => (await host.assignment()).continuations === 1), 'one continuation was spent')
    current = await host.assignment()
    assert.equal(current.status, 'running', 'a truncated turn leaves the work in progress')
    assert.equal(current.workVerified, false)
    assert.equal(current.outcomeKind, 'needs_continuation')
    assert.ok(host.followups.some(entry => entry.sessionId === sessionId && /TRUNCATED/.test(entry.text)), 'the continuation prompt was sent')

    // Each further truncation spends one unit of the bounded budget.
    for (let attempt = 2; attempt <= MAX_CONTINUATIONS; attempt += 1) {
      host.emit(sessionId, { kind: 'max-tokens' })
      assert.ok(await waitFor(async () => (await host.assignment()).continuations === attempt), `continuation ${attempt}`)
    }
    // Budget exhausted: the attempt stops and a human is asked, through the inbox.
    host.emit(sessionId, { kind: 'max-tokens' })
    assert.ok(await waitFor(async () => (await host.assignment()).status === 'failed'), 'an exhausted budget fails the attempt')
    current = await host.assignment()
    assert.equal(current.workVerified, false, 'a failed attempt never claims verified work')
    assert.equal(current.outcomeKind, 'failed')
    assert.match(current.error, /continuations_exhausted/)
    assert.equal(current.needsHuman, true)

    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    const pending = state.superagent.decisions.pending
    assert.ok(pending.some(entry => /not verified/i.test(entry.title)), JSON.stringify(pending))
    assert.equal(state.audit.filter(entry => entry.type === 'turn_done').length, 0, 'nothing was settled as done')
  } finally {
    await host.close()
  }
})

test('a completed turn without any proof is not done', async () => {
  // A plain directory: no repository to commit in, no structured report.
  const workspace = await mkdtemp(join(tmpdir(), 'dab-nogit-'))
  const host = await boot({ workspacePath: workspace })
  try {
    const sessionId = host.created[0].sessionId
    host.emit(sessionId, { kind: 'completed' })
    assert.ok(await waitFor(async () => (await host.assignment()).continuations === 1), 'a bare completion is continued')
    const current = await host.assignment()
    assert.notEqual(current.status, 'done', 'a bare completion must never settle done')
    assert.equal(current.workVerified, false)
    assert.equal(current.outcomeKind, 'needs_continuation')
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(state.audit.filter(entry => entry.type === 'turn_done').length, 0)
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a real commit during the attempt is the proof that settles done', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dab-git-'))
  const git = args => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: workspace, stdio: 'ignore' })
  execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' })
  await writeFile(join(workspace, 'README.md'), '# fixture\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'initial'])
  const host = await boot({ workspacePath: workspace })
  try {
    const launched = await host.assignment()
    assert.equal(typeof launched.startHead, 'string', 'the launch recorded the HEAD baseline')
    const sessionId = host.created[0].sessionId
    // The agent really commits during the attempt.
    await writeFile(join(workspace, 'work.txt'), 'done\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'work'])
    host.emit(sessionId, { kind: 'completed' })
    assert.ok(await waitFor(async () => (await host.assignment()).status === 'done'), 'a new commit settles the attempt done')
    const settled = await host.assignment()
    assert.equal(settled.workVerified, true)
    assert.equal(settled.outcomeKind, 'verified_done')
    assert.equal(settled.evidence.kind, 'commit')
    assert.equal(settled.turnFinished, true)
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.equal(state.audit.filter(entry => entry.type === 'turn_done').length, 1)
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('an operator reopen puts a settled item back in the dispatchable pool', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dab-reopen-'))
  const git = args => execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: workspace, stdio: 'ignore' })
  execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore' })
  await writeFile(join(workspace, 'README.md'), '# fixture\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'initial'])
  const host = await boot({ workspacePath: workspace })
  try {
    const sessionId = host.created[0].sessionId
    await writeFile(join(workspace, 'work.txt'), 'done\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'work'])
    host.emit(sessionId, { kind: 'completed' })
    assert.ok(await waitFor(async () => (await host.assignment()).status === 'done'))
    const settled = await host.assignment()
    const item = { id: settled.taskId, projectId: 'w1', fingerprint: 'wf-x' }
    // The journal proves completion for the SAME revision fingerprint.
    const verifiedJournal = [{ ...settled, workSource: { fingerprint: 'wf-x' } }]
    assert.equal(workItemReadinessOf(item, { assignments: verifiedJournal, now: Date.now() }).reason, 'work_item_completed')

    const noReason = await callJson(host.routes, 'POST', `/assignments/${settled.id}/reopen`, {})
    assert.equal(noReason.status, 400)
    assert.equal(noReason.body.error, 'reason_required')

    const reopened = await callJson(host.routes, 'POST', `/assignments/${settled.id}/reopen`, { reason: 'the fix was reverted upstream' })
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body))
    assert.equal(typeof reopened.body.value.reopenedAt, 'number')
    assert.equal(reopened.body.value.workVerified, false)
    const state = (await callJson(host.routes, 'GET', '/state')).body.value
    assert.ok(state.audit.some(entry => entry.type === 'assignment_reopened' && /reverted/.test(entry.reason)))

    // The same journal entry no longer proves completion: the item is dispatchable.
    const after = await host.assignment()
    const readiness = workItemReadinessOf(item, { assignments: [{ ...after, workSource: { fingerprint: 'wf-x' } }], now: Date.now() })
    assert.equal(readiness.ready, true, readiness.reason)
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
