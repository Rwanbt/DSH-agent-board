/**
 * Mandate + autonomy policy (L0–L4) — the ONE deterministic authorization
 * contract of the Agent Board.
 *
 * Why this module is pure and boring on purpose:
 *   - it is the only place that decides whether a project may be touched and
 *     which action class is allowed; every host path (tick, dispatch, approval,
 *     resume, failover, Task Board write, forge write, sub-agent, schedule)
 *     calls `effectivePolicyOf`/`authorizeAction` and nothing else;
 *   - a language model may PROPOSE an action, but only this module turns it into
 *     an authorized fact. A prompt is never a security boundary;
 *   - the default is deny: `scopeMode: 'none'`, every mutating action `false`,
 *     every project `enabled: false`. An empty workspace list never means "all".
 *
 * The most-restrictive-wins ladder is:
 *
 *   host permissions > mandate (scope + action flags) > global level
 *   > project level > integration ceiling > required level of the action
 *
 * @module dsh-agent-board/contracts/mandate
 */

/** How the operator scoped the autonomy. `none` is the only safe default. */
export const SCOPE_MODES = Object.freeze(['none', 'selected', 'all'])

/** Ordered autonomy levels. The array order IS the ranking. */
export const AUTONOMY_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4'])

export const LEVEL_RANK = Object.freeze(
  Object.fromEntries(AUTONOMY_LEVELS.map((level, index) => [level, index])),
)

/** Stable action vocabulary. Anything outside this set is refused. */
export const ACTIONS = Object.freeze([
  'read',
  'analyse',
  'propose',
  'comment',
  'create_task',
  'update_task',
  'launch',
  'delegate',
  'schedule',
  'push_branch',
  'open_pr',
  'merge',
  'protected_branch_write',
  'delete_task',
  'secrets',
  'policy_change',
])

/**
 * Actions that need no explicit per-action grant: they cannot mutate anything
 * outside the board's own memory, so the level alone authorizes them.
 */
export const READ_ONLY_ACTIONS = Object.freeze(['read', 'analyse', 'propose'])

/** Automatic threshold (legacy grants also use it as a hard minimum).
 * Explicit noncritical modes permit supervised execution at L2+ instead. */
export const ACTION_MIN_LEVEL = Object.freeze({
  read: 'L0',
  analyse: 'L1',
  propose: 'L1',
  // L2 may execute a prepared change, but ONLY after a valid human approval.
  launch: 'L2',
  comment: 'L3',
  create_task: 'L3',
  update_task: 'L3',
  schedule: 'L3',
  push_branch: 'L3',
  delegate: 'L4',
  open_pr: 'L4',
  // Critical actions: L4 is necessary, never sufficient.
  merge: 'L4',
  protected_branch_write: 'L4',
  delete_task: 'L4',
  secrets: 'L4',
  policy_change: 'L4',
})

/**
 * Actions the level can never grant on its own: they need `actions.<name>` AND
 * a per-occurrence human decision. L4 means maximal autonomy inside the
 * mandate, not unlimited permissions.
 */
export const CRITICAL_ACTIONS = Object.freeze([
  'merge',
  'protected_branch_write',
  'delete_task',
  'secrets',
  'policy_change',
])

/** Per-integration ceilings (an integration never widens the mandate). */
export const INTEGRATION_CEILING = Object.freeze({
  board: Object.freeze({}),
  taskboard: Object.freeze({
    read: 'L4',
    create_task: 'L4',
    update_task: 'L4',
    comment: 'L4',
    launch: 'L4',
    delete_task: 'L4',
  }),
  github: Object.freeze({
    read: 'L4',
    comment: 'L3',
    create_task: 'L3',
    update_task: 'L3',
    launch: 'L4',
    push_branch: 'L3',
    open_pr: 'L4',
    merge: 'L4',
    protected_branch_write: 'L4',
  }),
  forge: Object.freeze({
    read: 'L4',
    comment: 'L3',
    open_pr: 'L4',
    merge: 'L4',
  }),
})

