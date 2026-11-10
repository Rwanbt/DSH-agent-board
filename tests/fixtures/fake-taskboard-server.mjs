/**
 * SIMULATED Task Board HTTP server — TEST FIXTURE ONLY.
 *
 * This file is a SIMULATION of the PROPOSED `dsh-taskboard` execution contract
 * described in `docs/TASKBOARD-CONTRACT.md`. It is NOT the real Task Board
 * plugin (`D:\App\dsh-taskboard`) and must never be deployed, presented as a
 * live integration, or used as evidence that the extension exists.
 *
 * It implements:
 *  - the REAL read shape: `GET /dsh-taskboard/state` ->
 *    `{ ok:true, value:{ revision, tasks[], doneCount, capabilities, queue,
 *    meta:{ ledgerRevision, tasksTotal } } }` with tasks carrying the real
 *    `TaskRecord` fields (`version`, `claimedBy`, `execution.mode`,
 *    `isolation`, `executions[].outcome`);
 *  - the PROPOSED extension: `GET /dsh-taskboard/contract`,
 *    `POST /dsh-taskboard/tasks/:id/executions/lease`,
 *    `POST /dsh-taskboard/executions/:leaseId/{attach,report,release,settle}`
 *    with the documented idempotency, fencing and conflict semantics.
 *
 * Every response carries `x-simulated-contract: true` so no capture can be
 * mistaken for a real Task Board response.
 *
 * @module dsh-agent-board/tests/fixtures/fake-taskboard-server
 */

import { createServer } from 'node:http'

/** Header stamped on EVERY simulated response. */
export const SIMULATED_CONTRACT_HEADER = 'x-simulated-contract'

/** Simulated contract version (matches the proposal, v1). */
export const SIMULATED_CONTRACT_VERSION = 1

export const SIMULATED_FEATURES = Object.freeze([
  'execution.lease',
  'execution.attach',
  'execution.report',
  'execution.release',
  'execution.settle',
  'execution.fencing',
  'execution.idempotency',
  'execution.reroute',
])

/** A realistic TaskRecord for fixtures. */
export function simulatedTask(overrides = {}) {
  return {
    id: 't-contract-1',
    title: 'Contract flow task',
    description: 'Drives the proposed execution contract end to end.',
    prompt: '',
    workspaceId: 'w1',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    version: 3,
    execution: { mode: 'claim' },
    isolation: 'worktree',
    executions: [],
    ...overrides,
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    [SIMULATED_CONTRACT_HEADER]: 'true',
    'x-simulated-note': 'SIMULATION of the proposed dsh-taskboard execution contract (docs/TASKBOARD-CONTRACT.md); NOT the real plugin',
  })
  res.end(body)
}

function ok(res, status, value) {
  json(res, status, { ok: true, value })
}

