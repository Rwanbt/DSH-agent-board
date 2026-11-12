/**
 * Durable Super Agent identity and its recyclable session envelope.
 *
 * The identity is the part that survives a session cycle: agent id, model
 * pinning, autonomy mirror, generation counter and the session bookkeeping
 * (recycle count, last turn, last error). Everything here is pure and
 * deterministic: no clock, no randomness, no I/O. Callers inject `now`, and
 * ids are derived from content so two identical calls produce identical state.
 *
 * Normalization never throws. Garbage in (null, arrays, hostile keys, huge
 * strings, Python-style timestamps) yields a safe L0/idle identity; unknown
 * keys are dropped instead of copied, so a polluted payload cannot smuggle
 * `__proto__`, tokens or a session transcript into persisted state.
 *
 * @module dsh-agent-board/superagent/identity
 */

/** Bound for every free-form string persisted in an identity. */
export const IDENTITY_TEXT_LIMIT = 400

const DEFAULT_NAME = 'Super Agent'
const DEFAULT_STATUS = 'idle'
const DEFAULT_LEVEL = 'L0'

const LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4'])
const STATUSES = Object.freeze(['idle', 'thinking', 'waiting_human', 'paused', 'stopped', 'error'])

/**
 * Secret-shaped substrings are redacted anywhere an identity string could be
 * surfaced. The persistence layer must never carry a credential, even when a
 * caller pasted one into a name, a recycle reason or an error message.
 */
const SECRET_PATTERNS = Object.freeze([
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*)["']?[^\s,;"'}]+/gi,
])

function redactSecrets(text) {
  let out = text.replace(/\bsk-[A-Za-z0-9]{8,}\b/g, '[redacted]')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match, prefix) => `${prefix}[redacted]`)
  return out
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, max = IDENTITY_TEXT_LIMIT) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** Coerce a timestamp without ever throwing (Symbols, proxies, arrays…). */
function finiteInt(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return fallback
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  }
  return fallback
}

