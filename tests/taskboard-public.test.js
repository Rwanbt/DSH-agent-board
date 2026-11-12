/**
 * Contract tests for `src/connectors/taskboard-public.js`.
 *
 * The fixture is an in-process `node:http` server that implements the REAL
 * Task Board 0.12.0 public API v1 (routes, bearer auth, envelopes, claim
 * idempotency, fencing, dependency refusal). It is NOT the live host: the
 * running Task Board has no token configured, so the authenticated surface
 * cannot be probed live (see docs/TASKBOARD-PUBLIC-V1-AUDIT.md).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  CAPABILITY_STATES,
  PUBLIC_API_BASE_PATH,
  PUBLIC_API_OPERATIONS,
  capabilitiesOf,
  createPublicTaskBoardClient,
  describePublicTaskBoard,
} from '../src/connectors/taskboard-public.js'

const TOKEN = 'tb-public-test-token-6f1d'
const ACTOR = 'agent-board:test-worker'

const META = {
  apiVersion: 1,
  name: 'dsh-taskboard',
  eventTypes: ['task.created', 'task.updated', 'task.claimed', 'execution.started', 'execution.completed', 'task.in_review'],
  auth: 'bearer',
  writePolicy: 'explicit',
  donePolicy: 'user-only',
  features: { claim: true, attempts: true, handoff: true, reports: true, events: 'replay+resync', worktree: true, externalSync: true },
  taskStatuses: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived'],
}

const TASK_FIXTURES = [
  { id: 't-1', title: 'Task one', status: 'todo', workspaceId: 'ws-1', version: 3 },
  { id: 't-2', title: 'Task two', status: 'todo', workspaceId: 'ws-1', version: 2 },
  { id: 't-3', title: 'Task three', status: 'todo', workspaceId: 'ws-1', version: 2 },
  { id: 't-4', title: 'Task four', status: 'todo', workspaceId: 'ws-1', version: 1 },
  { id: 't-dep', title: 'Prerequisite', status: 'todo', workspaceId: 'ws-1', version: 1 },
  { id: 't-blocked', title: 'Blocked work', status: 'todo', workspaceId: 'ws-1', version: 1, dependsOn: ['t-dep'] },
]

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function sendRaw(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function failureMessage(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function taskSummary(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    urgency: 'normal',
    workspaceId: task.workspaceId,
    version: task.version,
    blocked: task.blocked === true,
    executionMode: 'claim',
    checklist: { total: 0, checked: 0 },
  }
}

function executionView(task, execution) {
  return {
    executionId: execution.id,
    taskId: task.id,
    workspaceId: task.workspaceId,
    attempt: execution.attempt,
    outcome: execution.outcome,
    trigger: 'manual',
    managedBy: 'external',
    fencingToken: execution.fencingToken,
    ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
    sessions: [...execution.sessions],
    attempts: execution.attempts.map(attempt => ({ ...attempt })),
    startedAt: execution.startedAt,
    ...(execution.endedAt === undefined ? {} : { endedAt: execution.endedAt }),
    ...(execution.report === undefined ? {} : { report: execution.report }),
    taskVersion: task.version,
  }
}

function dependencyView(task, tasks) {
  const details = (task.dependsOn ?? []).map(id => {
    const dependency = tasks.get(id)
    if (dependency === undefined) return { id, state: 'missing' }
    return {
      id,
      title: dependency.title,
      status: dependency.status,
      state: dependency.status === 'done' ? 'done' : 'pending',
    }
  })
  const pendingIds = details.filter(detail => detail.state === 'pending').map(detail => detail.id)
  const missingIds = details.filter(detail => detail.state === 'missing').map(detail => detail.id)
  return {
    taskId: task.id,
    total: details.length,
    completed: details.filter(detail => detail.state === 'done').length,
    pendingIds,
    missingIds,
    ready: pendingIds.length === 0 && missingIds.length === 0,
    details,
  }
}

/**
 * Start a fake Task Board public API v1.
 * @param {{token?: string, disabled?: boolean}} [options]
 */
