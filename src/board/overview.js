/**
 * Flat cockpit overview model (pure): one ordered list of agent cards with
 * stable sections and indicator counts, computed from the projection only.
 *
 * This module is the data half of the responsive cockpit (see
 * docs/UX-COCKPIT-CONTRACT.md, "Data contract"). The React layer only renders
 * the output: it never re-derives a status, a section or a count.
 *
 * Honesty rules:
 *   - no status is derived from age, role, model or task state; the section of
 *     a card is its projection status, and its Task Board state is a separate
 *     ledger fact rendered as its own chip;
 *   - the `review` bucket is ONLY the linked Task Board state `in_review`; when
 *     the ledger is not readable, `reviewAvailable` is false and the review
 *     count stays 0 (the UI shows the real reason, never a fabricated number);
 *   - archived sessions are operator-dismissed history, exactly as in
 *     `board/view.js`, so they are never an intervention;
 *   - blank sessions are not agents: they are counted in `counts.total` but not
 *     in `counts.agents`, never in a bucket and never as a card.
 *
 * Counting: `attention + active + review + other === counts.agents` (every
 * non-blank node once, with precedence attention > active > review > other).
 * The buckets describe the whole projection, independent from the view filter,
 * the project filter, the search, the focus or the dismiss preference: they are
 * indicators, not a count of the rendered cards (that is `counts.shown`).
 *
 * Ordering: the fixed section order (attention, running, other), then
 * `sortAttention()` inside each section, which already ends with the title and
 * then the id, so the result is a deterministic total order.
 *
 * @module dsh-agent-board/board/overview
 */

import { STATUS } from '../contracts/model.js'
import { RECENT_WINDOW_MS, VIEW_FILTERS, aggregateSubtrees, attentionRank, isActionRequired, isAttention, sortAttention } from './view.js'
import { matchesHierarchyFilters, normalizeHierarchyFilters, resolveNodeRoles } from './hierarchy.js'

/** Fixed order of the cockpit sections. */
export const OVERVIEW_SECTIONS = Object.freeze(['attention', 'running', 'other'])

/** Indicator buckets, in precedence order (each node counted exactly once). */
export const OVERVIEW_BUCKETS = Object.freeze(['attention', 'active', 'review', 'other'])

const TASK_IN_REVIEW = 'in_review'

function isIndex(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
}

