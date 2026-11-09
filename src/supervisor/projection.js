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

import { ERROR_TURN_KINDS, STATUS, STATUS_RANK, truncate } from '../contracts/model.js'

const PENDING_ACTION = Object.freeze({
  approval: 'approval',
  'plan-review': 'plan-review',
  question: 'question',
})

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
        title: typeof entry.title === 'string' ? entry.title : undefined,
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
 * Classify one agent. `live` is its unified status entry, `turnEnd` the last
 * turn/end fact the host recorded, `ack` the persisted read cursor.
 */
export function classifyStatus({ row, live, turnEnd, ack }) {
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
export function expectedActionOf(live) {
  const pending = live?.pendingInteraction
  if (pending === null || pending === undefined) return null
  const kind = typeof pending === 'string' ? pending : pending.kind
  if (typeof kind !== 'string' || kind === '') return null
  return PENDING_ACTION[kind] ?? 'unknown'
}

export function modelOf(row, assignment) {
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
export function buildProjection({ list, statusMap, hostState = {}, workspaces = {}, now = Date.now() }) {
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
