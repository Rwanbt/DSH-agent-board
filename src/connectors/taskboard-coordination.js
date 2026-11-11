/**
 * Task Board coordination read model (P3).
 *
 * This module is the ONLY place the supervision layer reads Task Board state.
 * It maps the real `GET /dsh-taskboard/state` records into a bounded, pure read
 * model (tasks, dependencies, cross-project edges, honest capabilities) and it
 * NEVER writes: the Task Board stays the source of truth for tasks, subtasks,
 * dependencies, Kanban columns, priorities, milestones and forge sync.
 *
 * No board-facing write API exists today, so the write capabilities below are
 * `false`. They are REPORTED, never emulated: `buildCoordinationProposal()`
 * returns a local recommendation with `applies:false` (or an explicit
 * `writes_unavailable` refusal), exactly like the execution-contract client
 * refuses to fake an execution it does not own. `done` remains human-only.
 *
 * The module has no import, no `fetch`, no clock and no I/O, so the same input
 * always produces the same output (stable ordering, bounded arrays) and a unit
 * test can prove that no request is ever performed.
 *
 * @module dsh-agent-board/connectors/taskboard-coordination
 */

/** The capability matrix. `read` is the only capability implemented today. */
export const COORDINATION_CAPABILITIES = Object.freeze({
  read: true,
  proposeReassignment: false,
  proposePriority: false,
  proposeBlocked: false,
  writeKanban: false,
  requestReview: false,
})

/**
 * Hard bounds on the read model. Counts, not semantics: a Task Board with more
 * tasks is truncated (deterministically, by id) instead of flooding the host
 * projection. `dependsOnPerTask` mirrors the Task Board's own
 * `MAX_TASK_DEPENDENCIES` (32) so a legal record is never truncated.
 */
export const COORDINATION_LIMITS = Object.freeze({
  tasks: 500,
  dependencies: 1000,
  dependsOnPerTask: 32,
})

/** Constant note attached to every model; states the ownership boundary. */
export const COORDINATION_NOTES = 'Task Board remains the source of truth; this adapter never writes.'

/**
 * The endpoints the Task Board WOULD have to expose before the board may apply
 * a coordination write. They are PROPOSED and SIMULATED-ONLY in tests: no real
 * Task Board (0.10/0.11) serves any of them, the board never calls them, and
 * `COORDINATION_CAPABILITIES` keeps every matching flag `false`.
 *
 * Promotion mirrors `docs/TASKBOARD-CONTRACT.md`: the Task Board would announce
 * these capabilities through a versioned negotiation before the board performs
 * one write, every route would fence on `expectedVersion`, require an
 * `idempotencyKey`, accept only a reason-bearing body, and refuse a transition
 * to `done` (human-only).
 */
export const PROPOSED_COORDINATION_ENDPOINTS = Object.freeze({
  proposeReassignment: Object.freeze({
    capability: 'proposeReassignment',
    method: 'POST',
    path: '/dsh-taskboard/tasks/:id/coordination/reassign',
    body: Object.freeze({ assignee: 'string', expectedVersion: 'integer', idempotencyKey: 'string', reason: 'string' }),
    status: 'proposed',
  }),
  proposePriority: Object.freeze({
    capability: 'proposePriority',
    method: 'POST',
    path: '/dsh-taskboard/tasks/:id/coordination/priority',
    body: Object.freeze({ priority: 'string', expectedVersion: 'integer', idempotencyKey: 'string', reason: 'string' }),
    status: 'proposed',
  }),
  proposeBlocked: Object.freeze({
    capability: 'proposeBlocked',
    method: 'POST',
    path: '/dsh-taskboard/tasks/:id/coordination/block',
    body: Object.freeze({ blocked: 'boolean', expectedVersion: 'integer', idempotencyKey: 'string', reason: 'string' }),
    status: 'proposed',
  }),
  writeKanban: Object.freeze({
    capability: 'writeKanban',
    method: 'POST',
    path: '/dsh-taskboard/tasks/:id/coordination/column',
    body: Object.freeze({ status: 'string', expectedVersion: 'integer', idempotencyKey: 'string', reason: 'string' }),
    status: 'proposed',
  }),
  requestReview: Object.freeze({
    capability: 'requestReview',
    method: 'POST',
    path: '/dsh-taskboard/tasks/:id/coordination/review',
    body: Object.freeze({ expectedVersion: 'integer', idempotencyKey: 'string', reason: 'string' }),
    status: 'proposed',
  }),
})

