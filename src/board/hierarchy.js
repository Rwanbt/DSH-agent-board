/**
 * Supervision hierarchy view (pure): workspace -> project -> orchestrator ->
 * teams of agents, built ON TOP of the existing board view.
 *
 * It never re-implements visibility, sorting or the attention policy: the
 * `view` argument is `buildBoardView()` output and is consumed as-is. This
 * module only adds what the board view does not know:
 *
 *   - the workspace (host supervision layer) level;
 *   - the declared-role projection of every node (generic identity when the
 *     declared role resolves to nothing: never a guessed mascot);
 *   - the project orchestrator, only when a node's DECLARED role really is
 *     `orchestrator` — otherwise `null`, an honest visible gap;
 *   - real per-project counts, supervision blocks and cross-project
 *     dependencies;
 *   - the agent filters (role / status / Task Board state) applied to the
 *     already-visible entries.
 *
 * Honesty rules:
 *   - `supervision === null` still renders: structure and counts come from the
 *     projection only, capabilities are unavailable (never faked) and the
 *     workspace status is `unknown` with an explicit reason;
 *   - no fake node is ever added (a missing orchestrator stays `null`);
 *   - a Task Board state filter is only applied when the integration reports
 *     it available; its absence is reported, never silently guessed.
 *
 * @module dsh-agent-board/board/hierarchy
 */

import { buildBoardView } from './view.js'
import { AGENT_ROLE_IDS, AGENT_STATUS_TONE, AGENT_TASK_STATE_TONE, dabResolveRoleForNode } from '../contracts/agent-roles.js'

export const WORKSPACE_ROLE_ID = 'super_orchestrator'
export const PROJECT_ORCHESTRATOR_ROLE_ID = 'orchestrator'
/** Filter value matching every node whose declared role resolves to nothing. */
export const GENERIC_ROLE_FILTER = 'generic'

/**
 * Singular/plural key choice for one count. `1` (and `-1`) is singular; zero and
 * every other value are plural. Pure so the UI and the tests share one rule.
 */
export function pluralKeyFor(count, singularKey, pluralKey) {
  const value = Number(count)
  return Number.isFinite(value) && Math.abs(value) === 1 ? singularKey : pluralKey
}

/**
 * Count text through an injected translator, e.g.
 * `countLabelFor(1, 'projectSingular', 'projectPlural', dabT)` -> `1 projet`.
 */
export function countLabelFor(count, singularKey, pluralKey, translate) {
  const value = Number(count) || 0
  const t = typeof translate === 'function' ? translate : key => key
  return `${value} ${t(pluralKeyFor(value, singularKey, pluralKey))}`
}

/**
 * Project-head count label: the REAL agent count, plus the displayed count when
 * the view shows fewer (attention policy or filters). Both numbers are real, so
 * the Projects view and the hierarchy never seem to disagree.
 */
export function projectCountLabel(counts, shownAgents, translate) {
  const total = Number(counts?.agents) || 0
  const shown = Number(shownAgents) || 0
  const t = typeof translate === 'function' ? translate : key => key
  const label = countLabelFor(total, 'agentSingular', 'agentPlural', t)
  if (shown === total) return label
  return `${label} · ${countLabelFor(shown, 'shownSingular', 'shownPlural', t)}`
}

const TASK_STATE_KEYS = Object.freeze(Object.keys(AGENT_TASK_STATE_TONE))
const STATUS_KEYS = Object.freeze(Object.keys(AGENT_STATUS_TONE))

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize the agent filters. Unknown values are dropped (a stale persisted
 * preference can never select an invisible pseudo-status).
 *
 * @param {object|null} filters
 * @returns {{role: string|null, status: string|null, taskState: string|null}}
 */
