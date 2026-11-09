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

/** Native-ish agent statuses. Never derived from elapsed time alone. */
const STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING_USER: 'waiting_user',
  FINISHED_UNREAD: 'finished_unread',
  FINISHED_READ: 'finished_read',
  FAILED: 'failed',
  IDLE: 'idle',
  UNKNOWN: 'unknown',
})

const STATUS_VALUES = Object.freeze(Object.values(STATUS))

/** Ranking used for stable ordering (lower = shown first). */
const STATUS_RANK = Object.freeze({
  [STATUS.WAITING_USER]: 0,
  [STATUS.RUNNING]: 1,
  [STATUS.FINISHED_UNREAD]: 2,
  [STATUS.FAILED]: 3,
  [STATUS.IDLE]: 4,
  [STATUS.FINISHED_READ]: 5,
  [STATUS.UNKNOWN]: 6,
})

/** Orchestration modes. Default is always `off`. */
const MODES = Object.freeze({
  OFF: 'off',
  SUPERVISED: 'supervised',
  AUTONOMOUS: 'autonomous',
})

const MODE_VALUES = Object.freeze(Object.values(MODES))

/** Turn-end kinds that must be surfaced as a failure, not as "finished". */
const ERROR_TURN_KINDS = Object.freeze(['error', 'failed'])

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

/** Default limits. Every one is configurable through the board API. */
const DEFAULT_POLICY = Object.freeze({
  mode: MODES.OFF,
  maxConcurrent: 2,
  maxSwitches: 2,
  proposalTtlMs: 30 * 60 * 1000,
  leaseTtlMs: 10 * 60 * 1000,
  allowedWorkspaces: [],
  allowedProviders: [],
  allowCloudFallback: false,
  routeChain: [],
  autonomyBudget: { maxTasksPerHour: 6 },
})

function normalizePolicy(input = {}, fallback = DEFAULT_POLICY) {
  const mode = isMode(input.mode) ? input.mode : fallback.mode
  const maxConcurrent = clampInt(input.maxConcurrent, 0, 8, fallback.maxConcurrent)
  const maxSwitches = clampInt(input.maxSwitches, 0, 5, fallback.maxSwitches)
  return {
    mode,
    maxConcurrent,
    maxSwitches,
    proposalTtlMs: clampInt(input.proposalTtlMs, 60_000, 86_400_000, fallback.proposalTtlMs),
    leaseTtlMs: clampInt(input.leaseTtlMs, 30_000, 86_400_000, fallback.leaseTtlMs),
    allowedWorkspaces: uniqueStrings(input.allowedWorkspaces ?? fallback.allowedWorkspaces),
    allowedProviders: uniqueStrings(input.allowedProviders ?? fallback.allowedProviders),
    allowCloudFallback: input.allowCloudFallback === true,
    routeChain: normalizeRouteChain(input.routeChain ?? fallback.routeChain),
    autonomyBudget: {
      maxTasksPerHour: clampInt(input.autonomyBudget?.maxTasksPerHour, 0, 100, fallback.autonomyBudget.maxTasksPerHour),
    },
  }
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
 * turn-end kind, read cursor, assignments). The output is one node per agent,
 * grouped by project, with a filiation tree.
 *
 * Status rules (non-negotiable):
 *   - pendingInteraction  -> waiting_user (even while running)
 *   - running             -> running (animated ring)
 *   - turn ended in error -> failed
 *   - turn ended, not consulted -> finished_unread (green)
 *   - turn ended, consulted     -> finished_read (grey)
 *   - no signal at all          -> idle, or unknown for a disconnected row
 *
 * Elapsed time alone NEVER produces running/finished. A missing row is
 * `unknown`, never `finished`.
 *
 * @module dsh-agent-board/supervisor/projection
 */


const PENDING_ACTION = Object.freeze({
  approval: 'approval',
  'plan-review': 'plan-review',
  question: 'question',
})

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
        title: typeof entry.title === 'string' ? entry.title : undefined,
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
 * Classify one agent. `live` is its unified status entry, `turnEnd` the last
 * turn/end fact the host recorded, `ack` the persisted read cursor.
 */
function classifyStatus({ row, live, turnEnd, ack }) {
  if (row === undefined && live === undefined) return STATUS.UNKNOWN
  const pendingKind = live?.pendingInteraction?.kind ?? live?.pendingInteraction
  if (typeof pendingKind === 'string' && pendingKind !== '') return STATUS.WAITING_USER
  if (row?.running === true || live?.running === true) return STATUS.RUNNING
  const end = turnEnd !== null && typeof turnEnd === 'object' ? turnEnd : null
  if (end !== null && ERROR_TURN_KINDS.includes(end.kind)) return STATUS.FAILED
  if (end !== null && Number.isFinite(Number(end.at))) {
    const seenAt = Number(ack?.seenAt)
    if (Number.isFinite(seenAt) && seenAt >= Number(end.at)) return STATUS.FINISHED_READ
    return STATUS.FINISHED_UNREAD
  }
  if (live?.completionUnread === true) return STATUS.FINISHED_UNREAD
  if (row === undefined) return STATUS.UNKNOWN
  return STATUS.IDLE
}