/** Coordination kinds that would REQUIRE a Task Board write. */
const WRITE_KINDS = Object.freeze({
  reassign: 'proposeReassignment',
  reassignment: 'proposeReassignment',
  priority: 'proposePriority',
  blocked: 'proposeBlocked',
  move: 'writeKanban',
  kanban: 'writeKanban',
  review: 'requestReview',
})

/**
 * Kinds that produce a local recommendation only. `delegate` is the
 * supervision layer's own action (launch/assign an agent) and `unblock` only
 * recommends proceeding once prerequisites are done; neither needs a Task Board
 * write, so both are honest with `applies:false`.
 */
const LOCAL_KINDS = Object.freeze(['delegate', 'unblock'])

const SOURCES = Object.freeze(['live', 'simulated', 'absent'])
const MAX_REASON = 500
const MAX_EVIDENCE_KEYS = 20
const MAX_EVIDENCE_ITEMS = 20
const MAX_EVIDENCE_STRING = 500

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Locale-independent comparison: the output must not depend on the host locale. */
function compareIds(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sourceOf(state, meta) {
  if (SOURCES.includes(meta.source)) return meta.source
  if (meta.simulated === true) return 'simulated'
  if (isObject(state) && state.simulated === true) return 'simulated'
  if (isObject(state) && isObject(state.meta) && state.meta.simulated === true) return 'simulated'
  return state === null || state === undefined ? 'absent' : 'live'
}

function reasonOf(meta) {
  return typeof meta.reason === 'string' && meta.reason !== '' ? meta.reason : null
}

/** Accept the raw `/state` value, its `{ ok:true, value }` envelope, or `list()`. */
function unwrapState(value) {
  if (isObject(value) && value.ok === true && isObject(value.value)) return value.value
  return value
}

/** The task array of a raw state, of `list()` output, or a bare task array. */
function taskListOf(state) {
  if (Array.isArray(state)) return state
  if (isObject(state) && Array.isArray(state.tasks)) return state.tasks
  if (isObject(state) && Array.isArray(state.items)) return state.items
  return null
}

function taskIsTrashed(raw) {
  return raw.trashedAt !== null && raw.trashedAt !== undefined
}

/** Normalized owning project id: raw `projectId`, else `project.id`, else workspaceId. */
function projectIdOf(raw, workspaceId) {
  if (typeof raw.projectId === 'string' && raw.projectId !== '') return raw.projectId
  if (isObject(raw.project) && typeof raw.project.id === 'string' && raw.project.id !== '') return raw.project.id
  return workspaceId !== '' ? workspaceId : null
}

function priorityOf(raw) {
  if (typeof raw.priority === 'string' && raw.priority !== '') return raw.priority
  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) return raw.priority
  return null
}

function assigneeOf(raw) {
  if (typeof raw.assignee === 'string' && raw.assignee !== '') return raw.assignee
  if (typeof raw.claimedBy === 'string' && raw.claimedBy !== '') return raw.claimedBy
  return null
}

/**
 * One Task Board record -> one bounded read-model task, or null when the record
 * is unusable (no string id). Works on the raw TaskRecord AND on the connector's
 * normalized item: `revision`/`version`, `assignee`/`claimedBy` and
 * `project`/`workspaceId` are read with documented fallbacks.
 */
function normalizeModelTask(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '') return null
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : ''
  const dependsOn = Array.isArray(raw.dependsOn)
    ? [...new Set(raw.dependsOn.filter(id => typeof id === 'string' && id !== ''))].sort(compareIds).slice(0, COORDINATION_LIMITS.dependsOnPerTask)
    : []
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    priority: priorityOf(raw),
    workspaceId,
    projectId: projectIdOf(raw, workspaceId),
    dependsOn,
    assignee: assigneeOf(raw),
    // Real ledger timestamp (used as the FACT time of a task block/edge, never a
    // rebuild-observation timestamp). Absent stays null, never `now`.
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : null,
    revision: Number.isSafeInteger(raw.revision)
      ? raw.revision
      : (Number.isSafeInteger(raw.version) ? raw.version : null),
  }
}

function unavailableModel(reason, source) {
  return {
    available: false,
    reason,
    source,
    tasks: [],
    dependencies: [],
    capabilities: { ...COORDINATION_CAPABILITIES, read: false },
    notes: COORDINATION_NOTES,
  }
}