export function normalizeHierarchyFilters(filters) {
  const value = isPlainObject(filters) ? filters : {}
  // A persisted role id is accepted only when it is an approved role or the
  // explicit "generic identity" filter: a stale/removed id must never silently
  // hide every agent while the toolbar shows "all roles".
  const role = typeof value.role === 'string' && value.role !== '' && value.role !== 'all'
    ? (value.role === GENERIC_ROLE_FILTER || AGENT_ROLE_IDS.includes(value.role) ? value.role : null)
    : null
  const status = typeof value.status === 'string' && STATUS_KEYS.includes(value.status) ? value.status : null
  const taskState = typeof value.taskState === 'string' && TASK_STATE_KEYS.includes(value.taskState) ? value.taskState : null
  return { role, status, taskState }
}

/** Task Board states indexed by task id; null when the integration is absent. */
export function taskStateIndex(supervision) {
  const taskboard = supervision?.taskboard
  if (!isPlainObject(taskboard) || taskboard.available !== true || !Array.isArray(taskboard.tasks)) return null
  const index = new Map()
  for (const task of taskboard.tasks) {
    if (!isPlainObject(task) || typeof task.id !== 'string') continue
    if (typeof task.status === 'string') index.set(task.id, task.status)
  }
  return index
}

/** Task Board task titles indexed by task id; null when the integration is absent. */
export function taskTitleIndex(supervision) {
  const taskboard = supervision?.taskboard
  if (!isPlainObject(taskboard) || taskboard.available !== true || !Array.isArray(taskboard.tasks)) return null
  const index = new Map()
  for (const task of taskboard.tasks) {
    if (!isPlainObject(task) || typeof task.id !== 'string') continue
    if (typeof task.title === 'string' && task.title !== '') index.set(task.id, task.title)
  }
  return index.size > 0 ? index : null
}

/**
 * Resolve the role of every node once per build.
 *
 * A DECLARED role/name always wins; otherwise the documented text inference is
 * used (title/goal/task title), marked `source:'inferred'`. The resolver is
 * injectable so a test can stub it; with the default resolver, nodes sharing the
 * same declared role + inference text share one resolution.
 *
 * @param {object} projection
 * @param {Function|object} [resolver] injected resolver (called with the declared
 *   role string, for backward compatibility) or default node resolver
 * @param {Map<string,string>|null} [taskTitles] task id -> title (inference input)
 */
export function resolveNodeRoles(projection, resolver = dabResolveRoleForNode, taskTitles = null) {
  const resolve = typeof resolver === 'function' ? resolver : dabResolveRoleForNode
  const useInference = resolve === dabResolveRoleForNode
  const cache = new Map()
  const out = new Map()
  for (const node of projection.nodes) {
    const declared = typeof node.role === 'string' && node.role !== '' ? node.role : null
    const taskTitle = taskTitles instanceof Map && node.taskId !== null && node.taskId !== undefined
      ? taskTitles.get(String(node.taskId)) ?? null
      : null
    const key = useInference && declared === null
      ? `i|${String(node.title ?? '')}|${String(node.goal ?? '')}|${String(taskTitle ?? '')}`
      : (declared ?? '')
    let resolved = cache.get(key)
    if (resolved === undefined) {
      resolved = useInference
        ? resolve({ role: declared, title: node.title, goal: node.goal, taskTitle })
        : (declared === null ? { roleId: null, source: 'generic', raw: null, role: null } : resolve(declared))
      if (!isPlainObject(resolved)) resolved = { roleId: null, source: 'generic', raw: declared, role: null }
      cache.set(key, resolved)
    }
    out.set(node.id, {
      roleId: typeof resolved.roleId === 'string' && resolved.roleId !== '' ? resolved.roleId : null,
      roleLabel: typeof resolved.role?.label === 'string' ? resolved.role.label : null,
      family: typeof resolved.role?.family === 'string' ? resolved.role.family : null,
      source: resolved.source === 'explicit' || resolved.source === 'alias' || resolved.source === 'inferred'
        ? resolved.source
        : 'generic',
      inference: isPlainObject(resolved.inference) ? resolved.inference : null,
      raw: typeof resolved.raw === 'string' ? resolved.raw : declared,
    })
  }
  return out
}

/**
 * The project orchestrator: an agent whose resolved role is `orchestrator`
 * (declared, or deduced from its declared text and then marked as such). A
 * `super_orchestrator` is the workspace layer, not a project orchestrator.
 * Deterministic choice when several qualify: a root first, then the most
 * recently updated, then the id. Never fabricated.
 */