/** The action the user is expected to take right now, if any. */
function expectedActionOf(live) {
  const pending = live?.pendingInteraction
  if (pending === null || pending === undefined) return null
  const kind = typeof pending === 'string' ? pending : pending.kind
  if (typeof kind !== 'string' || kind === '') return null
  return PENDING_ACTION[kind] ?? 'unknown'
}

function modelOf(row, assignment) {
  const candidates = [
    assignment?.model,
    row?.model,
    row?.modelSelection,
    row?.header?.model,
    row?.llm,
  ]
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    const provider = typeof candidate.provider === 'string' ? candidate.provider : undefined
    const model = typeof candidate.model === 'string' ? candidate.model : (typeof candidate.id === 'string' ? candidate.id : undefined)
    if (provider !== undefined || model !== undefined) {
      return {
        provider: provider ?? '—',
        model: model ?? '—',
        reasoningEffort: typeof candidate.reasoningEffort === 'string' ? candidate.reasoningEffort : null,
        source: assignment?.model !== undefined ? 'assignment' : 'session',
      }
    }
  }
  return { provider: '—', model: '—', reasoningEffort: null, source: 'unknown' }
}

function previewOf(hostState, sessionId, assignment) {
  const preview = hostState?.previews?.[sessionId]
  if (preview !== undefined && typeof preview.text === 'string' && preview.text !== '') {
    return { text: truncate(preview.text, 600), at: Number(preview.at) || null }
  }
  const checkpointText = assignment?.checkpoint?.lastText
  if (typeof checkpointText === 'string' && checkpointText !== '') {
    return { text: truncate(checkpointText, 600), at: Number(assignment?.checkpoint?.at) || null }
  }
  return { text: '', at: null }
}