/** Every mutating action starts disabled; migration never grants anything. */
const DISABLED_ACTIONS = Object.freeze(
  Object.fromEntries(ACTIONS.filter(action => !READ_ONLY_ACTIONS.includes(action)).map(action => [action, false])),
)

const MAX_PROJECTS = 50
const MAX_TEXT = 400
const MAX_NAME = 120

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,120}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** Reject prototype-pollution keys and anything that cannot be a workspace id. */
function safeKey(value) {
  return typeof value === 'string' && SAFE_KEY.test(value) && value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
}

function uniqueKeys(values) {
  if (!Array.isArray(values)) return []
  const out = []
  const seen = new Set()
  for (const value of values) {
    if (!safeKey(value) || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_PROJECTS) break
  }
  return out
}

function levelOf(value, fallback = 'L0') {
  return AUTONOMY_LEVELS.includes(value) ? value : fallback
}

function minLevel(left, right) {
  return LEVEL_RANK[left] <= LEVEL_RANK[right] ? left : right
}

function normalizeModel(value) {
  if (!isPlainObject(value)) return null
  const provider = text(value.provider, MAX_NAME)
  const model = text(value.model, MAX_NAME)
  if (provider === '' || model === '') return null
  const entry = { provider, model }
  const effort = text(value.reasoningEffort, 40)
  if (effort !== '') entry.reasoningEffort = effort
  return entry
}

function normalizeFallback(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const model = normalizeModel(entry)
    if (model === null) continue
    out.push(model)
    if (out.length >= 3) break
  }
  return out
}

function normalizeProjectPolicy(value) {
  const source = isPlainObject(value) ? value : {}
  return {
    // An inherited project is DISABLED: selecting a scope is not enabling it.
    enabled: source.enabled === true,
    // `null` means "inherit the global level" — a project override is explicit.
    level: AUTONOMY_LEVELS.includes(source.level) ? source.level : null,
    priority: clampInt(source.priority, 0, 9, 5),
    model: normalizeModel(source.model),
    budget: { maxTasksPerHour: clampInt(source.budget?.maxTasksPerHour, 0, 100, 6) },
    note: text(source.note, 240),
  }
}

function normalizeProjects(value) {
  if (!isPlainObject(value)) return {}
  const out = {}
  let kept = 0
  for (const [projectId, entry] of Object.entries(value)) {
    if (kept >= MAX_PROJECTS) break
    if (!safeKey(projectId)) continue
    out[projectId] = normalizeProjectPolicy(entry)
    kept += 1
  }
  return out
}

/** Explicit overrides only: absence preserves legacy boolean/level semantics. */
export const ACTION_MODES = Object.freeze(['deny', 'ask', 'auto'])

export function normalizeActionModes(value) {
  const source = isPlainObject(value) ? value : {}
  return Object.fromEntries(ACTIONS.filter(action => !READ_ONLY_ACTIONS.includes(action)
    && Object.hasOwn(source, action) && ACTION_MODES.includes(source[action]))
    .map(action => [action, source[action]]))
}

/** Effective mode, including the backward-compatible boolean fallback. */
export function actionModeOf(mandate, action) {
  const explicit = normalizeActionModes(mandate?.actionModes)[action]
  return explicit ?? (mandate?.actions?.[action] === true ? 'auto' : 'deny')
}

function normalizeActions(value, fallback = DISABLED_ACTIONS) {
  const source = isPlainObject(value) ? value : {}
  const previous = isPlainObject(fallback) ? fallback : DISABLED_ACTIONS
  const out = {}
  for (const action of ACTIONS) {
    if (READ_ONLY_ACTIONS.includes(action)) continue
    out[action] = source[action] === undefined ? previous[action] === true : source[action] === true
  }
  return out
}

