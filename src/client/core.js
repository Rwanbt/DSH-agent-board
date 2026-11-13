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

import { buildProjection, modelHistoryOf, resolveNodeModel, trackModelChange } from '../supervisor/projection.js'
import { aggregateSubtrees } from '../board/view.js'

export function emptyHostState() {
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
    // GOAL 6 payload additions. Every one may be absent on an older host: the
    // client degrades to an explicit "non disponible" instead of inventing.
    mandate: null,
    capabilities: null,
    superagent: null,
    dryRun: null,
  }
}

/** A plain object or null (tolerates arrays, primitives, foreign frames). */
function plainObjectOrNull(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * `state.superagent` of a host payload (GOAL 6), or null for an older host.
 * Nullable at every level: the caller must render "non disponible" rather than
 * assume a session, an identity or a decision inbox.
 */
export function superagentOf(host) {
  return plainObjectOrNull(host?.superagent)
}

/** `state.mandate` of a host payload, or null when the host does not publish it. */
export function mandateOf(host) {
  return plainObjectOrNull(host?.mandate)
}

/** `state.capabilities` matrix, or null (never assume a capability). */
export function capabilitiesOf(host) {
  return plainObjectOrNull(host?.capabilities)
}

/** Real pending decisions only: an answered/expired/superseded one is not pending. */
export function pendingDecisionsOf(superagent) {
  const list = Array.isArray(superagent?.decisions) ? superagent.decisions : []
  return list.filter(decision => plainObjectOrNull(decision) !== null && decision.status === 'pending')
}

export function pendingDecisionCountOf(superagent) {
  return pendingDecisionsOf(superagent).length
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const HOST_STATE_OBJECT_KEYS = ['acks', 'previews', 'turnEnd', 'health', 'gone', 'policy', 'instance', 'sync', 'adapters']
const HOST_STATE_ARRAY_KEYS = ['assignments', 'proposals', 'routeEvents', 'audit', 'reconcileNotes']
// GOAL 6 additive fields. They are recognised as a host-state marker but never
// type-validated here: a partially populated superagent payload must still
// reach the UI, which guards every field access itself.
const HOST_STATE_EXTRA_KEYS = ['mandate', 'capabilities', 'superagent', 'dryRun', 'supervision', 'projects', 'models', 'taskboardPublic', 'build']

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
    || HOST_STATE_EXTRA_KEYS.some(key => value[key] !== undefined && value[key] !== null)
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
export function createBoardStore(ctx, options = {}) {
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
      // GOAL 6 views, normalized once so every component receives the same
      // null-safe shape (an old host yields null and the UI says so).
      superagent: superagentOf(host),
      mandate: mandateOf(host),
      capabilities: capabilitiesOf(host),
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

  /**
   * One raw request. `read()` NEVER refreshes/replaces the host state: a
   * dry-run is a question, not an action, so it must not mutate the store.
   */
  async function request(method, path, body) {
    if (fetchImpl === null) return { ok: false, status: 0, error: 'no_fetch' }
    try {
      const headers = { accept: 'application/json' }
      const init = { method, headers }
      if (body !== undefined && method !== 'GET') {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body ?? {})
      }
      const response = await fetchImpl(`${apiBase}${path}`, init)
      const payload = await response.json().catch(() => null)
      return { ok: payload?.ok === true && response.ok, status: response.status, payload }
    } catch (error) {
      return { ok: false, status: 0, error: String(error?.message ?? error) }
    }
  }

  async function read(path) {
    return request('GET', path)
  }

  async function post(path, body) {
    const result = await request('POST', path, body)
    // A successful MUTATION refreshes the shared state; a read never does.
    if (result.ok) await refreshHost()
    return result
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

    // ---- GOAL 6 surfaces. Paths are the contract routes (§6); the UI never
    // builds them itself, so a payload/route change stays in one place.
    dryRun: () => read('/dry-run'),
    setScope: (scopeMode, selectedWorkspaces, confirm) => post('/mandate/scope', {
      scopeMode,
      ...(Array.isArray(selectedWorkspaces) ? { selectedWorkspaces } : {}),
      ...(typeof confirm === 'string' ? { confirm } : {}),
    }),
    setLevel: level => post('/mandate/level', { level }),
    setProject: (projectId, patch = {}) => post('/mandate/project', { projectId, ...patch }),
    /**
     * One switch per project. The host refuses to enable a project that is not
     * in scope (no silent scope increase), so enabling first makes the
     * selection explicit (POST /mandate/scope), then turns the project on.
     * Disabling only switches the project off; the scope is left as is.
     */
    enableProject: async (projectId, enabled) => {
      if (enabled !== true) return post('/mandate/project', { projectId, enabled: false })
      const current = mandateOf(host) ?? {}
      const selected = Array.isArray(current.selectedWorkspaces) ? current.selectedWorkspaces : []
      if (current.scopeMode !== 'all' && !selected.includes(projectId)) {
        const scoped = await post('/mandate/scope', { scopeMode: 'selected', selectedWorkspaces: [...selected, projectId] })
        if (scoped?.ok !== true) return scoped
      }
      return post('/mandate/project', { projectId, enabled: true })
    },
    setPause: paused => post('/mandate/pause', { paused: paused === true }),
    /** Full mandate patch (actions map and/or level), for POST /mandate. */
    setMandate: patch => post('/mandate', patch ?? {}),
    setAction: (action, enabled) => {
      // The host merges this patch. Do not redeclare scope/consent or replay
      // unrelated permissions from a potentially stale snapshot.
      return post('/mandate', { actions: { [action]: enabled === true } })
    },
    setActionMode: (action, mode) => post('/mandate', {
      actionModes: { [action]: mode }, actions: { [action]: mode !== 'deny' },
    }),
    startSuperagent: () => post('/superagent/start', {}),
    pauseSuperagent: () => post('/superagent/pause', {}),
    resumeSuperagent: () => post('/superagent/resume', {}),
    stopSuperagent: () => post('/superagent/stop', {}),
    cycleSuperagent: trigger => post('/superagent/cycle', { trigger: trigger ?? 'manual' }),
    setSuperagentModel: model => post('/superagent/model', model ?? {}),
    /** Exact-route efforts for one model (read-only; no state refresh). */
    modelInfo: (provider, model) => request('POST', '/models/info', { provider, model }),
    probeTaskboard: () => post('/integrations/taskboard/probe', {}),
    /**
     * Runtime contract self-test. A read-only question (the deep variant creates
     * and disposes one disposable confined session), so the shared state is NOT
     * refreshed: the panel renders the returned value directly.
     */
    selfTest: deep => request('POST', '/selftest', deep === true ? { deep: true, confirm: 'EPHEMERAL_SESSION' } : {}),
    addDirective: input => post('/superagent/directives', {
      text: String(input?.text ?? ''),
      scope: input?.scope === 'project' ? 'project' : 'global',
      ...(input?.scope === 'project' && typeof input?.projectId === 'string' ? { projectId: input.projectId } : {}),
    }),
    revokeDirective: id => post(`/superagent/directives/${encodeURIComponent(String(id))}/revoke`, {}),
    answerDecision: async (id, optionId, note) => {
      const result = await post(`/superagent/decisions/${encodeURIComponent(String(id))}/answer`, {
        optionId,
        ...(typeof note === 'string' && note !== '' ? { note } : {}),
      })
      return result.payload?.execution?.ok === false
        ? { ...result, ok: false, error: result.payload.execution.reason, payload: { ...result.payload, error: result.payload.execution.reason } }
        : result
    },
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