export function findProjectOrchestrator(nodes, roles) {
  let best = null
  let bestKey = null
  for (const node of nodes) {
    if (roles.get(node.id)?.roleId !== PROJECT_ORCHESTRATOR_ROLE_ID) continue
    const root = node.parentId === null || node.orphan === true || node.parentCycle === true
    const key = [root ? 0 : 1, -(Number(node.updatedAt) || 0), String(node.id)]
    if (bestKey === null || compareKeys(key, bestKey) < 0) {
      best = node
      bestKey = key
    }
  }
  if (best === null) return null
  return {
    id: best.id,
    name: best.title,
    role: best.role,
    roleId: PROJECT_ORCHESTRATOR_ROLE_ID,
    roleLabel: roles.get(best.id)?.roleLabel ?? null,
    source: roles.get(best.id)?.source ?? 'explicit',
    inference: roles.get(best.id)?.inference ?? null,
    status: best.status,
    projectId: best.projectId,
  }
}

function compareKeys(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return 0
}

/** Real per-project agent counts (every node of the project, not only visible ones). */
export function countProjectNodes(nodes) {
  const counts = { agents: 0, running: 0, waiting: 0, unread: 0, failed: 0, interrupted: 0 }
  for (const node of nodes) {
    counts.agents += 1
    if (node.status === 'running') counts.running += 1
    else if (node.status === 'waiting_user') counts.waiting += 1
    else if (node.status === 'finished_unread') counts.unread += 1
    else if (node.status === 'failed') counts.failed += 1
    else if (node.status === 'interrupted') counts.interrupted += 1
  }
  return counts
}

function addCounts(target, source) {
  for (const key of ['agents', 'running', 'waiting', 'unread', 'failed', 'interrupted']) target[key] += source[key]
  return target
}

/** Does this node pass the explicit agent filters? */
export function matchesHierarchyFilters(node, roles, filters, taskStates, taskStateAvailable) {
  if (filters.role !== null) {
    const roleId = roles.get(node.id)?.roleId ?? null
    if (filters.role === GENERIC_ROLE_FILTER ? roleId !== null : roleId !== filters.role) return false
  }
  if (filters.status !== null && node.status !== filters.status) return false
  if (filters.taskState !== null && taskStateAvailable) {
    const state = node.taskId === null || node.taskId === undefined ? null : taskStates?.get(String(node.taskId)) ?? null
    if (state !== filters.taskState) return false
  }
  return true
}

function flattenShaped(entry, out = []) {
  out.push(entry)
  for (const child of entry.children) flattenShaped(child, out)
  return out
}

/**
 * Build the supervision hierarchy.
 *
 * @param {object} projection buildProjection() output
 * @param {object|null} view buildBoardView() output (rebuilt with safe defaults when absent)
 * @param {object|null} supervision host supervision payload (contract C), or null
 * @param {object} [options]
 * @param {Function} [options.resolveRole] role resolver (default dabResolveAgentRole)
 * @param {object} [options.filters] agent filters (role / status / taskState)
 * @param {Map|object|null} [options.taskStates] task id -> Task Board state (default: supervision)
 * @param {Set<string>} [options.foldedProjects] project ids folded in the board
 * @param {string|null} [options.mode] host orchestration mode (used when supervision is absent)
 * @param {object} [options.viewOptions] options for buildBoardView when `view` is absent
 * @returns {object}
 */
