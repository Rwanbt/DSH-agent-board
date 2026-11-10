/**
 * Task Board execution-contract extension — capability negotiation and fenced
 * execution leases.
 *
 * The Agent Board must never read or write the Task Board's ledger directly.
 * Today it consumes the canonical read shape (`GET /dsh-taskboard/state`) and,
 * opt-in, the Task Board's own executor (`POST /tasks/:id/run`). That leaves a
 * real gap: a board-owned session (which is the ONLY backend able to fail over
 * model/provider) has no Task Board execution record, so
 * `taskboard_execution_report` is refused there.
 *
 * This module is the PROPOSED fix: a versioned, capability-negotiated extension
 * where the board LEASES an execution attempt, ATTACHES the session it owns,
 * submits the SAME structured report the Task Board already stores, and settles
 * the attempt. The Task Board stays the single writer of its ledger.
 *
 * It is implemented against a SIMULATED server in tests
 * (`tests/fixtures/fake-taskboard-server.mjs`) — this is NOT a live
 * integration. When the extension is absent (the real 0.10/0.11 Task Board has
 * no `/dsh-taskboard/contract` route) every write method refuses with
 * `not_negotiated`; nothing is emulated, retried against a guessed route, or
 * written through another surface.
 *
 * @module dsh-agent-board/connectors/taskboard-contract
 */

/** Proposed extension version. Integer, strictly increasing. */
export const TASKBOARD_CONTRACT_VERSION = 1

/** Default lease TTL the proposal asks the Task Board to enforce (2 minutes). */
export const TASKBOARD_LEASE_TTL_MS = 120_000

/** The endpoints this module speaks (documented in docs/TASKBOARD-CONTRACT.md). */
export const TASKBOARD_CONTRACT_ENDPOINTS = Object.freeze({
  contract: '/dsh-taskboard/contract',
  state: '/dsh-taskboard/state',
  lease: '/dsh-taskboard/tasks/:id/executions/lease',
  attach: '/dsh-taskboard/executions/:leaseId/attach',
  report: '/dsh-taskboard/executions/:leaseId/report',
  release: '/dsh-taskboard/executions/:leaseId/release',
  settle: '/dsh-taskboard/executions/:leaseId/settle',
})

/**
 * The full proposed feature set. A server announces the subset it implements;
 * negotiation intersects it with this list instead of trusting it blindly.
 */
export const TASKBOARD_CONTRACT_FEATURES = Object.freeze([
  'execution.lease',
  'execution.attach',
  'execution.report',
  'execution.release',
  'execution.settle',
  'execution.fencing',
  'execution.idempotency',
  'execution.reroute',
])

/**
 * Features required before the board may perform ANY write. A half-implemented
 * extension is more dangerous than an absent one (a lease without a release or
 * a settle leaks a claim forever), so the client refuses ALL writes when one of
 * these is missing rather than doing a partial dance.
 */
export const TASKBOARD_CONTRACT_WRITE_FEATURES = Object.freeze([
  'execution.lease',
  'execution.attach',
  'execution.report',
  'execution.release',
  'execution.settle',
  'execution.fencing',
  'execution.idempotency',
])

/** Stable machine error codes. Never a raw thrown value, never an HTTP number. */
export const TASKBOARD_CONTRACT_CODES = Object.freeze({
  not_negotiated: 'not_negotiated',
  lease_conflict: 'lease_conflict',
  version_conflict: 'version_conflict',
  claim_conflict: 'claim_conflict',
  not_found: 'not_found',
  invalid_input: 'invalid_input',
  unreachable: 'unreachable',
  bad_response: 'bad_response',
  http_error: 'http_error',
})

const KNOWN_CODES = new Set(Object.values(TASKBOARD_CONTRACT_CODES))

/** Report bounds, mirrored from the real `ExecutionReport` validator. */
const REPORT_LIMITS = Object.freeze({ summary: 2000, changedFiles: 50, checks: 50, artifacts: 30, risk: 2000 })

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function featureSetOf(list) {
  const out = new Set()
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry === 'string' && TASKBOARD_CONTRACT_FEATURES.includes(entry)) out.add(entry)
    }
  }
  return out
}

