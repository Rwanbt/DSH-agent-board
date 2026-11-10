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

import { ERROR_TURN_KINDS, INTERRUPTED_TURN_KINDS, STATUS, STATUS_RANK, truncate } from '../contracts/model.js'

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
 * Classify one agent and explain why. `live` is its unified status entry,
 * `turnEnd` the last turn/end fact the host recorded, `ack` the persisted read
 * cursor, `assignment` the board assignment bound to that session.
 *
 * The returned `reason`/`source`/`at` triple is what the UI shows in the card
 * details: a status without provenance is not allowed to be invented.
 *
 * @returns {{status:string, reason:string, source:string, at:number|null}}
 */
export function classifyStatusDetailed({ row, live, turnEnd, ack, assignment }) {
  const end = turnEnd !== null && typeof turnEnd === 'object' ? turnEnd : null
  const seenAt = Number(ack?.seenAt)
  const hasSeen = Number.isFinite(seenAt)
  const updatedAt = Number(row?.updatedAt)
  const nativeEnd = nativeTurnEndOf(row)

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
  // Failure truth: the host-recorded turn end wins, then the native lifecycle
  // fact. A recovered failure (a later turn started) is no longer a failure.
  if (end !== null && ERROR_TURN_KINDS.includes(end.kind) && end.recoveredAt === undefined) {
    const covered = hasSeen && Number.isFinite(Number(end.at)) && seenAt >= Number(end.at)
    return { status: STATUS.FAILED, reason: `turn_end:${end.kind}`, source: 'host_turn_end', at: Number(end.at) || null, _seen: covered }
  }
  if ((end === null || end.recoveredAt !== undefined) && nativeEnd !== null && ERROR_TURN_KINDS.includes(nativeEnd.reason)) {
    // Native-only failure: the host may have missed the event (restart). There
    // is no board ack that could have covered it, so it stays unread/visible.
    return { status: STATUS.FAILED, reason: `native_turn_end:${nativeEnd.reason}`, source: 'session_projection', at: null, _seen: false }
  }
  if (end !== null && Number.isFinite(Number(end.at))) {
    if (INTERRUPTED_TURN_KINDS.includes(end.kind)) {
      return { status: STATUS.IDLE, reason: `turn_ended:${end.kind}`, source: 'host_turn_end', at: Number(end.at) || null }
    }
    if (hasSeen && seenAt >= Number(end.at)) {
      return { status: STATUS.FINISHED_READ, reason: `ack_after_turn:${end.kind}`, source: 'host_turn_end', at: Number(end.at) || null }
    }
    return { status: STATUS.FINISHED_UNREAD, reason: `turn_end:${end.kind}_not_acknowledged`, source: 'host_turn_end', at: Number(end.at) || null }
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
    return { status: STATUS.FINISHED_READ, reason: `native_history:${nativeEnd.reason}`, source: 'session_projection', at: null }
  }
  if (row?.agentAvailable === false) {
    return { status: STATUS.UNAVAILABLE, reason: 'agent_not_available', source: 'session_row', at: null }
  }
  if (row === undefined) {
    return { status: STATUS.UNKNOWN, reason: 'no_row_for_session', source: 'none', at: null }
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
    const detail = classifyStatusDetailed({ row, live, turnEnd, ack, assignment })
    const status = detail.status
    const parentId = row !== undefined ? parentIdOf(row) : null
    const project = row !== undefined ? resolveProject(row, workspaceIndex) : UNASSIGNED_PROJECT
    const resolvedParent = parentId ?? (catalogParentOf.get(node.id) ?? null)
    const ownRunning = row?.running === true || live?.running === true
    const preview = previewOf(hostState, node.id, assignment, row, ownRunning)
    const stats = row?.projectionValues?.sessionStats
    // Explicit acknowledgement covers a failure only when a cursor exists and
    // it is at/after the recorded failure. A native-only failure has no such
    // cursor: it stays visible instead of silently leaving the home view.
    const seen = status === STATUS.FAILED ? detail._seen === true : status !== STATUS.FINISHED_UNREAD
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
      statusReason: detail.reason,
      statusSource: detail.source,
      statusAt: detail.at,
      seen,
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
      recovering: status === STATUS.RECOVERING,
      failed: status === STATUS.FAILED,
      unavailable: status === STATUS.UNAVAILABLE,
      archived: archived.has(node.id),
      blank: row?.blank === true,
      // Native fact: the user currently has this session open in the main view.
      // The panel uses it to acknowledge reading done outside the board.
      viewing: Number(row?.retainedBy?.mainView) > 0,
      agentAvailable: typeof row?.agentAvailable === 'boolean' ? row.agentAvailable : null,
      updatedAt: Number(row?.updatedAt) || null,
      assignmentId: assignment?.id ?? null,
      taskId: assignment?.taskId ?? null,
      assignmentStatus: assignment?.status ?? null,
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
    recovering: 0,
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