export function buildHierarchyView(projection, view, supervision, options = {}) {
  const source = projection ?? { nodes: [], byId: new Map(), roots: [], projects: [] }
  const boardView = view ?? buildBoardView(source, options.viewOptions ?? {})
  const filters = normalizeHierarchyFilters(options.filters)
  const taskTitles = options.taskTitles ?? taskTitleIndex(supervision)
  const roles = resolveNodeRoles(source, options.resolveRole, taskTitles ?? null)
  const taskStates = options.taskStates ?? taskStateIndex(supervision)
  const taskStateAvailable = taskStates !== null
  const folded = options.foldedProjects instanceof Set ? options.foldedProjects : new Set()
  const effectiveFilters = { ...filters, taskState: taskStateAvailable ? filters.taskState : null }

  // Real project index (every node), independent from what is displayed.
  const nodesByProject = new Map()
  for (const node of source.nodes) {
    if (!nodesByProject.has(node.projectId)) nodesByProject.set(node.projectId, [])
    nodesByProject.get(node.projectId).push(node)
  }

  const blocks = Array.isArray(supervision?.blocks) ? supervision.blocks.slice(0, 50) : []
  const dependencies = Array.isArray(supervision?.crossProjectDependencies) ? supervision.crossProjectDependencies.slice(0, 100) : []

  const projects = []
  for (const group of boardView.projects) {
    const allNodes = nodesByProject.get(group.id) ?? []
    const counts = countProjectNodes(allNodes)
    const teams = []
    for (const tree of group.trees) {
      const entries = flattenShaped(tree)
      let kept = entries
      let hidden = 0
      const filtering = effectiveFilters.role !== null || effectiveFilters.status !== null || effectiveFilters.taskState !== null
      if (filtering) {
        kept = entries.filter(entry => matchesHierarchyFilters(entry.node, roles, effectiveFilters, taskStates, taskStateAvailable))
        hidden = entries.length - kept.length
        if (kept.length === 0) continue
      }
      teams.push({
        root: tree.node,
        agents: kept.map(entry => entry.node),
        // Renderer input: the shaped entries (depth, hidden children, group
        // state) so the hierarchy can reuse the existing card component.
        entries: kept,
        hidden,
      })
    }
    const orchestrator = findProjectOrchestrator(allNodes, roles)
    projects.push({
      id: group.id,
      title: group.title,
      unassigned: group.id === 'unassigned',
      folded: folded.has(group.id),
      orchestrator,
      teams,
      counts,
      blocks: blocks.filter(block => block.projectId === group.id),
      crossProjectDependencies: dependencies.filter(dependency => (
        dependency.fromProjectId === group.id || dependency.toProjectId === group.id
      )),
      visibleAgents: group.visibleAgents,
    })
  }

  // Real totals: every project of the projection, even when the project filter
  // narrows what is displayed.
  const totals = { agents: 0, running: 0, waiting: 0, unread: 0, failed: 0, interrupted: 0 }
  for (const nodes of nodesByProject.values()) addCounts(totals, countProjectNodes(nodes))
  const realProjectCount = Array.isArray(source.projects)
    ? source.projects.length
    : nodesByProject.size

  const workspaceSupervision = isPlainObject(supervision?.workspace) ? supervision.workspace : null
  const available = isPlainObject(supervision)
  const mode = typeof workspaceSupervision?.mode === 'string'
    ? workspaceSupervision.mode
    : (typeof options.mode === 'string' ? options.mode : null)
  const workspaceStatus = workspaceSupervision?.status === 'active' || workspaceSupervision?.status === 'idle' || workspaceSupervision?.status === 'blocked'
    ? workspaceSupervision.status
    : 'unknown'

  const workspace = {
    id: typeof workspaceSupervision?.id === 'string' ? workspaceSupervision.id : 'workspace:supervision',
    synthetic: true,
    role: WORKSPACE_ROLE_ID,
    emblem: workspaceSupervision?.emblem === 'bolt' ? 'bolt' : 'crown',
    mode,
    status: workspaceStatus,
    statusReason: typeof workspaceSupervision?.reason === 'string'
      ? workspaceSupervision.reason
      : (available ? null : 'supervision_unavailable'),
    // A real agent may be exposed as the workspace agent by the host; a null
    // value means "no declared super-orchestrator agent", never a fake one.
    agent: isPlainObject(workspaceSupervision?.agent) ? workspaceSupervision.agent : null,
    counts: { ...totals, projects: realProjectCount, blocked: blocks.length, dependencies: dependencies.length },
    blocks,
    crossProjectDependencies: dependencies,
    recommendations: Array.isArray(supervision?.recommendations) ? supervision.recommendations.slice(0, 50) : [],
    capabilities: isPlainObject(supervision?.capabilities) ? supervision.capabilities : null,
    // The host's own capability reasons (additive, optional): preferred over a
    // generic translation because they name the REAL missing path.
    capabilityReasons: isPlainObject(supervision?.capabilityReasons) ? supervision.capabilityReasons : null,
    delegation: isPlainObject(workspaceSupervision?.delegation) ? workspaceSupervision.delegation : null,
    taskboard: isPlainObject(supervision?.taskboard) ? supervision.taskboard : null,
    available,
  }

  // Every project that REALLY has a declared (or deduced) orchestrator, even when
  // the current filter or the fold state hides that project. The cockpit band
  // counts and shows these; the view filter must not change the supervision
  // picture.
  const orchestrators = []
  for (const [projectId, projectNodes] of nodesByProject) {
    const orchestrator = findProjectOrchestrator(projectNodes, roles)
    if (orchestrator === null) continue
    orchestrators.push({
      projectId,
      projectTitle: projectNodes[0]?.projectTitle ?? String(projectId),
      unassigned: projectId === 'unassigned',
      orchestrator,
    })
  }
  orchestrators.sort((a, b) => String(a.projectTitle).localeCompare(String(b.projectTitle)))

  return {
    workspace,
    projects,
    projectsById: new Map(projects.map(project => [project.id, project])),
    orchestrators,
    // Per-node resolved role (declared role -> approved role, or generic).
    // Additive to the contract shape so the renderer does not re-resolve it.
    roles,
    totals: {
      ...totals,
      projects: realProjectCount,
      shownProjects: projects.length,
      visibleAgents: projects.reduce((sum, project) => sum + project.teams.reduce((inner, team) => inner + team.agents.length, 0), 0),
      blocked: blocks.length,
      dependencies: dependencies.length,
      supervisionAvailable: available,
      taskStateAvailable,
    },
    filters: {
      view: boardView.filter,
      query: boardView.query,
      role: filters.role,
      status: filters.status,
      taskState: effectiveFilters.taskState,
      taskStateAvailable,
    },
  }
}