function projectKeyOf(row, workspaces) {
  const sessionId = String(row?.id ?? '')
  for (const workspace of workspaces?.items ?? []) {
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      return { id: `ws:${workspace.id}`, title: workspace.title ?? workspace.path ?? 'Project' }
    }
  }
  const cwd = typeof row?.cwd === 'string' && row.cwd !== '' ? row.cwd : ''
  if (cwd !== '') {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    const name = parts.at(-1) ?? cwd
    return { id: `dir:${cwd}`, title: name }
  }
  return { id: 'unassigned', title: 'Unassigned' }
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
function buildProjection({ list, statusMap, hostState = {}, workspaces = {}, now = Date.now() }) {
  const normalized = normalizeSessions(list)
  const assignmentsBySession = new Map()
  for (const assignment of hostState.assignments ?? []) {
    if (typeof assignment?.sessionId === 'string') assignmentsBySession.set(assignment.sessionId, assignment)
  }
  const archived = new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds.map(String) : [])

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
  const catalogParentOf = new Map()
  for (const parentId of Object.keys(normalized.projectionsBySession)) {
    for (const entry of catalogChildrenOf(normalized.projectionsBySession, parentId)) {
      ensureNode(entry.id, normalized.byId[entry.id])
      if (!catalogParentOf.has(entry.id)) catalogParentOf.set(entry.id, parentId)
    }
  }

  const out = []
  for (const node of nodes.values()) {
    const row = node.row
    const live = statusEntryOf(statusMap, node.id)
    const turnEnd = hostState.turnEnd?.[node.id] ?? null
    const ack = hostState.acks?.[node.id] ?? null
    const assignment = assignmentsBySession.get(node.id) ?? null
    const status = classifyStatus({ row, live, turnEnd, ack })
    const parentId = row !== undefined ? parentIdOf(row) : null
    const project = row !== undefined ? projectKeyOf(row, workspaces) : { id: 'unassigned', title: 'Unassigned' }
    const resolvedParent = parentId ?? (catalogParentOf.get(node.id) ?? null)
    const preview = previewOf(hostState, node.id, assignment)
    out.push({
      id: node.id,
      parentId: resolvedParent,
      projectId: project.id,
      projectTitle: project.title,
      title: typeof row?.displayTitle === 'string' && row.displayTitle !== ''
        ? row.displayTitle
        : (typeof row?.title === 'string' && row.title !== '' ? row.title : node.id.slice(-12)),
      cwd: typeof row?.cwd === 'string' ? row.cwd : null,
      origin: typeof row?.origin === 'string' ? row.origin : (resolvedParent !== null ? 'subagent' : 'main'),
      status,
      expectedAction: expectedActionOf(live),
      model: modelOf(row, assignment),
      preview,
      unread: status === STATUS.FINISHED_UNREAD,
      waiting: status === STATUS.WAITING_USER,
      failed: status === STATUS.FAILED,
      archived: archived.has(node.id),
      blank: row?.blank === true,
      updatedAt: Number(row?.updatedAt) || null,
      assignmentId: assignment?.id ?? null,
      taskId: assignment?.taskId ?? null,
      previousSessionId: assignment?.previousSessionId ?? null,
      routeHistory: Array.isArray(assignment?.routeHistory) ? assignment.routeHistory : [],
      children: [],
      now,
    })
  }

  // Link children (two passes so forward references settle).
  const byId = new Map(out.map(node => [node.id, node]))
  for (const node of out) {
    if (node.parentId !== null && byId.has(node.parentId) && node.parentId !== node.id) {
      byId.get(node.parentId).children.push(node.id)
    }
  }

  const roots = out.filter(node => node.parentId === null || !byId.has(node.parentId))
  return { nodes: out, byId, roots, projects: groupProjects(out), counts: summarize(out) }
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
    finished_unread: 0,
    finished_read: 0,
    failed: 0,
    idle: 0,
    unknown: 0,
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
    lastTick: null,
    sync: null,
    adapters: { adapters: [], executors: [] },
    audit: [],
    reconcileNotes: [],
  }
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

  function bump() {
    dirty = true
    for (const listener of listeners) {
      try { listener() } catch { /* listener errors must not break the store */ }
    }
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
    const projection = buildProjection({ list, statusMap, hostState: host, workspaces, now: Date.now() })
    return {
      projection,
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

  function connectStream() {
    if (stream !== null || destroyed) return
    if (typeof EventSourceImpl !== 'function') return
    try {
      stream = new EventSourceImpl(`${apiBase}/events`)
      stream.onmessage = event => {
        try {
          const parsed = JSON.parse(event.data)
          if (parsed !== null && typeof parsed === 'object') {
            host = parsed
            hostError = null
            bump()
          }
        } catch { /* keep the previous state */ }
      }
      stream.onerror = () => { /* the browser reconnects automatically */ }
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
    ack: sessionId => post('/ack', { sessionId }),
    setMode: mode => post('/mode', { mode }),
    stop: () => post('/stop', {}),
    tick: () => post('/tick', {}),
    decide: (proposalId, approve) => post(`/proposals/${encodeURIComponent(proposalId)}/decide`, { approve }),
    dispatch: taskId => post('/dispatch', { taskId }),
    destroy() {
      destroyed = true
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



// ---- src/client/app.js ----
/**
 * Agent Board panel (React, plain createElement — no build-time JSX).
 *
 * The panel is registered through the official slots: one `main` occupant keyed
 * `dsh-agent-board` and one `sidebar.panellist` row. It renders a card per
 * agent with real native statuses, a filiation tree per project, collapsible
 * subtrees, click-to-preview and double-click-to-open (plus an explicit
 * "Open session" button for touch/mobile), and the orchestrator controls.
 *
 * This file is concatenated into the browser artifact by scripts/build-client.mjs.
 *
 * @module dsh-agent-board/client/app
 */

const DAB_PANEL_ID = 'dsh-agent-board'
const DAB_STYLE_ID = 'dsh-agent-board-style'
const DAB_COMPACT_KEY = 'dsh-agent-board:compact'

const DAB_STRINGS = {
  fr: {
    title: 'Agent Board',
    subtitle: 'Sessions, sous-agents et travail délégué',
    mode: 'Orchestration',
    off: 'Arrêt',
    supervised: 'Supervisé',
    autonomous: 'Autonome',
    stop: 'Arrêter les exécutions',
    compact: 'Cartes compactes',
    refresh: 'Rafraîchir',
    running: 'en cours',
    waiting: 'en attente',
    unread: 'non lus',
    failed: 'en erreur',
    idle: 'inactifs',
    consult: 'terminé, consulté',
    unknown: 'inconnu / déconnecté',
    waitingApproval: 'En attente de votre approbation',
    waitingQuestion: 'En attente de votre réponse',
    waitingPlan: 'En attente de votre revue de plan',
    open: 'Ouvrir la session',
    openHint: 'Double-clic ou bouton pour ouvrir',
    preview: 'Aperçu',
    noPreview: 'Aucun segment de réponse visible pour le moment.',
    collapse: 'Replier',
    expand: 'Déplier',
    empty: 'Aucune session ni sous-agent à afficher.',
    proposals: 'Propositions en attente',
    approve: 'Approuver',
    reject: 'Refuser',
    executions: 'Exécutions',
    noExecution: 'Aucune proposition ni exécution en cours.',
    syncOk: 'Task Board synchronisé',
    syncError: 'Task Board injoignable',
    adapters: 'Adaptateurs',
    restore: 'Reprise après redémarrage',
    resumed: 'interrompue — reprise contrôlée requise',
    offNotice: 'Observation seule : aucun nouvel ordre autonome.',
    supervisedNotice: 'Supervisé : les propositions attendent votre accord.',
    autonomousNotice: 'Autonome : exécution dans le mandat configuré.',
    subagent: 'sous-agent',
    modelUnknown: 'modèle inconnu',
  },
  en: {
    title: 'Agent Board',
    subtitle: 'Sessions, sub-agents and delegated work',
    mode: 'Orchestration',
    off: 'Off',
    supervised: 'Supervised',
    autonomous: 'Autonomous',
    stop: 'Stop executions',
    compact: 'Compact cards',
    refresh: 'Refresh',
    running: 'running',
    waiting: 'waiting',
    unread: 'unread',
    failed: 'failed',
    idle: 'idle',
    consult: 'finished, consulted',
    unknown: 'unknown / disconnected',
    waitingApproval: 'Waiting for your approval',
    waitingQuestion: 'Waiting for your answer',
    waitingPlan: 'Waiting for your plan review',
    open: 'Open session',
    openHint: 'Double-click or button to open',
    preview: 'Preview',
    noPreview: 'No visible answer segment yet.',
    collapse: 'Collapse',
    expand: 'Expand',
    empty: 'No session or sub-agent to display.',
    proposals: 'Pending proposals',
    approve: 'Approve',
    reject: 'Reject',
    executions: 'Executions',
    noExecution: 'No proposal or execution in flight.',
    syncOk: 'Task Board synced',
    syncError: 'Task Board unreachable',
    adapters: 'Adapters',
    restore: 'Restart reconciliation',
    resumed: 'interrupted — controlled resume required',
    offNotice: 'Observation only: no new autonomous order.',
    supervisedNotice: 'Supervised: proposals wait for your approval.',
    autonomousNotice: 'Autonomous: runs inside the configured mandate.',
    subagent: 'sub-agent',
    modelUnknown: 'unknown model',
  },
}

function dabLocale() {
  try {
    const snap = globalThis.__dabLocale?.()
    if (typeof snap === 'string' && snap !== '') return snap.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch { /* ignore */ }
  try {
    const lang = String(globalThis.document?.documentElement?.lang ?? navigator?.language ?? 'en')
    return lang.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  } catch {
    return 'en'
  }
}

let DAB_LANG = 'en'
const dabT = key => (DAB_STRINGS[DAB_LANG] ?? DAB_STRINGS.en)[key] ?? (DAB_STRINGS.en[key] ?? key)

const DAB_STATUS_KEY = {
  running: 'running',
  waiting_user: 'waiting',
  finished_unread: 'unread',
  finished_read: 'consult',
  failed: 'failed',
  idle: 'idle',
  unknown: 'unknown',
}

const DAB_CSS = `
.dab-root {
  display: flex; flex-direction: column; min-height: 0; height: 100%;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 13px; line-height: 1.45; overflow: hidden;
}
.dab-header { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 14px 18px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dab-header-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dab-title { font-size: 15px; font-weight: 650; margin: 0; }
.dab-subtitle { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dab-grow { flex: 1; min-width: 0; }
.dab-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: color-mix(in srgb, currentColor 8%, transparent); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dab-chip[data-tone="running"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dab-chip[data-tone="waiting"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.dab-chip[data-tone="unread"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.dab-chip[data-tone="failed"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.dab-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 4px 10px; font-size: 12px; font-weight: 550; cursor: pointer; }
.dab-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dab-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dab-btn[aria-pressed="true"] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1)); }
.dab-btn[disabled] { opacity: .5; cursor: default; }
.dab-btn[data-danger="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-border-l1)); color: var(--dsw-alias-state-error-primary); }
.dab-seg { display: inline-flex; gap: 4px; padding: 2px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dab-notice { padding: 6px 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dab-scroll { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 40px; }
.dab-project { margin-bottom: 18px; }
.dab-project-head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); text-transform: none; }
.dab-project-count { font-weight: 600; font-size: 11px; opacity: .8; }
.dab-row { display: flex; align-items: stretch; gap: 0; }
.dab-indent { flex: none; width: 18px; position: relative; }
.dab-indent::before { content: ""; position: absolute; left: 8px; top: -6px; bottom: -6px; width: 1px; background: var(--dsw-alias-border-l1); }
.dab-card {
  flex: 1; min-width: 0; margin: 0 0 8px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 9px 12px 9px 10px;
  transition: border-color .12s ease, background .12s ease;
}
.dab-card:hover { border-color: var(--dsw-alias-border-l2); }
.dab-card[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); }
.dab-card-head { display: flex; align-items: center; gap: 8px; }
.dab-open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; border: 0; background: none; padding: 0; text-align: left; color: inherit; font: inherit; cursor: pointer; border-radius: 6px; }
.dab-open:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
.dab-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dab-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dab-model { font-variant-numeric: tabular-nums; }
.dab-chevron { flex: none; border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 2px 4px; border-radius: 6px; font-size: 12px; }
.dab-chevron:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.dab-ring { flex: none; width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; position: relative; }
.dab-ring[data-status="running"]::before { content: ""; width: 14px; height: 14px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); border-top-color: var(--dsw-alias-brand-primary); animation: dab-spin 1s linear infinite; box-sizing: border-box; }
.dab-ring[data-status="waiting_user"]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); animation: dab-pulse 1.6s ease-in-out infinite; }
.dab-ring[data-status="finished_unread"]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 20%, transparent); }
.dab-ring[data-status="finished_read"]::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.dab-ring[data-status="failed"]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); }
.dab-ring[data-status="idle"]::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-state-idle-primary); }
.dab-ring[data-status="unknown"]::before { content: ""; width: 8px; height: 8px; border-radius: 50%; border: 1.5px dashed var(--dsw-alias-label-secondary); }
.dab-detail { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); display: flex; flex-direction: column; gap: 6px; }
.dab-label { font-size: 11px; font-weight: 700; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
.dab-preview { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; color: var(--dsw-alias-label-primary); max-height: 168px; overflow: auto; background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px; }
.dab-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dab-waiting { color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.dab-error { color: var(--dsw-alias-state-error-primary); }
.dab-empty { padding: 28px 8px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dab-panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; background: var(--dsw-alias-bg-layer-1); }
.dab-panel-title { font-size: 12px; font-weight: 700; color: var(--dsw-alias-label-secondary); margin: 0 0 8px; }
.dab-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dab-list li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dab-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dab-status-line { padding: 2px 18px 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
@keyframes dab-spin { to { transform: rotate(360deg); } }
@keyframes dab-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) {
  .dab-root * { animation-duration: .001ms !important; animation-iteration-count: 1 !important; }
  .dab-ring[data-status="running"]::before { animation: none; border-top-color: var(--dsw-alias-brand-primary); }
}
@media (max-width: 767px) {
  .dab-header { padding: 10px 12px 8px; }
  .dab-scroll { padding: 10px 12px 32px; }
  .dab-name { white-space: normal; }
}
`

function dabInjectStyles() {
  try {
    const document = globalThis.document
    if (document === undefined || document === null) return () => {}
    if (document.getElementById(DAB_STYLE_ID) !== null) return () => {}
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

function dabReadCompact() {
  try {
    return globalThis.localStorage?.getItem(DAB_COMPACT_KEY) === '1'
  } catch {
    return false
  }
}

function dabWriteCompact(value) {
  try {
    globalThis.localStorage?.setItem(DAB_COMPACT_KEY, value ? '1' : '0')
  } catch { /* private mode */ }
}

function dabFormatAge(at) {
  if (!Number.isFinite(Number(at))) return ''
  const seconds = Math.max(0, Math.round((Date.now() - Number(at)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  return `${Math.round(minutes / 60)}h`
}

function dabStatusLabel(status) {
  return dabT(DAB_STATUS_KEY[status] ?? 'unknown')
}

function dabModelText(model) {
  if (model === null || model === undefined) return dabT('modelUnknown')
  const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : '?'
  const name = typeof model.model === 'string' && model.model !== '' ? model.model : '?'
  const effort = typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '' ? ` · ${model.reasoningEffort}` : ''
  return `${provider}/${name}${effort}`
}

/** One agent card. */
function DabCard({ node, depth, collapsed, hasChildren, onToggle, onToggleCollapse, onOpen, onAck, compact }) {
  const [expanded, setExpanded] = React.useState(false)
  const selected = expanded
  const pendingLabel = node.expectedAction === 'approval'
    ? dabT('waitingApproval')
    : node.expectedAction === 'question'
      ? dabT('waitingQuestion')
      : node.expectedAction === 'plan-review'
        ? dabT('waitingPlan')
        : null

  const expand = () => {
    setExpanded(current => {
      const next = !current
      if (next === true && node.unread === true) onAck(node.id)
      return next
    })
  }

  const open = () => onOpen(node)

  const onKeyDown = event => {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      open()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      expand()
    }
  }

  return React.createElement(
    'div',
    { className: 'dab-row' },
    depth > 0 ? React.createElement('span', { className: 'dab-indent', 'aria-hidden': 'true' }) : null,
    React.createElement(
      'div',
      { className: 'dab-card', 'data-selected': selected ? 'true' : 'false', 'data-node-id': node.id },
      React.createElement(
        'div',
        { className: 'dab-card-head' },
        React.createElement('span', {
          className: 'dab-ring',
          'data-status': node.status,
          'aria-label': dabStatusLabel(node.status),
          role: 'img',
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dab-open',
            'aria-expanded': expanded,
            title: `${dabT('openHint')} — ${node.id}`,
            onClick: expand,
            onDoubleClick: open,
            onKeyDown,
          },
          React.createElement(
            'span',
            { className: 'dab-name' },
            node.archived ? '· ' : '',
            node.title,
            hasChildren ? React.createElement('span', { className: 'dab-chip', style: { marginLeft: '6px' } }, `${node.children.length}`) : null,
          ),
          React.createElement(
            'span',
            { className: 'dab-meta' },
            React.createElement('span', { className: 'dab-chip', 'data-tone': node.status === 'running' ? 'running' : node.status === 'waiting_user' ? 'waiting' : node.status === 'finished_unread' ? 'unread' : node.status === 'failed' ? 'failed' : undefined }, dabStatusLabel(node.status)),
            node.origin === 'subagent' ? React.createElement('span', { className: 'dab-chip' }, dabT('subagent')) : null,
            node.assignmentId !== null ? React.createElement('span', { className: 'dab-chip dab-mono' }, node.taskId ?? '') : null,
            React.createElement('span', { className: 'dab-chip dab-mono dab-model' }, dabModelText(node.model)),
            node.updatedAt !== null ? React.createElement('span', { className: 'dab-chip' }, dabFormatAge(node.updatedAt)) : null,
          ),
        ),
        hasChildren
          ? React.createElement(
            'button',
            {
              type: 'button',
              className: 'dab-chevron',
              'aria-expanded': !collapsed,
              'aria-label': collapsed ? dabT('expand') : dabT('collapse'),
              title: collapsed ? dabT('expand') : dabT('collapse'),
              onClick: onToggleCollapse,
            },
            collapsed ? '▸' : '▾',
          )
          : null,
      ),
      expanded
        ? React.createElement(
          'div',
          { className: 'dab-detail' },
          pendingLabel !== null ? React.createElement('div', { className: 'dab-waiting' }, pendingLabel) : null,
          node.status === 'failed' ? React.createElement('div', { className: 'dab-error' }, dabStatusLabel('failed')) : null,
          React.createElement('div', { className: 'dab-label' }, dabT('preview')),
          React.createElement('p', { className: 'dab-preview' }, node.preview?.text !== undefined && node.preview.text !== '' ? node.preview.text : dabT('noPreview')),
          React.createElement(
            'div',
            { className: 'dab-actions' },
            React.createElement(
              'button',
              { type: 'button', className: 'dab-btn', onClick: open, title: dabT('open') },
              '↗ ',
              dabT('open'),
            ),
            node.previousSessionId !== null ? React.createElement('span', { className: 'dab-chip dab-mono' }, `← ${node.previousSessionId.slice(-10)}`) : null,
            (node.routeHistory ?? []).slice(-2).map((entry, index) => React.createElement(
              'span',
              { className: 'dab-chip dab-mono', key: `route-${index}`, title: entry.reason ?? '' },
              `${entry.from ?? '?'} → ${entry.to ?? '?'}`,
            )),
          ),
          React.createElement('div', { className: 'dab-meta dab-mono' }, node.cwd ?? ''),
        )
        : null,
    ),
  )
}

function DabExecutionList({ host, onApprove, onReject }) {
  const proposals = Array.isArray(host.proposals) ? host.proposals : []
  const assignments = Array.isArray(host.assignments) ? host.assignments : []
  const active = assignments.filter(assignment => assignment.status === 'running' || assignment.status === 'starting').slice(-6)
  const interrupted = assignments.filter(assignment => assignment.status === 'interrupted').slice(-4)
  if (proposals.length === 0 && active.length === 0 && interrupted.length === 0) {
    return React.createElement('div', { className: 'dab-panel' }, React.createElement('p', { className: 'dab-panel-title' }, dabT('executions')), React.createElement('div', { className: 'dab-subtitle' }, dabT('noExecution')))
  }
  return React.createElement(
    'div',
    { className: 'dab-panel' },
    React.createElement('p', { className: 'dab-panel-title' }, dabT('executions')),
    React.createElement(
      'ul',
      { className: 'dab-list' },
      proposals.map(proposal => React.createElement(
        'li',
        { key: proposal.id },
        React.createElement('span', { className: 'dab-chip', 'data-tone': 'waiting' }, dabT('proposals')),
        React.createElement('span', { className: 'dab-grow' }, proposal.title),
        React.createElement('span', { className: 'dab-chip dab-mono' }, proposal.taskId),
        React.createElement('button', { type: 'button', className: 'dab-btn', onClick: () => onApprove(proposal.id) }, dabT('approve')),
        React.createElement('button', { type: 'button', className: 'dab-btn', onClick: () => onReject(proposal.id) }, dabT('reject')),
      )),
      active.map(assignment => React.createElement(
        'li',
        { key: assignment.id },
        React.createElement('span', { className: 'dab-chip', 'data-tone': 'running' }, assignment.status),
        React.createElement('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        React.createElement('span', { className: 'dab-chip dab-mono' }, assignment.model === null || assignment.model === undefined ? '?' : `${assignment.model.provider}/${assignment.model.model}`),
        assignment.sessionId !== null ? React.createElement('span', { className: 'dab-chip dab-mono' }, assignment.sessionId.slice(-10)) : null,
      )),
      interrupted.map(assignment => React.createElement(
        'li',
        { key: `int-${assignment.id}` },
        React.createElement('span', { className: 'dab-chip', 'data-tone': 'failed' }, dabT('restore')),
        React.createElement('span', { className: 'dab-grow dab-mono' }, assignment.taskId),
        React.createElement('span', { className: 'dab-error' }, dabT('resumed')),
      )),
    ),
  )
}

/** The main panel page. */
function dabMakePage(store, ctx) {
  return function AgentBoardPage() {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const [collapsed, setCollapsed] = React.useState(() => new Set())
    const [compact, setCompact] = React.useState(dabReadCompact)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')

    const host = snapshot.host ?? {}
    const projection = snapshot.projection ?? { nodes: [], byId: new Map(), roots: [], projects: [], counts: {} }
    const counts = projection.counts ?? {}

    React.useEffect(() => {
      store.start()
      const timer = setInterval(() => { void store.refreshHost() }, 20000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, [])

    const toggleCollapse = id => {
      setCollapsed(current => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const openNode = node => {
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace')
        if (typeof uiWorkspace?.openSession === 'function') {
          uiWorkspace.openSession(node.id)
          return
        }
        const layout = ctx.get?.('layout')
        if (typeof layout?.selectPanel === 'function') layout.selectPanel('conversation')
      } catch (error) {
        setNotice(`open failed: ${String(error?.message ?? error)}`)
      }
    }

    const ack = sessionId => { void store.ack(typeof sessionId === 'string' ? sessionId : sessionId?.id) }

    const act = async (label, operation) => {
      if (busy) return
      setBusy(true)
      try {
        const result = await operation()
        if (result?.ok !== true) setNotice(`${label}: ${result?.payload?.error ?? result?.error ?? result?.status ?? 'failed'}`)
        else setNotice('')
      } finally {
        setBusy(false)
      }
    }

    const mode = typeof host.mode === 'string' ? host.mode : 'off'
    const running = counts.running ?? 0
    const waiting = counts.waiting_user ?? 0
    const unread = counts.finished_unread ?? 0
    const canStop = (host.assignments ?? []).some(assignment => assignment.status === 'running' || assignment.status === 'starting')

    const header = React.createElement(
      'header',
      { className: 'dab-header' },
      React.createElement(
        'div',
        { className: 'dab-header-row' },
        React.createElement('h1', { className: 'dab-title' }, dabT('title')),
        React.createElement('span', { className: 'dab-subtitle' }, dabT('subtitle')),
        React.createElement('span', { className: 'dab-grow' }),
        running > 0 ? React.createElement('span', { className: 'dab-chip', 'data-tone': 'running' }, `${running} ${dabT('running')}`) : null,
        waiting > 0 ? React.createElement('span', { className: 'dab-chip', 'data-tone': 'waiting' }, `${waiting} ${dabT('waiting')}`) : null,
        unread > 0 ? React.createElement('span', { className: 'dab-chip', 'data-tone': 'unread' }, `${unread} ${dabT('unread')}`) : null,
      ),
      React.createElement(
        'div',
        { className: 'dab-header-row' },
        React.createElement('span', { className: 'dab-label' }, dabT('mode')),
        React.createElement(
          'div',
          { className: 'dab-seg', role: 'group', 'aria-label': dabT('mode') },
          ['off', 'supervised', 'autonomous'].map(value => React.createElement(
            'button',
            {
              key: value,
              type: 'button',
              className: 'dab-btn',
              'aria-pressed': mode === value,
              disabled: busy,
              onClick: () => act('mode', () => store.setMode(value)),
            },
            dabT(value),
          )),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dab-btn',
            'data-danger': 'true',
            disabled: busy || !canStop,
            onClick: () => act('stop', () => store.stop()),
            title: dabT('stop'),
          },
          '■ ',
          dabT('stop'),
        ),
        React.createElement('span', { className: 'dab-grow' }),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dab-btn',
            'aria-pressed': compact,
            onClick: () => { const next = !compact; setCompact(next); dabWriteCompact(next) },
          },
          dabT('compact'),
        ),
        React.createElement('button', { type: 'button', className: 'dab-btn', onClick: () => void store.refreshHost(), disabled: busy }, '⟳ ', dabT('refresh')),
      ),
    )

    const noticeText = mode === 'off' ? dabT('offNotice') : mode === 'supervised' ? dabT('supervisedNotice') : dabT('autonomousNotice')
    const sync = host.sync

    const body = React.createElement(
      'div',
      { className: 'dab-scroll' },
      notice !== '' ? React.createElement('div', { className: 'dab-notice dab-error', role: 'status' }, notice) : null,
      React.createElement('div', { className: 'dab-notice' }, noticeText),
      React.createElement('div', { className: 'dab-status-line' },
        sync === null || sync === undefined
          ? (snapshot.hostError !== null ? `${dabT('syncError')}: ${snapshot.hostError}` : '...')
          : sync.ok === true
            ? `${dabT('syncOk')} · rev ${sync.ledgerRevision ?? '?'} · ${sync.tasksTotal ?? 0} tâches · ${dabFormatAge(sync.at)}`
            : `${dabT('syncError')} — ${sync.error ?? ''}`),
      React.createElement(DabExecutionList, {
        host,
        onApprove: id => act('approve', () => store.decide(id, true)),
        onReject: id => act('reject', () => store.decide(id, false)),
      }),
      (host.reconcileNotes ?? []).length > 0
        ? React.createElement('div', { className: 'dab-panel' },
          React.createElement('p', { className: 'dab-panel-title' }, dabT('restore')),
          React.createElement('ul', { className: 'dab-list' }, (host.reconcileNotes ?? []).map(note => React.createElement('li', { key: note.assignmentId },
            React.createElement('span', { className: 'dab-chip', 'data-tone': 'failed' }, note.status),
            React.createElement('span', { className: 'dab-mono' }, note.taskId),
          ))))
        : null,
      (projection.projects ?? []).length === 0
        ? React.createElement('div', { className: 'dab-empty' }, dabT('empty'))
        : projection.projects.map(project => {
          const ownIds = new Set(project.nodes)
          const projectNodes = project.nodes.map(id => projection.byId.get(id)).filter(Boolean)
          const roots = projectNodes.filter(node => node.parentId === null || !ownIds.has(node.parentId))
          const rows = compact
            ? projectNodes.slice().sort((a, b) => String(a.title).localeCompare(String(b.title))).map(node => ({ node, depth: 0, collapsed: false, hasChildren: node.children.length > 0 }))
            : flattenVisible(roots, projection.byId, collapsed)
          return React.createElement(
            'section',
            { className: 'dab-project', key: project.id },
            React.createElement(
              'h2',
              { className: 'dab-project-head' },
              project.title,
              React.createElement('span', { className: 'dab-project-count' }, `${projectNodes.length}`),
            ),
            rows.map(row => React.createElement(DabCard, {
              key: row.node.id,
              node: row.node,
              depth: compact ? 0 : row.depth,
              collapsed: collapsed.has(row.node.id),
              hasChildren: row.hasChildren,
              compact,
              onToggleCollapse: () => toggleCollapse(row.node.id),
              onOpen: openNode,
              onAck: ack,
            })),
          )
        }),
      React.createElement(
        'details',
        { className: 'dab-panel' },
        React.createElement('summary', { className: 'dab-panel-title' }, `${dabT('adapters')} (${(host.adapters?.adapters ?? []).length})`),
        React.createElement('ul', { className: 'dab-list' },
          (host.adapters?.adapters ?? []).map(adapter => React.createElement('li', { key: adapter.id },
            React.createElement('span', { className: 'dab-chip' }, adapter.kind ?? '?'),
            React.createElement('span', { className: 'dab-grow' }, adapter.title ?? adapter.id),
            React.createElement('span', { className: 'dab-chip', 'data-tone': adapter.status === 'available' ? 'unread' : 'failed' }, adapter.status ?? '?'),
            adapter.validatedLive === true ? null : React.createElement('span', { className: 'dab-chip', 'data-tone': 'waiting' }, 'non validé live'),
          )),
        ),
      ),
    )

    return React.createElement('div', { className: 'dab-root', 'data-dsh-agent-board': '' }, header, body)
  }
}

function dabMakeIcon(store) {
  return function AgentBoardIcon() {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const counts = snapshot.projection?.counts ?? {}
    const unread = counts.finished_unread ?? 0
    const waiting = counts.waiting_user ?? 0
    return React.createElement(
      'span',
      { style: { display: 'inline-flex', alignItems: 'center', gap: '2px', position: 'relative' }, 'aria-hidden': 'true' },
      React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('rect', { x: 2.5, y: 3, width: 7, height: 5.4, rx: 1.4 }),
        React.createElement('rect', { x: 14.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
        React.createElement('rect', { x: 2.5, y: 15.6, width: 7, height: 5.4, rx: 1.4 }),
        React.createElement('path', { d: 'M6 8.4v3.1a1.5 1.5 0 0 0 1.5 1.5h10.5a1.5 1.5 0 0 1 1.5 1.5v1.1' }),
        React.createElement('path', { d: 'M3.2 15.6v-2.1A1.5 1.5 0 0 1 4.7 12h2.1' }),
      ),
      unread + waiting > 0
        ? React.createElement('span', {
          style: {
            position: 'absolute', top: '-6px', right: '-8px', minWidth: '13px', height: '13px', borderRadius: '999px',
            fontSize: '9px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: waiting > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
            color: 'var(--dsw-alias-bg-base)', padding: '0 3px',
          },
        }, String(unread + waiting))
        : null,
    )
  }
}

/** Client plugin entry: styles + store + slot registrations. */
function apply(ctx) {
  const disposers = []
  // Resolve the host locale first (the shell language, not navigator.language,
  // decides the panel language), then fall back to the document/browser.
  try {
    const snapshot = ctx.get?.('locale')?.getLocale?.()
    const active = snapshot?.active
    const id = typeof active === 'string' ? active : active?.id
    if (typeof id === 'string' && id !== '') globalThis.__dabLocale = () => id
  } catch { /* keep the document fallback */ }
  DAB_LANG = dabLocale()
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
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}


    return { name: 'dsh-agent-board/client', inject: ['slots'], apply }
  },
})