/** Unwrap `{ ok:true, value }` envelopes, tolerating both call styles. */
function unwrapEnvelope(value) {
  if (isObject(value) && value.ok === true && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value
  return value
}

function probeStatus(probeError) {
  const status = Number(probeError?.status)
  return Number.isFinite(status) ? status : 0
}

/**
 * Decide whether the proposed extension can be used at all.
 *
 * Absent when the probe got a 404 (the real 0.10/0.11 Task Board has no such
 * route) or no answer. Version mismatch and partial feature sets degrade
 * honestly: `ok` only covers compatibility, `writes` additionally requires the
 * complete write feature set, and `missing` always names what is absent.
 *
 * @param {object} [options]
 * @param {unknown} [options.contract]  the `/dsh-taskboard/contract` payload (envelope or value)
 * @param {object|null} [options.stateMeta] the `/state` meta (`{ ledgerRevision, tasksTotal }`)
 * @param {{ code?: string, status?: number, message?: string }|null} [options.probeError]
 * @returns {{ ok: boolean, version: number|null, features: Set<string>, missing: string[], missingWrite: string[], degraded: boolean, absent: boolean, writes: boolean, simulated: boolean, reason: string, probe: object|null }}
 */
export function negotiateContract({ contract = null, stateMeta = null, probeError = null } = {}) {
  const probe = isObject(probeError)
    ? { code: String(probeError.code ?? 'unknown'), status: probeStatus(probeError), message: typeof probeError.message === 'string' ? probeError.message : '' }
    : null
  const absentProbe = probe !== null && probe.status === 404
  const stateContract = isObject(stateMeta) && Number.isInteger(stateMeta.contractVersion)
    ? stateMeta.contractVersion
    : null

  const base = {
    ok: false,
    version: null,
    features: new Set(),
    missing: [...TASKBOARD_CONTRACT_FEATURES],
    missingWrite: [...TASKBOARD_CONTRACT_WRITE_FEATURES],
    degraded: false,
    absent: absentProbe,
    writes: false,
    simulated: false,
    reason: 'contract_endpoint_absent',
    probe,
  }

  if (contract === null || contract === undefined) {
    if (!absentProbe && probe !== null) {
      // Network/transport failure: below full capability, and still no write.
      return { ...base, absent: false, degraded: true, reason: 'contract_probe_failed' }
    }
    // The state projection may hint at a version, but a missing route is
    // authoritative: never infer the write contract from a read payload.
    if (stateContract !== null) return { ...base, reason: 'contract_route_missing' }
    return base
  }

  const payload = unwrapEnvelope(contract)
  const body = isObject(payload) && isObject(payload.contract) ? payload.contract : payload
  if (!isObject(body)) {
    return { ...base, absent: false, degraded: true, reason: 'contract_malformed', probe }
  }

  const declared = featureSetOf(body.features)
  const missing = TASKBOARD_CONTRACT_FEATURES.filter(feature => !declared.has(feature))
  const missingWrite = TASKBOARD_CONTRACT_WRITE_FEATURES.filter(feature => !declared.has(feature))
  const version = Number(body.version)
  const simulated = body.simulated === true
  const common = {
    features: declared,
    missing,
    missingWrite,
    simulated,
    probe,
  }

  if (!Number.isInteger(version) || version < 1) {
    return { ...base, ...common, absent: false, degraded: true, reason: 'contract_malformed' }
  }
  if (version > TASKBOARD_CONTRACT_VERSION) {
    // A newer server may have changed semantics; guessing is worse than
    // staying on the two existing backends for this task.
    return {
      ...base, ...common, version, absent: false, degraded: false, reason: 'unsupported_version',
    }
  }

  const writes = missingWrite.length === 0
  return {
    ok: true,
    version,
    features: declared,
    missing,
    missingWrite,
    degraded: missing.length > 0,
    absent: false,
    writes,
    simulated,
    reason: writes ? (missing.length > 0 ? 'contract_ok_degraded' : 'contract_ok') : 'partial_features',
    probe,
  }
}

/**
 * Stable idempotency key for one execution attempt.
 *
 * The attempt number is the fence: a failover keeps the same attempt and a
 * reroute gets a new one, so replaying a request for an attempt can never
 * produce a second execution.
 *
 * @param {{ taskId: string, attempt: number }} input
 */
export function executionIdempotencyKey({ taskId, attempt = 1 } = {}) {
  return `dsh-agent-board:lease:${String(taskId)}:${Number(attempt) || 1}`
}

function localFailure(code, message, status = 0) {
  return { ok: false, code, status, message }
}

function normalizeErrorCode(code, status) {
  if (KNOWN_CODES.has(code)) return code
  if (code === 'invalid_transition' || code === 'stale_request' || code === 'version_mismatch') {
    return status === 409 || status === 412 ? 'version_conflict' : 'invalid_input'
  }
  if (code === 'claimed' || code === 'already_claimed' || code === 'claim_taken') return 'claim_conflict'
  if (code === 'lease_taken' || code === 'execution_running') return 'lease_conflict'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 423) return 'claim_conflict'
  if (status === 412) return 'version_conflict'
  if (status === 400 || status === 422) return 'invalid_input'
  return 'http_error'
}