/**
 * Narrow the already-shaped board view to entries matching the agent filters.
 * Used by the existing "Projects" view so one toolbar filter is coherent in both
 * views. It only REMOVES entries the user explicitly filtered out: visibility,
 * attention and ordering were already decided by buildBoardView.
 *
 * @param {object} view buildBoardView() output
 * @param {object} filters role/status/taskState filters
 * @param {object} [options] same role/task-state inputs as buildHierarchyView
 * @returns {object} a pruned view (the same object when no filter is active)
 */
export function filterBoardViewByAgent(view, filters, options = {}) {
  const normalized = normalizeHierarchyFilters(filters)
  const taskStates = options.taskStates ?? taskStateIndex(options.supervision ?? null)
  const taskStateAvailable = taskStates !== null
  const effective = { ...normalized, taskState: taskStateAvailable ? normalized.taskState : null }
  if (effective.role === null && effective.status === null && effective.taskState === null) return view
  const roles = options.roles ?? resolveNodeRoles(options.projection ?? { nodes: [] }, options.resolveRole)

  const matches = entry => matchesHierarchyFilters(entry.node, roles, effective, taskStates, taskStateAvailable)
  const prune = entry => {
    const children = entry.children.map(prune).filter(child => child !== null)
    if (!matches(entry) && children.length === 0) return null
    return {
      ...entry,
      children,
      // Direct children hidden from BOTH the original cut and the filter.
      hiddenChildren: Math.max(0, entry.totalChildren - children.length),
      overflow: 0,
    }
  }

  let visibleCount = 0
  const projects = []
  for (const project of view.projects) {
    const trees = project.trees.map(prune).filter(tree => tree !== null)
    if (trees.length === 0) continue
    let projectVisible = 0
    for (const tree of trees) {
      const count = flattenShaped(tree).length
      projectVisible += count
      visibleCount += count
    }
    projects.push({ ...project, trees, visibleAgents: projectVisible })
  }
  return { ...view, projects, visibleCount }
}
