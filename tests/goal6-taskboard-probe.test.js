/**
 * GOAL 6 — Task Board public-v1 probe, against a REAL HTTP surface.
 *
 * The host must call the documented API with the configured Bearer token,
 * publish exact capabilities, and never leak the token. A disabled surface is
 * reported honestly (503 public_api_disabled), never faked as available.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../src/host/index.js'

const TOKEN = 'tb-public-token-for-tests'

function startPublicApi({ token = TOKEN, disabled = false } = {}) {
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (disabled) return send(503, { ok: false, error: { code: 'public_api_disabled', message: 'disabled' } })
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${token}`) return send(401, { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } })
    const url = new URL(req.url, 'http://local')
    if (url.pathname.endsWith('/meta')) {
      return send(200, {
        ok: true,
        value: {
          apiVersion: 1,
          name: 'dsh-taskboard',
          version: '0.12.0',
          auth: 'bearer',
          donePolicy: 'user-only',
          features: { claim: true, attempts: true, handoff: true, events: true, report: true },
        },
      })
    }
    if (url.pathname.endsWith('/projects')) return send(200, { ok: true, value: [{ id: 'w1', title: 'Projet', path: 'D:/p' }] })
    if (url.pathname.endsWith('/tasks')) return send(200, { ok: true, value: { tasks: [{ id: 't1' }, { id: 't2' }], next: null } })
    return send(404, { ok: false, error: { code: 'not_found', message: 'not found' } })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/dsh-taskboard/public/v1`, close: () => new Promise(done => server.close(done)) }))
  })
}

function makeCtx() {
  const routes = new Map()
  return {
    routes,
    ctx: {
      logger: { warn() {}, info() {}, error() {} },
      webServer: { getOrigin: () => 'http://127.0.0.1:1', register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
      connection: { requestRejection: () => undefined },
      effect(fn) { const dispose = fn(); return () => { dispose?.() } },
      workspaceRegistry: { get: () => undefined, list: () => [] },
      agents: { async create() { throw new Error('not used') }, get: () => undefined },
      get: () => undefined,
      on: () => () => {},
    },
  }
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
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body), raw: res.body }
}

async function withHost(options, run) {
  if (typeof options === 'function') { run = options; options = {} }
  const home = await mkdtemp(join(tmpdir(), 'dab-tbprobe-'))
  const previousHome = process.env.DSH_HOME
  const previousToken = process.env.DSH_TASKBOARD_PUBLIC_TOKEN
  const previousUrl = process.env.DSH_TASKBOARD_PUBLIC_URL
  if (options.token !== undefined) process.env.DSH_TASKBOARD_PUBLIC_TOKEN = options.token
  if (options.url !== undefined) process.env.DSH_TASKBOARD_PUBLIC_URL = options.url
  process.env.DSH_HOME = home
  const made = makeCtx()
  const dispose = apply(made.ctx)
  try {
    await callJson(made.routes, 'GET', '/state')
    await run({ ...made, home })
  } finally {
    dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousToken === undefined) delete process.env.DSH_TASKBOARD_PUBLIC_TOKEN
    else process.env.DSH_TASKBOARD_PUBLIC_TOKEN = previousToken
    if (previousUrl === undefined) delete process.env.DSH_TASKBOARD_PUBLIC_URL
    else process.env.DSH_TASKBOARD_PUBLIC_URL = previousUrl
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('a configured public API is probed for real: capabilities published, token never leaked', async () => {
  const api = await startPublicApi()
  try {
    await withHost({ token: TOKEN, url: api.url }, async ({ routes }) => {
      const probe = await callJson(routes, 'POST', '/integrations/taskboard/probe')
      assert.equal(probe.status, 200, JSON.stringify(probe.body))
      assert.equal(probe.body.value.configured, true)
      assert.equal(probe.body.value.reachable, true)
      assert.equal(probe.body.value.version, '0.12.0')
      assert.equal(probe.body.value.projects, 1)
      assert.equal(probe.body.value.tasksSample, 2)
      assert.equal(probe.body.value.capabilities.claim.state, 'available')
      assert.equal(probe.body.value.capabilities.attempt.state, 'available')
      assert.equal(probe.body.value.capabilities.handoff.state, 'available')

      const state = await callJson(routes, 'GET', '/state')
      assert.equal(state.raw.includes(TOKEN), false, 'the token must never appear in the published state')
      assert.equal(state.body.value.host.taskboardPublic.configured, true)
      assert.equal(state.body.value.host.taskboardPublic.reachable, true)
    })
  } finally {
    await api.close()
  }
})

test('a disabled public API is reported as disabled, never as available', async () => {
  const api = await startPublicApi({ disabled: true })
  try {
    await withHost({ token: TOKEN, url: api.url }, async ({ routes }) => {
      const probe = await callJson(routes, 'POST', '/integrations/taskboard/probe')
      assert.equal(probe.status, 200)
      assert.equal(probe.body.value.configured, true)
      assert.equal(probe.body.value.reachable, false)
      assert.equal(probe.body.value.reason, 'public_api_disabled')
      assert.equal(probe.body.value.capabilities, null)
    })
  } finally {
    await api.close()
  }
})

test('without a token the probe refuses to call the network and says why', async () => {
  await withHost(async ({ routes }) => {
    const probe = await callJson(routes, 'POST', '/integrations/taskboard/probe')
    assert.equal(probe.status, 200)
    assert.equal(probe.body.value.configured, false)
    assert.equal(probe.body.value.reason, 'token_not_configured')
    const diagnostics = await callJson(routes, 'GET', '/diagnostics')
    assert.equal(diagnostics.status, 200)
    assert.equal(diagnostics.body.value.taskboard.public.configured, false)
    assert.equal(diagnostics.body.value.taskboard.public.reason, 'token_not_configured')
  })
})