async function startFakeTaskBoard(options = {}) {
  const token = options.token ?? TOKEN
  const disabled = options.disabled === true
  const tasks = new Map()
  for (const fixture of TASK_FIXTURES) {
    tasks.set(fixture.id, { ...fixture, executions: [], blocked: fixture.blocked === true })
  }
  const requests = []
  let nextExecution = 1

  function findExecution(executionId) {
    for (const task of tasks.values()) {
      const execution = task.executions.find(candidate => candidate.id === executionId)
      if (execution !== undefined) return { task, execution }
    }
    return null
  }

  function fencesOk(execution, body) {
    if (execution.fencingToken > 1 && body.ifFencingToken === undefined) return 'missing'
    if (body.ifFencingToken !== undefined && body.ifFencingToken !== execution.fencingToken) return 'stale'
    return null
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = null
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
    }
    requests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      body,
      authorization: req.headers.authorization,
    })

    if (disabled) {
      failureMessage(res, 503, 'public_api_disabled', 'public API is disabled: configure DSH_TASKBOARD_PUBLIC_TOKEN')
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      failureMessage(res, 401, 'unauthorized', 'invalid bearer token')
      return
    }
    if (!url.pathname.startsWith(PUBLIC_API_BASE_PATH)) {
      failureMessage(res, 404, 'not_found', 'unknown public API route')
      return
    }
    const path = url.pathname.slice(PUBLIC_API_BASE_PATH.length) || '/'
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/meta') {
      sendJson(res, 200, { ok: true, value: META })
      return
    }
    if (method === 'GET' && path === '/projects') {
      sendJson(res, 200, { ok: true, value: [{ id: 'ws-1', title: 'Workspace one', path: 'D:\\ws-1' }] })
      return
    }
    if (method === 'GET' && path === '/events') {
      sendJson(res, 200, {
        ok: true,
        value: {
          events: [{ id: 'evt_1', seq: 1, type: 'task.created', at: 1, provenance: 'taskboard', taskId: 't-1', taskVersion: 1, status: 'todo', workspaceId: 'ws-1' }],
          oldestSeq: 1,
          latestSeq: 1,
          resync: false,
        },
      })
      return
    }
    if (method === 'GET' && path === '/tasks') {
      const limit = Math.max(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1)
      const offset = Math.max(Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0, 0)
      const live = [...tasks.values()]
      const page = live.slice(offset, offset + limit).map(taskSummary)
      const value = { tasks: page }
      if (offset + limit < live.length) value.next = String(offset + limit)
      sendJson(res, 200, { ok: true, value })
      return
    }
    if (method === 'GET' && path === '/executions/claim') {
      failureMessage(res, 404, 'not_found', 'no such execution')
      return
    }

    const taskRoute = /^\/tasks\/([^/]+)$/.exec(path)
    if (method === 'GET' && taskRoute !== null) {
      const id = decodeURIComponent(taskRoute[1])
      if (id === 't-malformed') {
        sendRaw(res, 200, 'this is not json')
        return
      }
      if (id === 't-internal') {
        failureMessage(res, 500, 'internal', 'internal error')
        return
      }
      if (id === 't-unknown-code') {
        failureMessage(res, 400, 'mystery_code', 'unknown code from a newer server')
        return
      }
      if (id === 't-soft-error') {
        failureMessage(res, 200, 'forbidden', 'soft refused')
        return
      }
      if (id === 't-slow') {
        const timer = setTimeout(() => {
          if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { ok: true, value: taskSummary({ id: 't-slow', title: 'Slow', status: 'todo', workspaceId: 'ws-1', version: 1 }) })
        }, 300)
        timer.unref?.()
        return
      }
      if (id === 't-slow-body') {
        // Headers arrive, then the body stalls: still a timeout, not a
        // bad_response.
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.write('{"ok":true,')
        const timer = setTimeout(() => {
          if (!res.destroyed && !res.writableEnded) res.end('"value":{}}')
        }, 300)
        timer.unref?.()
        return
      }
      const task = tasks.get(id)
      if (task === undefined) {
        failureMessage(res, 404, 'not_found', 'no such task')
        return
      }
      sendJson(res, 200, { ok: true, value: { ...taskSummary(task), description: task.description ?? '', prompt: '', createdAt: 1, updatedAt: 1, executions: [], dependencies: dependencyView(task, tasks), allowedActions: [] } })
      return
    }

    const dependencyRoute = /^\/tasks\/([^/]+)\/dependencies$/.exec(path)
    if (method === 'GET' && dependencyRoute !== null) {
      const task = tasks.get(decodeURIComponent(dependencyRoute[1]))
      if (task === undefined) {
        failureMessage(res, 404, 'not_found', 'no such task')
        return
      }
      sendJson(res, 200, { ok: true, value: dependencyView(task, tasks) })
      return
    }

    const executionRoute = /^\/executions\/([^/]+)$/.exec(path)
    if (method === 'GET' && executionRoute !== null) {
      const found = findExecution(decodeURIComponent(executionRoute[1]))
      if (found === null) {
        failureMessage(res, 404, 'not_found', 'no such execution')
        return
      }
      sendJson(res, 200, { ok: true, value: executionView(found.task, found.execution) })
      return
    }

    if (method === 'POST' && path === '/executions/claim') {
      if (body === null || typeof body.taskId !== 'string' || typeof body.actor !== 'string') {
        failureMessage(res, 400, 'invalid_input', 'taskId and actor are required')
        return
      }
      if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey === '') {
        failureMessage(res, 400, 'invalid_input', 'idempotencyKey is required')
        return
      }
      const task = tasks.get(body.taskId)
      if (task === undefined) {
        failureMessage(res, 404, 'not_found', 'no such task')
        return
      }
      if (body.workspaceId !== undefined && body.workspaceId !== task.workspaceId) {
        failureMessage(res, 403, 'forbidden', 'task belongs to another project')
        return
      }
      const replay = task.executions.find(execution => execution.idempotencyKey === body.idempotencyKey)
      if (replay !== undefined) {
        if (replay.externalActor !== body.actor) {
          failureMessage(res, 409, 'already_claimed', 'idempotency key belongs to another actor')
          return
        }
        sendJson(res, 201, { ok: true, value: { execution: executionView(task, replay), task: taskSummary(task) } })
        return
      }
      if (task.claimedBy !== undefined || task.status === 'in_progress') {
        failureMessage(res, 409, 'already_claimed', 'task is held by another actor')
        return
      }
      if (task.status !== 'todo') {
        failureMessage(res, 409, 'version_conflict', `task is ${task.status}, not todo`)
        return
      }
      if (task.blocked === true) {
        failureMessage(res, 409, 'version_conflict', 'task is blocked')
        return
      }
      const dependency = dependencyView(task, tasks)
      if (!dependency.ready) {
        failureMessage(res, 409, 'dependency_blocked', `unsatisfied dependencies: ${dependency.pendingIds.concat(dependency.missingIds).join(', ')}`)
        return
      }
      const now = Date.now()
      const execution = {
        id: `e-${nextExecution++}`,
        attempt: 1,
        outcome: 'running',
        fencingToken: 1,
        sessions: body.sessionId === undefined ? [] : [body.sessionId],
        ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        attempts: [{ n: 1, startedAt: now, outcome: 'running', ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }) }],
        startedAt: now,
        idempotencyKey: body.idempotencyKey,
        externalActor: body.actor,
      }
      task.executions.push(execution)
      task.status = 'in_progress'
      task.claimedBy = body.actor
      task.version += 1
      sendJson(res, 201, { ok: true, value: { execution: executionView(task, execution), task: taskSummary(task) } })
      return
    }

    const lifecycleRoute = /^\/executions\/([^/]+)\/(session|attempts|handoff|complete|interrupt)$/.exec(path)
    if (method === 'POST' && lifecycleRoute !== null) {
      const found = findExecution(decodeURIComponent(lifecycleRoute[1]))
      if (found === null) {
        failureMessage(res, 404, 'not_found', 'no such execution')
        return
      }
      const { task, execution } = found
      const action = lifecycleRoute[2]
      if (body === null || typeof body.actor !== 'string') {
        failureMessage(res, 400, 'invalid_input', 'actor is required')
        return
      }
      if (execution.externalActor !== body.actor) {
        failureMessage(res, 403, 'forbidden', 'only the claiming actor may change this execution')
        return
      }

      if (action === 'complete' || action === 'interrupt') {
        const outcome = action === 'interrupt' ? 'cancelled' : body.outcome
        if (!['succeeded', 'failed', 'cancelled'].includes(outcome)) {
          failureMessage(res, 400, 'invalid_input', 'outcome must be succeeded, failed or cancelled')
          return
        }
        if (execution.outcome !== 'running') {
          if (execution.outcome === outcome) {
            sendJson(res, 200, { ok: true, value: executionView(task, execution) })
            return
          }
          failureMessage(res, 409, 'version_conflict', 'execution already settled with another outcome')
          return
        }
        const fence = fencesOk(execution, body)
        if (fence !== null) {
          failureMessage(res, 409, 'stale_execution', fence === 'missing' ? 'fencing token required after a handoff or attempt change' : 'stale fencing token')
          return
        }
        execution.outcome = outcome
        execution.endedAt = Date.now()
        const attempt = execution.attempts[execution.attempts.length - 1]
        attempt.endedAt = execution.endedAt
        attempt.outcome = outcome
        if (body.report !== undefined) execution.report = body.report
        task.status = outcome === 'succeeded' ? 'in_review' : 'todo'
        delete task.claimedBy
        task.version += 1
        sendJson(res, 200, { ok: true, value: executionView(task, execution) })
        return
      }

      const fence = fencesOk(execution, body)
      if (fence !== null) {
        failureMessage(res, 409, 'stale_execution', fence === 'missing' ? 'fencing token required after a handoff or attempt change' : 'stale fencing token')
        return
      }
      if (execution.outcome !== 'running') {
        failureMessage(res, 409, 'version_conflict', 'execution already settled')
        return
      }

      if (action === 'session') {
        if (typeof body.sessionId !== 'string' || body.sessionId === '') {
          failureMessage(res, 400, 'invalid_input', 'sessionId is required')
          return
        }
        if (execution.sessionId !== undefined && execution.sessionId !== body.sessionId) {
          failureMessage(res, 409, 'version_conflict', 'execution already has a different session; use attempts or handoff')
          return
        }
        execution.sessionId = body.sessionId
        execution.attempts[execution.attempts.length - 1].sessionId = body.sessionId
        task.version += 1
        sendJson(res, 200, { ok: true, value: executionView(task, execution) })
        return
      }

      if (action === 'attempts') {
        if (typeof body.reason !== 'string' || body.reason === '') {
          failureMessage(res, 400, 'invalid_input', 'reason is required for a new attempt')
          return
        }
        const previous = execution.attempts[execution.attempts.length - 1]
        previous.endedAt = Date.now()
        previous.outcome = 'failed'
        previous.reason = body.reason
        const next = {
          n: previous.n + 1,
          startedAt: Date.now(),
          outcome: 'running',
          ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
        }
        execution.attempts.push(next)
        execution.attempt = next.n
        execution.fencingToken += 1
        if (body.sessionId === undefined) delete execution.sessionId
        else execution.sessionId = body.sessionId
        task.version += 1
        sendJson(res, 200, { ok: true, value: executionView(task, execution) })
        return
      }

      if (action === 'handoff') {
        if (typeof body.fromSessionId !== 'string' || typeof body.toSessionId !== 'string') {
          failureMessage(res, 400, 'invalid_input', 'fromSessionId and toSessionId are required')
          return
        }
        if (execution.sessionId !== body.fromSessionId) {
          failureMessage(res, 409, 'stale_execution', 'fromSessionId is not the current session')
          return
        }
        if (body.fromSessionId === body.toSessionId) {
          failureMessage(res, 400, 'invalid_input', 'handoff target equals the current session')
          return
        }
        const previous = execution.attempts[execution.attempts.length - 1]
        previous.endedAt = Date.now()
        previous.outcome = 'failed'
        previous.reason = body.reason ?? 'handoff'
        const next = { n: previous.n + 1, sessionId: body.toSessionId, startedAt: Date.now(), outcome: 'running' }
        execution.attempts.push(next)
        execution.attempt = next.n
        execution.sessionId = body.toSessionId
        execution.fencingToken += 1
        task.version += 1
        sendJson(res, 200, { ok: true, value: executionView(task, execution) })
        return
      }
    }

    failureMessage(res, 404, 'not_found', 'unknown public API route')
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.destroyed && !res.writableEnded) failureMessage(res, 500, 'internal', 'internal error')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`

  return {
    base,
    token,
    requests,
    tasks,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

function clientFor(board, overrides = {}) {
  return createPublicTaskBoardClient({ baseUrl: board.base, token: board.token, ...overrides })
}

function failureShape(result) {
  return { ok: result.ok, code: result.code, status: result.status }
}

function assertNoToken(value) {
  assert.equal(JSON.stringify(value).includes(TOKEN), false, 'a result leaked the bearer token')
}

test('describePublicTaskBoard returns only UI-safe fields', () => {
  const info = describePublicTaskBoard({ baseUrl: 'http://127.0.0.1:1234', token: TOKEN })
  assert.deepEqual(Object.keys(info).sort(), ['baseUrl', 'configured', 'tokenPresent'])
  assert.equal(info.configured, true)
  assert.equal(info.tokenPresent, true)
  assert.equal(info.baseUrl, `http://127.0.0.1:1234${PUBLIC_API_BASE_PATH}`)
  assertNoToken(info)

  const missing = describePublicTaskBoard({ baseUrl: 'http://127.0.0.1:1234' })
  assert.deepEqual(missing, {
    configured: false,
    baseUrl: `http://127.0.0.1:1234${PUBLIC_API_BASE_PATH}`,
    tokenPresent: false,
  })
  const invalid = describePublicTaskBoard({ baseUrl: 'not a url', token: TOKEN })
  assert.equal(invalid.configured, false)
  assert.equal(invalid.baseUrl, null)
  assert.equal(describePublicTaskBoard(null).configured, false)
})

