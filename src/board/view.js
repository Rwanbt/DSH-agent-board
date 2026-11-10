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

import { STATUS, STATUS_RANK } from '../contracts/model.js'

export const VIEW_FILTERS = Object.freeze(['attention', 'recent', 'all'])
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CHILD_LIMIT = 4
export const DEFAULT_TREE_LIMIT = 8

/** Does this node by itself demand to be on the home view? */
export function isAttention(node) {
  if (node === undefined || node === null) return false
  // An archived session is history whatever its status: the operator archived
  // it, so it is neither attention nor a fresh result (still reachable through
  // "all", the search and the history drawer).
  if (node.archived === true) return false
  if (node.status === STATUS.WAITING_USER) return true
  if (node.status === STATUS.RUNNING) return true
  if (node.status === STATUS.RECOVERING) return true
  // A stopped/superseded launch is unfinished work: hidden only once the user
  // has read it (the status stays `interrupted`, the attention flag clears).
  if (node.status === STATUS.INTERRUPTED) return node.seen !== true
  // The model's provider is inside an injected cooldown: the card is blocked
  // on something outside its own turn and needs a decision.
  if (node.status === STATUS.PROVIDER_UNAVAILABLE) return true
  if (node.status === STATUS.FINISHED_UNREAD) return true
  if (node.status === STATUS.FAILED && node.seen !== true) return true
  return false
}

/** Attention tier used for sorting: lower first. */
export function attentionRank(node) {
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
export function sortAttention(a, b) {
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
export function aggregateSubtrees(projection) {
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
export function includedByFilter(node, filter, now, query = '') {
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
export function buildBoardView(projection, options = {}) {
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
export function boardCounts(projection) {
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
export function projectOptions(projection) {
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
export function historyPage(projection, { query = '', project = null, offset = 0, limit = 30, includeSubagents = false } = {}) {
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
export function ancestorChain(projection, id) {
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