/**
 * Build the coordination read model from the Task Board state (or from nothing
 * when the plugin is absent/unreachable). Pure and total: malformed input never
 * throws, it degrades to `available:false` with a reason.
 *
 * @param {object|null|undefined} taskboardState raw `/dsh-taskboard/state` value
 *   (or its `{ ok:true, value }` envelope, the adapter's `list()` result, or a
 *   bare task array — all are normalized to the same read model).
 * @param {{
 *   source?: 'live'|'simulated'|'absent',
 *   simulated?: boolean,
 *   reason?: string|null,
 *   ledgerRevision?: number|null,
 *   tasksTotal?: number|null,
 * }} [meta] provenance the HOST knows: `source` is the only honest way to label
 *   a snapshot (the model never probes or infers a live connection from nothing);
 *   `reason` is preserved when the snapshot is unavailable.
 * @returns {{
 *   available: boolean,
 *   reason: string|null,
 *   source: 'live'|'simulated'|'absent',
 *   tasks: object[],
 *   dependencies: { taskId: string, dependsOnTaskId: string, crossProject: boolean }[],
 *   capabilities: Record<string, boolean>,
 *   notes: string,
 * }}
 */
export function readCoordinationModel(taskboardState, meta = {}) {
  const metaInfo = isObject(meta) ? meta : {}
  const state = unwrapState(taskboardState)
  const source = sourceOf(state, metaInfo)

  // An absent/unreachable board is not an error: the Agent Board keeps working
  // with an empty model and an explicit reason.
  if (source === 'absent' || state === null || state === undefined) {
    return unavailableModel(reasonOf(metaInfo) ?? 'taskboard_absent', 'absent')
  }
  const list = taskListOf(state)
  if (list === null) {
    return unavailableModel(reasonOf(metaInfo) ?? 'taskboard_malformed', source)
  }

  const seen = new Set()
  const collected = []
  for (const raw of list) {
    if (!isObject(raw)) continue
    // Trashed cards are not actionable work and are deliberately excluded from
    // the coordination model (the adapter still exposes them for the ledger view).
    if (taskIsTrashed(raw)) continue
    const task = normalizeModelTask(raw)
    if (task === null) continue
    // A malformed snapshot can repeat an id. Keep the first occurrence so the
    // result is deterministic; duplicates are a payload defect, not a merge.
    if (seen.has(task.id)) continue
    seen.add(task.id)
    collected.push(task)
  }
  collected.sort((a, b) => compareIds(a.id, b.id))
  const tasks = collected.slice(0, COORDINATION_LIMITS.tasks)
  const truncatedTasks = collected.length > tasks.length

  const taskById = new Map(tasks.map(task => [task.id, task]))
  const edges = []
  for (const task of tasks) {
    for (const dependsOnTaskId of task.dependsOn) {
      const target = taskById.get(dependsOnTaskId) ?? null
      // crossProject is FALSE when either side is unknown: an unresolved
      // prerequisite is not evidence of a cross-project edge. Edges are kept so
      // the consumer can still see the declared dependency.
      edges.push({
        taskId: task.id,
        dependsOnTaskId,
        crossProject: target !== null
          && task.projectId !== null
          && target.projectId !== null
          && task.projectId !== target.projectId,
      })
    }
  }
  edges.sort((a, b) => compareIds(a.taskId, b.taskId) || compareIds(a.dependsOnTaskId, b.dependsOnTaskId))
  const dependencies = edges.slice(0, COORDINATION_LIMITS.dependencies)

  let notes = COORDINATION_NOTES
  if (truncatedTasks) {
    notes += ` Read model bounded to ${COORDINATION_LIMITS.tasks} of ${collected.length} tasks (sorted by id).`
  }
  if (edges.length > dependencies.length) {
    notes += ` Dependency edges bounded to ${COORDINATION_LIMITS.dependencies} (sorted by task id).`
  }

  return {
    available: true,
    reason: null,
    source,
    tasks,
    dependencies,
    capabilities: { ...COORDINATION_CAPABILITIES },
    notes,
  }
}

