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
 * Classify one agent. `live` is its unified status entry, `turnEnd` the last
 * turn/end fact the host recorded, `ack` the persisted read cursor.
 */
export function classifyStatus({ row, live, turnEnd, ack }) {
  if (row === undefined && live === undefined) return STATUS.UNKNOWN
  if (expectedActionOf(live, row) !== null) return STATUS.WAITING_USER
  if (row?.running === true || live?.running === true) return STATUS.RUNNING
  const end = turnEnd !== null && typeof turnEnd === 'object' ? turnEnd : null
  if (end !== null && ERROR_TURN_KINDS.includes(end.kind) && end.recoveredAt === undefined) return STATUS.FAILED
  if (end !== null && Number.isFinite(Number(end.at))) {
    const seenAt = Number(ack?.seenAt)
    if (Number.isFinite(seenAt) && seenAt >= Number(end.at)) return STATUS.FINISHED_READ
    return STATUS.FINISHED_UNREAD
  }
  if (live?.completionUnread === true) return STATUS.FINISHED_UNREAD
  // Native durable fact (session projection): the last turn ended in error.
  const nativeEnd = nativeTurnEndOf(row)
  if (nativeEnd !== null && ERROR_TURN_KINDS.includes(nativeEnd.reason)) return STATUS.FAILED
  // A turn that completed before the board observed it is history, not "new".
  if (nativeEnd !== null) return STATUS.FINISHED_READ
  if (row === undefined) return STATUS.UNKNOWN
  return STATUS.IDLE
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

export function modelOf(row, assignment) {
  const candidates = [
    assignment?.model,
    row?.model,
    row?.modelSelection,
    row?.projectionValues?.modelSelection?.lastUsed,
    row?.projectionValues?.modelSelection?.next,
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

/**
 * The final answer excerpt. Only an answer that closed a turn is "final":
 *   1. host-captured last assistant message when the session is not running
 *      and a turn end was recorded at/after it;
 *   2. the native turn outline `response` of the latest answered turn;
 *   3. a board checkpoint text.
 * A mid-turn assistant segment (between tool calls) is never presented as the
 * final answer; it is exposed separately as `interim` only for activity.
 */
export function previewOf(hostState, sessionId, assignment, row, running = false) {
  const preview = hostState?.previews?.[sessionId]
  const end = hostState?.turnEnd?.[sessionId]
  const hostText = preview !== undefined && typeof preview.text === 'string' ? preview.text.trim() : ''
  if (hostText !== '' && !running && end !== undefined && Number(end.at) >= Number(preview.at)) {
    return { text: truncate(hostText, 600), at: Number(preview.at) || null, final: true, source: 'host' }
  }
  const outline = row?.projectionValues?.turnOutline
  if (Array.isArray(outline)) {
    for (let index = outline.length - 1; index >= 0; index -= 1) {
      const entry = outline[index]
      const isOpenTurn = running && index === outline.length - 1
      if (!isOpenTurn && typeof entry?.response === 'string' && entry.response.trim() !== '') {
        return { text: truncate(entry.response.trim(), 600), at: null, final: true, source: 'outline', turn: Number(entry.turn) || null }
      }
    }
  }
  const checkpointText = assignment?.checkpoint?.lastText
  if (!running && typeof checkpointText === 'string' && checkpointText !== '') {
    return { text: truncate(checkpointText, 600), at: Number(assignment?.checkpoint?.at) || null, final: true, source: 'checkpoint' }
  }
  return { text: '', at: null, final: false, source: null }
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

  const workspaceIndex = indexWorkspaces(workspaces)
  // Team member names declared by a parent (role labels for its children).
  const roleOf = new Map()
  const catalogEntryOf = new Map()
  for (const parentId of Object.keys(normalized.projectionsBySession)) {
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
    const status = classifyStatus({ row, live, turnEnd, ack })
    const parentId = row !== undefined ? parentIdOf(row) : null
    const project = row !== undefined ? resolveProject(row, workspaceIndex) : UNASSIGNED_PROJECT
    const resolvedParent = parentId ?? (catalogParentOf.get(node.id) ?? null)
    const ownRunning = row?.running === true || live?.running === true
    const preview = previewOf(hostState, node.id, assignment, row, ownRunning)
    const stats = row?.projectionValues?.sessionStats
    out.push({
      id: node.id,
      parentId: resolvedParent,
      projectId: project.id,
      projectTitle: project.title,
      projectSource: project.source,
      title: titleOf(row, catalogEntryOf.get(node.id), node.id),
      role: roleOf.get(node.id) ?? null,
      cwd: typeof row?.cwd === 'string' ? row.cwd : null,
      origin: typeof row?.origin === 'string' ? row.origin : (resolvedParent !== null ? 'subagent' : 'main'),
      status,
      seen: status === STATUS.FAILED ? (Number(ack?.seenAt) >= Number(turnEnd?.at ?? Infinity) || turnEnd === null) : status !== STATUS.FINISHED_UNREAD,
      expectedAction: expectedActionOf(live, row),
      waitingDetail: waitingDetailOf(row),
      model: modelOf(row, assignment),
      preview,
      activity: stats !== undefined && stats !== null
        ? { turns: Number(stats.turns) || 0, steps: Number(stats.steps) || 0, toolMs: Number(stats.toolMs) || 0, llmMs: Number(stats.llmMs) || 0 }
        : null,
      error: typeof turnEnd?.error === 'string' ? turnEnd.error : null,
      goal: typeof row?.projectionValues?.goal?.goal?.objective === 'string' ? truncate(row.projectionValues.goal.goal.objective, 240) : null,
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

  // Link children. A malformed parent chain (self-parent or cycle) is broken at
  // the node that closes the loop: it becomes a root flagged `parentCycle`.
  const byId = new Map(out.map(node => [node.id, node]))
  for (const node of out) {
    if (node.parentId === null) continue
    if (!byId.has(node.parentId)) { node.orphan = true; continue }
    const seen = new Set([node.id])
    let cursor = byId.get(node.parentId)
    let cycle = false
    while (cursor !== undefined) {
      if (seen.has(cursor.id)) { cycle = true; break }
      seen.add(cursor.id)
      cursor = cursor.parentId !== null && !cursor.parentCycle ? byId.get(cursor.parentId) : undefined
    }
    if (cycle) { node.parentCycle = true; continue }
  }
  for (const node of out) {
    if (node.parentId !== null && !node.orphan && !node.parentCycle) byId.get(node.parentId).children.push(node.id)
  }
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
