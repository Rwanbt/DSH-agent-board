/**
 * Client for the REAL Task Board public API v1 (contract
 * `D:\App\dsh-taskboard\docs\AGENT-BOARD-CONTRACT.md`, implementation
 * `src/host/public-api.ts` as shipped in Task Board 0.12.0).
 *
 * Unlike `taskboard-contract.js` (a proposal tested against a simulation), this
 * module speaks the surface the installed plugin actually serves:
 *
 *   GET  /dsh-taskboard/public/v1/meta
 *   GET  /dsh-taskboard/public/v1/projects
 *   GET  /dsh-taskboard/public/v1/tasks
 *   GET  /dsh-taskboard/public/v1/tasks/:id
 *   GET  /dsh-taskboard/public/v1/tasks/:id/dependencies
 *   GET  /dsh-taskboard/public/v1/executions/:id
 *   GET  /dsh-taskboard/public/v1/events
 *   POST /dsh-taskboard/public/v1/executions/claim
 *   POST /dsh-taskboard/public/v1/executions/:id/session
 *   POST /dsh-taskboard/public/v1/executions/:id/attempts
 *   POST /dsh-taskboard/public/v1/executions/:id/handoff
 *   POST /dsh-taskboard/public/v1/executions/:id/complete
 *   POST /dsh-taskboard/public/v1/executions/:id/interrupt
 *
 * Every method resolves to `{ ok: true, value }` or
 * `{ ok: false, code, message, status }`. It never throws, never logs, and never
 * puts the bearer token in a result — the token is only ever written to the
 * outgoing `authorization` header. The API is disabled (503) unless the host
 * has `DSH_TASKBOARD_PUBLIC_TOKEN` configured at launch.
 *
 * @module dsh-agent-board/connectors/taskboard-public
 */

/** Public API version this client implements (`meta.apiVersion`). */
export const PUBLIC_API_VERSION = 1

/** Route prefix of the public contract. */
export const PUBLIC_API_BASE_PATH = '/dsh-taskboard/public/v1'

/** Environment variable the Task Board host reads its bearer token from. */
export const PUBLIC_API_TOKEN_ENV = 'DSH_TASKBOARD_PUBLIC_TOKEN'

/** Client operations, in the order of GOAL6 §4.1. */
export const PUBLIC_API_OPERATIONS = Object.freeze([
  'meta',
  'projects',
  'listTasks',
  'task',
  'dependencies',
  'execution',
  'events',
  'claim',
  'attachSession',
  'attempt',
  'handoff',
  'complete',
  'interrupt',
])

/** Capability states used by {@link capabilitiesOf}. */
export const CAPABILITY_STATES = Object.freeze({
  available: 'available',
  unsupported: 'unsupported',
  unconfigured: 'unconfigured',
})

/** Codes documented by the Task Board contract v1 (AGENT-BOARD-CONTRACT §6). */
export const DOCUMENTED_PUBLIC_CODES = Object.freeze([
  'public_api_disabled',
  'unauthorized',
  'invalid_input',
  'not_found',
  'forbidden',
  'already_claimed',
  'dependency_blocked',
  'version_conflict',
  'stale_execution',
  'internal',
])

/**
 * Client-local codes (no HTTP response involved, `status: 0`, except
 * `bad_response`/`http_error` which carry the received status).
 */
export const LOCAL_PUBLIC_CODES = Object.freeze([
  'unconfigured',
  'unreachable',
  'timeout',
  'bad_response',
  'http_error',
])

const DEFAULT_TIMEOUT_MS = 4_000
const MAX_MESSAGE_CHARS = 600