function isReadableIndex(value) {
  if (isIndex(value)) return true
  // Tolerant read of a plain object index; `null`/`undefined` mean the ledger is
  // not readable and must never be turned into "no task is in review".
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function indexedValue(index, id) {
  if (index === null || id === null || id === undefined) return null
  const key = String(id)
  if (isIndex(index)) return index.get(key) ?? null
  return Object.prototype.hasOwnProperty.call(index, key) ? index[key] : null
}

function isRootNode(node) {
  return node.parentId === null || node.parentId === undefined || node.orphan === true || node.parentCycle === true
}

/**
 * Depth of every node from its displayed root, cycle-safe and linear.
 * A flagged root (orphan / broken cycle) is depth 0 even when it still carries
 * its declared `parentId`, matching the tree `buildProjection()` produces.
 */
function computeDepths(nodes, byId) {
  const memo = new Map()
  for (const node of nodes) {
    if (memo.has(node.id)) continue
    const path = []
    const seen = new Set()
    let cursor = node
    while (cursor !== undefined && !memo.has(cursor.id) && !isRootNode(cursor) && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      path.push(cursor)
      cursor = byId.get(String(cursor.parentId))
    }
    let depth
    if (cursor !== undefined && isRootNode(cursor)) {
      if (!memo.has(cursor.id)) memo.set(cursor.id, 0)
      depth = memo.get(cursor.id) + 1
    } else if (cursor !== undefined && memo.has(cursor.id)) {
      depth = memo.get(cursor.id) + 1
    } else {
      // Hand-built input with an unflagged cycle: break it deterministically at
      // the current path instead of recursing forever.
      depth = 0
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      memo.set(path[index].id, depth)
      depth += 1
    }
  }
  return memo
}

/** Section of a card: status only (the review bucket is not a section). */
function sectionOf(node) {
  if (isActionRequired(node)) return 'attention'
  if (node.status === STATUS.RUNNING || node.status === STATUS.RECOVERING) return 'running'
  return 'other'
}

/** Indicator bucket, mutually exclusive with the documented precedence. */
function bucketOf(node, taskStates, reviewAvailable) {
  if (isActionRequired(node)) return 'attention'
  if (node.status === STATUS.RUNNING || node.status === STATUS.RECOVERING) return 'active'
  if (reviewAvailable && indexedValue(taskStates, node.taskId) === TASK_IN_REVIEW) return 'review'
  return 'other'
}

/** Search over the fields the cockpit contract lists, plus the declared role. */
function matchesOverviewQuery(node, query, role, taskTitle) {
  if (query === '') return true
  const haystack = [
    node.title,
    node.role,
    role?.roleId,
    role?.roleLabel,
    node.projectTitle,
    node.id,
    node.taskId,
    taskTitle,
    typeof node.model === 'string' ? node.model : node.model?.model,
    node.model?.provider,
    node.goal,
  ]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  return query.split(/\s+/).filter(Boolean).every(term => haystack.includes(term))
}

/**
 * Build the flat cockpit overview.
 *
 * @param {object} projection `buildProjection()` output (tolerant of `undefined`)
 * @param {object} [options]
 * @param {'attention'|'action'|'all'|'recent'} [options.filter] view filter
 *   (default `attention`, the existing "current work" policy)
 * @param {string} [options.query] free-text search; when non-empty it overrides
 *   the view filter, exactly like `buildBoardView()`
 * @param {string|null} [options.project] only this project id, or null for all
 * @param {Set<string>} [options.dismissed] dismissed node ids (existing preference)
 * @param {Map<string,object>} [options.roles] resolved roles from
 *   `buildHierarchyView()` (optional; resolved from the projection otherwise)
 * @param {Map<string,string>|null} [options.taskStates] task id -> Task Board
 *   state; `null`/`undefined` means the ledger is not readable
 * @param {Map<string,string>|null} [options.taskTitles] task id -> Task Board title
 * @param {{role?:string|null,status?:string|null,taskState?:string|null}} [options.filters]
 *   agent filters, normalized by `normalizeHierarchyFilters()`
 * @param {'attention'|'active'|'review'|'other'|null} [options.focus] narrows to
 *   one indicator bucket (and takes precedence over the view filter); null clears it
 * @param {string|null} [options.selectedId] inspected node; when selecting it just
 *   acknowledged it out of the active filter, it stays pinned in the overview
 * @param {number} [options.now]
 * @returns {{
 *   sections: Array<{id:string, entries:Array<object>}>,
 *   entries: Array<object>,
 *   counts: {total:number, agents:number, active:number, attention:number,
 *            review:number, other:number, shown:number, reviewAvailable:boolean},
 *   filter: string, query: string, focus: string|null,
 * }}
 */
export function buildOverview(projection, options = {}) {
  const source = projection !== null && typeof projection === 'object' ? projection : {}
  const nodes = Array.isArray(source.nodes) ? source.nodes : []
  const byId = source.byId instanceof Map ? source.byId : new Map(nodes.map(node => [node.id, node]))
  // Normalized view input so a missing/partial projection degrades to an empty
  // board instead of throwing inside the shared helpers.
  const normalizedProjection = { nodes, byId }
  const now = Number(options.now) || Date.now()

  const filter = VIEW_FILTERS.includes(options.filter) ? options.filter : 'attention'
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
  const focus = OVERVIEW_BUCKETS.includes(options.focus) ? options.focus : null
  const project = typeof options.project === 'string' && options.project !== '' ? options.project : null
  const dismissed = options.dismissed instanceof Set ? options.dismissed : new Set()

  const taskStates = isReadableIndex(options.taskStates) ? options.taskStates : null
  const taskTitles = isReadableIndex(options.taskTitles) ? options.taskTitles : null
  const reviewAvailable = taskStates !== null

  const filters = normalizeHierarchyFilters(options.filters)
  // The Task Board state filter only applies when the ledger is readable;
  // otherwise it is ignored (reported, never silently guessed).
  const effectiveFilters = { ...filters, taskState: reviewAvailable ? filters.taskState : null }

  const roles = options.roles instanceof Map ? options.roles : resolveNodeRoles(normalizedProjection, undefined, taskTitles)
  const aggregates = aggregateSubtrees(normalizedProjection)
  const depths = computeDepths(nodes, byId)
  const selectedId = typeof options.selectedId === 'string' && options.selectedId !== '' ? options.selectedId : null

  const makeEntry = node => ({
    node,
    role: roles.get(node.id) ?? null,
    projectTitle: node.projectTitle ?? null,
    parentTitle: node.parentId === null || node.parentId === undefined ? null : (byId.get(String(node.parentId))?.title ?? null),
    taskState: reviewAvailable ? indexedValue(taskStates, node.taskId) : null,
    taskTitle: indexedValue(taskTitles, node.taskId),
    descendants: aggregates.get(node.id)?.descendants ?? 0,
    depth: depths.get(node.id) ?? 0,
    tier: attentionRank(node),
  })

  const counts = {
    total: nodes.length,
    agents: 0,
    active: 0,
    attention: 0,
    review: 0,
    other: 0,
    shown: 0,
    reviewAvailable,
  }
  const buckets = new Map()
  for (const node of nodes) {
    if (node.blank === true) continue
    counts.agents += 1
    const bucket = bucketOf(node, taskStates, reviewAvailable)
    buckets.set(node.id, bucket)
    counts[bucket] += 1
  }

  const included = []
  for (const node of nodes) {
    if (node.blank === true) continue
    // The dismiss preference hides a session from the attention/action/recent
    // views (an explicit "all" or a search still reaches it), as in view.js.
    if (dismissed.has(node.id) && query === '' && filter !== 'all') continue
    if (project !== null && node.projectId !== project) continue
    if (!matchesHierarchyFilters(node, roles, effectiveFilters, taskStates, reviewAvailable)) continue
    const bucket = buckets.get(node.id) ?? 'other'
    if (focus !== null) {
      if (bucket !== focus) continue
    } else if (query === '') {
      if (filter === 'action') {
        if (!isActionRequired(node)) continue
      } else if (filter === 'recent') {
        const withinWindow = node.archived !== true
          && Number.isFinite(Number(node.updatedAt))
          && now - Number(node.updatedAt) <= RECENT_WINDOW_MS
        if (!isAttention(node) && !withinWindow) continue
      } else if (filter === 'attention') {
        if (!isAttention(node)) continue
      }
      // filter === 'all': every non-blank node is included.
    }
    // A non-empty search overrides the view filter (existing board policy) and
    // still respects the project, agent and focus narrowing above.
    if (query !== '' && !matchesOverviewQuery(node, query, roles.get(node.id) ?? null, indexedValue(taskTitles, node.taskId))) continue
    included.push(makeEntry(node))
  }

  // The inspected card stays visible while its inspector is open. Selecting a
  // result ACKNOWLEDGES it (existing board behaviour), which can move it out of
  // the attention filter; without this pin, the card would vanish under the
  // operator's eyes and a keyboard user would lose their place. The pin respects
  // the project, query and agent filters; it only bypasses the view filter.
  if (selectedId !== null && !included.some(entry => entry.node.id === selectedId)) {
    const node = byId.get(selectedId)
    if (node !== undefined && node.blank !== true
      && (project === null || node.projectId === project)
      && (focus === null || (buckets.get(node.id) ?? 'other') === focus)
      && matchesHierarchyFilters(node, roles, effectiveFilters, taskStates, reviewAvailable)
      && (query === '' || matchesOverviewQuery(node, query, roles.get(node.id) ?? null, indexedValue(taskTitles, node.taskId)))) {
      included.push(makeEntry(node))
    }
  }

  const sections = []
  const entries = []
  for (const id of OVERVIEW_SECTIONS) {
    const sectionEntries = included.filter(entry => sectionOf(entry.node) === id).sort(sortAttention)
    sections.push({ id, entries: sectionEntries })
    entries.push(...sectionEntries)
  }
  counts.shown = entries.length

  return { sections, entries, counts, filter, query, focus }
}
