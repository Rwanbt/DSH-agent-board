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

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
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
      }
    }
  }
  if (row === undefined) {
    // No live session row. Even a stale turn end, unread flag or ack in the host
    // state cannot prove it finished: the runtime no longer knows it.
    return { status: STATUS.UNKNOWN, reason: 'no_row_for_session', source: 'none', at: null }
  }
  // Failure truth: the host-recorded turn end wins, then the native lifecycle
  // fact. A recovered failure (a later turn started) is no longer a failure.
  if (end !== null && ERROR_TURN_KINDS.includes(end.kind) && end.recoveredAt === undefined) {
    const covered = hasSeen && Number.isFinite(endAt) && seenAt >= endAt
    return failed(`turn_end:${end.kind}`, 'host_turn_end', Number.isFinite(endAt) ? endAt : null, { _seen: covered })
  }
  if ((end === null || end.recoveredAt !== undefined) && nativeEnd !== null && ERROR_TURN_KINDS.includes(nativeEnd.reason)) {
    // Native-only failure: the host may have missed the event (restart). There
    // is no board ack that could have covered it, so it stays unread/visible.
    return failed(`native_turn_end:${nativeEnd.reason}`, 'session_projection', null, { _seen: false })
  }
  // Session truth: an agent the runtime reports as gone is `unavailable`, even
  // when a turn end was recorded earlier. It is never "finished".
  if (row?.agentAvailable === false) {
    return { status: STATUS.UNAVAILABLE, reason: 'agent_not_available', source: 'session_row', at: null }
  }
  if (end !== null && Number.isFinite(endAt)) {
    if (INTERRUPTED_TURN_KINDS.includes(end.kind)) {
      return { status: STATUS.IDLE, reason: `turn_ended:${end.kind}`, source: 'host_turn_end', at: endAt }
    }
    if (hasSeen && seenAt >= endAt) {
      return { status: STATUS.FINISHED_READ, reason: `ack_after_turn:${end.kind}`, source: 'host_turn_end', at: endAt }
    }
    return { status: STATUS.FINISHED_UNREAD, reason: `turn_end:${end.kind}_not_acknowledged`, source: 'host_turn_end', at: endAt }
  }
  if (live?.completionUnread === true) {
    // The native runtime also tracks unread completions. An explicit board ack
    // that is newer than the session's last activity covers it; otherwise the
    // pill would be impossible to clear.
    if (hasSeen && Number.isFinite(updatedAt) && seenAt >= updatedAt) {
      return { status: STATUS.FINISHED_READ, reason: 'ack_after_native_activity', source: 'host_status', at: seenAt }
    }
    return { status: STATUS.FINISHED_UNREAD, reason: 'native_completion_unread', source: 'host_status', at: null }
  }
  if (nativeEnd !== null) {
    // A turn that completed before the board observed it is history, not "new".
    // A native-only turn end has no timestamp, so it can never be "recent".
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
 * The injected resolver is authoritative: when it is supplied, its `null`
 * result means "unknown" and no other field is used as a fallback. A throw is
 * treated as unknown (the panel must never crash on a resolver).
 *
 * Precedence: injected/native `modelSelection` projection, then the board
 * assignment that launched the card (a real fact about that launch). An
 * assignment route is NEVER copied onto a native session: an assignment only
 * exists for a card the board launched.
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
 */
function trackModelChange(memory, sessionId, model, now = Date.now(), { limit = MODEL_HISTORY_LIMIT, maxSessions = 512 } = {}) {
  if (memory === null || typeof memory?.get !== 'function' || typeof memory.set !== 'function') return null
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
  const entry = { from: current.last, to: label, at: Number(now) || null, reason: 'model_change', source: 'native' }
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

/**
 * The final answer excerpt. Only an answer that closed a turn is "final":
 *   1. host-captured last assistant message when the session is not running
 *      and a turn end was recorded at/after it;
 *   2. the native turn outline `response` of the latest answered turn;
 *   3. a board checkpoint text.
 * A mid-turn assistant segment (between tool calls) is never presented as the
 * final answer; it is exposed separately as `interim` only for activity.
 */
function previewOf(hostState, sessionId, assignment, row, running = false) {
  const preview = hostState?.previews?.[sessionId]
  const end = hostState?.turnEnd?.[sessionId]
  const hostText = preview !== undefined && typeof preview.text === 'string' ? preview.text.trim() : ''
  if (hostText !== '' && !running && end !== undefined && Number(end.at) >= Number(preview.at)) {
    // The captured segment is only a FINAL answer when the turn that closed it
    // actually completed. An error/aborted/unknown turn ends with a partial
    // segment, and an intermediate segment must never be labelled final.
    const kind = typeof end.kind === 'string' ? end.kind : 'unknown'
    const completed = !ERROR_TURN_KINDS.includes(kind) && !INTERRUPTED_TURN_KINDS.includes(kind) && kind !== 'unknown'
    return {
      text: truncate(hostText, 600),
      at: Number(preview.at) || null,
      final: completed,
      partial: !completed,
      turnEndKind: kind,
      source: 'host',
    }
  }
  const outline = row?.projectionValues?.turnOutline
  if (Array.isArray(outline)) {
    for (let index = outline.length - 1; index >= 0; index -= 1) {
      const entry = outline[index]
      const isOpenTurn = running && index === outline.length - 1
      if (!isOpenTurn && typeof entry?.response === 'string' && entry.response.trim() !== '') {
        return { text: truncate(entry.response.trim(), 600), at: null, final: true, partial: false, source: 'outline', turn: Number(entry.turn) || null }
      }
    }
  }
  const checkpointText = assignment?.checkpoint?.lastText
  if (!running && typeof checkpointText === 'string' && checkpointText !== '') {
    return { text: truncate(checkpointText, 600), at: Number(assignment?.checkpoint?.at) || null, final: true, partial: false, source: 'checkpoint' }
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
  for (const assignment of hostState.assignments ?? []) {
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
    const detail = classifyStatusDetailed({
      row,
      live,
      turnEnd,
      ack,
      assignment,
      gone: goneIndex.has(node.id),
      goneAt: goneIndex.get(node.id),
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
    const completedTurnEnd = endKind !== null && !ERROR_TURN_KINDS.includes(endKind) && !INTERRUPTED_TURN_KINDS.includes(endKind) && endKind !== 'unknown'
    // A real finish timestamp inside a bounded window. A future timestamp (host
    // and panel clocks differ) still counts: the flag must not flicker.
    const recentlyFinished = completedTurnEnd && Number.isFinite(endAt) && now - endAt <= windowMs
    // Explicit acknowledgement covers a failure only when a cursor exists and
    // it is at/after the recorded failure. A native-only failure has no such
    // cursor: it stays visible instead of silently leaving the home view.
    const seen = status === STATUS.FAILED ? detail._seen === true : status !== STATUS.FINISHED_UNREAD
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
      gone: goneIndex.has(node.id),
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
  if (node.status === STATUS.WAITING_USER) return true
  if (node.status === STATUS.RUNNING) return true
  if (node.status === STATUS.RECOVERING) return true
  // A stopped/superseded launch is unfinished work: never hidden as history.
  if (node.status === STATUS.INTERRUPTED) return true
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
      if (body?.ok !== true || body.value === null || typeof body.value !== 'object') throw new Error('invalid host state')
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
      if (parsed !== null && typeof parsed === 'object') {
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
    modelUnknown: 'inconnu',
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
    filterLabel: 'Filtre',
    orchestratorLabel: 'Orchestrateur',
    syncOk: 'Task Board synchronisé',
    syncError: 'Task Board injoignable',
    adapters: 'Adaptateurs',
    notLive: 'non validé live',
    keyboardHint: 'Entrée : ouvrir · Espace : aperçu · double-clic : ouvrir',
    projects: 'Projets',
    ago: 'il y a',
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
    modelUnknown: 'unknown',
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
    filterLabel: 'Filter',
    orchestratorLabel: 'Orchestrator',
    syncOk: 'Task Board synced',
    syncError: 'Task Board unreachable',
    adapters: 'Adapters',
    notLive: 'not validated live',
    keyboardHint: 'Enter: open · Space: preview · double-click: open',
    projects: 'Projects',
    ago: 'ago',
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
.dab-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; padding-left: 22px; }
.dab-meta > span { overflow: hidden; text-overflow: ellipsis; }
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


// ---- src/client/ui/card.js ----
/**
 * AgentCard: one compact card per agent. Pointer and keyboard go through the
 * shared click arbiter (single click = inspect, double click / Enter = open).
 * The branch toggle and the quick "open" button stop propagation so they never
 * trigger inspection or acknowledgement.
 *
 * @module dsh-agent-board/client/ui/card
 */

function dabCardSignature(props) {
  const node = props.node
  return [
    node.id, node.status, node.seen, node.title, node.role, node.updatedAt, node.expectedAction, node.waitingDetail,
    node.model?.model, node.model?.provider, node.model?.reasoningEffort, node.model?.source, node.recentlyFinished,
    node.taskId, node.error, node.orphan, node.parentCycle, node.parentReason, node.interrupted, node.providerUnavailable,
    props.selected, props.root, props.hiddenChildren, props.totalChildren, props.collapsed, props.expanded, props.groupActive,
    props.depth, props.compact, props.nowBucket,
  ].join('|')
}

function DabAgentCardImpl(props) {
  const { node, selected, root, arbiter, onToggleBranch, onRevealHidden, hiddenChildren, totalChildren, collapsed, expanded, groupActive, depth, compact } = props
  const h = React.createElement
  const modelLabel = dabModelText(node.model)
  const age = dabFormatAge(node.updatedAt)
  const statusText = dabStatusLabel(node.status)
  const calm = !(node.status === 'running' || node.status === 'recovering' || node.status === 'waiting_user' || node.status === 'finished_unread' || node.status === 'interrupted' || node.status === 'provider_unavailable' || (node.status === 'failed' && node.seen !== true))
  const label = [node.title, statusText, node.role, groupActive ? dabT('groupActive') : null].filter(Boolean).join(' — ')

  const stop = event => { event.stopPropagation() }
  const children = []
  children.push(h(
    'div', { className: 'dab-card-top', key: 'top' },
    h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', role: 'img', 'aria-label': statusText, title: statusText }),
    h('span', { className: 'dab-name', title: node.title }, node.title),
    h('button', {
      type: 'button', className: 'dab-icon-btn dab-quick', title: dabT('openSession'), 'aria-label': `${dabT('openSession')} : ${node.title}`,
      onClick: event => { stop(event); arbiter.open(node.id) },
      onDoubleClick: stop, onKeyDown: stop,
    }, '↗'),
  ))
  const meta = []
  if (node.role) meta.push(h('span', { key: 'role', className: 'dab-role' }, node.role))
  // Compact model chip: the card's provider/model fact, never a guess. The
  // height does not change: it lives in the existing single-line meta row.
  if (root || !node.role) {
    meta.push(h('span', {
      key: 'model',
      className: 'dab-chip',
      'data-source': typeof node.model?.source === 'string' ? node.model.source : 'unknown',
      title: dabModelTitle(node.model),
    }, modelLabel ?? dabT('noModel')))
  }
  if (node.taskId) meta.push(h('span', { key: 'task', className: 'dab-mono', title: `${dabT('task')} ${node.taskId}` }, node.taskId))
  if (age !== '') meta.push(h('span', { key: 'age', title: node.updatedAt ? new Date(node.updatedAt).toLocaleString() : '' }, age))
  if (node.orphan) meta.push(h('span', { key: 'orphan', title: dabT('orphan') }, `⚠ ${dabT('orphan')}`))
  if (node.parentCycle) meta.push(h('span', { key: 'cycle', title: dabT('cycle') }, `⚠ ${dabT('cycle')}`))
  if (node.parentContested) meta.push(h('span', { key: 'contested', title: `${dabT('cycle')} · ${(node.parentCandidates ?? []).join(', ')}` }, `⚠ ${dabT('contest')}`))
  const metaWithSeps = []
  meta.forEach((item, index) => {
    if (index > 0) metaWithSeps.push(h('span', { key: `sep-${index}`, className: 'dab-sep', 'aria-hidden': 'true' }))
    metaWithSeps.push(item)
  })
  if (metaWithSeps.length > 0) children.push(h('div', { className: 'dab-meta', key: 'meta' }, metaWithSeps))
  if (node.status === 'waiting_user') {
    children.push(h('div', { className: 'dab-wait', key: 'wait', title: node.waitingDetail ?? '' }, node.waitingDetail ?? dabWaitingLabel(node.expectedAction)))
  }
  if (node.status === 'failed' && node.seen !== true) {
    children.push(h('div', { className: 'dab-err', key: 'err', title: node.error ?? '' }, node.error ?? dabStatusLabel('failed')))
  }

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
  if (foot.length > 0) children.push(h('div', { className: 'dab-card-foot', key: 'foot' }, foot))

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
  }, children)
}

const DabAgentCard = React.memo(DabAgentCardImpl, (a, b) => dabCardSignature(a) === dabCardSignature(b) && a.arbiter === b.arbiter)


// ---- src/client/ui/tree.js ----
/**
 * AgentTree / ProjectGroup / CompactGrid: render the pure board view
 * (board/view.js) as family trees grouped by project, or as a compact grid
 * still grouped by project and by root parent.
 *
 * @module dsh-agent-board/client/ui/tree
 */

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
  return h('section', { className: 'dab-project', 'data-project-id': project.id, 'aria-label': title },
    h('button', { type: 'button', className: 'dab-project-head', 'aria-expanded': !folded, onClick: () => onFold(project.id) },
      h('span', { className: 'dab-caret', 'aria-hidden': 'true' }, folded ? '▸' : '▾'),
      h('span', null, title),
      h('span', { className: 'dab-project-count' }, `${project.visibleAgents} agent${project.visibleAgents > 1 ? 's' : ''}`),
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

function DabAgentPreview({ node, parent, onOpen, onSelect, onClose, openError, onDismiss, dismissed }) {
  const h = React.createElement
  const [more, setMore] = React.useState(false)
  React.useEffect(() => { setMore(false) }, [node?.id])
  if (node === null || node === undefined) return null
  const preview = node.preview ?? { text: '', final: false }
  const hasFinal = preview.final === true && typeof preview.text === 'string' && preview.text !== ''
  const line = hasFinal ? lastUsefulLine(preview.text) : ''
  const facts = []
  const fact = (key, label, value, mono) => {
    if (value === null || value === undefined || value === '') return
    facts.push(h('dt', { key: `${key}-t` }, label), h('dd', { key: `${key}-d`, className: mono ? 'dab-mono' : undefined }, value))
  }
  fact('project', dabT('project'), node.projectId === 'unassigned' ? dabT('unassigned') : node.projectTitle)
  fact('provider', dabT('provider'), node.model?.provider, true)
  fact('model', dabT('model'), node.model?.source === 'unknown' ? null : dabModelTitle(node.model), true)
  fact('modelSource', dabT('modelSource'), node.model?.source === 'unknown' ? null : (node.model.source === 'assignment' ? dabT('modelAssignment') : dabT('modelNative')))
  fact('task', dabT('task'), node.taskId, true)
  fact('goal', dabT('goal'), node.goal)
  if (parent !== null && parent !== undefined) {
    facts.push(h('dt', { key: 'parent-t' }, dabT('parent')), h('dd', { key: 'parent-d' },
      h('button', { type: 'button', className: 'dab-linkish', onClick: () => onSelect(parent.id) }, parent.title)))
  if (node.orphan) {
    fact('parent', dabT('parent'), `${dabT('orphan')} (${String(node.parentId).slice(-12)})`, true)
  } else if (node.parentCycle) {
    fact('parent', dabT('parent'), dabT('cycle'))
  } else if (node.parentContested) {
    fact('parent', dabT('parent'), `${dabT('contest')} (${(node.parentCandidates ?? []).join(', ')})`, true)
  }
  if (node.activity) fact('activity', dabT('activity'), `${node.activity.turns} ${dabT('turns')} · ${node.activity.steps} ${dabT('steps')}`)
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
      node.role ? h('span', { className: 'dab-tag' }, node.role) : null,
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
      ? h('div', { className: 'dab-muted' }, `${dabT('activity')} : ${node.activity.turns} ${dabT('turns')} · ${node.activity.steps} ${dabT('steps')}`)
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

function DabHistoryDrawer({ projection, project, selectedId, arbiter, onClose }) {
  const h = React.createElement
  const [query, setQuery] = React.useState('')
  const [limit, setLimit] = React.useState(DAB_HISTORY_PAGE)
  const inputRef = React.useRef(null)
  React.useEffect(() => { inputRef.current?.focus?.() }, [])
  React.useEffect(() => { setLimit(DAB_HISTORY_PAGE) }, [query, project])
  const page = React.useMemo(() => historyPage(projection, { query, project, offset: 0, limit }), [projection, query, project, limit])
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
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
        'aria-label': `${node.title} — ${dabStatusLabel(node.status)}`,
        onClick: event => arbiter.click(node.id, event.detail),
        onDoubleClick: () => arbiter.doubleClick(node.id),
        onKeyDown: event => { if (event.target === event.currentTarget && arbiter.key(node.id, event.key)) event.preventDefault() },
      },
      h('span', { className: 'dab-mark', 'data-status': node.status, 'data-seen': node.seen === true ? 'true' : 'false', 'aria-hidden': 'true' }),
      h('span', { className: 'dab-hist-main' },
        h('span', { className: 'dab-hist-title', title: node.title }, node.title),
        h('span', { className: 'dab-muted' }, [
          node.projectId === 'unassigned' ? dabT('unassigned') : node.projectTitle,
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
  const { counts, visibleCount, mode, busy, hostDown, canStop, stopped, secondary, onMode, onStop, onResume, onRefresh, ui, setUi, projects, onHistory, narrow } = props
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
    counter('unread', counts.unread, dabT('unread')),
    counter('failed', counts.failed, dabT('failed')),
    narrow ? null : h('span', { className: 'dab-muted', title: `${visibleCount} ${dabT('shown')} ${dabT('of')} ${counts.total}` }, `${visibleCount}/${counts.total}`))

  const projectSelect = select(dabT('projects'), ui.project ?? '',
    [['', dabT('allProjects')], ...projects.map(project => [project.id, `${project.id === 'unassigned' ? dabT('unassigned') : project.title} (${project.agents})`])],
    value => setUi({ project: value === '' ? null : value }), { style: narrow ? { flex: '1 1 auto', minWidth: 0 } : undefined })
  const filterSelect = select(dabT('filterLabel'), ui.filter,
    [['attention', dabT('filterAttention')], ['recent', dabT('filterRecent')], ['all', dabT('filterAll')]], value => setUi({ filter: value }))
  const viewSelect = select(dabT('viewLabel'), ui.compact ? 'compact' : 'tree',
    [['tree', dabT('treeView')], ['compact', dabT('compact')]], value => setUi({ compact: value === 'compact' }))
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
          h('div', { className: 'dab-bar' }, filterSelect, viewSelect),
          h('div', { className: 'dab-bar' }, modeSelect, stopOrResume, h('span', { className: 'dab-grow' }), state),
          h('div', { className: alert ? 'dab-alert' : 'dab-notice' }, hostDown ? dabT('orchestratorDown') : notice))
        : null,
    )
  }

  return h('header', { className: 'dab-toolbar' },
    h('div', { className: 'dab-bar', style: { flexWrap: 'nowrap' } },
      counters,
      h('div', { className: 'dab-search-wrap' }, search),
      projectSelect, filterSelect, viewSelect,
      h('span', { className: 'dab-grow' }),
      alertDot, modeSelect, stopOrResume, state, history, refresh),
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
  return { filter: 'attention', query: '', project: null, compact: false, folded: [], expanded: [], collapsed: [], dismissed: [], treeLimit: {} }
}

function dabReadUi() {
  const base = dabDefaultUi()
  try {
    const raw = globalThis.localStorage?.getItem(DAB_UI_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw)
    return {
      ...base,
      filter: VIEW_FILTERS.includes(parsed.filter) ? parsed.filter : base.filter,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      compact: parsed.compact === true,
      folded: Array.isArray(parsed.folded) ? parsed.folded.slice(0, 200) : [],
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.slice(0, 200) : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.slice(0, 200) : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.slice(-500) : [],
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

    // Every width keeps the overview: all projects, each foldable.
    const shownProjects = view.projects

    const selectedNode = selectedId !== null ? projection.byId.get(selectedId) ?? null : null
    const parentNode = selectedNode && selectedNode.parentId && !selectedNode.orphan && !selectedNode.parentCycle
      ? projection.byId.get(selectedNode.parentId) ?? null
      : null

    const nodeRef = React.useRef(projection)
    nodeRef.current = projection

    const acknowledge = React.useCallback(id => {
      const node = nodeRef.current.byId.get(id)
      if (node && (node.status === 'finished_unread' || node.status === 'recovering' || (node.status === 'failed' && node.seen !== true))) void store.ack(id, { source: 'board_click' })
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
        if (node.status === 'finished_unread' || (node.status === 'failed' && node.seen !== true)) {
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

    const mode = typeof host.mode === 'string' ? host.mode : 'off'
    const hostDown = snapshot.hostError !== null && snapshot.hostError !== undefined && host.sync === null
    const canStop = (host.assignments ?? []).some(assignment => assignment.status === 'running' || assignment.status === 'starting')
    const ctxValue = { selectedId, arbiter, onToggleBranch, onRevealHidden, nowBucket }

    const empty = shownProjects.length === 0
      ? h('div', { className: 'dab-empty' },
        h('div', null, ui.query !== '' ? dabT('emptySearch') : dabT('emptyAttention')),
        ui.query === '' ? h('div', { className: 'dab-muted' }, dabT('emptyHint')) : null,
        ui.query === '' ? h('button', { type: 'button', className: 'dab-btn', onClick: () => setHistoryOpen(true) }, dabIcon('history'), ` ${dabT('history')}`) : null)
      : null

    return h('div', { className: 'dab-root', ref: rootRef, 'data-dsh-agent-board': '', 'data-narrow': narrow ? 'true' : 'false' },
      h(DabToolbar, {
        counts, visibleCount: view.visibleCount, mode, busy, hostDown, canStop, ui, setUi, projects: projectList, narrow,
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
          h(DabExecutionList, { host, onApprove: id => act('approve', () => store.decide(id, true)), onReject: id => act('reject', () => store.decide(id, false)) }),
          empty,
          h('div', { className: 'dab-projects' }, shownProjects.map(project => h(DabProjectGroup, {
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
          ? h(DabAgentPreview, { node: selectedNode, parent: parentNode, onOpen: openSession, onSelect: selectNode, onClose: () => setSelectedId(null), openError, onDismiss, dismissed: dismissedSet.has(selectedNode.id) })
          : null),
      historyOpen
        ? h(DabHistoryDrawer, { projection, project: ui.project, selectedId, arbiter, onClose: () => setHistoryOpen(false) })
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