function clampInt(value, min, max, fallback) {
  const parsed = finiteInt(value, null)
  if (parsed === null) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Deterministic FNV-1a-ish digest (two independent 32-bit lanes, 16 hex chars). */
function hashText(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

function emptySession() {
  // `endedAt` stays null on a recycle request: requestRecycle has no injected
  // `now`, and a fabricated timestamp would be a lie in the audit trail.
  return {
    sessionId: null,
    active: false,
    createdAt: null,
    endedAt: null,
    recycledCount: 0,
    recycleReason: null,
    lastTurnAt: null,
    lastError: null,
  }
}

function normalizeLevel(value) {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return LEVELS.includes(text) ? text : DEFAULT_LEVEL
}

function normalizeStatus(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return STATUSES.includes(text) ? text : DEFAULT_STATUS
}

/**
 * Model pinning. An incomplete or non-object model normalizes to `null`:
 * "no model resolved" is honest, whereas inventing a provider is a fictional
 * capability. Unknown keys (`apiKey`, `headers`…) are never copied.
 */
function normalizeModel(raw) {
  if (!isRecord(raw)) return null
  const provider = boundedText(raw.provider, 80)
  const model = boundedText(raw.model, 120)
  if (provider === '' || model === '') return null
  const reasoningEffort = boundedText(raw.reasoningEffort, 40)
  const fallback = []
  if (Array.isArray(raw.fallback)) {
    for (const entry of raw.fallback) {
      if (fallback.length >= 3) break
      if (!isRecord(entry)) continue
      const entryProvider = boundedText(entry.provider, 80)
      const entryModel = boundedText(entry.model, 120)
      if (entryProvider === '' || entryModel === '') continue
      fallback.push({ provider: entryProvider, model: entryModel })
    }
  }
  return {
    provider,
    model,
    reasoningEffort: reasoningEffort === '' ? null : reasoningEffort,
    fallback,
  }
}

function normalizeSession(raw) {
  const session = emptySession()
  if (!isRecord(raw)) return session
  const sessionId = boundedText(raw.sessionId, 120)
  session.sessionId = sessionId === '' ? null : sessionId
  session.active = raw.active === true
  session.createdAt = finiteInt(raw.createdAt, null)
  session.endedAt = finiteInt(raw.endedAt, null)
  session.recycledCount = clampInt(raw.recycledCount, 0, 100000, 0)
  const recycleReason = boundedText(raw.recycleReason, IDENTITY_TEXT_LIMIT)
  session.recycleReason = recycleReason === '' ? null : redactSecrets(recycleReason)
  session.lastTurnAt = finiteInt(raw.lastTurnAt, null)
  const lastError = boundedText(raw.lastError, IDENTITY_TEXT_LIMIT)
  session.lastError = lastError === '' ? null : redactSecrets(lastError)
  return session
}

function derivedAgentId(createdAt, model) {
  const provider = model?.provider ?? ''
  const modelName = model?.model ?? ''
  return `super-agent-${hashText(`identity:${createdAt}:${provider}:${modelName}`)}`
}

/**
 * Create a brand-new identity at L0/idle. `agentId` is optional; without one
 * the id is derived from the creation timestamp and model pinning, so the
 * result is deterministic and contains no randomness.
 *
 * @param {{now?: number, agentId?: string, model?: object}} [input]
 * @returns {object}
 */
export function createIdentity({ now, agentId, model } = {}) {
  const createdAt = finiteInt(now, 0) ?? 0
  const normalizedModel = normalizeModel(model)
  const explicitId = boundedText(agentId, 200)
  return {
    agentId: explicitId === '' ? derivedAgentId(createdAt, normalizedModel) : explicitId,
    name: DEFAULT_NAME,
    createdAt,
    model: normalizedModel,
    level: DEFAULT_LEVEL,
    status: DEFAULT_STATUS,
    generation: 0,
    session: emptySession(),
  }
}

/**
 * Normalize any stored/attacker-supplied identity. Accepts either the identity
 * itself or a Super Agent slice carrying `identity`/`session` siblings (the
 * shape in the contract). Unknown keys are dropped, never merged.
 *
 * @param {unknown} raw
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function normalizeIdentity(raw, { now } = {}) {
  const record = isRecord(raw) ? raw : {}
  const hasNestedIdentity = isRecord(record.identity)
  const source = hasNestedIdentity ? record.identity : record
  const sessionSource = hasNestedIdentity ? record.session : source.session
  const fallbackNow = finiteInt(now, 0) ?? 0
  const createdAt = finiteInt(source.createdAt, fallbackNow) ?? 0
  const model = normalizeModel(source.model)
  const agentId = boundedText(source.agentId, 200)
  const name = boundedText(source.name, IDENTITY_TEXT_LIMIT)
  return {
    agentId: agentId === '' ? derivedAgentId(createdAt, model) : agentId,
    name: name === '' ? DEFAULT_NAME : name,
    createdAt,
    model,
    level: normalizeLevel(source.level),
    status: normalizeStatus(source.status),
    generation: clampInt(source.generation, 0, 1000000, 0),
    session: normalizeSession(sessionSource),
  }
}

/**
 * The projection safe to publish in state, logs and SSE: no session, no
 * transcript, no credential-shaped strings. Explicit field construction means
 * unknown keys can never leak even if the caller passes a raw record.
 *
 * @param {unknown} identity
 * @returns {object}
 */
export function publicIdentityOf(identity) {
  const normalized = normalizeIdentity(identity, { now: 0 })
  const model = normalized.model
  return {
    agentId: redactSecrets(normalized.agentId),
    name: redactSecrets(normalized.name),
    createdAt: normalized.createdAt,
    model: model === null
      ? null
      : {
          provider: model.provider,
          model: model.model,
          reasoningEffort: model.reasoningEffort,
          fallback: model.fallback.map(entry => ({ provider: entry.provider, model: entry.model })),
        },
    level: normalized.level,
    status: normalized.status,
    generation: normalized.generation,
  }
}

/**
 * Record one completed cycle: bump `generation`, stamp `lastTurnAt`, and map
 * the outcome onto the status enum. A paused/stopped identity is never
 * resurrected to idle by a cycle.
 *
 * @param {unknown} identity
 * @param {{at?: number, outcome?: string}} [input]
 * @returns {object}
 */
export function markCycle(identity, { at, outcome } = {}) {
  const base = normalizeIdentity(identity, { now: at })
  const atValue = finiteInt(at, base.createdAt) ?? base.createdAt
  const outcomeText = boundedText(outcome, 40).toLowerCase()
  let status = base.status
  if (outcomeText === 'error' || outcomeText === 'failed' || outcomeText === 'failure') status = 'error'
  else if (outcomeText === 'waiting_human' || outcomeText === 'waiting') status = 'waiting_human'
  else if (base.status !== 'paused' && base.status !== 'stopped') status = 'idle'
  const lastError = status === 'error'
    ? (redactSecrets(boundedText(outcome, IDENTITY_TEXT_LIMIT)) || 'cycle_error')
    : null
  return {
    ...base,
    status,
    generation: base.generation + 1,
    session: { ...base.session, lastTurnAt: atValue, lastError },
  }
}

/**
 * Ask for a new session. The old session is closed, the recycle counter moves
 * forward and `generation` increments so stale session output is fenced off.
 * A stopped identity stays stopped: recycling is not a resume.
 *
 * @param {unknown} identity
 * @param {string} [reason]
 * @returns {object}
 */
export function requestRecycle(identity, reason) {
  const base = normalizeIdentity(identity, { now: null })
  const recycleReason = redactSecrets(boundedText(reason, IDENTITY_TEXT_LIMIT)) || 'requested'
  return {
    ...base,
    status: base.status === 'stopped' ? 'stopped' : 'idle',
    generation: base.generation + 1,
    session: {
      ...base.session,
      active: false,
      sessionId: null,
      endedAt: null,
      recycledCount: base.session.recycledCount + 1,
      recycleReason,
    },
  }
}
