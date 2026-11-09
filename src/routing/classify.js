/**
 * Failure classification for the multi-provider router.
 *
 * The classifier answers three different questions and must not confuse them:
 *   - is this retryable on the SAME route?      (`retryable`)
 *   - is this a route/provider problem at all?  (`switchable`)
 *   - can the in-flight request be repaired at all, or does the TASK need a
 *     checkpoint + handoff? (`requiresHandoff`, e.g. an error after the first
 *     streamed chunk)
 *
 * It also refuses to disguise non-model failures as provider outages: a failing
 * test, a CI red build or a code bug is `notModel` and must never trigger a
 * silent provider switch. A security/policy refusal is `policy_refusal` and is
 * never routed around.
 *
 * @module dsh-agent-board/routing/classify
 */

export const FAILURE = Object.freeze({
  RATE_LIMIT: 'rate_limit',
  OVERLOADED: 'overloaded',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  TRANSPORT: 'transport',
  QUOTA: 'quota',
  AUTH: 'auth',
  AUTHZ: 'authz',
  CONTEXT_OVERFLOW: 'context_overflow',
  MODEL_UNAVAILABLE: 'model_unavailable',
  PARTIAL_STREAM: 'partial_stream',
  POLICY_REFUSAL: 'policy_refusal',
  NOT_MODEL: 'not_model',
  UNKNOWN: 'unknown',
})

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'])
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH'])

const SAFETY_PATTERN = /(content policy|safety|policy refusal|moderation|refus(?:al|é)|not permitted|permission denied|tool not allowed)/i
const NOT_MODEL_PATTERN = /(assertion|test suite failed|failing test|tests? failed|build failed|type ?error|typescript|syntaxerror|eslint|ci (?:failed|red)|compile error)/i
const QUOTA_PATTERN = /(quota|insufficient[ _]?(?:balance|credit|funds)|billing|out of credits|usage limit|plan limit)/i
const CONTEXT_PATTERN = /(context (?:length|window)|maximum context|too many tokens|prompt is too long|context_length_exceeded)/i
const AUTH_PATTERN = /(invalid[ _]?api[ _]?key|unauthori[sz]ed|token (?:expired|invalid)|authentication failed|401)/i
const OVERLOAD_PATTERN = /(overloaded|service unavailable|temporarily unavailable|529)/i
const RATE_LIMIT_PATTERN = /(rate[ _-]?limit|too many requests|throttl|429)/i
const MISSING_CREDENTIALS_PATTERN = /(no api[ _-]?key|missing api[ _-]?key|api[ _-]?key (?:is )?(?:missing|not (?:set|configured|found))|missing credentials?|credentials? (?:are )?(?:missing|not (?:set|configured|available))|no credential)/i
const MODEL_UNAVAILABLE_PATTERN = /((?:model|deployment) (?:[^.\n]{0,40}?)(?:not found|unavailable|does not exist|no longer|deleted|removed|unsupported))|no such model|model_not_found/i
const TRANSPORT_PATTERN = /(ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|socket hang up|network error|connection reset)/i

/**
 * @param {object|Error} input
 * @param {number} [input.status] HTTP status when known
 * @param {string} [input.code] transport error code
 * @param {string} [input.message]
 * @param {boolean} [input.afterFirstChunk] true when output was already emitted
 * @param {number} [input.retryAfterMs]
 * @param {string} [input.phase] 'request' | 'stream' | 'tool'
 */