function normalizeAllConsent(value) {
  if (!isPlainObject(value)) return null
  if (value.text !== 'ALL_PROJECTS') return null
  const at = Number(value.at)
  if (!Number.isFinite(at) || at <= 0) return null
  return { at: Math.trunc(at), by: text(value.by, MAX_NAME) || 'operator', text: 'ALL_PROJECTS', version: 1 }
}

function normalizeMigratedFrom(value) {
  if (!isPlainObject(value)) return null
  const at = Number(value.at)
  return {
    mode: text(value.mode, 20) || 'unknown',
    allowedWorkspaces: uniqueKeys(value.allowedWorkspaces),
    at: Number.isFinite(at) ? Math.trunc(at) : 0,
    reason: text(value.reason, 80) || 'goal6_scope_mode_v2',
  }
}

/** A brand new mandate: nothing is authorized. */
export function emptyMandate(now = Date.now()) {
  return {
    version: 2,
    scopeMode: 'none',
    selectedWorkspaces: [],
    allConsent: null,
    level: 'L0',
    actions: { ...DISABLED_ACTIONS },
    actionModes: {},
    projects: {},
    paused: false,
    revision: 0,
    updatedAt: Math.trunc(now),
    updatedBy: 'system',
    migratedFrom: null,
    requiresConfiguration: true,
    consentVersion: 1,
  }
}

/**
 * Normalize an untrusted mandate (persisted file, HTTP body, fixture).
 *
 * Safety properties, each covered by a test:
 *   - an unknown/absent scopeMode becomes `none`;
 *   - `all` without a valid recorded consent is downgraded to `none`;
 *   - `selected` keeps only safe, deduplicated workspace ids;
 *   - every mutating action defaults to `false`;
 *   - a level never rises above the fallback ceiling;
 *   - `requiresConfiguration` stays true until explicitly cleared.
 */