test('capabilitiesOf reports per-operation capability honestly', () => {
  const caps = capabilitiesOf(META)
  for (const operation of PUBLIC_API_OPERATIONS) {
    assert.equal(caps[operation].state, CAPABILITY_STATES.available, `${operation} should be available`)
    assert.equal(caps[operation].reason, null)
  }

  const degraded = capabilitiesOf({ ...META, features: { claim: true } })
  assert.equal(degraded.claim.state, 'available')
  assert.equal(degraded.attempt.state, 'unsupported')
  assert.equal(degraded.attempt.reason, 'feature_not_announced:attempts')
  assert.equal(degraded.handoff.state, 'unsupported')
  assert.equal(degraded.events.state, 'unsupported')

  const unconfigured = capabilitiesOf(null)
  for (const operation of PUBLIC_API_OPERATIONS) {
    assert.equal(unconfigured[operation].state, 'unconfigured')
  }
  assert.equal(unconfigured.meta.reason, 'meta_unavailable')

  const future = capabilitiesOf({ ...META, apiVersion: 2 })
  assert.equal(future.claim.state, 'unsupported')
  assert.equal(future.claim.reason, 'unsupported_api_version:2')

  const unsafe = capabilitiesOf({ ...META, donePolicy: 'operator' })
  assert.equal(unsafe.claim.state, 'unsupported')
  assert.equal(unsafe.claim.reason, 'done_policy_not_user_only')
  assert.equal(unsafe.meta.state, 'available', 'reads stay available when only the done policy is wrong')

  const envelope = capabilitiesOf({ ok: true, value: META })
  assert.equal(envelope.claim.state, 'available')
})

