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

