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

import { normalizeConcurrencyLimit, normalizeHourlyRate, normalizeProviderConcurrency, normalizeTokenPool } from './concurrency.js'

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

/**
 * Super Orchestrator supervision limits (additive policy slice).
 *
 * The supervision layer is the host policy engine, NOT a second agent runtime:
 * it observes real facts, proposes local actions and gates board-owned
 * delegations. `enabled:false` disables the whole layer (no delegation gate, no
 * recommendations, capabilities unavailable) while the existing authorization
 * gates keep working exactly as before.
 *
 * `emblem` is a visual variant of the SAME `super_orchestrator` role (crown or
 * bolt), never a new role.
 */
export const SUPERVISION_DEFAULT = Object.freeze({
  enabled: true,
  emblem: 'crown',
  // Board-launched assignments in flight (starting/running/recovering).
  // `null` means no ceiling of its own; `0` is a real freeze (see
  // `contracts/concurrency.js`), which the operator UI never lets you type.
  maxConcurrentDelegations: 2,
  // Real delegation starts inside the sliding hour. Superseded by the load model
  // (Lot 11) and kept only as an advanced safety valve; `null` = no rate limit.
  maxDelegationsPerHour: 6,
  // A delegated launch may not delegate again (depth 0 = a root delegation).
  maxDelegationDepth: 1,
  // A subtask in another project/workspace is a cross-project delegation.
  allowCrossProjectDelegation: false,
})

/**
 * The real-time load slice (Lot 11).
 *
 * `tokenBudget` is the size of the pool the operator is willing to spend on the
 * current work wave (`null` = no pool, nothing binds on money). `tokensPerTurn`
 * is the price of one turn used to translate the pool into a session count:
 * `null` means "measure it on this install, else use the documented fallback".
 */
export const LOAD_DEFAULT = Object.freeze({
  tokenBudget: null,
  tokensPerTurn: null,
})

/** Journal marker of the load model migration, stored outside the policy. */
export const LOAD_MODEL_VERSION = 1

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
  // Delay before the bounded settle/release retry sweep runs again (ms).
  settlementRetryMs: 60000,
  // A handoff normally requires a FRESH Task Board read proving ownership. When
  // that read fails (network), the default is to suppress the recovery; an
  // operator may opt into the optimistic path explicitly.
  allowUnverifiedHandoff: false,
  // Super Orchestrator supervision layer (pure policy; see SUPERVISION_DEFAULT).
  supervision: SUPERVISION_DEFAULT,
  // Per-provider (or per provider/model) ceilings. Empty = no provider ceiling:
  // the global concurrency and the provider's own rate limits still apply.
  providerConcurrency: {},
  // Super Agent runtime budget. These were literals in the host; they are policy
  // now, persisted and validated like every other limit. Concurrency `null` =
  // unlimited, `0` = freeze; the hourly figures are rates (0 = no call at all).
  superagent: Object.freeze({
    maxConcurrentAgents: 2,
    cyclesPerHour: 6,
    modelCallsPerHour: 12,
  }),
  // Real-time load slice (Lot 11): the token pool and the price of a turn.
  load: LOAD_DEFAULT,
})

const PERMISSION_LEVELS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
const EXECUTION_BACKENDS = Object.freeze(['board', 'taskboard', 'contract'])

export function normalizePolicy(input = {}, fallback = DEFAULT_POLICY) {
  const mode = isMode(input.mode) ? input.mode : fallback.mode
  // 0/`null` = unlimited. The hard ceiling only catches a typing mistake, and the
  // default stays 2 so an upgrade changes nothing.
  const maxConcurrent = normalizeConcurrencyLimit(input.maxConcurrent, fallback.maxConcurrent)
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
    // 'operator' once a /policy call named a backend; 'auto' lets the host
    // promote the default 'board' to the canonical Task Board contract.
    executionBackendSource: ['auto', 'operator'].includes(input.executionBackendSource)
      ? input.executionBackendSource
      : (fallback.executionBackendSource ?? 'auto'),
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
    settlementRetryMs: clampInt(input.settlementRetryMs, 0, 3600000, fallback.settlementRetryMs ?? 60000),
    allowUnverifiedHandoff: input.allowUnverifiedHandoff === undefined
      ? fallback.allowUnverifiedHandoff === true
      : input.allowUnverifiedHandoff === true,
    // Backward compatible: a persisted state.json written before the
    // supervision layer has no `supervision` key and receives the defaults.
    supervision: normalizeSupervision(input.supervision, fallback.supervision ?? SUPERVISION_DEFAULT),
    providerConcurrency: normalizeProviderConcurrency(input.providerConcurrency ?? fallback.providerConcurrency),
    superagent: normalizeSuperagentBudget(input.superagent, fallback.superagent ?? DEFAULT_POLICY.superagent),
    load: normalizeLoad(input.load, fallback.load ?? LOAD_DEFAULT),
  }
}

/**
 * Normalize the load slice: a pool in tokens (`null` = no pool) and the price of
 * one turn (`null` = measure it, else the documented fallback).
 *
 * A pool is never invented and never rounded up: `0` is a spent pool, a negative
 * or unreadable value falls back to "no pool".
 */
export function normalizeLoad(input, fallback = LOAD_DEFAULT) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const previous = fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : LOAD_DEFAULT
  return {
    tokenBudget: normalizeTokenPool(source.tokenBudget, normalizeTokenPool(previous.tokenBudget, null)),
    tokensPerTurn: normalizeTokenPool(source.tokensPerTurn, normalizeTokenPool(previous.tokensPerTurn, null)),
  }
}