test('read methods succeed, paginate and authenticate with the bearer token', async () => {
  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board)
    assert.equal(client.configured, true)
    assert.equal(client.baseUrl, `${board.base}${PUBLIC_API_BASE_PATH}`)
    assertNoToken(client)

    const meta = await client.meta()
    assert.equal(meta.ok, true)
    assert.equal(meta.value.name, 'dsh-taskboard')
    assertNoToken(meta)

    const projects = await client.projects()
    assert.equal(projects.ok, true)
    assert.deepEqual(projects.value.map(project => project.id), ['ws-1'])

    const first = await client.listTasks({ limit: 2 })
    assert.equal(first.value.tasks.length, 2)
    assert.equal(first.value.next, '2')
    const second = await client.listTasks({ limit: 2, cursor: first.value.next })
    assert.equal(second.value.tasks.length, 2)
    assert.equal(second.value.next, '4')
    const third = await client.listTasks({ limit: 2, cursor: '4' })
    assert.equal(third.value.tasks.length, 2)
    assert.equal(third.value.next, undefined)

    const task = await client.task('t-1')
    assert.equal(task.value.id, 't-1')

    const dependencies = await client.dependencies('t-blocked')
    assert.equal(dependencies.value.ready, false)
    assert.deepEqual(dependencies.value.pendingIds, ['t-dep'])

    const events = await client.events({ since: 0, limit: 5 })
    assert.equal(events.value.events.length, 1)
    assert.equal(events.value.resync, false)

    assert.ok(board.requests.length >= 7)
    for (const request of board.requests) assert.equal(request.authorization, `Bearer ${TOKEN}`)
    assert.ok(board.requests.some(request => request.path === `${PUBLIC_API_BASE_PATH}/tasks` && request.search.includes('limit=2')))

    const explicitBase = createPublicTaskBoardClient({ baseUrl: `${board.base}${PUBLIC_API_BASE_PATH}`, token: TOKEN })
    assert.equal((await explicitBase.meta()).ok, true)
    assert.equal(board.requests.at(-1).path, `${PUBLIC_API_BASE_PATH}/meta`)
  } finally {
    await board.close()
  }
})

