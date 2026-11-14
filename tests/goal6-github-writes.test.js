import { setupAgentHandle } from './fixtures/secure-agent-context.js'
/**
 * GOAL 6 — GitHub forge write path (opt-in) and host gating.
 *
 * The forge has no idempotency key: this build embeds a marker, so a retry
 * returns the SAME issue/comment/PR. Writes are behind two walls — the adapter
 * opt-in and the operator mandate — and no merge/delete capability exists.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'
import { createGithubAdapter } from '../src/connectors/github.js'

const TOKEN = 'ghp_test_secret_token_value'

function installFakeGithub() {
  const previous = globalThis.fetch
  const state = { issues: [], comments: new Map(), pulls: [], nextNumber: 1, calls: [] }
  const json = (status, value) => ({ ok: status < 400, status, json: async () => value })
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? 'GET'
    state.calls.push({ method, url: target, body: init.body ? JSON.parse(init.body) : null })
    const auth = init.headers?.authorization
    assert.equal(auth, `Bearer ${TOKEN}`, 'the adapter must send the token as a Bearer header')
    const u = new URL(target)
    const path = u.pathname
    if (method === 'GET' && path === '/repos/o/r/issues') {
      // Dedupe reads all (open/closed) issues.
      return json(200, state.issues)
    }
    if (method === 'POST' && path === '/repos/o/r/issues') {
      const body = JSON.parse(init.body)
      const issue = { number: state.nextNumber++, title: body.title, body: body.body, state: 'open', labels: (body.labels ?? []).map(name => ({ name })), html_url: `https://example.test/issues/${state.nextNumber - 1}`, updated_at: '2026-01-01T00:00:00Z' }
      state.issues.unshift(issue)
      return json(201, issue)
    }
    const commentMatch = path.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/)
    if (commentMatch !== null) {
      const number = commentMatch[1]
      const list = state.comments.get(number) ?? []
      if (method === 'GET') return json(200, list)
      if (method === 'POST') {
        const body = JSON.parse(init.body)
        const comment = { id: `c-${list.length + 1}`, body: body.body, html_url: `https://example.test/comments/${list.length + 1}` }
        list.push(comment)
        state.comments.set(number, list)
        return json(201, comment)
      }
    }
    if (method === 'GET' && path === '/repos/o/r/pulls') {
      const head = u.searchParams.get('head') ?? ''
      const branch = head.includes(':') ? head.split(':')[1] : head
      return json(200, state.pulls.filter(pull => pull.head.ref === branch))
    }
    if (method === 'POST' && path === '/repos/o/r/pulls') {
      const body = JSON.parse(init.body)
      const pull = { number: state.nextNumber++, title: body.title, body: body.body ?? '', state: 'open', html_url: `https://example.test/pull/${state.nextNumber - 1}`, head: { ref: body.head }, base: { ref: body.base }, updated_at: '2026-01-01T00:00:00Z' }
      state.pulls.push(pull)
      return json(201, pull)
    }
    if (method === 'GET' && /^\/repos\/o\/r\/commits\/[^/]+\/check-runs$/.test(path)) {
      return json(200, { check_runs: [{ name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://example.test/check/1' }] })
    }
    return json(404, { message: 'not found' })
  }
  return { state, restore: () => { globalThis.fetch = previous } }
}

test('adapter writes are opt-in, idempotent and never expose the token', async () => {
  const fake = installFakeGithub()
  try {
    const readOnly = createGithubAdapter({ repository: 'o/r', token: TOKEN, allowWrites: false })
    assert.equal(readOnly.describe().capabilities.create, false)
    await assert.rejects(() => readOnly.createIssue({ title: 'x' }, { idempotencyKey: 'k1' }), error => error.code === 'writes_disabled')

    const adapter = createGithubAdapter({ repository: 'o/r', token: TOKEN, allowWrites: true })
    const described = adapter.describe()
    assert.equal(described.capabilities.create, true)
    assert.equal(described.capabilities.comment, true)
    assert.equal(described.capabilities.open_pr, true)
    assert.equal(described.capabilities.merge, false, 'this build never merges')

    const first = await adapter.createIssue({ title: 'E2E', body: 'contexte' }, { idempotencyKey: 'k1' })
    assert.equal(first.created, true)
    const duplicate = await adapter.createIssue({ title: 'E2E', body: 'contexte' }, { idempotencyKey: 'k1' })
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.issue.id, first.issue.id)
    assert.equal(fake.state.issues.length, 1, 'a retry must not open a duplicate issue')
    assert.match(fake.state.issues[0].body, /<!-- agent-board:id:k1 -->/)

    const comment = await adapter.commentIssue(first.issue.id, 'preuve', { idempotencyKey: 'c1' })
    assert.equal(comment.created, true)
    const duplicateComment = await adapter.commentIssue(first.issue.id, 'preuve', { idempotencyKey: 'c1' })
    assert.equal(duplicateComment.created, false)

    const pr = await adapter.openPullRequest({ title: 'PR', head: 'feat/x', base: 'dev' }, { idempotencyKey: 'pr1' })
    assert.equal(pr.created, true)
    const duplicatePr = await adapter.openPullRequest({ title: 'PR', head: 'feat/x', base: 'dev' }, { idempotencyKey: 'pr1' })
    assert.equal(duplicatePr.created, false)
    assert.equal(fake.state.pulls.length, 1)

    const checks = await adapter.checks('feat/x')
    assert.equal(checks.total, 1)
    assert.equal(checks.runs[0].conclusion, 'success')

    const invalid = await adapter.createIssue({ title: 'x' }, {}).catch(error => error)
    assert.equal(invalid.code, 'invalid_input')
    const serialized = JSON.stringify({ described, first, duplicate, comment, duplicateComment, pr, duplicatePr, checks, invalid: String(invalid.message) })
    assert.equal(serialized.includes(TOKEN), false, 'the token must never appear in any returned value')
  } finally {
    fake.restore()
  }
})

test('an immediate retry survives an eventually-consistent issue list (in-process cache)', async () => {
  const previous = globalThis.fetch
  let created = 0
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    if (method === 'GET') return { ok: true, status: 200, json: async () => [] } // the list never shows the new issue yet
    created += 1
    const body = JSON.parse(init.body)
    return { ok: true, status: 201, json: async () => ({ number: 42, title: body.title, body: body.body, state: 'open', html_url: 'https://x/42' }) }
  }
  try {
    const adapter = createGithubAdapter({ repository: 'o/r', token: TOKEN, allowWrites: true })
    const first = await adapter.createIssue({ title: 'x' }, { idempotencyKey: 'k' })
    const second = await adapter.createIssue({ title: 'x' }, { idempotencyKey: 'k' })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.issue.id, first.issue.id)
    assert.equal(created, 1, 'the in-process cache prevents a duplicate even when the list lags')
  } finally {
    globalThis.fetch = previous
  }
})


test('concurrent retries share one request; hostile keys are rejected; the PR body carries a marker', async () => {
  const previous = globalThis.fetch
  let posts = 0
  const store = { pulls: [] }
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const path = new URL(String(url)).pathname
    if (method === 'GET' && path === '/repos/o/r/issues') return { ok: true, status: 200, json: async () => [] }
    if (method === 'GET' && path === '/search/issues') return { ok: false, status: 422, json: async () => ({ message: 'search unavailable' }) }
    if (method === 'GET' && path === '/repos/o/r/pulls') return { ok: true, status: 200, json: async () => store.pulls }
    if (method === 'POST' && path === '/repos/o/r/issues') {
      posts += 1
      const body = JSON.parse(init.body)
      return { ok: true, status: 201, json: async () => ({ number: posts, title: body.title, body: body.body, state: 'open', html_url: `https://x/${posts}` }) }
    }
    if (method === 'POST' && path === '/repos/o/r/pulls') {
      posts += 1
      const body = JSON.parse(init.body)
      const pull = { number: posts, title: body.title, body: body.body, state: 'open', html_url: `https://x/pull/${posts}`, head: { ref: body.head }, base: { ref: body.base }, updated_at: '2026-01-01T00:00:00Z' }
      store.pulls.push(pull)
      return { ok: true, status: 201, json: async () => pull }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  try {
    const adapter = createGithubAdapter({ repository: 'o/r', token: TOKEN, allowWrites: true })
    const [a, b] = await Promise.all([
      adapter.createIssue({ title: 'concurrent' }, { idempotencyKey: 'race-1' }),
      adapter.createIssue({ title: 'concurrent' }, { idempotencyKey: 'race-1' }),
    ])
    assert.equal(posts, 1, 'two concurrent calls with the same key must issue ONE POST')
    assert.equal(a.created, true)
    assert.equal(b.created, false)
    assert.equal(a.issue.id, b.issue.id)

    const hostile = await adapter.createIssue({ title: 'x' }, { idempotencyKey: 'k --> <b>x</b> <!-- agent-board:id:other' }).catch(error => error)
    assert.equal(hostile.code, 'invalid_input', 'a key that could forge a second marker is refused')

    const [pr1, pr2] = await Promise.all([
      adapter.openPullRequest({ title: 'PR', head: 'feat/race', base: 'dev' }, { idempotencyKey: 'pr-race' }),
      adapter.openPullRequest({ title: 'PR', head: 'feat/race', base: 'dev' }, { idempotencyKey: 'pr-race' }),
    ])
    assert.equal(store.pulls.length, 1, 'two concurrent PR calls for the same head open one PR')
    assert.equal(pr1.pull.id, pr2.pull.id)
    assert.match(store.pulls[0].body, /<!-- agent-board:id:pr-race -->/)
  } finally {
    globalThis.fetch = previous
  }
})

function makeCtx() {
  const routes = new Map()
  const created = []
  return {
    routes,
    ctx: {
      logger: { warn() {}, info() {}, error() {} },
      webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
      connection: { requestRejection: () => undefined },
      effect(fn) { const dispose = fn(); return () => { dispose?.() } },
      workspaceRegistry: {
        get: id => (id === 'w1' ? { id, path: process.cwd(), attachSession: async () => {} } : undefined),
        list: () => [{ id: 'w1', title: 'w1', path: process.cwd() }],
      },
      agents: { async create(options) { created.push(options); return setupAgentHandle(options, { agent: { id: options.sessionId, followup() {}, inject() {}, cancel() {} }, dispose: async () => {} }) }, get: () => undefined },
      get: () => undefined,
      on: () => () => {},
    },
    created,
  }
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

test('host gates forge writes behind the explicit opt-in and the mandate, and is idempotent', async () => {
  const fake = installFakeGithub()
  const home = await mkdtemp(join(tmpdir(), 'dab-forge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = TOKEN
  const made = makeCtx()
  let dispose = null
  try {
    dispose = apply(made.ctx, {
      githubRepository: 'o/r',
      allowGithubWrites: true,
      mandate: {
        scopeMode: 'selected',
        selectedWorkspaces: ['w1'],
        level: 'L3',
        actions: { comment: true, create_task: true },
        projects: { w1: { enabled: true } },
        requiresConfiguration: false,
      },
    })
    await callJson(made.routes, 'GET', '/state')
    await callJson(made.routes, 'POST', '/mode', { mode: 'autonomous' })
    const state = (await callJson(made.routes, 'GET', '/state')).body.value
    // Super Agent capabilities describe its actual executor, not the separate manual forge API.
    assert.equal(state.capabilities.create_task.state, 'unavailable', JSON.stringify(state.capabilities.create_task))
    assert.equal(state.capabilities.create_task.reason, 'taskboard_writes_unavailable')
    assert.equal(state.capabilities.open_pr.state, 'unavailable')
    assert.equal(state.capabilities.open_pr.reason, 'level_too_low')
    assert.equal(state.capabilities.open_pr.implemented, true)

    const created = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w1', title: 'Issue réelle (test)', body: 'corps', idempotencyKey: 'host-1' })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.value.created, true)
    const duplicate = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w1', title: 'Issue réelle (test)', body: 'corps', idempotencyKey: 'host-1' })
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.body.value.created, false)
    assert.equal(fake.state.issues.length, 1)

    const comment = await callJson(made.routes, 'POST', `/forge/issue/${created.body.value.issue.id}/comment`, { projectId: 'w1', body: 'suivi', idempotencyKey: 'host-c1' })
    assert.equal(comment.status, 201, JSON.stringify(comment.body))

    // A project outside the scope must be refused even though the action is granted.
    const outside = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w2', title: 'nope', idempotencyKey: 'host-2' })
    assert.equal(outside.status, 409)
    assert.equal(outside.body.error, 'project_not_selected')

    // open_pr needs L4 + the explicit action grant.
    const prRefused = await callJson(made.routes, 'POST', '/forge/pr', { projectId: 'w1', title: 'PR', head: 'feat/x', base: 'dev' })
    assert.equal(prRefused.status, 409)
    assert.equal(prRefused.body.error, 'level_too_low')

    // Raise the ceiling and grant the action: opening a PR becomes possible, and
    // a retry returns the SAME pull request.
    const mandate = await callJson(made.routes, 'POST', '/mandate', { mandate: { level: 'L4', actions: { open_pr: true } } })
    assert.equal(mandate.status, 200, JSON.stringify(mandate.body))
    const opened = await callJson(made.routes, 'POST', '/forge/pr', { projectId: 'w1', title: 'PR', head: 'feat/x', base: 'dev' })
    assert.equal(opened.status, 201, JSON.stringify(opened.body))
    assert.equal(opened.body.value.created, true)
    const reopened = await callJson(made.routes, 'POST', '/forge/pr', { projectId: 'w1', title: 'PR', head: 'feat/x', base: 'dev' })
    assert.equal(reopened.status, 200)
    assert.equal(reopened.body.value.created, false)
    assert.equal(fake.state.pulls.length, 1)
  } finally {
    if (dispose !== null) dispose()
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousToken
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fake.restore()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('without the adapter opt-in the host refuses every forge write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dab-forge-off-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const made = makeCtx()
  let dispose = null
  try {
    dispose = apply(made.ctx, {
      githubRepository: 'o/r',
      mandate: {
        scopeMode: 'selected',
        selectedWorkspaces: ['w1'],
        level: 'L4',
        actions: { create_task: true, comment: true, open_pr: true },
        projects: { w1: { enabled: true } },
        requiresConfiguration: false,
      },
    })
    await callJson(made.routes, 'GET', '/state')
    await callJson(made.routes, 'POST', '/mode', { mode: 'autonomous' })
    const state = (await callJson(made.routes, 'GET', '/state')).body.value
    assert.equal(state.capabilities.create_task.reason, 'taskboard_writes_unavailable')
    assert.equal(state.capabilities.create_task.state, 'unavailable')
    const refused = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w1', title: 'x', idempotencyKey: 'k' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error, 'github_writes_disabled')
  } finally {
    if (dispose !== null) dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
test('forge idempotency keys are namespaced by project AND object type', async () => {
  const fake = installFakeGithub()
  const home = await mkdtemp(join(tmpdir(), 'dab-forge-ns-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const previousToken = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = TOKEN
  const made = makeCtx()
  let dispose = null
  try {
    dispose = apply(made.ctx, {
      githubRepository: 'o/r',
      allowGithubWrites: true,
      mandate: {
        scopeMode: 'selected',
        selectedWorkspaces: ['w1', 'w2'],
        level: 'L4',
        actions: { create_task: true, comment: true, open_pr: true },
        projects: { w1: { enabled: true }, w2: { enabled: true } },
        requiresConfiguration: false,
      },
    })
    await callJson(made.routes, 'GET', '/state')
    await callJson(made.routes, 'POST', '/mode', { mode: 'autonomous' })

    // Same caller key, two projects => two distinct issues.
    const first = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w1', title: 'w1 issue', idempotencyKey: 'shared' })
    const second = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w2', title: 'w2 issue', idempotencyKey: 'shared' })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(second.status, 201, JSON.stringify(second.body))
    assert.notEqual(first.body.value.issue.id, second.body.value.issue.id)
    assert.equal(fake.state.issues.length, 2)

    // Same caller key, another object type => a different marker, no cross-match.
    const pr = await callJson(made.routes, 'POST', '/forge/pr', { projectId: 'w1', title: 'PR', head: 'feat/ns', base: 'dev', idempotencyKey: 'shared' })
    assert.equal(pr.status, 201, JSON.stringify(pr.body))
    assert.match(fake.state.pulls[0].body, /<!-- agent-board:id:w1:pr:shared -->/)
    const firstIssueRow = fake.state.issues.find(entry => String(entry.number) === first.body.value.issue.id)
    assert.match(firstIssueRow.body, /<!-- agent-board:id:w1:issue:shared -->/)
    const issueAgain = await callJson(made.routes, 'POST', '/forge/issue', { projectId: 'w1', title: 'retry', idempotencyKey: 'shared' })
    assert.equal(issueAgain.status, 200)
    assert.equal(issueAgain.body.value.issue.id, first.body.value.issue.id, 'the issue key never matches the PR object')
    assert.equal(fake.state.issues.length, 2)

    // Comment: deterministic key from taskId, and a hard 400 without any key.
    const c1 = await callJson(made.routes, 'POST', `/forge/issue/${first.body.value.issue.id}/comment`, { projectId: 'w1', taskId: 't-9', body: 'même clé' })
    const c2 = await callJson(made.routes, 'POST', `/forge/issue/${first.body.value.issue.id}/comment`, { projectId: 'w1', taskId: 't-9', body: 'même clé' })
    assert.equal(c1.status, 201, JSON.stringify(c1.body))
    assert.equal(c2.status, 200)
    assert.equal(c2.body.value.comment.id, c1.body.value.comment.id, 'a retry without a key but with the same taskId is the same comment')
    assert.equal((fake.state.comments.get(String(first.body.value.issue.id)) ?? []).length, 1)
    const noKey = await callJson(made.routes, 'POST', `/forge/issue/${first.body.value.issue.id}/comment`, { projectId: 'w1', body: 'sans clé' })
    assert.equal(noKey.status, 400)
    assert.equal(noKey.body.error, 'idempotencyKey_required')
  } finally {
    if (dispose !== null) dispose()
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousToken
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fake.restore()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
