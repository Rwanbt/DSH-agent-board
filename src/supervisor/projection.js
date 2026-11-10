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

import { ERROR_TURN_KINDS, STATUS, STATUS_RANK, truncate } from '../contracts/model.js'

const PENDING_ACTION = Object.freeze({
  approval: 'approval',
  'plan-review': 'plan-review',
  question: 'question',
})

/** Where a displayed model came from. Never guessed. */
export const MODEL_SOURCE = Object.freeze({
  NATIVE: 'native',
  ASSIGNMENT: 'assignment',
  UNKNOWN: 'unknown',
})

/** One bounded window for the non-status `recentlyFinished` view flag. */
export const RECENT_FINISHED_MS = 5 * 60 * 1000

/** Assignment statuses that mean "this launch did not finish its work". */
export const TERMINAL_NEGATIVE_ASSIGNMENT_STATUSES = Object.freeze(['interrupted', 'failed', 'stopped', 'superseded'])

/** How many model changes are kept in the visible history of one card. */
export const MODEL_HISTORY_LIMIT = 8


export function normalizeSessions(listSnapshot) {
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

export function statusEntryOf(statusMap, sessionId) {
  if (statusMap === null || statusMap === undefined) return undefined
  if (typeof statusMap.get === 'function') {
    const value = statusMap.get(sessionId)
    if (value !== undefined) return value
  }
  if (typeof statusMap === 'object' && statusMap[sessionId] !== undefined) return statusMap[sessionId]
  return undefined
}

/** Sub-agent catalog entries declared by the parent session's projection. */
export function catalogChildrenOf(projectionsBySession, parentId) {
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

export function parentIdOf(row) {
  if (row === null || typeof row !== 'object') return null
  const candidate = row.parentId ?? row.parentSessionId ?? row.parent
  return typeof candidate === 'string' && candidate !== '' ? candidate : null
}

export function isSubagentRow(row) {
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
export function classifyStatusDetailed({ row, live, turnEnd, ack, assignment, gone = false, goneAt = null, provider = null, health = null, now = Date.now() }) {
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
export function classifyStatus(input) {
  return classifyStatusDetailed(input).status
}

/** `projectionValues.mobilePushLifecycle.lastTurnEnd` = { turn, reason } when present. */
export function nativeTurnEndOf(row) {
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
export function expectedActionOf(live, row) {
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
export function waitingDetailOf(row) {
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
export function normalizeModelInfo(value) {
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
export function nativeModelOf(row) {
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
export function resolveNodeModel({ sessionId, row, assignment = null, modelOf, projectionsBySession = null }) {
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
export function modelLabelOf(model) {
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
export function trackModelChange(memory, sessionId, model, now = Date.now(), { limit = MODEL_HISTORY_LIMIT, maxSessions = 512 } = {}) {
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
export function modelHistoryOf(memory) {
  const out = {}
  if (memory === null || memory === undefined || typeof memory.entries !== 'function') return out
  for (const [id, record] of memory) {
    if (Array.isArray(record?.entries) && record.entries.length > 0) out[id] = record.entries
  }
  return out
}

/** Merge two route/model histories, dropping exact duplicates, order preserved. */
export function mergeRouteHistory(assignmentHistory, nativeHistory) {
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
export function providerOutageOf(health, provider, { now = Date.now(), sessionAt = null } = {}) {
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
export function previewOf(hostState, sessionId, assignment, row, running = false) {
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
export function lastUsefulLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text.split(/\r?\n/).map(line => line.replace(/^[\s>#*\-|`]+/, '').replace(/[`*|]+$/g, '').trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] !== '' && !/^-{3,}$/.test(lines[index])) return truncate(lines[index], 220)
  }
  return ''
}

/** Normalize a filesystem path for comparison (case-insensitive drive, `/`). */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(path)) path = path.toLowerCase()
  return path
}

/** Workspace index: session membership and normalized directory. */
export function indexWorkspaces(workspaces) {
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

export const UNASSIGNED_PROJECT = Object.freeze({ id: 'unassigned', title: 'Non attribué', path: null, source: 'none' })

/**
 * Resolve a session's project with reliable keys only:
 *   1. DSH workspace membership (workspace.sessionIds);
 *   2. normalized working directory equal to (or inside) a workspace path;
 *   3. otherwise "unassigned". Titles are never used.
 * Sub-agents inherit their parent's project in buildProjection.
 */
export function resolveProject(row, index) {
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
export function buildProjection({ list, statusMap, hostState = {}, workspaces = {}, now = Date.now(), modelOf, modelHistory = null, health, recentWindowMs = RECENT_FINISHED_MS }) {
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

export function groupProjects(nodes) {
  const groups = new Map()
  for (const node of nodes) {
    if (!groups.has(node.projectId)) groups.set(node.projectId, { id: node.projectId, title: node.projectTitle, nodes: [] })
    groups.get(node.projectId).nodes.push(node.id)
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))
}

export function summarize(nodes) {
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
export function flattenVisible(roots, byId, collapsedIds = new Set()) {
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

export function compareNodes(a, b) {
  const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
  if (rank !== 0) return rank
  return String(a.title).localeCompare(String(b.title))
}

/**
 * Ancestors that must stay visible even when a descendant is shown out of its
 * subtree (the client uses this for a flat/compact list).
 */
export function ancestorsOf(byId, sessionId) {
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
export function compactRows(projection) {
  return [...projection.nodes].sort((a, b) => {
    const project = String(a.projectTitle).localeCompare(String(b.projectTitle))
    return project !== 0 ? project : compareNodes(a, b)
  })
}