test('claim is idempotent, attempts raise the fence and success settles into in_review', async () => {
  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board)
    const claimInput = {
      taskId: 't-1',
      actor: ACTOR,
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      idempotencyKey: 'claim-key-1',
    }
    const claim = await client.claim(claimInput)
    assert.equal(claim.ok, true)
    assert.equal(claim.value.task.status, 'in_progress')
    assert.equal(claim.value.execution.fencingToken, 1)
    assertNoToken(claim)
    const executionId = claim.value.execution.executionId

    const replay = await client.claim(claimInput)
    assert.equal(replay.ok, true)
    assert.equal(replay.value.execution.executionId, executionId)

    const attached = await client.attachSession(executionId, { actor: ACTOR, sessionId: 'sess-1' })
    assert.equal(attached.ok, true)
    assert.equal(attached.value.sessionId, 'sess-1')

    const execution = await client.execution(executionId)
    assert.equal(execution.value.executionId, executionId)

    const attempt = await client.attempt(executionId, { actor: ACTOR, reason: 'model failover', sessionId: 'sess-2' })
    assert.equal(attempt.ok, true)
    assert.equal(attempt.value.attempt, 2)
    assert.equal(attempt.value.fencingToken, 2)

    const handoff = await client.handoff(executionId, {
      actor: ACTOR,
      fromSessionId: 'sess-2',
      toSessionId: 'sess-3',
      reason: 'handoff',
      ifFencingToken: 2,
    })
    assert.equal(handoff.ok, true)
    assert.equal(handoff.value.attempt, 3)
    assert.equal(handoff.value.fencingToken, 3)
    assert.equal(handoff.value.sessionId, 'sess-3')

    const withoutFence = await client.complete(executionId, { actor: ACTOR, outcome: 'succeeded' })
    assert.deepEqual(failureShape(withoutFence), { ok: false, code: 'stale_execution', status: 409 })
    const staleFence = await client.complete(executionId, { actor: ACTOR, outcome: 'succeeded', ifFencingToken: 2 })
    assert.equal(staleFence.code, 'stale_execution')

    const humanOnly = await client.complete(executionId, { actor: ACTOR, outcome: 'done', ifFencingToken: 3 })
    assert.deepEqual(failureShape(humanOnly), { ok: false, code: 'invalid_input', status: 0 })

    const completed = await client.complete(executionId, {
      actor: ACTOR,
      outcome: 'succeeded',
      ifFencingToken: 3,
      comment: 'implemented',
      report: { summary: 'implemented', changedFiles: ['src/x.js'], checks: ['node --test'], artifacts: [], risk: '' },
    })
    assert.equal(completed.ok, true)
    assert.equal(completed.value.outcome, 'succeeded')
    assert.equal(completed.value.report.summary, 'implemented')
    assertNoToken(completed)

    const task = await client.task('t-1')
    assert.equal(task.value.status, 'in_review')
    assert.equal(task.value.claimedBy, undefined)
  } finally {
    await board.close()
  }
})