function normalizeReport(report) {
  if (!isObject(report)) return null
  if (typeof report.summary !== 'string') return null
  const summary = report.summary.trim()
  if (summary.length === 0 || summary.length > REPORT_LIMITS.summary) return null
  const list = (value, cap) => {
    if (value === undefined) return []
    if (!Array.isArray(value)) return null
    if (value.length > cap) return null
    return value.map(entry => {
      if (typeof entry !== 'string' || entry.length > 300) return null
      return entry
    })
  }
  const changedFiles = list(report.changedFiles, REPORT_LIMITS.changedFiles)
  const checks = list(report.checks, REPORT_LIMITS.checks)
  const artifacts = list(report.artifacts, REPORT_LIMITS.artifacts)
  if (changedFiles === null || checks === null || artifacts === null) return null
  if (changedFiles.includes(null) || checks.includes(null) || artifacts.includes(null)) return null
  const risk = report.risk === undefined || report.risk === null ? '' : report.risk
  if (typeof risk !== 'string' || risk.length > REPORT_LIMITS.risk) return null
  return { summary, changedFiles, checks, artifacts, risk }
}

/**
 * Client for the proposed extension.
 *
 * Every method resolves to `{ ok:true, status, value }` or
 * `{ ok:false, code, status, message }` — it never throws and never performs a
 * write before `contract()` negotiated a complete extension.
 *
 * @param {object} options
 * @param {string} options.baseUrl same-origin GUI origin, e.g. http://127.0.0.1:62337
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.now] epoch-ms clock (audit `requestedAt` only)
 * @param {number} [options.timeoutMs]
 * @param {object|null} [options.stateMeta] `/state` meta used for honest refusals
 */
