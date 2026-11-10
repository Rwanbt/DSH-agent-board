/**
 * Stable domain contracts for the Agent Board.
 *
 * These names are the ones the rest of the plugin (and any future adapter)
 * codes against: ProjectRef, WorkItemRef, AgentNode, Assignment, Mandate,
 * Checkpoint, RoutePolicy, ProviderHealthEvent, AuditEvent. They are plain
 * JSON shapes on purpose — the journal, the HTTP API and the client all
 * serialize them, and a future storage migration must be able to read them.
 *
 * @module dsh-agent-board/contracts/model
 */

export const SCHEMA_VERSION = 1

/**
 * Native-ish agent statuses. Never derived from elapsed time alone.
 *
 * Six different facts are kept apart on purpose:
 *   - session state      -> `unavailable` (the runtime says the agent is gone)
 *   - turn state         -> `running` / `finished_*` / `failed`
 *   - agent state        -> `waiting_user` / `recovering`
 *   - assignment state   -> `interrupted` (lease/assignment facts: the launch
 *                           was stopped, superseded, or its agent vanished)
 *   - provider state     -> `provider_unavailable` (only from an injected
 *                           provider-health table inside its cooldown)
 *   - task state         -> the Task Board ledger (never mirrored as a status)
 *   - user read state    -> `finished_unread` vs `finished_read` (persisted ack)
 *
 * There is deliberately NO `waiting_agent` status: DSH exposes no trustworthy
 * per-session signal for "this agent is waiting for another agent" (see
 * `supervisor/projection.js` for the investigated sources).
 */
export const STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING_USER: 'waiting_user',
  RECOVERING: 'recovering',
  INTERRUPTED: 'interrupted',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  FINISHED_UNREAD: 'finished_unread',
  FINISHED_READ: 'finished_read',
  FAILED: 'failed',
  IDLE: 'idle',
  UNKNOWN: 'unknown',
  UNAVAILABLE: 'unavailable',
})

export const STATUS_VALUES = Object.freeze(Object.values(STATUS))

/** Statuses that mean "the user still has something to look at". */
export const ATTENTION_STATUSES = Object.freeze([
  STATUS.WAITING_USER,
  STATUS.INTERRUPTED,
  STATUS.FAILED,
  STATUS.FINISHED_UNREAD,
  STATUS.RECOVERING,
  STATUS.PROVIDER_UNAVAILABLE,
])

/** Ranking used for stable ordering (lower = shown first). */
export const STATUS_RANK = Object.freeze({
  [STATUS.WAITING_USER]: 0,
  [STATUS.RUNNING]: 1,
  [STATUS.RECOVERING]: 2,
  [STATUS.INTERRUPTED]: 2.2,
  [STATUS.PROVIDER_UNAVAILABLE]: 2.4,
  [STATUS.FINISHED_UNREAD]: 3,
  [STATUS.FAILED]: 4,
  [STATUS.IDLE]: 5,
  [STATUS.FINISHED_READ]: 6,
  [STATUS.UNKNOWN]: 7,
  [STATUS.UNAVAILABLE]: 8,
})

/** Turn-end kinds that must be surfaced as a failure, not as "finished". */
export const ERROR_TURN_KINDS = Object.freeze(['error', 'failed'])
/** Turn-end kinds that mean the work was interrupted, not completed. */
export const INTERRUPTED_TURN_KINDS = Object.freeze(['aborted', 'blocked'])

/** Orchestration modes. Default is always `off`. */
export const MODES = Object.freeze({
  OFF: 'off',
  SUPERVISED: 'supervised',
  AUTONOMOUS: 'autonomous',
})

export const MODE_VALUES = Object.freeze(Object.values(MODES))