test('claim without an idempotency key is refused locally, before any request', async () => {
  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board)
    const before = board.requests.length
    const refused = await client.claim({ taskId: 't-1', actor: ACTOR })
    assert.deepEqual(failureShape(refused), { ok: false, code: 'invalid_input', status: 0 })
    assert.equal(board.requests.length, before)
  } finally {
    await board.close()
  }
})

test('already_claimed, dependency_blocked and unknown codes pass through faithfully', async () => {
  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board)
    const claimed = await client.claim({ taskId: 't-2', actor: ACTOR, idempotencyKey: 'claim-key-2' })
    assert.equal(claimed.ok, true)

    const otherActor = await client.claim({ taskId: 't-2', actor: 'agent-board:intruder', idempotencyKey: 'claim-key-3' })
    assert.deepEqual(failureShape(otherActor), { ok: false, code: 'already_claimed', status: 409 })

    const replayedByAnother = await client.claim({ taskId: 't-2', actor: 'agent-board:intruder', idempotencyKey: 'claim-key-2' })
    assert.equal(replayedByAnother.code, 'already_claimed')

    const blocked = await client.claim({ taskId: 't-blocked', actor: ACTOR, idempotencyKey: 'claim-key-blocked' })
    assert.deepEqual(failureShape(blocked), { ok: false, code: 'dependency_blocked', status: 409 })

    const unknown = await client.task('t-unknown-code')
    assert.deepEqual(failureShape(unknown), { ok: false, code: 'mystery_code', status: 400 })

    const soft = await client.task('t-soft-error')
    assert.deepEqual(failureShape(soft), { ok: false, code: 'forbidden', status: 200 })
  } finally {
    await board.close()
  }
})