function refuse(res, status, code, message, extra = {}) {
  json(res, status, { ok: false, error: { code, message, ...extra } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/**
 * Build the in-memory simulated board (no socket).
 *
 * @param {object} [options]
 * @param {'full'|'partial'|'absent'} [options.contractMode]
 * @param {string[]} [options.features]  advertised subset (partial mode)
 * @param {object[]} [options.tasks]     TaskRecord fixtures
 * @param {Function} [options.now]       epoch-ms clock
 * @param {number} [options.leaseTtlMs]
 * @param {number} [options.revision]    initial ledger revision
 */
export function createSimulatedTaskBoard({
  contractMode = 'full',
  features = SIMULATED_FEATURES,
  tasks = [simulatedTask(), simulatedTask({ id: 't-contract-2', title: 'Second task', version: 1, isolation: 'none', execution: { mode: 'scheduled' } })],
  now = () => Date.now(),
  leaseTtlMs = 120_000,
  revision = 100,
} = {}) {
  const state = {
    revision: Number(revision) || 100,
    tasks: tasks.map(task => clone(task)),
    leases: new Map(),
  }
  const calls = []
  let leaseCounter = 0
  let executionCounter = 0
  let fenceCounter = 0

  function taskById(id) {
    return state.tasks.find(task => task.id === id) ?? null
  }

  function executionOf(lease) {
    const task = taskById(lease.taskId)
    return task?.executions?.find(entry => entry.id === lease.executionId) ?? null
  }

  function touch(task) {
    task.version += 1
    task.updatedAt = now()
    state.revision += 1
  }

  function activeLeaseFor(taskId) {
    for (const lease of state.leases.values()) {
      expire(lease)
      if (lease.taskId === taskId && (lease.state === 'leased' || lease.state === 'attached')) return lease
    }
    return null
  }

  /** Lazy TTL enforcement: the Task Board is the authority on lease expiry. */
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
      delete task.claimedBy
      delete task.claimedAt
      task.status = 'todo'
      touch(task)
    }
  }

  function leaseView(lease) {
    const task = taskById(lease.taskId)
    return {
      leaseId: lease.id,
      executionId: lease.executionId,
      taskId: lease.taskId,
      taskVersion: task?.version ?? null,
      route: lease.route,
      attempt: lease.attempt,
      fence: lease.fence,
      expiresAt: lease.expiresAt,
      state: lease.state,
    }
  }

  function attachView(lease) {
    return {
      leaseId: lease.id,
      sessionId: lease.sessionId,
      executionId: lease.executionId,
      state: lease.state,
      attachedAt: lease.attachedAt,
    }
  }

  function releaseView(lease) {
    return {
      leaseId: lease.id,
      state: lease.state,
      reason: lease.releaseReason,
      releasedAt: lease.releasedAt,
      taskVersion: taskById(lease.taskId)?.version ?? null,
    }
  }

  function settleView(lease) {
    const task = taskById(lease.taskId)
    return {
      leaseId: lease.id,
      executionId: lease.executionId,
      taskId: lease.taskId,
      outcome: lease.outcome,
      taskVersion: task?.version ?? null,
      status: task?.status ?? null,
      reportRevision: lease.reportRevision ?? null,
      simulated: true,
    }
  }

  function normalizedReport(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
    const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
    if (summary.length === 0 || summary.length > 2000) return null
    const list = value => (Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : [])
    const risk = typeof body.risk === 'string' ? body.risk : ''
    if (risk.length > 2000) return null
    return { summary, changedFiles: list(body.changedFiles), checks: list(body.checks), artifacts: list(body.artifacts), risk }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method ?? 'GET'
    let body = {}
    if (method === 'POST' || method === 'PUT') {
      const text = await readBody(req)
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          return refuse(res, 400, 'invalid_input', 'request body must be JSON')
        }
      }
    }
    calls.push({ method, path, body, at: now() })

    // ------------------------------------------------------------- read shape
    if (method === 'GET' && path === '/dsh-taskboard/state') {
      return ok(res, 200, {
        revision: state.revision,
        tasks: state.tasks.map(task => clone(task)),
        doneCount: state.tasks.filter(task => task.status === 'done' && task.trashedAt === undefined).length,
        capabilities: { archiveSessions: false },
        queue: null,
        meta: {
          ledgerRevision: state.revision,
          tasksTotal: state.tasks.length,
          simulated: true,
          contractVersion: contractMode === 'absent' ? null : SIMULATED_CONTRACT_VERSION,
        },
      })
    }

    // -------------------------------------------------- PROPOSED contract probe
    if (method === 'GET' && path === '/dsh-taskboard/contract') {
      if (contractMode === 'absent') {
        return refuse(res, 404, 'not_found', 'no execution-contract endpoint in this Task Board version')
      }
      const advertised = contractMode === 'partial' ? features.filter(feature => SIMULATED_FEATURES.includes(feature)) : [...SIMULATED_FEATURES]
      return ok(res, 200, {
        contract: {
          version: SIMULATED_CONTRACT_VERSION,
          features: advertised,
          product: 'dsh-taskboard',
          leaseTtlMs,
          simulated: true,
          note: 'SIMULATED proposed extension — not implemented by the real plugin',
        },
      })
    }

    // ---------------------------------------------------------- lease endpoint
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
      // Idempotent replay of the SAME attempt, or an explicit conflict.
      for (const lease of state.leases.values()) {
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
      const expectedVersion = body.expectedVersion
      if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== task.version) {
        return refuse(res, 409, 'version_conflict', `stale task version ${String(expectedVersion)} (current ${task.version})`, { currentVersion: task.version })
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
      state.leases.set(lease.id, lease)
      task.executions = [...(task.executions ?? []), {
        id: lease.executionId,
        trigger: 'manual',
        outcome: 'running',
        startedAt: now(),
        isolation: task.isolation ?? 'none',
        leaseId: lease.id,
        attempt: lease.attempt,
        ...(lease.route !== null ? { route: clone(lease.route) } : {}),
      }]
      task.status = 'in_progress'
      task.claimedBy = `lease:${lease.id}`
      task.claimedAt = now()
      touch(task)
      return ok(res, 202, leaseView(lease))
    }

    // --------------------------------------------------------- lease sub-paths
    const executionMatch = path.match(/^\/dsh-taskboard\/executions\/([^/]+)\/(attach|report|release|settle)$/)
    if (method === 'POST' && executionMatch !== null) {
      const leaseId = decodeURIComponent(executionMatch[1])
      const action = executionMatch[2]
      const lease = state.leases.get(leaseId)
      if (lease === undefined) return refuse(res, 404, 'not_found', `no such lease: ${leaseId}`)
      expire(lease)

      if (action === 'attach') {
        if (lease.state === 'released' || lease.state === 'settled') {
          return refuse(res, 422, 'invalid_input', `lease ${leaseId} is ${lease.state}; it cannot be attached`)
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return refuse(res, 422, 'invalid_input', 'sessionId is required')
        if (lease.state === 'attached') {
          if (lease.sessionId === sessionId) {
            // Idempotent: same lease + same session returns the SAME record,
            // and does NOT bump the task version again.
            return ok(res, 200, attachView(lease))
          }
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
        return ok(res, 200, attachView(lease))
      }

      if (action === 'report') {
        if (lease.state === 'released' || lease.state === 'settled') {
          return refuse(res, 422, 'invalid_input', `lease ${leaseId} is ${lease.state}; no report can be submitted`)
        }
        const report = normalizedReport(body)
        if (report === null) return refuse(res, 422, 'invalid_input', 'report needs a non-empty summary, bounded string arrays and a ≤2000-char risk')
        const task = taskById(lease.taskId)
        const execution = executionOf(lease)
        lease.report = report
        lease.reportRevision = (lease.reportRevision ?? 0) + 1
        lease.reportedAt = now()
        if (execution !== null) execution.report = clone(report)
        if (task !== null) touch(task)
        return ok(res, 200, { leaseId, reportRevision: lease.reportRevision, acceptedAt: lease.reportedAt })
      }

      if (action === 'release') {
        if (lease.state === 'released') return ok(res, 200, releaseView(lease)) // idempotent
        if (lease.state === 'settled') {
          return refuse(res, 422, 'invalid_input', `lease ${leaseId} is already settled; release is not applicable`)
        }
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
          delete task.claimedBy
          delete task.claimedAt
          task.status = 'todo'
          touch(task)
        }
        return ok(res, 200, releaseView(lease))
      }

      // settle
      if (lease.state === 'settled') return ok(res, 200, settleView(lease)) // idempotent
      if (lease.state === 'released') {
        return refuse(res, 422, 'invalid_input', `lease ${leaseId} was released; it cannot be settled`)
      }
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
        report = normalizedReport(body.report)
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
        delete task.claimedBy
        delete task.claimedAt
        if (outcome === 'succeeded') {
          task.status = body.requestReview === true ? 'in_review' : 'in_progress'
        } else {
          task.status = 'todo'
        }
        touch(task)
      }
      return ok(res, 200, settleView(lease))
    }

    return refuse(res, 404, 'not_found', `no simulated route for ${method} ${path}`)
  }

  return {
    // Inspection surface for tests and for the docs' evidence commands.
    get calls() {
      return calls
    },
    state() {
      return {
        revision: state.revision,
        tasks: state.tasks.map(task => clone(task)),
        leases: [...state.leases.values()].map(lease => clone(lease)),
        leaseTtlMs,
      }
    },
    task: id => clone(taskById(id)),
    handle,
  }
}

/**
 * Start the simulated Task Board on an ephemeral 127.0.0.1 port.
 *
 * @param {Parameters<typeof createSimulatedTaskBoard>[0]} [options]
 * @returns {Promise<{ url: string, board: ReturnType<typeof createSimulatedTaskBoard>, calls: object[], state: Function, task: Function, close: Function }>}
 */
export async function startSimulatedTaskBoard(options = {}) {
  const board = createSimulatedTaskBoard(options)
  const server = createServer((req, res) => {
    board.handle(req, res).catch(error => {
      try {
        refuse(res, 500, 'http_error', `simulated server failure: ${String(error?.message ?? error)}`)
      } catch {
        // The response is already gone; nothing honest left to do in a fixture.
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    board,
    calls: board.calls,
    state: () => board.state(),
    task: id => board.task(id),
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve(undefined))))
    },
  }
}