/** Default limits. Every one is configurable through the board API. */
export const DEFAULT_POLICY = Object.freeze({
  mode: MODES.OFF,
  maxConcurrent: 2,
  maxRetries: 2,
  maxSwitches: 2,
  proposalTtlMs: 30 * 60 * 1000,
  leaseTtlMs: 10 * 60 * 1000,
  // Automatic retries are bounded: a task whose last attempt failed is not
  // relaunched on the next tick, and a revision has a maximum number of
  // sessions (manual dispatch stays available to the operator).
  retryCooldownMs: 5 * 60 * 1000,
  maxAttemptsPerRevision: 4,
  allowedWorkspaces: [],
  allowedProviders: [],
  // A card may ask for a permission level; the operator's mandate decides which
  // levels this board may grant. `danger-full-access` is never inherited by default.
  allowedPermissions: ['read-only', 'workspace-write'],
  // 'board' = the board creates the session (model-level failover possible, but
  // the Task Board gets no execution record). 'taskboard' = the Task Board's own
  // executor creates the session/execution/worktree (no model-level failover).
  // 'contract' = the unified backend: the Task Board leases the canonical
  // execution, the board creates the session (so it can fail over) and attaches
  // it to that execution. It requires the negotiated execution contract.
  executionBackend: 'board',
  allowCloudFallback: false,
  autoResumeOnRestart: false,
  serializeSameWorkspace: false,
  routeChain: [],
  // Per-project route overrides, keyed by DSH workspace id. Only the documented
  // route keys are kept; the pure resolver (`routing/policy.js`) applies the
  // most-restrictive-wins layering. Unknown keys are dropped, never trusted.
  projectPolicies: {},
  autonomyBudget: { maxTasksPerHour: 6 },
  // Bounded request budget for the sliding hour. Only metrics the board can
  // substantiate are enforced; token/cost stay explicitly unavailable.
  requestsPerHour: 120,
  // The board may attach a settlement report composed from OBSERVED facts when
  // the agent did not submit one. Set to false to never write a report.
  contractBoardReport: true,
})

const PERMISSION_LEVELS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
const EXECUTION_BACKENDS = Object.freeze(['board', 'taskboard', 'contract'])

export function normalizePolicy(input = {}, fallback = DEFAULT_POLICY) {
  const mode = isMode(input.mode) ? input.mode : fallback.mode
  const maxConcurrent = clampInt(input.maxConcurrent, 0, 8, fallback.maxConcurrent)
  const maxSwitches = clampInt(input.maxSwitches, 0, 5, fallback.maxSwitches)
  return {
    mode,
    maxConcurrent,
    maxRetries: clampInt(input.maxRetries, 0, 5, fallback.maxRetries ?? 2),
    maxSwitches,
    proposalTtlMs: clampInt(input.proposalTtlMs, 60_000, 86_400_000, fallback.proposalTtlMs),
    leaseTtlMs: clampInt(input.leaseTtlMs, 30_000, 86_400_000, fallback.leaseTtlMs),
    retryCooldownMs: clampInt(input.retryCooldownMs, 0, 86_400_000, fallback.retryCooldownMs ?? 300_000),
    maxAttemptsPerRevision: clampInt(input.maxAttemptsPerRevision, 1, 10, fallback.maxAttemptsPerRevision ?? 4),
    allowedWorkspaces: uniqueStrings(input.allowedWorkspaces ?? fallback.allowedWorkspaces),
    allowedProviders: uniqueStrings(input.allowedProviders ?? fallback.allowedProviders),
    allowedPermissions: uniqueStrings(input.allowedPermissions ?? fallback.allowedPermissions)
      .filter(level => PERMISSION_LEVELS.includes(level)),
    executionBackend: EXECUTION_BACKENDS.includes(input.executionBackend)
      ? input.executionBackend
      : (fallback.executionBackend ?? 'board'),
    allowCloudFallback: input.allowCloudFallback === true,
    autoResumeOnRestart: input.autoResumeOnRestart === true,
    serializeSameWorkspace: input.serializeSameWorkspace === true,
    routeChain: normalizeRouteChain(input.routeChain ?? fallback.routeChain),
    projectPolicies: normalizeProjectPolicies(input.projectPolicies ?? fallback.projectPolicies),
    autonomyBudget: {
      maxTasksPerHour: clampInt(input.autonomyBudget?.maxTasksPerHour, 0, 100, fallback.autonomyBudget.maxTasksPerHour),
    },
    requestsPerHour: clampInt(input.requestsPerHour, 1, 10_000, fallback.requestsPerHour ?? 120),
    contractBoardReport: input.contractBoardReport === undefined
      ? fallback.contractBoardReport !== false
      : input.contractBoardReport === true,
  }
}

/** The permission level this board is allowed to grant for a card, or null. */
export function allowedPermissionOf(policy, requested) {
  if (typeof requested !== 'string' || requested === '') return null
  const allowed = Array.isArray(policy?.allowedPermissions) ? policy.allowedPermissions : DEFAULT_POLICY.allowedPermissions
  return allowed.includes(requested) ? requested : null
}