test('interrupt settles a claimed execution as cancelled and returns it to todo', async () => {
  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board)
    const claim = await client.claim({ taskId: 't-3', actor: ACTOR, idempotencyKey: 'claim-key-interrupt' })
    assert.equal(claim.ok, true)
    const executionId = claim.value.execution.executionId

    const interrupted = await client.interrupt(executionId, { actor: ACTOR, reason: 'operator stop', ifFencingToken: 1 })
    assert.equal(interrupted.ok, true)
    assert.equal(interrupted.value.outcome, 'cancelled')

    const task = await client.task('t-3')
    assert.equal(task.value.status, 'todo')
    assert.equal(task.value.claimedBy, undefined)
  } finally {
    await board.close()
  }
})

test('maps 401, 503, 500 and malformed JSON without throwing', async () => {
  const unauthorizedBoard = await startFakeTaskBoard()
  const unauthorizedClient = createPublicTaskBoardClient({ baseUrl: unauthorizedBoard.base, token: 'wrong-bearer-value' })
  const unauthorized = await unauthorizedClient.meta()
  assert.deepEqual(failureShape(unauthorized), { ok: false, code: 'unauthorized', status: 401 })
  assert.equal(JSON.stringify(unauthorized).includes('wrong-bearer-value'), false)
  await unauthorizedBoard.close()

  const disabledBoard = await startFakeTaskBoard({ disabled: true })
  const disabled = await clientFor(disabledBoard).meta()
  assert.deepEqual(failureShape(disabled), { ok: false, code: 'public_api_disabled', status: 503 })
  await disabledBoard.close()

  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board)
    const internal = await client.task('t-internal')
    assert.deepEqual(failureShape(internal), { ok: false, code: 'internal', status: 500 })
    const malformed = await client.task('t-malformed')
    assert.deepEqual(failureShape(malformed), { ok: false, code: 'bad_response', status: 200 })
  } finally {
    await board.close()
  }
})

