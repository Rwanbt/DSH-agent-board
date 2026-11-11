/* GENERATED FILE — edit the modules under src/ and run scripts/build-client.mjs. */
window.__ModuleLoader__.load({
  id: 'dsh-agent-board',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo, useSyncExternalStore, useCallback, useRef } = React
// ---- src/contracts/model.js ----
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

const SCHEMA_VERSION = 1

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
const STATUS = Object.freeze({
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

const STATUS_VALUES = Object.freeze(Object.values(STATUS))

/** Statuses that mean "the user still has something to look at". */
const ATTENTION_STATUSES = Object.freeze([
  STATUS.WAITING_USER,
  STATUS.INTERRUPTED,
  STATUS.FAILED,
  STATUS.FINISHED_UNREAD,
  STATUS.RECOVERING,
  STATUS.PROVIDER_UNAVAILABLE,
])

/** Ranking used for stable ordering (lower = shown first). */
const STATUS_RANK = Object.freeze({
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
const ERROR_TURN_KINDS = Object.freeze(['error', 'failed'])
/** Turn-end kinds that mean the work was interrupted, not completed. */
const INTERRUPTED_TURN_KINDS = Object.freeze(['aborted', 'blocked'])

/** Orchestration modes. Default is always `off`. */
const MODES = Object.freeze({
  OFF: 'off',
  SUPERVISED: 'supervised',
  AUTONOMOUS: 'autonomous',
})

const MODE_VALUES = Object.freeze(Object.values(MODES))

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
const SUPERVISION_DEFAULT = Object.freeze({
  enabled: true,
  emblem: 'crown',
  // Board-launched assignments in flight (starting/running/recovering).
  maxConcurrentDelegations: 2,
  // Real delegation starts inside the sliding hour.
  maxDelegationsPerHour: 6,
  // A delegated launch may not delegate again (depth 0 = a root delegation).
  maxDelegationDepth: 1,
  // A subtask in another project/workspace is a cross-project delegation.
  allowCrossProjectDelegation: false,
})

/** Default limits. Every one is configurable through the board API. */
const DEFAULT_POLICY = Object.freeze({
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
})

const PERMISSION_LEVELS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
const EXECUTION_BACKENDS = Object.freeze(['board', 'taskboard', 'contract'])

function normalizePolicy(input = {}, fallback = DEFAULT_POLICY) {
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
    settlementRetryMs: clampInt(input.settlementRetryMs, 0, 3600000, fallback.settlementRetryMs ?? 60000),
    allowUnverifiedHandoff: input.allowUnverifiedHandoff === undefined
      ? fallback.allowUnverifiedHandoff === true
      : input.allowUnverifiedHandoff === true,
    // Backward compatible: a persisted state.json written before the
    // supervision layer has no `supervision` key and receives the defaults.
    supervision: normalizeSupervision(input.supervision, fallback.supervision ?? SUPERVISION_DEFAULT),
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
function normalizeSupervision(input, fallback = SUPERVISION_DEFAULT) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const previous = fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)
    ? fallback
    : SUPERVISION_DEFAULT
  return {
    enabled: source.enabled === undefined ? previous.enabled !== false : source.enabled === true,
    emblem: EMBLEMS.includes(source.emblem) ? source.emblem : (EMBLEMS.includes(previous.emblem) ? previous.emblem : SUPERVISION_DEFAULT.emblem),
    maxConcurrentDelegations: clampInt(source.maxConcurrentDelegations, 0, 16, previous.maxConcurrentDelegations ?? SUPERVISION_DEFAULT.maxConcurrentDelegations),
    maxDelegationsPerHour: clampInt(source.maxDelegationsPerHour, 0, 200, previous.maxDelegationsPerHour ?? SUPERVISION_DEFAULT.maxDelegationsPerHour),
    maxDelegationDepth: clampInt(source.maxDelegationDepth, 0, 8, previous.maxDelegationDepth ?? SUPERVISION_DEFAULT.maxDelegationDepth),
    allowCrossProjectDelegation: source.allowCrossProjectDelegation === undefined
      ? previous.allowCrossProjectDelegation === true
      : source.allowCrossProjectDelegation === true,
  }
}

/** The permission level this board is allowed to grant for a card, or null. */
function allowedPermissionOf(policy, requested) {
  if (typeof requested !== 'string' || requested === '') return null
  const allowed = Array.isArray(policy?.allowedPermissions) ? policy.allowedPermissions : DEFAULT_POLICY.allowedPermissions
  return allowed.includes(requested) ? requested : null
}

/** Orchestration modes. Default is always `off`. */

function isMode(value) {
  return typeof value === 'string' && MODE_VALUES.includes(value)
}

function assertMode(value) {
  if (!isMode(value)) throw new Error(`agent-board: invalid orchestration mode ${JSON.stringify(value)}`)
  return value
}

/** A stable project identity: DSH workspace id, plus its directory when known. */
function projectRef(input = {}) {
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
function workItemRef(input) {
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
function idempotencyKey({ workItem, revision = 0, attempt = 0 }) {
  const item = typeof workItem === 'string' ? workItem : requireString(workItem?.canonicalId, 'idempotencyKey.workItem')
  return `${item}@${String(revision)}#${String(attempt)}`
}

function newId(prefix = 'id') {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/** Bound every text that crosses the journal or the wire. */
function truncate(text, max = 400) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= max) return value
  // Code-point safe: never split a surrogate pair in the middle.
  return `${[...value].slice(0, max).join('')}…`
}

/** Extract readable text out of arbitrary assistant content shapes. */
function textOfContent(content) {
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

function normalizeRouteChain(chain) {
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
function normalizeProjectPolicies(value) {
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


// ---- src/contracts/agent-roles.js ----
/**
 * Agent identity: the 15 approved mascot roles, their exact palette, the
 * declared-name aliases and the mapping from the board's EXISTING runtime
 * statuses to a status tone that is displayed separately from the role colour.
 *
 * Pure data + pure functions: imported by the host (supervision) and included in
 * the browser bundle. It never touches the DOM, never reads an asset and never
 * draws a mascot; `src/client/ui/avatar.js` owns the rendering.
 *
 * Invariants:
 *   - a role colour is identity, never status; a blocked Worker stays green;
 *   - a model/provider never implies a role (two agents may share one model and
 *     have different roles); the role comes from a DECLARED role/name only;
 *   - an unknown role resolves to `roleId:null` (generic identity) and never to a
 *     guessed mascot; the original string is preserved verbatim in `raw`.
 *
 * @module dsh-agent-board/contracts/agent-roles
 */

/** The 15 approved roles, exactly as published in the kit's `roles.json`. */
const AGENT_ROLES = Object.freeze({
  super_orchestrator: Object.freeze({
    id: 'super_orchestrator',
    label: 'Super Orchestrator',
    family: 'governance',
    shape: 'triangle',
    color: '#7043DB',
    gradient: Object.freeze(['#A77CF7', '#7043DB', '#5324B4']),
    scope: 'workspace',
    emblem: 'crown',
    description: 'Coordonne plusieurs projets et leurs orchestrateurs',
  }),
  orchestrator: Object.freeze({
    id: 'orchestrator', label: 'Orchestrator', family: 'governance', shape: 'triangle',
    color: '#8D55EA', gradient: Object.freeze(['#B47CFA', '#8D55EA', '#7643D7']), scope: 'project',
    description: 'Coordonne et pilote',
  }),
  architect: Object.freeze({
    id: 'architect', label: 'Architect', family: 'governance', shape: 'triangle',
    color: '#895AED', gradient: Object.freeze(['#A575F9', '#895AED', '#7346D7']), scope: 'project',
    description: 'Conçoit et structure',
  }),
  knowledge_manager: Object.freeze({
    id: 'knowledge_manager', label: 'Knowledge Manager', family: 'governance', shape: 'triangle',
    color: '#A572F3', gradient: Object.freeze(['#C698FB', '#A572F3', '#8F5DE5']), scope: 'project',
    description: 'Conserve et diffuse',
  }),
  planner: Object.freeze({
    id: 'planner', label: 'Planner', family: 'coordination', shape: 'square',
    color: '#228FFD', gradient: Object.freeze(['#3CB2FD', '#228FFD', '#0F79F3']), scope: 'project',
    description: 'Planifie et organise',
  }),
  dispatcher: Object.freeze({
    id: 'dispatcher', label: 'Dispatcher', family: 'coordination', shape: 'square',
    color: '#03B4E2', gradient: Object.freeze(['#1DD5F2', '#03B4E2', '#0099D0']), scope: 'project',
    description: 'Distribue les tâches',
  }),
  observer: Object.freeze({
    id: 'observer', label: 'Observer', family: 'coordination', shape: 'square',
    color: '#5F92C7', gradient: Object.freeze(['#7EB0DF', '#5F92C7', '#4F7EB0']), scope: 'project',
    description: 'Surveille et alerte',
  }),
  worker: Object.freeze({
    id: 'worker', label: 'Worker', family: 'execution', shape: 'cloud',
    color: '#36CB5E', gradient: Object.freeze(['#56E079', '#36CB5E', '#22B94B']), scope: 'project',
    description: 'Exécute et produit',
  }),
  researcher: Object.freeze({
    id: 'researcher', label: 'Researcher', family: 'execution', shape: 'cloud',
    color: '#25C5A6', gradient: Object.freeze(['#4EE0C1', '#25C5A6', '#0EAF8E']), scope: 'project',
    description: 'Explore et recherche',
  }),
  integrator: Object.freeze({
    id: 'integrator', label: 'Integrator', family: 'execution', shape: 'cloud',
    color: '#12AD86', gradient: Object.freeze(['#36D0A5', '#12AD86', '#049271']), scope: 'project',
    description: 'Assemble et consolide',
  }),
  optimizer: Object.freeze({
    id: 'optimizer', label: 'Optimizer', family: 'execution', shape: 'cloud',
    color: '#8ECF10', gradient: Object.freeze(['#A7E039', '#8ECF10', '#7DC000']), scope: 'project',
    description: 'Améliore et optimise',
  }),
  reviewer: Object.freeze({
    id: 'reviewer', label: 'Reviewer', family: 'quality', shape: 'circle',
    color: '#FB8819', gradient: Object.freeze(['#FEA838', '#FB8819', '#EC7003']), scope: 'project',
    description: 'Relit et évalue',
  }),
  auditor: Object.freeze({
    id: 'auditor', label: 'Auditor', family: 'quality', shape: 'circle',
    color: '#EB7E25', gradient: Object.freeze(['#FDA249', '#EB7E25', '#DD6917']), scope: 'project',
    description: 'Audite et contrôle',
  }),
  verifier: Object.freeze({
    id: 'verifier', label: 'Verifier', family: 'validation', shape: 'diamond',
    color: '#FEBF0D', gradient: Object.freeze(['#FEDB3B', '#FEBF0D', '#FEAE02']), scope: 'project',
    description: 'Teste et valide',
  }),
  guardian: Object.freeze({
    id: 'guardian', label: 'Guardian', family: 'protection', shape: 'hexagon',
    color: '#FE6560', gradient: Object.freeze(['#FD8782', '#FE6560', '#F14B49']), scope: 'project',
    description: 'Sécurise et applique les règles',
  }),
})

const AGENT_ROLE_IDS = Object.freeze(Object.keys(AGENT_ROLES))

/** Families keep the six approved silhouettes recognisable as camaïeux. */
const AGENT_FAMILIES = Object.freeze({
  governance: Object.freeze({ label: 'Gouvernance / connaissances', shape: 'triangle' }),
  coordination: Object.freeze({ label: 'Coordination / monitoring', shape: 'square' }),
  execution: Object.freeze({ label: 'Production / optimisation', shape: 'cloud' }),
  quality: Object.freeze({ label: 'Revue / audit', shape: 'circle' }),
  validation: Object.freeze({ label: 'Validation / tests', shape: 'diamond' }),
  protection: Object.freeze({ label: 'Protection / règles', shape: 'hexagon' }),
})

/**
 * Declared-name aliases only: a role/name an agent or the runtime ALREADY
 * declares. Keys are normalized (lower case, `_`/space/hyphen collapsed to
 * `-`); a value is the role id it names. Never add a behavioural alias (e.g.
 * "spawned a child", "used model X"): that would invent a role.
 */
const AGENT_ROLE_ALIASES = Object.freeze({
  'super-orchestrator': 'super_orchestrator',
  'workspace-orchestrator': 'super_orchestrator',
  supervisor: 'orchestrator',
  orchestrator: 'orchestrator',
  lead: 'orchestrator',
  'team-lead': 'orchestrator',
  coordinator: 'orchestrator',
  architect: 'architect',
  architecture: 'architect',
  arch: 'architect',
  'knowledge-manager': 'knowledge_manager',
  knowledge: 'knowledge_manager',
  memory: 'knowledge_manager',
  librarian: 'knowledge_manager',
  planner: 'planner',
  planning: 'planner',
  planificateur: 'planner',
  dispatcher: 'dispatcher',
  dispatch: 'dispatcher',
  observer: 'observer',
  monitor: 'observer',
  watcher: 'observer',
  worker: 'worker',
  dev: 'worker',
  developer: 'worker',
  implementer: 'worker',
  builder: 'worker',
  researcher: 'researcher',
  research: 'researcher',
  scout: 'researcher',
  explorer: 'researcher',
  integrator: 'integrator',
  integration: 'integrator',
  optimizer: 'optimizer',
  optimisation: 'optimizer',
  optimization: 'optimizer',
  perf: 'optimizer',
  reviewer: 'reviewer',
  review: 'reviewer',
  'code-review': 'reviewer',
  auditor: 'auditor',
  audit: 'auditor',
  verifier: 'verifier',
  verification: 'verifier',
  qa: 'verifier',
  tester: 'verifier',
  test: 'verifier',
  guardian: 'guardian',
  security: 'guardian',
  sentry: 'guardian',
  // Declared French display form; accent/case are removed by normalization.
  verificateur: 'verifier',
})

/**
 * Status tones: the kit's six (`active`, `planning`, `waiting`, `reviewing`,
 * `blocked`, `idle`) plus four documented extensions that name an EXISTING
 * plugin status the six cannot distinguish. They colour the status dot only.
 */
const AGENT_TONES = Object.freeze({
  active: Object.freeze({ color: '#1DC766', labelKey: 'statusRunning' }),
  planning: Object.freeze({ color: '#258FF5', labelKey: 'statusRecovering' }),
  waiting: Object.freeze({ color: '#F3BE13', labelKey: 'statusWaiting' }),
  reviewing: Object.freeze({ color: '#F48C1A', labelKey: 'taskInReview' }),
  blocked: Object.freeze({ color: '#F04453', labelKey: 'statusFailed' }),
  idle: Object.freeze({ color: '#7E8B9C', labelKey: 'statusIdle' }),
  // Extensions (documented; NOT roles): an unread result, a read result, an
  // agent the runtime no longer exposes, and a launch that was interrupted.
  unread: Object.freeze({ color: '#2EA043', labelKey: 'statusUnread' }),
  done: Object.freeze({ color: '#5F92C7', labelKey: 'statusRead' }),
  gone: Object.freeze({ color: '#8993A3', labelKey: 'statusUnknown' }),
  interrupted: Object.freeze({ color: '#B7791F', labelKey: 'statusInterrupted' }),
})

/**
 * The board's EXISTING statuses (contracts/model.js STATUS) -> tone. No new
 * status is introduced; only a display tone that never recolours the mascot:
 *
 *   running              -> active
 *   waiting_user         -> waiting
 *   recovering           -> planning
 *   interrupted          -> interrupted   (extension)
 *   provider_unavailable -> blocked
 *   failed               -> blocked
 *   finished_unread      -> unread        (extension)
 *   finished_read        -> done          (extension)
 *   idle                 -> idle
 *   unknown              -> gone          (extension)
 *   unavailable          -> gone          (extension)
 *
 * The four extensions exist because the kit's six tones cannot distinguish an
 * unread result from a read one, or a live agent from one the runtime no longer
 * exposes. They are statuses, never roles.
 */
const AGENT_STATUS_TONE = Object.freeze({
  running: 'active',
  waiting_user: 'waiting',
  recovering: 'planning',
  interrupted: 'interrupted',
  provider_unavailable: 'blocked',
  failed: 'blocked',
  finished_unread: 'unread',
  finished_read: 'done',
  idle: 'idle',
  unknown: 'gone',
  unavailable: 'gone',
})

/**
 * Task Board workflow states are a SEPARATE vocabulary from agent statuses:
 * "in review" belongs to a linked task, never to an agent and never to the
 * permanent Reviewer role. Only the five workflow states the board consumes are
 * mapped; a task state that is not in this table yields `taskTone:null` (no
 * chip), never a guessed tone.
 */
const AGENT_TASK_STATE_TONE = Object.freeze({
  todo: 'idle',
  in_progress: 'active',
  in_review: 'reviewing',
  blocked: 'blocked',
  done: 'done',
})

const TASK_STATE_TONES = Object.freeze(Object.keys(AGENT_TASK_STATE_TONE))

/** Normalize a declared role/name for alias lookup (never mutates the input data). */
function normalizeAgentRoleKey(value) {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Resolve a DECLARED role/name to an approved role.
 *
 * @param {string|{role?:string,name?:string,id?:string}|null|undefined} value
 * @returns {{ roleId: string|null, source: 'explicit'|'alias'|'generic', raw: string|null, role: object|null }}
 */
function dabResolveAgentRole(value) {
  const candidates = []
  if (typeof value === 'string') candidates.push(value)
  else if (value !== null && typeof value === 'object') {
    if (typeof value.role === 'string') candidates.push(value.role)
    if (typeof value.name === 'string') candidates.push(value.name)
  }
  const raw = candidates.find(candidate => typeof candidate === 'string' && candidate.trim() !== '') ?? null
  if (raw === null) return { roleId: null, source: 'generic', raw: null, role: null }
  // Exact role id first (case-insensitive): role ids use snake_case, while the
  // alias key normalizes `_` to `-`, so this must run before the alias lookup.
  const direct = raw.trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(AGENT_ROLES, direct)) {
    return { roleId: direct, source: 'explicit', raw, role: AGENT_ROLES[direct] }
  }
  const key = normalizeAgentRoleKey(raw)
  const alias = AGENT_ROLE_ALIASES[key]
  if (alias !== undefined && AGENT_ROLES[alias] !== undefined) {
    return { roleId: alias, source: 'alias', raw, role: AGENT_ROLES[alias] }
  }
  return { roleId: null, source: 'generic', raw, role: null }
}

/** Full mascot from 48px up; compact below. */
function dabAvatarVariantForSize(size) {
  const value = Number(size)
  if (!Number.isFinite(value)) return 'full'
  return value < 48 ? 'compact' : 'full'
}

/**
 * Pure avatar view model. The data-URI source map is injected so this module
 * stays asset-free and unit-testable; the component passes `AGENT_BOT_ASSETS`.
 *
 * `altParts` is the accessible-name composition: an array of
 * `{ text }` (literal, already declared: the agent name and the role label) and
 * `{ labelKey }` (a translation key: the status/task tone label). The avatar
 * translates the keys through `dabT` and never introduces a label of its own.
 *
 * @param {object} input
 * @param {string|object|null} [input.role] declared role/name
 * @param {string|null} [input.name] display name (never used to infer a role)
 * @param {string|null} [input.status] one of the board's EXISTING statuses
 * @param {string|null} [input.taskState] Task Board workflow state (separate)
 * @param {number} [input.size]
 * @param {'full'|'compact'|'auto'} [input.variant]
 * @param {'crown'|'bolt'} [input.emblem]
 * @param {object|null} [input.sources] { [roleId]: { full, compact } }
 * @returns {object}
 */
function dabAgentAvatarModel(input = {}) {
  const size = Number.isFinite(Number(input.size)) ? Math.max(8, Math.min(256, Math.trunc(Number(input.size)))) : 40
  const variant = input.variant === 'full' || input.variant === 'compact' ? input.variant : dabAvatarVariantForSize(size)
  const resolved = dabResolveAgentRole(input.role)
  const role = resolved.role
  const emblem = role?.id === 'super_orchestrator'
    ? (input.emblem === 'bolt' ? 'bolt' : 'crown')
    : null
  // The bolt emblem is a separate graphic identity (`super_orchestrator_bolt`),
  // never a recolour: look it up first and only fall back to the crown drawing
  // when the kit has no bolt asset.
  let src = null
  const sources = input.sources
  if (role !== null && sources !== null && typeof sources === 'object') {
    const sourceKey = emblem === 'bolt' ? 'super_orchestrator_bolt' : role.id
    src = sources[sourceKey]?.[variant] ?? null
    if (src === null && sourceKey !== role.id) src = sources[role.id]?.[variant] ?? null
  }
  const status = typeof input.status === 'string' ? input.status : null
  const statusKnown = status !== null && AGENT_STATUS_TONE[status] !== undefined
  const tone = statusKnown ? AGENT_STATUS_TONE[status] : 'idle'
  const taskState = typeof input.taskState === 'string' ? input.taskState : null
  const taskTone = taskState !== null && AGENT_TASK_STATE_TONE[taskState] !== undefined ? AGENT_TASK_STATE_TONE[taskState] : null
  const altParts = []
  if (typeof input.name === 'string' && input.name.trim() !== '') altParts.push({ text: input.name.trim() })
  if (role !== null) altParts.push({ text: role.label })
  if (statusKnown) altParts.push({ labelKey: AGENT_TONES[tone].labelKey })
  if (taskTone !== null) altParts.push({ labelKey: AGENT_TONES[taskTone].labelKey })
  return {
    roleId: resolved.roleId,
    roleLabel: role?.label ?? null,
    family: role?.family ?? null,
    shape: role?.shape ?? null,
    color: role?.color ?? null,
    gradient: role?.gradient ?? null,
    resolution: resolved.source,
    rawRole: resolved.raw,
    variant,
    size,
    src,
    emblem,
    status,
    tone,
    toneColor: AGENT_TONES[tone]?.color ?? AGENT_TONES.idle.color,
    toneLabelKey: AGENT_TONES[tone]?.labelKey ?? 'statusIdle',
    taskState,
    taskTone,
    taskToneColor: taskTone === null ? null : (AGENT_TONES[taskTone]?.color ?? null),
    taskToneLabelKey: taskTone === null ? null : (AGENT_TONES[taskTone]?.labelKey ?? null),
    altParts,
  }
}


// ---- src/supervisor/projection.js ----
/**
 * Session supervisor projection: native DSH session state -> Agent Board tree.
 *
 * Everything here is pure. The input is the client `sessions.list` snapshot
 * (ids / byId / projectionsBySession), the unified `uiSession.sessionStatus`
 * map, and the host-side facts the board persists (last assistant segment,
 * turn-end kind, read cursor, assignments, provider health). The output is one
 * node per agent, grouped by project, with a filiation tree.
 *
 * Status rules (non-negotiable):
 *   - pendingInteraction  -> waiting_user (even while running)
 *   - running             -> running (animated ring)
 *   - assignment stopped / superseded / failed / interrupted -> interrupted
 *   - turn ended in error -> failed, or provider_unavailable when the model's
 *                            provider is inside an injected cooldown
 *   - turn ended, not consulted -> finished_unread (green)
 *   - turn ended, consulted     -> finished_read (grey)
 *   - runtime says the agent is gone -> unavailable
 *   - session deleted / no live row  -> unknown with an explicit reason
 *   - no signal at all          -> idle
 *
 * Elapsed time alone NEVER produces running/finished. A missing row is
 * `unknown`, never `finished`. `recentlyFinished` is a view flag derived from a
 * real turn-end timestamp inside a bounded window; it is NOT a status, so a
 * quiet card never turns green because it aged.
 *
 * `waiting_agent` deliberately does NOT exist. The candidate native sources
 * were investigated: `agent/status` only carries idle/running, `subagents`
 * exposes awaited helpers (`waitForChildren`, `drainChildren`) and lifecycle
 * events for the CHILD (`subagent/start`, `subagent/end`) but no per-parent
 * "blocked on a child" projection value, and `uiSession.sessionStatus` only
 * carries running / pendingInteraction / completionUnread. While a parent
 * awaits a child its row stays `running: true`, so "waiting for another agent"
 * cannot be told apart from "working" without inventing a signal. The board
 * therefore keeps showing the truthful `running` status.
 *
 * Model/provider rule: the model chip is a fact, not a default. It comes from
 * the session's own `modelSelection` projection (native) or from the board
 * assignment that launched the card, never from the deployment default model
 * and never copied from an assignment onto a native session.
 *
 * @module dsh-agent-board/supervisor/projection
 */


const PENDING_ACTION = Object.freeze({
  approval: 'approval',
  'plan-review': 'plan-review',
  question: 'question',
})

/** Where a displayed model came from. Never guessed. */
const MODEL_SOURCE = Object.freeze({
  NATIVE: 'native',
  ASSIGNMENT: 'assignment',
  UNKNOWN: 'unknown',
})

/** One bounded window for the non-status `recentlyFinished` view flag. */
const RECENT_FINISHED_MS = 5 * 60 * 1000

/** Assignment statuses that mean "this launch did not finish its work". */
const TERMINAL_NEGATIVE_ASSIGNMENT_STATUSES = Object.freeze(['interrupted', 'failed', 'stopped', 'superseded'])

/** How many model changes are kept in the visible history of one card. */
const MODEL_HISTORY_LIMIT = 8


function normalizeSessions(listSnapshot) {
  const snapshot = listSnapshot !== null && typeof listSnapshot === 'object' ? listSnapshot : {}
  const byId = snapshot.byId !== null && typeof snapshot.byId === 'object' ? snapshot.byId : {}
  const ids = Array.isArray(snapshot.ids) ? snapshot.ids.map(String) : Object.keys(byId)
  return {
    phase: typeof snapshot.phase === 'string' ? snapshot.phase : 'ready',
    ids,
    byId,
    projectionsBySession: snapshot.projectionsBySession !== null && typeof snapshot.projectionsBySession === 'object'
      ? snapshot.projectionsBySession
      : {},
  }
}

function statusEntryOf(statusMap, sessionId) {
  if (statusMap === null || statusMap === undefined) return undefined
  if (typeof statusMap.get === 'function') {
    const value = statusMap.get(sessionId)
    if (value !== undefined) return value
  }
  if (typeof statusMap === 'object' && statusMap[sessionId] !== undefined) return statusMap[sessionId]
  return undefined
}

/** Sub-agent catalog entries declared by the parent session's projection. */
function catalogChildrenOf(projectionsBySession, parentId) {
  const projection = projectionsBySession?.[parentId]
  const catalog = projection?.values?.subagentCatalog
  if (!Array.isArray(catalog)) return []
  return catalog
    .map(entry => {
      if (entry === null || typeof entry !== 'object') return null
      const id = typeof entry.sessionId === 'string'
        ? entry.sessionId
        : (typeof entry.id === 'string' ? entry.id : null)
      if (id === null) return null
      return {
        id,
        title: typeof entry.title === 'string' ? entry.title : (typeof entry.label === 'string' ? entry.label : undefined),
        mode: typeof entry.mode === 'string' ? entry.mode : undefined,
        status: typeof entry.status === 'string' ? entry.status : undefined,
      }
    })
    .filter(entry => entry !== null)
}

function parentIdOf(row) {
  if (row === null || typeof row !== 'object') return null
  const candidate = row.parentId ?? row.parentSessionId ?? row.parent
  return typeof candidate === 'string' && candidate !== '' ? candidate : null
}

function isSubagentRow(row) {
  if (row === null || typeof row !== 'object') return false
  return row.origin === 'subagent' || parentIdOf(row) !== null
}

/**
 * Classify one agent and explain why. `live` is its unified status entry,
 * `turnEnd` the last turn/end fact the host recorded, `ack` the persisted read
 * cursor, `assignment` the board assignment bound to that session, `gone` the
 * host fact that the session was removed, `provider` the resolved provider (for
 * the injected-health check) and `health` the host provider-health table.
 *
 * The returned `reason`/`source`/`at` triple is what the UI shows in the card
 * details: a status without provenance is not allowed to be invented.
 *
 * @returns {{status:string, reason:string, source:string, at:number|null}}
 */
function classifyStatusDetailed({ row, live, turnEnd, ack, assignment, gone = false, goneAt = null, provider = null, health = null, now = Date.now() }) {
  const end = turnEnd !== null && typeof turnEnd === 'object' ? turnEnd : null
  const seenAt = Number(ack?.seenAt)
  const hasSeen = Number.isFinite(seenAt)
  const updatedAt = Number(row?.updatedAt)
  const nativeEnd = nativeTurnEndOf(row)
  const endAt = Number(end?.at)
  const sessionAt = Math.max(Number.isFinite(updatedAt) ? updatedAt : 0, Number.isFinite(endAt) ? endAt : 0) || null
  const outage = providerOutageOf(health, provider, { now, sessionAt })
  const failed = (reason, source, at, extra = {}) => outage !== null
    ? { status: STATUS.PROVIDER_UNAVAILABLE, reason: outage.reason, source: 'host_health', at: outage.at, healthUntil: outage.cooldownUntil, ...extra }
    : { status: STATUS.FAILED, reason, source, at, ...extra }

  if (gone === true) {
    // The host observed the session leave the runtime. Cache or journal data can
    // still hold a turn end for it: never turn that into "finished".
    return { status: STATUS.UNKNOWN, reason: 'session_gone', source: 'host_registry', at: Number(goneAt) || null }
  }
  if (row === undefined && live === undefined && assignment === undefined) {
    return { status: STATUS.UNKNOWN, reason: 'no_row_and_no_live_status', source: 'none', at: null }
  }
  const action = expectedActionOf(live, row)
  if (action !== null) {
    return { status: STATUS.WAITING_USER, reason: `pending_interaction:${action}`, source: live?.pendingInteraction !== undefined ? 'host_status' : 'session_projection', at: null }
  }
  if (row?.running === true || live?.running === true) {
    return { status: STATUS.RUNNING, reason: 'turn_in_progress', source: row?.running === true ? 'session_row' : 'host_status', at: null }
  }
  if (assignment?.status === 'recovering') {
    return { status: STATUS.RECOVERING, reason: `route_recovery:${truncate(String(assignment.reason ?? 'provider_failure'), 120)}`, source: 'assignment', at: Number(assignment.recoveringAt) || null }
  }
  // Assignment/lease truth: a launch that was stopped, superseded, interrupted
  // or failed is not "finished" and not "idle". A turn end NEWER than the
  // assignment (the session was resumed and answered) wins over it.
  if (assignment !== null && assignment !== undefined && TERMINAL_NEGATIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
    const assignmentEnd = Number(assignment.endedAt) || Number(assignment.startedAt) || null
    const turnIsNewer = Number.isFinite(endAt) && assignmentEnd !== null && endAt > assignmentEnd
    if (!turnIsNewer) {
      const detail = nonEmptyString(assignment.reason) ?? nonEmptyString(assignment.error)
      return {
        status: STATUS.INTERRUPTED,
        reason: `assignment:${assignment.status}${detail !== null ? `:${truncate(detail, 120)}` : ''}`,
        source: 'assignment',
        at: assignmentEnd,
        // An interrupted assignment can be acknowledged (read in the board or in
        // the native view): the status stays interrupted, the attention flag
        // clears. Without any timestamp the persisted ack is the only evidence.
        _seen: hasSeen && (assignmentEnd === null || seenAt >= assignmentEnd),
      }
    }
  }
  if (row === undefined) {
    // No live session row. Even a stale turn end, unread flag or ack in the host
    // state cannot prove it finished: the runtime no longer knows it.
    return { status: STATUS.UNKNOWN, reason: 'no_row_for_session', source: 'none', at: null }
  }
  // Failure truth: the host-recorded turn end wins, then the native lifecycle
  // fact. A recovered failure (a later turn started) is no longer a failure, and
  // a native failure the host missed must not be hidden by a stale completed end.
  const hostKind = typeof end?.kind === 'string' ? end.kind : null
  const hostFailed = hostKind !== null && ERROR_TURN_KINDS.includes(hostKind) && end?.recoveredAt === undefined
  const hostTurn = Number(end?.turn)
  const nativeFailed = nativeEnd !== null && ERROR_TURN_KINDS.includes(nativeEnd.reason)
  // The host end is a NEWER fact when it explicitly recovered the failure or
  // when it names a later turn; otherwise the native failure wins.
  const hostIsNewer = end !== null && (end.recoveredAt !== undefined
    || (Number.isFinite(hostTurn) && nativeEnd !== null && Number.isFinite(Number(nativeEnd.turn)) && Number(nativeEnd.turn) < hostTurn))
  if (hostFailed) {
    const covered = hasSeen && Number.isFinite(endAt) && seenAt >= endAt
    return failed(`turn_end:${hostKind}`, 'host_turn_end', Number.isFinite(endAt) ? endAt : null, { _seen: covered })
  }
  if (nativeFailed && !hostIsNewer) {
    // Native-only failure: the host may have missed the event (restart). The
    // persisted ack is the only read cursor available (a native turn end has no
    // timestamp), so an explicit ack is what clears the attention flag.
    return failed(`native_turn_end:${nativeEnd.reason}`, 'session_projection', null, { _seen: hasSeen })
  }
  // Session truth: an agent the runtime reports as gone is `unavailable`, even
  // when a turn end was recorded earlier. It is never "finished".
  if (row?.agentAvailable === false) {
    return { status: STATUS.UNAVAILABLE, reason: 'agent_not_available', source: 'session_row', at: null }
  }
  if (nativeEnd !== null && nativeEnd.reason !== COMPLETED_TURN_KIND && !nativeFailed && !hostIsNewer) {
    // Same rule for a native non-completion the host missed (aborted, blocked,
    // interrupted, forked, max-tokens): the stale completed end must not turn it
    // into a fresh result.
    return { status: STATUS.IDLE, reason: `native_turn_ended:${nativeEnd.reason}`, source: 'session_projection', at: null }
  }
  if (end !== null && Number.isFinite(endAt)) {
    if (hostKind === COMPLETED_TURN_KIND) {
      if (hasSeen && seenAt >= endAt) {
        return { status: STATUS.FINISHED_READ, reason: `ack_after_turn:${hostKind}`, source: 'host_turn_end', at: endAt }
      }
      return { status: STATUS.FINISHED_UNREAD, reason: `turn_end:${hostKind}_not_acknowledged`, source: 'host_turn_end', at: endAt }
    }
    // aborted / blocked / unknown / max-tokens / a recovered error: the turn did
    // NOT complete, so it is never a green "result" (idle with a reason).
    const recovered = end.recoveredAt !== undefined ? ':recovered' : ''
    return { status: STATUS.IDLE, reason: `turn_ended:${hostKind ?? 'unknown'}${recovered}`, source: 'host_turn_end', at: endAt }
  }
  if (live?.completionUnread === true) {
    // The native runtime also tracks unread completions. An explicit board ack
    // that is newer than the session's last activity covers it; when the row
    // carries no activity timestamp the ack is the only evidence available.
    const activityKnown = Number.isFinite(updatedAt) && updatedAt > 0
    if (hasSeen && (!activityKnown || seenAt >= updatedAt)) {
      return { status: STATUS.FINISHED_READ, reason: 'ack_after_native_activity', source: 'host_status', at: seenAt }
    }
    return { status: STATUS.FINISHED_UNREAD, reason: 'native_completion_unread', source: 'host_status', at: null }
  }
  if (nativeEnd !== null) {
    // Only a `completed` native turn end reaches this point (any other reason
    // returned `idle` above): it is history, not "new", and it has no timestamp
    // so it can never be "recent".
    return { status: STATUS.FINISHED_READ, reason: `native_history:${nativeEnd.reason}`, source: 'session_projection', at: null }
  }
  return { status: STATUS.IDLE, reason: 'no_activity', source: 'session_row', at: null }
}

/** Backward-compatible status-only view of {@link classifyStatusDetailed}. */
function classifyStatus(input) {
  return classifyStatusDetailed(input).status
}

/** `projectionValues.mobilePushLifecycle.lastTurnEnd` = { turn, reason } when present. */
function nativeTurnEndOf(row) {
  const end = row?.projectionValues?.mobilePushLifecycle?.lastTurnEnd
  if (end === null || typeof end !== 'object') return null
  const reason = typeof end.reason === 'string' ? end.reason : (typeof end.reason?.kind === 'string' ? end.reason.kind : null)
  return reason === null ? null : { turn: Number(end.turn) || null, reason }
}

/**
 * The action the user is expected to take right now, if any. Sources, in
 * order: the unified status `pendingInteraction`, then the session's own
 * projection (an active user question, a plan awaiting review).
 */
function expectedActionOf(live, row) {
  const pending = live?.pendingInteraction
  if (pending !== null && pending !== undefined) {
    const kind = typeof pending === 'string' ? pending : pending.kind
    if (typeof kind === 'string' && kind !== '') return PENDING_ACTION[kind] ?? 'unknown'
  }
  const values = row?.projectionValues
  if (Array.isArray(values?.userQuestions?.active) && values.userQuestions.active.length > 0) return 'question'
  if (values?.plan?.pending === true) return 'plan-review'
  return null
}

/** Short human text of what is missing (first active question), if known. */
function waitingDetailOf(row) {
  const question = row?.projectionValues?.userQuestions?.active?.[0]
  const candidates = [question?.question, question?.questions?.[0]?.question, question?.title, question?.header]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return truncate(candidate.trim(), 160)
  }
  return null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Normalize any accepted model shape to `{provider, model, reasoningEffort}`.
 * Returns `null` when nothing is known: a partial shape with neither a
 * provider nor a model is not a model.
 */
function normalizeModelInfo(value) {
  if (typeof value === 'string') {
    const [provider, model] = value.split('/')
    if (nonEmptyString(provider) !== null && nonEmptyString(model) !== null) {
      return { provider, model, reasoningEffort: null }
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const provider = nonEmptyString(value.provider)
  const model = nonEmptyString(value.model) ?? nonEmptyString(value.id)
  if (provider === null && model === null) return null
  return { provider, model, reasoningEffort: nonEmptyString(value.reasoningEffort) }
}

/**
 * The default native resolver: ONLY the `modelSelection` projection value DSH
 * publishes per session (`modelSelection.lastUsed`, fed by the `model/selection`
 * session event). No other field is consulted — a session whose model is
 * unknown must stay unknown instead of inheriting the deployment default.
 */
function nativeModelOf(row) {
  return normalizeModelInfo(row?.projectionValues?.modelSelection?.lastUsed)
}

/**
 * Resolve the model shown on one card.
 *
 * Contract the host may inject as `modelOf`:
 *   `modelOf(sessionId: string, row: object|undefined) -> {provider, model, reasoningEffort?} | "provider/model" | null | undefined`
 * The injected resolver is the NATIVE source (it replaces the `modelSelection`
 * read, not the assignment): when it is supplied, its `null` result means
 * "native model unknown" and no other native field is used as a fallback. A
 * throw is treated as unknown (the panel must never crash on a resolver).
 *
 * Precedence (chosen on purpose): the board assignment that launched the card
 * wins, because it is the route the board itself created and may have switched;
 * otherwise the native `modelSelection` projection is shown. An assignment route
 * is NEVER copied onto a native session: an assignment only exists for a card
 * the board launched.
 */
function resolveNodeModel({ sessionId, row, assignment = null, modelOf, projectionsBySession = null }) {
  const id = String(sessionId ?? row?.id ?? '')
  let native = null
  if (typeof modelOf === 'function') {
    try {
      native = normalizeModelInfo(modelOf(id, row))
    } catch {
      native = null
    }
  } else {
    native = nativeModelOf(row) ?? normalizeModelInfo(projectionsBySession?.[id]?.values?.modelSelection?.lastUsed)
  }
  if (assignment !== null && typeof assignment === 'object') {
    const assigned = normalizeModelInfo(assignment.model)
    if (assigned !== null) return { ...assigned, source: MODEL_SOURCE.ASSIGNMENT }
  }
  if (native !== null) return { ...native, source: MODEL_SOURCE.NATIVE }
  return { provider: null, model: null, reasoningEffort: null, source: MODEL_SOURCE.UNKNOWN }
}

/** `provider/model` label of a resolved model, or null when unknown. */
function modelLabelOf(model) {
  if (model === null || model === undefined || typeof model !== 'object') return null
  const provider = nonEmptyString(model.provider)
  const name = nonEmptyString(model.model)
  if (provider === null && name === null) return null
  return `${provider ?? '?'}/${name ?? '?'}`
}

/**
 * Remember the last model observed for a session and return the history entry
 * appended when it CHANGED (or null). The memory map is owned by the caller
 * (the client store) and bounded, so a long-lived panel cannot grow forever.
 * Identity stays the session id: a model change never creates a second card.
 *
 * Provenance: an assignment route is NOT a native model/selection change. The
 * host already owns that fact in `assignment.routeHistory` (with the real
 * switch reason), so an assignment-sourced value returns null and does not
 * touch the native memory. Only native `modelSelection` transitions are kept
 * here, with `source:'native'`.
 */
function trackModelChange(memory, sessionId, model, now = Date.now(), { limit = MODEL_HISTORY_LIMIT, maxSessions = 512 } = {}) {
  if (memory === null || typeof memory?.get !== 'function' || typeof memory.set !== 'function') return null
  if (model?.source === MODEL_SOURCE.ASSIGNMENT) return null
  const label = modelLabelOf(model)
  if (label === null) return null
  const id = String(sessionId)
  const current = memory.get(id)
  if (current === undefined) {
    memory.set(id, { last: label, entries: [] })
    if (memory.size > maxSessions) {
      const oldest = memory.keys().next()
      if (oldest.done !== true) memory.delete(oldest.value)
    }
    return null
  }
  if (current.last === label) return null
  const entry = { from: current.last, to: label, at: Number(now) || null, reason: 'model_change', source: MODEL_SOURCE.NATIVE }
  current.last = label
  current.entries = [...current.entries, entry].slice(-limit)
  return entry
}

/** Snapshot `{ sessionId: entries[] }` of the model history memory. */
function modelHistoryOf(memory) {
  const out = {}
  if (memory === null || memory === undefined || typeof memory.entries !== 'function') return out
  for (const [id, record] of memory) {
    if (Array.isArray(record?.entries) && record.entries.length > 0) out[id] = record.entries
  }
  return out
}

/** Merge two route/model histories, dropping exact duplicates, order preserved. */
function mergeRouteHistory(assignmentHistory, nativeHistory) {
  const out = []
  const seen = new Set()
  const sources = [Array.isArray(assignmentHistory) ? assignmentHistory : [], Array.isArray(nativeHistory) ? nativeHistory : []]
  for (const entries of sources) {
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const key = `${entry.from ?? ''}>${entry.to ?? ''}@${entry.at ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

function historyFor(modelHistory, sessionId) {
  if (modelHistory === null || modelHistory === undefined) return []
  const value = typeof modelHistory.get === 'function' ? modelHistory.get(sessionId) : modelHistory[sessionId]
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.entries)) return value.entries
  return []
}

/**
 * The provider outage affecting a session, or null.
 *
 * Only an INJECTED health table can produce `provider_unavailable`: the entry
 * must still be cooling down (`cooldownUntil > now`) and the session must not
 * have moved since the outage was observed (a later completed turn means this
 * card is not blocked). No health table -> the status never appears.
 */
function providerOutageOf(health, provider, { now = Date.now(), sessionAt = null } = {}) {
  if (health === null || health === undefined || typeof health !== 'object') return null
  const name = nonEmptyString(provider)
  if (name === null) return null
  const entry = health[name]
  if (entry === null || typeof entry !== 'object') return null
  const cooldownUntil = Number(entry.cooldownUntil)
  if (!Number.isFinite(cooldownUntil) || cooldownUntil <= now) return null
  const lastFailureAt = Number(entry.lastFailureAt)
  const failureAt = Number.isFinite(lastFailureAt) ? lastFailureAt : null
  const activityAt = Number(sessionAt)
  if (failureAt !== null && Number.isFinite(activityAt) && activityAt > failureAt) return null
  const kind = nonEmptyString(entry.lastFailureKind) ?? 'unknown'
  return {
    provider: name,
    cooldownUntil,
    kind,
    at: failureAt,
    // The reason carries the exact cooldown deadline so the card explains when
    // the provider is expected back, without a second status field.
    reason: `provider_cooldown:${name}:${kind}:until:${new Date(cooldownUntil).toISOString()}`,
  }
}

/** The only turn-end kind that delivered a complete answer. */
const COMPLETED_TURN_KIND = 'completed'

/**
 * The fact that closed the most recent turn, or null.
 *
 * A host-recorded failure wins when it is not recovered (the native projection
 * may have missed it); otherwise the native fact wins because it carries the
 * turn number needed to attribute an outline response to its own turn.
 */
function closingTurnOf(row, end) {
  const hostKind = end !== null && typeof end === 'object' && end.recoveredAt === undefined && typeof end.kind === 'string' ? end.kind : null
  const native = nativeTurnEndOf(row)
  if (hostKind !== null && hostKind !== COMPLETED_TURN_KIND) {
    return { kind: hostKind, turn: native !== null ? native.turn : null, source: 'host_turn_end' }
  }
  if (native !== null) return { kind: native.reason, turn: native.turn, source: 'session_projection' }
  return hostKind !== null ? { kind: hostKind, turn: null, source: 'host_turn_end' } : null
}

/**
 * The final answer excerpt. Only an answer that closed a COMPLETED turn is
 * "final":
 *   1. host-captured last assistant message when the session is not running
 *      and a turn end was recorded at/after it;
 *   2. the native turn outline `response` of the latest answered turn;
 *   3. a board checkpoint text, only when its assignment completed.
 * A mid-turn assistant segment (between tool calls) is never presented as the
 * final answer; it is exposed separately as `interim` only for activity.
 */
function previewOf(hostState, sessionId, assignment, row, running = false) {
  const preview = hostState?.previews?.[sessionId]
  const end = hostState?.turnEnd?.[sessionId]
  const hasEnd = end !== null && end !== undefined && typeof end === 'object'
  const closing = closingTurnOf(row, hasEnd ? end : null)
  const closedWell = closing !== null && closing.kind === COMPLETED_TURN_KIND
  const hostText = preview !== undefined && typeof preview.text === 'string' ? preview.text.trim() : ''
  if (hostText !== '' && !running && hasEnd && Number(end.at) >= Number(preview.at)) {
    // The captured segment is only a FINAL answer when the turn that closed it
    // actually completed. An error/aborted/unknown turn ends with a partial
    // segment, and an intermediate segment must never be labelled final.
    const kind = typeof end.kind === 'string' ? end.kind : 'unknown'
    return {
      text: truncate(hostText, 600),
      at: Number(preview.at) || null,
      final: closedWell,
      partial: !closedWell,
      turnEndKind: kind,
      source: 'host',
    }
  }
  const outline = row?.projectionValues?.turnOutline
  if (Array.isArray(outline)) {
    for (let index = outline.length - 1; index >= 0; index -= 1) {
      const entry = outline[index]
      const isOpenTurn = running && index === outline.length - 1
      if (isOpenTurn) continue
      if (typeof entry?.response !== 'string' || entry.response.trim() === '') continue
      const turn = Number(entry.turn)
      // Which turn produced this response? Use the turn number when the closing
      // fact carries one; otherwise the newest entry is the only candidate.
      const belongsToClosingTurn = closing !== null && !closedWell && (Number.isFinite(closing.turn) && Number.isFinite(turn)
        ? turn === closing.turn
        : index === outline.length - 1)
      if (belongsToClosingTurn) {
        return {
          text: truncate(entry.response.trim(), 600),
          at: null,
          final: false,
          partial: true,
          source: 'outline',
          turn: Number.isFinite(turn) ? turn : null,
          turnEndKind: closing.kind,
        }
      }
      return { text: truncate(entry.response.trim(), 600), at: null, final: true, partial: false, source: 'outline', turn: Number.isFinite(turn) ? turn : null }
    }
  }
  const checkpointText = assignment?.checkpoint?.lastText
  if (!running && typeof checkpointText === 'string' && checkpointText !== '') {
    // A board checkpoint describes an attempt in progress: it is only a final
    // answer when that assignment actually completed (`done`) and no negative
    // turn end closed after it.
    const finalized = assignment?.status === 'done' && (closing === null || closedWell)
    return {
      text: truncate(checkpointText, 600),
      at: Number(assignment?.checkpoint?.at) || null,
      final: finalized,
      partial: !finalized,
      source: 'checkpoint',
      turnEndKind: closing !== null ? closing.kind : null,
    }
  }
  return { text: '', at: null, final: false, partial: false, source: null }
}

/** Last non-empty line of an answer, without markdown decoration. */
function lastUsefulLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text.split(/\r?\n/).map(line => line.replace(/^[\s>#*\-|`]+/, '').replace(/[`*|]+$/g, '').trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] !== '' && !/^-{3,}$/.test(lines[index])) return truncate(lines[index], 220)
  }
  return ''
}

/** Normalize a filesystem path for comparison (case-insensitive drive, `/`). */
function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(path)) path = path.toLowerCase()
  return path
}

/** Workspace index: session membership and normalized directory. */
function indexWorkspaces(workspaces) {
  const bySession = new Map()
  const byPath = []
  for (const workspace of Array.isArray(workspaces?.items) ? workspaces.items : []) {
    if (workspace === null || typeof workspace !== 'object') continue
    const id = workspace.workspaceId ?? workspace.id
    if (typeof id !== 'string' || id === '') continue
    const ref = { id: `ws:${id}`, workspaceId: id, title: workspace.title || workspace.path || id, path: workspace.path ?? null, source: 'workspace' }
    for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
      if (!bySession.has(String(sessionId))) bySession.set(String(sessionId), ref)
    }
    const path = normalizePath(workspace.path)
    if (path !== '') byPath.push({ path, ref })
  }
  byPath.sort((a, b) => b.path.length - a.path.length)
  return { bySession, byPath }
}

const UNASSIGNED_PROJECT = Object.freeze({ id: 'unassigned', title: 'Non attribué', path: null, source: 'none' })

/**
 * Resolve a session's project with reliable keys only:
 *   1. DSH workspace membership (workspace.sessionIds);
 *   2. normalized working directory equal to (or inside) a workspace path;
 *   3. otherwise "unassigned". Titles are never used.
 * Sub-agents inherit their parent's project in buildProjection.
 */
function resolveProject(row, index) {
  const sessionId = String(row?.id ?? '')
  const member = index.bySession.get(sessionId)
  if (member !== undefined) return member
  const cwd = normalizePath(row?.cwd ?? row?.projectionValues?.workingDirectory)
  if (cwd !== '') {
    for (const entry of index.byPath) {
      if (cwd === entry.path || cwd.startsWith(`${entry.path}/`)) return { ...entry.ref, source: 'cwd' }
    }
  }
  return UNASSIGNED_PROJECT
}

function titleOf(row, catalogEntry, nodeId) {
  const label = row?.projectionValues?.subagent?.label ?? catalogEntry?.title
  if (typeof label === 'string' && label.trim() !== '') return label.trim()
  if (typeof row?.displayTitle === 'string' && row.displayTitle !== '') return row.displayTitle.replace(/^#+\s*/, '')
  if (typeof row?.title === 'string' && row.title !== '') return row.title.replace(/^#+\s*/, '')
  return nodeId.slice(-12)
}

/**
 * Build the tree.
 *
 * @param {object} input
 * @param {object} input.list            sessions.list snapshot
 * @param {Map|object} input.statusMap   uiSession.sessionStatus snapshot
 * @param {object} input.hostState       { previews, turnEnd, acks, assignments }
 * @param {object} input.workspaces      { items, archivedSessionIds }
 * @param {number} input.now
 */
/** Session ids the host observed leaving the runtime (`api-session/removed`). */
function indexGone(hostState) {
  const index = new Map()
  const source = hostState?.gone ?? hostState?.removedSessions
  if (source === null || source === undefined) return index
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === 'string') index.set(entry, null)
      else if (typeof entry?.sessionId === 'string') index.set(entry.sessionId, Number(entry.at) || null)
    }
    return index
  }
  if (typeof source === 'object') {
    for (const [id, value] of Object.entries(source)) index.set(id, typeof value === 'number' ? value : (Number(value?.at) || null))
  }
  return index
}

/**
 * Build the tree.
 *
 * @param {object} input
 * @param {object} input.list            sessions.list snapshot
 * @param {Map|object} input.statusMap   uiSession.sessionStatus snapshot
 * @param {object} input.hostState       { previews, turnEnd, acks, assignments, health, gone }
 * @param {object} input.workspaces      { items, archivedSessionIds }
 * @param {number} input.now
 * @param {Function} [input.modelOf]     host resolver: `(sessionId, row) => model|null`
 * @param {object|Map} [input.modelHistory] per-session model changes `{ [id]: entry[] }`
 * @param {object} [input.health]        provider health table (defaults to hostState.health)
 * @param {number} [input.recentWindowMs] window of the non-status `recentlyFinished` flag
 */
function buildProjection({ list, statusMap, hostState = {}, workspaces = {}, now = Date.now(), modelOf, modelHistory = null, health, recentWindowMs = RECENT_FINISHED_MS }) {
  const normalized = normalizeSessions(list)
  const assignmentsBySession = new Map()
  // Tolerant read: a malformed host frame (or an older host) must degrade to an
  // empty assignment list instead of breaking the whole projection.
  for (const assignment of Array.isArray(hostState.assignments) ? hostState.assignments : []) {
    if (typeof assignment?.sessionId === 'string') assignmentsBySession.set(assignment.sessionId, assignment)
  }
  const archived = new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds.map(String) : [])
  const goneIndex = indexGone(hostState)
  const healthTable = health !== undefined ? health : hostState?.health
  const windowMs = Number.isFinite(Number(recentWindowMs)) ? Number(recentWindowMs) : RECENT_FINISHED_MS

  /** @type {Map<string, object>} */
  const nodes = new Map()

  const ensureNode = (id, row) => {
    const existing = nodes.get(id)
    if (existing !== undefined) {
      if (row !== undefined && existing.row === undefined) existing.row = row
      return existing
    }
    const node = { id, row, children: [] }
    nodes.set(id, node)
    return node
  }

  for (const id of normalized.ids) {
    ensureNode(String(id), normalized.byId[id])
  }
  // Catalog entries may describe children whose row is not in the flat list yet
  // (or is filtered out). They still belong to the tree, as unknown if needed.
  // Two catalogs may claim the same child: every claim is recorded, never
  // silently collapsed, so the anomaly stays visible and deterministic.
  const catalogParentOf = new Map()
  const catalogClaimants = new Map()
  // Sorted parents keep the "first claim" fallback deterministic.
  const catalogParents = Object.keys(normalized.projectionsBySession).sort()
  for (const parentId of catalogParents) {
    for (const entry of catalogChildrenOf(normalized.projectionsBySession, parentId)) {
      ensureNode(entry.id, normalized.byId[entry.id])
      const claimants = catalogClaimants.get(entry.id) ?? []
      if (!claimants.includes(parentId)) claimants.push(parentId)
      catalogClaimants.set(entry.id, claimants)
      if (!catalogParentOf.has(entry.id)) catalogParentOf.set(entry.id, parentId)
    }
  }

  const workspaceIndex = indexWorkspaces(workspaces)
  // Team member names declared by a parent (role labels for its children).
  const roleOf = new Map()
  const catalogEntryOf = new Map()
  for (const parentId of catalogParents) {
    for (const entry of catalogChildrenOf(normalized.projectionsBySession, parentId)) catalogEntryOf.set(entry.id, entry)
  }
  for (const id of normalized.ids) {
    const members = normalized.byId[id]?.projectionValues?.agentTeam?.members
    if (!Array.isArray(members)) continue
    for (const member of members) {
      if (member?.role === 'teammate' && typeof member.id === 'string' && typeof member.name === 'string') roleOf.set(member.id, member.name)
    }
  }

  const out = []
  for (const node of nodes.values()) {
    const row = node.row
    const live = statusEntryOf(statusMap, node.id)
    const turnEnd = hostState.turnEnd?.[node.id] ?? null
    const ack = hostState.acks?.[node.id] ?? null
    const assignment = assignmentsBySession.get(node.id) ?? null
    const model = resolveNodeModel({ sessionId: node.id, row, assignment, modelOf, projectionsBySession: normalized.projectionsBySession })
    // A removal tombstone only wins while the runtime does not publish a live
    // row for the session: a resurrected session (row updated at/after the
    // removal) is live evidence and beats the stale fact.
    const goneAt = goneIndex.get(node.id)
    const rowUpdatedAt = Number(row?.updatedAt)
    const resurrected = row !== undefined && (goneAt === null || (Number.isFinite(rowUpdatedAt) && rowUpdatedAt >= goneAt))
    const gone = goneIndex.has(node.id) && !resurrected
    const detail = classifyStatusDetailed({
      row,
      live,
      turnEnd,
      ack,
      assignment,
      gone,
      goneAt,
      provider: model.provider,
      health: healthTable,
      now,
    })
    const status = detail.status
    const project = row !== undefined ? resolveProject(row, workspaceIndex) : UNASSIGNED_PROJECT
    // Parentage: the session row's own lineage wins, a catalog claim is the
    // fallback. A disagreement is flagged, never silently re-parented.
    const rowParent = row !== undefined ? parentIdOf(row) : null
    const claimants = catalogClaimants.get(node.id) ?? []
    const catalogParent = claimants.length > 0 ? [...claimants].sort()[0] : (catalogParentOf.get(node.id) ?? null)
    const resolvedParent = rowParent ?? catalogParent
    const parentSource = rowParent !== null ? 'session_row' : (catalogParent !== null ? 'subagent_catalog' : 'none')
    const contested = claimants.length > 1 || (rowParent !== null && claimants.length > 0 && !claimants.includes(rowParent))
    const ownRunning = row?.running === true || live?.running === true
    const preview = previewOf(hostState, node.id, assignment, row, ownRunning)
    const stats = row?.projectionValues?.sessionStats
    const endAt = Number(turnEnd?.at)
    const endKind = typeof turnEnd?.kind === 'string' ? turnEnd.kind : null
    // Only a turn end kind `completed` delivered a finished answer, and only when
    // the newest turn-end fact (host OR native) is that completion: a stale
    // completed host end must not make a later native failure/abort "recent".
    const closing = closingTurnOf(row, turnEnd !== null && turnEnd !== undefined && typeof turnEnd === 'object' ? turnEnd : null)
    const completedTurnEnd = endKind === COMPLETED_TURN_KIND && (closing === null || closing.kind === COMPLETED_TURN_KIND)
    // A real finish timestamp inside a bounded window. A future timestamp (host
    // and panel clocks differ) still counts: the flag must not flicker.
    const recentlyFinished = completedTurnEnd && Number.isFinite(endAt) && now - endAt <= windowMs
    // Explicit acknowledgement covers a failure or an interrupted launch only
    // when a cursor exists and it is at/after the recorded fact. A native-only
    // failure has no such cursor: it stays visible instead of silently leaving
    // the home view.
    const seen = status === STATUS.FAILED || status === STATUS.INTERRUPTED
      ? detail._seen === true
      : status !== STATUS.FINISHED_UNREAD
    out.push({
      id: node.id,
      parentId: resolvedParent,
      parentSource,
      parentReason: null,
      parentCandidates: contested ? [...claimants].sort() : [],
      parentContested: contested,
      projectId: project.id,
      projectTitle: project.title,
      projectSource: project.source,
      title: titleOf(row, catalogEntryOf.get(node.id), node.id),
      role: roleOf.get(node.id) ?? null,
      cwd: typeof row?.cwd === 'string' ? row.cwd : null,
      origin: typeof row?.origin === 'string' ? row.origin : (resolvedParent !== null ? 'subagent' : 'main'),
      status,
      statusReason: detail.reason,
      statusSource: detail.source,
      statusAt: detail.at,
      seen,
      expectedAction: expectedActionOf(live, row),
      waitingDetail: waitingDetailOf(row),
      model,
      modelSource: model.source,
      preview,
      activity: stats !== undefined && stats !== null
        ? { turns: Number(stats.turns) || 0, steps: Number(stats.steps) || 0, toolMs: Number(stats.toolMs) || 0, llmMs: Number(stats.llmMs) || 0 }
        : null,
      error: typeof turnEnd?.error === 'string' ? turnEnd.error : null,
      goal: typeof row?.projectionValues?.goal?.goal?.objective === 'string' ? truncate(row.projectionValues.goal.goal.objective, 240) : null,
      unread: status === STATUS.FINISHED_UNREAD,
      waiting: status === STATUS.WAITING_USER,
      recovering: status === STATUS.RECOVERING,
      interrupted: status === STATUS.INTERRUPTED,
      providerUnavailable: status === STATUS.PROVIDER_UNAVAILABLE,
      failed: status === STATUS.FAILED,
      unavailable: status === STATUS.UNAVAILABLE,
      archived: archived.has(node.id),
      blank: row?.blank === true,
      // Native fact: the user currently has this session open in the main view.
      // The panel uses it to acknowledge reading done outside the board.
      viewing: Number(row?.retainedBy?.mainView) > 0,
      agentAvailable: typeof row?.agentAvailable === 'boolean' ? row.agentAvailable : null,
      updatedAt: Number(row?.updatedAt) || null,
      // Non-status view facts: a real turn end inside the window, and the
      // provider cooldown deadline when the status is `provider_unavailable`.
      recentlyFinished,
      finishedAt: completedTurnEnd && Number.isFinite(endAt) ? endAt : null,
      healthUntil: Number(detail.healthUntil) || null,
      gone,
      assignmentId: assignment?.id ?? null,
      taskId: assignment?.taskId ?? null,
      assignmentStatus: assignment?.status ?? null,
      previousSessionId: assignment?.previousSessionId ?? null,
      routeHistory: mergeRouteHistory(assignment?.routeHistory, historyFor(modelHistory, node.id)),
      children: [],
      now,
    })
  }

  linkHierarchy(out)

  const byId = new Map(out.map(node => [node.id, node]))
  const isRoot = node => node.parentId === null || node.orphan === true || node.parentCycle === true
  // Descendants live in their root's project: one tree is never split.
  const inherit = (node, project) => {
    node.projectId = project.projectId
    node.projectTitle = project.projectTitle
    for (const childId of node.children) inherit(byId.get(childId), project)
  }
  for (const node of out) if (isRoot(node)) inherit(node, { projectId: node.projectId, projectTitle: node.projectTitle })

  const roots = out.filter(isRoot)
  return { nodes: out, byId, roots, projects: groupProjects(out), counts: summarize(out) }
}

/**
 * Link the filiation tree in O(n).
 *
 *   - orphan: the claimed parent is not in the projection. The claim is kept
 *     (`parentId` unchanged, `parentReason: 'orphan_parent'`) and the node
 *     becomes a root: it is never re-parented silently.
 *   - cycle: the malformed chain is broken at the SMALLEST id of the cycle, so
 *     the result never depends on the input order. That node keeps its
 *     `parentId` but is a root (`parentCycle`, `parentReason: 'cycle_detected'`).
 *   - contested: a child claimed by two catalogs (or by its row and a catalog)
 *     keeps the deterministic parent and carries `parentContested` plus the
 *     candidate list.
 *
 * Each anomaly is also appended to `statusReason`, so the card explains the
 * parentage warning next to the status provenance.
 */
function linkHierarchy(out) {
  const byId = new Map(out.map(node => [node.id, node]))
  // Colouring walk over the functional "parent" graph: every node enters one
  // path once, so the whole pass is linear (the old per-node upward walk was
  // quadratic on a deep chain).
  const color = new Map()
  for (const node of out) {
    if ((color.get(node.id) ?? 0) !== 0) continue
    const path = []
    let cursor = node
    while (cursor !== undefined) {
      const state = color.get(cursor.id) ?? 0
      if (state !== 0) break
      color.set(cursor.id, 1)
      path.push(cursor)
      cursor = cursor.parentId !== null && byId.has(cursor.parentId) ? byId.get(cursor.parentId) : undefined
    }
    if (cursor !== undefined && color.get(cursor.id) === 1) {
      const start = path.findIndex(candidate => candidate.id === cursor.id)
      const cycle = start === -1 ? path : path.slice(start)
      let breaker = cycle[0]
      for (const member of cycle) if (member.id < breaker.id) breaker = member
      breaker.parentCycle = true
      breaker.parentReason = 'cycle_detected'
    }
    for (const visited of path) color.set(visited.id, 2)
  }
  for (const node of out) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      node.orphan = true
      node.parentReason = node.parentReason ?? 'orphan_parent'
    } else if (node.parentContested === true) {
      node.parentReason = node.parentReason ?? 'contested_parents'
    }
    if (node.parentReason !== null && node.parentReason !== undefined) {
      node.statusReason = `${node.statusReason} · ${node.parentReason}`
    }
  }
  for (const node of out) {
    if (node.parentId !== null && !node.orphan && !node.parentCycle) byId.get(node.parentId).children.push(node.id)
  }
  return byId
}

function groupProjects(nodes) {
  const groups = new Map()
  for (const node of nodes) {
    if (!groups.has(node.projectId)) groups.set(node.projectId, { id: node.projectId, title: node.projectTitle, nodes: [] })
    groups.get(node.projectId).nodes.push(node.id)
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))
}

function summarize(nodes) {
  const counts = {
    total: nodes.length,
    running: 0,
    waiting_user: 0,
    recovering: 0,
    interrupted: 0,
    provider_unavailable: 0,
    finished_unread: 0,
    finished_read: 0,
    failed: 0,
    idle: 0,
    unknown: 0,
    unavailable: 0,
  }
  for (const node of nodes) {
    if (counts[node.status] !== undefined) counts[node.status] += 1
  }
  return counts
}

/** Depth-first flattening honouring collapsed subtrees. */
function flattenVisible(roots, byId, collapsedIds = new Set()) {
  const out = []
  const visit = (node, depth) => {
    const collapsed = collapsedIds.has(node.id)
    out.push({ node, depth, collapsed, hasChildren: node.children.length > 0 })
    if (collapsed) return
    for (const childId of node.children) {
      const child = byId.get(childId)
      if (child !== undefined) visit(child, depth + 1)
    }
  }
  const sorted = [...roots].sort(compareNodes)
  for (const root of sorted) visit(root, 0)
  return out
}

function compareNodes(a, b) {
  const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
  if (rank !== 0) return rank
  return String(a.title).localeCompare(String(b.title))
}

/**
 * Ancestors that must stay visible even when a descendant is shown out of its
 * subtree (the client uses this for a flat/compact list).
 */
function ancestorsOf(byId, sessionId) {
  const chain = []
  let current = byId.get(sessionId)
  const guard = new Set()
  while (current !== undefined && current.parentId !== null && !guard.has(current.parentId)) {
    guard.add(current.parentId)
    const parent = byId.get(current.parentId)
    if (parent === undefined) break
    chain.push(parent.id)
    current = parent
  }
  return chain.reverse()
}

/** Compact mode: one row per agent, no tree indentation, parents kept flat. */
function compactRows(projection) {
  return [...projection.nodes].sort((a, b) => {
    const project = String(a.projectTitle).localeCompare(String(b.projectTitle))
    return project !== 0 ? project : compareNodes(a, b)
  })
}


// ---- src/supervisor/super-orchestrator.js ----
/**
 * Super Orchestrator supervision projection (pure).
 *
 * This module turns the facts the host already owns into the supervision
 * payload the panel renders. It is PURE: no `node:` API, no `ctx`, no I/O, no
 * timer. It is also concatenated into the browser bundle, so it only depends on
 * names defined by `contracts/model.js` and `contracts/agent-roles.js` (both
 * earlier in the build order) — nothing from the host.
 *
 * Honesty rules (the reason this module exists):
 *   - the workspace node is a synthetic supervision LAYER (policy engine), NOT
 *     an AI agent: `synthetic:true`, `role:'super_orchestrator'`. A real agent
 *     whose DECLARED role resolves to `super_orchestrator` may be exposed as
 *     `workspace.agent`; otherwise it is `null` (never fabricated);
 *   - a project orchestrator is only an agent whose declared role resolves to
 *     `orchestrator`; otherwise `null` (a visible gap, not a fake node);
 *   - the workspace status comes from real facts only: mode `off` => `idle`
 *     (observing, never `active`), Stop or a secondary instance => `blocked`,
 *     otherwise `active`. No invented runtime state;
 *   - blocks come from real facts only (failed/interrupted agents, provider
 *     cooldown, Task Board blocked tasks, unsatisfied cross-project
 *     prerequisites) and every block carries its `source` and `at`;
 *   - recommendations are LOCAL PROPOSALS: `status:'proposed'`, `applies:false`.
 *     This module never writes the Task Board;
 *   - a capability that does not exist is reported `unavailable` / `proposal_only`
 *     with a reason, never simulated.
 *
 * @module dsh-agent-board/supervisor/super-orchestrator
 */


/** Shape version of the supervision payload. */
const SUPERVISION_VERSION = 1
/** Synthetic workspace id: the host supervision layer, not an agent. */
const SUPERVISION_WORKSPACE_ID = 'workspace:supervision'
/** Bounded published event history (newest kept). */
const MAX_SUPERVISION_EVENTS = 50
/** Bounds so one large ledger cannot inflate the SSE/HTTP frame. */
const MAX_SUPERVISION_BLOCKS = 100
const MAX_SUPERVISION_RECOMMENDATIONS = 50
const MAX_SUPERVISION_TASKS = 200
const MAX_SUPERVISION_DEPENDENCIES = 100

const SUPERVISION_HOUR_MS = 3_600_000
const SUPERVISION_ACTIVE_ASSIGNMENT_STATUSES = Object.freeze(['starting', 'running', 'recovering'])
const SUPERVISION_BLOCKING_AGENT_STATUSES = Object.freeze([STATUS.FAILED, STATUS.INTERRUPTED, STATUS.PROVIDER_UNAVAILABLE])
const SUPERVISION_RECOMMENDATION_KIND_ORDER = Object.freeze({ delegate: 0, unblock: 1, priority: 2, reassign: 3 })
/** The Task Board workflow state that satisfies a prerequisite (human-confirmed). */
const SUPERVISION_DONE_TASK_STATUS = 'done'

/**
 * Build the supervision payload for one host state.
 *
 * @param {object} input
 * @param {object|null} input.projection  `buildProjection()` output (real agent nodes)
 * @param {object|null} input.hostState   durable host facts (mode, policy, assignments, proposals…)
 * @param {object|null} [input.taskboard] Task Board coordination read model (contract D) or null
 * @param {number} [input.now]
 * @returns {object} the supervision payload (plain JSON)
 */
function buildSupervision(input = {}) {
  const source = supervisionIsPlainObject(input) ? input : {}
  const now = Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now()
  const hostState = supervisionIsPlainObject(source.hostState) ? source.hostState : {}
  const policy = supervisionIsPlainObject(hostState.policy) ? hostState.policy : {}
  const config = normalizeSupervision(policy.supervision ?? {}, DEFAULT_POLICY.supervision)
  const nodes = Array.isArray(source.projection?.nodes) ? source.projection.nodes.filter(node => supervisionIsPlainObject(node)) : []
  const assignments = Array.isArray(hostState.assignments) ? hostState.assignments.filter(entry => supervisionIsPlainObject(entry)) : []
  const proposals = Array.isArray(hostState.proposals) ? hostState.proposals.filter(entry => supervisionIsPlainObject(entry)) : []
  const taskboard = supervisionNormalizeTaskboard(source.taskboard)
  const mode = typeof hostState.mode === 'string' ? hostState.mode : null

  const assignmentsById = new Map()
  for (const assignment of assignments) {
    if (typeof assignment.id === 'string' && assignment.id !== '') assignmentsById.set(assignment.id, assignment)
  }

  const roleCache = new Map()
  const roleOf = node => {
    const declared = typeof node.role === 'string' && node.role !== '' ? node.role : null
    if (roleCache.has(declared)) return roleCache.get(declared)
    const resolved = declared === null ? { roleId: null, source: 'generic', raw: null } : dabResolveAgentRole(declared)
    const value = {
      roleId: typeof resolved?.roleId === 'string' && resolved.roleId !== '' ? resolved.roleId : null,
      source: resolved?.source === 'explicit' || resolved?.source === 'alias' ? resolved.source : 'generic',
      raw: typeof resolved?.raw === 'string' ? resolved.raw : declared,
      label: typeof resolved?.role?.label === 'string' ? resolved.role.label : null,
    }
    roleCache.set(declared, value)
    return value
  }

  const agents = nodes.map(node => supervisionAgentOf(node, assignmentsById, roleOf))
  const agentsById = new Map(agents.map(agent => [agent.id, agent]))

  const crossProjectDependencies = supervisionBuildCrossProjectDependencies({
    tasks: taskboard.tasks,
    dependencies: taskboard.dependencies,
    now,
  })
  const blocks = supervisionBuildBlocks({ agents, taskboard, crossProjectDependencies, now })

  const delegation = {
    depthLimit: config.maxDelegationDepth,
    concurrentLimit: config.maxConcurrentDelegations,
    hourlyLimit: config.maxDelegationsPerHour,
    allowCrossProjectDelegation: config.allowCrossProjectDelegation,
    usedThisHour: supervisionLaunchesWithinHour(assignments, now),
    // Board-launched assignments in flight: the durable assignment facts, not a
    // projection count (a launch that has no observable node yet still counts).
    inFlight: assignments.filter(assignment => SUPERVISION_ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status)).length,
  }

  const workspaceStatus = supervisionStatusOf({ mode, stoppedAt: hostState.stoppedAt, instance: hostState.instance, enabled: config.enabled })

  const projects = supervisionBuildProjects({
    nodes,
    agents,
    agentsById,
    blocks,
    crossProjectDependencies,
    roleOf,
  })

  const capabilities = supervisionCapabilities({ config, taskboard })
  const recommendations = config.enabled === true && taskboard.available === true
    ? supervisionBuildRecommendations({
      tasks: taskboard.tasks,
      assignments,
      proposals,
      policy,
      config,
      inFlight: delegation.inFlight,
      usedThisHour: delegation.usedThisHour,
      now,
    })
    : []

  const counts = {
    projects: projects.length,
    agents: agents.length,
    running: agents.filter(agent => agent.status === STATUS.RUNNING).length,
    waiting: agents.filter(agent => agent.status === STATUS.WAITING_USER).length,
    unread: agents.filter(agent => agent.status === STATUS.FINISHED_UNREAD).length,
    failed: agents.filter(agent => agent.status === STATUS.FAILED).length,
    interrupted: agents.filter(agent => agent.status === STATUS.INTERRUPTED).length,
    blocked: blocks.length,
  }

  return {
    version: SUPERVISION_VERSION,
    at: now,
    workspace: {
      id: SUPERVISION_WORKSPACE_ID,
      // A supervision LAYER, explicitly labelled: not an AI agent.
      synthetic: true,
      role: 'super_orchestrator',
      emblem: config.emblem,
      mode,
      status: workspaceStatus.status,
      reason: workspaceStatus.reason,
      // A real agent may carry that role; the layer never invents one.
      agent: supervisionWorkspaceAgentOf(agents, roleOf, nodes),
      counts,
      delegation,
    },
    projects,
    blocks,
    crossProjectDependencies,
    recommendations,
    capabilities: capabilities.values,
    capabilityReasons: capabilities.reasons,
    limits: {
      enabled: config.enabled,
      depthLimit: config.maxDelegationDepth,
      concurrentLimit: config.maxConcurrentDelegations,
      hourlyLimit: config.maxDelegationsPerHour,
      allowCrossProjectDelegation: config.allowCrossProjectDelegation,
      bounded: {
        events: MAX_SUPERVISION_EVENTS,
        blocks: MAX_SUPERVISION_BLOCKS,
        recommendations: MAX_SUPERVISION_RECOMMENDATIONS,
        tasks: MAX_SUPERVISION_TASKS,
        crossProjectDependencies: MAX_SUPERVISION_DEPENDENCIES,
      },
    },
    taskboard,
  }
}

/**
 * Diff two supervision payloads into REAL transition events only.
 *
 * Rules:
 *   - an entity absent from the previous payload establishes the baseline: no
 *     event is emitted for merely being observed for the first time (that would
 *     fabricate an `agent.started` after a projection gap);
 *   - every event is a real diff of a durable/observed field;
 *   - stable id `${type}|${entityId}|${at}`: the same fact always yields the same
 *     id, so consumers may de-duplicate and tolerate order;
 *   - bounded to the newest {@link MAX_SUPERVISION_EVENTS}.
 *
 * Types: `agent.status.changed`, `agent.started`, `agent.task.assigned`,
 * `agent.blocked`, `agent.delegated`, `agent.task.completed`,
 * `project.status.changed`, `task.status.changed`, `task.assignee.changed`.
 *
 * @param {object|null} previous previous buildSupervision() payload
 * @param {object|null} next     new buildSupervision() payload
 * @param {number} [at]          transition timestamp (epoch ms)
 * @returns {object[]} bounded events
 */
function supervisionEvents(previous, next, at = Date.now()) {
  if (!supervisionIsPlainObject(previous) || !supervisionIsPlainObject(next)) return []
  const time = Number.isFinite(Number(at)) ? Number(at) : Date.now()
  const out = []
  const beforeAgents = supervisionAgentIndex(previous)
  const afterAgents = supervisionAgentIndex(next)
  for (const id of [...afterAgents.keys()].sort()) {
    const before = beforeAgents.get(id)
    const current = afterAgents.get(id)
    if (before === undefined || current === undefined) continue
    if (before.status !== current.status) {
      out.push(supervisionEventOf('agent.status.changed', id, time, {
        from: before.status ?? null,
        to: current.status ?? null,
        reason: current.statusReason ?? null,
      }))
      if (current.status === STATUS.RUNNING && before.status !== STATUS.RUNNING) {
        out.push(supervisionEventOf('agent.started', id, time, { taskId: current.taskId ?? null, assignmentId: current.assignmentId ?? null }))
      }
      if (SUPERVISION_BLOCKING_AGENT_STATUSES.includes(current.status) && !SUPERVISION_BLOCKING_AGENT_STATUSES.includes(before.status)) {
        out.push(supervisionEventOf('agent.blocked', id, time, { status: current.status, reason: current.statusReason ?? null }))
      }
    }
    if ((before.taskId ?? null) !== (current.taskId ?? null) && (current.taskId ?? null) !== null) {
      out.push(supervisionEventOf('agent.task.assigned', id, time, { from: before.taskId ?? null, to: current.taskId }))
    }
    if (before.assignmentStatus !== 'done' && current.assignmentStatus === 'done') {
      out.push(supervisionEventOf('agent.task.completed', id, time, { taskId: current.taskId ?? null, assignmentId: current.assignmentId ?? null }))
    }
    if ((before.assignmentId ?? null) !== (current.assignmentId ?? null)
      && (current.assignmentId ?? null) !== null
      && current.delegation !== null && current.delegation !== undefined
      // A handoff CONTINUES a delegation (same depth, `requestedBy` handoff): it
      // is not a new delegation and must not be reported as one.
      && current.delegation.requestedBy !== 'board:handoff'
      && current.delegation.depth > (before.delegation?.depth ?? -1)) {
      out.push(supervisionEventOf('agent.delegated', id, time, {
        assignmentId: current.assignmentId,
        taskId: current.taskId ?? null,
        depth: current.delegation.depth,
        rootTaskId: current.delegation.rootTaskId ?? null,
      }))
    }
  }

  const beforeProjects = supervisionProjectIndex(previous)
  const afterProjects = supervisionProjectIndex(next)
  for (const id of [...afterProjects.keys()].sort()) {
    const before = beforeProjects.get(id)
    const current = afterProjects.get(id)
    if (before === undefined || current === undefined) continue
    if (before.status !== current.status) {
      out.push(supervisionEventOf('project.status.changed', id, time, {
        from: before.status ?? null,
        to: current.status ?? null,
        reason: current.reason ?? null,
      }))
    }
  }

  const beforeTasks = supervisionTaskIndex(previous)
  const afterTasks = supervisionTaskIndex(next)
  for (const id of [...afterTasks.keys()].sort()) {
    const before = beforeTasks.get(id)
    const current = afterTasks.get(id)
    if (before === undefined || current === undefined) continue
    if (before.status !== current.status) {
      out.push(supervisionEventOf('task.status.changed', id, time, { from: before.status ?? null, to: current.status ?? null }))
    }
    if ((before.assignee ?? null) !== (current.assignee ?? null)) {
      out.push(supervisionEventOf('task.assignee.changed', id, time, { from: before.assignee ?? null, to: current.assignee ?? null }))
    }
  }

  return out.slice(-MAX_SUPERVISION_EVENTS)
}

/**
 * Merge a new event batch into the published history.
 *
 * De-duplicates by the stable id (the FIRST occurrence is kept, so the order in
 * which facts were observed never changes an id's position) and keeps the
 * newest `limit` events.
 *
 * @param {object[]} existing
 * @param {object[]} incoming
 * @param {number} [limit]
 * @returns {object[]}
 */
function mergeSupervisionEvents(existing, incoming, limit = MAX_SUPERVISION_EVENTS) {
  const bound = Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : MAX_SUPERVISION_EVENTS)
  const out = []
  const seen = new Set()
  for (const event of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!supervisionIsPlainObject(event) || typeof event.id !== 'string' || seen.has(event.id)) continue
    seen.add(event.id)
    out.push(event)
  }
  return out.length > bound ? out.slice(-bound) : out
}

// --------------------------------------------------------------- internals

function supervisionIsPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function supervisionEventOf(type, entityId, at, detail = {}) {
  return { id: `${type}|${entityId}|${at}`, type, entityId, at, ...detail }
}

/** Compact agent facts, derived only from the projection node (+ its assignment). */
function supervisionAgentOf(node, assignmentsById, roleOf) {
  const assignment = typeof node.assignmentId === 'string' ? assignmentsById.get(node.assignmentId) ?? null : null
  const role = roleOf(node)
  const delegation = supervisionDelegationOf(assignment)
  return {
    id: String(node.id),
    name: typeof node.title === 'string' && node.title !== '' ? node.title : String(node.id),
    role: role.roleId,
    roleLabel: role.label,
    declaredRole: role.raw,
    roleSource: role.source,
    status: typeof node.status === 'string' ? node.status : STATUS.UNKNOWN,
    statusReason: typeof node.statusReason === 'string' ? node.statusReason : null,
    statusSource: typeof node.statusSource === 'string' ? node.statusSource : null,
    statusAt: Number.isFinite(Number(node.statusAt)) ? Number(node.statusAt) : null,
    projectId: typeof node.projectId === 'string' ? node.projectId : 'unassigned',
    projectTitle: typeof node.projectTitle === 'string' ? node.projectTitle : null,
    parentId: typeof node.parentId === 'string' ? node.parentId : null,
    taskId: typeof node.taskId === 'string' ? node.taskId : null,
    assignmentId: typeof node.assignmentId === 'string' ? node.assignmentId : null,
    assignmentStatus: typeof node.assignmentStatus === 'string'
      ? node.assignmentStatus
      : (typeof assignment?.status === 'string' ? assignment.status : null),
    delegation,
    healthUntil: Number.isFinite(Number(node.healthUntil)) ? Number(node.healthUntil) : null,
    updatedAt: Number.isFinite(Number(node.updatedAt)) ? Number(node.updatedAt) : null,
  }
}

/** The recorded delegation facts, or null. Never inferred. */
function supervisionDelegationOf(assignment) {
  const delegation = assignment?.delegation
  if (!supervisionIsPlainObject(delegation)) return null
  const depth = Number(delegation.depth)
  if (!Number.isFinite(depth) || depth < 0) return null
  return {
    depth: Math.trunc(depth),
    rootTaskId: typeof delegation.rootTaskId === 'string' ? delegation.rootTaskId : null,
    parentAssignmentId: typeof delegation.parentAssignmentId === 'string' ? delegation.parentAssignmentId : null,
    projectId: typeof delegation.projectId === 'string' ? delegation.projectId : null,
    requestedBy: typeof delegation.requestedBy === 'string' ? delegation.requestedBy : null,
  }
}

/** The declared super-orchestrator agent, or null (never a fabricated node). */
function supervisionWorkspaceAgentOf(agents, roleOf, nodes) {
  const nodeById = new Map(nodes.map(node => [String(node.id), node]))
  const candidates = agents.filter(agent => agent.role === 'super_orchestrator')
  if (candidates.length === 0) return null
  const ranked = candidates.map(agent => {
    const node = nodeById.get(agent.id)
    const root = node !== undefined && (node.parentId === null || node.parentId === undefined || node.orphan === true || node.parentCycle === true)
    return { agent, key: [root ? 0 : 1, -(Number(node?.updatedAt) || 0), agent.id] }
  })
  ranked.sort((left, right) => supervisionCompareKeys(left.key, right.key))
  const best = ranked[0].agent
  return {
    id: best.id,
    name: best.name,
    role: 'super_orchestrator',
    declaredRole: best.declaredRole,
    status: best.status,
    projectId: best.projectId,
    statusReason: best.statusReason,
  }
}

function supervisionCompareKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

/** Workspace status from real facts only. */
function supervisionStatusOf({ mode, stoppedAt, instance, enabled }) {
  if (supervisionIsPlainObject(instance) && instance.primary === false) {
    return { status: 'blocked', reason: 'secondary_instance' }
  }
  if (stoppedAt !== null && stoppedAt !== undefined) {
    return { status: 'blocked', reason: 'stopped_by_operator' }
  }
  if (mode === 'off') {
    // Mode off means OBSERVING: the layer is never reported active.
    return { status: 'idle', reason: 'mode_off' }
  }
  if (enabled !== true) return { status: 'idle', reason: 'supervision_disabled' }
  return { status: 'active', reason: 'supervision_active' }
}

function supervisionBuildProjects({ nodes, agents, agentsById, blocks, crossProjectDependencies, roleOf }) {
  const byProject = new Map()
  for (const node of nodes) {
    const id = typeof node.projectId === 'string' ? node.projectId : 'unassigned'
    if (!byProject.has(id)) {
      byProject.set(id, {
        id,
        title: typeof node.projectTitle === 'string' && node.projectTitle !== '' ? node.projectTitle : id,
        nodes: [],
      })
    }
    byProject.get(id).nodes.push(node)
  }
  const projects = []
  for (const group of [...byProject.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))) {
    const projectAgents = group.nodes.map(node => agentsById.get(String(node.id))).filter(agent => agent !== undefined)
    const projectBlocks = blocks.filter(block => block.projectId === group.id)
    const counts = {
      agents: projectAgents.length,
      running: projectAgents.filter(agent => agent.status === STATUS.RUNNING).length,
      waiting: projectAgents.filter(agent => agent.status === STATUS.WAITING_USER).length,
      unread: projectAgents.filter(agent => agent.status === STATUS.FINISHED_UNREAD).length,
      failed: projectAgents.filter(agent => agent.status === STATUS.FAILED).length,
      interrupted: projectAgents.filter(agent => agent.status === STATUS.INTERRUPTED).length,
      blocked: projectBlocks.length,
    }
    // Project status is a derived label over real counts/blocks, with a reason.
    const status = projectBlocks.length > 0
      ? 'blocked'
      : (counts.running > 0 ? 'active' : 'idle')
    const reason = projectBlocks.length > 0
      ? `blocked:${projectBlocks[0].kind}`
      : (counts.running > 0 ? 'agents_running' : 'no_active_agent')
    projects.push({
      id: group.id,
      title: group.title,
      status,
      reason,
      orchestrator: supervisionProjectOrchestratorOf(group.nodes, roleOf),
      agents: projectAgents,
      counts,
      blocks: projectBlocks,
      crossProjectDependencies: crossProjectDependencies.filter(dependency => (
        dependency.fromProjectId === group.id || dependency.toProjectId === group.id
      )),
    })
  }
  return projects
}

/** The project orchestrator: only a DECLARED `orchestrator`, deterministic. */
function supervisionProjectOrchestratorOf(nodes, roleOf) {
  const candidates = nodes
    .filter(node => roleOf(node).roleId === 'orchestrator')
    .map(node => {
      const root = node.parentId === null || node.parentId === undefined || node.orphan === true || node.parentCycle === true
      return { node, key: [root ? 0 : 1, -(Number(node.updatedAt) || 0), String(node.id)] }
    })
    .sort((left, right) => supervisionCompareKeys(left.key, right.key))
  if (candidates.length === 0) return null
  const best = candidates[0].node
  return {
    id: String(best.id),
    name: typeof best.title === 'string' && best.title !== '' ? best.title : String(best.id),
    role: 'orchestrator',
    declaredRole: typeof best.role === 'string' ? best.role : null,
    status: typeof best.status === 'string' ? best.status : STATUS.UNKNOWN,
    projectId: typeof best.projectId === 'string' ? best.projectId : 'unassigned',
  }
}

/**
 * Blocks from real facts only. Every entry names its source and timestamp:
 *   `agent_failed`, `agent_interrupted`, `provider_cooldown`, `task_blocked`,
 *   `cross_project_prerequisite`.
 */
function supervisionBuildBlocks({ agents, taskboard, crossProjectDependencies, now }) {
  const blocks = []
  for (const agent of agents) {
    if (agent.status === STATUS.FAILED) {
      blocks.push({
        id: `agent_failed|${agent.projectId}|${agent.id}`,
        kind: 'agent_failed',
        projectId: agent.projectId,
        agentId: agent.id,
        reason: agent.statusReason ?? 'agent_failed',
        at: agent.statusAt ?? now,
        source: agent.statusSource ?? 'projection',
      })
    } else if (agent.status === STATUS.INTERRUPTED) {
      blocks.push({
        id: `agent_interrupted|${agent.projectId}|${agent.id}`,
        kind: 'agent_interrupted',
        projectId: agent.projectId,
        agentId: agent.id,
        reason: agent.statusReason ?? 'agent_interrupted',
        at: agent.statusAt ?? now,
        source: agent.statusSource ?? 'assignment',
      })
    } else if (agent.status === STATUS.PROVIDER_UNAVAILABLE) {
      blocks.push({
        id: `provider_cooldown|${agent.projectId}|${agent.id}`,
        kind: 'provider_cooldown',
        projectId: agent.projectId,
        agentId: agent.id,
        reason: agent.statusReason ?? 'provider_unavailable',
        at: agent.statusAt ?? now,
        source: 'host_health',
        until: agent.healthUntil,
      })
    }
  }
  for (const task of taskboard.tasks) {
    const projectId = supervisionProjectIdOf(task)
    if (task.status === 'blocked' || task.blocked === true) {
      blocks.push({
        id: `task_blocked|${projectId}|${task.id}`,
        kind: 'task_blocked',
        projectId,
        taskId: task.id,
        reason: 'task_board_blocked',
        at: task.updatedAt ?? now,
        source: 'taskboard',
      })
    }
  }
  for (const dependency of crossProjectDependencies) {
    if (dependency.satisfied === true) continue
    const task = taskboard.tasks.find(entry => entry.id === dependency.fromTaskId)
    if (task === undefined || supervisionTaskStatusOf(task) === SUPERVISION_DONE_TASK_STATUS) continue
    blocks.push({
      id: `cross_project_prerequisite|${dependency.fromTaskId}|${dependency.toTaskId}`,
      kind: 'cross_project_prerequisite',
      projectId: dependency.fromProjectId,
      taskId: dependency.fromTaskId,
      blockedByTaskId: dependency.toTaskId,
      reason: `cross_project_prerequisite_pending:${dependency.toTaskId}`,
      at: dependency.at,
      source: 'taskboard',
    })
  }
  const unique = new Map()
  for (const block of blocks) unique.set(block.id, block)
  return [...unique.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_SUPERVISION_BLOCKS)
}

/** Cross-project `dependsOn` edges: `from` depends on `to` (real Task Board data). */
function supervisionBuildCrossProjectDependencies({ tasks, dependencies, now }) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const out = []
  // The Task Board read model (contract D) already resolves the cross-project
  // flag; when it supplies the edges, use ITS verdict instead of re-deriving it.
  const declaredEdges = Array.isArray(dependencies)
    ? dependencies.filter(edge => supervisionIsPlainObject(edge) && edge.crossProject === true)
    : null
  if (declaredEdges !== null) {
    for (const edge of declaredEdges) {
      const task = byId.get(edge.taskId)
      const dependency = byId.get(edge.dependsOnTaskId)
      if (task === undefined || dependency === undefined) continue
      out.push(supervisionDependencyEdgeOf(task, dependency, now))
    }
  } else {
    for (const task of tasks) {
      for (const dependencyId of task.dependsOn) {
        const dependency = byId.get(dependencyId)
        if (dependency === undefined) continue
        if (!supervisionProjectsDiffer(task, dependency)) continue
        out.push(supervisionDependencyEdgeOf(task, dependency, now))
      }
    }
  }
  const unique = new Map()
  for (const dependency of out) unique.set(dependency.id, dependency)
  return [...unique.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_SUPERVISION_DEPENDENCIES)
}

function supervisionDependencyEdgeOf(task, dependency, now) {
  return {
    id: `taskboard|${task.id}|${dependency.id}`,
    fromTaskId: task.id,
    fromProjectId: supervisionProjectIdOf(task),
    toTaskId: dependency.id,
    toProjectId: supervisionProjectIdOf(dependency),
    source: 'taskboard',
    satisfied: supervisionTaskStatusOf(dependency) === SUPERVISION_DONE_TASK_STATUS,
    at: Math.max(Number(task.updatedAt) || 0, Number(dependency.updatedAt) || 0) || now,
  }
}

function supervisionProjectIdOf(task) {
  if (typeof task?.projectId === 'string' && task.projectId !== '') return task.projectId
  if (typeof task?.workspaceId === 'string' && task.workspaceId !== '') return task.workspaceId
  return 'unknown'
}

function supervisionProjectsDiffer(left, right) {
  const leftProject = typeof left?.projectId === 'string' && left.projectId !== '' ? left.projectId : null
  const rightProject = typeof right?.projectId === 'string' && right.projectId !== '' ? right.projectId : null
  if (leftProject !== null && rightProject !== null) return leftProject !== rightProject
  const leftWorkspace = typeof left?.workspaceId === 'string' ? left.workspaceId : ''
  const rightWorkspace = typeof right?.workspaceId === 'string' ? right.workspaceId : ''
  if (leftWorkspace !== '' && rightWorkspace !== '') return leftWorkspace !== rightWorkspace
  return false
}

function supervisionTaskStatusOf(task) {
  if (task?.trashedAt !== undefined && task?.trashedAt !== null) return 'trashed'
  return typeof task?.status === 'string' ? task.status : 'unknown'
}

function supervisionDependenciesOf(task) {
  return Array.isArray(task?.dependsOn) ? task.dependsOn.map(String) : []
}

/**
 * Readiness, mirroring `orchestrator/dag.js#readinessOf` (which is not part of
 * the browser bundle). A test pins both implementations against the same
 * fixtures; the rule is: status `todo` and every prerequisite `done` (never
 * `in_review`).
 */
function supervisionReadinessOf(task, tasksById) {
  const status = supervisionTaskStatusOf(task)
  if (status === 'trashed') return { ready: false, reason: 'trashed' }
  if (status !== 'todo') return { ready: false, reason: `status:${status}` }
  const blockers = []
  const missing = []
  for (const dependencyId of supervisionDependenciesOf(task)) {
    const dependency = tasksById.get(dependencyId)
    if (dependency === undefined) {
      missing.push(dependencyId)
      continue
    }
    if (supervisionTaskStatusOf(dependency) !== SUPERVISION_DONE_TASK_STATUS) blockers.push(dependencyId)
  }
  if (missing.length > 0) return { ready: false, reason: `unknown_prerequisite:${missing.join(',')}` }
  if (blockers.length > 0) return { ready: false, reason: `blocked_by:${blockers.join(',')}` }
  return { ready: true, reason: 'ready' }
}

function supervisionLaunchesWithinHour(assignments, now) {
  const cutoff = now - SUPERVISION_HOUR_MS
  return assignments
    .filter(assignment => assignment?.previousSessionId === null || assignment?.previousSessionId === undefined)
    .map(assignment => Number(assignment?.startedAt))
    .filter(at => Number.isFinite(at) && at > cutoff).length
}

/**
 * Recommendation proposals. Pure and local: `applies:false`, `status:'proposed'`.
 * Nothing here writes the Task Board.
 */
function supervisionBuildRecommendations({ tasks, assignments, proposals, policy, config, inFlight, usedThisHour }) {
  const out = []
  const tasksById = new Map(tasks.map(task => [task.id, task]))
  const activeTaskIds = new Set(assignments
    .filter(assignment => SUPERVISION_ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status))
    .map(assignment => String(assignment?.taskId)))
  const pendingProposalTaskIds = new Set(proposals
    .filter(proposal => proposal?.status === 'pending')
    .map(proposal => String(proposal?.taskId)))
  const withinLimits = inFlight < config.maxConcurrentDelegations && usedThisHour < config.maxDelegationsPerHour
  const worktreeCapable = policy?.executionBackend === 'taskboard' || policy?.executionBackend === 'contract'

  const push = (kind, task, reason, evidence) => {
    if (out.length >= MAX_SUPERVISION_RECOMMENDATIONS) return
    const projectId = supervisionProjectIdOf(task)
    out.push({
      id: `proposal|${kind}|${task.id}`,
      kind,
      taskId: task.id,
      projectId,
      reason,
      evidence,
      status: 'proposed',
      // A proposal is NEVER applied by this module: there is no write path.
      applies: false,
    })
  }

  // delegate: a READY task with no assignment, only when the capability is
  // gated (supervision enabled) and inside the delegation limits.
  if (withinLimits) {
    for (const task of tasks) {
      if (supervisionTaskStatusOf(task) !== 'todo') continue
      const readiness = supervisionReadinessOf(task, tasksById)
      if (!readiness.ready) continue
      if (activeTaskIds.has(String(task.id)) || pendingProposalTaskIds.has(String(task.id))) continue
      if (typeof task.assignee === 'string' && task.assignee !== '') continue
      if (task.activeExecution === true) continue
      if (task.execution?.mode === 'scheduled') continue
      if (task.isolation === 'worktree' && !worktreeCapable) continue
      push('delegate', task, 'task_ready_and_unassigned', {
        readiness: readiness.reason,
        status: task.status,
        inFlight,
        usedThisHour,
      })
    }
  }

  // unblock: a blocked card whose prerequisites are all done.
  for (const task of tasks) {
    if (task.status !== 'blocked') continue
    const dependencies = supervisionDependenciesOf(task)
    if (dependencies.length === 0) continue
    const known = dependencies.map(id => tasksById.get(id))
    if (known.some(dependency => dependency === undefined)) continue
    if (!known.every(dependency => supervisionTaskStatusOf(dependency) === SUPERVISION_DONE_TASK_STATUS)) continue
    push('unblock', task, 'prerequisites_done_but_card_blocked', { prerequisites: dependencies })
  }

  // priority: only when the Task Board really exposes priorities, and only for a
  // real project-level contention (two projects blocked on one another).
  const hasPriorities = tasks.some(task => task.priority !== undefined && task.priority !== null && task.priority !== '')
  if (hasPriorities) {
    const edges = new Map()
    for (const task of tasks) {
      for (const dependencyId of task.dependsOn) {
        const dependency = tasksById.get(dependencyId)
        if (dependency === undefined) continue
        if (!supervisionProjectsDiffer(task, dependency)) continue
        if (supervisionTaskStatusOf(task) === SUPERVISION_DONE_TASK_STATUS) continue
        const key = `${supervisionProjectIdOf(task)}>${supervisionProjectIdOf(dependency)}`
        if (!edges.has(key)) edges.set(key, [])
        edges.get(key).push({ task, dependency })
      }
    }
    const emitted = new Set()
    for (const [key, list] of [...edges.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      const [fromProjectId, toProjectId] = key.split('>')
      if (fromProjectId === toProjectId || fromProjectId === 'unknown' || toProjectId === 'unknown') continue
      const reverse = edges.get(`${toProjectId}>${fromProjectId}`)
      if (reverse === undefined) continue
      const pairKey = [fromProjectId, toProjectId].sort().join('<>')
      if (emitted.has(pairKey)) continue
      emitted.add(pairKey)
      const candidates = [...list, ...reverse].sort((left, right) => left.task.id.localeCompare(right.task.id))
      const chosen = candidates[0].task
      push('priority', chosen, 'cross_project_contention', {
        projects: [fromProjectId, toProjectId],
        tasks: candidates.map(entry => entry.task.id).sort(),
        priorities: candidates.map(entry => ({ taskId: entry.task.id, priority: entry.task.priority ?? null })),
      })
    }
  }

  // reassign: only ever a proposal — the Task Board exposes no board-facing
  // write API. The real fact is a finished board delegation whose card is still
  // in progress.
  for (const assignment of assignments) {
    if (!['failed', 'interrupted', 'stopped'].includes(assignment?.status)) continue
    const task = tasksById.get(String(assignment?.taskId))
    if (task === undefined || task.status !== 'in_progress') continue
    push('reassign', task, `assignment_${assignment.status}_without_claim_release`, {
      assignmentId: assignment.id ?? null,
      assignmentStatus: assignment.status,
      assignee: typeof task.assignee === 'string' ? task.assignee : null,
      capability: 'proposal_only',
      writeApi: 'unavailable',
    })
  }

  return out
    .sort((left, right) => (SUPERVISION_RECOMMENDATION_KIND_ORDER[left.kind] ?? 9) - (SUPERVISION_RECOMMENDATION_KIND_ORDER[right.kind] ?? 9)
      || left.taskId.localeCompare(right.taskId))
    .slice(0, MAX_SUPERVISION_RECOMMENDATIONS)
}

/** Explicit capability matrix: implemented / proposal-only / unavailable + why. */
function supervisionCapabilities({ config, taskboard }) {
  const enabled = config.enabled === true
  const hasPriorities = taskboard.available === true
    && taskboard.tasks.some(task => task.priority !== undefined && task.priority !== null && task.priority !== '')
  const priority = hasPriorities ? 'proposal_only' : 'unavailable'
  const priorityReason = hasPriorities
    ? 'taskboard_write_api_unavailable'
    : (taskboard.available === true ? 'taskboard_priorities_unavailable' : 'taskboard_unavailable')
  const values = {
    observe: true,
    recommend: enabled,
    delegate: enabled ? 'gated' : 'unavailable',
    reassign: 'proposal_only',
    priority,
    receiveOrchestratorReports: 'unavailable',
    kanbanWrite: 'unavailable',
  }
  const reasons = {}
  if (!enabled) {
    reasons.delegate = 'supervision_disabled'
    reasons.recommend = 'supervision_disabled'
  }
  reasons.reassign = 'taskboard_write_api_unavailable'
  reasons.priority = priorityReason
  reasons.receiveOrchestratorReports = 'no_inbound_orchestrator_report_channel'
  reasons.kanbanWrite = 'taskboard_write_api_unavailable'
  return { values, reasons }
}

function supervisionNormalizeTaskboard(input) {
  const source = supervisionIsPlainObject(input) ? input : null
  const available = source?.available === true
  const rawTasks = available && Array.isArray(source?.tasks) ? source.tasks : []
  const tasks = []
  for (const raw of rawTasks) {
    if (!supervisionIsPlainObject(raw) || typeof raw.id !== 'string' || raw.id === '') continue
    tasks.push({
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      priority: raw.priority ?? null,
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
      projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      assignee: typeof raw.assignee === 'string'
        ? raw.assignee
        : (typeof raw.claimedBy === 'string' ? raw.claimedBy : null),
      revision: raw.revision ?? raw.version ?? null,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : null,
      blocked: raw.blocked === true,
      execution: supervisionIsPlainObject(raw.execution) ? { mode: raw.execution.mode ?? null } : null,
      activeExecution: raw.activeExecution === true,
      isolation: typeof raw.isolation === 'string' ? raw.isolation : null,
    })
    if (tasks.length >= MAX_SUPERVISION_TASKS) break
  }
  const total = available
    ? (Number.isFinite(Number(source?.count)) ? Number(source.count) : rawTasks.length)
    : 0
  return {
    available,
    reason: available
      ? (typeof source?.reason === 'string' ? source.reason : null)
      : (typeof source?.reason === 'string' && source.reason !== '' ? source.reason : 'taskboard_unavailable'),
    source: source?.source === 'live' || source?.source === 'simulated' ? source.source : (available ? 'live' : 'absent'),
    count: total,
    truncated: total > tasks.length,
    tasks,
    // The adapter's resolved edges (with its own cross-project verdict). Kept as
    // `null` when the source does not supply them so the builder re-derives the
    // edges from the tasks instead of silently reporting none.
    dependencies: available && Array.isArray(source?.dependencies)
      ? source.dependencies
        .filter(edge => supervisionIsPlainObject(edge) && typeof edge.taskId === 'string' && typeof edge.dependsOnTaskId === 'string')
        .slice(0, MAX_SUPERVISION_DEPENDENCIES)
      : null,
    capabilities: supervisionNormalizeTaskboardCapabilities(source?.capabilities),
    notes: typeof source?.notes === 'string' ? source.notes : null,
  }
}

function supervisionNormalizeTaskboardCapabilities(input) {
  const source = supervisionIsPlainObject(input) ? input : {}
  return {
    read: source.read === true,
    proposeReassignment: source.proposeReassignment === true,
    proposePriority: source.proposePriority === true,
    proposeBlocked: source.proposeBlocked === true,
    writeKanban: source.writeKanban === true,
    requestReview: source.requestReview === true,
  }
}

function supervisionAgentIndex(supervision) {
  const index = new Map()
  for (const project of Array.isArray(supervision?.projects) ? supervision.projects : []) {
    for (const agent of Array.isArray(project?.agents) ? project.agents : []) {
      if (supervisionIsPlainObject(agent) && typeof agent.id === 'string') index.set(agent.id, agent)
    }
  }
  return index
}

function supervisionProjectIndex(supervision) {
  const index = new Map()
  for (const project of Array.isArray(supervision?.projects) ? supervision.projects : []) {
    if (supervisionIsPlainObject(project) && typeof project.id === 'string') index.set(project.id, project)
  }
  return index
}

function supervisionTaskIndex(supervision) {
  const index = new Map()
  const tasks = Array.isArray(supervision?.taskboard?.tasks) ? supervision.taskboard.tasks : []
  for (const task of tasks) {
    if (supervisionIsPlainObject(task) && typeof task.id === 'string') index.set(task.id, task)
  }
  return index
}


// ---- src/board/view.js ----
/**
 * Board view model (pure): which agents the board shows, in which order, and
 * how trees are cut. Input is the projection from supervisor/projection.js;
 * output is a deterministic, memo-friendly structure for the React layer.
 *
 * Display policy (default "attention" view):
 *   - agents really running, plus every ancestor needed to reach them;
 *   - agents waiting for a user action (never hidden because they are old);
 *   - finished-and-not-consulted results; unseen failures;
 *   - everything else (idle, read, archived) is history: hidden by default,
 *     reachable through the "recent" filter, the search, or the History drawer.
 * Age is used only to scope the optional "recent" filter, never to set a status.
 *
 * @module dsh-agent-board/board/view
 */


const VIEW_FILTERS = Object.freeze(['attention', 'recent', 'all'])
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_CHILD_LIMIT = 4
const DEFAULT_TREE_LIMIT = 8

/** Does this node by itself demand to be on the home view? */
function isAttention(node) {
  if (node === undefined || node === null) return false
  // An archived session is history whatever its status: the operator archived
  // it, so it is neither attention nor a fresh result (still reachable through
  // "all", the search and the history drawer).
  if (node.archived === true) return false
  if (node.status === STATUS.WAITING_USER) return true
  if (node.status === STATUS.RUNNING) return true
  if (node.status === STATUS.RECOVERING) return true
  // A stopped/superseded launch is unfinished work: hidden only once the user
  // has read it (the status stays `interrupted`, the attention flag clears).
  if (node.status === STATUS.INTERRUPTED) return node.seen !== true
  // The model's provider is inside an injected cooldown: the card is blocked
  // on something outside its own turn and needs a decision.
  if (node.status === STATUS.PROVIDER_UNAVAILABLE) return true
  if (node.status === STATUS.FINISHED_UNREAD) return true
  if (node.status === STATUS.FAILED && node.seen !== true) return true
  return false
}

/** Attention tier used for sorting: lower first. */
function attentionRank(node) {
  switch (node?.status) {
    case STATUS.WAITING_USER: return 0
    case STATUS.RUNNING: return 1
    case STATUS.FINISHED_UNREAD: return 2
    case STATUS.INTERRUPTED: return 2.2
    case STATUS.RECOVERING: return 2.5
    case STATUS.PROVIDER_UNAVAILABLE: return 2.7
    case STATUS.FAILED: return node.seen === true ? 5 : 3
    default: return 4 + (STATUS_RANK[node?.status] ?? 9) / 10
  }
}

/** Stable comparator: attention tier, then most recent activity, then title, then id. */
function sortAttention(a, b) {
  const tier = attentionRank(a) - attentionRank(b)
  if (tier !== 0) return tier
  const at = (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
  if (at !== 0) return at
  const title = String(a.title).localeCompare(String(b.title))
  return title !== 0 ? title : String(a.id).localeCompare(String(b.id))
}

/**
 * Subtree aggregate for every node: does the subtree contain attention, the
 * best tier inside it, and its descendant count. Iterative post-order, cycle-safe.
 */
function aggregateSubtrees(projection) {
  const agg = new Map()
  const visit = (node, guard) => {
    if (agg.has(node.id)) return agg.get(node.id)
    if (guard.has(node.id)) return { attention: false, bestTier: 9, descendants: 0, running: false, waiting: 0, unread: 0 }
    guard.add(node.id)
    let attention = isAttention(node)
    let bestTier = attentionRank(node)
    let descendants = 0
    let running = node.status === STATUS.RUNNING
    let waiting = node.status === STATUS.WAITING_USER ? 1 : 0
    let unread = node.status === STATUS.FINISHED_UNREAD ? 1 : 0
    let latest = Number(node.updatedAt) || 0
    for (const childId of node.children) {
      const child = projection.byId.get(childId)
      if (child === undefined) continue
      const sub = visit(child, guard)
      attention = attention || sub.attention
      bestTier = Math.min(bestTier, sub.bestTier)
      descendants += 1 + sub.descendants
      running = running || sub.running
      waiting += sub.waiting
      unread += sub.unread
      latest = Math.max(latest, sub.latest)
    }
    const value = { attention, bestTier, descendants, running, waiting, unread, latest }
    agg.set(node.id, value)
    return value
  }
  for (const node of projection.nodes) visit(node, new Set())
  return agg
}

function matchesQuery(node, query) {
  if (query === '') return true
  const haystack = [node.title, node.role, node.projectTitle, node.id, node.taskId, node.model?.model, node.model?.provider, node.goal]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return query.split(/\s+/).filter(Boolean).every(term => haystack.includes(term))
}

/** Is this node itself included by the active filter? */
function includedByFilter(node, filter, now, query = '') {
  if (query !== '') return matchesQuery(node, query)
  if (filter === 'all') return node.blank !== true
  if (isAttention(node)) return true
  if (filter === 'recent') {
    if (node.archived === true || node.blank === true) return false
    return Number.isFinite(Number(node.updatedAt)) && now - Number(node.updatedAt) <= RECENT_WINDOW_MS
  }
  return false
}

/**
 * Build the visible forest.
 *
 * @param {object} projection buildProjection() output
 * @param {object} options
 * @param {'attention'|'recent'|'all'} options.filter
 * @param {string} options.query       free-text search (overrides filter)
 * @param {string|null} options.project only this project id, or null for all
 * @param {Set<string>} options.expanded node ids whose hidden children are revealed
 * @param {Set<string>} options.collapsed node ids whose branch is folded
 * @param {number} options.now
 * @param {number} [options.childLimit]
 * @returns {{ projects: Array, counts: object, visibleCount: number }}
 */
function buildBoardView(projection, options = {}) {
  const filter = VIEW_FILTERS.includes(options.filter) ? options.filter : 'attention'
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const now = Number(options.now) || Date.now()
  const expanded = options.expanded ?? new Set()
  const collapsed = options.collapsed ?? new Set()
  const dismissed = options.dismissed ?? new Set()
  const childLimit = Number(options.childLimit) || DEFAULT_CHILD_LIMIT
  const agg = options.aggregates ?? aggregateSubtrees(projection)

  // A node is kept when it, or anything under it, is included (ancestors of an
  // included node are therefore always kept).
  const keepMemo = new Map()
  const keeps = node => {
    if (keepMemo.has(node.id)) return keepMemo.get(node.id)
    keepMemo.set(node.id, false) // cycle guard
    // Dismissed nodes leave the attention/recent views (still searchable, still in "all").
    let keep = dismissed.has(node.id) && query === '' && filter !== 'all' ? false : includedByFilter(node, filter, now, query)
    for (const childId of node.children) {
      const child = projection.byId.get(childId)
      if (child !== undefined && keeps(child)) keep = true
    }
    keepMemo.set(node.id, keep)
    return keep
  }

  let visibleCount = 0
  const shape = (node, depth, guard) => {
    guard.add(node.id)
    visibleCount += 1
    const allChildren = node.children
      .map(id => projection.byId.get(id))
      .filter(child => child !== undefined && !guard.has(child.id))
      .sort(sortAttention)
    const isExpanded = expanded.has(node.id)
    const isCollapsed = collapsed.has(node.id)
    const wanted = isExpanded ? allChildren : allChildren.filter(keeps)
    let shown = isCollapsed ? [] : wanted
    let overflow = 0
    if (!isExpanded && !isCollapsed && shown.length > childLimit) {
      // Attention children are never cut; the limit only trims calm ones.
      const urgent = shown.filter(child => agg.get(child.id)?.attention)
      const calm = shown.filter(child => !agg.get(child.id)?.attention)
      const room = Math.max(0, childLimit - urgent.length)
      shown = [...urgent, ...calm.slice(0, room)].sort(sortAttention)
      overflow = wanted.length - shown.length
    }
    const hiddenChildren = allChildren.length - shown.length
    return {
      node,
      depth,
      aggregate: agg.get(node.id),
      groupActive: agg.get(node.id)?.running === true && node.status !== STATUS.RUNNING,
      totalChildren: allChildren.length,
      hiddenChildren,
      overflow,
      collapsed: isCollapsed,
      expanded: isExpanded,
      children: shown.map(child => shape(child, depth + 1, guard)),
    }
  }

  const groups = new Map()
  for (const root of projection.roots) {
    if (options.project && root.projectId !== options.project) continue
    if (!keeps(root)) continue
    if (!groups.has(root.projectId)) groups.set(root.projectId, { id: root.projectId, title: root.projectTitle, roots: [] })
    groups.get(root.projectId).roots.push(root)
  }

  const projects = []
  for (const group of groups.values()) {
    const roots = group.roots.sort((a, b) => {
      const ta = agg.get(a.id)?.bestTier ?? 9
      const tb = agg.get(b.id)?.bestTier ?? 9
      if (ta !== tb) return ta - tb
      return sortAttention(a, b)
    })
    const before = visibleCount
    const trees = roots.map(root => shape(root, 0, new Set()))
    const summary = { running: 0, waiting: 0, unread: 0 }
    for (const root of roots) {
      const sub = agg.get(root.id)
      if (sub?.running) summary.running += 1
      summary.waiting += sub?.waiting ?? 0
      summary.unread += sub?.unread ?? 0
    }
    projects.push({
      id: group.id,
      title: group.title,
      unassigned: group.id === 'unassigned',
      trees,
      visibleAgents: visibleCount - before,
      bestTier: Math.min(...roots.map(root => agg.get(root.id)?.bestTier ?? 9)),
      summary,
    })
  }
  projects.sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1
    if (a.bestTier !== b.bestTier) return a.bestTier - b.bestTier
    return String(a.title).localeCompare(String(b.title))
  })

  return { projects, visibleCount, filter, query }
}

/** Global counters, independent from what is displayed. */
function boardCounts(projection) {
  const counts = { total: 0, running: 0, waiting: 0, unread: 0, failed: 0, interrupted: 0, provider_unavailable: 0, history: 0, roots: projection.roots.length }
  for (const node of projection.nodes) {
    counts.total += 1
    if (node.status === STATUS.RUNNING) counts.running += 1
    else if (node.status === STATUS.WAITING_USER) counts.waiting += 1
    else if (node.status === STATUS.FINISHED_UNREAD) counts.unread += 1
    else if (node.status === STATUS.INTERRUPTED) counts.interrupted += 1
    else if (node.status === STATUS.PROVIDER_UNAVAILABLE) counts.provider_unavailable += 1
    else if (node.status === STATUS.FAILED && node.seen !== true) counts.failed += 1
    else counts.history += 1
  }
  return counts
}

/** Projects available for the project filter (all, not only visible ones). */
function projectOptions(projection) {
  const map = new Map()
  for (const root of projection.roots) {
    const entry = map.get(root.projectId) ?? { id: root.projectId, title: root.projectTitle, agents: 0 }
    map.set(root.projectId, entry)
  }
  for (const node of projection.nodes) {
    const entry = map.get(node.projectId)
    if (entry !== undefined) entry.agents += 1
  }
  return [...map.values()].sort((a, b) => {
    if ((a.id === 'unassigned') !== (b.id === 'unassigned')) return a.id === 'unassigned' ? 1 : -1
    return a.title.localeCompare(b.title)
  })
}

/**
 * History list: every non-attention agent, most recent first, searched and
 * paginated. Only top-level sessions are listed by default; sub-agents appear
 * under their parent's entry count (and through the search).
 */
function historyPage(projection, { query = '', project = null, offset = 0, limit = 30, includeSubagents = false } = {}) {
  const q = String(query).trim().toLowerCase()
  const items = projection.nodes.filter(node => {
    if (node.blank === true) return false
    if (isAttention(node)) return false
    if (project && node.projectId !== project) return false
    if (!includeSubagents && q === '' && node.parentId !== null && !node.orphan && !node.parentCycle) return false
    return matchesQuery(node, q)
  })
  items.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(a.id).localeCompare(String(b.id)))
  const start = Math.max(0, Number(offset) || 0)
  return { total: items.length, offset: start, items: items.slice(start, start + limit), hasMore: start + limit < items.length }
}

/** Ancestor ids of a node, root first (cycle-safe). */
function ancestorChain(projection, id) {
  const chain = []
  const guard = new Set([id])
  let current = projection.byId.get(id)
  while (current?.parentId && !current.orphan && !current.parentCycle && !guard.has(current.parentId)) {
    guard.add(current.parentId)
    const parent = projection.byId.get(current.parentId)
    if (parent === undefined) break
    chain.unshift(parent.id)
    current = parent
  }
  return chain
}


// ---- src/board/hierarchy.js ----
/**
 * Supervision hierarchy view (pure): workspace -> project -> orchestrator ->
 * teams of agents, built ON TOP of the existing board view.
 *
 * It never re-implements visibility, sorting or the attention policy: the
 * `view` argument is `buildBoardView()` output and is consumed as-is. This
 * module only adds what the board view does not know:
 *
 *   - the workspace (host supervision layer) level;
 *   - the declared-role projection of every node (generic identity when the
 *     declared role resolves to nothing: never a guessed mascot);
 *   - the project orchestrator, only when a node's DECLARED role really is
 *     `orchestrator` — otherwise `null`, an honest visible gap;
 *   - real per-project counts, supervision blocks and cross-project
 *     dependencies;
 *   - the agent filters (role / status / Task Board state) applied to the
 *     already-visible entries.
 *
 * Honesty rules:
 *   - `supervision === null` still renders: structure and counts come from the
 *     projection only, capabilities are unavailable (never faked) and the
 *     workspace status is `unknown` with an explicit reason;
 *   - no fake node is ever added (a missing orchestrator stays `null`);
 *   - a Task Board state filter is only applied when the integration reports
 *     it available; its absence is reported, never silently guessed.
 *
 * @module dsh-agent-board/board/hierarchy
 */


const WORKSPACE_ROLE_ID = 'super_orchestrator'
const PROJECT_ORCHESTRATOR_ROLE_ID = 'orchestrator'
/** Filter value matching every node whose declared role resolves to nothing. */
const GENERIC_ROLE_FILTER = 'generic'

/**
 * Singular/plural key choice for one count. `1` (and `-1`) is singular; zero and
 * every other value are plural. Pure so the UI and the tests share one rule.
 */
function pluralKeyFor(count, singularKey, pluralKey) {
  const value = Number(count)
  return Number.isFinite(value) && Math.abs(value) === 1 ? singularKey : pluralKey
}

/**
 * Count text through an injected translator, e.g.
 * `countLabelFor(1, 'projectSingular', 'projectPlural', dabT)` -> `1 projet`.
 */
function countLabelFor(count, singularKey, pluralKey, translate) {
  const value = Number(count) || 0
  const t = typeof translate === 'function' ? translate : key => key
  return `${value} ${t(pluralKeyFor(value, singularKey, pluralKey))}`
}

/**
 * Project-head count label: the REAL agent count, plus the displayed count when
 * the view shows fewer (attention policy or filters). Both numbers are real, so
 * the Projects view and the hierarchy never seem to disagree.
 */
function projectCountLabel(counts, shownAgents, translate) {
  const total = Number(counts?.agents) || 0
  const shown = Number(shownAgents) || 0
  const t = typeof translate === 'function' ? translate : key => key
  const label = countLabelFor(total, 'agentSingular', 'agentPlural', t)
  if (shown === total) return label
  return `${label} · ${countLabelFor(shown, 'shownSingular', 'shownPlural', t)}`
}

const TASK_STATE_KEYS = Object.freeze(Object.keys(AGENT_TASK_STATE_TONE))
const STATUS_KEYS = Object.freeze(Object.keys(AGENT_STATUS_TONE))

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize the agent filters. Unknown values are dropped (a stale persisted
 * preference can never select an invisible pseudo-status).
 *
 * @param {object|null} filters
 * @returns {{role: string|null, status: string|null, taskState: string|null}}
 */
function normalizeHierarchyFilters(filters) {
  const value = isPlainObject(filters) ? filters : {}
  // A persisted role id is accepted only when it is an approved role or the
  // explicit "generic identity" filter: a stale/removed id must never silently
  // hide every agent while the toolbar shows "all roles".
  const role = typeof value.role === 'string' && value.role !== '' && value.role !== 'all'
    ? (value.role === GENERIC_ROLE_FILTER || AGENT_ROLE_IDS.includes(value.role) ? value.role : null)
    : null
  const status = typeof value.status === 'string' && STATUS_KEYS.includes(value.status) ? value.status : null
  const taskState = typeof value.taskState === 'string' && TASK_STATE_KEYS.includes(value.taskState) ? value.taskState : null
  return { role, status, taskState }
}

/** Task Board states indexed by task id; null when the integration is absent. */
function taskStateIndex(supervision) {
  const taskboard = supervision?.taskboard
  if (!isPlainObject(taskboard) || taskboard.available !== true || !Array.isArray(taskboard.tasks)) return null
  const index = new Map()
  for (const task of taskboard.tasks) {
    if (!isPlainObject(task) || typeof task.id !== 'string') continue
    if (typeof task.status === 'string') index.set(task.id, task.status)
  }
  return index
}

/**
 * Resolve the declared role of every node once per build. The resolver is
 * injected (default: the pure registry) so a test can stub it. Nodes sharing a
 * declared role string share one resolution: O(distinct declared roles).
 */
function resolveNodeRoles(projection, resolver = dabResolveAgentRole) {
  const resolve = typeof resolver === 'function' ? resolver : dabResolveAgentRole
  const cache = new Map()
  const out = new Map()
  for (const node of projection.nodes) {
    const declared = typeof node.role === 'string' && node.role !== '' ? node.role : null
    const key = declared ?? ''
    let resolved = cache.get(key)
    if (resolved === undefined) {
      resolved = declared === null ? { roleId: null, source: 'generic', raw: null, role: null } : resolve(declared)
      if (!isPlainObject(resolved)) resolved = { roleId: null, source: 'generic', raw: declared, role: null }
      cache.set(key, resolved)
    }
    out.set(node.id, {
      roleId: typeof resolved.roleId === 'string' && resolved.roleId !== '' ? resolved.roleId : null,
      roleLabel: typeof resolved.role?.label === 'string' ? resolved.role.label : null,
      family: typeof resolved.role?.family === 'string' ? resolved.role.family : null,
      source: resolved.source === 'explicit' || resolved.source === 'alias' ? resolved.source : 'generic',
      raw: typeof resolved.raw === 'string' ? resolved.raw : declared,
    })
  }
  return out
}

/**
 * The project orchestrator: an agent whose DECLARED role resolves to
 * `orchestrator`. A `super_orchestrator` is the workspace layer, not a project
 * orchestrator. Deterministic choice when several are declared: a root first,
 * then the most recently updated, then the id. Never fabricated.
 */
function findProjectOrchestrator(nodes, roles) {
  let best = null
  let bestKey = null
  for (const node of nodes) {
    if (roles.get(node.id)?.roleId !== PROJECT_ORCHESTRATOR_ROLE_ID) continue
    const root = node.parentId === null || node.orphan === true || node.parentCycle === true
    const key = [root ? 0 : 1, -(Number(node.updatedAt) || 0), String(node.id)]
    if (bestKey === null || compareKeys(key, bestKey) < 0) {
      best = node
      bestKey = key
    }
  }
  if (best === null) return null
  return {
    id: best.id,
    name: best.title,
    role: best.role,
    roleId: PROJECT_ORCHESTRATOR_ROLE_ID,
    roleLabel: roles.get(best.id)?.roleLabel ?? null,
    status: best.status,
    projectId: best.projectId,
  }
}

function compareKeys(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return 0
}

/** Real per-project agent counts (every node of the project, not only visible ones). */
function countProjectNodes(nodes) {
  const counts = { agents: 0, running: 0, waiting: 0, unread: 0, failed: 0, interrupted: 0 }
  for (const node of nodes) {
    counts.agents += 1
    if (node.status === 'running') counts.running += 1
    else if (node.status === 'waiting_user') counts.waiting += 1
    else if (node.status === 'finished_unread') counts.unread += 1
    else if (node.status === 'failed') counts.failed += 1
    else if (node.status === 'interrupted') counts.interrupted += 1
  }
  return counts
}

function addCounts(target, source) {
  for (const key of ['agents', 'running', 'waiting', 'unread', 'failed', 'interrupted']) target[key] += source[key]
  return target
}

/** Does this node pass the explicit agent filters? */
function matchesHierarchyFilters(node, roles, filters, taskStates, taskStateAvailable) {
  if (filters.role !== null) {
    const roleId = roles.get(node.id)?.roleId ?? null
    if (filters.role === GENERIC_ROLE_FILTER ? roleId !== null : roleId !== filters.role) return false
  }
  if (filters.status !== null && node.status !== filters.status) return false
  if (filters.taskState !== null && taskStateAvailable) {
    const state = node.taskId === null || node.taskId === undefined ? null : taskStates?.get(String(node.taskId)) ?? null
    if (state !== filters.taskState) return false
  }
  return true
}

function flattenShaped(entry, out = []) {
  out.push(entry)
  for (const child of entry.children) flattenShaped(child, out)
  return out
}

/**
 * Build the supervision hierarchy.
 *
 * @param {object} projection buildProjection() output
 * @param {object|null} view buildBoardView() output (rebuilt with safe defaults when absent)
 * @param {object|null} supervision host supervision payload (contract C), or null
 * @param {object} [options]
 * @param {Function} [options.resolveRole] role resolver (default dabResolveAgentRole)
 * @param {object} [options.filters] agent filters (role / status / taskState)
 * @param {Map|object|null} [options.taskStates] task id -> Task Board state (default: supervision)
 * @param {Set<string>} [options.foldedProjects] project ids folded in the board
 * @param {string|null} [options.mode] host orchestration mode (used when supervision is absent)
 * @param {object} [options.viewOptions] options for buildBoardView when `view` is absent
 * @returns {object}
 */
function buildHierarchyView(projection, view, supervision, options = {}) {
  const source = projection ?? { nodes: [], byId: new Map(), roots: [], projects: [] }
  const boardView = view ?? buildBoardView(source, options.viewOptions ?? {})
  const filters = normalizeHierarchyFilters(options.filters)
  const roles = resolveNodeRoles(source, options.resolveRole)
  const taskStates = options.taskStates ?? taskStateIndex(supervision)
  const taskStateAvailable = taskStates !== null
  const folded = options.foldedProjects instanceof Set ? options.foldedProjects : new Set()
  const effectiveFilters = { ...filters, taskState: taskStateAvailable ? filters.taskState : null }

  // Real project index (every node), independent from what is displayed.
  const nodesByProject = new Map()
  for (const node of source.nodes) {
    if (!nodesByProject.has(node.projectId)) nodesByProject.set(node.projectId, [])
    nodesByProject.get(node.projectId).push(node)
  }

  const blocks = Array.isArray(supervision?.blocks) ? supervision.blocks.slice(0, 50) : []
  const dependencies = Array.isArray(supervision?.crossProjectDependencies) ? supervision.crossProjectDependencies.slice(0, 100) : []

  const projects = []
  for (const group of boardView.projects) {
    const allNodes = nodesByProject.get(group.id) ?? []
    const counts = countProjectNodes(allNodes)
    const teams = []
    for (const tree of group.trees) {
      const entries = flattenShaped(tree)
      let kept = entries
      let hidden = 0
      const filtering = effectiveFilters.role !== null || effectiveFilters.status !== null || effectiveFilters.taskState !== null
      if (filtering) {
        kept = entries.filter(entry => matchesHierarchyFilters(entry.node, roles, effectiveFilters, taskStates, taskStateAvailable))
        hidden = entries.length - kept.length
        if (kept.length === 0) continue
      }
      teams.push({
        root: tree.node,
        agents: kept.map(entry => entry.node),
        // Renderer input: the shaped entries (depth, hidden children, group
        // state) so the hierarchy can reuse the existing card component.
        entries: kept,
        hidden,
      })
    }
    const orchestrator = findProjectOrchestrator(allNodes, roles)
    projects.push({
      id: group.id,
      title: group.title,
      unassigned: group.id === 'unassigned',
      folded: folded.has(group.id),
      orchestrator,
      teams,
      counts,
      blocks: blocks.filter(block => block.projectId === group.id),
      crossProjectDependencies: dependencies.filter(dependency => (
        dependency.fromProjectId === group.id || dependency.toProjectId === group.id
      )),
      visibleAgents: group.visibleAgents,
    })
  }

  // Real totals: every project of the projection, even when the project filter
  // narrows what is displayed.
  const totals = { agents: 0, running: 0, waiting: 0, unread: 0, failed: 0, interrupted: 0 }
  for (const nodes of nodesByProject.values()) addCounts(totals, countProjectNodes(nodes))
  const realProjectCount = Array.isArray(source.projects)
    ? source.projects.length
    : nodesByProject.size

  const workspaceSupervision = isPlainObject(supervision?.workspace) ? supervision.workspace : null
  const available = isPlainObject(supervision)
  const mode = typeof workspaceSupervision?.mode === 'string'
    ? workspaceSupervision.mode
    : (typeof options.mode === 'string' ? options.mode : null)
  const workspaceStatus = workspaceSupervision?.status === 'active' || workspaceSupervision?.status === 'idle' || workspaceSupervision?.status === 'blocked'
    ? workspaceSupervision.status
    : 'unknown'

  const workspace = {
    id: typeof workspaceSupervision?.id === 'string' ? workspaceSupervision.id : 'workspace:supervision',
    synthetic: true,
    role: WORKSPACE_ROLE_ID,
    emblem: workspaceSupervision?.emblem === 'bolt' ? 'bolt' : 'crown',
    mode,
    status: workspaceStatus,
    statusReason: typeof workspaceSupervision?.reason === 'string'
      ? workspaceSupervision.reason
      : (available ? null : 'supervision_unavailable'),
    // A real agent may be exposed as the workspace agent by the host; a null
    // value means "no declared super-orchestrator agent", never a fake one.
    agent: isPlainObject(workspaceSupervision?.agent) ? workspaceSupervision.agent : null,
    counts: { ...totals, projects: realProjectCount, blocked: blocks.length, dependencies: dependencies.length },
    blocks,
    crossProjectDependencies: dependencies,
    recommendations: Array.isArray(supervision?.recommendations) ? supervision.recommendations.slice(0, 50) : [],
    capabilities: isPlainObject(supervision?.capabilities) ? supervision.capabilities : null,
    // The host's own capability reasons (additive, optional): preferred over a
    // generic translation because they name the REAL missing path.
    capabilityReasons: isPlainObject(supervision?.capabilityReasons) ? supervision.capabilityReasons : null,
    delegation: isPlainObject(workspaceSupervision?.delegation) ? workspaceSupervision.delegation : null,
    taskboard: isPlainObject(supervision?.taskboard) ? supervision.taskboard : null,
    available,
  }

  return {
    workspace,
    projects,
    projectsById: new Map(projects.map(project => [project.id, project])),
    // Per-node resolved role (declared role -> approved role, or generic).
    // Additive to the contract shape so the renderer does not re-resolve it.
    roles,
    totals: {
      ...totals,
      projects: realProjectCount,
      shownProjects: projects.length,
      visibleAgents: projects.reduce((sum, project) => sum + project.teams.reduce((inner, team) => inner + team.agents.length, 0), 0),
      blocked: blocks.length,
      dependencies: dependencies.length,
      supervisionAvailable: available,
      taskStateAvailable,
    },
    filters: {
      view: boardView.filter,
      query: boardView.query,
      role: filters.role,
      status: filters.status,
      taskState: effectiveFilters.taskState,
      taskStateAvailable,
    },
  }
}

/**
 * Narrow the already-shaped board view to entries matching the agent filters.
 * Used by the existing "Projects" view so one toolbar filter is coherent in both
 * views. It only REMOVES entries the user explicitly filtered out: visibility,
 * attention and ordering were already decided by buildBoardView.
 *
 * @param {object} view buildBoardView() output
 * @param {object} filters role/status/taskState filters
 * @param {object} [options] same role/task-state inputs as buildHierarchyView
 * @returns {object} a pruned view (the same object when no filter is active)
 */
function filterBoardViewByAgent(view, filters, options = {}) {
  const normalized = normalizeHierarchyFilters(filters)
  const taskStates = options.taskStates ?? taskStateIndex(options.supervision ?? null)
  const taskStateAvailable = taskStates !== null
  const effective = { ...normalized, taskState: taskStateAvailable ? normalized.taskState : null }
  if (effective.role === null && effective.status === null && effective.taskState === null) return view
  const roles = options.roles ?? resolveNodeRoles(options.projection ?? { nodes: [] }, options.resolveRole)

  const matches = entry => matchesHierarchyFilters(entry.node, roles, effective, taskStates, taskStateAvailable)
  const prune = entry => {
    const children = entry.children.map(prune).filter(child => child !== null)
    if (!matches(entry) && children.length === 0) return null
    return {
      ...entry,
      children,
      // Direct children hidden from BOTH the original cut and the filter.
      hiddenChildren: Math.max(0, entry.totalChildren - children.length),
      overflow: 0,
    }
  }

  let visibleCount = 0
  const projects = []
  for (const project of view.projects) {
    const trees = project.trees.map(prune).filter(tree => tree !== null)
    if (trees.length === 0) continue
    let projectVisible = 0
    for (const tree of trees) {
      const count = flattenShaped(tree).length
      projectVisible += count
      visibleCount += count
    }
    projects.push({ ...project, trees, visibleAgents: projectVisible })
  }
  return { ...view, projects, visibleCount }
}


// ---- src/board/interaction.js ----
/**
 * Pointer/keyboard arbitration for agent cards (pure, timer-injected).
 *
 *   single click  -> after `delay` ms without a second click: onSelect(id)
 *   double click  -> cancels the pending single action, onOpen(id) exactly once
 *   Enter         -> onOpen(id)        Space -> onSelect(id)
 *
 * A second `open` for the same id inside `openGuardMs` is dropped, so a
 * dblclick event racing a keyboard Enter or a duplicated dblclick never opens
 * the session twice.
 *
 * @module dsh-agent-board/board/interaction
 */

const CLICK_DELAY_MS = 250
const OPEN_GUARD_MS = 800

function createClickArbiter({
  onSelect,
  onOpen,
  delay = CLICK_DELAY_MS,
  openGuardMs = OPEN_GUARD_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
  now = () => Date.now(),
} = {}) {
  let pending = null
  let lastOpen = { id: null, at: -Infinity }

  const cancel = () => {
    if (pending !== null) {
      clearTimer(pending.handle)
      pending = null
    }
  }

  const open = id => {
    cancel()
    const at = now()
    if (lastOpen.id === id && at - lastOpen.at < openGuardMs) return false
    lastOpen = { id, at }
    onOpen?.(id)
    return true
  }

  return {
    click(id, detail = 1) {
      // detail >= 2 is the second click of a double click: wait for dblclick.
      if (detail >= 2) { cancel(); return }
      cancel()
      const handle = setTimer(() => {
        pending = null
        onSelect?.(id)
      }, delay)
      pending = { id, handle }
    },
    doubleClick(id) {
      return open(id)
    },
    key(id, key) {
      if (key === 'Enter') { open(id); return true }
      if (key === ' ' || key === 'Spacebar') { cancel(); onSelect?.(id); return true }
      return false
    },
    open,
    cancel,
    get pendingId() { return pending?.id ?? null },
  }
}


// ---- src/client/core.js ----
/**
 * Client-side board store (no React, no DOM).
 *
 * It merges three live sources:
 *   - the native `sessions` list snapshot (session rows + sub-agent catalog),
 *   - the native `uiSession.sessionStatus` map (running / pendingInteraction /
 *     completionUnread) when the runtime provides it,
 *   - the host board state (previews, turn-end facts, read cursors,
 *     assignments, orchestration mode) fetched once and then streamed over SSE.
 *
 * It never polls a status endpoint: native state arrives through subscriptions,
 * host state arrives through `EventSource`, and the projection is rebuilt only
 * when one of them changes.
 *
 * @module dsh-agent-board/client/core
 */


function emptyHostState() {
  return {
    mode: 'off',
    stoppedAt: null,
    policy: {},
    acks: {},
    previews: {},
    turnEnd: {},
    proposals: [],
    assignments: [],
    routeEvents: [],
    health: {},
    gone: {},
    lastTick: null,
    sync: null,
    adapters: { adapters: [], executors: [] },
    audit: [],
    reconcileNotes: [],
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const HOST_STATE_OBJECT_KEYS = ['acks', 'previews', 'turnEnd', 'health', 'gone', 'policy', 'instance', 'sync', 'adapters']
const HOST_STATE_ARRAY_KEYS = ['assignments', 'proposals', 'routeEvents', 'audit', 'reconcileNotes']

/**
 * Is this object a host state frame? The event stream is shared, so a valid
 * JSON object that is not the board contract must never replace the state the
 * projection reads. A frame is accepted only when it carries a known top-level
 * field AND every present known field has its expected container type (arrays
 * stay arrays, tables stay plain objects; null is tolerated for optional
 * objects so a partially populated state is still accepted).
 */
function looksLikeHostState(value) {
  if (!isPlainObject(value)) return false
  const known = typeof value.mode === 'string'
    || HOST_STATE_ARRAY_KEYS.some(key => Array.isArray(value[key]))
    || HOST_STATE_OBJECT_KEYS.some(key => isPlainObject(value[key]))
  if (!known) return false
  for (const key of HOST_STATE_ARRAY_KEYS) {
    if (value[key] !== undefined && !Array.isArray(value[key])) return false
  }
  for (const key of HOST_STATE_OBJECT_KEYS) {
    if (value[key] !== undefined && value[key] !== null && !isPlainObject(value[key])) return false
  }
  return true
}

/** Every session id the projection can create a node for (rows + catalogs). */
function knownSessionIds(list) {
  const ids = new Set()
  const byId = list?.byId !== null && typeof list?.byId === 'object' ? list.byId : {}
  for (const id of Array.isArray(list?.ids) ? list.ids : Object.keys(byId)) ids.add(String(id))
  const projections = list?.projectionsBySession
  if (projections !== null && typeof projections === 'object') {
    for (const projection of Object.values(projections)) {
      const catalog = projection?.values?.subagentCatalog
      if (!Array.isArray(catalog)) continue
      for (const entry of catalog) {
        const id = typeof entry?.sessionId === 'string' ? entry.sessionId : (typeof entry?.id === 'string' ? entry.id : null)
        if (id !== null) ids.add(id)
      }
    }
  }
  return ids
}

/**
 * @param {object} ctx cordis client context (needs .get(name))
 * @param {object} [options]
 */
function createBoardStore(ctx, options = {}) {
  const apiBase = options.apiBase ?? '/dsh-agent-board/api/v2'
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  const EventSourceImpl = options.EventSourceImpl ?? globalThis.EventSource

  let host = emptyHostState()
  let hostError = null
  let cache = null
  let dirty = true
  let bound = false
  let stream = null
  let destroyed = false
  const listeners = new Set()
  const unsubscribers = []

  const service = name => {
    try {
      return ctx?.get?.(name)
    } catch {
      return undefined
    }
  }

  // Model identity is per SESSION id, never per model: a native `model/selection`
  // change updates the chip and appends one entry to that card's visible route
  // history. The memory lives here (not in the pure projection) and is bounded.
  const modelMemory = new Map()
  const modelResolver = typeof options.modelOf === 'function' ? options.modelOf : undefined

  // Native sources can notify many times per second while agents stream.
  // Notifications are coalesced: at most one projection rebuild per window.
  const notifyWindowMs = Number.isFinite(options.notifyWindowMs) ? options.notifyWindowMs : 200
  let notifyTimer = null
  let stats = { notifications: 0, rebuilds: 0 }

  function flush() {
    notifyTimer = null
    for (const listener of listeners) {
      try { listener() } catch { /* listener errors must not break the store */ }
    }
  }

  function bump() {
    dirty = true
    stats.notifications += 1
    if (notifyWindowMs <= 0) { flush(); return }
    if (notifyTimer !== null) return
    notifyTimer = setTimeout(flush, notifyWindowMs)
  }

  function bind() {
    if (bound || destroyed) return
    let any = false
    const sessions = service('sessions')
    if (typeof sessions?.list?.subscribe === 'function') {
      unsubscribers.push(sessions.list.subscribe(bump))
      any = true
    }
    const uiSession = service('uiSession')
    if (typeof uiSession?.sessionStatus?.subscribe === 'function') {
      unsubscribers.push(uiSession.sessionStatus.subscribe(bump))
      any = true
    }
    bound = any
  }

  function compute() {
    const sessions = service('sessions')
    const list = (() => {
      try { return sessions?.list?.getSnapshot?.() ?? {} } catch { return {} }
    })()
    const statusMap = (() => {
      try { return service('uiSession')?.sessionStatus?.getSnapshot?.() ?? new Map() } catch { return new Map() }
    })()
    const workspaces = (() => {
      try { return service('workspaces')?.list?.getSnapshot?.() ?? {} } catch { return {} }
    })()
    const now = Date.now()
    // Resolve every known model first, so a change is recorded AND rendered in
    // the same snapshot (no "chip now, history next tick" gap).
    const projectionsBySession = list?.projectionsBySession
    const assignmentBySession = new Map()
    for (const assignment of Array.isArray(host?.assignments) ? host.assignments : []) {
      if (typeof assignment?.sessionId === 'string') assignmentBySession.set(assignment.sessionId, assignment)
    }
    for (const id of knownSessionIds(list)) {
      const row = list?.byId?.[id]
      const model = resolveNodeModel({
        sessionId: id, row, assignment: assignmentBySession.get(id) ?? null, modelOf: modelResolver, projectionsBySession,
      })
      trackModelChange(modelMemory, id, model, now)
    }
    const projection = buildProjection({
      list,
      statusMap,
      hostState: host,
      workspaces,
      now,
      modelOf: modelResolver,
      modelHistory: modelHistoryOf(modelMemory),
    })
    stats.rebuilds += 1
    return {
      projection,
      aggregates: aggregateSubtrees(projection),
      host,
      hostError,
      phase: typeof list?.phase === 'string' ? list.phase : 'ready',
      bound,
    }
  }

  function getSnapshot() {
    bind()
    if (!dirty && cache !== null) return cache
    cache = compute()
    dirty = false
    return cache
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function refreshHost() {
    if (fetchImpl === null) return { ok: false, error: 'no_fetch' }
    try {
      const response = await fetchImpl(`${apiBase}/state`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      if (body?.ok !== true || !looksLikeHostState(body.value)) throw new Error('invalid host state')
      host = body.value
      hostError = null
      bump()
      return { ok: true }
    } catch (error) {
      hostError = String(error?.message ?? error)
      bump()
      return { ok: false, error: hostError }
    }
  }

  // One parser for every SSE frame shape: the host emits named `state` frames,
  // other implementations may emit unnamed `message` frames. Both paths must
  // apply exactly the same validation so a malformed frame never breaks the store.
  function applyStreamFrame(event) {
    try {
      const parsed = JSON.parse(event?.data)
      // Any valid JSON object is NOT a host state: an unrelated object (or a
      // partially shaped one) would replace the board state and make the
      // projection iterate garbage. Only a frame that looks like the host state
      // contract is applied; the previous state is kept otherwise.
      if (looksLikeHostState(parsed)) {
        host = parsed
        hostError = null
        bump()
      }
    } catch { /* keep the previous state */ }
  }

  function connectStream() {
    if (stream !== null || destroyed) return
    if (typeof EventSourceImpl !== 'function') return
    try {
      const source = new EventSourceImpl(`${apiBase}/events`)
      stream = source
      // The host broadcasts `event: state`; `onmessage` only receives unnamed
      // `message` frames, so the named event needs its own listener. Test
      // doubles and minimal EventSource implementations may not implement
      // addEventListener: fall back to onmessage only in that case.
      if (typeof source.addEventListener === 'function') source.addEventListener('state', applyStreamFrame)
      // Protocol compatibility: hosts that emit unnamed frames still reach us.
      source.onmessage = applyStreamFrame
      source.onerror = () => { /* the browser reconnects automatically */ }
    } catch {
      stream = null
    }
  }

  async function post(path, body) {
    if (fetchImpl === null) return { ok: false, error: 'no_fetch' }
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => null)
      if (payload?.ok === true) await refreshHost()
      return { ok: payload?.ok === true, status: response.status, payload }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const api = {
    getSnapshot,
    subscribe,
    refreshHost,
    connectStream,
    getHost: () => host,
    ack: (sessionId, options = {}) => post('/ack', { sessionId, ...(typeof options.source === 'string' ? { source: options.source } : {}) }),
    unack: sessionId => post('/ack', { sessionId, seen: false }),
    resume: () => post('/resume', {}),
    setMode: mode => post('/mode', { mode }),
    stop: () => post('/stop', {}),
    tick: () => post('/tick', {}),
    decide: (proposalId, approve) => post(`/proposals/${encodeURIComponent(proposalId)}/decide`, { approve }),
    dispatch: taskId => post('/dispatch', { taskId }),
    getStats: () => ({ ...stats }),
    destroy() {
      destroyed = true
      if (notifyTimer !== null) { clearTimeout(notifyTimer); notifyTimer = null }
      for (const unsubscribe of unsubscribers.splice(0)) {
        try { unsubscribe() } catch { /* ignore */ }
      }
      if (stream !== null) {
        try { stream.close() } catch { /* ignore */ }
        stream = null
      }
      listeners.clear()
    },
  }

  return {
    ...api,
    start() {
      bind()
      void refreshHost()
      connectStream()
    },
  }
}



// ---- src/client/ui/strings.js ----
/**
 * Panel strings (fr/en) and locale resolution. Concatenated into the browser
 * artifact by scripts/build-client.mjs: every name here is global to the bundle.
 *
 * @module dsh-agent-board/client/ui/strings
 */

const DAB_STRINGS = {
  fr: {
    title: 'Agent Board',
    mode: 'Orchestrateur',
    off: 'Arrêt',
    supervised: 'Supervisé',
    autonomous: 'Autonome',
    stop: 'Arrêter les exécutions',
    stopNone: 'Aucune exécution du board en cours',
    orchestratorDown: 'API orchestrateur injoignable : contrôle indisponible',
    compact: 'Cartes compactes',
    treeView: 'Arbre',
    refresh: 'Rafraîchir',
    search: 'Rechercher un agent, un projet, une tâche…',
    allProjects: 'Tous les projets',
    filterAttention: 'À traiter',
    filterRecent: 'Récents 24 h',
    filterAll: 'Tout',
    history: 'Historique',
    running: 'en cours',
    waiting: 'en attente',
    unread: 'non lus',
    failed: 'en erreur',
    shown: 'affichés',
    of: 'sur',
    statusRunning: 'En cours',
    statusWaiting: 'Attend votre action',
    statusRecovering: 'Récupération en cours',
    statusInterrupted: 'Interrompu',
    statusProviderUnavailable: 'Fournisseur indisponible',
    statusUnavailable: 'Agent indisponible',
    statusUnread: 'Terminé — non consulté',
    statusRead: 'Terminé',
    statusFailed: 'Échec',
    statusIdle: 'Inactif',
    statusUnknown: 'Inconnu / déconnecté',
    groupActive: 'sous-agents actifs',
    waitingApproval: 'Attend votre approbation',
    waitingQuestion: 'Attend votre réponse',
    waitingPlan: 'Attend votre revue du plan',
    waitingUnknown: 'Attend une intervention',
    open: 'Ouvrir',
    openSession: 'Ouvrir la session',
    openParent: 'Ouvrir le parent',
    openFailed: 'Impossible d\u2019ouvrir cette session via le routeur DSH',
    finalAnswer: 'Dernière ligne de la réponse finale',
    noFinal: 'Pas encore de réponse finale.',
    activity: 'Activité',
    previousSession: 'Session précédente',
    routeHistory: 'Changements de route',
    statusReason: 'Raison du statut',
    recovery: 'Reprise',
    resume: 'Reprendre',
    stoppedNotice: 'Arrêté par l’opérateur — aucune nouvelle délégation',
    secondaryInstance: 'Instance secondaire (lecture seule) : un autre hôte possède l’état.',
    turns: 'tours',
    steps: 'étapes',
    seeMore: 'Voir plus',
    seeLess: 'Réduire',
    close: 'Fermer',
    collapse: 'Replier la branche',
    expand: 'Déplier la branche',
    showHidden: 'afficher',
    hidden: 'masqués',
    children: 'sous-agents',
    subagent: 'sous-agent',
    parent: 'Parent',
    project: 'Projet',
    model: 'Modèle',
    task: 'Tâche',
    directory: 'Répertoire',
    session: 'Session',
    goal: 'Objectif',
    orphan: 'parent inconnu',
    cycle: 'parenté invalide (cycle)',
    contest: 'parenté contestée',
    unassigned: 'Non attribué',
    emptyAttention: 'Rien à traiter : aucun agent en cours, en attente ou fraîchement terminé.',
    emptyHint: 'L\u2019historique reste accessible via « Historique » ou la recherche.',
    emptySearch: 'Aucun agent ne correspond.',
    moreTrees: 'Afficher {n} arbre(s) de plus',
    historyTitle: 'Historique des sessions',
    historyHint: 'Sessions inactives, consultées ou archivées. Rien n\u2019est supprimé ni archivé par le board.',
    loadMore: 'Charger plus',
    archived: 'archivée',
    noModel: 'modèle inconnu',
    provider: 'Fournisseur',
    modelNative: 'natif',
    modelAssignment: 'board',
    modelSource: 'Source du modèle',
    proposals: 'Proposition en attente',
    approve: 'Approuver',
    reject: 'Refuser',
    executions: 'Exécutions du board',
    restore: 'Reprise après redémarrage',
    resumed: 'interrompue — reprise contrôlée requise',
    offNotice: 'Observation seule',
    supervisedNotice: 'Les propositions attendent votre accord',
    autonomousNotice: 'Exécute dans le mandat configuré',
    orchestratorState: 'État orchestrateur et adaptateurs',
    stateShort: 'État',
    moreControls: 'Filtres et orchestrateur',
    dismiss: 'Retirer du tableau',
    undismiss: 'Remettre dans le tableau',
    dismissHint: 'Masque cette session des vues « À traiter » et « Récents » (la session n’est pas supprimée ; visible via « Tout » ou la recherche)',
    viewLabel: 'Vue',
    viewModeLabel: 'Mode de vue',
    filterLabel: 'Filtre',
    orchestratorLabel: 'Orchestrateur',
    syncOk: 'Task Board synchronisé',
    syncError: 'Task Board injoignable',
    adapters: 'Adaptateurs',
    notLive: 'non validé live',
    keyboardHint: 'Entrée : ouvrir · Espace : aperçu · double-clic : ouvrir',
    projects: 'Projets',
    ago: 'il y a',
    // ---- supervision / hiérarchie / identités (GOAL 4)
    role: 'Rôle',
    roleAll: 'Tous les rôles',
    roleGeneric: 'Générique',
    roleFamilyLabel: 'Famille de rôle',
    roleDeclared: 'Rôle déclaré',
    roleDeclaredAlias: 'rôle déclaré (alias)',
    noDeclaredRole: 'Rôle non déclaré',
    genericIdentity: 'Identité générique',
    familyGovernance: 'Gouvernance / connaissances',
    familyCoordination: 'Coordination / supervision',
    familyExecution: 'Production / optimisation',
    familyQuality: 'Revue / audit',
    familyValidation: 'Validation / tests',
    familyProtection: 'Protection / règles',
    statusFilterLabel: 'Statut',
    statusAll: 'Tous les statuts',
    viewProjects: 'Projets',
    viewHierarchy: 'Hiérarchie',
    taskStateFilterLabel: 'État Task Board',
    taskStateAll: 'Tous les états',
    taskStateUnavailable: 'Task Board non lu',
    taskStateUnavailable: 'Task Board indisponible',
    taskStateTitle: 'État de la tâche liée (Task Board)',
    taskTodo: 'À faire',
    taskInProgress: 'En cours',
    taskInReview: 'En revue',
    taskBlocked: 'Bloquée',
    taskDone: 'Terminée',
    taskCanceled: 'Annulée',
    taskArchived: 'Archivée',
    agent: 'Agent',
    agents: 'agents',
    // Count forms (fr): the UI never prints "1 projets".
    projectSingular: 'projet',
    projectPlural: 'projets',
    agentSingular: 'agent',
    agentPlural: 'agents',
    unreadSingular: 'non lu',
    unreadPlural: 'non lus',
    interruptedSingular: 'interrompu',
    interruptedPlural: 'interrompus',
    blockedSingular: 'bloqué',
    blockedPlural: 'bloqués',
    turnSingular: 'tour',
    turnPlural: 'tours',
    stepSingular: 'étape',
    stepPlural: 'étapes',
    shownSingular: 'affiché',
    shownPlural: 'affichés',
    supervision: 'Supervision',
    supervisionLayer: 'Couche de supervision (non un agent)',
    superOrchestrator: 'Super-orchestrateur',
    supervisionExpand: 'Afficher la supervision',
    supervisionCollapse: 'Masquer la supervision',
    supervisionUnavailable: 'Supervision non publiée par l’hôte : structure et comptages réels, capacités indisponibles.',
    taskboardUnavailable: 'Task Board indisponible pour la lecture',
    supervisionWorkspace: 'Espace de travail',
    supervisionMode: 'Mode',
    supervisionBlocked: 'bloqués',
    supervisionDependencies: 'Dépendances inter-projets',
    supervisionNoDependencies: 'Aucune dépendance inter-projets connue.',
    supervisionBlocks: 'Blocages',
    supervisionNoBlocks: 'Aucun blocage connu.',
    supervisionRecommendations: 'Recommandations',
    supervisionNoRecommendations: 'Aucune recommandation.',
    recommendationNotApplied: 'proposition — non appliquée',
    recommendationDelegate: 'Délégation',
    recommendationUnblock: 'Déblocage',
    recommendationPriority: 'Priorité',
    recommendationReassign: 'Réaffectation',
    supervisionCapabilities: 'Capacités',
    supervisionCapabilityReason: 'Raison',
    supervisionStatusActive: 'Actif',
    supervisionStatusIdle: 'Inactif (observation)',
    supervisionStatusBlocked: 'Bloqué',
    supervisionStatusUnknown: 'Inconnu',
    supervisionSynthetic: 'Couche de supervision de l’hôte : aucune session ne lui correspond.',
    supervisionDelegation: 'Délégation : {inFlight} en cours · profondeur {depth} · {concurrent} simultanées · {hourly}/h',
    capObserve: 'Observer',
    capRecommend: 'Recommander',
    capDelegate: 'Déléguer',
    capReassign: 'Réaffecter',
    capPriority: 'Prioriser',
    capReceiveReports: 'Rapports d’orchestrateur',
    capKanbanWrite: 'Écriture Task Board',
    capabilityAvailable: 'Disponible',
    capabilityGated: 'Sous conditions',
    capabilityProposalOnly: 'Proposition seulement',
    capabilityUnavailable: 'Non disponible',
    capReasonSupervisionUnavailable: 'hôte : supervision non publiée',
    capReasonGated: 'soumise aux limites et à l’accord de l’opérateur',
    capReasonProposalOnly: 'aucune écriture : proposition uniquement',
    capReasonReadOnly: 'Task Board en lecture seule depuis le board',
    capReasonNoChannel: 'aucun canal de rapport d’orchestrateur dans cette version',
    capReasonDisabled: 'désactivée par la politique',
    capReasonUnknown: 'raison non fournie par l’hôte',
    hierarchy: 'Hiérarchie',
    hierarchyOrchestratorMissing: 'Aucun orchestrateur déclaré',
    hierarchyOrchestratorMissingHint: 'Aucun agent de ce projet ne déclare le rôle orchestrator : le board n’en crée jamais.',
    hierarchyAgentsCount: '{n} agents',
    hierarchyHiddenByFilter: '{n} masqués par le filtre',
    hierarchyNoAgents: 'Aucun agent visible dans ce projet.',
    hierarchyEmpty: 'Aucun agent ne correspond aux filtres.',
    hierarchyTeamOf: 'Équipe de {name}',
    activityReal: 'Activité réelle : {activity}',
    emptyFiltered: 'Aucun agent ne correspond aux filtres actifs.',
    clearFilters: 'Effacer les filtres',
    noActivity: 'Activité inconnue',
  },
  en: {
    title: 'Agent Board',
    mode: 'Orchestrator',
    off: 'Off',
    supervised: 'Supervised',
    autonomous: 'Autonomous',
    stop: 'Stop executions',
    stopNone: 'No board execution in flight',
    orchestratorDown: 'Orchestrator API unreachable: control unavailable',
    compact: 'Compact cards',
    treeView: 'Tree',
    refresh: 'Refresh',
    search: 'Search an agent, project, task…',
    allProjects: 'All projects',
    filterAttention: 'Needs attention',
    filterRecent: 'Recent 24 h',
    filterAll: 'All',
    history: 'History',
    running: 'running',
    waiting: 'waiting',
    unread: 'unread',
    failed: 'failed',
    shown: 'shown',
    of: 'of',
    statusRunning: 'Running',
    statusWaiting: 'Needs your action',
    statusRecovering: 'Recovering',
    statusInterrupted: 'Interrupted',
    statusProviderUnavailable: 'Provider unavailable',
    statusUnavailable: 'Agent unavailable',
    statusUnread: 'Finished — not viewed',
    statusRead: 'Finished',
    statusFailed: 'Failed',
    statusIdle: 'Idle',
    statusUnknown: 'Unknown / disconnected',
    groupActive: 'active sub-agents',
    waitingApproval: 'Waiting for your approval',
    waitingQuestion: 'Waiting for your answer',
    waitingPlan: 'Waiting for your plan review',
    waitingUnknown: 'Waiting for an intervention',
    open: 'Open',
    openSession: 'Open session',
    openParent: 'Open parent',
    openFailed: 'This session cannot be opened through the DSH router',
    finalAnswer: 'Last line of the final answer',
    noFinal: 'No final answer yet.',
    activity: 'Activity',
    previousSession: 'Previous session',
    routeHistory: 'Route changes',
    statusReason: 'Status reason',
    recovery: 'Recovery',
    resume: 'Resume',
    stoppedNotice: 'Stopped by the operator — no new delegation',
    secondaryInstance: 'Secondary instance (read-only): another host owns the state.',
    turns: 'turns',
    steps: 'steps',
    seeMore: 'See more',
    seeLess: 'Less',
    close: 'Close',
    collapse: 'Collapse branch',
    expand: 'Expand branch',
    showHidden: 'show',
    hidden: 'hidden',
    children: 'sub-agents',
    subagent: 'sub-agent',
    parent: 'Parent',
    project: 'Project',
    model: 'Model',
    task: 'Task',
    directory: 'Directory',
    session: 'Session',
    goal: 'Goal',
    orphan: 'unknown parent',
    cycle: 'invalid parentage (cycle)',
    contest: 'contested parentage',
    unassigned: 'Unassigned',
    emptyAttention: 'Nothing to handle: no agent running, waiting or freshly finished.',
    emptyHint: 'History stays available through “History” or the search.',
    emptySearch: 'No agent matches.',
    moreTrees: 'Show {n} more tree(s)',
    historyTitle: 'Session history',
    historyHint: 'Idle, viewed or archived sessions. The board never deletes or archives anything.',
    loadMore: 'Load more',
    archived: 'archived',
    noModel: 'unknown model',
    provider: 'Provider',
    modelNative: 'native',
    modelAssignment: 'board',
    modelSource: 'Model source',
    proposals: 'Pending proposal',
    approve: 'Approve',
    reject: 'Reject',
    executions: 'Board executions',
    restore: 'Restart reconciliation',
    resumed: 'interrupted — controlled resume required',
    offNotice: 'Observation only',
    supervisedNotice: 'Proposals wait for your approval',
    autonomousNotice: 'Runs inside the configured mandate',
    orchestratorState: 'Orchestrator and adapters status',
    stateShort: 'Status',
    moreControls: 'Filters and orchestrator',
    dismiss: 'Remove from board',
    undismiss: 'Put back on board',
    dismissHint: 'Hides this session from the Attention and Recent views (the session is not deleted; still visible in All or search)',
    viewLabel: 'View',
    viewModeLabel: 'View mode',
    filterLabel: 'Filter',
    orchestratorLabel: 'Orchestrator',
    syncOk: 'Task Board synced',
    syncError: 'Task Board unreachable',
    adapters: 'Adapters',
    notLive: 'not validated live',
    keyboardHint: 'Enter: open · Space: preview · double-click: open',
    projects: 'Projects',
    ago: 'ago',
    // ---- supervision / hierarchy / identities (GOAL 4)
    role: 'Role',
    roleAll: 'All roles',
    roleGeneric: 'Generic',
    roleFamilyLabel: 'Role family',
    roleDeclared: 'Declared role',
    roleDeclaredAlias: 'declared role (alias)',
    noDeclaredRole: 'No declared role',
    genericIdentity: 'Generic identity',
    familyGovernance: 'Governance / knowledge',
    familyCoordination: 'Coordination / monitoring',
    familyExecution: 'Production / optimization',
    familyQuality: 'Review / audit',
    familyValidation: 'Validation / testing',
    familyProtection: 'Protection / rules',
    statusFilterLabel: 'Status',
    statusAll: 'All statuses',
    viewProjects: 'Projects',
    viewHierarchy: 'Hierarchy',
    taskStateFilterLabel: 'Task Board state',
    taskStateAll: 'All states',
    taskStateUnavailable: 'Task Board not read',
    taskStateUnavailable: 'Task Board unavailable',
    taskStateTitle: 'Linked Task Board state',
    taskTodo: 'Todo',
    taskInProgress: 'In progress',
    taskInReview: 'In review',
    taskBlocked: 'Blocked',
    taskDone: 'Done',
    taskCanceled: 'Canceled',
    taskArchived: 'Archived',
    agent: 'Agent',
    agents: 'agents',
    // Count forms (en): 1 project / 2 projects.
    projectSingular: 'project',
    projectPlural: 'projects',
    agentSingular: 'agent',
    agentPlural: 'agents',
    unreadSingular: 'unread',
    unreadPlural: 'unread',
    interruptedSingular: 'interrupted',
    interruptedPlural: 'interrupted',
    blockedSingular: 'blocked',
    blockedPlural: 'blocked',
    turnSingular: 'turn',
    turnPlural: 'turns',
    stepSingular: 'step',
    stepPlural: 'steps',
    shownSingular: 'shown',
    shownPlural: 'shown',
    supervision: 'Supervision',
    supervisionLayer: 'Supervision layer (not an agent)',
    superOrchestrator: 'Super orchestrator',
    supervisionExpand: 'Show supervision',
    supervisionCollapse: 'Hide supervision',
    supervisionUnavailable: 'Supervision not published by the host: real structure and counts, capabilities unavailable.',
    taskboardUnavailable: 'Task Board unavailable for reading',
    supervisionWorkspace: 'Workspace',
    supervisionMode: 'Mode',
    supervisionBlocked: 'blocked',
    supervisionDependencies: 'Cross-project dependencies',
    supervisionNoDependencies: 'No known cross-project dependency.',
    supervisionBlocks: 'Blocking items',
    supervisionNoBlocks: 'No known blocking item.',
    supervisionRecommendations: 'Recommendations',
    supervisionNoRecommendations: 'No recommendation.',
    recommendationNotApplied: 'proposal — not applied',
    recommendationDelegate: 'Delegation',
    recommendationUnblock: 'Unblock',
    recommendationPriority: 'Priority',
    recommendationReassign: 'Reassignment',
    supervisionCapabilities: 'Capabilities',
    supervisionCapabilityReason: 'Reason',
    supervisionStatusActive: 'Active',
    supervisionStatusIdle: 'Idle (observing)',
    supervisionStatusBlocked: 'Blocked',
    supervisionStatusUnknown: 'Unknown',
    supervisionSynthetic: 'Host supervision layer: no session backs it.',
    supervisionDelegation: 'Delegation: {inFlight} in flight · depth {depth} · {concurrent} concurrent · {hourly}/h',
    capObserve: 'Observe',
    capRecommend: 'Recommend',
    capDelegate: 'Delegate',
    capReassign: 'Reassign',
    capPriority: 'Set priority',
    capReceiveReports: 'Orchestrator reports',
    capKanbanWrite: 'Task Board writes',
    capabilityAvailable: 'Available',
    capabilityGated: 'Gated',
    capabilityProposalOnly: 'Proposal only',
    capabilityUnavailable: 'Unavailable',
    capReasonSupervisionUnavailable: 'host: supervision not published',
    capReasonGated: 'subject to limits and operator approval',
    capReasonProposalOnly: 'no write path: proposal only',
    capReasonReadOnly: 'Task Board is read-only from the board',
    capReasonNoChannel: 'no orchestrator report channel in this build',
    capReasonDisabled: 'disabled by policy',
    capReasonUnknown: 'no reason provided by the host',
    hierarchy: 'Hierarchy',
    hierarchyOrchestratorMissing: 'No declared orchestrator',
    hierarchyOrchestratorMissingHint: 'No agent in this project declares the orchestrator role: the board never creates one.',
    hierarchyAgentsCount: '{n} agents',
    hierarchyHiddenByFilter: '{n} hidden by the filter',
    hierarchyNoAgents: 'No visible agent in this project.',
    hierarchyEmpty: 'No agent matches the filters.',
    hierarchyTeamOf: 'Team of {name}',
    activityReal: 'Real activity: {activity}',
    emptyFiltered: 'No agent matches the active filters.',
    clearFilters: 'Clear filters',
    noActivity: 'Activity unknown',
  },
}

let DAB_LANG = 'en'

function dabResolveLocale(ctx) {
  try {
    const snapshot = ctx?.get?.('locale')?.getLocale?.()
    const active = snapshot?.active
    const id = typeof active === 'string' ? active : active?.id
    // 'auto' / 'system' (or anything not a language tag) defers to the document.
    if (typeof id === 'string' && /^(fr|en|zh)/i.test(id)) return id.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch { /* fall through */ }
  try {
    const lang = String(globalThis.document?.documentElement?.lang || globalThis.navigator?.language || 'en')
    return lang.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch {
    return 'en'
  }
}

function dabT(key, vars) {
  const raw = (DAB_STRINGS[DAB_LANG] ?? DAB_STRINGS.en)[key] ?? DAB_STRINGS.en[key] ?? key
  if (vars === undefined) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
}

const DAB_STATUS_TEXT = {
  running: 'statusRunning',
  waiting_user: 'statusWaiting',
  recovering: 'statusRecovering',
  interrupted: 'statusInterrupted',
  provider_unavailable: 'statusProviderUnavailable',
  finished_unread: 'statusUnread',
  finished_read: 'statusRead',
  failed: 'statusFailed',
  idle: 'statusIdle',
  unknown: 'statusUnknown',
  unavailable: 'statusUnavailable',
}

function dabStatusLabel(status) {
  return dabT(DAB_STATUS_TEXT[status] ?? 'statusUnknown')
}

/** Task Board workflow state: a SEPARATE vocabulary from the agent statuses. */
const DAB_TASK_STATE_TEXT = {
  todo: 'taskTodo',
  in_progress: 'taskInProgress',
  in_review: 'taskInReview',
  blocked: 'taskBlocked',
  done: 'taskDone',
  canceled: 'taskCanceled',
  archived: 'taskArchived',
}

function dabTaskStateLabel(state) {
  const key = DAB_TASK_STATE_TEXT[state]
  return key === undefined ? null : dabT(key)
}

/**
 * Translated count noun with a real singular form ("projet"/"projets"). Used
 * where the number is rendered separately (counters, chips).
 */
function dabCountNoun(count, singularKey, pluralKey) {
  const value = Number(count) || 0
  const key = typeof pluralKeyFor === 'function'
    ? pluralKeyFor(value, singularKey, pluralKey)
    : (Math.abs(value) === 1 ? singularKey : pluralKey)
  return dabT(key)
}

/** Translated count with a real singular form (the UI must never print
 * "1 projets"). The pure key choice lives in board/hierarchy.js. */
function dabCountLabel(count, singularKey, pluralKey) {
  const value = Number(count) || 0
  return `${value} ${dabCountNoun(value, singularKey, pluralKey)}`
}

/** "3 tours · 9 étapes" / "1 turn · 2 steps" — real counters only. */
function dabTurnStepLabel(turns, steps) {
  return `${dabCountLabel(turns, 'turnSingular', 'turnPlural')} · ${dabCountLabel(steps, 'stepSingular', 'stepPlural')}`
}

const DAB_FAMILY_TEXT = {
  governance: 'familyGovernance',
  coordination: 'familyCoordination',
  execution: 'familyExecution',
  quality: 'familyQuality',
  validation: 'familyValidation',
  protection: 'familyProtection',
}

function dabFamilyLabel(family) {
  const key = DAB_FAMILY_TEXT[family]
  return key === undefined ? null : dabT(key)
}

const DAB_SUPERVISION_STATUS_TEXT = {
  active: 'supervisionStatusActive',
  idle: 'supervisionStatusIdle',
  blocked: 'supervisionStatusBlocked',
}

function dabSupervisionStatusLabel(status) {
  const key = DAB_SUPERVISION_STATUS_TEXT[status]
  return key === undefined ? dabT('supervisionStatusUnknown') : dabT(key)
}

const DAB_RECOMMENDATION_TEXT = {
  delegate: 'recommendationDelegate',
  unblock: 'recommendationUnblock',
  priority: 'recommendationPriority',
  reassign: 'recommendationReassign',
}

function dabRecommendationLabel(kind) {
  const key = DAB_RECOMMENDATION_TEXT[kind]
  return key === undefined ? String(kind ?? '') : dabT(key)
}


function dabWaitingLabel(action) {
  if (action === 'approval') return dabT('waitingApproval')
  if (action === 'question') return dabT('waitingQuestion')
  if (action === 'plan-review') return dabT('waitingPlan')
  return dabT('waitingUnknown')
}

function dabFormatAge(at, now = Date.now()) {
  if (!Number.isFinite(Number(at)) || Number(at) <= 0) return ''
  const seconds = Math.max(0, Math.round((now - Number(at)) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} j`
}

/**
 * Chip text: the model name when known, else the provider, else null (the card
 * then renders the explicit "unknown model" label). Never a placeholder for a
 * value the board does not have.
 */
function dabModelText(model) {
  if (model === null || model === undefined || model.source === 'unknown') return null
  if (typeof model.model === 'string' && model.model !== '') return model.model
  if (typeof model.provider === 'string' && model.provider !== '') return model.provider
  return null
}

function dabModelTitle(model) {
  if (model === null || model === undefined || model.source === 'unknown') return dabT('noModel')
  const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '?'
  const name = typeof model.model === 'string' && model.model !== '' ? model.model : '?'
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  const source = model.source === 'assignment' ? ` · ${dabT('modelAssignment')}` : ` · ${dabT('modelNative')}`
  return `${provider}/${name}${effort}${source}`
}

/** Compact `provider/model` chip label for the inspector, null when unknown. */
function dabModelChipText(model) {
  if (model === null || model === undefined || model.source === 'unknown') return null
  const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '?'
  const name = typeof model.model === 'string' && model.model !== '' ? model.model : '?'
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  return `${provider}/${name}${effort}`
}


// ---- src/client/ui/styles.js ----
/**
 * Panel CSS. Only DSH theme tokens (--dsw-*) are used, so light, dark and
 * custom themes apply unchanged. Borderless surfaces (fill contrast only),
 * floating inspector, curved SVG connectors drawn by ui/tree.js.
 * Layout switches on the panel width (container query), not the window width.
 *
 * @module dsh-agent-board/client/ui/styles
 */

const DAB_STYLE_ID = 'dsh-agent-board-style'

const DAB_CSS = `
.dab-root { container-type: inline-size; container-name: dab; position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; overflow: hidden; }
.dab-root *, .dab-root *::before, .dab-root *::after { box-sizing: border-box; }
/* Borderless cards need a fill that differs from the page in BOTH themes (light layers are all #fff). */
.dab-root { --dab-card-fill: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))); --dab-panel-fill: var(--dsw-alias-bg-layer-1); --dab-chip-fill: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))); }
.dab-round, .dab-dot, .dab-mark::before, .dab-group-ring, .dab-pill { corner-shape: round; }

/* ---------- toolbar */
.dab-toolbar { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 16px; position: relative; z-index: 4; }
.dab-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dab-title { font-size: 16px; line-height: 24px; font-weight: 500; margin: 0 4px 0 0; white-space: nowrap; }
.dab-grow { flex: 1 1 0; min-width: 0; }
.dab-counter { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-counter b { color: var(--dsw-alias-label-primary); font-weight: 500; font-variant-numeric: tabular-nums; }
.dab-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dab-dot[data-tone="running"] { background: var(--dsw-alias-brand-primary); }
.dab-dot[data-tone="waiting"] { background: var(--dsw-alias-state-warn-primary); }
.dab-dot[data-tone="unread"] { background: var(--dsw-alias-state-success-primary); }
.dab-dot[data-tone="failed"] { background: var(--dsw-alias-state-error-primary); }
.dab-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dab-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 28px; border-radius: var(--dsw-radius-sm); border: 0;
  background: var(--dab-card-fill); color: var(--dsw-alias-label-primary); padding: 4px 10px; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.dab-btn:focus-visible, .dab-input:focus-visible, .dab-select:focus-visible, .dab-pill:focus-visible, .dab-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dab-btn[aria-pressed="true"] { background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-bg-layer-1)); }
.dab-btn[disabled] { opacity: .45; cursor: not-allowed; }
.dab-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }
.dab-btn[data-variant="ghost"] { background: transparent; }
@media (hover: hover) {
  .dab-btn:hover:not([disabled]), .dab-pill:hover, .dab-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dab-btn[data-danger="true"]:hover:not([disabled]) { background: var(--dsw-alias-interactive-bg-hover-danger); }
  .dab-card:hover { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-1)); }
  .dab-hist:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.dab-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md); background: var(--dab-card-fill); }
.dab-seg .dab-btn { background: transparent; min-height: 26px; }
.dab-seg .dab-btn[aria-pressed="true"] { background: var(--dsw-alias-bg-base); }
.dab-input, .dab-select { min-height: 28px; border-radius: var(--dsw-radius-sm); border: 0; background: var(--dab-card-fill); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; padding: 4px 10px; min-width: 0; }
.dab-input { flex: 1 1 200px; max-width: 320px; }
.dab-select { max-width: 200px; flex: none; appearance: none; -webkit-appearance: none; cursor: pointer; padding-right: 26px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center; background-size: 12px; text-overflow: ellipsis; }
.dab-select:disabled { opacity: .55; cursor: default; }
.dab-dd { position: relative; display: inline-flex; flex: none; min-width: 0; }
.dab-dd > .dab-select { width: 100%; text-align: left; display: inline-flex; align-items: center; }
.dab-dd-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dab-dd-pop { position: absolute; left: 0; top: calc(100% + 6px); z-index: 8; min-width: max(100%, 180px); max-width: min(320px, 90vw); max-height: 50vh; overflow: auto;
  margin: 0; padding: 4px; list-style: none; border-radius: var(--dsw-radius-md); background: var(--dab-panel-fill); box-shadow: var(--dsw-elevation-prominent); outline: none; }
.dab-dd-opt { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 4px 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-primary); }
.dab-dd-opt[data-active="true"] { background: var(--dab-chip-fill); }
.dab-dd-opt[aria-selected="true"] { font-weight: 500; }
.dab-dd-check { margin-left: auto; color: var(--dsw-alias-label-secondary); }
@media (pointer: coarse) { .dab-dd-opt { min-height: 40px; font-size: 15px; } }
.dab-select option { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.dab-counters { display: inline-flex; align-items: center; gap: 10px; flex: none; }
.dab-search-wrap { display: flex; flex: 1 1 160px; min-width: 120px; max-width: 320px; }
.dab-search-wrap .dab-input { max-width: none; }
.dab-ico { display: block; flex: none; }
.dab-btn .dab-ico { display: inline-block; vertical-align: -3px; }
.dab-icon-btn[data-danger="true"]:not([disabled]) { color: var(--dsw-alias-state-error-primary); }
.dab-icon-btn[disabled] { opacity: .4; cursor: default; }
@media (pointer: coarse) { .dab-input, .dab-select { font-size: 16px; } }
.dab-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.dab-notice { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-alert { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dab-icon-btn { flex: none; width: 28px; height: 28px; border-radius: var(--dsw-radius-sm); border: 0; background: transparent; display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 1; cursor: pointer; padding: 0; }

/* ---------- orchestrator status popover (small, in the toolbar) */
.dab-state { position: relative; }
.dab-state > summary { list-style: none; cursor: pointer; }
.dab-state > summary::-webkit-details-marker { display: none; }
.dab-state-pop { position: absolute; right: 0; top: calc(100% + 6px); width: min(360px, 90vw); max-height: 60vh; overflow: auto; padding: 10px 12px;
  border-radius: var(--dsw-radius-lg); background: var(--dab-panel-fill); box-shadow: var(--dsw-elevation-prominent); z-index: 6; }

/* ---------- layout */
.dab-main { flex: 1; min-height: 0; display: flex; position: relative; }
.dab-scroll { flex: 1; min-width: 0; overflow: auto; padding: 6px 16px 40px; }
.dab-projects { display: flex; flex-wrap: wrap; gap: 8px 28px; align-items: flex-start; }
.dab-project { margin: 0 0 14px; min-width: 0; max-width: 100%; }
.dab-project-head { display: flex; align-items: center; gap: 8px; border: 0; background: none; padding: 4px 6px 4px 2px; margin: 0 0 6px; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; text-align: left; border-radius: var(--dsw-radius-sm); }
.dab-project-head .dab-caret { color: var(--dsw-alias-label-secondary); width: 12px; flex: none; }
.dab-project-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-forest { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: flex-start; }
.dab-tile { position: relative; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding: 2px; }
.dab-more { margin-top: 8px; }

/* ---------- tree: layout only, connectors are an SVG overlay (.dab-links) */
.dab-tree { list-style: none; margin: 0; padding: 0; position: relative; z-index: 1; }
.dab-branch { display: flex; align-items: flex-start; list-style: none; margin: 0; padding: 0; }
.dab-kids { list-style: none; margin: 0; padding: 0 0 0 34px; display: flex; flex-direction: column; gap: 8px; }
.dab-links { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; z-index: 0; }
.dab-links path { fill: none; stroke: var(--dsw-alias-border-l3); stroke-width: 1.25; stroke-linecap: round; }
.dab-links path[data-active="true"] { stroke: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }

/* ---------- card (borderless: fill contrast only) */
.dab-card { position: relative; flex: none; width: 210px; min-height: 46px; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px;
  border-radius: var(--dsw-radius-md); border: 0; background: var(--dab-card-fill); cursor: pointer; user-select: none;
  transition: background-color .12s ease, box-shadow .12s ease; outline: none; }
.dab-card[data-root="true"] { width: 248px; border-radius: var(--dsw-radius-lg); padding: 10px 12px; }
.dab-card:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dab-card[data-selected="true"] { box-shadow: 0 0 0 1.5px var(--dsw-alias-brand-primary); }
.dab-card[data-status="waiting_user"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dab-card-fill)); }
.dab-card[data-status="interrupted"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, var(--dab-card-fill)); }
.dab-card[data-status="provider_unavailable"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, var(--dab-card-fill)); }
.dab-card[data-status="failed"][data-seen="false"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, var(--dab-card-fill)); }
.dab-card[data-calm="true"] .dab-name { color: var(--dsw-alias-label-secondary); }
.dab-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dab-name { flex: 1; min-width: 0; font-weight: 500; font-size: 13px; line-height: 18px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.dab-meta { display: flex; align-items: center; flex-wrap: wrap; align-content: flex-start; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; padding-left: 22px; }
/* The work row (task id, Task Board state, age) wraps freely: no max-height, so a
   wrapped line is never clipped mid-glyph; each item ellipsizes on its own. */
.dab-meta-work { row-gap: 2px; }
.dab-meta > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 100%; }
.dab-meta .dab-sep::before { content: "·"; }
.dab-wait { font-size: 12px; color: var(--dsw-alias-state-warn-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 22px; }
.dab-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 22px; }
.dab-card-foot { display: flex; align-items: center; gap: 6px; margin-top: 2px; padding-left: 22px; }
.dab-pill { display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: 999px; background: var(--dab-chip-fill);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; padding: 0 8px; min-height: 22px; cursor: pointer; }
/* Compact provider/model chip (card meta row and inspector). Same line height as
   the surrounding meta text, so the card layout does not change. */
.dab-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-chip[data-source="unknown"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); }
.dab-chip[data-source="assignment"] { box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, transparent); }
.dab-pill[data-tone="running"] { color: var(--dsw-alias-label-primary); }
.dab-quick { opacity: 0; }
.dab-card:focus-within .dab-quick, .dab-card[data-selected="true"] .dab-quick { opacity: 1; }
@media (hover: hover) { .dab-card:hover .dab-quick { opacity: 1; } }
@media (hover: none) { .dab-quick { opacity: 1; } }

/* ---------- status mark (always a true circle) */
.dab-mark { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; }
.dab-mark::before { content: ""; display: block; border-radius: 50%; corner-shape: round; }
.dab-mark[data-status="running"]::before { animation: dab-spin .9s linear infinite; width: 13px; height: 13px; border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); border-top-color: var(--dsw-alias-label-primary); }
.dab-mark[data-status="waiting_user"]::before { width: 9px; height: 9px; background: var(--dsw-alias-state-warn-primary); }
.dab-mark[data-status="finished_unread"]::before { width: 9px; height: 9px; background: var(--dsw-alias-state-success-primary); }
.dab-mark[data-status="failed"]::before { width: 9px; height: 9px; background: var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="failed"][data-seen="true"]::before { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="finished_read"]::before { width: 8px; height: 8px; background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary)); }
.dab-mark[data-status="idle"]::before { width: 8px; height: 8px; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary)); }
/* Interrupted: hollow amber ring. Provider outage: dashed error ring. Neither
   animates, so the running ring stays the only motion in the panel. */
.dab-mark[data-status="interrupted"]::before { width: 9px; height: 9px; background: transparent; box-shadow: inset 0 0 0 2px var(--dsw-alias-state-warn-primary); }
.dab-mark[data-status="provider_unavailable"]::before { width: 9px; height: 9px; border: 1.5px dashed var(--dsw-alias-state-error-primary); }
.dab-mark[data-status="unknown"]::before { width: 8px; height: 8px; border: 1.5px dashed var(--dsw-alias-label-secondary); }
.dab-group-ring { display: inline-block; width: 8px; height: 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-primary); margin-right: 2px; }
@keyframes dab-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .dab-mark[data-status="running"]::before { animation: none; border-right-color: var(--dsw-alias-label-primary); }
  .dab-card, .dab-inspector { transition: none; }
}

/* ---------- compact grid */
.dab-compact-group { margin: 0 0 10px; }
.dab-compact-parent { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-compact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px; }
.dab-compact-grid .dab-card { width: auto; min-height: 0; padding: 6px 8px; }

/* ---------- inspector: floating panel */
.dab-inspector { flex: none; width: 340px; max-width: 42%; margin: 4px 12px 12px 0; border-radius: var(--dsw-radius-xl); border: 0;
  background: var(--dab-panel-fill); box-shadow: var(--dsw-elevation-panel); overflow: auto; padding: 14px 16px 20px;
  display: flex; flex-direction: column; gap: 10px; align-self: stretch; }
.dab-insp-head { display: flex; align-items: flex-start; gap: 8px; }
.dab-insp-title { font-size: 14px; line-height: 22px; font-weight: 500; margin: 0; word-break: break-word; flex: 1; min-width: 0; }
.dab-insp-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.dab-answer { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; background: var(--dab-card-fill);
  border-radius: var(--dsw-radius-md); padding: 8px 10px; max-height: 320px; overflow: auto; }
.dab-answer[data-empty="true"] { color: var(--dsw-alias-label-secondary); font-style: italic; }
.dab-dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; font-size: 12px; }
.dab-dl dt { color: var(--dsw-alias-label-secondary); }
.dab-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dab-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.dab-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dab-linkish { border: 0; background: none; padding: 0; color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; text-align: left; }
.dab-tag { display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px; corner-shape: round; font-size: 12px; background: var(--dab-card-fill); color: var(--dsw-alias-label-secondary); white-space: nowrap; }

/* ---------- drawer (history): floating */
.dab-drawer { position: absolute; top: 8px; right: 12px; bottom: 12px; width: min(440px, calc(100% - 24px)); background: var(--dab-panel-fill);
  border-radius: var(--dsw-radius-xl); box-shadow: var(--dsw-elevation-prominent); display: flex; flex-direction: column; z-index: 5; overflow: hidden; }
.dab-drawer-head { padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 8px; }
.dab-drawer-head .dab-input { flex: none; max-width: none; width: 100%; }
.dab-drawer-list { flex: 1; overflow: auto; list-style: none; margin: 0; padding: 0 8px 16px; }
.dab-hist { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--dsw-radius-md); cursor: pointer; }
.dab-hist:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-hist[data-selected="true"] { background: var(--dab-card-fill); }
.dab-hist-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dab-hist-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- misc */
.dab-panel { border-radius: var(--dsw-radius-lg); padding: 8px 12px; margin: 0 0 12px; background: var(--dab-card-fill); }
.dab-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dab-list li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.dab-empty { padding: 40px 12px; text-align: center; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.dab-mobile-menu { display: none; }
.dab-only-narrow { display: none; }

/* ---------- narrow panel (phone, small window): compact header + overview */
@container dab (max-width: 720px) {
  .dab-toolbar { padding: 8px 10px 6px; gap: 6px; }
  .dab-only-wide { display: none !important; }
  .dab-only-narrow { display: inline-flex; }
  .dab-title { font-size: 15px; }
  .dab-input { max-width: none; flex: 1 1 0; }
  .dab-mobile-menu { display: flex; flex-direction: column; gap: 8px; padding: 8px 0 2px; }
  .dab-mobile-menu .dab-bar { gap: 6px; }
  .dab-scroll { padding: 4px 10px 32px; overflow-x: hidden; }
  .dab-projects { display: block; }
  .dab-project { margin-bottom: 10px; }
  .dab-forest { display: block; }
  .dab-forest > .dab-tile + .dab-tile { margin-top: 8px; }
  .dab-tile { overflow: visible; padding: 0; }
  .dab-branch { flex-direction: column; align-items: stretch; }
  .dab-card, .dab-card[data-root="true"] { width: 100%; padding: 7px 10px; min-height: 0; }
  .dab-name { -webkit-line-clamp: 1; }
  .dab-kids { padding: 6px 0 0 22px; gap: 6px; }
  .dab-inspector { position: absolute; left: 8px; right: 8px; bottom: 8px; width: auto; max-width: none; max-height: 64%; margin: 0; z-index: 5; box-shadow: var(--dsw-elevation-prominent); }
  .dab-pill, .dab-btn { min-height: 32px; }
  .dab-icon-btn { width: 32px; height: 32px; }
}

/* ---------- identity (GOAL 4): mascot, resolved role, project, task chip */
.dab-card-main { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.dab-card-mascot { flex: none; display: inline-flex; align-items: center; justify-content: center; }
.dab-card-mascot .dab-avatar, .dab-band-mascot .dab-avatar, .dab-hier-orch .dab-avatar, .dab-project-orch .dab-avatar { flex: none; }
.dab-card-ident { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* Inside the identity column the rows align with the title, not with the mascot. */
.dab-card-ident > .dab-meta, .dab-card-ident > .dab-wait, .dab-card-ident > .dab-err, .dab-card-ident > .dab-card-foot { padding-left: 0; }
.dab-role-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-role-chip[data-resolution="generic"] { background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); }
/* Family chip: identity context only, never a status colour. */
.dab-family-chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: transparent; box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary));
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-project-line { color: var(--dsw-alias-label-secondary); }
.dab-task-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 0 6px; border-radius: 999px; corner-shape: round;
  background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.dab-task-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-secondary); }
.dab-task-chip[data-tone="active"] .dab-task-dot { background: var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary)); }
.dab-task-chip[data-tone="waiting"] .dab-task-dot, .dab-task-chip[data-tone="reviewing"] .dab-task-dot,
.dab-task-chip[data-tone="interrupted"] .dab-task-dot { background: var(--dsw-alias-state-warn-primary); }
.dab-task-chip[data-tone="blocked"] .dab-task-dot { background: var(--dsw-alias-state-error-primary); }
.dab-task-chip[data-tone="unread"] .dab-task-dot { background: var(--dsw-alias-state-success-primary); }
.dab-task-chip[data-tone="done"] .dab-task-dot { background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dab-task-chip[data-tone="idle"] .dab-task-dot, .dab-task-chip[data-tone="gone"] .dab-task-dot { background: var(--dsw-alias-border-l3, var(--dsw-alias-label-secondary)); }
.dab-activity { margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* ---------- mascot (ui/avatar.js owns the markup, this file owns the paint) */
.dab-avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: var(--dab-avatar-size, 40px); height: var(--dab-avatar-size, 40px); border-radius: 50%; }
.dab-avatar[data-selected="true"] { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.dab-avatar-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.dab-avatar-fallback { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: 50%; background: var(--dab-chip-fill); }
/* Status dot: SEPARATE from the mascot; colour comes from the status tone, the
   role colour never expresses a status. */
.dab-avatar-dot { position: absolute; right: 0; bottom: 0; box-sizing: content-box; border-radius: 50%;
  width: max(7px, calc(var(--dab-avatar-size, 40px) * 0.23)); height: max(7px, calc(var(--dab-avatar-size, 40px) * 0.23));
  border: 2px solid var(--dab-card-fill); background: var(--dsw-alias-label-secondary); }
.dab-avatar-dot[data-tone="active"] { background: var(--dsw-alias-state-success-primary); }
.dab-avatar-dot[data-tone="planning"] { background: var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary)); }
.dab-avatar-dot[data-tone="waiting"], .dab-avatar-dot[data-tone="reviewing"],
.dab-avatar-dot[data-tone="interrupted"] { background: var(--dsw-alias-state-warn-primary); }
.dab-avatar-dot[data-tone="blocked"] { background: var(--dsw-alias-state-error-primary); }
.dab-avatar-dot[data-tone="unread"] { background: var(--dsw-alias-state-success-primary); }
.dab-avatar-dot[data-tone="done"] { background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dab-avatar-dot[data-tone="idle"] { background: var(--dsw-alias-label-secondary); }
.dab-avatar-dot[data-tone="gone"] { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); }
.dab-avatar-task { position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%); padding: 0 4px; border-radius: 999px;
  font-size: 9px; line-height: 12px; white-space: nowrap; background: var(--dab-chip-fill); color: var(--dsw-alias-label-secondary); }
.dab-project-orch { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dab-project-orch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.dab-dot[data-tone="idle"] { background: var(--dsw-alias-label-secondary); }

/* ---------- supervision band (host supervision LAYER, not an agent) */
.dab-band { flex: none; margin: 0 0 10px; border-radius: var(--dsw-radius-lg); background: var(--dab-card-fill); overflow: hidden; }
.dab-band-head { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 54px; padding: 8px 30px 8px 12px; border: 0; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--dsw-radius-lg); }
.dab-band-head > .dab-caret { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); width: 12px; flex: none; color: var(--dsw-alias-label-secondary); }
.dab-band-head:focus-visible, .dab-hier-project-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dab-band-mascot { flex: none; display: inline-flex; align-items: center; }
.dab-band-ident { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dab-band-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; font-weight: 500; }
.dab-band-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-band-counters { flex: 0 1 auto; display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
.dab-band-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 12px 12px; min-width: 0; }
/* The body is always in the DOM (aria-controls must resolve); collapsed = hidden. */
.dab-band-body[hidden] { display: none; }
.dab-band-notice { padding: 6px 8px; border-radius: var(--dsw-radius-sm); font-size: 12px;
  color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.dab-band-agent { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.dab-band-section { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dab-band-list { max-height: 180px; overflow: auto; }
.dab-band-list li { align-items: flex-start; }
.dab-sup-status { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-sup-status[data-status="active"] .dab-dot { background: var(--dsw-alias-brand-primary); }
.dab-sup-status[data-status="blocked"] .dab-dot { background: var(--dsw-alias-state-error-primary); }
.dab-sup-status[data-status="unknown"] .dab-dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-secondary); }
.dab-tag[data-tone="proposal"] { color: var(--dsw-alias-state-warn-primary); }
.dab-cap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 14px; }
.dab-cap-row { display: grid; grid-template-columns: minmax(96px, auto) auto; gap: 0 8px; align-items: baseline; padding: 3px 0;
  border-top: 1px solid var(--dsw-alias-border-l3, transparent); font-size: 12px; }
.dab-cap-label { color: var(--dsw-alias-label-primary); }
.dab-cap-value { font-weight: 500; }
.dab-cap-value[data-available="true"] { color: var(--dsw-alias-label-secondary); }
.dab-cap-value[data-available="false"] { color: var(--dsw-alias-state-warn-primary); }
.dab-cap-reason { grid-column: 1 / -1; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary); }
.dab-cap-reason-label { opacity: .75; }

/* ---------- hierarchy view: workspace -> projects -> teams of cards */
.dab-hier { display: flex; flex-direction: column; gap: 10px; }
.dab-hier-ws { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg); background: var(--dab-card-fill); }
.dab-hier-ws-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dab-hier-ws-mascot { flex: none; display: inline-flex; align-items: center; }
.dab-hier-ws-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dab-hier-ws-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; font-weight: 500; }
.dab-hier-ws-sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dab-hier-projects { display: flex; flex-direction: column; gap: 10px; }
.dab-hier-project { border-radius: var(--dsw-radius-lg); background: var(--dab-card-fill); padding: 4px 6px 8px; }
.dab-hier-project-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%; padding: 6px; border: 0; border-radius: var(--dsw-radius-md);
  background: none; color: inherit; font: inherit; font-size: 13px; font-weight: 500; text-align: left; cursor: pointer; }
.dab-hier-project-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 42%; }
.dab-hier-orch { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dab-hier-orch[data-gap="true"] { color: var(--dsw-alias-state-warn-primary); }
.dab-gap-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1.5px currentColor; }
.dab-hier-counts { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dab-hier-project-head > .dab-hier-counts { margin-left: auto; }
.dab-hier-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 4px; }
.dab-hier-team { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dab-hier-team-title { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-hier-team-note { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-hier-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 6px; }
.dab-hier-cards .dab-card { width: auto; }
.dab-hier-notes { padding: 6px 8px; border-radius: var(--dsw-radius-md); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }

/* ---------- narrow: stacked band, single-column hierarchy (no connector lines) */
@container dab (max-width: 720px) {
  .dab-band-head { flex-wrap: wrap; align-items: flex-start; min-height: 0; }
  /* The chevron stays on the FIRST line (absolute), never under the counters. */
  .dab-band-head > .dab-caret { top: 10px; transform: none; }
  .dab-band-counters { width: 100%; justify-content: flex-start; }
  .dab-band-body { padding: 2px 10px 10px; }
  .dab-cap-grid { grid-template-columns: 1fr; }
  .dab-hier-project-head { align-items: flex-start; }
  .dab-hier-project-title { max-width: 100%; white-space: normal; }
  .dab-hier-project-head > .dab-hier-counts { margin-left: 0; }
  .dab-hier-cards { grid-template-columns: 1fr; }
  .dab-project-orch-name { max-width: 110px; }
}
@container dab (max-width: 420px) {
  .dab-hier-ws-head { align-items: flex-start; }
  .dab-band-counters { gap: 8px; }
  .dab-hier-ws-sub { gap: 6px; }
}
`

function dabInjectStyles(ctxStyles) {
  try {
    if (typeof ctxStyles?.insert === 'function') return ctxStyles.insert(DAB_CSS)
    const document = globalThis.document
    if (document === undefined || document === null) return () => {}
    const previous = document.getElementById(DAB_STYLE_ID)
    if (previous !== null) previous.remove()
    const style = document.createElement('style')
    style.id = DAB_STYLE_ID
    style.textContent = DAB_CSS
    document.head.appendChild(style)
    return () => {
      try { style.remove() } catch { /* ignore */ }
    }
  } catch {
    return () => {}
  }
}


// ---- src/client/ui/agent-bots-assets.js ----
/* GENERATED FILE — run node scripts/build-assets.mjs */
const AGENT_BOT_ASSETS = Object.freeze({
  architect: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWFyY2hpdGVjdCI+Cjx0aXRsZSBpZD0idGl0bGUtYXJjaGl0ZWN0Ij5BcmNoaXRlY3Qg4oCUIENvbsOnb2l0IGV0IHN0cnVjdHVyZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtYXJjaGl0ZWN0IiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTU3NUY5Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM4OTVBRUQiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM3MzQ2RDciLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iIzg5NUFFRCIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiM4OTVBRUQiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gNTMgNDMgTCA0MSAzNCIvPgo8cGF0aCBkPSJNIDY1IDMwIEwgNTcgMTciLz4KPHBhdGggZD0iTSA4MyAyNSBMIDgwIDExIi8+PC9nPgo8cGF0aCBkPSJNIDEwNy4xMyA0Ni45NyBDIDEwMS4zOCA1MS4zNCA4Ni4wMiA2NS40NiA3OS4wOCA3My41MyBDIDcyLjE1IDgxLjYxIDU4LjI5IDEwMC4yOSA1Mi4zNyAxMTAuNzMgQyA0Ni40NSAxMjEuMTYgMzUuMDQgMTQ4LjY1IDMyLjM0IDE1NS44OSBDIDI5LjYzIDE2My4xMiAzMC40OSAxNjQuMTQgMzEuMDAgMTY3Ljg0IEMgMzEuNTEgMTcxLjU0IDM0LjgyIDE4MS45MSAzNi4zNCAxODUuMTEgQyAzNy44NyAxODguMzAgNDAuMTQgMTkwLjg5IDQzLjAyIDE5My4wOCBDIDQ1LjkwIDE5NS4yNiA1MS45NCAyMDAuMTkgNTkuMDUgMjAyLjM3IEMgNjYuMTUgMjA0LjU2IDg0Ljc0IDIwOS4zMyA5OS4xMiAyMTAuMzQgQyAxMTMuNTAgMjExLjM1IDE2MS4wNyAyMTAuNjggMTcyLjU4IDIxMC4zNCBDIDE4NC4wOCAyMTAuMDEgMTg1LjU0IDIwOC44NiAxODkuOTQgMjA3LjY5IEMgMTk0LjM0IDIwNi41MSAyMDMuOTIgMjAyLjkwIDIwNy4zMCAyMDEuMDUgQyAyMTAuNjggMTk5LjIwIDIxNC42MiAxOTUuNjAgMjE2LjY1IDE5My4wOCBDIDIxOC42OCAxOTAuNTUgMjIyLjMxIDE4NS44MyAyMjMuMzMgMTgxLjEyIEMgMjI0LjM0IDE3Ni40MSAyMjUuODUgMTYyLjk1IDIyNC42NiAxNTUuODkgQyAyMjMuNDggMTQ4LjgyIDIxOC4wNCAxMzQuNDIgMjEzLjk4IDEyNS4zNCBDIDIwOS45MiAxMTYuMjUgMTk3LjAxIDkxLjczIDE5Mi42MSA4NC4xNiBDIDE4OC4yMSA3Ni41OSAxODIuODEgNjkuNzcgMTc5LjI1IDY1LjU2IEMgMTc1LjcwIDYxLjM2IDE2OC43OSA1NC4xNSAxNjQuNTYgNTAuOTUgQyAxNjAuMzMgNDcuNzYgMTUwLjk0IDQxLjg0IDE0NS44NiA0MC4zMyBDIDE0MC43OSAzOC44MSAxMjkuNDAgMzguMTYgMTI0LjQ5IDM5LjAwIEMgMTE5LjU5IDM5Ljg0IDExMi44OCA0Mi42MCAxMDcuMTMgNDYuOTcgWiIgZmlsbD0idXJsKCNncmFkaWVudC1hcmNoaXRlY3QpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iMTAwIiBjeT0iMTA4IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTM0IiBjeT0iMTA4IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE1MSAxNDcpIHNjYWxlKDEuMSkiPjxnIHN0cm9rZT0iI2ZmZiIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSI1LjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTI1IDUgNDUgMTUgMjUgMjYgNSAxNSBaIiBmaWxsPSIjZmZmIiBzdHJva2U9Im5vbmUiLz48cGF0aCBkPSJNNSAyNiAyNSAzNyA0NSAyNiBNNSAzNiAyNSA0NyA0NSAzNiIvPjwvZz48L2c+Cjwvc3ZnPgo=', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWFyY2hpdGVjdCI+Cjx0aXRsZSBpZD0idGl0bGUtYXJjaGl0ZWN0Ij5BcmNoaXRlY3Qg4oCUIENvbsOnb2l0IGV0IHN0cnVjdHVyZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtYXJjaGl0ZWN0IiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTU3NUY5Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM4OTVBRUQiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM3MzQ2RDciLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSAxMDcuMTMgNDYuOTcgQyAxMDEuMzggNTEuMzQgODYuMDIgNjUuNDYgNzkuMDggNzMuNTMgQyA3Mi4xNSA4MS42MSA1OC4yOSAxMDAuMjkgNTIuMzcgMTEwLjczIEMgNDYuNDUgMTIxLjE2IDM1LjA0IDE0OC42NSAzMi4zNCAxNTUuODkgQyAyOS42MyAxNjMuMTIgMzAuNDkgMTY0LjE0IDMxLjAwIDE2Ny44NCBDIDMxLjUxIDE3MS41NCAzNC44MiAxODEuOTEgMzYuMzQgMTg1LjExIEMgMzcuODcgMTg4LjMwIDQwLjE0IDE5MC44OSA0My4wMiAxOTMuMDggQyA0NS45MCAxOTUuMjYgNTEuOTQgMjAwLjE5IDU5LjA1IDIwMi4zNyBDIDY2LjE1IDIwNC41NiA4NC43NCAyMDkuMzMgOTkuMTIgMjEwLjM0IEMgMTEzLjUwIDIxMS4zNSAxNjEuMDcgMjEwLjY4IDE3Mi41OCAyMTAuMzQgQyAxODQuMDggMjEwLjAxIDE4NS41NCAyMDguODYgMTg5Ljk0IDIwNy42OSBDIDE5NC4zNCAyMDYuNTEgMjAzLjkyIDIwMi45MCAyMDcuMzAgMjAxLjA1IEMgMjEwLjY4IDE5OS4yMCAyMTQuNjIgMTk1LjYwIDIxNi42NSAxOTMuMDggQyAyMTguNjggMTkwLjU1IDIyMi4zMSAxODUuODMgMjIzLjMzIDE4MS4xMiBDIDIyNC4zNCAxNzYuNDEgMjI1Ljg1IDE2Mi45NSAyMjQuNjYgMTU1Ljg5IEMgMjIzLjQ4IDE0OC44MiAyMTguMDQgMTM0LjQyIDIxMy45OCAxMjUuMzQgQyAyMDkuOTIgMTE2LjI1IDE5Ny4wMSA5MS43MyAxOTIuNjEgODQuMTYgQyAxODguMjEgNzYuNTkgMTgyLjgxIDY5Ljc3IDE3OS4yNSA2NS41NiBDIDE3NS43MCA2MS4zNiAxNjguNzkgNTQuMTUgMTY0LjU2IDUwLjk1IEMgMTYwLjMzIDQ3Ljc2IDE1MC45NCA0MS44NCAxNDUuODYgNDAuMzMgQyAxNDAuNzkgMzguODEgMTI5LjQwIDM4LjE2IDEyNC40OSAzOS4wMCBDIDExOS41OSAzOS44NCAxMTIuODggNDIuNjAgMTA3LjEzIDQ2Ljk3IFoiIGZpbGw9InVybCgjZ3JhZGllbnQtYXJjaGl0ZWN0KSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjEwMCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEzNCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNTEgMTQ3KSBzY2FsZSgxLjEpIj48ZyBzdHJva2U9IiNmZmYiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNS40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yNSA1IDQ1IDE1IDI1IDI2IDUgMTUgWiIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSJub25lIi8+PHBhdGggZD0iTTUgMjYgMjUgMzcgNDUgMjYgTTUgMzYgMjUgNDcgNDUgMzYiLz48L2c+PC9nPgo8L3N2Zz4K' }),
  auditor: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWF1ZGl0b3IiPgo8dGl0bGUgaWQ9InRpdGxlLWF1ZGl0b3IiPkF1ZGl0b3Ig4oCUIEF1ZGl0ZSBldCBjb250csO0bGU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LWF1ZGl0b3IiIHgxPSIxOSUiIHkxPSIwJSIgeDI9Ijc3JSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGREEyNDkiLz48c3RvcCBvZmZzZXQ9IjUzJSIgc3RvcC1jb2xvcj0iI0VCN0UyNSIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0RENjkxNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8ZWxsaXBzZSBjeD0iMTI4IiBjeT0iMjMwIiByeD0iODEiIHJ5PSI5IiBmaWxsPSIjRUI3RTI1IiBvcGFjaXR5PSIwLjE2Ii8+CjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0VCN0UyNSIgc3Ryb2tlLXdpZHRoPSI5LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTSAxOTYgNDkgTCAyMDUgMjkiLz4KPHBhdGggZD0iTSAyMTIgNTUgTCAyMjggNDciLz48L2c+CjxwYXRoIGQ9Ik0gMTA5LjY0IDQ4LjM1IEMgMTAxLjM3IDUwLjA2IDg1LjI1IDU3LjA2IDc4LjM2IDYxLjg1IEMgNzEuNDcgNjYuNjMgNTkuNTUgNzkuNjQgNTUuMjQgODYuMTQgQyA1MC45MyA5Mi42MyA0NS43NCAxMDUuMjcgNDQuMzYgMTEzLjEzIEMgNDIuOTggMTIwLjk5IDQyLjgxIDE0MC4xOCA0NC4zNiAxNDguMjIgQyA0NS45MSAxNTYuMjUgNTIuMjkgMTcwLjI0IDU2LjYwIDE3Ni41NiBDIDYwLjkxIDE4Mi44OSA3MS44MSAxOTMuODggNzguMzYgMTk4LjE1IEMgODQuOTEgMjAyLjQzIDk5LjY3IDIwOC43NiAxMDguMjggMjEwLjMwIEMgMTE2Ljg5IDIxMS44NCAxMzkuMzAgMjEwLjk4IDE0Ni4zNiAyMTAuMzAgQyAxNTMuNDIgMjA5LjYyIDE1OS4yMiAyMDcuMTIgMTY0LjA0IDIwNC45MCBDIDE2OC44NiAyMDIuNjggMTc5LjYyIDE5Ny4wMyAxODQuNDQgMTkyLjc2IEMgMTg5LjI2IDE4OC40OCAxOTguNjcgMTc3LjQ5IDIwMi4xMiAxNzEuMTYgQyAyMDUuNTcgMTY0Ljg0IDIxMC42MSAxNTAuMTcgMjExLjY0IDE0Mi44MiBDIDIxMi42NyAxMzUuNDcgMjEyLjUyIDEyMS4xNiAyMTAuMjggMTEzLjEzIEMgMjA4LjA0IDEwNS4xMCAxOTguOTYgODYuMjMgMTkzLjk2IDc5LjM5IEMgMTg4Ljk2IDcyLjU1IDE3Ny4yMSA2My4wOCAxNzAuODQgNTkuMTUgQyAxNjQuNDcgNTUuMjEgMTUxLjM5IDQ5LjcyIDE0My42NCA0OC4zNSBDIDEzNS44OSA0Ni45OCAxMTcuOTEgNDYuNjQgMTA5LjY0IDQ4LjM1IFoiIGZpbGw9InVybCgjZ3JhZGllbnQtYXVkaXRvcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MSIgY3k9IjEwNyIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyOCIgY3k9IjEwNyIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMzIgMTM0KSBzY2FsZSgxLjAyKSI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjUuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSIxMCIgeT0iMTAiIHdpZHRoPSIzMiIgaGVpZ2h0PSIzNiIgcng9IjQiLz48cGF0aCBkPSJNMjAgNyBIMzEgQTMgMyAwIDAgMSAzNCAxMCBWMTUgSDE3IFYxMCBBMyAzIDAgMCAxIDIwIDcgWiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik0xNyAzMCAyMyAzNiAzNSAyMyIvPjwvZz48L2c+Cjwvc3ZnPgo=', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWF1ZGl0b3IiPgo8dGl0bGUgaWQ9InRpdGxlLWF1ZGl0b3IiPkF1ZGl0b3Ig4oCUIEF1ZGl0ZSBldCBjb250csO0bGU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LWF1ZGl0b3IiIHgxPSIxOSUiIHkxPSIwJSIgeDI9Ijc3JSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGREEyNDkiLz48c3RvcCBvZmZzZXQ9IjUzJSIgc3RvcC1jb2xvcj0iI0VCN0UyNSIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0RENjkxNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8cGF0aCBkPSJNIDEwOS42NCA0OC4zNSBDIDEwMS4zNyA1MC4wNiA4NS4yNSA1Ny4wNiA3OC4zNiA2MS44NSBDIDcxLjQ3IDY2LjYzIDU5LjU1IDc5LjY0IDU1LjI0IDg2LjE0IEMgNTAuOTMgOTIuNjMgNDUuNzQgMTA1LjI3IDQ0LjM2IDExMy4xMyBDIDQyLjk4IDEyMC45OSA0Mi44MSAxNDAuMTggNDQuMzYgMTQ4LjIyIEMgNDUuOTEgMTU2LjI1IDUyLjI5IDE3MC4yNCA1Ni42MCAxNzYuNTYgQyA2MC45MSAxODIuODkgNzEuODEgMTkzLjg4IDc4LjM2IDE5OC4xNSBDIDg0LjkxIDIwMi40MyA5OS42NyAyMDguNzYgMTA4LjI4IDIxMC4zMCBDIDExNi44OSAyMTEuODQgMTM5LjMwIDIxMC45OCAxNDYuMzYgMjEwLjMwIEMgMTUzLjQyIDIwOS42MiAxNTkuMjIgMjA3LjEyIDE2NC4wNCAyMDQuOTAgQyAxNjguODYgMjAyLjY4IDE3OS42MiAxOTcuMDMgMTg0LjQ0IDE5Mi43NiBDIDE4OS4yNiAxODguNDggMTk4LjY3IDE3Ny40OSAyMDIuMTIgMTcxLjE2IEMgMjA1LjU3IDE2NC44NCAyMTAuNjEgMTUwLjE3IDIxMS42NCAxNDIuODIgQyAyMTIuNjcgMTM1LjQ3IDIxMi41MiAxMjEuMTYgMjEwLjI4IDExMy4xMyBDIDIwOC4wNCAxMDUuMTAgMTk4Ljk2IDg2LjIzIDE5My45NiA3OS4zOSBDIDE4OC45NiA3Mi41NSAxNzcuMjEgNjMuMDggMTcwLjg0IDU5LjE1IEMgMTY0LjQ3IDU1LjIxIDE1MS4zOSA0OS43MiAxNDMuNjQgNDguMzUgQyAxMzUuODkgNDYuOTggMTE3LjkxIDQ2LjY0IDEwOS42NCA0OC4zNSBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LWF1ZGl0b3IpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTEiIGN5PSIxMDciIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMjgiIGN5PSIxMDciIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTMyIDEzNCkgc2NhbGUoMS4wMikiPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI1LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHJlY3QgeD0iMTAiIHk9IjEwIiB3aWR0aD0iMzIiIGhlaWdodD0iMzYiIHJ4PSI0Ii8+PHBhdGggZD0iTTIwIDcgSDMxIEEzIDMgMCAwIDEgMzQgMTAgVjE1IEgxNyBWMTAgQTMgMyAwIDAgMSAyMCA3IFoiIGZpbGw9IiNmZmYiLz48cGF0aCBkPSJNMTcgMzAgMjMgMzYgMzUgMjMiLz48L2c+PC9nPgo8L3N2Zz4K' }),
  dispatcher: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWRpc3BhdGNoZXIiPgo8dGl0bGUgaWQ9InRpdGxlLWRpc3BhdGNoZXIiPkRpc3BhdGNoZXIg4oCUIERpc3RyaWJ1ZSBsZXMgdMOiY2hlczwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtZGlzcGF0Y2hlciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzFERDVGMiIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjMDNCNEUyIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDA5OUQwIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxlbGxpcHNlIGN4PSIxMjgiIGN5PSIyMzAiIHJ4PSI4MSIgcnk9IjkiIGZpbGw9IiMwM0I0RTIiIG9wYWNpdHk9IjAuMTYiLz4KPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDNCNEUyIiBzdHJva2Utd2lkdGg9IjkuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48cGF0aCBkPSJNIDE5NiA0NiBMIDIwNCAyNCIvPgo8cGF0aCBkPSJNIDIxMCA1NCBMIDIyNSA0NSIvPgo8cGF0aCBkPSJNIDIyMCA2NiBMIDIzNiA2MCIvPjwvZz4KPHBhdGggZD0iTSA2MS4zMyA1OS4wMCBDIDU3LjQ1IDYxLjAzIDU2LjM2IDYzLjEzIDU0LjY3IDY1LjY3IEMgNTIuOTggNjguMjAgNDkuMzUgNzMuMDkgNDguMDAgNzkuMDAgQyA0Ni42NSA4NC45MSA0NC4zNCAxMDEuMzYgNDQuMDAgMTEyLjMzIEMgNDMuNjYgMTIzLjMxIDQ0LjE1IDE1NS44NyA0NS4zMyAxNjUuNjcgQyA0Ni41MiAxNzUuNDYgNTAuNDYgMTg1LjExIDUzLjMzIDE4OS42NyBDIDU2LjIwIDE5NC4yMyA2Mi4yNiAxOTkuMzAgNjguMDAgMjAxLjY3IEMgNzMuNzQgMjA0LjAzIDg1LjgzIDIwNy4zMiA5OC42NyAyMDguMzMgQyAxMTEuNTAgMjA5LjM1IDE1OC4zNiAyMDkuODQgMTY5LjMzIDIwOS42NyBDIDE4MC4zMSAyMDkuNTAgMTgxLjk2IDIwOC4wMSAxODUuMzMgMjA3LjAwIEMgMTg4LjcxIDIwNS45OSAxOTMuMzAgMjA0LjIwIDE5Ni4wMCAyMDEuNjcgQyAxOTguNzAgMTk5LjEzIDIwNC44MSAxOTEuNTYgMjA2LjY3IDE4Ny4wMCBDIDIwOC41MiAxODIuNDQgMjEwLjUwIDE3Ny44MyAyMTAuNjcgMTY1LjY3IEMgMjEwLjg0IDE1My41MSAyMDkuMzUgMTAzLjMzIDIwOC4wMCA5MS4wMCBDIDIwNi42NSA3OC42NyAyMDMuMDQgNzIuODkgMjAwLjAwIDY4LjMzIEMgMTk2Ljk2IDYzLjc3IDE5MC4wOCA1Ny41MyAxODQuMDAgNTUuMDAgQyAxNzcuOTIgNTIuNDcgMTU5LjI2IDQ5LjM1IDE1Mi4wMCA0OC4zMyBDIDE0NC43NCA0Ny4zMiAxMzUuMTEgNDYuODMgMTI2LjY3IDQ3LjAwIEMgMTE4LjIyIDQ3LjE3IDkzLjYxIDQ4LjE1IDg1LjMzIDQ5LjY3IEMgNzcuMDYgNTEuMTkgNjUuMjIgNTYuOTcgNjEuMzMgNTkuMDAgWiIgZmlsbD0idXJsKCNncmFkaWVudC1kaXNwYXRjaGVyKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkyIiBjeT0iMTEwIiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTI3IiBjeT0iMTEwIiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0OCAxNDUpIHNjYWxlKDEuMDYpIj48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjUgNDMgVjkgTTI1IDI3IEw5IDE0IE0yNSAyNyBMNDEgMTQiLz48cGF0aCBkPSJNMTcgMTQgSDkgVjIyIE0zMyAxNCBINDEgVjIyIE0xOCAxMyBMMjUgNiBMMzIgMTMiLz48L2c+PC9nPgo8L3N2Zz4K', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWRpc3BhdGNoZXIiPgo8dGl0bGUgaWQ9InRpdGxlLWRpc3BhdGNoZXIiPkRpc3BhdGNoZXIg4oCUIERpc3RyaWJ1ZSBsZXMgdMOiY2hlczwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtZGlzcGF0Y2hlciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzFERDVGMiIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjMDNCNEUyIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDA5OUQwIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxwYXRoIGQ9Ik0gNjEuMzMgNTkuMDAgQyA1Ny40NSA2MS4wMyA1Ni4zNiA2My4xMyA1NC42NyA2NS42NyBDIDUyLjk4IDY4LjIwIDQ5LjM1IDczLjA5IDQ4LjAwIDc5LjAwIEMgNDYuNjUgODQuOTEgNDQuMzQgMTAxLjM2IDQ0LjAwIDExMi4zMyBDIDQzLjY2IDEyMy4zMSA0NC4xNSAxNTUuODcgNDUuMzMgMTY1LjY3IEMgNDYuNTIgMTc1LjQ2IDUwLjQ2IDE4NS4xMSA1My4zMyAxODkuNjcgQyA1Ni4yMCAxOTQuMjMgNjIuMjYgMTk5LjMwIDY4LjAwIDIwMS42NyBDIDczLjc0IDIwNC4wMyA4NS44MyAyMDcuMzIgOTguNjcgMjA4LjMzIEMgMTExLjUwIDIwOS4zNSAxNTguMzYgMjA5Ljg0IDE2OS4zMyAyMDkuNjcgQyAxODAuMzEgMjA5LjUwIDE4MS45NiAyMDguMDEgMTg1LjMzIDIwNy4wMCBDIDE4OC43MSAyMDUuOTkgMTkzLjMwIDIwNC4yMCAxOTYuMDAgMjAxLjY3IEMgMTk4LjcwIDE5OS4xMyAyMDQuODEgMTkxLjU2IDIwNi42NyAxODcuMDAgQyAyMDguNTIgMTgyLjQ0IDIxMC41MCAxNzcuODMgMjEwLjY3IDE2NS42NyBDIDIxMC44NCAxNTMuNTEgMjA5LjM1IDEwMy4zMyAyMDguMDAgOTEuMDAgQyAyMDYuNjUgNzguNjcgMjAzLjA0IDcyLjg5IDIwMC4wMCA2OC4zMyBDIDE5Ni45NiA2My43NyAxOTAuMDggNTcuNTMgMTg0LjAwIDU1LjAwIEMgMTc3LjkyIDUyLjQ3IDE1OS4yNiA0OS4zNSAxNTIuMDAgNDguMzMgQyAxNDQuNzQgNDcuMzIgMTM1LjExIDQ2LjgzIDEyNi42NyA0Ny4wMCBDIDExOC4yMiA0Ny4xNyA5My42MSA0OC4xNSA4NS4zMyA0OS42NyBDIDc3LjA2IDUxLjE5IDY1LjIyIDU2Ljk3IDYxLjMzIDU5LjAwIFoiIGZpbGw9InVybCgjZ3JhZGllbnQtZGlzcGF0Y2hlcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MiIgY3k9IjExMCIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyNyIgY3k9IjExMCIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNDggMTQ1KSBzY2FsZSgxLjA2KSI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTI1IDQzIFY5IE0yNSAyNyBMOSAxNCBNMjUgMjcgTDQxIDE0Ii8+PHBhdGggZD0iTTE3IDE0IEg5IFYyMiBNMzMgMTQgSDQxIFYyMiBNMTggMTMgTDI1IDYgTDMyIDEzIi8+PC9nPjwvZz4KPC9zdmc+Cg==' }),
  guardian: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWd1YXJkaWFuIj4KPHRpdGxlIGlkPSJ0aXRsZS1ndWFyZGlhbiI+R3VhcmRpYW4g4oCUIFPDqWN1cmlzZSBldCBhcHBsaXF1ZSBsZXMgcsOoZ2xlczwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtZ3VhcmRpYW4iIHgxPSIxOSUiIHkxPSIwJSIgeDI9Ijc3JSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGRDg3ODIiLz48c3RvcCBvZmZzZXQ9IjUzJSIgc3RvcC1jb2xvcj0iI0ZFNjU2MCIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0YxNEI0OSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8ZWxsaXBzZSBjeD0iMTI4IiBjeT0iMjMwIiByeD0iODEiIHJ5PSI5IiBmaWxsPSIjRkU2NTYwIiBvcGFjaXR5PSIwLjE2Ii8+CjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZFNjU2MCIgc3Ryb2tlLXdpZHRoPSI5LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTSAxOTQgNTYgTCAyMDMgMzUiLz4KPHBhdGggZD0iTSAyMTIgNjUgTCAyMjYgNTciLz48L2c+CjxwYXRoIGQ9Ik0gNzYuNzYgNjUuNzAgQyA3My4wMCA3MS42MyA1NC41NyAxMDAuMjQgNDkuNzkgMTA4LjU1IEMgNDUuMDEgMTE2Ljg2IDQwLjIwIDEyNi4zOSAzOS4wMCAxMzEuMzEgQyAzNy44MCAxMzYuMjMgMzYuNDIgMTM4LjkwIDQwLjM1IDE0Ny4zOCBDIDQ0LjI4IDE1NS44NiA2NS4wNiAxOTAuNjQgNzAuMDIgMTk4LjI3IEMgNzQuOTcgMjA1LjkwIDc3LjA2IDIwNS45NSA3OS40NSAyMDcuNjQgQyA4MS44NSAyMDkuMzQgNzcuNjIgMjExLjE1IDg4Ljg5IDIxMS42NiBDIDEwMC4xNyAyMTIuMTcgMTU3LjM1IDIxMi4xNyAxNjguNDUgMjExLjY2IEMgMTc5LjU2IDIxMS4xNSAxNzIuMjggMjEzLjA3IDE3Ni41NSAyMDcuNjQgQyAxODAuODIgMjAyLjIyIDE5Ny4yMSAxNzcuMjkgMjAyLjE3IDE2OC44MSBDIDIwNy4xMiAxNjAuMzMgMjE0LjExIDE0NS43OCAyMTUuNjUgMTQwLjY5IEMgMjE3LjE5IDEzNS42MCAyMTguNTcgMTM3LjI5IDIxNC4zMCAxMjguNjMgQyAyMTAuMDMgMTE5Ljk4IDE4Ny4yMyA4MC43MCAxODEuOTQgNzIuMzkgQyAxNzYuNjQgNjQuMDggMTc1LjIzIDY0LjcxIDE3Mi41MCA2My4wMiBDIDE2OS43NyA2MS4zMiAxNzAuNDQgNTkuNTEgMTYwLjM2IDU5LjAwIEMgMTUwLjI5IDU4LjQ5IDEwMy4xOSA1OC42NiA5Mi45NCA1OS4wMCBDIDgyLjY5IDU5LjM0IDgxLjUwIDYwLjgzIDc5LjQ1IDYxLjY4IEMgNzcuNDAgNjIuNTMgODAuNTIgNTkuNzYgNzYuNzYgNjUuNzAgWiIgZmlsbD0idXJsKCNncmFkaWVudC1ndWFyZGlhbikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MiIgY3k9IjExMyIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyNyIgY3k9IjExMyIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMzcgMTM1KSBzY2FsZSgxLjA0KSI+PHBhdGggZD0iTTI1IDQgQzMxIDkgNDAgMTIgNDQgMTMgVjI1IEM0NCAzNiAzNiA0MyAyNSA0OCBDMTQgNDMgNiAzNiA2IDI1IFYxMyBDMTIgMTIgMTkgOSAyNSA0IFoiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L2c+Cjwvc3ZnPgo=', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWd1YXJkaWFuIj4KPHRpdGxlIGlkPSJ0aXRsZS1ndWFyZGlhbiI+R3VhcmRpYW4g4oCUIFPDqWN1cmlzZSBldCBhcHBsaXF1ZSBsZXMgcsOoZ2xlczwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtZ3VhcmRpYW4iIHgxPSIxOSUiIHkxPSIwJSIgeDI9Ijc3JSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGRDg3ODIiLz48c3RvcCBvZmZzZXQ9IjUzJSIgc3RvcC1jb2xvcj0iI0ZFNjU2MCIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0YxNEI0OSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8cGF0aCBkPSJNIDc2Ljc2IDY1LjcwIEMgNzMuMDAgNzEuNjMgNTQuNTcgMTAwLjI0IDQ5Ljc5IDEwOC41NSBDIDQ1LjAxIDExNi44NiA0MC4yMCAxMjYuMzkgMzkuMDAgMTMxLjMxIEMgMzcuODAgMTM2LjIzIDM2LjQyIDEzOC45MCA0MC4zNSAxNDcuMzggQyA0NC4yOCAxNTUuODYgNjUuMDYgMTkwLjY0IDcwLjAyIDE5OC4yNyBDIDc0Ljk3IDIwNS45MCA3Ny4wNiAyMDUuOTUgNzkuNDUgMjA3LjY0IEMgODEuODUgMjA5LjM0IDc3LjYyIDIxMS4xNSA4OC44OSAyMTEuNjYgQyAxMDAuMTcgMjEyLjE3IDE1Ny4zNSAyMTIuMTcgMTY4LjQ1IDIxMS42NiBDIDE3OS41NiAyMTEuMTUgMTcyLjI4IDIxMy4wNyAxNzYuNTUgMjA3LjY0IEMgMTgwLjgyIDIwMi4yMiAxOTcuMjEgMTc3LjI5IDIwMi4xNyAxNjguODEgQyAyMDcuMTIgMTYwLjMzIDIxNC4xMSAxNDUuNzggMjE1LjY1IDE0MC42OSBDIDIxNy4xOSAxMzUuNjAgMjE4LjU3IDEzNy4yOSAyMTQuMzAgMTI4LjYzIEMgMjEwLjAzIDExOS45OCAxODcuMjMgODAuNzAgMTgxLjk0IDcyLjM5IEMgMTc2LjY0IDY0LjA4IDE3NS4yMyA2NC43MSAxNzIuNTAgNjMuMDIgQyAxNjkuNzcgNjEuMzIgMTcwLjQ0IDU5LjUxIDE2MC4zNiA1OS4wMCBDIDE1MC4yOSA1OC40OSAxMDMuMTkgNTguNjYgOTIuOTQgNTkuMDAgQyA4Mi42OSA1OS4zNCA4MS41MCA2MC44MyA3OS40NSA2MS42OCBDIDc3LjQwIDYyLjUzIDgwLjUyIDU5Ljc2IDc2Ljc2IDY1LjcwIFoiIGZpbGw9InVybCgjZ3JhZGllbnQtZ3VhcmRpYW4pIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTIiIGN5PSIxMTMiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMjciIGN5PSIxMTMiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTM3IDEzNSkgc2NhbGUoMS4wNCkiPjxwYXRoIGQ9Ik0yNSA0IEMzMSA5IDQwIDEyIDQ0IDEzIFYyNSBDNDQgMzYgMzYgNDMgMjUgNDggQzE0IDQzIDYgMzYgNiAyNSBWMTMgQzEyIDEyIDE5IDkgMjUgNCBaIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9nPgo8L3N2Zz4K' }),
  integrator: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWludGVncmF0b3IiPgo8dGl0bGUgaWQ9InRpdGxlLWludGVncmF0b3IiPkludGVncmF0b3Ig4oCUIEFzc2VtYmxlIGV0IGNvbnNvbGlkZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtaW50ZWdyYXRvciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzM2RDBBNSIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjMTJBRDg2Ii8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDQ5MjcxIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxlbGxpcHNlIGN4PSIxMjgiIGN5PSIyMzAiIHJ4PSI4MSIgcnk9IjkiIGZpbGw9IiMxMkFEODYiIG9wYWNpdHk9IjAuMTYiLz4KPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTJBRDg2IiBzdHJva2Utd2lkdGg9IjkuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48cGF0aCBkPSJNIDIwMCA2MCBMIDIwOSAzNyIvPgo8cGF0aCBkPSJNIDIxNSA2OCBMIDIyNyA1NCIvPgo8cGF0aCBkPSJNIDIyNiA3NyBMIDI0MSA2OCIvPjwvZz4KPHBhdGggZD0iTSAyOS4wMCAxNTEuNTMgQyAyOC4zMiAxNTYuNjEgMjguMzEgMTY4LjY2IDMwLjMzIDE3NC4yNSBDIDMyLjM2IDE3OS44MyA0MS43OSAxOTIuMDcgNDUuMDAgMTk1LjYzIEMgNDguMjEgMTk5LjE4IDUyLjEyIDIwMC43OSA1NS42NyAyMDIuMzEgQyA1OS4yMSAyMDMuODMgNjUuOTEgMjA2LjQ3IDczLjAwIDIwNy42NSBDIDgwLjA5IDIwOC44NCAxMDAuMDEgMjExLjMzIDExMS42NyAyMTEuNjYgQyAxMjMuMzIgMjEyLjAwIDE1NC4zNiAyMTEuNjggMTY1LjAwIDIxMC4zMyBDIDE3NS42NCAyMDguOTcgMTg5LjQyIDIwNC4zNiAxOTUuNjcgMjAwLjk3IEMgMjAxLjkyIDE5Ny41OSAyMTEuMTIgMTg3LjY2IDIxNC4zMyAxODMuNjAgQyAyMTcuNTQgMTc5LjU0IDIxOS44MiAxNzIuNjMgMjIxLjAwIDE2OC45MCBDIDIyMi4xOCAxNjUuMTggMjI0LjAwIDE1OS4yOCAyMjMuNjcgMTU0LjIwIEMgMjIzLjMzIDE0OS4xMyAyMjEuMjAgMTM0Ljc0IDIxOC4zMyAxMjguODEgQyAyMTUuNDYgMTIyLjg5IDIwNC44OCAxMTAuOTkgMjAxLjAwIDEwNy40MyBDIDE5Ny4xMiAxMDMuODggMTkxLjIxIDEwMS43NyAxODcuNjcgMTAwLjc1IEMgMTg0LjEyIDk5Ljc0IDE3Ni4zOCAxMDEuOTUgMTczLjAwIDk5LjQyIEMgMTY5LjYyIDk2Ljg4IDE2My43MCA4NC4wOSAxNjEuMDAgODAuNzEgQyAxNTguMzAgNzcuMzIgMTU0LjM3IDc0LjU1IDE1MS42NyA3Mi42OSBDIDE0OC45NiA3MC44MyAxNDMuMjEgNjcuMzYgMTM5LjY3IDY2LjAxIEMgMTM2LjEyIDY0LjY1IDEyOC4yMyA2Mi4zNCAxMjMuNjcgNjIuMDAgQyAxMTkuMTEgNjEuNjYgMTA5LjQxIDYxLjQ3IDEwMy42NyA2My4zNCBDIDk3LjkyIDY1LjIwIDgzLjQwIDcyLjMwIDc4LjMzIDc2LjcwIEMgNzMuMjcgODEuMTAgNjYuMDMgOTMuMDAgNjMuNjcgOTguMDggQyA2MS4zMCAxMDMuMTYgNjEuODYgMTEzLjU3IDU5LjY3IDExNi43OSBDIDU3LjQ3IDEyMC4wMCA0OS4zNyAxMjEuMjcgNDYuMzMgMTIzLjQ3IEMgNDMuMjkgMTI1LjY3IDM3Ljg2IDEzMC42MCAzNS42NyAxMzQuMTYgQyAzMy40NyAxMzcuNzEgMjkuNjggMTQ2LjQ1IDI5LjAwIDE1MS41MyBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LWludGVncmF0b3IpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTEiIGN5PSIxMjUiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMjciIGN5PSIxMjUiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTQ2IDE0NCkgc2NhbGUoMS4xNCkiPjxnIHN0cm9rZT0iI2ZmZiIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSI1LjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTI1IDUgNDUgMTUgMjUgMjYgNSAxNSBaIiBmaWxsPSIjZmZmIiBzdHJva2U9Im5vbmUiLz48cGF0aCBkPSJNNSAyNiAyNSAzNyA0NSAyNiBNNSAzNiAyNSA0NyA0NSAzNiIvPjwvZz48L2c+Cjwvc3ZnPgo=', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWludGVncmF0b3IiPgo8dGl0bGUgaWQ9InRpdGxlLWludGVncmF0b3IiPkludGVncmF0b3Ig4oCUIEFzc2VtYmxlIGV0IGNvbnNvbGlkZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtaW50ZWdyYXRvciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzM2RDBBNSIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjMTJBRDg2Ii8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMDQ5MjcxIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxwYXRoIGQ9Ik0gMjkuMDAgMTUxLjUzIEMgMjguMzIgMTU2LjYxIDI4LjMxIDE2OC42NiAzMC4zMyAxNzQuMjUgQyAzMi4zNiAxNzkuODMgNDEuNzkgMTkyLjA3IDQ1LjAwIDE5NS42MyBDIDQ4LjIxIDE5OS4xOCA1Mi4xMiAyMDAuNzkgNTUuNjcgMjAyLjMxIEMgNTkuMjEgMjAzLjgzIDY1LjkxIDIwNi40NyA3My4wMCAyMDcuNjUgQyA4MC4wOSAyMDguODQgMTAwLjAxIDIxMS4zMyAxMTEuNjcgMjExLjY2IEMgMTIzLjMyIDIxMi4wMCAxNTQuMzYgMjExLjY4IDE2NS4wMCAyMTAuMzMgQyAxNzUuNjQgMjA4Ljk3IDE4OS40MiAyMDQuMzYgMTk1LjY3IDIwMC45NyBDIDIwMS45MiAxOTcuNTkgMjExLjEyIDE4Ny42NiAyMTQuMzMgMTgzLjYwIEMgMjE3LjU0IDE3OS41NCAyMTkuODIgMTcyLjYzIDIyMS4wMCAxNjguOTAgQyAyMjIuMTggMTY1LjE4IDIyNC4wMCAxNTkuMjggMjIzLjY3IDE1NC4yMCBDIDIyMy4zMyAxNDkuMTMgMjIxLjIwIDEzNC43NCAyMTguMzMgMTI4LjgxIEMgMjE1LjQ2IDEyMi44OSAyMDQuODggMTEwLjk5IDIwMS4wMCAxMDcuNDMgQyAxOTcuMTIgMTAzLjg4IDE5MS4yMSAxMDEuNzcgMTg3LjY3IDEwMC43NSBDIDE4NC4xMiA5OS43NCAxNzYuMzggMTAxLjk1IDE3My4wMCA5OS40MiBDIDE2OS42MiA5Ni44OCAxNjMuNzAgODQuMDkgMTYxLjAwIDgwLjcxIEMgMTU4LjMwIDc3LjMyIDE1NC4zNyA3NC41NSAxNTEuNjcgNzIuNjkgQyAxNDguOTYgNzAuODMgMTQzLjIxIDY3LjM2IDEzOS42NyA2Ni4wMSBDIDEzNi4xMiA2NC42NSAxMjguMjMgNjIuMzQgMTIzLjY3IDYyLjAwIEMgMTE5LjExIDYxLjY2IDEwOS40MSA2MS40NyAxMDMuNjcgNjMuMzQgQyA5Ny45MiA2NS4yMCA4My40MCA3Mi4zMCA3OC4zMyA3Ni43MCBDIDczLjI3IDgxLjEwIDY2LjAzIDkzLjAwIDYzLjY3IDk4LjA4IEMgNjEuMzAgMTAzLjE2IDYxLjg2IDExMy41NyA1OS42NyAxMTYuNzkgQyA1Ny40NyAxMjAuMDAgNDkuMzcgMTIxLjI3IDQ2LjMzIDEyMy40NyBDIDQzLjI5IDEyNS42NyAzNy44NiAxMzAuNjAgMzUuNjcgMTM0LjE2IEMgMzMuNDcgMTM3LjcxIDI5LjY4IDE0Ni40NSAyOS4wMCAxNTEuNTMgWiIgZmlsbD0idXJsKCNncmFkaWVudC1pbnRlZ3JhdG9yKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkxIiBjeT0iMTI1IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTI3IiBjeT0iMTI1IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0NiAxNDQpIHNjYWxlKDEuMTQpIj48ZyBzdHJva2U9IiNmZmYiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNS40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yNSA1IDQ1IDE1IDI1IDI2IDUgMTUgWiIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSJub25lIi8+PHBhdGggZD0iTTUgMjYgMjUgMzcgNDUgMjYgTTUgMzYgMjUgNDcgNDUgMzYiLz48L2c+PC9nPgo8L3N2Zz4K' }),
  knowledge_manager: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWtub3dsZWRnZV9tYW5hZ2VyIj4KPHRpdGxlIGlkPSJ0aXRsZS1rbm93bGVkZ2VfbWFuYWdlciI+S25vd2xlZGdlIE1hbmFnZXIg4oCUIENvbnNlcnZlIGV0IGRpZmZ1c2U8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LWtub3dsZWRnZV9tYW5hZ2VyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQzY5OEZCIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiNBNTcyRjMiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM4RjVERTUiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iI0E1NzJGMyIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiNBNTcyRjMiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gNTMgNDMgTCA0MSAzNCIvPgo8cGF0aCBkPSJNIDY1IDMwIEwgNTcgMTciLz4KPHBhdGggZD0iTSA4MyAyNSBMIDgwIDExIi8+PC9nPgo8cGF0aCBkPSJNIDEwNy4xMyA0Ni45NyBDIDEwMS4zOCA1MS4zNCA4Ni4wMiA2NS40NiA3OS4wOCA3My41MyBDIDcyLjE1IDgxLjYxIDU4LjI5IDEwMC4yOSA1Mi4zNyAxMTAuNzMgQyA0Ni40NSAxMjEuMTYgMzUuMDQgMTQ4LjY1IDMyLjM0IDE1NS44OSBDIDI5LjYzIDE2My4xMiAzMC40OSAxNjQuMTQgMzEuMDAgMTY3Ljg0IEMgMzEuNTEgMTcxLjU0IDM0LjgyIDE4MS45MSAzNi4zNCAxODUuMTEgQyAzNy44NyAxODguMzAgNDAuMTQgMTkwLjg5IDQzLjAyIDE5My4wOCBDIDQ1LjkwIDE5NS4yNiA1MS45NCAyMDAuMTkgNTkuMDUgMjAyLjM3IEMgNjYuMTUgMjA0LjU2IDg0Ljc0IDIwOS4zMyA5OS4xMiAyMTAuMzQgQyAxMTMuNTAgMjExLjM1IDE2MS4wNyAyMTAuNjggMTcyLjU4IDIxMC4zNCBDIDE4NC4wOCAyMTAuMDEgMTg1LjU0IDIwOC44NiAxODkuOTQgMjA3LjY5IEMgMTk0LjM0IDIwNi41MSAyMDMuOTIgMjAyLjkwIDIwNy4zMCAyMDEuMDUgQyAyMTAuNjggMTk5LjIwIDIxNC42MiAxOTUuNjAgMjE2LjY1IDE5My4wOCBDIDIxOC42OCAxOTAuNTUgMjIyLjMxIDE4NS44MyAyMjMuMzMgMTgxLjEyIEMgMjI0LjM0IDE3Ni40MSAyMjUuODUgMTYyLjk1IDIyNC42NiAxNTUuODkgQyAyMjMuNDggMTQ4LjgyIDIxOC4wNCAxMzQuNDIgMjEzLjk4IDEyNS4zNCBDIDIwOS45MiAxMTYuMjUgMTk3LjAxIDkxLjczIDE5Mi42MSA4NC4xNiBDIDE4OC4yMSA3Ni41OSAxODIuODEgNjkuNzcgMTc5LjI1IDY1LjU2IEMgMTc1LjcwIDYxLjM2IDE2OC43OSA1NC4xNSAxNjQuNTYgNTAuOTUgQyAxNjAuMzMgNDcuNzYgMTUwLjk0IDQxLjg0IDE0NS44NiA0MC4zMyBDIDE0MC43OSAzOC44MSAxMjkuNDAgMzguMTYgMTI0LjQ5IDM5LjAwIEMgMTE5LjU5IDM5Ljg0IDExMi44OCA0Mi42MCAxMDcuMTMgNDYuOTcgWiIgZmlsbD0idXJsKCNncmFkaWVudC1rbm93bGVkZ2VfbWFuYWdlcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSIxMDAiIGN5PSIxMDgiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMzQiIGN5PSIxMDgiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTUxIDE0Nykgc2NhbGUoMS4xKSI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjUuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjUgMTIgQzE3IDcgMTEgNyA1IDExIFY0MCBDMTQgMzYgMTkgMzkgMjUgNDQgQzMxIDM5IDM2IDM2IDQ1IDQwIFYxMSBDMzkgNyAzMyA3IDI1IDEyIFoiLz48cGF0aCBkPSJNMjUgMTIgVjQ0Ii8+PC9nPjwvZz4KPC9zdmc+Cg==', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLWtub3dsZWRnZV9tYW5hZ2VyIj4KPHRpdGxlIGlkPSJ0aXRsZS1rbm93bGVkZ2VfbWFuYWdlciI+S25vd2xlZGdlIE1hbmFnZXIg4oCUIENvbnNlcnZlIGV0IGRpZmZ1c2U8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LWtub3dsZWRnZV9tYW5hZ2VyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQzY5OEZCIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiNBNTcyRjMiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM4RjVERTUiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSAxMDcuMTMgNDYuOTcgQyAxMDEuMzggNTEuMzQgODYuMDIgNjUuNDYgNzkuMDggNzMuNTMgQyA3Mi4xNSA4MS42MSA1OC4yOSAxMDAuMjkgNTIuMzcgMTEwLjczIEMgNDYuNDUgMTIxLjE2IDM1LjA0IDE0OC42NSAzMi4zNCAxNTUuODkgQyAyOS42MyAxNjMuMTIgMzAuNDkgMTY0LjE0IDMxLjAwIDE2Ny44NCBDIDMxLjUxIDE3MS41NCAzNC44MiAxODEuOTEgMzYuMzQgMTg1LjExIEMgMzcuODcgMTg4LjMwIDQwLjE0IDE5MC44OSA0My4wMiAxOTMuMDggQyA0NS45MCAxOTUuMjYgNTEuOTQgMjAwLjE5IDU5LjA1IDIwMi4zNyBDIDY2LjE1IDIwNC41NiA4NC43NCAyMDkuMzMgOTkuMTIgMjEwLjM0IEMgMTEzLjUwIDIxMS4zNSAxNjEuMDcgMjEwLjY4IDE3Mi41OCAyMTAuMzQgQyAxODQuMDggMjEwLjAxIDE4NS41NCAyMDguODYgMTg5Ljk0IDIwNy42OSBDIDE5NC4zNCAyMDYuNTEgMjAzLjkyIDIwMi45MCAyMDcuMzAgMjAxLjA1IEMgMjEwLjY4IDE5OS4yMCAyMTQuNjIgMTk1LjYwIDIxNi42NSAxOTMuMDggQyAyMTguNjggMTkwLjU1IDIyMi4zMSAxODUuODMgMjIzLjMzIDE4MS4xMiBDIDIyNC4zNCAxNzYuNDEgMjI1Ljg1IDE2Mi45NSAyMjQuNjYgMTU1Ljg5IEMgMjIzLjQ4IDE0OC44MiAyMTguMDQgMTM0LjQyIDIxMy45OCAxMjUuMzQgQyAyMDkuOTIgMTE2LjI1IDE5Ny4wMSA5MS43MyAxOTIuNjEgODQuMTYgQyAxODguMjEgNzYuNTkgMTgyLjgxIDY5Ljc3IDE3OS4yNSA2NS41NiBDIDE3NS43MCA2MS4zNiAxNjguNzkgNTQuMTUgMTY0LjU2IDUwLjk1IEMgMTYwLjMzIDQ3Ljc2IDE1MC45NCA0MS44NCAxNDUuODYgNDAuMzMgQyAxNDAuNzkgMzguODEgMTI5LjQwIDM4LjE2IDEyNC40OSAzOS4wMCBDIDExOS41OSAzOS44NCAxMTIuODggNDIuNjAgMTA3LjEzIDQ2Ljk3IFoiIGZpbGw9InVybCgjZ3JhZGllbnQta25vd2xlZGdlX21hbmFnZXIpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iMTAwIiBjeT0iMTA4IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTM0IiBjeT0iMTA4IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE1MSAxNDcpIHNjYWxlKDEuMSkiPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI1LjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTI1IDEyIEMxNyA3IDExIDcgNSAxMSBWNDAgQzE0IDM2IDE5IDM5IDI1IDQ0IEMzMSAzOSAzNiAzNiA0NSA0MCBWMTEgQzM5IDcgMzMgNyAyNSAxMiBaIi8+PHBhdGggZD0iTTI1IDEyIFY0NCIvPjwvZz48L2c+Cjwvc3ZnPgo=' }),
  observer: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLW9ic2VydmVyIj4KPHRpdGxlIGlkPSJ0aXRsZS1vYnNlcnZlciI+T2JzZXJ2ZXIg4oCUIFN1cnZlaWxsZSBldCBhbGVydGU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LW9ic2VydmVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjN0VCMERGIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM1RjkyQzciLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM0RjdFQjAiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iIzVGOTJDNyIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiM1RjkyQzciIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gMTk2IDQ2IEwgMjA0IDI0Ii8+CjxwYXRoIGQ9Ik0gMjEwIDU0IEwgMjI1IDQ1Ii8+CjxwYXRoIGQ9Ik0gMjIwIDY2IEwgMjM2IDYwIi8+PC9nPgo8cGF0aCBkPSJNIDYxLjMzIDU5LjAwIEMgNTcuNDUgNjEuMDMgNTYuMzYgNjMuMTMgNTQuNjcgNjUuNjcgQyA1Mi45OCA2OC4yMCA0OS4zNSA3My4wOSA0OC4wMCA3OS4wMCBDIDQ2LjY1IDg0LjkxIDQ0LjM0IDEwMS4zNiA0NC4wMCAxMTIuMzMgQyA0My42NiAxMjMuMzEgNDQuMTUgMTU1Ljg3IDQ1LjMzIDE2NS42NyBDIDQ2LjUyIDE3NS40NiA1MC40NiAxODUuMTEgNTMuMzMgMTg5LjY3IEMgNTYuMjAgMTk0LjIzIDYyLjI2IDE5OS4zMCA2OC4wMCAyMDEuNjcgQyA3My43NCAyMDQuMDMgODUuODMgMjA3LjMyIDk4LjY3IDIwOC4zMyBDIDExMS41MCAyMDkuMzUgMTU4LjM2IDIwOS44NCAxNjkuMzMgMjA5LjY3IEMgMTgwLjMxIDIwOS41MCAxODEuOTYgMjA4LjAxIDE4NS4zMyAyMDcuMDAgQyAxODguNzEgMjA1Ljk5IDE5My4zMCAyMDQuMjAgMTk2LjAwIDIwMS42NyBDIDE5OC43MCAxOTkuMTMgMjA0LjgxIDE5MS41NiAyMDYuNjcgMTg3LjAwIEMgMjA4LjUyIDE4Mi40NCAyMTAuNTAgMTc3LjgzIDIxMC42NyAxNjUuNjcgQyAyMTAuODQgMTUzLjUxIDIwOS4zNSAxMDMuMzMgMjA4LjAwIDkxLjAwIEMgMjA2LjY1IDc4LjY3IDIwMy4wNCA3Mi44OSAyMDAuMDAgNjguMzMgQyAxOTYuOTYgNjMuNzcgMTkwLjA4IDU3LjUzIDE4NC4wMCA1NS4wMCBDIDE3Ny45MiA1Mi40NyAxNTkuMjYgNDkuMzUgMTUyLjAwIDQ4LjMzIEMgMTQ0Ljc0IDQ3LjMyIDEzNS4xMSA0Ni44MyAxMjYuNjcgNDcuMDAgQyAxMTguMjIgNDcuMTcgOTMuNjEgNDguMTUgODUuMzMgNDkuNjcgQyA3Ny4wNiA1MS4xOSA2NS4yMiA1Ni45NyA2MS4zMyA1OS4wMCBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LW9ic2VydmVyKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkyIiBjeT0iMTEwIiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTI3IiBjeT0iMTEwIiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0OCAxNDUpIHNjYWxlKDEuMDYpIj48cGF0aCBkPSJNNCAyNiBIMTQgTDIwIDExIEwyOSA0MCBMMzYgMjEgTDQxIDI2IEg0NyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjUuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9nPgo8L3N2Zz4K', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLW9ic2VydmVyIj4KPHRpdGxlIGlkPSJ0aXRsZS1vYnNlcnZlciI+T2JzZXJ2ZXIg4oCUIFN1cnZlaWxsZSBldCBhbGVydGU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LW9ic2VydmVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjN0VCMERGIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM1RjkyQzciLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM0RjdFQjAiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSA2MS4zMyA1OS4wMCBDIDU3LjQ1IDYxLjAzIDU2LjM2IDYzLjEzIDU0LjY3IDY1LjY3IEMgNTIuOTggNjguMjAgNDkuMzUgNzMuMDkgNDguMDAgNzkuMDAgQyA0Ni42NSA4NC45MSA0NC4zNCAxMDEuMzYgNDQuMDAgMTEyLjMzIEMgNDMuNjYgMTIzLjMxIDQ0LjE1IDE1NS44NyA0NS4zMyAxNjUuNjcgQyA0Ni41MiAxNzUuNDYgNTAuNDYgMTg1LjExIDUzLjMzIDE4OS42NyBDIDU2LjIwIDE5NC4yMyA2Mi4yNiAxOTkuMzAgNjguMDAgMjAxLjY3IEMgNzMuNzQgMjA0LjAzIDg1LjgzIDIwNy4zMiA5OC42NyAyMDguMzMgQyAxMTEuNTAgMjA5LjM1IDE1OC4zNiAyMDkuODQgMTY5LjMzIDIwOS42NyBDIDE4MC4zMSAyMDkuNTAgMTgxLjk2IDIwOC4wMSAxODUuMzMgMjA3LjAwIEMgMTg4LjcxIDIwNS45OSAxOTMuMzAgMjA0LjIwIDE5Ni4wMCAyMDEuNjcgQyAxOTguNzAgMTk5LjEzIDIwNC44MSAxOTEuNTYgMjA2LjY3IDE4Ny4wMCBDIDIwOC41MiAxODIuNDQgMjEwLjUwIDE3Ny44MyAyMTAuNjcgMTY1LjY3IEMgMjEwLjg0IDE1My41MSAyMDkuMzUgMTAzLjMzIDIwOC4wMCA5MS4wMCBDIDIwNi42NSA3OC42NyAyMDMuMDQgNzIuODkgMjAwLjAwIDY4LjMzIEMgMTk2Ljk2IDYzLjc3IDE5MC4wOCA1Ny41MyAxODQuMDAgNTUuMDAgQyAxNzcuOTIgNTIuNDcgMTU5LjI2IDQ5LjM1IDE1Mi4wMCA0OC4zMyBDIDE0NC43NCA0Ny4zMiAxMzUuMTEgNDYuODMgMTI2LjY3IDQ3LjAwIEMgMTE4LjIyIDQ3LjE3IDkzLjYxIDQ4LjE1IDg1LjMzIDQ5LjY3IEMgNzcuMDYgNTEuMTkgNjUuMjIgNTYuOTcgNjEuMzMgNTkuMDAgWiIgZmlsbD0idXJsKCNncmFkaWVudC1vYnNlcnZlcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MiIgY3k9IjExMCIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyNyIgY3k9IjExMCIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNDggMTQ1KSBzY2FsZSgxLjA2KSI+PHBhdGggZD0iTTQgMjYgSDE0IEwyMCAxMSBMMjkgNDAgTDM2IDIxIEw0MSAyNiBINDciIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI1LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvZz4KPC9zdmc+Cg==' }),
  optimizer: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLW9wdGltaXplciI+Cjx0aXRsZSBpZD0idGl0bGUtb3B0aW1pemVyIj5PcHRpbWl6ZXIg4oCUIEFtw6lsaW9yZSBldCBvcHRpbWlzZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtb3B0aW1pemVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTdFMDM5Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM4RUNGMTAiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM3REMwMDAiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iIzhFQ0YxMCIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiM4RUNGMTAiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gMjAwIDYwIEwgMjA5IDM3Ii8+CjxwYXRoIGQ9Ik0gMjE1IDY4IEwgMjI3IDU0Ii8+CjxwYXRoIGQ9Ik0gMjI2IDc3IEwgMjQxIDY4Ii8+PC9nPgo8cGF0aCBkPSJNIDI5LjAwIDE1MS41MyBDIDI4LjMyIDE1Ni42MSAyOC4zMSAxNjguNjYgMzAuMzMgMTc0LjI1IEMgMzIuMzYgMTc5LjgzIDQxLjc5IDE5Mi4wNyA0NS4wMCAxOTUuNjMgQyA0OC4yMSAxOTkuMTggNTIuMTIgMjAwLjc5IDU1LjY3IDIwMi4zMSBDIDU5LjIxIDIwMy44MyA2NS45MSAyMDYuNDcgNzMuMDAgMjA3LjY1IEMgODAuMDkgMjA4Ljg0IDEwMC4wMSAyMTEuMzMgMTExLjY3IDIxMS42NiBDIDEyMy4zMiAyMTIuMDAgMTU0LjM2IDIxMS42OCAxNjUuMDAgMjEwLjMzIEMgMTc1LjY0IDIwOC45NyAxODkuNDIgMjA0LjM2IDE5NS42NyAyMDAuOTcgQyAyMDEuOTIgMTk3LjU5IDIxMS4xMiAxODcuNjYgMjE0LjMzIDE4My42MCBDIDIxNy41NCAxNzkuNTQgMjE5LjgyIDE3Mi42MyAyMjEuMDAgMTY4LjkwIEMgMjIyLjE4IDE2NS4xOCAyMjQuMDAgMTU5LjI4IDIyMy42NyAxNTQuMjAgQyAyMjMuMzMgMTQ5LjEzIDIyMS4yMCAxMzQuNzQgMjE4LjMzIDEyOC44MSBDIDIxNS40NiAxMjIuODkgMjA0Ljg4IDExMC45OSAyMDEuMDAgMTA3LjQzIEMgMTk3LjEyIDEwMy44OCAxOTEuMjEgMTAxLjc3IDE4Ny42NyAxMDAuNzUgQyAxODQuMTIgOTkuNzQgMTc2LjM4IDEwMS45NSAxNzMuMDAgOTkuNDIgQyAxNjkuNjIgOTYuODggMTYzLjcwIDg0LjA5IDE2MS4wMCA4MC43MSBDIDE1OC4zMCA3Ny4zMiAxNTQuMzcgNzQuNTUgMTUxLjY3IDcyLjY5IEMgMTQ4Ljk2IDcwLjgzIDE0My4yMSA2Ny4zNiAxMzkuNjcgNjYuMDEgQyAxMzYuMTIgNjQuNjUgMTI4LjIzIDYyLjM0IDEyMy42NyA2Mi4wMCBDIDExOS4xMSA2MS42NiAxMDkuNDEgNjEuNDcgMTAzLjY3IDYzLjM0IEMgOTcuOTIgNjUuMjAgODMuNDAgNzIuMzAgNzguMzMgNzYuNzAgQyA3My4yNyA4MS4xMCA2Ni4wMyA5My4wMCA2My42NyA5OC4wOCBDIDYxLjMwIDEwMy4xNiA2MS44NiAxMTMuNTcgNTkuNjcgMTE2Ljc5IEMgNTcuNDcgMTIwLjAwIDQ5LjM3IDEyMS4yNyA0Ni4zMyAxMjMuNDcgQyA0My4yOSAxMjUuNjcgMzcuODYgMTMwLjYwIDM1LjY3IDEzNC4xNiBDIDMzLjQ3IDEzNy43MSAyOS42OCAxNDYuNDUgMjkuMDAgMTUxLjUzIFoiIGZpbGw9InVybCgjZ3JhZGllbnQtb3B0aW1pemVyKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkxIiBjeT0iMTI1IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTI3IiBjeT0iMTI1IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0NiAxNDQpIHNjYWxlKDEuMTQpIj48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNi40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik01IDM5IEwxOSAyNiAyNyAzMyA0NiAxMSIvPjxwYXRoIGQ9Ik0zNCAxMSBINDYgVjIzIi8+PC9nPjwvZz4KPC9zdmc+Cg==', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLW9wdGltaXplciI+Cjx0aXRsZSBpZD0idGl0bGUtb3B0aW1pemVyIj5PcHRpbWl6ZXIg4oCUIEFtw6lsaW9yZSBldCBvcHRpbWlzZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtb3B0aW1pemVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTdFMDM5Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM4RUNGMTAiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM3REMwMDAiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSAyOS4wMCAxNTEuNTMgQyAyOC4zMiAxNTYuNjEgMjguMzEgMTY4LjY2IDMwLjMzIDE3NC4yNSBDIDMyLjM2IDE3OS44MyA0MS43OSAxOTIuMDcgNDUuMDAgMTk1LjYzIEMgNDguMjEgMTk5LjE4IDUyLjEyIDIwMC43OSA1NS42NyAyMDIuMzEgQyA1OS4yMSAyMDMuODMgNjUuOTEgMjA2LjQ3IDczLjAwIDIwNy42NSBDIDgwLjA5IDIwOC44NCAxMDAuMDEgMjExLjMzIDExMS42NyAyMTEuNjYgQyAxMjMuMzIgMjEyLjAwIDE1NC4zNiAyMTEuNjggMTY1LjAwIDIxMC4zMyBDIDE3NS42NCAyMDguOTcgMTg5LjQyIDIwNC4zNiAxOTUuNjcgMjAwLjk3IEMgMjAxLjkyIDE5Ny41OSAyMTEuMTIgMTg3LjY2IDIxNC4zMyAxODMuNjAgQyAyMTcuNTQgMTc5LjU0IDIxOS44MiAxNzIuNjMgMjIxLjAwIDE2OC45MCBDIDIyMi4xOCAxNjUuMTggMjI0LjAwIDE1OS4yOCAyMjMuNjcgMTU0LjIwIEMgMjIzLjMzIDE0OS4xMyAyMjEuMjAgMTM0Ljc0IDIxOC4zMyAxMjguODEgQyAyMTUuNDYgMTIyLjg5IDIwNC44OCAxMTAuOTkgMjAxLjAwIDEwNy40MyBDIDE5Ny4xMiAxMDMuODggMTkxLjIxIDEwMS43NyAxODcuNjcgMTAwLjc1IEMgMTg0LjEyIDk5Ljc0IDE3Ni4zOCAxMDEuOTUgMTczLjAwIDk5LjQyIEMgMTY5LjYyIDk2Ljg4IDE2My43MCA4NC4wOSAxNjEuMDAgODAuNzEgQyAxNTguMzAgNzcuMzIgMTU0LjM3IDc0LjU1IDE1MS42NyA3Mi42OSBDIDE0OC45NiA3MC44MyAxNDMuMjEgNjcuMzYgMTM5LjY3IDY2LjAxIEMgMTM2LjEyIDY0LjY1IDEyOC4yMyA2Mi4zNCAxMjMuNjcgNjIuMDAgQyAxMTkuMTEgNjEuNjYgMTA5LjQxIDYxLjQ3IDEwMy42NyA2My4zNCBDIDk3LjkyIDY1LjIwIDgzLjQwIDcyLjMwIDc4LjMzIDc2LjcwIEMgNzMuMjcgODEuMTAgNjYuMDMgOTMuMDAgNjMuNjcgOTguMDggQyA2MS4zMCAxMDMuMTYgNjEuODYgMTEzLjU3IDU5LjY3IDExNi43OSBDIDU3LjQ3IDEyMC4wMCA0OS4zNyAxMjEuMjcgNDYuMzMgMTIzLjQ3IEMgNDMuMjkgMTI1LjY3IDM3Ljg2IDEzMC42MCAzNS42NyAxMzQuMTYgQyAzMy40NyAxMzcuNzEgMjkuNjggMTQ2LjQ1IDI5LjAwIDE1MS41MyBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LW9wdGltaXplcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MSIgY3k9IjEyNSIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyNyIgY3k9IjEyNSIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNDYgMTQ0KSBzY2FsZSgxLjE0KSI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNSAzOSBMMTkgMjYgMjcgMzMgNDYgMTEiLz48cGF0aCBkPSJNMzQgMTEgSDQ2IFYyMyIvPjwvZz48L2c+Cjwvc3ZnPgo=' }),
  orchestrator: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLW9yY2hlc3RyYXRvciI+Cjx0aXRsZSBpZD0idGl0bGUtb3JjaGVzdHJhdG9yIj5PcmNoZXN0cmF0b3Ig4oCUIENvb3Jkb25uZSBldCBwaWxvdGU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LW9yY2hlc3RyYXRvciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0I0N0NGQSIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjOEQ1NUVBIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjNzY0M0Q3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxlbGxpcHNlIGN4PSIxMjgiIGN5PSIyMzAiIHJ4PSI4MSIgcnk9IjkiIGZpbGw9IiM4RDU1RUEiIG9wYWNpdHk9IjAuMTYiLz4KPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjOEQ1NUVBIiBzdHJva2Utd2lkdGg9IjkuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48cGF0aCBkPSJNIDUzIDQzIEwgNDEgMzQiLz4KPHBhdGggZD0iTSA2NSAzMCBMIDU3IDE3Ii8+CjxwYXRoIGQ9Ik0gODMgMjUgTCA4MCAxMSIvPjwvZz4KPHBhdGggZD0iTSAxMDcuMTMgNDYuOTcgQyAxMDEuMzggNTEuMzQgODYuMDIgNjUuNDYgNzkuMDggNzMuNTMgQyA3Mi4xNSA4MS42MSA1OC4yOSAxMDAuMjkgNTIuMzcgMTEwLjczIEMgNDYuNDUgMTIxLjE2IDM1LjA0IDE0OC42NSAzMi4zNCAxNTUuODkgQyAyOS42MyAxNjMuMTIgMzAuNDkgMTY0LjE0IDMxLjAwIDE2Ny44NCBDIDMxLjUxIDE3MS41NCAzNC44MiAxODEuOTEgMzYuMzQgMTg1LjExIEMgMzcuODcgMTg4LjMwIDQwLjE0IDE5MC44OSA0My4wMiAxOTMuMDggQyA0NS45MCAxOTUuMjYgNTEuOTQgMjAwLjE5IDU5LjA1IDIwMi4zNyBDIDY2LjE1IDIwNC41NiA4NC43NCAyMDkuMzMgOTkuMTIgMjEwLjM0IEMgMTEzLjUwIDIxMS4zNSAxNjEuMDcgMjEwLjY4IDE3Mi41OCAyMTAuMzQgQyAxODQuMDggMjEwLjAxIDE4NS41NCAyMDguODYgMTg5Ljk0IDIwNy42OSBDIDE5NC4zNCAyMDYuNTEgMjAzLjkyIDIwMi45MCAyMDcuMzAgMjAxLjA1IEMgMjEwLjY4IDE5OS4yMCAyMTQuNjIgMTk1LjYwIDIxNi42NSAxOTMuMDggQyAyMTguNjggMTkwLjU1IDIyMi4zMSAxODUuODMgMjIzLjMzIDE4MS4xMiBDIDIyNC4zNCAxNzYuNDEgMjI1Ljg1IDE2Mi45NSAyMjQuNjYgMTU1Ljg5IEMgMjIzLjQ4IDE0OC44MiAyMTguMDQgMTM0LjQyIDIxMy45OCAxMjUuMzQgQyAyMDkuOTIgMTE2LjI1IDE5Ny4wMSA5MS43MyAxOTIuNjEgODQuMTYgQyAxODguMjEgNzYuNTkgMTgyLjgxIDY5Ljc3IDE3OS4yNSA2NS41NiBDIDE3NS43MCA2MS4zNiAxNjguNzkgNTQuMTUgMTY0LjU2IDUwLjk1IEMgMTYwLjMzIDQ3Ljc2IDE1MC45NCA0MS44NCAxNDUuODYgNDAuMzMgQyAxNDAuNzkgMzguODEgMTI5LjQwIDM4LjE2IDEyNC40OSAzOS4wMCBDIDExOS41OSAzOS44NCAxMTIuODggNDIuNjAgMTA3LjEzIDQ2Ljk3IFoiIGZpbGw9InVybCgjZ3JhZGllbnQtb3JjaGVzdHJhdG9yKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjEwMCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEzNCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNTEgMTQ3KSBzY2FsZSgxLjEpIj48ZyBzdHJva2U9IiNmZmYiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yNSAxMSBWMjcgTTI1IDI3IEg4IFYzNiBNMjUgMjcgSDQyIFYzNiIvPjwvZz48ZyBmaWxsPSIjZmZmIj48Y2lyY2xlIGN4PSIyNSIgY3k9IjgiIHI9IjcuNCIvPjxjaXJjbGUgY3g9IjgiIGN5PSI0MSIgcj0iNy40Ii8+PGNpcmNsZSBjeD0iNDIiIGN5PSI0MSIgcj0iNy40Ii8+PC9nPjwvZz4KPC9zdmc+Cg==', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLW9yY2hlc3RyYXRvciI+Cjx0aXRsZSBpZD0idGl0bGUtb3JjaGVzdHJhdG9yIj5PcmNoZXN0cmF0b3Ig4oCUIENvb3Jkb25uZSBldCBwaWxvdGU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LW9yY2hlc3RyYXRvciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0I0N0NGQSIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjOEQ1NUVBIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjNzY0M0Q3Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxwYXRoIGQ9Ik0gMTA3LjEzIDQ2Ljk3IEMgMTAxLjM4IDUxLjM0IDg2LjAyIDY1LjQ2IDc5LjA4IDczLjUzIEMgNzIuMTUgODEuNjEgNTguMjkgMTAwLjI5IDUyLjM3IDExMC43MyBDIDQ2LjQ1IDEyMS4xNiAzNS4wNCAxNDguNjUgMzIuMzQgMTU1Ljg5IEMgMjkuNjMgMTYzLjEyIDMwLjQ5IDE2NC4xNCAzMS4wMCAxNjcuODQgQyAzMS41MSAxNzEuNTQgMzQuODIgMTgxLjkxIDM2LjM0IDE4NS4xMSBDIDM3Ljg3IDE4OC4zMCA0MC4xNCAxOTAuODkgNDMuMDIgMTkzLjA4IEMgNDUuOTAgMTk1LjI2IDUxLjk0IDIwMC4xOSA1OS4wNSAyMDIuMzcgQyA2Ni4xNSAyMDQuNTYgODQuNzQgMjA5LjMzIDk5LjEyIDIxMC4zNCBDIDExMy41MCAyMTEuMzUgMTYxLjA3IDIxMC42OCAxNzIuNTggMjEwLjM0IEMgMTg0LjA4IDIxMC4wMSAxODUuNTQgMjA4Ljg2IDE4OS45NCAyMDcuNjkgQyAxOTQuMzQgMjA2LjUxIDIwMy45MiAyMDIuOTAgMjA3LjMwIDIwMS4wNSBDIDIxMC42OCAxOTkuMjAgMjE0LjYyIDE5NS42MCAyMTYuNjUgMTkzLjA4IEMgMjE4LjY4IDE5MC41NSAyMjIuMzEgMTg1LjgzIDIyMy4zMyAxODEuMTIgQyAyMjQuMzQgMTc2LjQxIDIyNS44NSAxNjIuOTUgMjI0LjY2IDE1NS44OSBDIDIyMy40OCAxNDguODIgMjE4LjA0IDEzNC40MiAyMTMuOTggMTI1LjM0IEMgMjA5LjkyIDExNi4yNSAxOTcuMDEgOTEuNzMgMTkyLjYxIDg0LjE2IEMgMTg4LjIxIDc2LjU5IDE4Mi44MSA2OS43NyAxNzkuMjUgNjUuNTYgQyAxNzUuNzAgNjEuMzYgMTY4Ljc5IDU0LjE1IDE2NC41NiA1MC45NSBDIDE2MC4zMyA0Ny43NiAxNTAuOTQgNDEuODQgMTQ1Ljg2IDQwLjMzIEMgMTQwLjc5IDM4LjgxIDEyOS40MCAzOC4xNiAxMjQuNDkgMzkuMDAgQyAxMTkuNTkgMzkuODQgMTEyLjg4IDQyLjYwIDEwNy4xMyA0Ni45NyBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LW9yY2hlc3RyYXRvcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSIxMDAiIGN5PSIxMDgiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMzQiIGN5PSIxMDgiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTUxIDE0Nykgc2NhbGUoMS4xKSI+PGcgc3Ryb2tlPSIjZmZmIiBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjUuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjUgMTEgVjI3IE0yNSAyNyBIOCBWMzYgTTI1IDI3IEg0MiBWMzYiLz48L2c+PGcgZmlsbD0iI2ZmZiI+PGNpcmNsZSBjeD0iMjUiIGN5PSI4IiByPSI3LjQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iNDEiIHI9IjcuNCIvPjxjaXJjbGUgY3g9IjQyIiBjeT0iNDEiIHI9IjcuNCIvPjwvZz48L2c+Cjwvc3ZnPgo=' }),
  planner: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXBsYW5uZXIiPgo8dGl0bGUgaWQ9InRpdGxlLXBsYW5uZXIiPlBsYW5uZXIg4oCUIFBsYW5pZmllIGV0IG9yZ2FuaXNlPC90aXRsZT4KPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJncmFkaWVudC1wbGFubmVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjM0NCMkZEIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiMyMjhGRkQiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwRjc5RjMiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iIzIyOEZGRCIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiMyMjhGRkQiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gMTk2IDQ2IEwgMjA0IDI0Ii8+CjxwYXRoIGQ9Ik0gMjEwIDU0IEwgMjI1IDQ1Ii8+CjxwYXRoIGQ9Ik0gMjIwIDY2IEwgMjM2IDYwIi8+PC9nPgo8cGF0aCBkPSJNIDYxLjMzIDU5LjAwIEMgNTcuNDUgNjEuMDMgNTYuMzYgNjMuMTMgNTQuNjcgNjUuNjcgQyA1Mi45OCA2OC4yMCA0OS4zNSA3My4wOSA0OC4wMCA3OS4wMCBDIDQ2LjY1IDg0LjkxIDQ0LjM0IDEwMS4zNiA0NC4wMCAxMTIuMzMgQyA0My42NiAxMjMuMzEgNDQuMTUgMTU1Ljg3IDQ1LjMzIDE2NS42NyBDIDQ2LjUyIDE3NS40NiA1MC40NiAxODUuMTEgNTMuMzMgMTg5LjY3IEMgNTYuMjAgMTk0LjIzIDYyLjI2IDE5OS4zMCA2OC4wMCAyMDEuNjcgQyA3My43NCAyMDQuMDMgODUuODMgMjA3LjMyIDk4LjY3IDIwOC4zMyBDIDExMS41MCAyMDkuMzUgMTU4LjM2IDIwOS44NCAxNjkuMzMgMjA5LjY3IEMgMTgwLjMxIDIwOS41MCAxODEuOTYgMjA4LjAxIDE4NS4zMyAyMDcuMDAgQyAxODguNzEgMjA1Ljk5IDE5My4zMCAyMDQuMjAgMTk2LjAwIDIwMS42NyBDIDE5OC43MCAxOTkuMTMgMjA0LjgxIDE5MS41NiAyMDYuNjcgMTg3LjAwIEMgMjA4LjUyIDE4Mi40NCAyMTAuNTAgMTc3LjgzIDIxMC42NyAxNjUuNjcgQyAyMTAuODQgMTUzLjUxIDIwOS4zNSAxMDMuMzMgMjA4LjAwIDkxLjAwIEMgMjA2LjY1IDc4LjY3IDIwMy4wNCA3Mi44OSAyMDAuMDAgNjguMzMgQyAxOTYuOTYgNjMuNzcgMTkwLjA4IDU3LjUzIDE4NC4wMCA1NS4wMCBDIDE3Ny45MiA1Mi40NyAxNTkuMjYgNDkuMzUgMTUyLjAwIDQ4LjMzIEMgMTQ0Ljc0IDQ3LjMyIDEzNS4xMSA0Ni44MyAxMjYuNjcgNDcuMDAgQyAxMTguMjIgNDcuMTcgOTMuNjEgNDguMTUgODUuMzMgNDkuNjcgQyA3Ny4wNiA1MS4xOSA2NS4yMiA1Ni45NyA2MS4zMyA1OS4wMCBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LXBsYW5uZXIpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTIiIGN5PSIxMTAiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMjciIGN5PSIxMTAiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTQ4IDE0NSkgc2NhbGUoMS4wNikiPjxnIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI3LjEiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTTYgMTEgSDQ0IE02IDI1IEg0NCBNNiAzOSBINDQiLz48L2c+PC9nPgo8L3N2Zz4K', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXBsYW5uZXIiPgo8dGl0bGUgaWQ9InRpdGxlLXBsYW5uZXIiPlBsYW5uZXIg4oCUIFBsYW5pZmllIGV0IG9yZ2FuaXNlPC90aXRsZT4KPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJncmFkaWVudC1wbGFubmVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjM0NCMkZEIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiMyMjhGRkQiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwRjc5RjMiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSA2MS4zMyA1OS4wMCBDIDU3LjQ1IDYxLjAzIDU2LjM2IDYzLjEzIDU0LjY3IDY1LjY3IEMgNTIuOTggNjguMjAgNDkuMzUgNzMuMDkgNDguMDAgNzkuMDAgQyA0Ni42NSA4NC45MSA0NC4zNCAxMDEuMzYgNDQuMDAgMTEyLjMzIEMgNDMuNjYgMTIzLjMxIDQ0LjE1IDE1NS44NyA0NS4zMyAxNjUuNjcgQyA0Ni41MiAxNzUuNDYgNTAuNDYgMTg1LjExIDUzLjMzIDE4OS42NyBDIDU2LjIwIDE5NC4yMyA2Mi4yNiAxOTkuMzAgNjguMDAgMjAxLjY3IEMgNzMuNzQgMjA0LjAzIDg1LjgzIDIwNy4zMiA5OC42NyAyMDguMzMgQyAxMTEuNTAgMjA5LjM1IDE1OC4zNiAyMDkuODQgMTY5LjMzIDIwOS42NyBDIDE4MC4zMSAyMDkuNTAgMTgxLjk2IDIwOC4wMSAxODUuMzMgMjA3LjAwIEMgMTg4LjcxIDIwNS45OSAxOTMuMzAgMjA0LjIwIDE5Ni4wMCAyMDEuNjcgQyAxOTguNzAgMTk5LjEzIDIwNC44MSAxOTEuNTYgMjA2LjY3IDE4Ny4wMCBDIDIwOC41MiAxODIuNDQgMjEwLjUwIDE3Ny44MyAyMTAuNjcgMTY1LjY3IEMgMjEwLjg0IDE1My41MSAyMDkuMzUgMTAzLjMzIDIwOC4wMCA5MS4wMCBDIDIwNi42NSA3OC42NyAyMDMuMDQgNzIuODkgMjAwLjAwIDY4LjMzIEMgMTk2Ljk2IDYzLjc3IDE5MC4wOCA1Ny41MyAxODQuMDAgNTUuMDAgQyAxNzcuOTIgNTIuNDcgMTU5LjI2IDQ5LjM1IDE1Mi4wMCA0OC4zMyBDIDE0NC43NCA0Ny4zMiAxMzUuMTEgNDYuODMgMTI2LjY3IDQ3LjAwIEMgMTE4LjIyIDQ3LjE3IDkzLjYxIDQ4LjE1IDg1LjMzIDQ5LjY3IEMgNzcuMDYgNTEuMTkgNjUuMjIgNTYuOTcgNjEuMzMgNTkuMDAgWiIgZmlsbD0idXJsKCNncmFkaWVudC1wbGFubmVyKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkyIiBjeT0iMTEwIiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTI3IiBjeT0iMTEwIiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0OCAxNDUpIHNjYWxlKDEuMDYpIj48ZyBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNy4xIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik02IDExIEg0NCBNNiAyNSBINDQgTTYgMzkgSDQ0Ii8+PC9nPjwvZz4KPC9zdmc+Cg==' }),
  researcher: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXJlc2VhcmNoZXIiPgo8dGl0bGUgaWQ9InRpdGxlLXJlc2VhcmNoZXIiPlJlc2VhcmNoZXIg4oCUIEV4cGxvcmUgZXQgcmVjaGVyY2hlPC90aXRsZT4KPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJncmFkaWVudC1yZXNlYXJjaGVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNEVFMEMxIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiMyNUM1QTYiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwRUFGOEUiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iIzI1QzVBNiIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiMyNUM1QTYiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gMjAwIDYwIEwgMjA5IDM3Ii8+CjxwYXRoIGQ9Ik0gMjE1IDY4IEwgMjI3IDU0Ii8+CjxwYXRoIGQ9Ik0gMjI2IDc3IEwgMjQxIDY4Ii8+PC9nPgo8cGF0aCBkPSJNIDI5LjAwIDE1MS41MyBDIDI4LjMyIDE1Ni42MSAyOC4zMSAxNjguNjYgMzAuMzMgMTc0LjI1IEMgMzIuMzYgMTc5LjgzIDQxLjc5IDE5Mi4wNyA0NS4wMCAxOTUuNjMgQyA0OC4yMSAxOTkuMTggNTIuMTIgMjAwLjc5IDU1LjY3IDIwMi4zMSBDIDU5LjIxIDIwMy44MyA2NS45MSAyMDYuNDcgNzMuMDAgMjA3LjY1IEMgODAuMDkgMjA4Ljg0IDEwMC4wMSAyMTEuMzMgMTExLjY3IDIxMS42NiBDIDEyMy4zMiAyMTIuMDAgMTU0LjM2IDIxMS42OCAxNjUuMDAgMjEwLjMzIEMgMTc1LjY0IDIwOC45NyAxODkuNDIgMjA0LjM2IDE5NS42NyAyMDAuOTcgQyAyMDEuOTIgMTk3LjU5IDIxMS4xMiAxODcuNjYgMjE0LjMzIDE4My42MCBDIDIxNy41NCAxNzkuNTQgMjE5LjgyIDE3Mi42MyAyMjEuMDAgMTY4LjkwIEMgMjIyLjE4IDE2NS4xOCAyMjQuMDAgMTU5LjI4IDIyMy42NyAxNTQuMjAgQyAyMjMuMzMgMTQ5LjEzIDIyMS4yMCAxMzQuNzQgMjE4LjMzIDEyOC44MSBDIDIxNS40NiAxMjIuODkgMjA0Ljg4IDExMC45OSAyMDEuMDAgMTA3LjQzIEMgMTk3LjEyIDEwMy44OCAxOTEuMjEgMTAxLjc3IDE4Ny42NyAxMDAuNzUgQyAxODQuMTIgOTkuNzQgMTc2LjM4IDEwMS45NSAxNzMuMDAgOTkuNDIgQyAxNjkuNjIgOTYuODggMTYzLjcwIDg0LjA5IDE2MS4wMCA4MC43MSBDIDE1OC4zMCA3Ny4zMiAxNTQuMzcgNzQuNTUgMTUxLjY3IDcyLjY5IEMgMTQ4Ljk2IDcwLjgzIDE0My4yMSA2Ny4zNiAxMzkuNjcgNjYuMDEgQyAxMzYuMTIgNjQuNjUgMTI4LjIzIDYyLjM0IDEyMy42NyA2Mi4wMCBDIDExOS4xMSA2MS42NiAxMDkuNDEgNjEuNDcgMTAzLjY3IDYzLjM0IEMgOTcuOTIgNjUuMjAgODMuNDAgNzIuMzAgNzguMzMgNzYuNzAgQyA3My4yNyA4MS4xMCA2Ni4wMyA5My4wMCA2My42NyA5OC4wOCBDIDYxLjMwIDEwMy4xNiA2MS44NiAxMTMuNTcgNTkuNjcgMTE2Ljc5IEMgNTcuNDcgMTIwLjAwIDQ5LjM3IDEyMS4yNyA0Ni4zMyAxMjMuNDcgQyA0My4yOSAxMjUuNjcgMzcuODYgMTMwLjYwIDM1LjY3IDEzNC4xNiBDIDMzLjQ3IDEzNy43MSAyOS42OCAxNDYuNDUgMjkuMDAgMTUxLjUzIFoiIGZpbGw9InVybCgjZ3JhZGllbnQtcmVzZWFyY2hlcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MSIgY3k9IjEyNSIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyNyIgY3k9IjEyNSIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNDYgMTQ0KSBzY2FsZSgxLjE0KSI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYuNyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxNCIvPjxwYXRoIGQ9Ik0zMSAzMSBMNDYgNDYiLz48L2c+PC9nPgo8L3N2Zz4K', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXJlc2VhcmNoZXIiPgo8dGl0bGUgaWQ9InRpdGxlLXJlc2VhcmNoZXIiPlJlc2VhcmNoZXIg4oCUIEV4cGxvcmUgZXQgcmVjaGVyY2hlPC90aXRsZT4KPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJncmFkaWVudC1yZXNlYXJjaGVyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNEVFMEMxIi8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiMyNUM1QTYiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwRUFGOEUiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSAyOS4wMCAxNTEuNTMgQyAyOC4zMiAxNTYuNjEgMjguMzEgMTY4LjY2IDMwLjMzIDE3NC4yNSBDIDMyLjM2IDE3OS44MyA0MS43OSAxOTIuMDcgNDUuMDAgMTk1LjYzIEMgNDguMjEgMTk5LjE4IDUyLjEyIDIwMC43OSA1NS42NyAyMDIuMzEgQyA1OS4yMSAyMDMuODMgNjUuOTEgMjA2LjQ3IDczLjAwIDIwNy42NSBDIDgwLjA5IDIwOC44NCAxMDAuMDEgMjExLjMzIDExMS42NyAyMTEuNjYgQyAxMjMuMzIgMjEyLjAwIDE1NC4zNiAyMTEuNjggMTY1LjAwIDIxMC4zMyBDIDE3NS42NCAyMDguOTcgMTg5LjQyIDIwNC4zNiAxOTUuNjcgMjAwLjk3IEMgMjAxLjkyIDE5Ny41OSAyMTEuMTIgMTg3LjY2IDIxNC4zMyAxODMuNjAgQyAyMTcuNTQgMTc5LjU0IDIxOS44MiAxNzIuNjMgMjIxLjAwIDE2OC45MCBDIDIyMi4xOCAxNjUuMTggMjI0LjAwIDE1OS4yOCAyMjMuNjcgMTU0LjIwIEMgMjIzLjMzIDE0OS4xMyAyMjEuMjAgMTM0Ljc0IDIxOC4zMyAxMjguODEgQyAyMTUuNDYgMTIyLjg5IDIwNC44OCAxMTAuOTkgMjAxLjAwIDEwNy40MyBDIDE5Ny4xMiAxMDMuODggMTkxLjIxIDEwMS43NyAxODcuNjcgMTAwLjc1IEMgMTg0LjEyIDk5Ljc0IDE3Ni4zOCAxMDEuOTUgMTczLjAwIDk5LjQyIEMgMTY5LjYyIDk2Ljg4IDE2My43MCA4NC4wOSAxNjEuMDAgODAuNzEgQyAxNTguMzAgNzcuMzIgMTU0LjM3IDc0LjU1IDE1MS42NyA3Mi42OSBDIDE0OC45NiA3MC44MyAxNDMuMjEgNjcuMzYgMTM5LjY3IDY2LjAxIEMgMTM2LjEyIDY0LjY1IDEyOC4yMyA2Mi4zNCAxMjMuNjcgNjIuMDAgQyAxMTkuMTEgNjEuNjYgMTA5LjQxIDYxLjQ3IDEwMy42NyA2My4zNCBDIDk3LjkyIDY1LjIwIDgzLjQwIDcyLjMwIDc4LjMzIDc2LjcwIEMgNzMuMjcgODEuMTAgNjYuMDMgOTMuMDAgNjMuNjcgOTguMDggQyA2MS4zMCAxMDMuMTYgNjEuODYgMTEzLjU3IDU5LjY3IDExNi43OSBDIDU3LjQ3IDEyMC4wMCA0OS4zNyAxMjEuMjcgNDYuMzMgMTIzLjQ3IEMgNDMuMjkgMTI1LjY3IDM3Ljg2IDEzMC42MCAzNS42NyAxMzQuMTYgQyAzMy40NyAxMzcuNzEgMjkuNjggMTQ2LjQ1IDI5LjAwIDE1MS41MyBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LXJlc2VhcmNoZXIpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTEiIGN5PSIxMjUiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMjciIGN5PSIxMjUiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTQ2IDE0NCkgc2NhbGUoMS4xNCkiPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI2LjciIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMTQiLz48cGF0aCBkPSJNMzEgMzEgTDQ2IDQ2Ii8+PC9nPjwvZz4KPC9zdmc+Cg==' }),
  reviewer: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXJldmlld2VyIj4KPHRpdGxlIGlkPSJ0aXRsZS1yZXZpZXdlciI+UmV2aWV3ZXIg4oCUIFJlbGl0IGV0IMOpdmFsdWU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LXJldmlld2VyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjRkVBODM4Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiNGQjg4MTkiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNFQzcwMDMiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iI0ZCODgxOSIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiNGQjg4MTkiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gMTk2IDQ5IEwgMjA1IDI5Ii8+CjxwYXRoIGQ9Ik0gMjEyIDU1IEwgMjI4IDQ3Ii8+PC9nPgo8cGF0aCBkPSJNIDEwOS42NCA0OC4zNSBDIDEwMS4zNyA1MC4wNiA4NS4yNSA1Ny4wNiA3OC4zNiA2MS44NSBDIDcxLjQ3IDY2LjYzIDU5LjU1IDc5LjY0IDU1LjI0IDg2LjE0IEMgNTAuOTMgOTIuNjMgNDUuNzQgMTA1LjI3IDQ0LjM2IDExMy4xMyBDIDQyLjk4IDEyMC45OSA0Mi44MSAxNDAuMTggNDQuMzYgMTQ4LjIyIEMgNDUuOTEgMTU2LjI1IDUyLjI5IDE3MC4yNCA1Ni42MCAxNzYuNTYgQyA2MC45MSAxODIuODkgNzEuODEgMTkzLjg4IDc4LjM2IDE5OC4xNSBDIDg0LjkxIDIwMi40MyA5OS42NyAyMDguNzYgMTA4LjI4IDIxMC4zMCBDIDExNi44OSAyMTEuODQgMTM5LjMwIDIxMC45OCAxNDYuMzYgMjEwLjMwIEMgMTUzLjQyIDIwOS42MiAxNTkuMjIgMjA3LjEyIDE2NC4wNCAyMDQuOTAgQyAxNjguODYgMjAyLjY4IDE3OS42MiAxOTcuMDMgMTg0LjQ0IDE5Mi43NiBDIDE4OS4yNiAxODguNDggMTk4LjY3IDE3Ny40OSAyMDIuMTIgMTcxLjE2IEMgMjA1LjU3IDE2NC44NCAyMTAuNjEgMTUwLjE3IDIxMS42NCAxNDIuODIgQyAyMTIuNjcgMTM1LjQ3IDIxMi41MiAxMjEuMTYgMjEwLjI4IDExMy4xMyBDIDIwOC4wNCAxMDUuMTAgMTk4Ljk2IDg2LjIzIDE5My45NiA3OS4zOSBDIDE4OC45NiA3Mi41NSAxNzcuMjEgNjMuMDggMTcwLjg0IDU5LjE1IEMgMTY0LjQ3IDU1LjIxIDE1MS4zOSA0OS43MiAxNDMuNjQgNDguMzUgQyAxMzUuODkgNDYuOTggMTE3LjkxIDQ2LjY0IDEwOS42NCA0OC4zNSBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LXJldmlld2VyKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkxIiBjeT0iMTA3IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTI4IiBjeT0iMTA3IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEzMiAxMzQpIHNjYWxlKDEuMDIpIj48ZyBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNi43IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjIwIiBjeT0iMjAiIHI9IjE0Ii8+PHBhdGggZD0iTTMxIDMxIEw0NiA0NiIvPjwvZz48L2c+Cjwvc3ZnPgo=', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXJldmlld2VyIj4KPHRpdGxlIGlkPSJ0aXRsZS1yZXZpZXdlciI+UmV2aWV3ZXIg4oCUIFJlbGl0IGV0IMOpdmFsdWU8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LXJldmlld2VyIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjRkVBODM4Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiNGQjg4MTkiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNFQzcwMDMiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSAxMDkuNjQgNDguMzUgQyAxMDEuMzcgNTAuMDYgODUuMjUgNTcuMDYgNzguMzYgNjEuODUgQyA3MS40NyA2Ni42MyA1OS41NSA3OS42NCA1NS4yNCA4Ni4xNCBDIDUwLjkzIDkyLjYzIDQ1Ljc0IDEwNS4yNyA0NC4zNiAxMTMuMTMgQyA0Mi45OCAxMjAuOTkgNDIuODEgMTQwLjE4IDQ0LjM2IDE0OC4yMiBDIDQ1LjkxIDE1Ni4yNSA1Mi4yOSAxNzAuMjQgNTYuNjAgMTc2LjU2IEMgNjAuOTEgMTgyLjg5IDcxLjgxIDE5My44OCA3OC4zNiAxOTguMTUgQyA4NC45MSAyMDIuNDMgOTkuNjcgMjA4Ljc2IDEwOC4yOCAyMTAuMzAgQyAxMTYuODkgMjExLjg0IDEzOS4zMCAyMTAuOTggMTQ2LjM2IDIxMC4zMCBDIDE1My40MiAyMDkuNjIgMTU5LjIyIDIwNy4xMiAxNjQuMDQgMjA0LjkwIEMgMTY4Ljg2IDIwMi42OCAxNzkuNjIgMTk3LjAzIDE4NC40NCAxOTIuNzYgQyAxODkuMjYgMTg4LjQ4IDE5OC42NyAxNzcuNDkgMjAyLjEyIDE3MS4xNiBDIDIwNS41NyAxNjQuODQgMjEwLjYxIDE1MC4xNyAyMTEuNjQgMTQyLjgyIEMgMjEyLjY3IDEzNS40NyAyMTIuNTIgMTIxLjE2IDIxMC4yOCAxMTMuMTMgQyAyMDguMDQgMTA1LjEwIDE5OC45NiA4Ni4yMyAxOTMuOTYgNzkuMzkgQyAxODguOTYgNzIuNTUgMTc3LjIxIDYzLjA4IDE3MC44NCA1OS4xNSBDIDE2NC40NyA1NS4yMSAxNTEuMzkgNDkuNzIgMTQzLjY0IDQ4LjM1IEMgMTM1Ljg5IDQ2Ljk4IDExNy45MSA0Ni42NCAxMDkuNjQgNDguMzUgWiIgZmlsbD0idXJsKCNncmFkaWVudC1yZXZpZXdlcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MSIgY3k9IjEwNyIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyOCIgY3k9IjEwNyIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMzIgMTM0KSBzY2FsZSgxLjAyKSI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYuNyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSIxNCIvPjxwYXRoIGQ9Ik0zMSAzMSBMNDYgNDYiLz48L2c+PC9nPgo8L3N2Zz4K' }),
  super_orchestrator: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXN1cGVyX29yY2hlc3RyYXRvciI+Cjx0aXRsZSBpZD0idGl0bGUtc3VwZXJfb3JjaGVzdHJhdG9yIj5TdXBlciBPcmNoZXN0cmF0b3Ig4oCUIENvb3Jkb25uZSBwbHVzaWV1cnMgcHJvamV0cyBldCBsZXVycyBvcmNoZXN0cmF0ZXVyczwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtc3VwZXJfb3JjaGVzdHJhdG9yIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTc3Q0Y3Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM3MDQzREIiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM1MzI0QjQiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0icmVnYWxpYS1zdXBlcl9vcmNoZXN0cmF0b3IiIHgxPSIxMCUiIHkxPSIwJSIgeDI9IjYwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGRkYyQTciLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNGMkI5MzYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPGVsbGlwc2UgY3g9IjEyOCIgY3k9IjIzMCIgcng9IjgxIiByeT0iOSIgZmlsbD0iIzcwNDNEQiIgb3BhY2l0eT0iMC4xNiIvPgo8ZyBmaWxsPSJub25lIiBzdHJva2U9IiM3MDQzREIiIHN0cm9rZS13aWR0aD0iOS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxwYXRoIGQ9Ik0gNTMgNDMgTCA0MSAzNCIvPgo8cGF0aCBkPSJNIDY1IDMwIEwgNTcgMTciLz4KPHBhdGggZD0iTSA4MyAyNSBMIDgwIDExIi8+PC9nPgo8cGF0aCBkPSJNIDEwNy4xMyA0Ni45NyBDIDEwMS4zOCA1MS4zNCA4Ni4wMiA2NS40NiA3OS4wOCA3My41MyBDIDcyLjE1IDgxLjYxIDU4LjI5IDEwMC4yOSA1Mi4zNyAxMTAuNzMgQyA0Ni40NSAxMjEuMTYgMzUuMDQgMTQ4LjY1IDMyLjM0IDE1NS44OSBDIDI5LjYzIDE2My4xMiAzMC40OSAxNjQuMTQgMzEuMDAgMTY3Ljg0IEMgMzEuNTEgMTcxLjU0IDM0LjgyIDE4MS45MSAzNi4zNCAxODUuMTEgQyAzNy44NyAxODguMzAgNDAuMTQgMTkwLjg5IDQzLjAyIDE5My4wOCBDIDQ1LjkwIDE5NS4yNiA1MS45NCAyMDAuMTkgNTkuMDUgMjAyLjM3IEMgNjYuMTUgMjA0LjU2IDg0Ljc0IDIwOS4zMyA5OS4xMiAyMTAuMzQgQyAxMTMuNTAgMjExLjM1IDE2MS4wNyAyMTAuNjggMTcyLjU4IDIxMC4zNCBDIDE4NC4wOCAyMTAuMDEgMTg1LjU0IDIwOC44NiAxODkuOTQgMjA3LjY5IEMgMTk0LjM0IDIwNi41MSAyMDMuOTIgMjAyLjkwIDIwNy4zMCAyMDEuMDUgQyAyMTAuNjggMTk5LjIwIDIxNC42MiAxOTUuNjAgMjE2LjY1IDE5My4wOCBDIDIxOC42OCAxOTAuNTUgMjIyLjMxIDE4NS44MyAyMjMuMzMgMTgxLjEyIEMgMjI0LjM0IDE3Ni40MSAyMjUuODUgMTYyLjk1IDIyNC42NiAxNTUuODkgQyAyMjMuNDggMTQ4LjgyIDIxOC4wNCAxMzQuNDIgMjEzLjk4IDEyNS4zNCBDIDIwOS45MiAxMTYuMjUgMTk3LjAxIDkxLjczIDE5Mi42MSA4NC4xNiBDIDE4OC4yMSA3Ni41OSAxODIuODEgNjkuNzcgMTc5LjI1IDY1LjU2IEMgMTc1LjcwIDYxLjM2IDE2OC43OSA1NC4xNSAxNjQuNTYgNTAuOTUgQyAxNjAuMzMgNDcuNzYgMTUwLjk0IDQxLjg0IDE0NS44NiA0MC4zMyBDIDE0MC43OSAzOC44MSAxMjkuNDAgMzguMTYgMTI0LjQ5IDM5LjAwIEMgMTE5LjU5IDM5Ljg0IDExMi44OCA0Mi42MCAxMDcuMTMgNDYuOTcgWiIgZmlsbD0idXJsKCNncmFkaWVudC1zdXBlcl9vcmNoZXN0cmF0b3IpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iMTAwIiBjeT0iMTA4IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTM0IiBjeT0iMTA4IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxwYXRoIGQ9Ik0gMTAxIDM3IEwgMTA1IDE0IFEgMTA2IDExIDExMCAxNSBMIDEyMCAyNiBMIDEzMiA3IFEgMTM1IDIgMTM4IDcgTCAxNTEgMjYgTCAxNjEgMTUgUSAxNjYgMTAgMTY3IDE3IEwgMTcwIDM3IFEgMTM2IDQ2IDEwMSAzNyBaIiBmaWxsPSJ1cmwoI3JlZ2FsaWEtc3VwZXJfb3JjaGVzdHJhdG9yKSIgc3Ryb2tlPSIjRkZGRkZGIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48cGF0aCBkPSJNIDEwMyAzOCBRIDEzNSA0NSAxNjggMzgiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZCRjFDMCIgc3Ryb2tlLXdpZHRoPSIzLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNTEgMTQ3KSBzY2FsZSgxLjEpIj48ZyBzdHJva2U9IiNmZmYiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yNSAxMSBWMjcgTTI1IDI3IEg4IFYzNiBNMjUgMjcgSDQyIFYzNiIvPjwvZz48ZyBmaWxsPSIjZmZmIj48Y2lyY2xlIGN4PSIyNSIgY3k9IjgiIHI9IjcuNCIvPjxjaXJjbGUgY3g9IjgiIGN5PSI0MSIgcj0iNy40Ii8+PGNpcmNsZSBjeD0iNDIiIGN5PSI0MSIgcj0iNy40Ii8+PC9nPjwvZz4KPC9zdmc+Cg==', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXN1cGVyX29yY2hlc3RyYXRvciI+Cjx0aXRsZSBpZD0idGl0bGUtc3VwZXJfb3JjaGVzdHJhdG9yIj5TdXBlciBPcmNoZXN0cmF0b3Ig4oCUIENvb3Jkb25uZSBwbHVzaWV1cnMgcHJvamV0cyBldCBsZXVycyBvcmNoZXN0cmF0ZXVyczwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtc3VwZXJfb3JjaGVzdHJhdG9yIiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTc3Q0Y3Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM3MDQzREIiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM1MzI0QjQiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0icmVnYWxpYS1zdXBlcl9vcmNoZXN0cmF0b3IiIHgxPSIxMCUiIHkxPSIwJSIgeDI9IjYwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGRkYyQTciLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNGMkI5MzYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KPHBhdGggZD0iTSAxMDcuMTMgNDYuOTcgQyAxMDEuMzggNTEuMzQgODYuMDIgNjUuNDYgNzkuMDggNzMuNTMgQyA3Mi4xNSA4MS42MSA1OC4yOSAxMDAuMjkgNTIuMzcgMTEwLjczIEMgNDYuNDUgMTIxLjE2IDM1LjA0IDE0OC42NSAzMi4zNCAxNTUuODkgQyAyOS42MyAxNjMuMTIgMzAuNDkgMTY0LjE0IDMxLjAwIDE2Ny44NCBDIDMxLjUxIDE3MS41NCAzNC44MiAxODEuOTEgMzYuMzQgMTg1LjExIEMgMzcuODcgMTg4LjMwIDQwLjE0IDE5MC44OSA0My4wMiAxOTMuMDggQyA0NS45MCAxOTUuMjYgNTEuOTQgMjAwLjE5IDU5LjA1IDIwMi4zNyBDIDY2LjE1IDIwNC41NiA4NC43NCAyMDkuMzMgOTkuMTIgMjEwLjM0IEMgMTEzLjUwIDIxMS4zNSAxNjEuMDcgMjEwLjY4IDE3Mi41OCAyMTAuMzQgQyAxODQuMDggMjEwLjAxIDE4NS41NCAyMDguODYgMTg5Ljk0IDIwNy42OSBDIDE5NC4zNCAyMDYuNTEgMjAzLjkyIDIwMi45MCAyMDcuMzAgMjAxLjA1IEMgMjEwLjY4IDE5OS4yMCAyMTQuNjIgMTk1LjYwIDIxNi42NSAxOTMuMDggQyAyMTguNjggMTkwLjU1IDIyMi4zMSAxODUuODMgMjIzLjMzIDE4MS4xMiBDIDIyNC4zNCAxNzYuNDEgMjI1Ljg1IDE2Mi45NSAyMjQuNjYgMTU1Ljg5IEMgMjIzLjQ4IDE0OC44MiAyMTguMDQgMTM0LjQyIDIxMy45OCAxMjUuMzQgQyAyMDkuOTIgMTE2LjI1IDE5Ny4wMSA5MS43MyAxOTIuNjEgODQuMTYgQyAxODguMjEgNzYuNTkgMTgyLjgxIDY5Ljc3IDE3OS4yNSA2NS41NiBDIDE3NS43MCA2MS4zNiAxNjguNzkgNTQuMTUgMTY0LjU2IDUwLjk1IEMgMTYwLjMzIDQ3Ljc2IDE1MC45NCA0MS44NCAxNDUuODYgNDAuMzMgQyAxNDAuNzkgMzguODEgMTI5LjQwIDM4LjE2IDEyNC40OSAzOS4wMCBDIDExOS41OSAzOS44NCAxMTIuODggNDIuNjAgMTA3LjEzIDQ2Ljk3IFoiIGZpbGw9InVybCgjZ3JhZGllbnQtc3VwZXJfb3JjaGVzdHJhdG9yKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjEwMCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEzNCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8cGF0aCBkPSJNIDEwMSAzNyBMIDEwNSAxNCBRIDEwNiAxMSAxMTAgMTUgTCAxMjAgMjYgTCAxMzIgNyBRIDEzNSAyIDEzOCA3IEwgMTUxIDI2IEwgMTYxIDE1IFEgMTY2IDEwIDE2NyAxNyBMIDE3MCAzNyBRIDEzNiA0NiAxMDEgMzcgWiIgZmlsbD0idXJsKCNyZWdhbGlhLXN1cGVyX29yY2hlc3RyYXRvcikiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHBhdGggZD0iTSAxMDMgMzggUSAxMzUgNDUgMTY4IDM4IiBmaWxsPSJub25lIiBzdHJva2U9IiNGQkYxQzAiIHN0cm9rZS13aWR0aD0iMy41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTUxIDE0Nykgc2NhbGUoMS4xKSI+PGcgc3Ryb2tlPSIjZmZmIiBmaWxsPSJub25lIiBzdHJva2Utd2lkdGg9IjUuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjUgMTEgVjI3IE0yNSAyNyBIOCBWMzYgTTI1IDI3IEg0MiBWMzYiLz48L2c+PGcgZmlsbD0iI2ZmZiI+PGNpcmNsZSBjeD0iMjUiIGN5PSI4IiByPSI3LjQiLz48Y2lyY2xlIGN4PSI4IiBjeT0iNDEiIHI9IjcuNCIvPjxjaXJjbGUgY3g9IjQyIiBjeT0iNDEiIHI9IjcuNCIvPjwvZz48L2c+Cjwvc3ZnPgo=' }),
  super_orchestrator_bolt: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXN1cGVyX29yY2hlc3RyYXRvcl9ib2x0Ij4KPHRpdGxlIGlkPSJ0aXRsZS1zdXBlcl9vcmNoZXN0cmF0b3JfYm9sdCI+U3VwZXIgT3JjaGVzdHJhdG9yIOKAlCBDb29yZG9ubmUgcGx1c2lldXJzIHByb2pldHMgZXQgbGV1cnMgb3JjaGVzdHJhdGV1cnM8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LXN1cGVyX29yY2hlc3RyYXRvcl9ib2x0IiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTc3Q0Y3Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM3MDQzREIiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM1MzI0QjQiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0icmVnYWxpYS1zdXBlcl9vcmNoZXN0cmF0b3JfYm9sdCIgeDE9IjEwJSIgeTE9IjAlIiB4Mj0iNjAlIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0ZGRjJBNyIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0YyQjkzNiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8ZWxsaXBzZSBjeD0iMTI4IiBjeT0iMjMwIiByeD0iODEiIHJ5PSI5IiBmaWxsPSIjNzA0M0RCIiBvcGFjaXR5PSIwLjE2Ii8+CjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzcwNDNEQiIgc3Ryb2tlLXdpZHRoPSI5LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTSA1MyA0MyBMIDQxIDM0Ii8+CjxwYXRoIGQ9Ik0gNjUgMzAgTCA1NyAxNyIvPgo8cGF0aCBkPSJNIDgzIDI1IEwgODAgMTEiLz48L2c+CjxwYXRoIGQ9Ik0gMTA3LjEzIDQ2Ljk3IEMgMTAxLjM4IDUxLjM0IDg2LjAyIDY1LjQ2IDc5LjA4IDczLjUzIEMgNzIuMTUgODEuNjEgNTguMjkgMTAwLjI5IDUyLjM3IDExMC43MyBDIDQ2LjQ1IDEyMS4xNiAzNS4wNCAxNDguNjUgMzIuMzQgMTU1Ljg5IEMgMjkuNjMgMTYzLjEyIDMwLjQ5IDE2NC4xNCAzMS4wMCAxNjcuODQgQyAzMS41MSAxNzEuNTQgMzQuODIgMTgxLjkxIDM2LjM0IDE4NS4xMSBDIDM3Ljg3IDE4OC4zMCA0MC4xNCAxOTAuODkgNDMuMDIgMTkzLjA4IEMgNDUuOTAgMTk1LjI2IDUxLjk0IDIwMC4xOSA1OS4wNSAyMDIuMzcgQyA2Ni4xNSAyMDQuNTYgODQuNzQgMjA5LjMzIDk5LjEyIDIxMC4zNCBDIDExMy41MCAyMTEuMzUgMTYxLjA3IDIxMC42OCAxNzIuNTggMjEwLjM0IEMgMTg0LjA4IDIxMC4wMSAxODUuNTQgMjA4Ljg2IDE4OS45NCAyMDcuNjkgQyAxOTQuMzQgMjA2LjUxIDIwMy45MiAyMDIuOTAgMjA3LjMwIDIwMS4wNSBDIDIxMC42OCAxOTkuMjAgMjE0LjYyIDE5NS42MCAyMTYuNjUgMTkzLjA4IEMgMjE4LjY4IDE5MC41NSAyMjIuMzEgMTg1LjgzIDIyMy4zMyAxODEuMTIgQyAyMjQuMzQgMTc2LjQxIDIyNS44NSAxNjIuOTUgMjI0LjY2IDE1NS44OSBDIDIyMy40OCAxNDguODIgMjE4LjA0IDEzNC40MiAyMTMuOTggMTI1LjM0IEMgMjA5LjkyIDExNi4yNSAxOTcuMDEgOTEuNzMgMTkyLjYxIDg0LjE2IEMgMTg4LjIxIDc2LjU5IDE4Mi44MSA2OS43NyAxNzkuMjUgNjUuNTYgQyAxNzUuNzAgNjEuMzYgMTY4Ljc5IDU0LjE1IDE2NC41NiA1MC45NSBDIDE2MC4zMyA0Ny43NiAxNTAuOTQgNDEuODQgMTQ1Ljg2IDQwLjMzIEMgMTQwLjc5IDM4LjgxIDEyOS40MCAzOC4xNiAxMjQuNDkgMzkuMDAgQyAxMTkuNTkgMzkuODQgMTEyLjg4IDQyLjYwIDEwNy4xMyA0Ni45NyBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LXN1cGVyX29yY2hlc3RyYXRvcl9ib2x0KSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjEwMCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEzNCIgY3k9IjEwOCIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8cGF0aCBkPSJNIDE0MiAzIEwgMTA5IDI3IFEgMTA3IDMwIDExMyAzMCBIMTMxIEwgMTIyIDQ5IEwgMTU4IDIxIFEgMTYxIDE3IDE1NiAxNyBIMTM5IFoiIGZpbGw9InVybCgjcmVnYWxpYS1zdXBlcl9vcmNoZXN0cmF0b3JfYm9sdCkiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE1MSAxNDcpIHNjYWxlKDEuMSkiPjxnIHN0cm9rZT0iI2ZmZiIgZmlsbD0ibm9uZSIgc3Ryb2tlLXdpZHRoPSI1LjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTI1IDExIFYyNyBNMjUgMjcgSDggVjM2IE0yNSAyNyBINDIgVjM2Ii8+PC9nPjxnIGZpbGw9IiNmZmYiPjxjaXJjbGUgY3g9IjI1IiBjeT0iOCIgcj0iNy40Ii8+PGNpcmNsZSBjeD0iOCIgY3k9IjQxIiByPSI3LjQiLz48Y2lyY2xlIGN4PSI0MiIgY3k9IjQxIiByPSI3LjQiLz48L2c+PC9nPgo8L3N2Zz4K', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXN1cGVyX29yY2hlc3RyYXRvcl9ib2x0Ij4KPHRpdGxlIGlkPSJ0aXRsZS1zdXBlcl9vcmNoZXN0cmF0b3JfYm9sdCI+U3VwZXIgT3JjaGVzdHJhdG9yIOKAlCBDb29yZG9ubmUgcGx1c2lldXJzIHByb2pldHMgZXQgbGV1cnMgb3JjaGVzdHJhdGV1cnM8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LXN1cGVyX29yY2hlc3RyYXRvcl9ib2x0IiB4MT0iMTklIiB5MT0iMCUiIHgyPSI3NyUiIHkyPSIxMDAlIj48c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjQTc3Q0Y3Ii8+PHN0b3Agb2Zmc2V0PSI1MyUiIHN0b3AtY29sb3I9IiM3MDQzREIiLz48c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiM1MzI0QjQiLz48L2xpbmVhckdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0icmVnYWxpYS1zdXBlcl9vcmNoZXN0cmF0b3JfYm9sdCIgeDE9IjEwJSIgeTE9IjAlIiB4Mj0iNjAlIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI0ZGRjJBNyIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0YyQjkzNiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8cGF0aCBkPSJNIDEwNy4xMyA0Ni45NyBDIDEwMS4zOCA1MS4zNCA4Ni4wMiA2NS40NiA3OS4wOCA3My41MyBDIDcyLjE1IDgxLjYxIDU4LjI5IDEwMC4yOSA1Mi4zNyAxMTAuNzMgQyA0Ni40NSAxMjEuMTYgMzUuMDQgMTQ4LjY1IDMyLjM0IDE1NS44OSBDIDI5LjYzIDE2My4xMiAzMC40OSAxNjQuMTQgMzEuMDAgMTY3Ljg0IEMgMzEuNTEgMTcxLjU0IDM0LjgyIDE4MS45MSAzNi4zNCAxODUuMTEgQyAzNy44NyAxODguMzAgNDAuMTQgMTkwLjg5IDQzLjAyIDE5My4wOCBDIDQ1LjkwIDE5NS4yNiA1MS45NCAyMDAuMTkgNTkuMDUgMjAyLjM3IEMgNjYuMTUgMjA0LjU2IDg0Ljc0IDIwOS4zMyA5OS4xMiAyMTAuMzQgQyAxMTMuNTAgMjExLjM1IDE2MS4wNyAyMTAuNjggMTcyLjU4IDIxMC4zNCBDIDE4NC4wOCAyMTAuMDEgMTg1LjU0IDIwOC44NiAxODkuOTQgMjA3LjY5IEMgMTk0LjM0IDIwNi41MSAyMDMuOTIgMjAyLjkwIDIwNy4zMCAyMDEuMDUgQyAyMTAuNjggMTk5LjIwIDIxNC42MiAxOTUuNjAgMjE2LjY1IDE5My4wOCBDIDIxOC42OCAxOTAuNTUgMjIyLjMxIDE4NS44MyAyMjMuMzMgMTgxLjEyIEMgMjI0LjM0IDE3Ni40MSAyMjUuODUgMTYyLjk1IDIyNC42NiAxNTUuODkgQyAyMjMuNDggMTQ4LjgyIDIxOC4wNCAxMzQuNDIgMjEzLjk4IDEyNS4zNCBDIDIwOS45MiAxMTYuMjUgMTk3LjAxIDkxLjczIDE5Mi42MSA4NC4xNiBDIDE4OC4yMSA3Ni41OSAxODIuODEgNjkuNzcgMTc5LjI1IDY1LjU2IEMgMTc1LjcwIDYxLjM2IDE2OC43OSA1NC4xNSAxNjQuNTYgNTAuOTUgQyAxNjAuMzMgNDcuNzYgMTUwLjk0IDQxLjg0IDE0NS44NiA0MC4zMyBDIDE0MC43OSAzOC44MSAxMjkuNDAgMzguMTYgMTI0LjQ5IDM5LjAwIEMgMTE5LjU5IDM5Ljg0IDExMi44OCA0Mi42MCAxMDcuMTMgNDYuOTcgWiIgZmlsbD0idXJsKCNncmFkaWVudC1zdXBlcl9vcmNoZXN0cmF0b3JfYm9sdCkiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSIxMDAiIGN5PSIxMDgiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMzQiIGN5PSIxMDgiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPHBhdGggZD0iTSAxNDIgMyBMIDEwOSAyNyBRIDEwNyAzMCAxMTMgMzAgSDEzMSBMIDEyMiA0OSBMIDE1OCAyMSBRIDE2MSAxNyAxNTYgMTcgSDEzOSBaIiBmaWxsPSJ1cmwoI3JlZ2FsaWEtc3VwZXJfb3JjaGVzdHJhdG9yX2JvbHQpIiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNTEgMTQ3KSBzY2FsZSgxLjEpIj48ZyBzdHJva2U9IiNmZmYiIGZpbGw9Im5vbmUiIHN0cm9rZS13aWR0aD0iNS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yNSAxMSBWMjcgTTI1IDI3IEg4IFYzNiBNMjUgMjcgSDQyIFYzNiIvPjwvZz48ZyBmaWxsPSIjZmZmIj48Y2lyY2xlIGN4PSIyNSIgY3k9IjgiIHI9IjcuNCIvPjxjaXJjbGUgY3g9IjgiIGN5PSI0MSIgcj0iNy40Ii8+PGNpcmNsZSBjeD0iNDIiIGN5PSI0MSIgcj0iNy40Ii8+PC9nPjwvZz4KPC9zdmc+Cg==' }),
  verifier: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXZlcmlmaWVyIj4KPHRpdGxlIGlkPSJ0aXRsZS12ZXJpZmllciI+VmVyaWZpZXIg4oCUIFRlc3RlIGV0IHZhbGlkZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtdmVyaWZpZXIiIHgxPSIxOSUiIHkxPSIwJSIgeDI9Ijc3JSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGRURCM0IiLz48c3RvcCBvZmZzZXQ9IjUzJSIgc3RvcC1jb2xvcj0iI0ZFQkYwRCIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0ZFQUUwMiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8ZWxsaXBzZSBjeD0iMTI4IiBjeT0iMjMwIiByeD0iODEiIHJ5PSI5IiBmaWxsPSIjRkVCRjBEIiBvcGFjaXR5PSIwLjE2Ii8+CjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZFQkYwRCIgc3Ryb2tlLXdpZHRoPSI5LjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTSAxOTcgNTEgTCAyMDYgMzEiLz4KPHBhdGggZD0iTSAyMTUgNjIgTCAyMzAgNTMiLz48L2c+CjxwYXRoIGQ9Ik0gMTE5LjIwIDUxLjAwIEMgMTE1LjI1IDUyLjE5IDExMS42OSA1Mi41OCAxMDIuOTQgNjAuNDEgQyA5NC4yMCA2OC4yNCA1Ny42NyAxMDQuNjYgNTAuMTMgMTEyLjg0IEMgNDIuNTggMTIxLjAxIDQ0LjM4IDEyMi4wNCA0My4zNSAxMjQuOTMgQyA0Mi4zMyAxMjcuODMgNDAuOTcgMTMxLjc3IDQyLjAwIDEzNS42OSBDIDQzLjAzIDEzOS42MCA0NS44MiAxNDkuMDQgNTEuNDggMTU1Ljg1IEMgNTcuMTQgMTYyLjY2IDc5LjE0IDE4Mi44MiA4Ni42OSAxODkuNDYgQyA5NC4yNCAxOTYuMTAgMTA1LjU4IDIwNS4yMSAxMTEuMDcgMjA4LjI4IEMgMTE2LjU2IDIxMS4zNCAxMjUuNzQgMjEzLjY2IDEzMC4wMyAyMTMuNjYgQyAxMzQuMzIgMjEzLjY2IDE0MC45OCAyMTAuNDkgMTQ0LjkzIDIwOC4yOCBDIDE0OC44NyAyMDYuMDcgMTUzLjI5IDIwMy4zMyAxNjEuMTggMTk2LjE4IEMgMTY5LjA3IDE4OS4wMyAyMDAuNzEgMTU4LjgwIDIwNy4yMyAxNTEuODIgQyAyMTMuNzUgMTQ0Ljg0IDIxMS45NiAxNDQuMTMgMjEyLjY1IDE0MS4wNyBDIDIxMy4zMyAxMzguMDAgMjEzLjY3IDEzMS4yMCAyMTIuNjUgMTI3LjYyIEMgMjExLjYyIDEyNC4wNSAyMTIuNzUgMTIxLjY5IDIwNC41MiAxMTIuODQgQyAxOTYuMjkgMTAzLjk4IDE1Ni41NiA2NS41NSAxNDcuNjQgNTcuNzIgQyAxMzguNzIgNDkuODkgMTM3LjcwIDUxLjg1IDEzNC4wOSA1MS4wMCBDIDEzMC40OSA1MC4xNSAxMjMuMTQgNDkuODEgMTE5LjIwIDUxLjAwIFoiIGZpbGw9InVybCgjZ3JhZGllbnQtdmVyaWZpZXIpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTMiIGN5PSIxMTQiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMzAiIGN5PSIxMTQiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTM5IDEzOCkgc2NhbGUoMS4wNCkiPjxwYXRoIGQ9Ik01IDI2IDE5IDM5IDQ2IDEwIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNy4zIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L2c+Cjwvc3ZnPgo=', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXZlcmlmaWVyIj4KPHRpdGxlIGlkPSJ0aXRsZS12ZXJpZmllciI+VmVyaWZpZXIg4oCUIFRlc3RlIGV0IHZhbGlkZTwvdGl0bGU+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQtdmVyaWZpZXIiIHgxPSIxOSUiIHkxPSIwJSIgeDI9Ijc3JSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNGRURCM0IiLz48c3RvcCBvZmZzZXQ9IjUzJSIgc3RvcC1jb2xvcj0iI0ZFQkYwRCIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI0ZFQUUwMiIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8cGF0aCBkPSJNIDExOS4yMCA1MS4wMCBDIDExNS4yNSA1Mi4xOSAxMTEuNjkgNTIuNTggMTAyLjk0IDYwLjQxIEMgOTQuMjAgNjguMjQgNTcuNjcgMTA0LjY2IDUwLjEzIDExMi44NCBDIDQyLjU4IDEyMS4wMSA0NC4zOCAxMjIuMDQgNDMuMzUgMTI0LjkzIEMgNDIuMzMgMTI3LjgzIDQwLjk3IDEzMS43NyA0Mi4wMCAxMzUuNjkgQyA0My4wMyAxMzkuNjAgNDUuODIgMTQ5LjA0IDUxLjQ4IDE1NS44NSBDIDU3LjE0IDE2Mi42NiA3OS4xNCAxODIuODIgODYuNjkgMTg5LjQ2IEMgOTQuMjQgMTk2LjEwIDEwNS41OCAyMDUuMjEgMTExLjA3IDIwOC4yOCBDIDExNi41NiAyMTEuMzQgMTI1Ljc0IDIxMy42NiAxMzAuMDMgMjEzLjY2IEMgMTM0LjMyIDIxMy42NiAxNDAuOTggMjEwLjQ5IDE0NC45MyAyMDguMjggQyAxNDguODcgMjA2LjA3IDE1My4yOSAyMDMuMzMgMTYxLjE4IDE5Ni4xOCBDIDE2OS4wNyAxODkuMDMgMjAwLjcxIDE1OC44MCAyMDcuMjMgMTUxLjgyIEMgMjEzLjc1IDE0NC44NCAyMTEuOTYgMTQ0LjEzIDIxMi42NSAxNDEuMDcgQyAyMTMuMzMgMTM4LjAwIDIxMy42NyAxMzEuMjAgMjEyLjY1IDEyNy42MiBDIDIxMS42MiAxMjQuMDUgMjEyLjc1IDEyMS42OSAyMDQuNTIgMTEyLjg0IEMgMTk2LjI5IDEwMy45OCAxNTYuNTYgNjUuNTUgMTQ3LjY0IDU3LjcyIEMgMTM4LjcyIDQ5Ljg5IDEzNy43MCA1MS44NSAxMzQuMDkgNTEuMDAgQyAxMzAuNDkgNTAuMTUgMTIzLjE0IDQ5LjgxIDExOS4yMCA1MS4wMCBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LXZlcmlmaWVyKSIvPgo8ZyBmaWxsPSJ3aGl0ZSI+PGVsbGlwc2UgY3g9IjkzIiBjeT0iMTE0IiByeD0iOCIgcnk9IjEzLjAiLz48ZWxsaXBzZSBjeD0iMTMwIiBjeT0iMTE0IiByeD0iOCIgcnk9IjEzLjAiLz48L2c+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEzOSAxMzgpIHNjYWxlKDEuMDQpIj48cGF0aCBkPSJNNSAyNiAxOSAzOSA0NiAxMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjcuMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PC9nPgo8L3N2Zz4K' }),
  worker: Object.freeze({ full: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXdvcmtlciI+Cjx0aXRsZSBpZD0idGl0bGUtd29ya2VyIj5Xb3JrZXIg4oCUIEV4w6ljdXRlIGV0IHByb2R1aXQ8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LXdvcmtlciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzU2RTA3OSIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjMzZDQjVFIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMjJCOTRCIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxlbGxpcHNlIGN4PSIxMjgiIGN5PSIyMzAiIHJ4PSI4MSIgcnk9IjkiIGZpbGw9IiMzNkNCNUUiIG9wYWNpdHk9IjAuMTYiLz4KPGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMzZDQjVFIiBzdHJva2Utd2lkdGg9IjkuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48cGF0aCBkPSJNIDIwMCA2MCBMIDIwOSAzNyIvPgo8cGF0aCBkPSJNIDIxNSA2OCBMIDIyNyA1NCIvPgo8cGF0aCBkPSJNIDIyNiA3NyBMIDI0MSA2OCIvPjwvZz4KPHBhdGggZD0iTSAyOS4wMCAxNTEuNTMgQyAyOC4zMiAxNTYuNjEgMjguMzEgMTY4LjY2IDMwLjMzIDE3NC4yNSBDIDMyLjM2IDE3OS44MyA0MS43OSAxOTIuMDcgNDUuMDAgMTk1LjYzIEMgNDguMjEgMTk5LjE4IDUyLjEyIDIwMC43OSA1NS42NyAyMDIuMzEgQyA1OS4yMSAyMDMuODMgNjUuOTEgMjA2LjQ3IDczLjAwIDIwNy42NSBDIDgwLjA5IDIwOC44NCAxMDAuMDEgMjExLjMzIDExMS42NyAyMTEuNjYgQyAxMjMuMzIgMjEyLjAwIDE1NC4zNiAyMTEuNjggMTY1LjAwIDIxMC4zMyBDIDE3NS42NCAyMDguOTcgMTg5LjQyIDIwNC4zNiAxOTUuNjcgMjAwLjk3IEMgMjAxLjkyIDE5Ny41OSAyMTEuMTIgMTg3LjY2IDIxNC4zMyAxODMuNjAgQyAyMTcuNTQgMTc5LjU0IDIxOS44MiAxNzIuNjMgMjIxLjAwIDE2OC45MCBDIDIyMi4xOCAxNjUuMTggMjI0LjAwIDE1OS4yOCAyMjMuNjcgMTU0LjIwIEMgMjIzLjMzIDE0OS4xMyAyMjEuMjAgMTM0Ljc0IDIxOC4zMyAxMjguODEgQyAyMTUuNDYgMTIyLjg5IDIwNC44OCAxMTAuOTkgMjAxLjAwIDEwNy40MyBDIDE5Ny4xMiAxMDMuODggMTkxLjIxIDEwMS43NyAxODcuNjcgMTAwLjc1IEMgMTg0LjEyIDk5Ljc0IDE3Ni4zOCAxMDEuOTUgMTczLjAwIDk5LjQyIEMgMTY5LjYyIDk2Ljg4IDE2My43MCA4NC4wOSAxNjEuMDAgODAuNzEgQyAxNTguMzAgNzcuMzIgMTU0LjM3IDc0LjU1IDE1MS42NyA3Mi42OSBDIDE0OC45NiA3MC44MyAxNDMuMjEgNjcuMzYgMTM5LjY3IDY2LjAxIEMgMTM2LjEyIDY0LjY1IDEyOC4yMyA2Mi4zNCAxMjMuNjcgNjIuMDAgQyAxMTkuMTEgNjEuNjYgMTA5LjQxIDYxLjQ3IDEwMy42NyA2My4zNCBDIDk3LjkyIDY1LjIwIDgzLjQwIDcyLjMwIDc4LjMzIDc2LjcwIEMgNzMuMjcgODEuMTAgNjYuMDMgOTMuMDAgNjMuNjcgOTguMDggQyA2MS4zMCAxMDMuMTYgNjEuODYgMTEzLjU3IDU5LjY3IDExNi43OSBDIDU3LjQ3IDEyMC4wMCA0OS4zNyAxMjEuMjcgNDYuMzMgMTIzLjQ3IEMgNDMuMjkgMTI1LjY3IDM3Ljg2IDEzMC42MCAzNS42NyAxMzQuMTYgQyAzMy40NyAxMzcuNzEgMjkuNjggMTQ2LjQ1IDI5LjAwIDE1MS41MyBaIiBmaWxsPSJ1cmwoI2dyYWRpZW50LXdvcmtlcikiLz4KPGcgZmlsbD0id2hpdGUiPjxlbGxpcHNlIGN4PSI5MSIgY3k9IjEyNSIgcng9IjgiIHJ5PSIxMy4wIi8+PGVsbGlwc2UgY3g9IjEyNyIgY3k9IjEyNSIgcng9IjgiIHJ5PSIxMy4wIi8+PC9nPgo8ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxNDYgMTQ0KSBzY2FsZSgxLjE0KSI+PHBhdGggZD0iTTQzIDcgQzM1IDMgMjUgMTAgMjUgMjAgTDggMzcgQzQgNDEgNyA0NyAxMiA0NyBDMTUgNDcgMTcgNDUgMTkgNDMgTDM2IDI2IEM0NSAyNiA0OSAxNSA0MyA3IFogTTM2IDcgNDQgMTQgMzUgMjMgMjggMTYgWiIgZmlsbD0iI2ZmZiIgZmlsbC1ydWxlPSJldmVub2RkIi8+PC9nPgo8L3N2Zz4K', compact: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgMjU2IDI1NiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsbGVkYnk9InRpdGxlLXdvcmtlciI+Cjx0aXRsZSBpZD0idGl0bGUtd29ya2VyIj5Xb3JrZXIg4oCUIEV4w6ljdXRlIGV0IHByb2R1aXQ8L3RpdGxlPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImdyYWRpZW50LXdvcmtlciIgeDE9IjE5JSIgeTE9IjAlIiB4Mj0iNzclIiB5Mj0iMTAwJSI+PHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzU2RTA3OSIvPjxzdG9wIG9mZnNldD0iNTMlIiBzdG9wLWNvbG9yPSIjMzZDQjVFIi8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMjJCOTRCIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxwYXRoIGQ9Ik0gMjkuMDAgMTUxLjUzIEMgMjguMzIgMTU2LjYxIDI4LjMxIDE2OC42NiAzMC4zMyAxNzQuMjUgQyAzMi4zNiAxNzkuODMgNDEuNzkgMTkyLjA3IDQ1LjAwIDE5NS42MyBDIDQ4LjIxIDE5OS4xOCA1Mi4xMiAyMDAuNzkgNTUuNjcgMjAyLjMxIEMgNTkuMjEgMjAzLjgzIDY1LjkxIDIwNi40NyA3My4wMCAyMDcuNjUgQyA4MC4wOSAyMDguODQgMTAwLjAxIDIxMS4zMyAxMTEuNjcgMjExLjY2IEMgMTIzLjMyIDIxMi4wMCAxNTQuMzYgMjExLjY4IDE2NS4wMCAyMTAuMzMgQyAxNzUuNjQgMjA4Ljk3IDE4OS40MiAyMDQuMzYgMTk1LjY3IDIwMC45NyBDIDIwMS45MiAxOTcuNTkgMjExLjEyIDE4Ny42NiAyMTQuMzMgMTgzLjYwIEMgMjE3LjU0IDE3OS41NCAyMTkuODIgMTcyLjYzIDIyMS4wMCAxNjguOTAgQyAyMjIuMTggMTY1LjE4IDIyNC4wMCAxNTkuMjggMjIzLjY3IDE1NC4yMCBDIDIyMy4zMyAxNDkuMTMgMjIxLjIwIDEzNC43NCAyMTguMzMgMTI4LjgxIEMgMjE1LjQ2IDEyMi44OSAyMDQuODggMTEwLjk5IDIwMS4wMCAxMDcuNDMgQyAxOTcuMTIgMTAzLjg4IDE5MS4yMSAxMDEuNzcgMTg3LjY3IDEwMC43NSBDIDE4NC4xMiA5OS43NCAxNzYuMzggMTAxLjk1IDE3My4wMCA5OS40MiBDIDE2OS42MiA5Ni44OCAxNjMuNzAgODQuMDkgMTYxLjAwIDgwLjcxIEMgMTU4LjMwIDc3LjMyIDE1NC4zNyA3NC41NSAxNTEuNjcgNzIuNjkgQyAxNDguOTYgNzAuODMgMTQzLjIxIDY3LjM2IDEzOS42NyA2Ni4wMSBDIDEzNi4xMiA2NC42NSAxMjguMjMgNjIuMzQgMTIzLjY3IDYyLjAwIEMgMTE5LjExIDYxLjY2IDEwOS40MSA2MS40NyAxMDMuNjcgNjMuMzQgQyA5Ny45MiA2NS4yMCA4My40MCA3Mi4zMCA3OC4zMyA3Ni43MCBDIDczLjI3IDgxLjEwIDY2LjAzIDkzLjAwIDYzLjY3IDk4LjA4IEMgNjEuMzAgMTAzLjE2IDYxLjg2IDExMy41NyA1OS42NyAxMTYuNzkgQyA1Ny40NyAxMjAuMDAgNDkuMzcgMTIxLjI3IDQ2LjMzIDEyMy40NyBDIDQzLjI5IDEyNS42NyAzNy44NiAxMzAuNjAgMzUuNjcgMTM0LjE2IEMgMzMuNDcgMTM3LjcxIDI5LjY4IDE0Ni40NSAyOS4wMCAxNTEuNTMgWiIgZmlsbD0idXJsKCNncmFkaWVudC13b3JrZXIpIi8+CjxnIGZpbGw9IndoaXRlIj48ZWxsaXBzZSBjeD0iOTEiIGN5PSIxMjUiIHJ4PSI4IiByeT0iMTMuMCIvPjxlbGxpcHNlIGN4PSIxMjciIGN5PSIxMjUiIHJ4PSI4IiByeT0iMTMuMCIvPjwvZz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTQ2IDE0NCkgc2NhbGUoMS4xNCkiPjxwYXRoIGQ9Ik00MyA3IEMzNSAzIDI1IDEwIDI1IDIwIEw4IDM3IEM0IDQxIDcgNDcgMTIgNDcgQzE1IDQ3IDE3IDQ1IDE5IDQzIEwzNiAyNiBDNDUgMjYgNDkgMTUgNDMgNyBaIE0zNiA3IDQ0IDE0IDM1IDIzIDI4IDE2IFoiIGZpbGw9IiNmZmYiIGZpbGwtcnVsZT0iZXZlbm9kZCIvPjwvZz4KPC9zdmc+Cg==' }),
})


// ---- src/client/ui/avatar.js ----
/**
 * AgentAvatar: the approved mascot (or a neutral grey mark), a separate status
 * dot and an optional Task Board state chip.
 *
 * Client module concatenated into the browser artifact by
 * scripts/build-client.mjs: everything here is global to the bundle. It uses
 * React.createElement only — no JSX and no HTML string sink: an SVG data URI is
 * only ever assigned to an `<img>` `src`. The role never carries a status
 * colour: the dot is a distinct element driven by `data-tone`.
 *
 * The wrapper owns the accessible name (`role="img"` + composed aria-label);
 * the `<img>` is decorative (`alt=""`). `decorative` renders `aria-hidden`.
 * Size flows to CSS through the `--dab-avatar-size` custom property. There is no
 * animation by default; any pulse a stylesheet adds must be disabled under
 * `prefers-reduced-motion` (styles.js owns that rule).
 *
 * @module dsh-agent-board/client/ui/avatar
 */

/** Injected data-URI map. The bundle defines AGENT_BOT_ASSETS before this file. */
function dabAvatarSources(props) {
  if (Object.prototype.hasOwnProperty.call(props, 'sources')) return props.sources ?? null
  if (typeof AGENT_BOT_ASSETS !== 'undefined') return AGENT_BOT_ASSETS
  return null
}

/**
 * Neutral grey identity mark used when the role is unknown or the asset source
 * is missing. Deliberately NOT one of the 15 mascot silhouettes: a plain person
 * glyph, so an unknown agent is never given a guessed role.
 */
function dabAvatarGenericMark(h) {
  return h('svg', {
    className: 'dab-avatar-generic',
    viewBox: '0 0 24 24',
    width: '60%',
    height: '60%',
    'aria-hidden': 'true',
    focusable: 'false',
  },
  h('circle', { key: 'head', cx: 12, cy: 8.5, r: 3.6, fill: '#7E8B9C' }),
  h('path', {
    key: 'body',
    d: 'M4.6 20.2c1.2-4.2 4.1-6.4 7.4-6.4s6.2 2.2 7.4 6.4',
    fill: 'none',
    stroke: '#7E8B9C',
    strokeWidth: 2.4,
    strokeLinecap: 'round',
  }))
}

/** Compose the accessible name from the pure model's structured parts. */
function dabAvatarAltText(model) {
  const parts = []
  for (const part of model.altParts) {
    const text = part.labelKey !== undefined ? dabT(part.labelKey) : part.text
    if (typeof text === 'string' && text.trim() !== '' && !parts.includes(text)) parts.push(text)
  }
  // No declared name and no readable status: name the element without guessing
  // a role. `agent` is a generic label owned by strings.js.
  if (parts.length === 0) parts.push(dabT('agent'))
  return parts.join(' — ')
}

/**
 * @param {object} props
 * @param {string|object|null} [props.role] declared role/name
 * @param {string|null} [props.name]
 * @param {string|null} [props.status] one of the board's EXISTING statuses
 * @param {string|null} [props.taskState] Task Board workflow state (separate)
 * @param {number} [props.size] rendered size in px (CSS variable)
 * @param {'full'|'compact'|'auto'} [props.variant]
 * @param {'crown'|'bolt'} [props.emblem]
 * @param {boolean} [props.selected]
 * @param {boolean} [props.decorative]
 * @returns {object} React element
 */
function DabAgentAvatar(props) {
  const h = React.createElement
  const model = dabAgentAvatarModel({
    role: props.role,
    name: props.name,
    status: props.status,
    taskState: props.taskState,
    size: props.size,
    variant: props.variant,
    emblem: props.emblem,
    sources: dabAvatarSources(props),
  })
  const decorative = props.decorative === true
  const selected = props.selected === true
  const label = dabAvatarAltText(model)

  const children = []
  if (model.src !== null) {
    children.push(h('img', {
      key: 'image',
      className: 'dab-avatar-img',
      src: model.src,
      alt: '',
      width: model.size,
      height: model.size,
      draggable: false,
      decoding: 'async',
    }))
  } else {
    children.push(h('span', { key: 'generic', className: 'dab-avatar-fallback' }, dabAvatarGenericMark(h)))
  }
  // The status dot is separate from the mascot: role colour is identity, the dot
  // is the runtime status tone. Its colour is a stylesheet decision (data-tone).
  children.push(h('span', {
    key: 'status',
    className: 'dab-avatar-dot',
    'data-tone': model.tone,
    title: dabT(model.toneLabelKey),
    'aria-hidden': 'true',
  }))
  if (model.taskTone !== null) {
    const taskLabel = dabT(model.taskToneLabelKey)
    children.push(h('span', {
      key: 'task',
      className: 'dab-avatar-task',
      'data-tone': model.taskTone,
      title: `${dabT('task')} · ${taskLabel}`,
    }, taskLabel))
  }

  const attributes = {
    className: 'dab-avatar',
    'data-role': model.roleId ?? 'generic',
    'data-tone': model.tone,
    'data-variant': model.variant,
    'data-selected': selected ? 'true' : 'false',
    'data-size': String(model.size),
    style: { '--dab-avatar-size': `${model.size}px` },
  }
  if (model.emblem !== null) attributes['data-emblem'] = model.emblem
  if (decorative) {
    attributes['aria-hidden'] = 'true'
  } else {
    attributes.role = 'img'
    attributes['aria-label'] = label
  }
  return h('span', attributes, children)
}


// ---- src/client/ui/card.js ----
/**
 * AgentCard: one compact card per agent. Pointer and keyboard go through the
 * shared click arbiter (single click = inspect, double click / Enter = open).
 * The branch toggle and the quick "open" button stop propagation so they never
 * trigger inspection or acknowledgement.
 *
 * Identity is expressed by the official mascot (`DabAgentAvatar`, from
 * ui/avatar.js) and the resolved DECLARED role; status stays on the existing
 * mark and dot, never on the role colour. The real activity (turn/step counters
 * the runtime reports) is shown as text when present: there is deliberately no
 * bar or percentage, because no reliable completion measure exists.
 *
 * @module dsh-agent-board/client/ui/card
 */

/**
 * Render the mascot when the avatar module is part of the bundle. `typeof` on an
 * undeclared global is safe, so a partial build never throws at render time.
 */
function dabMascot(h, props) {
  return typeof DabAgentAvatar === 'function' ? h(DabAgentAvatar, props) : null
}

function dabCardRole(node, resolved) {
  if (resolved !== null && resolved !== undefined) return resolved
  if (typeof dabResolveAgentRole === 'function') return dabResolveAgentRole(node.role)
  return { roleId: null, roleLabel: null, family: null, source: 'generic', raw: node.role ?? null }
}

function dabCardSignature(props) {
  const node = props.node
  const role = dabCardRole(node, props.role)
  return [
    node.id, node.status, node.seen, node.title, node.role, node.updatedAt, node.expectedAction, node.waitingDetail,
    node.model?.model, node.model?.provider, node.model?.reasoningEffort, node.model?.source, node.recentlyFinished,
    node.taskId, node.error, node.orphan, node.parentCycle, node.parentReason, node.interrupted, node.providerUnavailable,
    node.projectId, node.projectTitle, node.origin,
    node.activity?.turns, node.activity?.steps,
    role?.roleId, role?.roleLabel, role?.family, role?.source,
    props.selected, props.root, props.hiddenChildren, props.totalChildren, props.collapsed, props.expanded, props.groupActive,
    props.depth, props.compact, props.nowBucket, props.taskState, props.groupedProject,
  ].join('|')
}

function DabAgentCardImpl(props) {
  const { node, selected, root, arbiter, onToggleBranch, onRevealHidden, hiddenChildren, totalChildren, collapsed, expanded, groupActive, depth, compact, taskState, groupedProject } = props
  const h = React.createElement
  const role = dabCardRole(node, props.role)
  const roleText = role.roleLabel ?? (typeof node.role === 'string' && node.role !== '' ? node.role : null)
  const genericRole = role.roleId === null || role.roleId === undefined
  const familyText = typeof dabFamilyLabel === 'function' ? dabFamilyLabel(role.family) : null
  const taskLabel = typeof dabTaskStateLabel === 'function' && typeof taskState === 'string' ? dabTaskStateLabel(taskState) : null
  const modelLabel = dabModelText(node.model)
  const age = dabFormatAge(node.updatedAt)
  const statusText = dabStatusLabel(node.status)
  const projectText = node.projectId === 'unassigned' ? dabT('unassigned') : (typeof node.projectTitle === 'string' ? node.projectTitle : null)
  const activity = node.activity !== null && node.activity !== undefined && (Number(node.activity.turns) > 0 || Number(node.activity.steps) > 0)
    ? { turns: Number(node.activity.turns) || 0, steps: Number(node.activity.steps) || 0 }
    : null
  const calm = !(node.status === 'running' || node.status === 'recovering' || node.status === 'waiting_user' || node.status === 'finished_unread' || node.status === 'interrupted' || node.status === 'provider_unavailable' || (node.status === 'failed' && node.seen !== true))
  const label = [node.title, statusText, roleText, projectText, taskLabel, groupActive ? dabT('groupActive') : null].filter(Boolean).join(' — ')

  const stop = event => { event.stopPropagation() }
  const mascot = dabMascot(h, {
    role: node.role,
    name: node.title,
    status: node.status,
    // The card renders its own linked-task chip in the meta row; the mascot
    // stays identity + status only (no duplicated task chip).
    taskState: null,
    size: compact ? 20 : 30,
    variant: compact ? 'compact' : 'full',
    decorative: true,
  })
  const top = h(
    'div', { className: 'dab-card-top', key: 'top' },
    h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', role: 'img', 'aria-label': statusText, title: statusText }),
    h('span', { className: 'dab-name', title: node.title }, node.title),
    h('button', {
      type: 'button', className: 'dab-icon-btn dab-quick', title: dabT('openSession'), 'aria-label': `${dabT('openSession')} : ${node.title}`,
      onClick: event => { stop(event); arbiter.open(node.id) },
      onDoubleClick: stop, onKeyDown: stop,
    }, '↗'),
  )
  const meta = []
  // Row 1 = identity: role (and the model chip for root cards). The family is
  // identity context too, but it is already part of the role tooltip and of the
  // inspector; keeping it out of the row leaves room for the model.
  // Role identity. A declared role that resolves to nothing gets ONE neutral
  // chip (never a guessed role, never a role colour); the raw declared string
  // stays in the tooltip. Compact cards only keep the raw name when present.
  if (genericRole) {
    if (compact !== true) {
      meta.push(h('span', {
        key: 'role',
        className: 'dab-role-chip',
        'data-resolution': 'generic',
        'data-role': 'generic',
        title: [dabT('role'), dabT('noDeclaredRole'), dabT('genericIdentity'),
          role.raw !== null && role.raw !== undefined && role.raw !== '' ? `(${role.raw})` : null]
          .filter(Boolean).join(' · '),
      }, dabT('noDeclaredRole')))
    } else if (roleText !== null) {
      meta.push(h('span', {
        key: 'role',
        className: 'dab-role-chip',
        'data-resolution': 'generic',
        'data-role': 'generic',
        title: [dabT('role'), roleText, dabT('genericIdentity')].filter(Boolean).join(' · '),
      }, roleText))
    }
  } else if (roleText !== null) {
    meta.push(h('span', {
      key: 'role',
      className: 'dab-role-chip',
      'data-resolution': role.source ?? 'generic',
      'data-role': role.roleId ?? 'generic',
      title: [dabT('role'), roleText, familyText, role.raw !== null && role.raw !== undefined && role.raw !== roleText ? `(${role.raw})` : null]
        .filter(Boolean).join(' · '),
    }, roleText))
  }
  // Compact model chip: the card's provider/model fact, never a guess. It shares
  // the identity row with the role, so the work facts keep their own row.
  if (root || roleText === null) {
    meta.push(h('span', {
      key: 'model',
      className: 'dab-chip',
      'data-source': typeof node.model?.source === 'string' ? node.model.source : 'unknown',
      title: dabModelTitle(node.model),
    }, modelLabel ?? dabT('noModel')))
  }
  // Row 2 = work facts: the project context (only when the card is not already
  // grouped inside that project), the linked task, its Task Board state and the
  // age. The row may wrap; it is never clipped mid-line.
  const work = []
  // The project is already the section title when the card is grouped inside its
  // project (tree, compact grid, hierarchy): the chip would only steal width
  // from the task/age facts. It stays in the aria-label and the inspector.
  if (projectText !== null && groupedProject !== true) {
    work.push(h('span', { key: 'project', className: 'dab-project-line', title: `${dabT('project')} : ${projectText}` }, projectText))
  }
  if (node.taskId) work.push(h('span', { key: 'task', className: 'dab-mono', title: `${dabT('task')} ${node.taskId}` }, node.taskId))
  // The linked Task Board state is a SEPARATE vocabulary from the agent status.
  // Rendered only when the integration really reported the state.
  if (taskLabel !== null) {
    work.push(h('span', {
      key: 'taskState',
      className: 'dab-task-chip',
      'data-state': taskState,
      'data-tone': typeof AGENT_TASK_STATE_TONE === 'object' ? AGENT_TASK_STATE_TONE[taskState] ?? 'idle' : 'idle',
      title: `${dabT('taskStateTitle')} — ${taskLabel}`,
    }, h('span', { className: 'dab-task-dot', 'aria-hidden': 'true' }), taskLabel))
  }
  if (age !== '') work.push(h('span', { key: 'age', title: node.updatedAt ? new Date(node.updatedAt).toLocaleString() : '' }, age))
  if (node.orphan) work.push(h('span', { key: 'orphan', title: dabT('orphan') }, `⚠ ${dabT('orphan')}`))
  if (node.parentCycle) work.push(h('span', { key: 'cycle', title: dabT('cycle') }, `⚠ ${dabT('cycle')}`))
  if (node.parentContested) work.push(h('span', { key: 'contested', title: `${dabT('cycle')} · ${(node.parentCandidates ?? []).join(', ')}` }, `⚠ ${dabT('contest')}`))
  const withSeparators = items => {
    const out = []
    items.forEach((item, index) => {
      if (index > 0) out.push(h('span', { key: `sep-${index}`, className: 'dab-sep', 'aria-hidden': 'true' }))
      out.push(item)
    })
    return out
  }
  const metaWithSeps = withSeparators(meta)
  const workWithSeps = withSeparators(work)

  const foot = []
  if (!compact && totalChildren > 0) {
    if (hiddenChildren > 0 && !collapsed) {
      foot.push(h('button', {
        key: 'reveal', type: 'button', className: 'dab-pill', 'data-tone': groupActive ? 'running' : undefined,
        'aria-label': `${dabT('expand')} : ${hiddenChildren} ${dabT('hidden')}`,
        onClick: event => { stop(event); onRevealHidden(node.id) },
        onDoubleClick: stop, onKeyDown: stop,
      }, groupActive ? h('span', { className: 'dab-group-ring', 'aria-hidden': 'true' }) : null, `+${hiddenChildren} ${dabT('hidden')}`))
    }
    foot.push(h('button', {
      key: 'toggle', type: 'button', className: 'dab-pill', 'aria-expanded': !collapsed,
      'aria-label': `${collapsed ? dabT('expand') : dabT('collapse')} (${totalChildren} ${dabT('children')})`,
      title: collapsed ? dabT('expand') : dabT('collapse'),
      onClick: event => { stop(event); onToggleBranch(node.id, collapsed, expanded) },
      onDoubleClick: stop, onKeyDown: stop,
    }, collapsed ? `▸ ${totalChildren}` : `▾ ${totalChildren}`))
  } else if (groupActive) {
    foot.push(h('span', { key: 'grp', className: 'dab-muted' }, h('span', { className: 'dab-group-ring', 'aria-hidden': 'true' }), dabT('groupActive')))
  }
  // REAL activity only: the runtime counters, never a percentage or a bar.
  if (activity !== null) {
    const activityText = typeof dabTurnStepLabel === 'function'
      ? dabTurnStepLabel(activity.turns, activity.steps)
      : `${activity.turns} ${dabT('turns')} · ${activity.steps} ${dabT('steps')}`
    foot.push(h('span', {
      key: 'activity',
      className: 'dab-activity',
      title: dabT('activityReal', { activity: activityText }),
    }, activityText))
  }

  const ident = [top]
  if (metaWithSeps.length > 0) ident.push(h('div', { className: 'dab-meta', key: 'meta' }, metaWithSeps))
  if (workWithSeps.length > 0) ident.push(h('div', { className: 'dab-meta dab-meta-work', key: 'work' }, workWithSeps))
  if (node.status === 'waiting_user') {
    ident.push(h('div', { className: 'dab-wait', key: 'wait', title: node.waitingDetail ?? '' }, node.waitingDetail ?? dabWaitingLabel(node.expectedAction)))
  }
  if (node.status === 'failed' && node.seen !== true) {
    ident.push(h('div', { className: 'dab-err', key: 'err', title: node.error ?? '' }, node.error ?? dabStatusLabel('failed')))
  }
  if (foot.length > 0) ident.push(h('div', { className: 'dab-card-foot', key: 'foot' }, foot))

  return h('div', {
    className: 'dab-card',
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    'aria-pressed': selected ? 'true' : 'false',
    'data-node-id': node.id,
    'data-status': node.status,
    'data-seen': node.seen === true ? 'true' : 'false',
    'data-root': root ? 'true' : 'false',
    'data-selected': selected ? 'true' : 'false',
    'data-calm': calm ? 'true' : 'false',
    'data-role': role.roleId ?? 'generic',
    'data-role-resolution': role.source ?? 'generic',
    'data-task-state': taskLabel === null ? undefined : taskState,
    // Non-status view hint: the turn really completed inside the recent window.
    'data-recent': node.recentlyFinished === true ? 'true' : 'false',
    'data-depth': String(depth ?? 0),
    title: dabT('keyboardHint'),
    onClick: event => arbiter.click(node.id, event.detail),
    onDoubleClick: event => { event.preventDefault(); arbiter.doubleClick(node.id) },
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (arbiter.key(node.id, event.key)) event.preventDefault()
    },
  },
  mascot === null
    ? ident
    : h('div', { className: 'dab-card-main' },
      h('span', { className: 'dab-card-mascot', 'aria-hidden': 'true' }, mascot),
      h('div', { className: 'dab-card-ident' }, ident)),
  )
}

const DabAgentCard = React.memo(DabAgentCardImpl, (a, b) => dabCardSignature(a) === dabCardSignature(b) && a.arbiter === b.arbiter)


// ---- src/client/ui/hierarchy.js ----
/**
 * Supervision band and hierarchy view (presentational, pure props).
 *
 * `DabSupervisionBand` renders the host supervision LAYER (not an agent): the
 * super-orchestrator mascot, the real mode, the aggregate counts, the blocking
 * items, the cross-project dependency count, the recommendations (explicitly
 * tagged "proposal — not applied") and the capability matrix, where every
 * unavailable capability shows its reason. It is collapsible, keyboard
 * reachable, and stacks on narrow panels.
 *
 * `DabHierarchyView` renders workspace -> project -> orchestrator -> agents. A
 * project without a DECLARED orchestrator shows an explicit gap: the board never
 * creates an agent. Grouped compact cards reuse `DabAgentCard`; there is no
 * full-width connector line and no raw HTML sink anywhere.
 *
 * @module dsh-agent-board/client/ui/hierarchy
 */

const DAB_SUPERVISION_BODY_ID = 'dab-supervision-body'

/** The seven capabilities of the supervision contract, in display order. */
const DAB_CAPABILITY_ROWS = Object.freeze([
  ['observe', 'capObserve'],
  ['recommend', 'capRecommend'],
  ['delegate', 'capDelegate'],
  ['reassign', 'capReassign'],
  ['priority', 'capPriority'],
  ['receiveOrchestratorReports', 'capReceiveReports'],
  ['kanbanWrite', 'capKanbanWrite'],
])

/**
 * Map one capability value to a visible state and an explicit reason. An absent
 * value is unavailable, never assumed available. The host's own reason (a real
 * code such as `taskboard_write_api_unavailable`) wins over a generic label.
 */
function dabCapabilityEntry(key, capabilities, reasons) {
  const missing = capabilities === null || capabilities === undefined
  const value = missing ? undefined : capabilities[key]
  const hosted = reasons !== null && reasons !== undefined && typeof reasons[key] === 'string' && reasons[key] !== ''
    ? reasons[key]
    : null
  const withReason = (labelKey, available, fallbackKey) => ({ labelKey, available, reasonKey: hosted === null ? fallbackKey : null, reason: hosted })
  if (value === true) return { labelKey: 'capabilityAvailable', available: true, reasonKey: null, reason: null }
  if (value === 'gated') return withReason('capabilityGated', true, 'capReasonGated')
  if (value === 'proposal_only') return withReason('capabilityProposalOnly', false, 'capReasonProposalOnly')
  if (value === 'unavailable' || value === false) {
    if (key === 'kanbanWrite') return withReason('capabilityUnavailable', false, 'capReasonReadOnly')
    if (key === 'receiveOrchestratorReports') return withReason('capabilityUnavailable', false, 'capReasonNoChannel')
    if (key === 'delegate') return withReason('capabilityUnavailable', false, 'capReasonDisabled')
    if (key === 'reassign' || key === 'priority') return withReason('capabilityUnavailable', false, 'capReasonProposalOnly')
    return withReason('capabilityUnavailable', false, 'capReasonDisabled')
  }
  return {
    labelKey: 'capabilityUnavailable',
    available: false,
    reasonKey: missing ? 'capReasonSupervisionUnavailable' : 'capReasonUnknown',
    reason: null,
  }
}

function dabCounter(h, key, tone, value, label) {
  if (!(value > 0)) return null
  return h('span', { key, className: 'dab-counter', title: `${value} ${label}`, 'aria-label': `${value} ${label}` },
    h('span', { className: 'dab-dot', 'data-tone': tone }), h('b', null, value))
}

/** Translated singular/plural label for a count (never "1 projets"). */
function dabCountText(count, singularKey, pluralKey) {
  return typeof dabCountLabel === 'function'
    ? dabCountLabel(count, singularKey, pluralKey)
    : `${Number(count) || 0} ${dabT(Math.abs(Number(count)) === 1 ? singularKey : pluralKey)}`
}

/** Noun only, for counters that render the number themselves. */
function dabCountNounText(count, singularKey, pluralKey) {
  return typeof dabCountNoun === 'function'
    ? dabCountNoun(count, singularKey, pluralKey)
    : dabT(Math.abs(Number(count)) === 1 ? singularKey : pluralKey)
}

function dabModeLabel(mode) {
  if (mode === 'off' || mode === 'supervised' || mode === 'autonomous') return dabT(mode)
  return null
}

function dabWorkspaceStatusChip(h, workspace) {
  return h('span', {
    className: 'dab-sup-status',
    'data-status': workspace.status,
    title: workspace.statusReason === null || workspace.statusReason === undefined
      ? dabSupervisionStatusLabel(workspace.status)
      : `${dabSupervisionStatusLabel(workspace.status)} · ${workspace.statusReason}`,
  }, h('span', { className: 'dab-dot', 'data-tone': 'idle', 'aria-hidden': 'true' }),
  dabSupervisionStatusLabel(workspace.status))
}

function dabBlockList(h, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return h('div', { className: 'dab-muted' }, dabT('supervisionNoBlocks'))
  return h('ul', { className: 'dab-list dab-band-list' }, blocks.slice(0, 20).map(block => h('li', { key: String(block.id) },
    h('span', { className: 'dab-tag', title: block.source ?? '' }, String(block.source ?? '?')),
    h('span', { className: 'dab-grow' }, String(block.reason ?? '')),
    block.taskId ? h('span', { className: 'dab-mono' }, String(block.taskId)) : null,
    block.agentId ? h('span', { className: 'dab-mono' }, String(block.agentId)) : null)))
}

function dabDependencyList(h, dependencies, projects) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) return h('div', { className: 'dab-muted' }, dabT('supervisionNoDependencies'))
  const titleOf = id => projects.find(project => project.id === id)?.title ?? String(id)
  return h('ul', { className: 'dab-list dab-band-list' }, dependencies.slice(0, 20).map(dependency => h('li', { key: String(dependency.id) },
    h('span', { className: 'dab-grow dab-mono' },
      `${titleOf(dependency.fromProjectId)} (${String(dependency.fromTaskId)}) → ${titleOf(dependency.toProjectId)} (${String(dependency.toTaskId)})`))))
}

function dabRecommendationList(h, recommendations, projects) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return h('div', { className: 'dab-muted' }, dabT('supervisionNoRecommendations'))
  const titleOf = id => projects.find(project => project.id === id)?.title ?? String(id)
  return h('ul', { className: 'dab-list dab-band-list' }, recommendations.slice(0, 20).map(recommendation => h('li', { key: String(recommendation.id) },
    // Never an action: a recommendation is a proposal the host would have to
    // apply, and it states so explicitly.
    h('span', { className: 'dab-tag', 'data-tone': 'proposal', title: dabT('recommendationNotApplied') }, dabT('recommendationNotApplied')),
    h('span', { className: 'dab-grow' },
      `${dabRecommendationLabel(recommendation.kind)} · ${titleOf(recommendation.projectId)}`,
      recommendation.reason ? h('span', { className: 'dab-muted' }, ` — ${String(recommendation.reason)}`) : null),
    recommendation.taskId ? h('span', { className: 'dab-mono' }, String(recommendation.taskId)) : null)))
}

function dabCapabilityMatrix(h, capabilities, reasons) {
  return h('div', { className: 'dab-cap-grid', role: 'list', 'aria-label': dabT('supervisionCapabilities') },
    DAB_CAPABILITY_ROWS.map(([key, labelKey]) => {
      const entry = dabCapabilityEntry(key, capabilities, reasons)
      return h('div', {
        key, role: 'listitem', className: 'dab-cap-row',
        'data-available': entry.available ? 'true' : 'false',
        'data-capability': key,
      },
      h('span', { className: 'dab-cap-label' }, dabT(labelKey)),
      h('span', { className: 'dab-cap-value', 'data-available': entry.available ? 'true' : 'false' }, dabT(entry.labelKey)),
      entry.reasonKey === null && entry.reason === null
        ? null
        : h('span', { className: 'dab-cap-reason' }, h('span', { className: 'dab-cap-reason-label' }, `${dabT('supervisionCapabilityReason')} : `), entry.reason ?? dabT(entry.reasonKey)))
    }))
}

/**
 * The supervision band (host supervision layer). Collapsed by default when a
 * single project exists: the caller owns the persisted open state.
 */
function DabSupervisionBand({ workspace, totals, projects, open, onToggle }) {
  const h = React.createElement
  const mode = dabModeLabel(workspace.mode)
  const counters = [
    dabCounter(h, 'projects', 'idle', totals.projects, dabCountNounText(totals.projects, 'projectSingular', 'projectPlural')),
    dabCounter(h, 'agents', 'idle', totals.agents, dabCountNounText(totals.agents, 'agentSingular', 'agentPlural')),
    dabCounter(h, 'running', 'running', totals.running, dabT('running')),
    dabCounter(h, 'waiting', 'waiting', totals.waiting, dabT('waiting')),
    dabCounter(h, 'unread', 'unread', totals.unread, dabCountNounText(totals.unread, 'unreadSingular', 'unreadPlural')),
    dabCounter(h, 'failed', 'failed', totals.failed, dabT('failed')),
    dabCounter(h, 'interrupted', 'waiting', totals.interrupted, dabCountNounText(totals.interrupted, 'interruptedSingular', 'interruptedPlural')),
    dabCounter(h, 'blocked', 'failed', totals.blocked, dabCountNounText(totals.blocked, 'blockedSingular', 'blockedPlural')),
  ].filter(Boolean)
  const header = h('button', {
    type: 'button',
    className: 'dab-band-head',
    'aria-expanded': open,
    'aria-controls': DAB_SUPERVISION_BODY_ID,
    title: open ? dabT('supervisionCollapse') : dabT('supervisionExpand'),
    onClick: onToggle,
  },
  h('span', { className: 'dab-band-mascot', 'aria-hidden': 'true' },
    dabMascot(h, {
      role: 'super_orchestrator', emblem: workspace.emblem, name: dabT('superOrchestrator'),
      // The supervision layer has no agent status: the dot stays neutral and
      // the real layer status is the separate chip below.
      status: 'unknown', size: 34, variant: 'compact', decorative: true,
    })),
  h('span', { className: 'dab-band-ident' },
    h('span', { className: 'dab-band-title' }, dabT('supervision'), workspace.synthetic ? h('span', { className: 'dab-tag' }, dabT('supervisionLayer')) : null),
    h('span', { className: 'dab-band-sub' }, mode === null ? null : h('span', { className: 'dab-tag' }, `${dabT('supervisionMode')} : ${mode}`), dabWorkspaceStatusChip(h, workspace))),
  h('span', { className: 'dab-band-counters' }, counters),
  h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'))

  // The body is ALWAYS rendered (hidden when collapsed): `aria-controls` must
  // never point at a missing element, and the hidden attribute is enough.
  const body = h('div', { className: 'dab-band-body', id: DAB_SUPERVISION_BODY_ID, hidden: !open },
    workspace.available ? null : h('div', { className: 'dab-band-notice' }, dabT('supervisionUnavailable')),
    // A Task Board that cannot be read is REPORTED here, not silently missing.
    workspace.taskboard !== null && workspace.taskboard !== undefined && workspace.taskboard.available === false
      ? h('div', { className: 'dab-band-notice', title: String(workspace.taskboard.reason ?? '') },
        `${dabT('taskboardUnavailable')}${workspace.taskboard.reason ? ` — ${String(workspace.taskboard.reason)}` : ''}`)
      : null,
    h('div', { className: 'dab-muted' }, dabT('supervisionSynthetic')),
    workspace.agent !== null && workspace.agent !== undefined
      ? h('div', { className: 'dab-band-agent' },
        h('span', { className: 'dab-label' }, `${dabT('superOrchestrator')} : `),
        h('span', null, String(workspace.agent.name ?? workspace.agent.id ?? '')),
        workspace.agent.status ? h('span', { className: 'dab-tag' }, dabStatusLabel(workspace.agent.status)) : null)
      : null,
    workspace.delegation === null || workspace.delegation === undefined
      ? null
      : h('div', { className: 'dab-muted' }, dabT('supervisionDelegation', {
        inFlight: Number(workspace.delegation.inFlight) || 0,
        depth: workspace.delegation.depthLimit ?? '?',
        concurrent: workspace.delegation.concurrentLimit ?? '?',
        hourly: workspace.delegation.hourlyLimit ?? '?',
      })),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionRecommendations')} (${Array.isArray(workspace.recommendations) ? workspace.recommendations.length : 0})`),
      dabRecommendationList(h, workspace.recommendations, projects)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionBlocks')} (${Array.isArray(workspace.blocks) ? workspace.blocks.length : 0})`),
      dabBlockList(h, workspace.blocks)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, `${dabT('supervisionDependencies')} (${Number(totals.dependencies) || 0})`),
      dabDependencyList(h, workspace.crossProjectDependencies, projects)),
    h('div', { className: 'dab-band-section' },
      h('div', { className: 'dab-label' }, dabT('supervisionCapabilities')),
      dabCapabilityMatrix(h, workspace.capabilities, workspace.capabilityReasons)))

  return h('section', {
    className: 'dab-band',
    'data-available': workspace.available ? 'true' : 'false',
    'data-status': workspace.status,
    'aria-label': dabT('supervision'),
  }, header, body)
}

/** Project head counters: the REAL counts, not the visible-card count. */
function dabProjectCounters(h, counts) {
  return h('span', { className: 'dab-hier-counts' },
    dabCounter(h, 'r', 'running', counts.running, dabT('running')),
    dabCounter(h, 'w', 'waiting', counts.waiting, dabT('waiting')),
    dabCounter(h, 'u', 'unread', counts.unread, dabCountNounText(counts.unread, 'unreadSingular', 'unreadPlural')),
    dabCounter(h, 'f', 'failed', counts.failed, dabT('failed')),
    dabCounter(h, 'i', 'waiting', counts.interrupted, dabCountNounText(counts.interrupted, 'interruptedSingular', 'interruptedPlural')))
}

function dabHierarchyCard(h, entry, ctx, compact) {
  const node = entry.node
  return h(DabAgentCard, {
    key: node.id,
    node,
    depth: entry.depth,
    root: false,
    compact: compact === true,
    selected: ctx.selectedId === node.id,
    arbiter: ctx.arbiter,
    hiddenChildren: entry.hiddenChildren,
    totalChildren: entry.totalChildren,
    collapsed: entry.collapsed,
    expanded: entry.expanded,
    groupActive: entry.groupActive,
    onToggleBranch: ctx.onToggleBranch,
    onRevealHidden: ctx.onRevealHidden,
    nowBucket: ctx.nowBucket,
    role: ctx.roles instanceof Map ? ctx.roles.get(node.id) ?? null : null,
    taskState: node.taskId !== null && node.taskId !== undefined && ctx.taskStates instanceof Map
      ? ctx.taskStates.get(String(node.taskId)) ?? null
      : null,
    groupedProject: true,
  })
}

function DabHierarchyTeam({ team, ctx, compact }) {
  const h = React.createElement
  const rootIncluded = team.agents.some(node => node.id === team.root.id)
  const caption = rootIncluded ? null : h('div', { className: 'dab-hier-team-title' }, dabT('hierarchyTeamOf', { name: team.root.title }))
  return h('div', { className: 'dab-hier-team', 'data-root-id': team.root.id },
    caption,
    team.hidden > 0 ? h('div', { className: 'dab-hier-team-note' }, dabT('hierarchyHiddenByFilter', { n: team.hidden })) : null,
    h('div', { className: 'dab-hier-cards' }, team.entries.map(entry => dabHierarchyCard(h, entry, ctx, compact))))
}

function DabHierarchyProject({ project, ctx, compact, filtersActive }) {
  const h = React.createElement
  const title = project.unassigned ? dabT('unassigned') : project.title
  const orchestrator = project.orchestrator
  // Real counts stay real; when the board view displays fewer (attention policy
  // or filters), the head says both instead of showing one view's number only.
  const shownAgents = project.teams.reduce((sum, team) => sum + team.agents.length, 0)
  const countLabel = typeof projectCountLabel === 'function'
    ? projectCountLabel(project.counts, shownAgents, dabT)
    : `${dabCountText(project.counts.agents, 'agentSingular', 'agentPlural')}${project.counts.agents === shownAgents ? '' : ` · ${dabCountText(shownAgents, 'shownSingular', 'shownPlural')}`}`
  return h('section', { className: 'dab-hier-project', 'data-project-id': project.id, 'aria-label': title },
    h('button', {
      type: 'button', className: 'dab-hier-project-head', 'aria-expanded': !project.folded,
      title: project.folded ? dabT('expand') : dabT('collapse'),
      onClick: () => ctx.onFoldProject(project),
    },
    h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, project.folded ? '▸' : '▾'),
    h('span', { className: 'dab-hier-project-title' }, title),
    h('span', { className: 'dab-project-count' }, countLabel),
    orchestrator === null || orchestrator === undefined
      ? h('span', {
        className: 'dab-hier-orch',
        'data-gap': 'true',
        title: dabT('hierarchyOrchestratorMissingHint'),
      }, h('span', { className: 'dab-gap-dot', 'aria-hidden': 'true' }), dabT('hierarchyOrchestratorMissing'))
      : h('span', { className: 'dab-hier-orch', title: `${dabT('orchestratorLabel')} : ${orchestrator.name}` },
        dabMascot(h, { role: orchestrator.role, name: orchestrator.name, status: orchestrator.status, size: 20, variant: 'compact', decorative: true }),
        h('span', null, orchestrator.name)),
    dabProjectCounters(h, project.counts)),
    project.folded ? null : h('div', { className: 'dab-hier-body' },
      project.teams.length === 0
        ? h('div', { className: 'dab-muted' }, filtersActive ? dabT('hierarchyEmpty') : dabT('hierarchyNoAgents'))
        : project.teams.map(team => h(DabHierarchyTeam, { key: team.root.id, team, ctx, compact })),
      project.blocks.length > 0
        ? h('div', { className: 'dab-hier-notes' },
          h('div', { className: 'dab-label' }, `${dabT('supervisionBlocks')} (${project.blocks.length})`),
          dabBlockList(h, project.blocks))
        : null,
      project.crossProjectDependencies.length > 0
        ? h('div', { className: 'dab-hier-notes' },
          h('div', { className: 'dab-label' }, `${dabT('supervisionDependencies')} (${project.crossProjectDependencies.length})`),
          dabDependencyList(h, project.crossProjectDependencies, [] ))
        : null))
}

/**
 * Workspace -> project -> orchestrator -> agents. No full-width connector line,
 * no auto-created agent, no HTML sink.
 */
function DabHierarchyView({ hierarchy, ctx, compact }) {
  const h = React.createElement
  const workspace = hierarchy.workspace
  const mode = dabModeLabel(workspace.mode)
  const filters = hierarchy.filters ?? {}
  const filtersActive = (filters.role ?? null) !== null || (filters.status ?? null) !== null || (filters.taskState ?? null) !== null
  const workspaceHead = h('section', { className: 'dab-hier-ws', 'aria-label': dabT('supervisionWorkspace') },
    h('div', { className: 'dab-hier-ws-head' },
      h('span', { className: 'dab-hier-ws-mascot', 'aria-hidden': 'true' },
        dabMascot(h, { role: 'super_orchestrator', emblem: workspace.emblem, name: dabT('superOrchestrator'), status: 'unknown', size: 40, variant: 'compact', decorative: true })),
      h('div', { className: 'dab-hier-ws-text' },
        h('div', { className: 'dab-hier-ws-title' }, dabT('supervisionWorkspace'),
          h('span', { className: 'dab-tag' }, dabT('supervisionLayer')),
          mode === null ? null : h('span', { className: 'dab-tag' }, `${dabT('supervisionMode')} : ${mode}`),
          dabWorkspaceStatusChip(h, workspace)),
        h('div', { className: 'dab-hier-ws-sub' },
          h('span', null, `${dabCountText(hierarchy.totals.agents, 'agentSingular', 'agentPlural')} · ${dabCountText(hierarchy.totals.projects, 'projectSingular', 'projectPlural')}`),
          h('span', { className: 'dab-hier-counts' },
            dabCounter(h, 'r', 'running', hierarchy.totals.running, dabT('running')),
            dabCounter(h, 'w', 'waiting', hierarchy.totals.waiting, dabT('waiting')),
            dabCounter(h, 'u', 'unread', hierarchy.totals.unread, dabCountNounText(hierarchy.totals.unread, 'unreadSingular', 'unreadPlural')),
            dabCounter(h, 'f', 'failed', hierarchy.totals.failed, dabT('failed')))))),
    workspace.available ? null : h('div', { className: 'dab-band-notice' }, dabT('supervisionUnavailable')))

  const empty = hierarchy.projects.length === 0
    ? h('div', { className: 'dab-empty' }, filtersActive ? dabT('hierarchyEmpty') : dabT('hierarchyNoAgents'))
    : null

  return h('div', { className: 'dab-hier', 'data-compact': compact ? 'true' : 'false' },
    workspaceHead,
    empty,
    empty === null
      ? h('div', { className: 'dab-hier-projects' }, hierarchy.projects.map(project => h(DabHierarchyProject, { key: project.id, project, ctx, compact, filtersActive })))
      : null)
}


// ---- src/client/ui/tree.js ----
/**
 * AgentTree / ProjectGroup / CompactGrid: render the pure board view
 * (board/view.js) as family trees grouped by project, or as a compact grid
 * still grouped by project and by root parent.
 *
 * @module dsh-agent-board/client/ui/tree
 */

function dabEntryRole(ctx, node) {
  if (ctx.roles instanceof Map) return ctx.roles.get(node.id) ?? null
  return null
}

function dabEntryTaskState(ctx, node) {
  if (node.taskId === null || node.taskId === undefined) return null
  if (ctx.taskStates instanceof Map) return ctx.taskStates.get(String(node.taskId)) ?? null
  return null
}

function DabTreeBranch({ entry, ctx }) {
  const h = React.createElement
  const node = entry.node
  return h(
    'li', { className: 'dab-branch', role: 'treeitem', 'aria-expanded': entry.totalChildren > 0 ? !entry.collapsed : undefined, 'aria-level': entry.depth + 1 },
    h(DabAgentCard, {
      node,
      depth: entry.depth,
      root: entry.depth === 0,
      selected: ctx.selectedId === node.id,
      arbiter: ctx.arbiter,
      hiddenChildren: entry.hiddenChildren,
      totalChildren: entry.totalChildren,
      collapsed: entry.collapsed,
      expanded: entry.expanded,
      groupActive: entry.groupActive,
      onToggleBranch: ctx.onToggleBranch,
      onRevealHidden: ctx.onRevealHidden,
      nowBucket: ctx.nowBucket,
      role: dabEntryRole(ctx, node),
      taskState: dabEntryTaskState(ctx, node),
      groupedProject: true,
    }),
    entry.children.length > 0
      ? h('ul', { className: 'dab-kids', role: 'group' }, entry.children.map(child => h(DabTreeBranch, { key: child.node.id, entry: child, ctx })))
      : null,
  )
}

/** Parent → child pairs of the visible tree (render order). */
function dabEdgesOf(entry, out = []) {
  for (const child of entry.children) {
    out.push({ from: entry.node.id, to: child.node.id, active: child.aggregate?.running === true || child.node.status === 'running' })
    dabEdgesOf(child, out)
  }
  return out
}

/**
 * Smooth node-graph link between two card rectangles (tile coordinates).
 * Horizontal layout: right-middle of the parent → left-middle of the child.
 * Stacked (narrow) layout: below the parent's mark → left-middle of the child.
 */
function dabLinkPath(a, b) {
  if (b.left >= a.right - 1) {
    const x1 = a.right
    const y1 = a.top + Math.min(24, a.height / 2)
    const x2 = b.left
    const y2 = b.top + Math.min(24, b.height / 2)
    const dx = Math.max(12, (x2 - x1) * 0.55)
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
  }
  const x1 = a.left + 16
  const y1 = a.bottom
  const x2 = b.left
  const y2 = b.top + Math.min(18, b.height / 2)
  return `M${x1},${y1} C${x1},${y2} ${x1},${y2} ${x2},${y2}`
}

function DabAgentTree({ entry, ctx }) {
  const h = React.createElement
  const tileRef = React.useRef(null)
  const [links, setLinks] = React.useState({ paths: [], width: 0, height: 0 })
  const edges = dabEdgesOf(entry)
  const edgeKey = edges.map(edge => `${edge.from}>${edge.to}:${edge.active ? 1 : 0}`).join('|')

  React.useLayoutEffect(() => {
    const tile = tileRef.current
    if (tile === null) return undefined
    const measure = () => {
      const base = tile.getBoundingClientRect()
      const rectOf = id => {
        const element = tile.querySelector(`.dab-card[data-node-id="${CSS.escape(id)}"]`)
        if (element === null) return null
        const r = element.getBoundingClientRect()
        const left = r.left - base.left + tile.scrollLeft
        const top = r.top - base.top + tile.scrollTop
        return { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height }
      }
      const paths = []
      for (const edge of edges) {
        const a = rectOf(edge.from)
        const b = rectOf(edge.to)
        if (a !== null && b !== null) paths.push({ key: `${edge.from}>${edge.to}`, d: dabLinkPath(a, b), active: edge.active })
      }
      setLinks({ paths, width: tile.scrollWidth, height: tile.scrollHeight })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => measure())
    observer.observe(tile)
    return () => observer.disconnect()
  }, [edgeKey, ctx.selectedId])

  return h('div', { className: 'dab-tile', ref: tileRef },
    links.paths.length > 0
      ? h('svg', { className: 'dab-links', width: links.width, height: links.height, 'aria-hidden': 'true' },
        links.paths.map(link => h('path', { key: link.key, d: link.d, 'data-active': link.active ? 'true' : 'false' })))
      : null,
    h('ul', { className: 'dab-tree', role: 'tree', 'aria-label': entry.node.title },
      h(DabTreeBranch, { entry, ctx })))
}

function dabFlattenTree(entry, out = [], parentTitle = null) {
  out.push({ entry, parentTitle })
  for (const child of entry.children) dabFlattenTree(child, out, entry.node.title)
  return out
}

/**
 * The visible tree slice. `treeLimit` trims CALM trees only: a tree whose
 * subtree contains an agent waiting for the user is never hidden because it is
 * older than eight newer trees (the yellow card is the one thing that must
 * always be reachable without expanding a list).
 */
function dabVisibleTrees(project, treeLimit) {
  const head = project.trees.slice(0, treeLimit)
  const tail = project.trees.slice(treeLimit)
  const waiting = tail.filter(tree => (tree.aggregate?.bestTier ?? 9) === 0 || tree.node?.status === 'waiting_user')
  return waiting.length === 0 ? head : [...waiting, ...head]
}

function DabCompactProject({ project, ctx, trees }) {
  const h = React.createElement
  return h('div', null, trees.map(tree => {
    const flat = dabFlattenTree(tree)
    return h('div', { className: 'dab-compact-group', key: tree.node.id },
      tree.children.length > 0 || tree.hiddenChildren > 0
        ? h('div', { className: 'dab-compact-parent' }, `${tree.node.title}${tree.hiddenChildren > 0 ? ` · +${tree.hiddenChildren} ${dabT('hidden')}` : ''}`)
        : null,
      h('div', { className: 'dab-compact-grid' }, flat.map(({ entry }) => h(DabAgentCard, {
        key: entry.node.id,
        node: entry.node,
        depth: entry.depth,
        root: false,
        compact: true,
        selected: ctx.selectedId === entry.node.id,
        arbiter: ctx.arbiter,
        hiddenChildren: 0,
        totalChildren: 0,
        collapsed: false,
        expanded: false,
        groupActive: entry.groupActive,
        onToggleBranch: ctx.onToggleBranch,
        onRevealHidden: ctx.onRevealHidden,
        nowBucket: ctx.nowBucket,
        role: dabEntryRole(ctx, entry.node),
        taskState: dabEntryTaskState(ctx, entry.node),
        groupedProject: true,
      }))))
  }))
}

function DabProjectGroup({ project, ctx, folded, onFold, treeLimit, onMoreTrees, compact }) {
  const h = React.createElement
  const title = project.unassigned ? dabT('unassigned') : project.title
  const trees = folded ? [] : dabVisibleTrees(project, treeLimit)
  const hiddenTrees = Math.max(0, project.trees.length - trees.length)
  const summary = []
  if (project.summary.running > 0) summary.push(h('span', { key: 'r', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'running' }), project.summary.running))
  if (project.summary.waiting > 0) summary.push(h('span', { key: 'w', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'waiting' }), project.summary.waiting))
  if (project.summary.unread > 0) summary.push(h('span', { key: 'u', className: 'dab-counter' }, h('span', { className: 'dab-dot', 'data-tone': 'unread' }), project.summary.unread))
  // The declared project orchestrator, when the hierarchy projection found one.
  // A missing orchestrator is NOT rendered here as a fake node or a warning;
  // the hierarchy view owns the explicit gap.
  const orchestrator = project.orchestrator
  const orchestratorChip = orchestrator === null || orchestrator === undefined
    ? null
    : h('span', {
      className: 'dab-project-orch',
      title: `${dabT('orchestratorLabel')} : ${orchestrator.name}${orchestrator.role ? ` (${orchestrator.role})` : ''}`,
    },
    dabMascot(h, { role: orchestrator.role, name: orchestrator.name, status: orchestrator.status, size: 18, variant: 'compact', decorative: true }),
    h('span', { className: 'dab-project-orch-name' }, orchestrator.name))
  return h('section', { className: 'dab-project', 'data-project-id': project.id, 'aria-label': title },
    h('button', { type: 'button', className: 'dab-project-head', 'aria-expanded': !folded, onClick: () => onFold(project.id) },
      h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, folded ? '▸' : '▾'),
      h('span', null, title),
      h('span', { className: 'dab-project-count' }, `${project.visibleAgents} agent${project.visibleAgents > 1 ? 's' : ''}`),
      orchestratorChip,
      summary),
    folded
      ? null
      : compact
        ? h(DabCompactProject, { project, ctx, trees })
        : h('div', { className: 'dab-forest' }, trees.map(tree => h(DabAgentTree, { key: tree.node.id, entry: tree, ctx }))),
    !folded && hiddenTrees > 0
      ? h('div', { className: 'dab-more' }, h('button', { type: 'button', className: 'dab-btn', onClick: () => onMoreTrees(project.id) }, dabT('moreTrees', { n: hiddenTrees })))
      : null,
  )
}


// ---- src/client/ui/preview.js ----
/**
 * AgentPreview: the inspection panel opened by a single click. It shows the
 * last useful line of the agent's FINAL answer (never a tool call, a log line
 * or reasoning), "See more" for the bounded full excerpt, then secondary facts.
 *
 * @module dsh-agent-board/client/ui/preview
 */

function DabAgentPreview({ node, parent, onOpen, onSelect, onClose, openError, onDismiss, dismissed, role, taskState }) {
  const h = React.createElement
  const [more, setMore] = React.useState(false)
  React.useEffect(() => { setMore(false) }, [node?.id])
  if (node === null || node === undefined) return null
  const resolvedRole = role ?? (typeof dabResolveAgentRole === 'function' ? dabResolveAgentRole(node.role) : { roleId: null, roleLabel: null, family: null, source: 'generic', raw: node.role ?? null })
  const roleText = resolvedRole?.roleLabel ?? (typeof node.role === 'string' && node.role !== '' ? node.role : null)
  const roleFamily = typeof dabFamilyLabel === 'function' ? dabFamilyLabel(resolvedRole?.family) : null
  const taskLabel = typeof dabTaskStateLabel === 'function' && typeof taskState === 'string' ? dabTaskStateLabel(taskState) : null
  const preview = node.preview ?? { text: '', final: false }
  const hasFinal = preview.final === true && typeof preview.text === 'string' && preview.text !== ''
  const line = hasFinal ? lastUsefulLine(preview.text) : ''
  const facts = []
  const fact = (key, label, value, mono) => {
    if (value === null || value === undefined || value === '') return
    facts.push(h('dt', { key: `${key}-t` }, label), h('dd', { key: `${key}-d`, className: mono ? 'dab-mono' : undefined }, value))
  }
  fact('project', dabT('project'), node.projectId === 'unassigned' ? dabT('unassigned') : node.projectTitle)
  fact('role', dabT('role'), roleText === null ? null : `${roleText}${roleFamily ? ` · ${roleFamily}` : ''}${resolvedRole?.source === 'alias' ? ` (${dabT('roleDeclaredAlias')})` : ''}`)
  fact('taskState', dabT('taskStateTitle'), taskLabel)
  fact('provider', dabT('provider'), node.model?.provider, true)
  fact('model', dabT('model'), dabModelChipText(node.model), true)
  fact('modelSource', dabT('modelSource'), node.model?.source === 'unknown' ? null : (node.model.source === 'assignment' ? dabT('modelAssignment') : dabT('modelNative')))
  fact('task', dabT('task'), node.taskId, true)
  fact('goal', dabT('goal'), node.goal)
  if (parent !== null && parent !== undefined) {
    facts.push(h('dt', { key: 'parent-t' }, dabT('parent')), h('dd', { key: 'parent-d' },
      h('button', { type: 'button', className: 'dab-linkish', onClick: () => onSelect(parent.id) }, parent.title)))
  } else if (node.orphan) {
    fact('parent', dabT('parent'), `${dabT('orphan')} (${String(node.parentId).slice(-12)})`, true)
  } else if (node.parentCycle) {
    fact('parent', dabT('parent'), dabT('cycle'))
  } else if (node.parentContested) {
    fact('parent', dabT('parent'), `${dabT('contest')} (${(node.parentCandidates ?? []).join(', ')})`, true)
  }
  if (node.activity) fact('activity', dabT('activity'), dabTurnStepLabel(node.activity.turns, node.activity.steps))
  fact('cwd', dabT('directory'), node.cwd, true)
  fact('session', dabT('session'), node.id, true)
  // A route switch must stay visible: never show only the LAST provider.
  fact('previous', dabT('previousSession'), node.previousSessionId, true)
  const routes = Array.isArray(node.routeHistory) ? node.routeHistory : []
  if (routes.length > 0) {
    fact('routes', dabT('routeHistory'), routes.map(entry => `${entry.from ?? '?'} → ${entry.to ?? '?'}${entry.reason ? ` (${entry.reason})` : ''}`).join(' · '))
  }
  fact('reason', dabT('statusReason'), node.statusReason, true)
  if (node.status === 'recovering') {
    facts.push(h('dt', { key: 'rec-t' }, dabT('recovery')), h('dd', { key: 'rec-d', className: 'dab-alert' }, node.statusReason ?? ''))
  }
  if (node.status === 'interrupted') {
    facts.push(h('dt', { key: 'int-t' }, dabT('statusInterrupted')), h('dd', { key: 'int-d', className: 'dab-wait' }, node.statusReason ?? ''))
  }
  if (node.status === 'provider_unavailable') {
    facts.push(h('dt', { key: 'pu-t' }, dabT('statusProviderUnavailable')), h('dd', { key: 'pu-d', className: 'dab-alert' }, node.statusReason ?? ''))
  }

  return h('aside', { className: 'dab-inspector', 'aria-label': `${dabT('finalAnswer')} — ${node.title}`, 'data-inspector-for': node.id },
    h('div', { className: 'dab-insp-head' },
      h('h2', { className: 'dab-insp-title' }, node.title),
      h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', 'aria-label': dabT('close'), onClick: onClose }, '✕')),
    h('div', { className: 'dab-insp-status' },
      h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', 'aria-hidden': 'true' }),
      dabStatusLabel(node.status),
      // Compact provider/model chip, same tokens as the card. Unknown stays
      // explicit instead of borrowing the deployment default model.
      h('span', {
        className: 'dab-chip',
        'data-source': typeof node.model?.source === 'string' ? node.model.source : 'unknown',
        title: dabModelTitle(node.model),
      }, dabModelChipText(node.model) ?? dabT('noModel')),
      roleText !== null
        ? h('span', {
          className: 'dab-role-chip',
          'data-resolution': resolvedRole?.source ?? 'generic',
          title: [dabT('role'), roleText, roleFamily].filter(Boolean).join(' · '),
        }, roleText)
        : null,
      roleFamily !== null
        ? h('span', { className: 'dab-family-chip', title: `${dabT('roleFamilyLabel')} : ${roleFamily}` }, roleFamily)
        : null,
      taskLabel !== null
        ? h('span', {
          className: 'dab-task-chip',
          'data-state': taskState,
          'data-tone': typeof AGENT_TASK_STATE_TONE === 'object' ? AGENT_TASK_STATE_TONE[taskState] ?? 'idle' : 'idle',
          title: `${dabT('taskStateTitle')} — ${taskLabel}`,
        }, h('span', { className: 'dab-task-dot', 'aria-hidden': 'true' }), taskLabel)
        : null,
      node.origin === 'subagent' ? h('span', { className: 'dab-tag' }, dabT('subagent')) : null),
    node.status === 'waiting_user'
      ? h('div', { className: 'dab-wait', style: { whiteSpace: 'normal' } }, node.waitingDetail ?? dabWaitingLabel(node.expectedAction))
      : null,
    node.status === 'failed' && node.error ? h('div', { className: 'dab-alert' }, node.error) : null,
    h('div', { className: 'dab-label' }, dabT('finalAnswer')),
    h('p', { className: 'dab-answer', 'data-empty': hasFinal ? 'false' : 'true', 'data-testid': 'dab-answer' },
      hasFinal ? (more ? preview.text : line) : dabT('noFinal')),
    hasFinal && preview.text.trim() !== line
      ? h('button', { type: 'button', className: 'dab-linkish', 'aria-expanded': more, onClick: () => setMore(value => !value) }, more ? dabT('seeLess') : dabT('seeMore'))
      : null,
    !hasFinal && node.activity
      ? h('div', { className: 'dab-muted' }, `${dabT('activity')} : ${dabTurnStepLabel(node.activity.turns, node.activity.steps)}`)
      : null,
    h('div', { className: 'dab-actions' },
      h('button', { type: 'button', className: 'dab-btn', 'aria-pressed': 'false', onClick: () => onOpen(node.id), 'data-testid': 'dab-open' }, `↗ ${dabT('openSession')}`),
      parent ? h('button', { type: 'button', className: 'dab-btn', onClick: () => onOpen(parent.id) }, dabT('openParent')) : null,
      node.status !== 'running' && typeof onDismiss === 'function'
        ? h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', title: dabT('dismissHint'), onClick: () => onDismiss(node.id, !dismissed) }, dismissed ? dabT('undismiss') : dabT('dismiss'))
        : null),
    openError ? h('div', { className: 'dab-alert', role: 'status' }, openError) : null,
    h('dl', { className: 'dab-dl' }, facts),
  )
}


// ---- src/client/ui/history.js ----
/**
 * HistoryDrawer: on-demand, searchable, paginated list of every calm session
 * (idle, viewed, archived). It is computed only while open, from the in-memory
 * projection — no extra fetch, nothing deleted or archived.
 *
 * @module dsh-agent-board/client/ui/history
 */

const DAB_HISTORY_PAGE = 30

function DabHistoryDrawer({ projection, project, selectedId, arbiter, onClose, roles, taskStates }) {
  const h = React.createElement
  const [query, setQuery] = React.useState('')
  const [limit, setLimit] = React.useState(DAB_HISTORY_PAGE)
  const inputRef = React.useRef(null)
  React.useEffect(() => { inputRef.current?.focus?.() }, [])
  React.useEffect(() => { setLimit(DAB_HISTORY_PAGE) }, [query, project])
  const page = React.useMemo(() => historyPage(projection, { query, project, offset: 0, limit }), [projection, query, project, limit])
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
  const roleOf = node => {
    const resolved = roles instanceof Map ? roles.get(node.id) : null
    const text = resolved?.roleLabel ?? (typeof node.role === 'string' && node.role !== '' ? node.role : null)
    return text
  }
  const taskStateOf = node => {
    if (node.taskId === null || node.taskId === undefined || !(taskStates instanceof Map)) return null
    return typeof dabTaskStateLabel === 'function' ? dabTaskStateLabel(taskStates.get(String(node.taskId))) : null
  }
  return h('div', { className: 'dab-drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': dabT('historyTitle'), onKeyDown: onKey },
    h('div', { className: 'dab-drawer-head' },
      h('div', { className: 'dab-bar' },
        h('strong', { style: { fontSize: '14px' } }, dabT('historyTitle')),
        h('span', { className: 'dab-muted' }, `${page.total}`),
        h('span', { className: 'dab-grow' }),
        h('button', { type: 'button', className: 'dab-btn', 'data-variant': 'ghost', onClick: onClose, 'aria-label': dabT('close') }, '✕')),
      h('input', { ref: inputRef, type: 'search', className: 'dab-input', style: { maxWidth: 'none' }, placeholder: dabT('search'), 'aria-label': dabT('search'), value: query, onChange: event => setQuery(event.target.value) }),
      h('div', { className: 'dab-muted' }, dabT('historyHint'))),
    h('ul', { className: 'dab-drawer-list' },
      page.items.map(node => h('li', {
        key: node.id, className: 'dab-hist', tabIndex: 0, role: 'button', 'data-node-id': node.id,
        'data-selected': selectedId === node.id ? 'true' : 'false',
        'aria-label': [node.title, dabStatusLabel(node.status), roleOf(node)].filter(Boolean).join(' — '),
        onClick: event => arbiter.click(node.id, event.detail),
        onDoubleClick: () => arbiter.doubleClick(node.id),
        onKeyDown: event => { if (event.target === event.currentTarget && arbiter.key(node.id, event.key)) event.preventDefault() },
      },
      h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', 'aria-hidden': 'true' }),
      h('span', { className: 'dab-hist-main' },
        h('span', { className: 'dab-hist-title', title: node.title }, node.title),
        h('span', { className: 'dab-muted' }, [
          node.projectId === 'unassigned' ? dabT('unassigned') : node.projectTitle,
          roleOf(node),
          taskStateOf(node),
          node.children.length > 0 ? `${node.children.length} ${dabT('children')}` : null,
          node.archived ? dabT('archived') : null,
          dabFormatAge(node.updatedAt),
        ].filter(Boolean).join(' · '))))),
      page.hasMore
        ? h('li', { style: { padding: '8px' } }, h('button', { type: 'button', className: 'dab-btn', onClick: () => setLimit(value => value + DAB_HISTORY_PAGE) }, `${dabT('loadMore')} (${page.total - page.items.length})`))
        : null),
  )
}


// ---- src/client/ui/toolbar.js ----
/**
 * Toolbar (counters, search, project filter, view filters, orchestrator
 * controls) and the orchestrator side panels (proposals/executions, adapters).
 * The orchestrator controls are the pre-existing ones; when the host API is
 * unreachable they are disabled and say so instead of pretending to work.
 *
 * @module dsh-agent-board/client/ui/toolbar
 */

const DAB_ICONS = {
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  stop: ['M7 7h10v10H7z'],
  play: ['M8 5l11 7-11 7z'],
}

/** Existing agent statuses offered by the additive status filter. */
const DAB_FILTER_STATUSES = Object.freeze([
  'running', 'waiting_user', 'recovering', 'interrupted', 'provider_unavailable',
  'finished_unread', 'finished_read', 'failed', 'idle', 'unknown', 'unavailable',
])

/** Task Board workflow states (a SEPARATE vocabulary from agent statuses). */
const DAB_FILTER_TASK_STATES = Object.freeze(['todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'archived'])

const DAB_GENERIC_ROLE_FILTER = typeof GENERIC_ROLE_FILTER === 'string' ? GENERIC_ROLE_FILTER : 'generic'

function dabRoleFilterOptions() {
  const options = [['', dabT('roleAll')]]
  if (typeof AGENT_ROLES === 'object' && AGENT_ROLES !== null && typeof AGENT_ROLE_IDS !== 'undefined') {
    for (const roleId of AGENT_ROLE_IDS) options.push([roleId, AGENT_ROLES[roleId]?.label ?? roleId])
  }
  options.push([DAB_GENERIC_ROLE_FILTER, dabT('roleGeneric')])
  return options
}

function dabHierarchyFiltersActive(ui) {
  return (typeof ui.roleFilter === 'string' && ui.roleFilter !== '')
    || (typeof ui.statusFilter === 'string' && ui.statusFilter !== '')
    || (typeof ui.taskStateFilter === 'string' && ui.taskStateFilter !== '')
}

function dabIcon(name) {
  const h = React.createElement
  return h('svg', { className: 'dab-ico', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    (DAB_ICONS[name] ?? []).map((d, index) => h('path', { key: index, d })))
}

/** Themed dropdown (the native <select> popup cannot follow the plugin look). */
function DabSelect({ label, value, options, onChange, title, disabled, style }) {
  const h = React.createElement
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const rootRef = React.useRef(null)
  const listRef = React.useRef(null)
  const current = options.find(([optionValue]) => optionValue === value) ?? options[0]
  React.useEffect(() => {
    if (!open) return undefined
    const close = event => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    listRef.current?.focus()
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const show = () => { setActive(Math.max(0, options.findIndex(([optionValue]) => optionValue === value))); setOpen(true) }
  const pick = index => { const option = options[index]; setOpen(false); rootRef.current?.querySelector('button')?.focus(); if (option && option[0] !== value) onChange(option[0]) }
  const onListKey = event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(active) }
    else if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); if (event.key === 'Escape') rootRef.current?.querySelector('button')?.focus() }
  }
  return h('div', { className: 'dab-dd', ref: rootRef, style },
    h('button', {
      type: 'button', className: 'dab-select', 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-label': `${label} : ${current?.[1] ?? ''}`, title: title ?? label, disabled,
      onClick: () => (open ? setOpen(false) : show()),
      onKeyDown: event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() } },
    }, h('span', { className: 'dab-dd-text' }, current?.[1] ?? '')),
    open
      ? h('ul', { className: 'dab-dd-pop', role: 'listbox', 'aria-label': label, tabIndex: -1, ref: listRef, onKeyDown: onListKey, 'aria-activedescendant': `dab-opt-${label}-${active}` },
        options.map(([optionValue, text], index) => h('li', {
          key: optionValue, id: `dab-opt-${label}-${index}`, role: 'option', className: 'dab-dd-opt', 'aria-selected': optionValue === value, 'data-active': index === active,
          onPointerEnter: () => setActive(index), onClick: () => pick(index),
        }, h('span', { className: 'dab-dd-text' }, text), optionValue === value ? h('span', { className: 'dab-dd-check', 'aria-hidden': 'true' }, '✓') : null)))
      : null)
}

function DabToolbar(props) {
  const h = React.createElement
  const { counts, visibleCount, mode, busy, hostDown, canStop, stopped, secondary, onMode, onStop, onResume, onRefresh, ui, setUi, projects, onHistory, narrow, taskStateAvailable, taskStateUnavailableReason } = props
  const counter = (tone, value, label) => value > 0
    ? h('span', { className: 'dab-counter', key: tone, title: `${value} ${label}`, 'aria-label': `${value} ${label}` }, h('span', { className: 'dab-dot', 'data-tone': tone }), h('b', null, value))
    : null
  const modeNotice = mode === 'off' ? dabT('offNotice') : mode === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice')
  const notice = secondary ? dabT('secondaryInstance') : stopped ? dabT('stoppedNotice') : modeNotice
  const [menuOpen, setMenuOpen] = React.useState(false)
  const state = props.statePanel ?? null
  const alert = secondary || stopped || hostDown
  const iconBtn = (icon, label, onClick, extra = {}) => h('button', { type: 'button', className: 'dab-icon-btn', onClick, 'aria-label': label, title: label, ...extra }, dabIcon(icon))
  const select = (label, value, options, onChange, extra = {}) => h(DabSelect, { label, value, options, onChange, title: extra.title, disabled: extra.disabled, style: extra.style })

  const counters = h('span', { className: 'dab-counters' },
    counter('running', counts.running, dabT('running')),
    counter('waiting', counts.waiting, dabT('waiting')),
    counter('unread', counts.unread, dabCountNoun(counts.unread, 'unreadSingular', 'unreadPlural')),
    counter('failed', counts.failed, dabT('failed')),
    narrow ? null : h('span', { className: 'dab-muted', title: `${visibleCount} ${dabT('shown')} ${dabT('of')} ${counts.total}` }, `${visibleCount}/${counts.total}`))

  const projectSelect = select(dabT('projects'), ui.project ?? '',
    [['', dabT('allProjects')], ...projects.map(project => [project.id, `${project.id === 'unassigned' ? dabT('unassigned') : project.title} (${project.agents})`])],
    value => setUi({ project: value === '' ? null : value }), { style: narrow ? { flex: '1 1 auto', minWidth: 0 } : undefined })
  const filterSelect = select(dabT('filterLabel'), ui.filter,
    [['attention', dabT('filterAttention')], ['recent', dabT('filterRecent')], ['all', dabT('filterAll')]], value => setUi({ filter: value }))
  const viewSelect = select(dabT('viewLabel'), ui.compact ? 'compact' : 'tree',
    [['tree', dabT('treeView')], ['compact', dabT('compact')]], value => setUi({ compact: value === 'compact' }))
  // Additive filters (GOAL 4): role, agent status, view mode and — only when the
  // Task Board integration reports it available — the linked Task Board state.
  const viewModeSelect = select(dabT('viewModeLabel'), ui.viewMode === 'hierarchy' ? 'hierarchy' : 'projects',
    [['projects', dabT('viewProjects')], ['hierarchy', dabT('viewHierarchy')]], value => setUi({ viewMode: value }))
  const roleSelect = select(dabT('role'), typeof ui.roleFilter === 'string' ? ui.roleFilter : '',
    dabRoleFilterOptions(), value => setUi({ roleFilter: value === '' ? null : value }))
  const statusSelect = select(dabT('statusFilterLabel'), typeof ui.statusFilter === 'string' ? ui.statusFilter : '',
    [['', dabT('statusAll')], ...DAB_FILTER_STATUSES.map(status => [status, dabStatusLabel(status)])],
    value => setUi({ statusFilter: value === '' ? null : value }))
  // The Task Board state filter is shown only when the integration reports it
  // available. When it is not, the control stays visible but DISABLED with the
  // real reason: a reachable ledger that has not been read yet must not look
  // like an absent feature.
  const taskStateSelect = taskStateAvailable === true
    ? select(dabT('taskStateFilterLabel'), typeof ui.taskStateFilter === 'string' ? ui.taskStateFilter : '',
      [['', dabT('taskStateAll')], ...DAB_FILTER_TASK_STATES.map(state => [state, dabTaskStateLabel(state) ?? state])],
      value => setUi({ taskStateFilter: value === '' ? null : value }))
    : select(dabT('taskStateFilterLabel'), '', [['', dabT('taskStateUnavailable')]], () => {},
      { disabled: true, title: taskStateUnavailableReason ?? dabT('taskStateUnavailable') })
  const clearFilters = dabHierarchyFiltersActive(ui)
    ? h('button', {
      type: 'button', className: 'dab-btn', 'data-variant': 'ghost',
      onClick: () => setUi({ roleFilter: null, statusFilter: null, taskStateFilter: null }),
    }, dabT('clearFilters'))
    : null
  const modeSelect = select(dabT('orchestratorLabel'), mode,
    ['off', 'supervised', 'autonomous'].map(value => [value, `${dabT('orchestratorLabel')} : ${dabT(value)}`]), onMode,
    { disabled: busy || hostDown || secondary, title: hostDown ? dabT('orchestratorDown') : notice })
  const stopOrResume = stopped && mode !== 'off' && !secondary
    ? iconBtn('play', dabT('resume'), onResume, { disabled: busy || hostDown, 'data-tone': 'resume' })
    : iconBtn('stop', canStop ? dabT('stop') : dabT('stopNone'), onStop, { disabled: busy || hostDown || !canStop || secondary, 'data-danger': 'true' })
  const alertDot = alert ? h('span', { className: 'dab-dot', 'data-tone': 'failed', title: hostDown ? dabT('orchestratorDown') : notice, role: 'img', 'aria-label': hostDown ? dabT('orchestratorDown') : notice }) : null

  const search = h('input', {
    type: 'search', className: 'dab-input', placeholder: dabT('search'), 'aria-label': dabT('search'), value: ui.query,
    onChange: event => setUi({ query: event.target.value }),
    onKeyDown: event => { if (event.key === 'Escape') setUi({ query: '' }) },
  })
  const history = iconBtn('history', dabT('history'), onHistory, { 'aria-haspopup': 'dialog' })
  const refresh = iconBtn('refresh', dabT('refresh'), onRefresh, { disabled: busy })

  if (narrow) {
    return h('header', { className: 'dab-toolbar' },
      h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } },
        counters, projectSelect, alertDot, history, refresh,
        iconBtn('more', dabT('moreControls'), () => setMenuOpen(value => !value), { 'aria-expanded': menuOpen })),
      h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } }, search),
      menuOpen
        ? h('div', { className: 'dab-mobile-menu' },
          h('div', { className: 'dab-bar' }, viewModeSelect, filterSelect),
          h('div', { className: 'dab-bar' }, roleSelect, statusSelect),
          h('div', { className: 'dab-bar' }, viewSelect, taskStateSelect, clearFilters),
          h('div', { className: 'dab-bar' }, modeSelect, stopOrResume, h('span', { className: 'dab-grow' }), state),
          h('div', { className: alert ? 'dab-alert' : 'dab-notice' }, hostDown ? dabT('orchestratorDown') : notice))
        : null,
    )
  }

  return h('header', { className: 'dab-toolbar' },
    h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } },
      counters,
      h('div', { className: 'dab-search-wrap' }, search),
      projectSelect, filterSelect,
      h('span', { className: 'dab-grow' }),
      alertDot, modeSelect, stopOrResume, state, history, refresh),
    h('div', { className: 'dab-bar' },
      viewModeSelect, roleSelect, statusSelect, taskStateSelect, viewSelect, clearFilters),
  )
}
function DabExecutionList({ host, onApprove, onReject }) {
  const h = React.createElement
  const proposals = Array.isArray(host.proposals) ? host.proposals : []
  const assignments = Array.isArray(host.assignments) ? host.assignments : []
  const active = assignments.filter(assignment => assignment.status === 'running' || assignment.status === 'starting').slice(-6)
  const interrupted = assignments.filter(assignment => assignment.status === 'interrupted').slice(-4)
  if (proposals.length === 0 && active.length === 0 && interrupted.length === 0) return null
  return h('div', { className: 'dab-panel' },
    h('div', { className: 'dab-label' }, dabT('executions')),
    h('ul', { className: 'dab-list' },
      proposals.map(proposal => h('li', { key: proposal.id },
        h('span', { className: 'dab-dot', 'data-tone': 'waiting' }),
        h('span', { className: 'dab-grow' }, `${dabT('proposals')} — ${proposal.title}`),
        h('span', { className: 'dab-tag dab-mono' }, proposal.taskId),
        h('button', { type: 'button', className: 'dab-btn', onClick: () => onApprove(proposal.id) }, dabT('approve')),
        h('button', { type: 'button', className: 'dab-btn', onClick: () => onReject(proposal.id) }, dabT('reject')))),
      active.map(assignment => h('li', { key: assignment.id },
        h('span', { className: 'dab-dot', 'data-tone': 'running' }),
        h('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        h('span', { className: 'dab-tag dab-mono' }, assignment.model ? `${assignment.model.provider}/${assignment.model.model}` : '?'))),
      interrupted.map(assignment => h('li', { key: `int-${assignment.id}` },
        h('span', { className: 'dab-dot', 'data-tone': 'failed' }),
        h('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        h('span', { className: 'dab-alert' }, dabT('resumed'))))),
  )
}

function DabOrchestratorState({ host, hostError }) {
  const h = React.createElement
  const sync = host.sync
  const adapters = host.adapters?.adapters ?? []
  const healthy = sync?.ok === true && !hostError
  return h('details', { className: 'dab-state' },
    h('summary', { className: 'dab-btn', title: dabT('orchestratorState'), 'aria-label': dabT('orchestratorState') },
      h('span', { className: 'dab-dot', 'data-tone': healthy ? 'unread' : 'failed' }), dabT('stateShort')),
    h('div', { className: 'dab-state-pop' },
    h('div', { className: 'dab-label' }, dabT('orchestratorState')),
    h('div', { className: 'dab-muted', style: { marginTop: '6px' } },
      sync === null || sync === undefined
        ? (hostError ? `${dabT('syncError')}: ${hostError}` : '…')
        : sync.ok === true
          ? `${dabT('syncOk')} · rev ${sync.ledgerRevision ?? '?'} · ${sync.tasksTotal ?? 0} · ${dabFormatAge(sync.at)}`
          : `${dabT('syncError')} — ${sync.error ?? ''}`),
    (host.reconcileNotes ?? []).length > 0
      ? h('ul', { className: 'dab-list' }, host.reconcileNotes.map(note => h('li', { key: note.assignmentId },
        h('span', { className: 'dab-tag' }, `${dabT('restore')} · ${note.status}`), h('span', { className: 'dab-mono' }, note.taskId))))
      : null,
    h('div', { className: 'dab-label', style: { marginTop: '8px' } }, `${dabT('adapters')} (${adapters.length})`),
    h('ul', { className: 'dab-list' }, adapters.map(adapter => h('li', { key: adapter.id },
      h('span', { className: 'dab-tag' }, adapter.kind ?? '?'),
      h('span', { className: 'dab-grow' }, adapter.title ?? adapter.id),
      h('span', { className: 'dab-tag' }, adapter.status ?? '?'),
      adapter.validatedLive === true ? null : h('span', { className: 'dab-tag' }, dabT('notLive'))))),
    ),
  )
}


// ---- src/client/app.js ----
/**
 * Agent Board panel entry (React via plain createElement, no JSX build).
 *
 * Composition:
 *   AgentBoard (this file)       state, store subscription, routing
 *   ├─ DabToolbar                ui/toolbar.js
 *   ├─ DabProjectGroup           ui/tree.js  → DabAgentTree → DabAgentCard (ui/card.js)
 *   ├─ DabAgentPreview           ui/preview.js
 *   └─ DabHistoryDrawer          ui/history.js
 * Pure logic lives in supervisor/projection.js (status, project, parentage),
 * board/view.js (visibility, sorting, history) and board/interaction.js
 * (click/double-click arbitration).
 *
 * This file is concatenated into the browser artifact by scripts/build-client.mjs.
 *
 * @module dsh-agent-board/client/app
 */

const DAB_PANEL_ID = 'dsh-agent-board'
const DAB_UI_KEY = 'dsh-agent-board:ui:v2'

/** UI state survives a panel remount (navigation to a session and back). */
const DAB_MEMORY = { scrollTop: 0, selectedId: null }

function dabDefaultUi() {
  return {
    filter: 'attention', query: '', project: null, compact: false,
    folded: [], expanded: [], collapsed: [], dismissed: [], treeLimit: {},
    // GOAL 4 additive preferences (validated and bounded on read).
    viewMode: 'projects', roleFilter: null, statusFilter: null, taskStateFilter: null, supervisionOpen: null,
  }
}

function dabReadUi() {
  const base = dabDefaultUi()
  try {
    const raw = globalThis.localStorage?.getItem(DAB_UI_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw)
    // Role/status/task filters are re-validated by the pure hierarchy module: an
    // unknown persisted value can never select an invisible pseudo-status.
    const filters = normalizeHierarchyFilters({
      role: parsed.roleFilter,
      status: parsed.statusFilter,
      taskState: parsed.taskStateFilter,
    })
    return {
      ...base,
      filter: VIEW_FILTERS.includes(parsed.filter) ? parsed.filter : base.filter,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      compact: parsed.compact === true,
      folded: Array.isArray(parsed.folded) ? parsed.folded.slice(0, 200) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.slice(0, 200) : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.slice(0, 200) : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.slice(-500) : [],
      viewMode: parsed.viewMode === 'hierarchy' ? 'hierarchy' : 'projects',
      roleFilter: filters.role,
      statusFilter: filters.status,
      taskStateFilter: filters.taskState,
      supervisionOpen: typeof parsed.supervisionOpen === 'boolean' ? parsed.supervisionOpen : null,
    }
  } catch {
    return base
  }
}

function dabWriteUi(ui) {
  try {
    const { query: _query, treeLimit: _limit, ...persisted } = ui
    globalThis.localStorage?.setItem(DAB_UI_KEY, JSON.stringify(persisted))
  } catch { /* private mode */ }
}

function dabMakePage(store, ctx) {
  return function AgentBoardPage() {
    const h = React.createElement
    DAB_LANG = dabResolveLocale(ctx)
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const [ui, setUiState] = React.useState(dabReadUi)
    const [selectedId, setSelectedId] = React.useState(DAB_MEMORY.selectedId)
    const [historyOpen, setHistoryOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')
    const [openError, setOpenError] = React.useState('')
    const [narrow, setNarrow] = React.useState(false)
    const [nowBucket, setNowBucket] = React.useState(() => Math.floor(Date.now() / 60000))
    const rootRef = React.useRef(null)
    const scrollRef = React.useRef(null)

    const host = snapshot.host ?? {}
    const projection = snapshot.projection
    const aggregates = snapshot.aggregates

    const setUi = React.useCallback(patch => {
      setUiState(current => {
        const next = { ...current, ...patch }
        dabWriteUi(next)
        return next
      })
    }, [])

    // Lifecycle: start the store; a coarse minute tick refreshes relative ages.
    React.useEffect(() => {
      store.start()
      const tick = setInterval(() => setNowBucket(Math.floor(Date.now() / 60000)), 60000)
      return () => clearInterval(tick)
    }, [])

    // Width-driven layout (the panel may be narrow inside a wide window).
    React.useEffect(() => {
      const element = rootRef.current
      if (element === null || typeof ResizeObserver !== 'function') return undefined
      const observer = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect?.width ?? element.clientWidth
        setNarrow(width > 0 && width <= 720)
      })
      observer.observe(element)
      return () => observer.disconnect()
    }, [])

    // Restore and remember the scroll position across remounts.
    React.useEffect(() => {
      const element = scrollRef.current
      if (element !== null) element.scrollTop = DAB_MEMORY.scrollTop
      return () => { if (element !== null) DAB_MEMORY.scrollTop = element.scrollTop }
    }, [])
    React.useEffect(() => { DAB_MEMORY.selectedId = selectedId }, [selectedId])

    const expandedSet = React.useMemo(() => new Set(ui.expanded), [ui.expanded])
    const collapsedSet = React.useMemo(() => new Set(ui.collapsed), [ui.collapsed])
    const foldedSet = React.useMemo(() => new Set(ui.folded), [ui.folded])
    const dismissedSet = React.useMemo(() => new Set(ui.dismissed), [ui.dismissed])

    const view = React.useMemo(() => buildBoardView(projection, {
      filter: ui.filter, query: ui.query, project: ui.project, expanded: expandedSet, collapsed: collapsedSet, dismissed: dismissedSet, now: nowBucket * 60000 + 60000, aggregates,
    }), [projection, aggregates, ui.filter, ui.query, ui.project, expandedSet, collapsedSet, dismissedSet, nowBucket])

    const counts = React.useMemo(() => boardCounts(projection), [projection])
    const projectList = React.useMemo(() => projectOptions(projection), [projection])

    const mode = typeof host.mode === 'string' ? host.mode : 'off'
    // The host publishes the supervision payload (GOAL 4). A missing/foreign
    // value is `null`: the hierarchy then renders structure and real counts only.
    const supervision = host.supervision !== null && typeof host.supervision === 'object' && !Array.isArray(host.supervision)
      ? host.supervision
      : null
    const taskStates = React.useMemo(() => (typeof taskStateIndex === 'function' ? taskStateIndex(supervision) : null), [supervision])
    const filters = React.useMemo(() => normalizeHierarchyFilters({
      role: ui.roleFilter, status: ui.statusFilter, taskState: ui.taskStateFilter,
    }), [ui.roleFilter, ui.statusFilter, ui.taskStateFilter])
    const filtersActive = filters.role !== null || filters.status !== null || filters.taskState !== null

    // Fold state of the rendered projects (computed identically for the board
    // and the hierarchy, so a fold is never out of sync between views).
    const foldedProjects = React.useMemo(() => {
      const set = new Set()
      for (const project of view.projects) {
        const folded = project.unassigned
          ? !foldedSet.has(`open:${project.id}`) && ui.query === '' && ui.project !== project.id
          : foldedSet.has(project.id)
        if (folded) set.add(project.id)
      }
      return set
    }, [view.projects, foldedSet, ui.query, ui.project])

    // Existing view, narrowed by the explicit agent filters. buildBoardView
    // still owns visibility, attention and ordering; this only removes entries
    // the operator filtered out.
    const filteredView = React.useMemo(() => filterBoardViewByAgent(view, filters, { projection, taskStates }),
      [view, projection, filters, taskStates])

    // The hierarchy is rebuilt only when its real inputs change: a compact-mode
    // toggle or a selection never rebuilds it.
    const hierarchy = React.useMemo(() => buildHierarchyView(projection, view, supervision, {
      filters, taskStates, foldedProjects, mode,
    }), [projection, view, supervision, filters, taskStates, foldedProjects, mode])

    // Every width keeps the overview: all projects, each foldable.
    const shownProjects = React.useMemo(() => {
      if (ui.viewMode === 'hierarchy') return []
      return filteredView.projects.map(project => {
        const entry = hierarchy.projectsById.get(project.id)
        return entry === undefined
          ? project
          : { ...project, orchestrator: entry.orchestrator, hierarchyCounts: entry.counts }
      })
    }, [filteredView, hierarchy, ui.viewMode])

    const selectedNode = selectedId !== null ? projection.byId.get(selectedId) ?? null : null
    const parentNode = selectedNode && selectedNode.parentId && !selectedNode.orphan && !selectedNode.parentCycle
      ? projection.byId.get(selectedNode.parentId) ?? null
      : null

    const nodeRef = React.useRef(projection)
    nodeRef.current = projection

    const acknowledge = React.useCallback(id => {
      const node = nodeRef.current.byId.get(id)
      if (node && (node.status === 'finished_unread' || node.status === 'recovering' || ((node.status === 'failed' || node.status === 'interrupted') && node.seen !== true))) void store.ack(id, { source: 'board_click' })
    }, [])

    // Reading a session OUTSIDE the board (native main view) is still reading.
    // The key includes the session activity timestamp: a LATER turn that
    // completes while the same session is still open is acknowledged again,
    // and leaving the view clears the entry.
    const nativeAcked = React.useRef(new Map())
    React.useEffect(() => {
      const viewing = new Set()
      for (const node of projection.nodes) {
        if (node.viewing !== true) continue
        viewing.add(node.id)
        const activityKey = String(Number(node.updatedAt) || 0)
        if (nativeAcked.current.get(node.id) === activityKey) continue
        if (node.status === 'finished_unread' || ((node.status === 'failed' || node.status === 'interrupted') && node.seen !== true)) {
          nativeAcked.current.set(node.id, activityKey)
          void store.ack(node.id, { source: 'native_view' })
        }
      }
      for (const id of [...nativeAcked.current.keys()]) {
        if (!viewing.has(id)) nativeAcked.current.delete(id)
      }
    }, [projection])

    const openSession = React.useCallback(id => {
      setOpenError('')
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (typeof uiWorkspace?.openSession !== 'function') throw new Error('uiWorkspace.openSession unavailable')
        const scroll = scrollRef.current
        if (scroll !== null) DAB_MEMORY.scrollTop = scroll.scrollTop
        DAB_MEMORY.selectedId = id
        uiWorkspace.openSession(id)
        acknowledge(id)
      } catch (error) {
        setSelectedId(id)
        setOpenError(`${dabT('openFailed')} (${String(error?.message ?? error)})`)
      }
    }, [acknowledge])

    const selectNode = React.useCallback(id => {
      setOpenError('')
      setSelectedId(id)
      acknowledge(id)
    }, [acknowledge])

    const onDismiss = React.useCallback((id, on) => {
      setUiState(current => {
        const rest = current.dismissed.filter(entry => entry !== id)
        const next = { ...current, dismissed: on ? [...rest, id] : rest }
        dabWriteUi(next)
        return next
      })
      if (on) { acknowledge(id); setSelectedId(null) }
    }, [acknowledge])

    const arbiter = React.useMemo(() => createClickArbiter({ onSelect: selectNode, onOpen: openSession }), [selectNode, openSession])
    React.useEffect(() => () => arbiter.cancel(), [arbiter])

    const onToggleBranch = React.useCallback((id, collapsed) => {
      setUiState(current => {
        const collapsedNext = new Set(current.collapsed)
        const expandedNext = new Set(current.expanded)
        if (collapsed) collapsedNext.delete(id)
        else { collapsedNext.add(id); expandedNext.delete(id) }
        const next = { ...current, collapsed: [...collapsedNext], expanded: [...expandedNext] }
        dabWriteUi(next)
        return next
      })
    }, [])
    const onRevealHidden = React.useCallback(id => {
      setUiState(current => {
        const next = { ...current, expanded: [...new Set([...current.expanded, id])], collapsed: current.collapsed.filter(entry => entry !== id) }
        dabWriteUi(next)
        return next
      })
    }, [])
    const onFold = React.useCallback(id => {
      setUiState(current => {
        const folded = new Set(current.folded)
        if (folded.has(id)) folded.delete(id)
        else folded.add(id)
        const next = { ...current, folded: [...folded] }
        dabWriteUi(next)
        return next
      })
    }, [])
    const onMoreTrees = React.useCallback(id => {
      setUiState(current => ({ ...current, treeLimit: { ...current.treeLimit, [id]: (current.treeLimit[id] ?? DEFAULT_TREE_LIMIT) + DEFAULT_TREE_LIMIT } }))
    }, [])

    const act = async (label, operation) => {
      if (busy) return
      setBusy(true)
      try {
        const result = await operation()
        setNotice(result?.ok === true ? '' : `${label}: ${result?.payload?.error ?? result?.error ?? result?.status ?? 'failed'}`)
      } finally {
        setBusy(false)
      }
    }

    const hostDown = snapshot.hostError !== null && snapshot.hostError !== undefined && host.sync === null
    const canStop = (host.assignments ?? []).some(assignment => assignment.status === 'running' || assignment.status === 'starting')
    const ctxValue = {
      selectedId, arbiter, onToggleBranch, onRevealHidden, nowBucket,
      roles: hierarchy.roles,
      taskStates,
      onFoldProject: project => onFold(project.unassigned ? `open:${project.id}` : project.id),
    }
    // Collapsed by default when a single project exists; the operator's explicit
    // choice (persisted) always wins.
    const supervisionOpen = ui.supervisionOpen === null || ui.supervisionOpen === undefined
      ? hierarchy.projects.length !== 1
      : ui.supervisionOpen === true

    const empty = shownProjects.length === 0 && ui.viewMode !== 'hierarchy'
      ? h('div', { className: 'dab-empty' },
        h('div', null, ui.query !== '' ? dabT('emptySearch') : (filtersActive ? dabT('emptyFiltered') : dabT('emptyAttention'))),
        ui.query === '' && !filtersActive ? h('div', { className: 'dab-muted' }, dabT('emptyHint')) : null,
        filtersActive
          ? h('button', { type: 'button', className: 'dab-btn', onClick: () => setUi({ roleFilter: null, statusFilter: null, taskStateFilter: null }) }, dabT('clearFilters'))
          : null,
        ui.query === '' && !filtersActive ? h('button', { type: 'button', className: 'dab-btn', onClick: () => setHistoryOpen(true) }, dabIcon('history'), ` ${dabT('history')}`) : null)
      : null

    return h('div', { className: 'dab-root', ref: rootRef, 'data-dsh-agent-board': '', 'data-narrow': narrow ? 'true' : 'false' },
      h(DabToolbar, {
        counts, visibleCount: filteredView.visibleCount, mode, busy, hostDown, canStop, ui, setUi, projects: projectList, narrow,
        taskStateAvailable: hierarchy.totals.taskStateAvailable,
        taskStateUnavailableReason: hierarchy.workspace.taskboard !== null && hierarchy.workspace.taskboard !== undefined && hierarchy.workspace.taskboard.available === false
          ? (typeof hierarchy.workspace.taskboard.reason === 'string' ? hierarchy.workspace.taskboard.reason : null)
          : null,
        stopped: host.stoppedAt !== null && host.stoppedAt !== undefined,
        secondary: host.instance?.primary === false,
        onMode: value => act('mode', () => store.setMode(value)),
        onStop: () => act('stop', () => store.stop()),
        onResume: () => act('resume', () => store.resume()),
        onRefresh: () => { void store.refreshHost(); void act('refresh', () => store.refreshHost()) },
        onHistory: () => setHistoryOpen(true),
        statePanel: h(DabOrchestratorState, { host, hostError: snapshot.hostError }),
      }),
      h('div', { className: 'dab-main' },
        h('div', { className: 'dab-scroll', ref: scrollRef, onScroll: event => { DAB_MEMORY.scrollTop = event.currentTarget.scrollTop } },
          notice !== '' ? h('div', { className: 'dab-alert', role: 'status', style: { marginBottom: '8px' } }, notice) : null,
          h(DabSupervisionBand, {
            workspace: hierarchy.workspace,
            totals: hierarchy.totals,
            projects: hierarchy.projects,
            open: supervisionOpen,
            onToggle: () => setUi({ supervisionOpen: !supervisionOpen }),
          }),
          h(DabExecutionList, { host, onApprove: id => act('approve', () => store.decide(id, true)), onReject: id => act('reject', () => store.decide(id, false)) }),
          empty,
          ui.viewMode === 'hierarchy'
            ? h(DabHierarchyView, { hierarchy, ctx: ctxValue, compact: ui.compact })
            : h('div', { className: 'dab-projects' }, shownProjects.map(project => h(DabProjectGroup, {
              key: project.id, project, ctx: ctxValue, compact: ui.compact,
              // "Unassigned" starts folded (opt-in), every real project starts open.
              folded: project.unassigned
                ? !foldedSet.has(`open:${project.id}`) && ui.query === '' && ui.project !== project.id
                : foldedSet.has(project.id),
              onFold: id => onFold(project.unassigned ? `open:${id}` : id),
              treeLimit: ui.treeLimit[project.id] ?? DEFAULT_TREE_LIMIT,
              onMoreTrees,
            })))),
        selectedNode !== null
          ? h(DabAgentPreview, {
            node: selectedNode, parent: parentNode, onOpen: openSession, onSelect: selectNode, onClose: () => setSelectedId(null), openError, onDismiss, dismissed: dismissedSet.has(selectedNode.id),
            role: hierarchy.roles.get(selectedNode.id) ?? null,
            taskState: selectedNode.taskId !== null && selectedNode.taskId !== undefined && taskStates instanceof Map
              ? taskStates.get(String(selectedNode.taskId)) ?? null
              : null,
          })
          : null),
      historyOpen
        ? h(DabHistoryDrawer, { projection, project: ui.project, selectedId, arbiter, onClose: () => setHistoryOpen(false), roles: hierarchy.roles, taskStates })
        : null,
    )
  }
}

/** Tooltip matching the DSH shell bubble (same tokens as its native tooltips). */
function dabTipHide() {
  for (const node of document.querySelectorAll('[data-dab-tip]')) node.remove()
  // Bubbles left by an earlier plugin build (no marker): unclassed body-level tooltip divs.
  for (const node of document.querySelectorAll('body > div[role="tooltip"]:not([class])')) {
    if (String(node.getAttribute('style') ?? '').includes('--dsw-alias-tooltip-bg')) node.remove()
  }
  document.removeEventListener('pointermove', dabTipGuard, true)
  window.removeEventListener('blur', dabTipHide)
  window.removeEventListener('scroll', dabTipHide, true)
}
let dabTipAnchor = null
function dabTipGuard(event) {
  const anchor = dabTipAnchor
  if (anchor === null || !anchor.isConnected) return dabTipHide()
  const r = anchor.getBoundingClientRect()
  if (event.clientX < r.left - 2 || event.clientX > r.right + 2 || event.clientY < r.top - 2 || event.clientY > r.bottom + 2) dabTipHide()
}
function dabTipHandlers(text) {
  const hide = dabTipHide
  const show = event => {
    hide()
    const anchor = event.currentTarget
    dabTipAnchor = anchor
    const rect = anchor.getBoundingClientRect()
    const row = (anchor.closest('button') ?? anchor).getBoundingClientRect()
    const bubble = document.createElement('div')
    bubble.setAttribute('role', 'tooltip')
    bubble.setAttribute('data-dab-tip', '')
    bubble.textContent = text
    Object.assign(bubble.style, {
      display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', margin: '0', fontWeight: '400', fontFamily: 'inherit',
      position: 'fixed', zIndex: '1100', left: `${Math.round(rect.right + 8)}px`, top: `${Math.round(row.top + row.height / 2)}px`, transform: 'translateY(-50%)',
      width: 'max-content', maxWidth: 'min(50vw, calc(100vw - 24px))', padding: '3px 7px', borderRadius: 'var(--dsw-radius-sm)',
      background: 'var(--dsw-alias-tooltip-bg)', color: 'var(--dsw-static-neutral-bluish-00)', fontSize: '13px', lineHeight: '20px',
      whiteSpace: 'pre-line', pointerEvents: 'none',
    })
    document.body.appendChild(bubble)
    document.addEventListener('pointermove', dabTipGuard, true)
    window.addEventListener('blur', dabTipHide)
    window.addEventListener('scroll', dabTipHide, true)
  }
  return { onPointerEnter: show, onPointerLeave: hide, onPointerDown: hide }
}

function dabMakeIcon(store) {
  return function AgentBoardIcon() {
    const h = React.createElement
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const counts = snapshot.projection?.counts ?? {}
    const running = counts.running ?? 0
    const waiting = counts.waiting_user ?? 0
    const unread = counts.finished_unread ?? 0
    const [wide, setWide] = React.useState(true)
    const ref = React.useRef(null)
    const statsRef = React.useRef(null)
    const placeRef = React.useRef(() => {})
    React.useLayoutEffect(() => { placeRef.current() })
    // Same pattern as the Task board entry: numbers at the row's right edge when
    // the sidebar is expanded, a small badge on the icon when it is collapsed.
    React.useLayoutEffect(() => {
      const button = ref.current?.closest('button')
      if (button == null || typeof ResizeObserver === 'undefined') return undefined
      if (getComputedStyle(button).position === 'static') button.style.position = 'relative'
      // Anchor the numbers on the ROW's vertical centre even when an inner
      // positioned wrapper (icon box) is the containing block.
      const place = () => {
        const stats = statsRef.current
        const parent = stats?.offsetParent
        if (!stats || !parent) return
        const b = button.getBoundingClientRect()
        const p = parent.getBoundingClientRect()
        stats.style.top = `${Math.round(b.top - p.top + b.height / 2)}px`
        stats.style.right = `${Math.round(p.right - b.right + 9)}px`
      }
      const measure = () => { setWide(button.clientWidth > 44); place() }
      measure()
      placeRef.current = place
      const observer = new ResizeObserver(measure)
      observer.observe(button)
      return () => observer.disconnect()
    }, [])
    const title = `${running} ${dabT('running')} | ${waiting} ${dabT('waiting')} | ${unread} ${dabT('unread')}`
    const stat = (value, color) => h('span', { style: { color } }, String(value))
    const sep = () => h('span', { style: { opacity: 0.5 } }, '|')
    return h('span', { ref, style: { display: 'inline-flex', alignItems: 'center' } },
      h('span', { style: { position: 'relative', display: 'inline-flex' }, 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 2.5, y: 3, width: 7, height: 5.4, rx: 1.4 }),
          h('rect', { x: 14.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
          h('rect', { x: 2.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
          h('path', { d: 'M6 8.4v3.1a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 1 1.5 1.5v1.1' }),
          h('path', { d: 'M3.2 15.6v-2.1A1.5 1.5 0 0 1 4.7 12h2.1' })),
        !wide && unread + waiting > 0
          ? h('span', {
            style: {
              position: 'absolute', top: '-5px', right: '-8px', minWidth: '13px', height: '13px', borderRadius: '7px', padding: '0 3px',
              fontSize: '9px', fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: waiting > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)',
            },
          }, String(unread + waiting))
          : null),
      wide && running + waiting + unread > 0
        ? h('span', {
          ref: statsRef, 'aria-label': title, ...dabTipHandlers(title),
          style: {
            position: 'absolute', right: '9px', top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', gap: '3px',
            fontSize: '11px', lineHeight: 1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
          },
        },
          stat(running, 'var(--dsw-alias-state-info-primary, #3e63dd)'), sep(),
          stat(waiting, 'var(--dsw-alias-state-warn-primary, #e69842)'), sep(),
          stat(unread, 'var(--dsw-alias-state-success-primary, #2ea043)'))
        : null)
  }
}
/** Client plugin entry: styles + store + slot registrations. */
function apply(ctx) {
  const disposers = []
  DAB_LANG = dabResolveLocale(ctx)
  try { dabTipHide() } catch { /* ignore */ }
  try {
    const locale = ctx.get?.('locale')
    if (typeof locale?.subscribe === 'function') disposers.push(locale.subscribe(() => { DAB_LANG = dabResolveLocale(ctx) }))
  } catch { /* keep the resolved language */ }
  try {
    disposers.push(dabInjectStyles())
  } catch { /* styling must never break activation */ }
  const store = createBoardStore(ctx)
  const page = dabMakePage(store, ctx)
  const icon = dabMakeIcon(store)
  try {
    const slots = ctx.get?.('slots') ?? ctx.slots
    if (slots === undefined || typeof slots.register !== 'function') throw new Error('slots service unavailable')
    disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: DAB_PANEL_ID }, page)))
    disposers.push(slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist', id: DAB_PANEL_ID, order: 11, label: () => dabT('title'),
    }, icon)))
  } catch (error) {
    // The shell fails the whole boot when a plugin apply throws: never rethrow.
    console.error('[dsh-agent-board] panel registration failed', error)
  }
  store.start()
  const dispose = () => {
    for (const disposer of disposers.splice(0).reverse()) {
      try { disposer?.() } catch { /* ignore */ }
    }
    store.destroy()
    try { dabTipHide() } catch { /* ignore */ }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}


    return { name: 'dsh-agent-board/client', inject: ['slots'], apply }
  },
})
