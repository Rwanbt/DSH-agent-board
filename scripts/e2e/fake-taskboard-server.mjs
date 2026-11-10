#!/usr/bin/env node
/**
 * SIMULATED Task Board HTTP server for the isolated-host E2E harness.
 *
 * ⚠️  THIS IS A SIMULATION — NOT the real `dsh-taskboard` plugin and not the
 * real ledger. Every response carries `x-simulated-taskboard: true` and a
 * `x-simulated-note` header, and the banner on stderr says so. Nothing served
 * here can be presented as live Task Board evidence.
 *
 * It serves:
 *  1. the REAL read contract used by `src/connectors/taskboard.js`:
 *       GET /dsh-taskboard/state
 *         -> { ok:true, value:{ revision, tasks[], doneCount, queue,
 *              meta:{ ledgerRevision, tasksTotal } } }
 *     tasks use the real TaskRecord field names (`version`, `claimedBy`,
 *     `execution.mode`, `isolation`, `executions[].outcome`).
 *  2. the PROPOSED execution-ownership extension documented in
 *     `docs/TASKBOARD-CONTRACT.md` (see `src/connectors/taskboard-contract.js`
 *     when present):
 *       GET  /dsh-taskboard/contract
 *       POST /dsh-taskboard/tasks/:id/executions/lease
 *       POST /dsh-taskboard/executions/:leaseId/{attach,report,release,settle}
 *     with idempotency, fencing, TTL and conflict semantics.
 *  3. harness-only seeding for standalone use:
 *       POST /_control/tasks     { task }
 *       POST /_control/reset     { clearTasks?, clearLog? }
 *       GET  /_control/state
 *
 * Standalone:
 *   node scripts/e2e/fake-taskboard-server.mjs [--port 0]
 *   -> prints one JSON line on stdout: {"url":"http://127.0.0.1:PORT",...}
 *
 * In-process (used by run-e2e.mjs):
 *   const { startFakeTaskBoard } = await import('./fake-taskboard-server.mjs')
 *   const fake = await startFakeTaskBoard({ port: 0, workspaceId, leaseTtlMs })
 *   fake.createTask({ id, title, ... })
 *   fake.tasks, fake.state(), fake.calls, fake.close()
 *
 * @module scripts/e2e/fake-taskboard-server
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const SIMULATION_HEADER = 'x-simulated-taskboard'
export const SIMULATION_NOTE = 'SIMULATION of the dsh-taskboard read contract + proposed execution contract; NOT the real plugin'
export const CONTRACT_VERSION = 1
export const CONTRACT_FEATURES = Object.freeze([
  'execution.lease',
  'execution.attach',
  'execution.report',
  'execution.release',
  'execution.settle',
  'execution.fencing',
  'execution.idempotency',
  'execution.reroute',
])

function headers(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    [SIMULATION_HEADER]: 'true',
    'x-simulated-note': SIMULATION_NOTE,
    ...extra,
  }
}

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, headers({ 'content-length': Buffer.byteLength(body), ...extraHeaders }))
  res.end(body)
}

const ok = (res, status, value) => send(res, status, { ok: true, value })
const refuse = (res, status, code, message, extra = {}) => send(res, status, { ok: false, error: { code, message, ...extra } })

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const clone = value => (value === undefined ? undefined : structuredClone(value))

function normalizeReport(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (summary.length === 0 || summary.length > 2000) return null
  const listOf = value => (Array.isArray(value) ? value.filter(entry => typeof entry === 'string').slice(0, 50) : [])
  const risk = typeof body.risk === 'string' ? body.risk : ''
  if (risk.length > 2000) return null
  return { summary, changedFiles: listOf(body.changedFiles), checks: listOf(body.checks), artifacts: listOf(body.artifacts), risk }
}

/**
 * Create the in-memory simulated board.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceId] default workspace id for seeded tasks
 * @param {number} [options.leaseTtlMs]
 * @param {number} [options.revision]
 * @param {Function} [options.now]
 */