test('enforces a real AbortController timeout', async () => {
  const board = await startFakeTaskBoard()
  try {
    const client = clientFor(board, { timeoutMs: 40 })
    const startedAt = Date.now()
    const result = await client.task('t-slow')
    assert.deepEqual(failureShape(result), { ok: false, code: 'timeout', status: 0 })
    assert.ok(Date.now() - startedAt < 1_500, 'timeout must abort promptly, not wait for the server')
    assertNoToken(result)

    const bodyStartedAt = Date.now()
    const stalledBody = await client.task('t-slow-body')
    assert.deepEqual(failureShape(stalledBody), { ok: false, code: 'timeout', status: 0 })
    assert.ok(Date.now() - bodyStartedAt < 1_500, 'a stalled body must map to timeout too')
  } finally {
    await board.close()
  }
})

test('unconfigured clients refuse locally and transports never throw', async () => {
  const calls = []
  const unconfigured = createPublicTaskBoardClient({
    baseUrl: 'http://127.0.0.1:1',
    token: '',
    fetchImpl: async (...args) => {
      calls.push(args)
      throw new Error('fetch must not be called while unconfigured')
    },
  })
  assert.equal(unconfigured.configured, false)
  assert.deepEqual(failureShape(await unconfigured.meta()), { ok: false, code: 'unconfigured', status: 0 })
  assert.equal(calls.length, 0)
  assert.equal(createPublicTaskBoardClient(null).configured, false)

  const throwing = createPublicTaskBoardClient({
    baseUrl: 'http://127.0.0.1:1',
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error(`transport exploded with ${TOKEN}`)
    },
  })
  const transport = await throwing.meta()
  assert.deepEqual(failureShape(transport), { ok: false, code: 'unreachable', status: 0 })
  assert.equal(transport.message.includes(TOKEN), false)
  assert.match(transport.message, /\[redacted\]/)

  const noResponse = createPublicTaskBoardClient({
    baseUrl: 'http://127.0.0.1:1',
    token: TOKEN,
    fetchImpl: async () => null,
  })
  assert.deepEqual(failureShape(await noResponse.meta()), { ok: false, code: 'bad_response', status: 0 })

  // Malformed arguments and missing inputs must resolve to errors, never throw.
  for (const method of ['listTasks', 'events', 'claim', 'attachSession', 'attempt', 'handoff', 'complete', 'interrupt']) {
    const result = await throwing[method]()
    assert.equal(result.ok, false, `${method}() must resolve to an error`)
    assert.equal(typeof result.code, 'string')
  }
})

test('the token is never returned and the client never logs', async () => {
  const board = await startFakeTaskBoard()
  const captured = []
  const originals = {}
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    originals[method] = console[method]
    console[method] = (...args) => captured.push(args)
  }
  try {
    const client = clientFor(board)
    assertNoToken(client)
    assertNoToken(await client.meta())
    assertNoToken(await client.task('t-internal'))
  } finally {
    for (const method of Object.keys(originals)) console[method] = originals[method]
    await board.close()
  }
  assert.deepEqual(captured, [])
})