export function classifyFailure(input = {}) {
  const message = typeof input.message === 'string'
    ? input.message
    : (typeof input?.error?.message === 'string' ? input.error.message : '')
  const rawStatus = Number(input.status ?? input?.error?.status)
  // Providers sometimes only put the HTTP code in the message; infer it once so
  // the rest of the classifier reasons on one authoritative status value.
  const inferred = Number((message.match(/\b(401|403|408|429|5\d\d)\b/) ?? [])[1])
  const status = Number.isFinite(rawStatus) ? rawStatus : (Number.isFinite(inferred) ? inferred : NaN)
  const code = String(input.code ?? input?.error?.code ?? '')
  const afterFirstChunk = input.afterFirstChunk === true
  const text = `${code} ${message}`

  const base = { status: Number.isFinite(status) ? status : null, message: message.slice(0, 300), afterFirstChunk }

  // Explicit non-model failures win over everything: a red build is not an outage.
  if (NOT_MODEL_PATTERN.test(text)) {
    return { ...base, kind: FAILURE.NOT_MODEL, retryable: false, switchable: false, requiresHandoff: false, notModel: true, retryAfterMs: null }
  }
  // A refusal is a decision, not a fault: never bypass it with another provider.
  // A 403 is a policy refusal UNLESS it is an authentication/permission failure
  // of the provider itself (then another provider can legitimately serve us).
  if (SAFETY_PATTERN.test(text) && !(status === 403 && AUTH_PATTERN.test(text))) {
    return { ...base, kind: FAILURE.POLICY_REFUSAL, retryable: false, switchable: false, requiresHandoff: false, notModel: false, retryAfterMs: null }
  }
  if (status === 403 && !AUTH_PATTERN.test(text)) {
    return { ...base, kind: FAILURE.POLICY_REFUSAL, retryable: false, switchable: false, requiresHandoff: false, notModel: false, retryAfterMs: null }
  }
  if (CONTEXT_PATTERN.test(text)) {
    return { ...base, kind: FAILURE.CONTEXT_OVERFLOW, retryable: false, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  // A missing/absent credential is a configuration fault, not a transient one:
  // retrying the same route can never succeed, but another route may hold a
  // valid credential, so a switch is legitimate.
  if (MISSING_CREDENTIALS_PATTERN.test(text) && status !== 401) {
    return { ...base, kind: FAILURE.AUTH, retryable: false, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  if (QUOTA_PATTERN.test(text)) {
    return { ...base, kind: FAILURE.QUOTA, retryable: false, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  if (status === 401 || AUTH_PATTERN.test(text)) {
    return { ...base, kind: FAILURE.AUTH, retryable: false, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  // Rate limiting is recognised from the STATUS or from the wording: providers
  // often say "Too many requests" without ever printing the number 429.
  if (status === 429 || RATE_LIMIT_PATTERN.test(text)) {
    const retryAfterMs = Number.isFinite(Number(input.retryAfterMs)) ? Number(input.retryAfterMs) : null
    return { ...base, kind: FAILURE.RATE_LIMIT, retryable: true, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs }
  }
  // A model that no longer exists (or is not deployed for this account) is a
  // route problem: retry on the same model can never succeed.
  if (MODEL_UNAVAILABLE_PATTERN.test(text) || status === 404) {
    return { ...base, kind: FAILURE.MODEL_UNAVAILABLE, retryable: false, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  if (status === 408 || status === 504 || TIMEOUT_CODES.has(code) || /timeout|timed out/i.test(message)) {
    return { ...base, kind: FAILURE.TIMEOUT, retryable: true, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  if (status >= 500 && status < 600) {
    return { ...base, kind: status === 529 || OVERLOAD_PATTERN.test(text) ? FAILURE.OVERLOADED : FAILURE.SERVER_ERROR, retryable: true, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  if (TRANSPORT_CODES.has(code) || TRANSPORT_PATTERN.test(text)) {
    return { ...base, kind: FAILURE.TRANSPORT, retryable: true, switchable: true, requiresHandoff: afterFirstChunk, notModel: false, retryAfterMs: null }
  }
  if (afterFirstChunk) {
    // Stream already started: the same request cannot be silently replaced.
    return { ...base, kind: FAILURE.PARTIAL_STREAM, retryable: false, switchable: true, requiresHandoff: true, notModel: false, retryAfterMs: null }
  }
  return { ...base, kind: FAILURE.UNKNOWN, retryable: true, switchable: false, requiresHandoff: false, notModel: false, retryAfterMs: null }
}

/** Retry-After is either delta-seconds or an HTTP-date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, Math.trunc(seconds * 1000))
  const date = Date.parse(String(value))
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return null
}