export function createFakeTaskBoard({ workspaceId = 'w-e2e', leaseTtlMs = 120_000, revision = 100, now = () => Date.now() } = {}) {
  /** @type {{revision:number, tasks:object[]}} */
  const state = { revision, tasks: [] }
  const leases = new Map()
  const calls = []
  let leaseCounter = 0
  let executionCounter = 0
  let fenceCounter = 0
  let taskCounter = 0

  const taskById = id => state.tasks.find(task => task.id === id) ?? null
  const executionOf = lease => taskById(lease.taskId)?.executions?.find(entry => entry.id === lease.executionId) ?? null

  function touch(task) {
    task.version += 1
    task.updatedAt = now()
    state.revision += 1
  }

  function createTask(overrides = {}) {
    taskCounter += 1
    const task = {
      id: overrides.id ?? `tb-e2e-${taskCounter}`,
      title: overrides.title ?? `E2E simulated task ${taskCounter}`,
      description: overrides.description ?? '',
      prompt: overrides.prompt ?? '',
      status: overrides.status ?? 'todo',
      urgency: overrides.urgency ?? 'normal',
      workspaceId: overrides.workspaceId ?? workspaceId,
      version: Number.isInteger(overrides.version) ? overrides.version : 1,
      claimedBy: null,
      claimedAt: null,
      dependsOn: Array.isArray(overrides.dependsOn) ? [...overrides.dependsOn] : [],
      blocked: overrides.blocked === true,
      waitingForHuman: overrides.waitingForHuman === true,
      execution: overrides.execution ?? { mode: 'claim' },
      isolation: overrides.isolation ?? 'none',
      permission: overrides.permission ?? 'workspace-write',
      executions: Array.isArray(overrides.executions) ? clone(overrides.executions) : [],
      createdAt: now(),
      updatedAt: now(),
      ...clone(overrides),
    }
    state.tasks.push(task)
    state.revision += 1
    return clone(task)
  }

  function updateTask(id, patch = {}) {
    const task = taskById(id)
    if (task === null) return null
    Object.assign(task, {
      ...clone(patch),
      id: task.id,
      version: Number.isInteger(patch?.version) ? patch.version : task.version + 1,
      updatedAt: now(),
    })
    state.revision += 1
    return clone(task)
  }

  function activeLeaseFor(taskId) {
    for (const lease of leases.values()) {
      expire(lease)
      if (lease.taskId === taskId && (lease.state === 'leased' || lease.state === 'attached')) return lease
    }
    return null
  }

  function expire(lease) {
    if (lease.state !== 'leased' && lease.state !== 'attached') return
    if (lease.expiresAt > now()) return
    lease.state = 'released'
    lease.releasedAt = now()
    lease.releaseReason = 'lease expired'
    const task = taskById(lease.taskId)
    const execution = executionOf(lease)
    if (execution !== null && execution.outcome === 'running') {
      execution.outcome = 'cancelled'
      execution.endedAt = now()
      execution.error = 'lease expired'
    }
    if (task !== null) {
      task.claimedBy = null
      task.claimedAt = null
      task.status = 'todo'
      touch(task)
    }
  }

  const leaseView = lease => ({
    leaseId: lease.id,
    executionId: lease.executionId,
    taskId: lease.taskId,
    taskVersion: taskById(lease.taskId)?.version ?? null,
    route: lease.route,
    attempt: lease.attempt,
    fence: lease.fence,
    expiresAt: lease.expiresAt,
    state: lease.state,
  })

  function readState() {
    return {
      revision: state.revision,
      tasks: state.tasks.map(task => clone(task)),
      doneCount: state.tasks.filter(task => task.status === 'done' && task.trashedAt === undefined).length,
      capabilities: { archiveSessions: false },
      queue: null,
      meta: {
        ledgerRevision: state.revision,
        tasksTotal: state.tasks.length,
        simulated: true,
        contractVersion: CONTRACT_VERSION,
      },
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'
    let body = {}
    if (method === 'POST' || method === 'PUT') {
      const text = await readBody(req)
      if (text.length > 0) {
        try { body = JSON.parse(text) } catch {
          refuse(res, 400, 'invalid_json', 'request body must be JSON')
          return
        }
      }
    }
    calls.push({ method, path, body: clone(body), at: now() })

    if (method === 'GET' && path === '/dsh-taskboard/state') {
      ok(res, 200, readState())
      return
    }

    if (method === 'GET' && path === '/dsh-taskboard/contract') {
      ok(res, 200, {
        contract: {
          version: CONTRACT_VERSION,
          features: [...CONTRACT_FEATURES],
          product: 'dsh-taskboard',
          leaseTtlMs,
          simulated: true,
          note: 'SIMULATED proposed extension — not implemented by the real plugin',
        },
      })
      return
    }

    // ------------------------------------------------- harness-only seeding
    if (method === 'POST' && path === '/_control/tasks') {
      const created = createTask(body?.task ?? {})
      ok(res, 201, created)
      return
    }
    const updateMatch = path.match(/^\/_control\/tasks\/([^/]+)$/)
    if (method === 'POST' && updateMatch !== null) {
      const updated = updateTask(decodeURIComponent(updateMatch[1]), body?.patch ?? {})
      if (updated === null) return refuse(res, 404, 'not_found', `no such task: ${decodeURIComponent(updateMatch[1])}`)
      return ok(res, 200, updated)
    }
    if (method === 'POST' && path === '/_control/reset') {
      leases.clear()
      if (body?.clearTasks === true) {
        state.tasks.length = 0
        state.revision += 1
      }
      if (body?.clearLog === true) calls.length = 0
      ok(res, 200, { queued: 0, tasks: state.tasks.length })
      return
    }
    if (method === 'GET' && path === '/_control/state') {
      ok(res, 200, { ...readState(), leases: [...leases.values()].map(clone), leaseTtlMs })
      return
    }

    // ------------------------------------------------------------- lease
    const leaseMatch = path.match(/^\/dsh-taskboard\/tasks\/([^/]+)\/executions\/lease$/)
    if (method === 'POST' && leaseMatch !== null) {
      const taskId = decodeURIComponent(leaseMatch[1])
      const task = taskById(taskId)
      if (task === null) return refuse(res, 404, 'not_found', `no such task: ${taskId}`)
      if (task.trashedAt !== undefined || task.status === 'done' || task.status === 'archived') {
        return refuse(res, 422, 'invalid_input', `task ${taskId} is not claimable (status ${task.status})`)
      }
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : ''
      if (key === '') return refuse(res, 422, 'invalid_input', 'idempotencyKey is required')
      for (const lease of leases.values()) {
        if (lease.taskId !== taskId || lease.idempotencyKey !== key) continue
        expire(lease)
        if (lease.state === 'leased' || lease.state === 'attached') return ok(res, 200, leaseView(lease))
        return refuse(res, 409, 'lease_conflict', `attempt ${lease.attempt} already ended (${lease.state}); use a new attempt number`)
      }
      const prior = activeLeaseFor(taskId)
      if (prior !== null) {
        return refuse(res, 409, 'lease_conflict', `task ${taskId} already has an active lease (${prior.id})`, { leaseId: prior.id, fence: prior.fence })
      }
      const running = (task.executions ?? []).find(entry => entry.outcome === 'running')
      if (task.status === 'in_progress' && (typeof task.claimedBy === 'string' || running !== undefined)) {
        return refuse(res, 409, 'claim_conflict', `task ${taskId} is already claimed by ${String(task.claimedBy ?? running?.sessionId ?? 'another session')}`)
      }
      if (body.expectedVersion !== undefined && body.expectedVersion !== null && body.expectedVersion !== task.version) {
        return refuse(res, 409, 'version_conflict', `stale task version ${String(body.expectedVersion)} (current ${task.version})`, { currentVersion: task.version })
      }
      if (task.status !== 'todo' && task.status !== 'in_progress') {
        return refuse(res, 422, 'invalid_input', `task ${taskId} cannot be leased from status ${task.status}`)
      }
      const lease = {
        id: `lease-${++leaseCounter}`,
        taskId,
        executionId: `exec-${++executionCounter}`,
        route: body.route ?? null,
        attempt: Number.isInteger(body.attempt) && body.attempt > 0 ? body.attempt : 1,
        previousExecutionId: typeof body.previousExecutionId === 'string' ? body.previousExecutionId : null,
        idempotencyKey: key,
        state: 'leased',
        fence: ++fenceCounter,
        sessionId: null,
        createdAt: now(),
        expiresAt: now() + leaseTtlMs,
        report: null,
        reportRevision: null,
        outcome: null,
      }
      leases.set(lease.id, lease)
      task.executions = [...(task.executions ?? []), {
        id: lease.executionId,
        trigger: 'manual',
        outcome: 'running',
        startedAt: now(),
        isolation: task.isolation ?? 'none',
        leaseId: lease.id,
        attempt: lease.attempt,
        ...(lease.previousExecutionId !== null ? { previousExecutionId: lease.previousExecutionId } : {}),
        ...(lease.route !== null ? { route: clone(lease.route) } : {}),
      }]
      task.status = 'in_progress'
      task.claimedBy = `lease:${lease.id}`
      task.claimedAt = now()
      touch(task)
      ok(res, 202, leaseView(lease))
      return
    }

    // ------------------------------------------------- lease sub-resources
    const executionMatch = path.match(/^\/dsh-taskboard\/executions\/([^/]+)\/(attach|report|release|settle)$/)
    if (method === 'POST' && executionMatch !== null) {
      const leaseId = decodeURIComponent(executionMatch[1])
      const action = executionMatch[2]
      const lease = leases.get(leaseId)
      if (lease === undefined) return refuse(res, 404, 'not_found', `no such lease: ${leaseId}`)
      expire(lease)

      if (action === 'attach') {
        if (lease.state === 'released' || lease.state === 'settled') {
          return refuse(res, 422, 'invalid_input', `lease ${leaseId} is ${lease.state}; it cannot be attached`)
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return refuse(res, 422, 'invalid_input', 'sessionId is required')
        if (lease.state === 'attached') {
          if (lease.sessionId === sessionId) return ok(res, 200, {
            leaseId: lease.id, sessionId: lease.sessionId, executionId: lease.executionId, state: lease.state, attachedAt: lease.attachedAt,
          })
          return refuse(res, 409, 'claim_conflict', `lease ${leaseId} is already attached to ${String(lease.sessionId)}`)
        }
        const task = taskById(lease.taskId)
        const execution = executionOf(lease)
        lease.sessionId = sessionId
        lease.state = 'attached'
        lease.attachedAt = now()
        if (execution !== null) {
          execution.sessionId = sessionId
          if (body.route !== null && body.route !== undefined) execution.route = clone(body.route)
        }
        if (task !== null) {
          task.claimedBy = sessionId
          task.claimedAt = now()
          touch(task)
        }
        return ok(res, 200, { leaseId: lease.id, sessionId, executionId: lease.executionId, state: lease.state, attachedAt: lease.attachedAt })
      }

      if (action === 'report') {
        if (lease.state === 'released' || lease.state === 'settled') {
          return refuse(res, 422, 'invalid_input', `lease ${leaseId} is ${lease.state}; no report can be submitted`)
        }
        const report = normalizeReport(body)
        if (report === null) return refuse(res, 422, 'invalid_input', 'report needs a non-empty summary, bounded string arrays and a ≤2000-char risk')
        lease.report = report
        lease.reportRevision = (lease.reportRevision ?? 0) + 1
        lease.reportedAt = now()
        const execution = executionOf(lease)
        if (execution !== null) execution.report = clone(report)
        const task = taskById(lease.taskId)
        if (task !== null) touch(task)
        return ok(res, 200, { leaseId, reportRevision: lease.reportRevision, acceptedAt: lease.reportedAt })
      }

      if (action === 'release') {
        if (lease.state === 'released') {
          return ok(res, 200, {
            leaseId, state: lease.state, reason: lease.releaseReason, releasedAt: lease.releasedAt, taskVersion: taskById(lease.taskId)?.version ?? null,
          })
        }
        if (lease.state === 'settled') return refuse(res, 422, 'invalid_input', `lease ${leaseId} is already settled; release is not applicable`)
        const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason.slice(0, 500) : 'released by dsh-agent-board'
        lease.state = 'released'
        lease.releasedAt = now()
        lease.releaseReason = reason
        const task = taskById(lease.taskId)
        const execution = executionOf(lease)
        if (execution !== null && execution.outcome === 'running') {
          execution.outcome = 'cancelled'
          execution.endedAt = now()
          execution.error = reason
        }
        if (task !== null) {
          task.claimedBy = null
          task.claimedAt = null
          task.status = 'todo'
          touch(task)
        }
        return ok(res, 200, {
          leaseId, state: lease.state, reason, releasedAt: lease.releasedAt, taskVersion: task?.version ?? null,
        })
      }

      // settle
      if (lease.state === 'settled') {
        return ok(res, 200, {
          leaseId, executionId: lease.executionId, taskId: lease.taskId, outcome: lease.outcome,
          taskVersion: taskById(lease.taskId)?.version ?? null, status: taskById(lease.taskId)?.status ?? null,
          reportRevision: lease.reportRevision ?? null, simulated: true,
        })
      }
      if (lease.state === 'released') return refuse(res, 422, 'invalid_input', `lease ${leaseId} was released; it cannot be settled`)
      const outcome = body.outcome
      if (!['succeeded', 'failed', 'cancelled'].includes(outcome)) {
        const why = outcome === 'done' ? '`done` is a human-only action; an execution can never settle a task to done' : 'outcome must be succeeded, failed or cancelled'
        return refuse(res, 422, 'invalid_input', why)
      }
      if (body.requestReview === true && outcome !== 'succeeded') {
        return refuse(res, 422, 'invalid_input', 'requestReview is only valid for a succeeded execution')
      }
      let report = null
      if (body.report !== null && body.report !== undefined) {
        report = normalizeReport(body.report)
        if (report === null) return refuse(res, 422, 'invalid_input', 'settle report is invalid')
      }
      const task = taskById(lease.taskId)
      const execution = executionOf(lease)
      lease.state = 'settled'
      lease.outcome = outcome
      lease.settledAt = now()
      lease.requestReview = body.requestReview === true
      if (report !== null) {
        lease.report = report
        lease.reportRevision = (lease.reportRevision ?? 0) + 1
      }
      if (execution !== null) {
        execution.outcome = outcome
        execution.endedAt = lease.settledAt
        if (report !== null) execution.report = clone(report)
        if (outcome === 'failed' && execution.error === undefined) execution.error = 'execution failed'
      }
      if (task !== null) {
        task.claimedBy = null
        task.claimedAt = null
        task.status = outcome === 'succeeded' ? (body.requestReview === true ? 'in_review' : 'in_progress') : 'todo'
        touch(task)
      }
      return ok(res, 200, {
        leaseId, executionId: lease.executionId, taskId: lease.taskId, outcome,
        taskVersion: task?.version ?? null, status: task?.status ?? null,
        reportRevision: lease.reportRevision ?? null, simulated: true,
      })
    }

    refuse(res, 404, 'not_found', `no simulated route for ${method} ${path}`)
  }

  return {
    calls,
    state: readState,
    leases: () => [...leases.values()].map(clone),
    get tasks() { return state.tasks },
    task: id => clone(taskById(id)),
    createTask,
    updateTask,
    handle,
  }
}

/**
 * Start the simulated Task Board on an ephemeral (or fixed) 127.0.0.1 port.
 * @returns {Promise<{url:string, port:number, board:ReturnType<typeof createFakeTaskBoard>, createTask:Function, state:Function, tasks:object[], calls:object[], close:Function}>}
 */
export async function startFakeTaskBoard(options = {}) {
  const board = createFakeTaskBoard(options)
  const server = createServer((req, res) => {
    board.handle(req, res).catch(error => {
      try { refuse(res, 500, 'http_error', `simulated server failure: ${String(error?.message ?? error)}`) } catch { /* response gone */ }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(options.port ?? 0), options.host ?? '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : Number(options.port ?? 0)
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    board,
    createTask: board.createTask,
    updateTask: board.updateTask,
    state: board.state,
    get tasks() { return board.tasks },
    calls: board.calls,
    leases: board.leases,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.()
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}

const isMain = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(name)
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
  }
  const fake = await startFakeTaskBoard({
    port: Number(option('--port', '0')) || 0,
    workspaceId: option('--workspace', `w-${randomUUID().slice(0, 8)}`),
  })
  process.stderr.write(`[fake-taskboard] SIMULATION — not the real ledger; ${fake.url} (all responses carry ${SIMULATION_HEADER}: true)\n`)
  process.stdout.write(`${JSON.stringify({ url: fake.url, port: fake.port, simulation: true })}\n`)
  const shutdown = () => { void fake.close().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