/**
 * Lift the two legacy ceilings that used to throttle the product, ONCE.
 *
 * A document written by 0.1.0 carries the documented defaults (2 concurrent and
 * 6 starts per hour). They are replaced by `null` — "no ceiling of its own", the
 * load model decides — while a value that is NOT the old default is preserved:
 * an operator who typed 20 meant 20. The old values stay readable in the audit
 * entry, and the hourly field remains an active advanced safety valve.
 *
 * @param {object} policy a normalized policy
 * @param {{at?: number}} [options]
 * @returns {{policy: object, migrated: boolean, from: {maxConcurrentDelegations: number|null, maxDelegationsPerHour: number|null}}}
 */
export function migratePolicyToLoadModel(policy, { at = null } = {}) {
  const source = policy !== null && typeof policy === 'object' && !Array.isArray(policy) ? policy : {}
  const supervision = source.supervision !== null && typeof source.supervision === 'object' ? source.supervision : {}
  const lift = (value, legacyDefault) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return null
    return number === legacyDefault ? null : number
  }
  const from = {
    maxConcurrentDelegations: Number.isFinite(Number(supervision.maxConcurrentDelegations)) ? Number(supervision.maxConcurrentDelegations) : null,
    maxDelegationsPerHour: Number.isFinite(Number(supervision.maxDelegationsPerHour)) ? Number(supervision.maxDelegationsPerHour) : null,
  }
  const next = {
    ...source,
    supervision: {
      ...supervision,
      maxConcurrentDelegations: lift(supervision.maxConcurrentDelegations, SUPERVISION_DEFAULT.maxConcurrentDelegations),
      maxDelegationsPerHour: lift(supervision.maxDelegationsPerHour, SUPERVISION_DEFAULT.maxDelegationsPerHour),
    },
  }
  const migrated = next.supervision.maxConcurrentDelegations !== from.maxConcurrentDelegations
    || next.supervision.maxDelegationsPerHour !== from.maxDelegationsPerHour
  return { policy: migrated ? next : source, migrated, from, ...(Number.isFinite(Number(at)) ? { at: Number(at) } : {}) }
}

/**
 * The Super Agent's own runtime budget, configurable through the policy.
 *
 * These were three literals in the host (`maxConcurrentAgents: 2`,
 * `cyclesPerHour: 6`, `modelCallsPerHour: 12`), so an operator running dozens of
 * projects could not let the agent keep up. 0 means unlimited for all three.
 */
export function normalizeSuperagentBudget(input, fallback = DEFAULT_POLICY.superagent) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const previous = fallback !== null && typeof fallback === 'object' ? fallback : DEFAULT_POLICY.superagent
  return {
    maxConcurrentAgents: normalizeConcurrencyLimit(source.maxConcurrentAgents, previous.maxConcurrentAgents),
    // Hourly ceilings are RATE limits, not concurrency: they do not belong under
    // the concurrency hard ceiling (fifty sessions legitimately exceed 256 calls).
    // `null` = no rate limit, which is the default since the load model (Lot 11);
    // an absent value still inherits the previous layer.
    cyclesPerHour: normalizeHourlyRate(source.cyclesPerHour === undefined ? previous.cyclesPerHour : source.cyclesPerHour, null, 100_000),
    modelCallsPerHour: normalizeHourlyRate(source.modelCallsPerHour === undefined ? previous.modelCallsPerHour : source.modelCallsPerHour, null, 100_000),
  }
}

const EMBLEMS = Object.freeze(['crown', 'bolt'])

/**
 * Normalize the additive supervision policy slice.
 *
 * Unknown keys are dropped (never copied into the journal), every numeric limit
 * is clamped to a documented bound, and a missing value falls back to the
 * supplied layer (so a partial `POST /policy` keeps the operator's other
 * choices). A board built before this field reads as the defaults.
 */
export function normalizeSupervision(input, fallback = SUPERVISION_DEFAULT) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const previous = fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)
    ? fallback
    : SUPERVISION_DEFAULT
  return {
    enabled: source.enabled === undefined ? previous.enabled !== false : source.enabled === true,
    emblem: EMBLEMS.includes(source.emblem) ? source.emblem : (EMBLEMS.includes(previous.emblem) ? previous.emblem : SUPERVISION_DEFAULT.emblem),
    maxConcurrentDelegations: normalizeConcurrencyLimit(source.maxConcurrentDelegations, previous.maxConcurrentDelegations ?? SUPERVISION_DEFAULT.maxConcurrentDelegations),
    // An ABSENT value keeps the previous layer; an EXPLICIT `null` means "no rate
    // limit", which is what the Lot 11 migration writes on purpose.
    maxDelegationsPerHour: normalizeHourlyRate(
      source.maxDelegationsPerHour === undefined ? previous.maxDelegationsPerHour : source.maxDelegationsPerHour,
      null,
    ),
    maxDelegationDepth: clampInt(source.maxDelegationDepth, 0, 8, previous.maxDelegationDepth ?? SUPERVISION_DEFAULT.maxDelegationDepth),
    allowCrossProjectDelegation: source.allowCrossProjectDelegation === undefined
      ? previous.allowCrossProjectDelegation === true
      : source.allowCrossProjectDelegation === true,
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