/** Read-only operations: available as soon as `/meta` speaks API v1. */
const READ_OPERATIONS = Object.freeze(['meta', 'projects', 'listTasks', 'task', 'dependencies', 'execution'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Normalize an explicit base URL. A bare origin gets the documented API base
 * path appended; an explicit path is preserved (reverse proxies). Credentials
 * embedded in the URL are dropped so they can never reach a payload or a log.
 *
 * @param {unknown} baseUrl
 * @returns {string|null}
 */
function normalizeApiBase(baseUrl) {
  if (!nonEmptyString(baseUrl)) return null
  let url
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '' ? PUBLIC_API_BASE_PATH : path}`
}

function capability(state, reason = null) {
  return { state, reason }
}

function allUnavailable(state, reason) {
  const out = {}
  for (const operation of PUBLIC_API_OPERATIONS) out[operation] = capability(state, reason)
  return out
}

function unwrapMeta(meta) {
  if (isObject(meta) && meta.ok === true && Object.prototype.hasOwnProperty.call(meta, 'value')) return meta.value
  return meta
}

/**
 * Honest per-operation capability map derived from a `/meta` payload.
 *
 * Each operation maps to `{ state: 'available'|'unsupported'|'unconfigured',
 * reason }`. `reason` is `null` when available and a stable machine-readable
 * string otherwise (`meta_unavailable`, `unsupported_api_version:<v>`,
 * `unexpected_product`, `unsupported_auth`, `done_policy_not_user_only`,
 * `feature_not_announced:<feature>`). Reads are judged only on the API
 * identity; writes additionally require a user-only `donePolicy`, so an
 * unknown server can never be described as able to settle tasks.
 *
 * @param {unknown} meta a `/meta` value (an `{ok:true,value}` envelope is also accepted)
 * @returns {Record<string, {state: string, reason: string|null}>}
 */
export function capabilitiesOf(meta) {
  const payload = unwrapMeta(meta)
  if (!isObject(payload)) return allUnavailable(CAPABILITY_STATES.unconfigured, 'meta_unavailable')
  if (payload.apiVersion !== PUBLIC_API_VERSION) {
    return allUnavailable(CAPABILITY_STATES.unsupported, `unsupported_api_version:${String(payload.apiVersion)}`)
  }
  if (payload.name !== 'dsh-taskboard') return allUnavailable(CAPABILITY_STATES.unsupported, 'unexpected_product')
  if (payload.auth !== 'bearer') return allUnavailable(CAPABILITY_STATES.unsupported, 'unsupported_auth')

  const features = isObject(payload.features) ? payload.features : {}
  const donePolicyOk = payload.donePolicy === 'user-only'
  const capabilities = {}

  for (const operation of READ_OPERATIONS) capabilities[operation] = capability(CAPABILITY_STATES.available)

  capabilities.events = features.events === true || nonEmptyString(features.events)
    ? capability(CAPABILITY_STATES.available)
    : capability(CAPABILITY_STATES.unsupported, 'feature_not_announced:events')

  const writeFeature = (operation, feature) => {
    if (!donePolicyOk) {
      capabilities[operation] = capability(CAPABILITY_STATES.unsupported, 'done_policy_not_user_only')
      return
    }
    capabilities[operation] = features[feature] === true
      ? capability(CAPABILITY_STATES.available)
      : capability(CAPABILITY_STATES.unsupported, `feature_not_announced:${feature}`)
  }

  writeFeature('claim', 'claim')
  // Session binding is part of the execution envelope opened by a claim; the
  // contract does not advertise a separate `sessions` feature.
  writeFeature('attachSession', 'claim')
  writeFeature('attempt', 'attempts')
  writeFeature('handoff', 'handoff')
  writeFeature('complete', 'claim')
  writeFeature('interrupt', 'claim')

  return capabilities
}

/**
 * UI-safe description of a Task Board public API configuration.
 *
 * Only `configured`, `baseUrl` and `tokenPresent` are returned; the token value
 * is never part of the object, not even redacted.
 *
 * @param {{baseUrl?: unknown, token?: unknown}} [config]
 * @returns {{configured: boolean, baseUrl: string|null, tokenPresent: boolean}}
 */
export function describePublicTaskBoard(config = {}) {
  const source = isObject(config) ? config : {}
  const baseUrl = normalizeApiBase(source.baseUrl)
  const tokenPresent = typeof source.token === 'string' && source.token.trim().length > 0
  return { configured: baseUrl !== null && tokenPresent, baseUrl, tokenPresent }
}

/**
 * Create a Task Board public API v1 client.
 *
 * `baseUrl` is the only source of the origin (no discovery, no environment
 * probe at import time). Pass the GUI origin or the full
 * `/dsh-taskboard/public/v1` base path; a bare origin gets the documented path
 * appended. Without a base URL, a token, or a fetch implementation the client
 * is `configured: false` and every method refuses locally with
 * `code: 'unconfigured'` before any network access.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] GUI origin or full public API base
 * @param {string} [options.token] `DSH_TASKBOARD_PUBLIC_TOKEN` value
 * @param {Function} [options.fetchImpl] fetch-compatible implementation
 * @param {Function} [options.now] accepted for call-site symmetry (public v1
 *   requests carry no client timestamp)
 * @param {number} [options.timeoutMs] hard per-request timeout (default 4000)
 */
export function createPublicTaskBoardClient(options = {}) {
  const config = isObject(options) ? options : {}
  const baseUrl = normalizeApiBase(config.baseUrl)
  // The Task Board trims both the configured token and the Authorization
  // candidate; mirror that so a stray space never looks like a valid config.
  const token = typeof config.token === 'string' && config.token.trim().length > 0
    ? config.token.trim()
    : null
  const fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) && Number(config.timeoutMs) > 0
    ? Math.trunc(Number(config.timeoutMs))
    : DEFAULT_TIMEOUT_MS
  const configured = baseUrl !== null && token !== null && typeof fetchImpl === 'function'

  function redact(message) {
    let text = typeof message === 'string' ? message : String(message ?? '')
    if (token !== null) text = text.split(token).join('[redacted]')
    if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}...`
    return text
  }

  function failure(code, message, status = 0) {
    return { ok: false, code, message: redact(message), status }
  }

  function unconfiguredReason() {
    if (baseUrl === null) return 'Task Board public API baseUrl is missing or invalid'
    if (token === null) return `Task Board public API token is missing (set ${PUBLIC_API_TOKEN_ENV} and restart the host)`
    return 'no fetch implementation is available'
  }

  function codeForStatus(status) {
    switch (status) {
      case 400:
      case 422: return 'invalid_input'
      case 401: return 'unauthorized'
      case 403: return 'forbidden'
      case 404: return 'not_found'
      case 500: return 'internal'
      case 503: return 'public_api_disabled'
      default: return 'http_error'
    }
  }

  function interpret(response, payload) {
    const status = Number(response?.status) || 0
    const envelopeError = isObject(payload) && isObject(payload.error) ? payload.error : null
    const hasCode = envelopeError !== null && nonEmptyString(envelopeError.code)
    const serverMessage = envelopeError !== null && typeof envelopeError.message === 'string' ? envelopeError.message : null

    if (response?.ok !== true) {
      return failure(
        hasCode ? envelopeError.code : codeForStatus(status),
        serverMessage ?? `Task Board public API refused the request (HTTP ${status})`,
        status,
      )
    }
    if (isObject(payload) && payload.ok === true && Object.prototype.hasOwnProperty.call(payload, 'value')) {
      return { ok: true, value: payload.value }
    }
    if (hasCode) {
      return failure(envelopeError.code, serverMessage ?? 'Task Board public API returned an error envelope', status)
    }
    return failure('bad_response', 'Task Board public API returned a response that is not an { ok, value } envelope', status)
  }

  /**
   * Perform one request. All transport, timeout, envelope and error handling
   * lives here so no method can throw or leak the token.
   */
  async function request(method, path, { query, body } = {}) {
    if (!configured) return failure('unconfigured', unconfiguredReason())

    let url
    try {
      url = new URL(`${baseUrl}${path}${query === undefined ? '' : `?${query}`}`)
    } catch {
      return failure('invalid_input', 'Task Board public API request URL is invalid')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    try {
      let response
      try {
        response = await fetchImpl(url.toString(), {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) return failure('timeout', `Task Board public API timed out after ${timeoutMs} ms`)
        return failure('unreachable', `Task Board public API unreachable: ${error?.message ?? error}`)
      }
      if (!isObject(response) || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
        return failure('bad_response', 'fetch implementation returned no usable HTTP response')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        // A body that stalls past the deadline is a timeout, not a malformed
        // envelope: the request was aborted while it was still streaming.
        if (controller.signal.aborted) return failure('timeout', `Task Board public API timed out after ${timeoutMs} ms`)
        payload = null
      }
      return interpret(response, payload)
    } catch (error) {
      // Defensive: a hostile fetch/Response implementation must not turn a
      // connection attempt into an exception for the orchestrator.
      if (controller.signal.aborted) return failure('timeout', `Task Board public API timed out after ${timeoutMs} ms`)
      return failure('unreachable', `Task Board public API request failed: ${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }
  }

  function queryOf(params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        const list = value.filter(entry => typeof entry === 'string' && entry !== '')
        if (list.length > 0) search.set(key, list.join(','))
      } else if (typeof value === 'boolean') {
        search.set(key, value ? 'true' : 'false')
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        search.set(key, String(value))
      } else if (typeof value === 'string' && value !== '') {
        search.set(key, value)
      }
    }
    const text = search.toString()
    return text === '' ? undefined : text
  }

  function requestId(value, label = 'id') {
    return nonEmptyString(value) ? null : failure('invalid_input', `${label} must be a non-empty string`)
  }

  function requestString(value, label) {
    return nonEmptyString(value) ? null : failure('invalid_input', `${label} is required`)
  }

  function optionalString(args, key) {
    if (args[key] === undefined || args[key] === null) return null
    return nonEmptyString(args[key]) ? null : failure('invalid_input', `${key} must be a non-empty string when provided`)
  }

  function optionalFence(args) {
    if (args.ifFencingToken === undefined || args.ifFencingToken === null) return null
    return Number.isInteger(args.ifFencingToken) && args.ifFencingToken > 0
      ? null
      : failure('invalid_input', 'ifFencingToken must be a positive integer when provided')
  }

  function lifecycleBody(args, extra = {}) {
    return {
      actor: args.actor,
      ...(nonEmptyString(args.sessionId) ? { sessionId: args.sessionId } : {}),
      ...(nonEmptyString(args.reason) ? { reason: args.reason } : {}),
      ...(Number.isInteger(args.ifFencingToken) ? { ifFencingToken: args.ifFencingToken } : {}),
      ...extra,
    }
  }

  async function meta() {
    return request('GET', '/meta')
  }

  async function projects() {
    return request('GET', '/projects')
  }

  async function listTasks(input = {}) {
    const args = isObject(input) ? input : {}
    return request('GET', '/tasks', {
      query: queryOf({
        status: args.status,
        workspaceId: args.workspaceId,
        eligible: args.eligible,
        limit: args.limit,
        cursor: args.cursor,
      }),
    })
  }

  async function task(id) {
    const guard = requestId(id)
    if (guard !== null) return guard
    return request('GET', `/tasks/${encodeURIComponent(id)}`)
  }

  async function dependencies(id) {
    const guard = requestId(id)
    if (guard !== null) return guard
    return request('GET', `/tasks/${encodeURIComponent(id)}/dependencies`)
  }

  async function execution(id) {
    const guard = requestId(id)
    if (guard !== null) return guard
    return request('GET', `/executions/${encodeURIComponent(id)}`)
  }

  async function events(input = {}) {
    const args = isObject(input) ? input : {}
    return request('GET', '/events', { query: queryOf({ since: args.since, limit: args.limit }) })
  }

  async function claim(input = {}) {
    const args = isObject(input) ? input : {}
    const guard = requestId(args.taskId, 'taskId')
      ?? requestString(args.actor, 'actor')
      ?? optionalString(args, 'workspaceId')
      ?? optionalString(args, 'sessionId')
    if (guard !== null) return guard
    if (!nonEmptyString(args.idempotencyKey)) {
      // A claim without an idempotency key cannot be replayed safely: the
      // host may have committed the mutation before the transport failed.
      return failure('invalid_input', 'idempotencyKey is required for claim; no claim is sent without it')
    }
    return request('POST', '/executions/claim', {
      body: {
        taskId: args.taskId,
        actor: args.actor,
        ...(nonEmptyString(args.workspaceId) ? { workspaceId: args.workspaceId } : {}),
        ...(nonEmptyString(args.sessionId) ? { sessionId: args.sessionId } : {}),
        idempotencyKey: args.idempotencyKey,
      },
    })
  }

  async function attachSession(id, input = {}) {
    const args = isObject(input) ? input : {}
    const guard = requestId(id)
      ?? requestString(args.actor, 'actor')
      ?? requestString(args.sessionId, 'sessionId')
      ?? optionalFence(args)
    if (guard !== null) return guard
    return request('POST', `/executions/${encodeURIComponent(id)}/session`, {
      body: lifecycleBody(args),
    })
  }

  async function attempt(id, input = {}) {
    const args = isObject(input) ? input : {}
    const guard = requestId(id)
      ?? requestString(args.actor, 'actor')
      ?? requestString(args.reason, 'reason')
      ?? optionalString(args, 'sessionId')
      ?? optionalFence(args)
    if (guard !== null) return guard
    return request('POST', `/executions/${encodeURIComponent(id)}/attempts`, {
      body: lifecycleBody(args),
    })
  }

  async function handoff(id, input = {}) {
    const args = isObject(input) ? input : {}
    const guard = requestId(id)
      ?? requestString(args.actor, 'actor')
      ?? requestString(args.fromSessionId, 'fromSessionId')
      ?? requestString(args.toSessionId, 'toSessionId')
      ?? optionalString(args, 'reason')
      ?? optionalFence(args)
    if (guard !== null) return guard
    return request('POST', `/executions/${encodeURIComponent(id)}/handoff`, {
      body: lifecycleBody(args, {
        fromSessionId: args.fromSessionId,
        toSessionId: args.toSessionId,
      }),
    })
  }

  async function complete(id, input = {}) {
    const args = isObject(input) ? input : {}
    const guard = requestId(id)
      ?? requestString(args.actor, 'actor')
      ?? optionalString(args, 'comment')
      ?? optionalFence(args)
    if (guard !== null) return guard
    if (!['succeeded', 'failed', 'cancelled'].includes(args.outcome)) {
      // `done` is the human's confirmation in the Task Board UI. Refusing it
      // locally keeps the rule independent from a server-side typo.
      return failure('invalid_input', "outcome must be 'succeeded', 'failed' or 'cancelled'; `done` is human-only")
    }
    if (args.report !== undefined && args.report !== null && !isObject(args.report)) {
      return failure('invalid_input', 'report must be an object when provided')
    }
    return request('POST', `/executions/${encodeURIComponent(id)}/complete`, {
      body: lifecycleBody(args, {
        outcome: args.outcome,
        ...(nonEmptyString(args.comment) ? { comment: args.comment } : {}),
        ...(args.report === undefined || args.report === null ? {} : { report: args.report }),
      }),
    })
  }

  async function interrupt(id, input = {}) {
    const args = isObject(input) ? input : {}
    const guard = requestId(id)
      ?? requestString(args.actor, 'actor')
      ?? optionalString(args, 'reason')
      ?? optionalFence(args)
    if (guard !== null) return guard
    return request('POST', `/executions/${encodeURIComponent(id)}/interrupt`, {
      body: lifecycleBody(args),
    })
  }

  return {
    configured,
    baseUrl,
    meta,
    projects,
    listTasks,
    task,
    dependencies,
    execution,
    events,
    claim,
    attachSession,
    attempt,
    handoff,
    complete,
    interrupt,
  }
}