/** Orchestration modes. Default is always `off`. */

export function isMode(value) {
  return typeof value === 'string' && MODE_VALUES.includes(value)
}

export function assertMode(value) {
  if (!isMode(value)) throw new Error(`agent-board: invalid orchestration mode ${JSON.stringify(value)}`)
  return value
}

/** A stable project identity: DSH workspace id, plus its directory when known. */
export function projectRef(input = {}) {
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : undefined
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined
  if (id === undefined && path === undefined) throw new Error('agent-board: projectRef needs id or path')
  return {
    id: id ?? path,
    path: path ?? null,
    title: typeof input.title === 'string' && input.title !== '' ? input.title : (id ?? path),
  }
}

/**
 * One external work item, with an explicit provenance and an authority field.
 * `canonicalId` is the identity the board uses; the external ids stay readable.
 */
export function workItemRef(input) {
  const system = requireString(input.system, 'workItemRef.system')
  const externalId = requireString(input.externalId, 'workItemRef.externalId')
  return {
    system,
    externalId,
    canonicalId: `${system}:${externalId}`,
    url: typeof input.url === 'string' ? input.url : null,
    revision: input.revision ?? null,
    authority: input.authority ?? 'external',
    title: typeof input.title === 'string' ? input.title : '',
  }
}

/** Deterministic idempotency key: one logical assignment per (item, revision, attempt). */
export function idempotencyKey({ workItem, revision = 0, attempt = 0 }) {
  const item = typeof workItem === 'string' ? workItem : requireString(workItem?.canonicalId, 'idempotencyKey.workItem')
  return `${item}@${String(revision)}#${String(attempt)}`
}

export function newId(prefix = 'id') {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/** Bound every text that crosses the journal or the wire. */
export function truncate(text, max = 400) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= max) return value
  // Code-point safe: never split a surrogate pair in the middle.
  return `${[...value].slice(0, max).join('')}…`
}

/** Extract readable text out of arbitrary assistant content shapes. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text
          if (typeof part.content === 'string') return part.content
        }
        return ''
      })
      .filter(part => part !== '')
      .join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

function requireString(value, field) {
  if (typeof value !== 'string' || value === '') throw new Error(`agent-board: ${field} must be a non-empty string`)
  return value
}

export function normalizeRouteChain(chain) {
  if (!Array.isArray(chain)) return []
  const out = []
  for (const entry of chain) {
    if (typeof entry === 'string' && entry !== '') {
      const [provider, model] = entry.split('/')
      if (provider && model) out.push({ provider, model })
      continue
    }
    if (entry !== null && typeof entry === 'object' && typeof entry.provider === 'string' && typeof entry.model === 'string') {
      out.push({
        provider: entry.provider,
        model: entry.model,
        locality: entry.locality === 'local' ? 'local' : 'remote',
        reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : undefined,
      })
    }
  }
  return out
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(entry => typeof entry === 'string' && entry !== ''))]
}

/**
 * Sanitize the per-project route overrides. A project layer carries a subset of
 * the documented route keys; anything else is dropped so a hand-edited policy
 * file cannot smuggle an unrelated limit into the resolver.
 */
export function normalizeProjectPolicies(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  let kept = 0
  for (const [workspaceId, layer] of Object.entries(value)) {
    if (kept >= 20) break
    if (typeof workspaceId !== 'string' || workspaceId === '') continue
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) continue
    const entry = {}
    if (Array.isArray(layer.allowedProviders)) entry.allowedProviders = uniqueStrings(layer.allowedProviders)
    if (Array.isArray(layer.deniedProviders)) entry.deniedProviders = uniqueStrings(layer.deniedProviders)
    if (typeof layer.allowCloudFallback === 'boolean') entry.allowCloudFallback = layer.allowCloudFallback
    if (layer.locality === 'local' || layer.localOnly === true) entry.locality = 'local'
    for (const key of ['maxRetries', 'maxSwitches', 'cooldownMs']) {
      if (Number.isFinite(Number(layer[key]))) entry[key] = Math.trunc(Number(layer[key]))
    }
    if (Array.isArray(layer.routeChain)) entry.routeChain = normalizeRouteChain(layer.routeChain)
    out[workspaceId] = entry
    kept += 1
  }
  return out
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