export function normalizeMandate(input, fallback = emptyMandate()) {
  const source = isPlainObject(input) ? input : {}
  const previous = isPlainObject(fallback) ? fallback : emptyMandate()
  const allConsent = normalizeAllConsent(source.allConsent) ?? (source.allConsent === undefined ? previous.allConsent : null)
  let scopeMode = SCOPE_MODES.includes(source.scopeMode)
    ? source.scopeMode
    : (SCOPE_MODES.includes(previous.scopeMode) ? previous.scopeMode : 'none')
  // Consent is a precondition, never a consequence: a hand-edited "all" without
  // the recorded ALL_PROJECTS consent is refused, not trusted.
  if (scopeMode === 'all' && allConsent === null) scopeMode = 'none'
  const selectedWorkspaces = scopeMode === 'selected'
    ? uniqueKeys(source.selectedWorkspaces ?? previous.selectedWorkspaces)
    : []
  // `selected` with no existing workspace authorizes nothing.
  const effectiveScope = scopeMode === 'selected' && selectedWorkspaces.length === 0 ? 'none' : scopeMode
  // The level is read as-is (a valid L0–L4 enum). Raising it is a deliberate,
  // audited operator action, not something normalization may silently undo — and
  // a persisted state must round-trip without losing the operator's ceiling.
  const level = levelOf(source.level, previous.level ?? 'L0')
  const actions = normalizeActions(source.actions, previous.actions ?? DISABLED_ACTIONS)
  const actionModes = normalizeActionModes(previous.actionModes)
  // A legacy boolean patch is an explicit replacement of that action's mode.
  // A mode supplied in the same patch wins; invalid modes fail closed.
  for (const action of Object.keys(actions)) {
    if (isPlainObject(source.actions) && Object.hasOwn(source.actions, action)) delete actionModes[action]
    if (isPlainObject(source.actionModes) && Object.hasOwn(source.actionModes, action)) {
      actionModes[action] = ACTION_MODES.includes(source.actionModes[action]) ? source.actionModes[action] : 'deny'
    }
    if (Object.hasOwn(actionModes, action)) actions[action] = actionModes[action] !== 'deny'
  }
  return {
    version: 2,
    scopeMode: effectiveScope,
    selectedWorkspaces: effectiveScope === 'selected' ? selectedWorkspaces : [],
    allConsent: effectiveScope === 'all' ? allConsent : null,
    level,
    actions,
    actionModes,
    projects: source.projects === undefined ? normalizeProjects(previous.projects) : normalizeProjects({ ...previous.projects, ...source.projects }),
    paused: source.paused === undefined ? previous.paused === true : source.paused === true,
    revision: clampInt(source.revision, 0, 1_000_000_000, previous.revision ?? 0),
    updatedAt: clampInt(source.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    updatedBy: text(source.updatedBy, MAX_NAME) || 'operator',
    migratedFrom: source.migratedFrom === undefined ? normalizeMigratedFrom(previous.migratedFrom) : normalizeMigratedFrom(source.migratedFrom),
    requiresConfiguration: source.requiresConfiguration === undefined
      ? previous.requiresConfiguration !== false
      : source.requiresConfiguration === true,
    consentVersion: 1,
  }
}

/**
 * Restrictive migration from the schemaVersion 1 policy.
 *
 * The old semantic (`allowedWorkspaces: []` = every workspace) is the defect
 * that launched a Unifia task. It is never reproduced: an empty legacy list
 * maps to `none`, a non-empty one to `selected`; the level is capped at L1; all
 * mutating actions stay disabled and `requiresConfiguration` blocks resumes
 * until the operator confirms a new mandate.
 */
export function migrateLegacyPolicy({ policy, mode, now = Date.now() } = {}) {
  const legacy = isPlainObject(policy) ? policy : {}
  const allowed = uniqueKeys(legacy.allowedWorkspaces)
  const scopeMode = allowed.length > 0 ? 'selected' : 'none'
  const projects = {}
  for (const workspaceId of allowed) {
    projects[workspaceId] = normalizeProjectPolicy({
      enabled: false,
      level: 'L0',
      priority: 5,
      budget: { maxTasksPerHour: clampInt(legacy.autonomyBudget?.maxTasksPerHour, 0, 100, 0) },
    })
  }
  const legacyMode = typeof mode === 'string' ? mode : (typeof legacy.mode === 'string' ? legacy.mode : 'off')
  // Supervised and autonomous both land on L1: the upgrade grants no new power.
  const level = legacyMode === 'off' ? 'L0' : 'L1'
  const at = Math.trunc(now)
  const mandate = normalizeMandate({
    scopeMode,
    selectedWorkspaces: allowed,
    level,
    actions: { ...DISABLED_ACTIONS },
    projects,
    paused: false,
    revision: 1,
    updatedAt: at,
    updatedBy: 'migration',
    migratedFrom: { mode: legacyMode, allowedWorkspaces: allowed, at, reason: 'goal6_scope_mode_v2' },
    requiresConfiguration: true,
  })
  return {
    mandate,
    audit: {
      type: 'mandate_migrated',
      at,
      from: { mode: legacyMode, allowedWorkspaces: allowed },
      to: { scopeMode: mandate.scopeMode, level: mandate.level, requiresConfiguration: true },
      reason: 'goal6_scope_mode_v2',
    },
  }
}

/**
 * The single authorization decision.
 *
 * @param {object} input
 * @param {object} input.mandate        normalized mandate
 * @param {string} [input.projectId]    workspace the action targets
 * @param {string} input.action         one of ACTIONS
 * @param {string} [input.integration]  board | taskboard | github | forge
 * @param {string} [input.mode]         legacy off/supervised/autonomous (off denies)
 * @param {boolean} [input.stopped]     operator Stop is active
 * @param {boolean} [input.approved]    a valid, non-expired human approval exists
 * @param {number} [input.running]      active assignments
 * @param {number} [input.maxConcurrent]
 * @returns {{allowed:boolean,reason:string,level:string,requiredLevel:string,
 *            scope:string,requiresApproval:boolean,requiresHumanDecision:boolean,
 *            projectSelected:boolean}}
 */
export function effectivePolicyOf({
  mandate,
  projectId,
  action,
  integration = 'board',
  mode = 'supervised',
  stopped = false,
  paused = false,
  approved = false,
  running = 0,
  maxConcurrent = Number.POSITIVE_INFINITY,
} = {}) {
  const current = normalizeMandate(mandate)
  const requiredLevel = ACTION_MIN_LEVEL[action] ?? 'L4'
  const scope = current.scopeMode
  const projectSelected = scope === 'all'
    || (scope === 'selected' && typeof projectId === 'string' && current.selectedWorkspaces.includes(projectId))
  const project = typeof projectId === 'string' && Object.hasOwn(current.projects, projectId)
    ? current.projects[projectId]
    : null
  // `all` is the operator's explicit consent for every recognized project, so a
  // project with no explicit policy row is enabled at the global ceiling. Under
  // `selected`, a missing row is disabled — selection is not a grant.
  const projectEnabled = project !== null ? project.enabled === true : scope === 'all'
  const projectLevel = project !== null ? (project.level ?? current.level) : current.level
  const projectBudget = project !== null ? project.budget.maxTasksPerHour : Number.POSITIVE_INFINITY
  const integrationCeiling = INTEGRATION_CEILING[integration]?.[action] ?? 'L4'
  const level = minLevel(current.level, minLevel(projectLevel, integrationCeiling))
  const critical = CRITICAL_ACTIONS.includes(action)
  const readOnly = READ_ONLY_ACTIONS.includes(action)
  const base = {
    allowed: false,
    level,
    requiredLevel,
    scope,
    requiresApproval: false,
    requiresHumanDecision: critical,
    projectSelected,
  }

  // 1. Hard stops first, so the reason is the real one.
  if (mode === 'off' && action !== 'read') return { ...base, reason: 'mode_off' }
  if (stopped) return { ...base, reason: 'stopped_by_operator' }
  if (current.paused || paused === true) return { ...base, reason: 'paused_by_operator' }

  // 2. Read-only actions never need a project scope (diagnostics stay possible).
  if (readOnly) {
    if (LEVEL_RANK[level] < LEVEL_RANK[requiredLevel]) return { ...base, reason: 'level_too_low' }
    return { ...base, allowed: true, reason: 'allowed' }
  }

  // 3. Scope is explicit, never implicit.
  if (scope === 'none') return { ...base, reason: 'scope_none' }
  if (!projectSelected) return { ...base, reason: 'project_not_selected' }

  // 4. The project must be independently enabled and configured.
  if (current.requiresConfiguration) return { ...base, reason: 'requires_configuration' }
  if (!projectEnabled) return { ...base, reason: 'project_disabled' }
  if (projectBudget === 0 && (action === 'launch' || action === 'schedule')) {
    return { ...base, reason: 'project_budget_exhausted' }
  }

  // Explicit tri-state grants treat the action minimum as an AUTOMATION
  // threshold. L2+ can approve noncritical work below it; legacy booleans keep
  // their historical hard minimum. Capability/executor checks remain external.
  const actionMode = actionModeOf(current, action)
  const belowMinimum = LEVEL_RANK[level] < LEVEL_RANK[requiredLevel]
  const approvalFallback = Object.hasOwn(current.actionModes, action)
    && actionMode !== 'deny' && !critical && LEVEL_RANK[level] >= LEVEL_RANK.L2
  // 5. Level ladder (global ∩ project ∩ integration ∩ action).
  if (belowMinimum && !approvalFallback) return { ...base, reason: 'level_too_low' }

  // 6. The operator's per-action grant.
  if (current.actions[action] !== true) {
    return { ...base, reason: critical ? 'critical_action_not_granted' : 'action_disabled' }
  }

  // 7. Concurrency is a real refusal, not decoration.
  if ((action === 'launch' || action === 'delegate') && Number(running) >= Number(maxConcurrent)) {
    return { ...base, reason: 'concurrency_limit', requiresApproval: LEVEL_RANK[level] < LEVEL_RANK.L3 }
  }

  // 8. L2 executes prepared changes only after a real, non-expired approval;
  //    critical actions always need a per-occurrence human decision.
  const requiresApproval = actionMode === 'ask' || belowMinimum || LEVEL_RANK[level] < LEVEL_RANK.L3
  if (critical) {
    return approved
      ? { ...base, allowed: true, reason: 'allowed', requiresApproval: true }
      : { ...base, reason: 'approval_required', requiresApproval: true }
  }
  if (requiresApproval) {
    return approved
      ? { ...base, allowed: true, reason: 'allowed', requiresApproval: true }
      : { ...base, reason: 'approval_required', requiresApproval: true }
  }
  return { ...base, allowed: true, reason: 'allowed' }
}

/** Readable alias used by callers that only need the decision. */
export function mandateAllows(mandate, probe = {}) {
  return effectivePolicyOf({ ...probe, mandate })
}

/** Convenience: which levels can perform an action (for UI hints/tests). */
export function levelsForAction(action) {
  const required = ACTION_MIN_LEVEL[action]
  if (required === undefined) return []
  return AUTONOMY_LEVELS.filter(level => LEVEL_RANK[level] >= LEVEL_RANK[required])
}

/** A French, operator-facing summary. Never invents a enabled capability. */
export function describeMandate(mandate) {
  const current = normalizeMandate(mandate)
  const scopeLabel = current.scopeMode === 'all'
    ? 'Tous les projets (consentement enregistré)'
    : current.scopeMode === 'selected'
      ? `${current.selectedWorkspaces.length} projet(s) sélectionné(s)`
      : 'Aucun projet'
  const enabledProjects = Object.values(current.projects).filter(project => project.enabled).length
  return {
    scopeMode: current.scopeMode,
    scopeLabel,
    projectCount: current.selectedWorkspaces.length,
    enabledProjects,
    level: current.level,
    paused: current.paused,
    requiresConfiguration: current.requiresConfiguration,
    actionsEnabled: Object.entries(current.actions).filter(([, value]) => value === true).map(([key]) => key),
  }
}

/**
 * Apply an operator patch to a mandate (POST /mandate). Unknown keys are
 * dropped, the revision is bumped and the update is timestamped. Granting
 * `all` requires the explicit confirmation text; without it the patch is
 * refused rather than silently downgraded (the caller must say no clearly).
 * Actions/modes merge per key. Boolean-only keys replace previous explicit
 * modes; mode keys win same-patch conflicts and refresh the boolean mirror.
 * Keep actionModes sparse during migration: filling inherited `auto` entries
 * would opt legacy grants into the new supervised fallback below their minimum.
 */
export function applyMandatePatch(current, patch = {}, { now = Date.now(), by = 'operator' } = {}) {
  const previous = normalizeMandate(current)
  const source = isPlainObject(patch) ? patch : {}
  if (source.scopeMode === 'all') {
    const consent = normalizeAllConsent(source.allConsent)
    if (consent === null) return { ok: false, reason: 'all_scope_requires_confirmation' }
  }
  if (source.scopeMode === 'selected' && uniqueKeys(source.selectedWorkspaces).length === 0) {
    return { ok: false, reason: 'selected_scope_requires_workspaces' }
  }
  const next = normalizeMandate({
    ...source,
    // A level change is accepted here but must be audited by the caller: the
    // dedicated POST /mandate/level path writes the entry, and a patch that only
    // repeats the current level changes nothing.
    level: source.level === undefined ? previous.level : source.level,
    revision: previous.revision + 1,
    updatedAt: Math.trunc(now),
    updatedBy: text(by, MAX_NAME) || 'operator',
    requiresConfiguration: source.requiresConfiguration === undefined ? previous.requiresConfiguration : source.requiresConfiguration,
  }, previous)
  return { ok: true, mandate: next }
}
