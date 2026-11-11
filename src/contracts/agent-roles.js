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
export const AGENT_ROLES = Object.freeze({
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

export const AGENT_ROLE_IDS = Object.freeze(Object.keys(AGENT_ROLES))

/** Families keep the six approved silhouettes recognisable as camaïeux. */
export const AGENT_FAMILIES = Object.freeze({
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
export const AGENT_ROLE_ALIASES = Object.freeze({
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
export const AGENT_TONES = Object.freeze({
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
export const AGENT_STATUS_TONE = Object.freeze({
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
export const AGENT_TASK_STATE_TONE = Object.freeze({
  todo: 'idle',
  in_progress: 'active',
  in_review: 'reviewing',
  blocked: 'blocked',
  done: 'done',
})

export const TASK_STATE_TONES = Object.freeze(Object.keys(AGENT_TASK_STATE_TONE))

/** Normalize a declared role/name for alias lookup (never mutates the input data). */
export function normalizeAgentRoleKey(value) {
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
export function dabResolveAgentRole(value) {
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
export function dabAvatarVariantForSize(size) {
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
export function dabAgentAvatarModel(input = {}) {
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