function refusal(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

/** JSON-safe, bounded, deterministically keyed copy of the caller's evidence. */
function boundedEvidence(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, MAX_EVIDENCE_STRING)
  if (depth >= 2) return '[bounded]'
  if (Array.isArray(value)) return value.slice(0, MAX_EVIDENCE_ITEMS).map(entry => boundedEvidence(entry, depth + 1))
  if (isObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort().slice(0, MAX_EVIDENCE_KEYS)) {
      out[key] = boundedEvidence(value[key], depth + 1)
    }
    return out
  }
  return null
}

function proposalFor(task, request) {
  const kind = request.kind
  const reason = typeof request.reason === 'string' ? request.reason.trim().slice(0, MAX_REASON) : ''
  if (reason === '') {
    return refusal('invalid_request', 'request.reason must be a non-empty string; a recommendation without a reason is not emitted')
  }
  return {
    ok: true,
    proposal: {
      id: `dsh-agent-board:coordination:${kind}:${task.id}`,
      kind,
      taskId: task.id,
      projectId: task.projectId ?? (typeof task.workspaceId === 'string' && task.workspaceId !== '' ? task.workspaceId : null),
      reason,
      evidence: boundedEvidence(request.evidence),
      applies: false,
      status: 'proposed',
    },
  }
}

function writesUnavailable(kind, capability) {
  const endpoint = PROPOSED_COORDINATION_ENDPOINTS[capability]
  return refusal(
    'writes_unavailable',
    `the Task Board exposes no board-facing write API for "${kind}"; nothing was written. `
      + `To promote this capability the Task Board would have to expose ${endpoint.method} ${endpoint.path} `
      + '(PROPOSED; not implemented by the real plugin and never called by this adapter).',
    { expectedEndpoints: [`${endpoint.method} ${endpoint.path}`] },
  )
}

/**
 * A coordination proposal is a local RECOMMENDATION, never a write.
 *
 * `delegate` and `unblock` produce a proposal (local supervision actions, no
 * Task Board write). Every write-oriented kind (`reassign`, `priority`,
 * `blocked`, `move`, `review`) is refused with `writes_unavailable` and the
 * documented PROPOSED endpoint, because no board-facing write API exists and
 * `COORDINATION_CAPABILITIES` deliberately implements none. A forged
 * `model.capabilities` flag can never unlock a write either.
 *
 * @param {object} model `readCoordinationModel()` output
 * @param {{ kind: string, taskId: string, reason: string, evidence?: object }} request
 * @returns {{ ok: true, proposal: object } | { ok: false, code: string, message: string, [key: string]: any }}
 */
export function buildCoordinationProposal(model, request = {}) {
  const req = isObject(request) ? request : {}
  if (!isObject(model) || model.available !== true || !Array.isArray(model.tasks)) {
    const reason = isObject(model) && typeof model.reason === 'string' && model.reason !== '' ? model.reason : null
    return refusal(
      'taskboard_unavailable',
      `the Task Board read model is unavailable${reason === null ? '' : ` (${reason})`}; no coordination proposal can be made`,
    )
  }
  if (typeof req.taskId !== 'string' || req.taskId === '') {
    return refusal('invalid_request', 'request.taskId must be a non-empty string')
  }
  if (typeof req.kind !== 'string' || req.kind === '') {
    return refusal('invalid_request', 'request.kind must be a non-empty string')
  }
  const task = model.tasks.find(entry => isObject(entry) && entry.id === req.taskId) ?? null
  if (task === null) {
    return refusal('task_not_found', `task ${req.taskId} is not in the Task Board read model`)
  }
  if (LOCAL_KINDS.includes(req.kind)) return proposalFor(task, req)

  const capability = WRITE_KINDS[req.kind]
  if (capability === undefined) {
    return refusal('invalid_kind', `unknown coordination kind "${req.kind}"; expected one of ${[...Object.keys(WRITE_KINDS), ...LOCAL_KINDS].sort(compareIds).join(', ')}`)
  }
  // Two independent gates: THIS module must implement the capability, and the
  // read model must advertise it. Neither is true today, and a read model alone
  // can never grant a write this module does not implement.
  const implemented = COORDINATION_CAPABILITIES[capability] === true
  const advertised = isObject(model.capabilities) && model.capabilities[capability] === true
  if (!implemented || !advertised) return writesUnavailable(req.kind, capability)

  // Unreachable today (kept so the gate is explicit if the Task Board ever
  // negotiates the capability): a proposal stays local and `applies:false`.
  return proposalFor(task, req)
}