export function createTaskBoardContractClient({ baseUrl, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 4000, stateMeta = null } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('agent-board: task board contract client needs a base URL')
  if (typeof fetchImpl !== 'function') throw new Error('agent-board: task board contract client needs a fetch implementation')
  if (typeof now !== 'function') throw new Error('agent-board: task board contract client needs a now() function')

  let negotiation = null

  async function request(method, path, body) {
    const url = new URL(path, baseUrl).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) > 0 ? Number(timeoutMs) : 4000)
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (error) {
      return { error: { code: 'unreachable', status: 0, message: `task board unreachable: ${String(error?.message ?? error)}` } }
    } finally {
      clearTimeout(timer)
    }
    let payload = null
    if (response !== null && typeof response.json === 'function') {
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
    }
    if (response === null || response.ok !== true) {
      const status = Number(response?.status) || 0
      const rawCode = typeof payload?.error?.code === 'string'
        ? payload.error.code
        : (typeof payload?.code === 'string' ? payload.code : `http_${status}`)
      const message = typeof payload?.error?.message === 'string'
        ? payload.error.message
        : (typeof payload?.message === 'string' ? payload.message : `task board refused the request (HTTP ${status})`)
      return { error: { code: normalizeErrorCode(rawCode, status), status, message } }
    }
    if (!isObject(payload) || payload.ok !== true || !Object.prototype.hasOwnProperty.call(payload, 'value')) {
      return { error: { code: 'bad_response', status: Number(response.status) || 0, message: 'task board returned an envelope without ok:true/value' } }
    }
    return { status: Number(response.status) || 0, value: payload.value }
  }

  function fail(error) {
    return localFailure(error.code ?? 'http_error', error.message ?? 'task board request failed', error.status ?? 0)
  }

  function requireWrites() {
    if (negotiation === null) {
      return localFailure('not_negotiated', 'contract() must be called before any execution write; no write is emulated')
    }
    if (negotiation.ok !== true) {
      return localFailure('not_negotiated', `execution contract unavailable (${negotiation.reason}); staying on the existing backends`)
    }
    if (negotiation.writes !== true) {
      return localFailure('not_negotiated', `execution contract is partial; missing ${negotiation.missingWrite.join(', ')}`)
    }
    return null
  }

  function guardLeaseInput(taskId) {
    if (typeof taskId !== 'string' || taskId === '') return localFailure('invalid_input', 'taskId is required')
    return null
  }

  function guardLeaseId(leaseId) {
    if (typeof leaseId !== 'string' || leaseId === '') return localFailure('invalid_input', 'leaseId is required')
    return null
  }

  async function contract() {
    const response = await request('GET', TASKBOARD_CONTRACT_ENDPOINTS.contract)
    const probeError = response.error ?? null
    negotiation = negotiateContract({
      contract: response.error === undefined ? response.value : null,
      stateMeta,
      probeError,
    })
    return negotiation
  }

  async function leaseExecution(taskId, { route = null, attempt = 1, previousExecutionId = null, idempotencyKey = null, expectedVersion = null } = {}) {
    const guard = requireWrites() ?? guardLeaseInput(taskId)
    if (guard !== null) return guard
    if (!Number.isInteger(attempt) || attempt < 1) return localFailure('invalid_input', 'attempt must be a positive integer')
    if (route !== null && (!isObject(route) || typeof route.provider !== 'string' || typeof route.model !== 'string')) {
      return localFailure('invalid_input', 'route must be { provider, model } when provided')
    }
    if (previousExecutionId !== null && typeof previousExecutionId !== 'string') {
      return localFailure('invalid_input', 'previousExecutionId must be a string when provided')
    }
    if (expectedVersion !== null && !Number.isInteger(expectedVersion)) {
      return localFailure('invalid_input', 'expectedVersion must be an integer when provided')
    }
    const key = typeof idempotencyKey === 'string' && idempotencyKey !== ''
      ? idempotencyKey
      : executionIdempotencyKey({ taskId, attempt })
    const response = await request(
      'POST',
      `/dsh-taskboard/tasks/${encodeURIComponent(taskId)}/executions/lease`,
      {
        route,
        attempt,
        previousExecutionId,
        expectedVersion,
        idempotencyKey: key,
        requestedAt: now(),
      },
    )
    if (response.error !== undefined) return fail(response.error)
    const value = response.value
    if (!isObject(value) || typeof value.leaseId !== 'string' || typeof value.executionId !== 'string') {
      return localFailure('bad_response', 'lease response is missing leaseId/executionId', response.status)
    }
    return { ok: true, status: response.status, value }
  }

  async function attachSession(leaseId, { sessionId, route = null } = {}) {
    const guard = requireWrites() ?? guardLeaseId(leaseId)
    if (guard !== null) return guard
    if (typeof sessionId !== 'string' || sessionId === '') return localFailure('invalid_input', 'sessionId is required')
    const response = await request(
      'POST',
      `/dsh-taskboard/executions/${encodeURIComponent(leaseId)}/attach`,
      { sessionId, route },
    )
    if (response.error !== undefined) return fail(response.error)
    const value = response.value
    if (!isObject(value) || value.leaseId !== leaseId || value.sessionId !== sessionId) {
      return localFailure('bad_response', 'attach response does not echo the lease and session', response.status)
    }
    return { ok: true, status: response.status, value }
  }

  async function submitReport(leaseId, report) {
    const guard = requireWrites() ?? guardLeaseId(leaseId)
    if (guard !== null) return guard
    const normalized = normalizeReport(report)
    if (normalized === null) {
      return localFailure('invalid_input', 'report needs a non-empty summary, bounded string arrays and a ≤2000-char risk')
    }
    const response = await request(
      'POST',
      `/dsh-taskboard/executions/${encodeURIComponent(leaseId)}/report`,
      normalized,
    )
    if (response.error !== undefined) return fail(response.error)
    return { ok: true, status: response.status, value: response.value }
  }

  async function releaseLease(leaseId, { reason = null } = {}) {
    const guard = requireWrites() ?? guardLeaseId(leaseId)
    if (guard !== null) return guard
    if (reason !== null && typeof reason !== 'string') return localFailure('invalid_input', 'reason must be a string when provided')
    const response = await request(
      'POST',
      `/dsh-taskboard/executions/${encodeURIComponent(leaseId)}/release`,
      { reason: reason === null ? '' : reason.slice(0, 500) },
    )
    if (response.error !== undefined) return fail(response.error)
    return { ok: true, status: response.status, value: response.value }
  }

  async function settleExecution(leaseId, { outcome, report = null, requestReview = false } = {}) {
    const guard = requireWrites() ?? guardLeaseId(leaseId)
    if (guard !== null) return guard
    if (!['succeeded', 'failed', 'cancelled'].includes(outcome)) {
      // `done` is a human action; refusing it here makes the rule local, not
      // dependent on the server being careful.
      return localFailure('invalid_input', "outcome must be 'succeeded', 'failed' or 'cancelled'; `done` is human-only")
    }
    if (typeof requestReview !== 'boolean') return localFailure('invalid_input', 'requestReview must be a boolean')
    if (requestReview === true && outcome !== 'succeeded') {
      return localFailure('invalid_input', 'requestReview is only meaningful for a succeeded execution')
    }
    let normalized = null
    if (report !== null && report !== undefined) {
      normalized = normalizeReport(report)
      if (normalized === null) return localFailure('invalid_input', 'settle report is invalid')
    }
    const response = await request(
      'POST',
      `/dsh-taskboard/executions/${encodeURIComponent(leaseId)}/settle`,
      { outcome, report: normalized, requestReview },
    )
    if (response.error !== undefined) return fail(response.error)
    return { ok: true, status: response.status, value: response.value }
  }

  return {
    baseUrl,
    /** The last negotiation outcome, or null before `contract()`. */
    negotiation: () => negotiation,
    supports(feature) {
      return negotiation !== null && negotiation.ok === true && negotiation.features.has(feature)
    },
    contract,
    leaseExecution,
    attachSession,
    submitReport,
    releaseLease,
    settleExecution,
  }
}
