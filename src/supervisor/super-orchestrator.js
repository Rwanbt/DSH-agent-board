/**
 * Super Orchestrator supervision projection (pure).
 *
 * This module turns the facts the host already owns into the supervision
 * payload the panel renders. It is PURE: no `node:` API, no `ctx`, no I/O, no
 * timer. It is also concatenated into the browser bundle, so it only depends on
 * names defined by `contracts/model.js` and `contracts/agent-roles.js` (both
 * earlier in the build order) — nothing from the host.
 *
 * Honesty rules (the reason this module exists):
 *   - the workspace node is a synthetic supervision LAYER (policy engine), NOT
 *     an AI agent: `synthetic:true`, `role:'super_orchestrator'`. A real agent
 *     whose DECLARED role resolves to `super_orchestrator` may be exposed as
 *     `workspace.agent`; otherwise it is `null` (never fabricated);
 *   - a project orchestrator is only an agent whose declared role resolves to
 *     `orchestrator`; otherwise `null` (a visible gap, not a fake node);
 *   - the workspace status comes from real facts only: mode `off` => `idle`
 *     (observing, never `active`), Stop or a secondary instance => `blocked`,
 *     otherwise `active`. No invented runtime state;
 *   - blocks come from real facts only (failed/interrupted agents, provider
 *     cooldown, Task Board blocked tasks, unsatisfied cross-project
 *     prerequisites) and every block carries its `source` and `at`;
 *   - recommendations are LOCAL PROPOSALS: `status:'proposed'`, `applies:false`.
 *     This module never writes the Task Board;
 *   - a capability that does not exist is reported `unavailable` / `proposal_only`
 *     with a reason, never simulated.
 *
 * @module dsh-agent-board/supervisor/super-orchestrator
 */

import { DEFAULT_POLICY, STATUS, normalizeSupervision } from '../contracts/model.js'
import { dabResolveAgentRole } from '../contracts/agent-roles.js'

/** Shape version of the supervision payload. */
export const SUPERVISION_VERSION = 1
/** Synthetic workspace id: the host supervision layer, not an agent. */
export const SUPERVISION_WORKSPACE_ID = 'workspace:supervision'
/** Bounded published event history (newest kept). */
export const MAX_SUPERVISION_EVENTS = 50
/** Bounds so one large ledger cannot inflate the SSE/HTTP frame. */
export const MAX_SUPERVISION_BLOCKS = 100
export const MAX_SUPERVISION_RECOMMENDATIONS = 50
export const MAX_SUPERVISION_TASKS = 200
export const MAX_SUPERVISION_DEPENDENCIES = 100

const SUPERVISION_HOUR_MS = 3_600_000
const SUPERVISION_ACTIVE_ASSIGNMENT_STATUSES = Object.freeze(['starting', 'running', 'recovering'])
const SUPERVISION_BLOCKING_AGENT_STATUSES = Object.freeze([STATUS.FAILED, STATUS.INTERRUPTED, STATUS.PROVIDER_UNAVAILABLE])
const SUPERVISION_RECOMMENDATION_KIND_ORDER = Object.freeze({ delegate: 0, unblock: 1, priority: 2, reassign: 3 })
/** The Task Board workflow state that satisfies a prerequisite (human-confirmed). */
const SUPERVISION_DONE_TASK_STATUS = 'done'

/**
 * Build the supervision payload for one host state.
 *
 * @param {object} input
 * @param {object|null} input.projection  `buildProjection()` output (real agent nodes)
 * @param {object|null} input.hostState   durable host facts (mode, policy, assignments, proposals…)
 * @param {object|null} [input.taskboard] Task Board coordination read model (contract D) or null
 * @param {number} [input.now]
 * @returns {object} the supervision payload (plain JSON)
 */
export function buildSupervision(input = {}) {
  const source = supervisionIsPlainObject(input) ? input : {}
  const now = Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now()
  const hostState = supervisionIsPlainObject(source.hostState) ? source.hostState : {}
  const policy = supervisionIsPlainObject(hostState.policy) ? hostState.policy : {}
  const config = normalizeSupervision(policy.supervision ?? {}, DEFAULT_POLICY.supervision)
  const nodes = Array.isArray(source.projection?.nodes) ? source.projection.nodes.filter(node => supervisionIsPlainObject(node)) : []
  const assignments = Array.isArray(hostState.assignments) ? hostState.assignments.filter(entry => supervisionIsPlainObject(entry)) : []
  const proposals = Array.isArray(hostState.proposals) ? hostState.proposals.filter(entry => supervisionIsPlainObject(entry)) : []
  const taskboard = supervisionNormalizeTaskboard(source.taskboard)
  const mode = typeof hostState.mode === 'string' ? hostState.mode : null

  const assignmentsById = new Map()
  for (const assignment of assignments) {
    if (typeof assignment.id === 'string' && assignment.id !== '') assignmentsById.set(assignment.id, assignment)
  }

  const roleCache = new Map()
  const roleOf = node => {
    const declared = typeof node.role === 'string' && node.role !== '' ? node.role : null
    if (roleCache.has(declared)) return roleCache.get(declared)
    const resolved = declared === null ? { roleId: null, source: 'generic', raw: null } : dabResolveAgentRole(declared)
    const value = {
      roleId: typeof resolved?.roleId === 'string' && resolved.roleId !== '' ? resolved.roleId : null,
      source: resolved?.source === 'explicit' || resolved?.source === 'alias' ? resolved.source : 'generic',
      raw: typeof resolved?.raw === 'string' ? resolved.raw : declared,
      label: typeof resolved?.role?.label === 'string' ? resolved.role.label : null,
    }
    roleCache.set(declared, value)
    return value
  }

  const agents = nodes.map(node => supervisionAgentOf(node, assignmentsById, roleOf))
  const agentsById = new Map(agents.map(agent => [agent.id, agent]))

  const crossProjectDependencies = supervisionBuildCrossProjectDependencies({
    tasks: taskboard.tasks,
    dependencies: taskboard.dependencies,
    now,
  })
  const blocks = supervisionBuildBlocks({ agents, taskboard, crossProjectDependencies, now })

  const delegation = {
    depthLimit: config.maxDelegationDepth,
    concurrentLimit: config.maxConcurrentDelegations,
    hourlyLimit: config.maxDelegationsPerHour,
    allowCrossProjectDelegation: config.allowCrossProjectDelegation,
    usedThisHour: supervisionLaunchesWithinHour(assignments, now),
    // Board-launched assignments in flight: the durable assignment facts, not a
    // projection count (a launch that has no observable node yet still counts).
    inFlight: assignments.filter(assignment => SUPERVISION_ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status)).length,
  }

  const workspaceStatus = supervisionStatusOf({ mode, stoppedAt: hostState.stoppedAt, instance: hostState.instance, enabled: config.enabled })

  const projects = supervisionBuildProjects({
    nodes,
    agents,
    agentsById,
    blocks,
    crossProjectDependencies,
    roleOf,
  })

  const capabilities = supervisionCapabilities({ config, taskboard })
  const recommendations = config.enabled === true && taskboard.available === true
    ? supervisionBuildRecommendations({
      tasks: taskboard.tasks,
      assignments,
      proposals,
      policy,
      config,
      inFlight: delegation.inFlight,
      usedThisHour: delegation.usedThisHour,
      now,
    })
    : []

  const counts = {
    projects: projects.length,
    agents: agents.length,
    running: agents.filter(agent => agent.status === STATUS.RUNNING).length,
    waiting: agents.filter(agent => agent.status === STATUS.WAITING_USER).length,
    unread: agents.filter(agent => agent.status === STATUS.FINISHED_UNREAD).length,
    failed: agents.filter(agent => agent.status === STATUS.FAILED).length,
    interrupted: agents.filter(agent => agent.status === STATUS.INTERRUPTED).length,
    blocked: blocks.length,
  }

  return {
    version: SUPERVISION_VERSION,
    at: now,
    workspace: {
      id: SUPERVISION_WORKSPACE_ID,
      // A supervision LAYER, explicitly labelled: not an AI agent.
      synthetic: true,
      role: 'super_orchestrator',
      emblem: config.emblem,
      mode,
      status: workspaceStatus.status,
      reason: workspaceStatus.reason,
      // A real agent may carry that role; the layer never invents one.
      agent: supervisionWorkspaceAgentOf(agents, roleOf, nodes),
      counts,
      delegation,
    },
    projects,
    blocks,
    crossProjectDependencies,
    recommendations,
    capabilities: capabilities.values,
    capabilityReasons: capabilities.reasons,
    limits: {
      enabled: config.enabled,
      depthLimit: config.maxDelegationDepth,
      concurrentLimit: config.maxConcurrentDelegations,
      hourlyLimit: config.maxDelegationsPerHour,
      allowCrossProjectDelegation: config.allowCrossProjectDelegation,
      bounded: {
        events: MAX_SUPERVISION_EVENTS,
        blocks: MAX_SUPERVISION_BLOCKS,
        recommendations: MAX_SUPERVISION_RECOMMENDATIONS,
        tasks: MAX_SUPERVISION_TASKS,
        crossProjectDependencies: MAX_SUPERVISION_DEPENDENCIES,
      },
    },
    taskboard,
  }
}

/**
 * Diff two supervision payloads into REAL transition events only.
 *
 * Rules:
 *   - an entity absent from the previous payload establishes the baseline: no
 *     event is emitted for merely being observed for the first time (that would
 *     fabricate an `agent.started` after a projection gap);
 *   - every event is a real diff of a durable/observed field;
 *   - stable id `${type}|${entityId}|${at}`: the same fact always yields the same
 *     id, so consumers may de-duplicate and tolerate order;
 *   - bounded to the newest {@link MAX_SUPERVISION_EVENTS}.
 *
 * Types: `agent.status.changed`, `agent.started`, `agent.task.assigned`,
 * `agent.blocked`, `agent.delegated`, `agent.task.completed`,
 * `project.status.changed`, `task.status.changed`, `task.assignee.changed`.
 *
 * @param {object|null} previous previous buildSupervision() payload
 * @param {object|null} next     new buildSupervision() payload
 * @param {number} [at]          transition timestamp (epoch ms)
 * @returns {object[]} bounded events
 */
export function supervisionEvents(previous, next, at = Date.now()) {
  if (!supervisionIsPlainObject(previous) || !supervisionIsPlainObject(next)) return []
  const time = Number.isFinite(Number(at)) ? Number(at) : Date.now()
  const out = []
  const beforeAgents = supervisionAgentIndex(previous)
  const afterAgents = supervisionAgentIndex(next)
  for (const id of [...afterAgents.keys()].sort()) {
    const before = beforeAgents.get(id)
    const current = afterAgents.get(id)
    if (before === undefined || current === undefined) continue
    if (before.status !== current.status) {
      out.push(supervisionEventOf('agent.status.changed', id, time, {
        from: before.status ?? null,
        to: current.status ?? null,
        reason: current.statusReason ?? null,
      }))
      if (current.status === STATUS.RUNNING && before.status !== STATUS.RUNNING) {
        out.push(supervisionEventOf('agent.started', id, time, { taskId: current.taskId ?? null, assignmentId: current.assignmentId ?? null }))
      }
      if (SUPERVISION_BLOCKING_AGENT_STATUSES.includes(current.status) && !SUPERVISION_BLOCKING_AGENT_STATUSES.includes(before.status)) {
        out.push(supervisionEventOf('agent.blocked', id, time, { status: current.status, reason: current.statusReason ?? null }))
      }
    }
    if ((before.taskId ?? null) !== (current.taskId ?? null) && (current.taskId ?? null) !== null) {
      out.push(supervisionEventOf('agent.task.assigned', id, time, { from: before.taskId ?? null, to: current.taskId }))
    }
    if (before.assignmentStatus !== 'done' && current.assignmentStatus === 'done') {
      out.push(supervisionEventOf('agent.task.completed', id, time, { taskId: current.taskId ?? null, assignmentId: current.assignmentId ?? null }))
    }
    if ((before.assignmentId ?? null) !== (current.assignmentId ?? null)
      && (current.assignmentId ?? null) !== null
      && current.delegation !== null && current.delegation !== undefined
      // A handoff CONTINUES a delegation (same depth, `requestedBy` handoff): it
      // is not a new delegation and must not be reported as one.
      && current.delegation.requestedBy !== 'board:handoff'
      && current.delegation.depth > (before.delegation?.depth ?? -1)) {
      out.push(supervisionEventOf('agent.delegated', id, time, {
        assignmentId: current.assignmentId,
        taskId: current.taskId ?? null,
        depth: current.delegation.depth,
        rootTaskId: current.delegation.rootTaskId ?? null,
      }))
    }
  }

  const beforeProjects = supervisionProjectIndex(previous)
  const afterProjects = supervisionProjectIndex(next)
  for (const id of [...afterProjects.keys()].sort()) {
    const before = beforeProjects.get(id)
    const current = afterProjects.get(id)
    if (before === undefined || current === undefined) continue
    if (before.status !== current.status) {
      out.push(supervisionEventOf('project.status.changed', id, time, {
        from: before.status ?? null,
        to: current.status ?? null,
        reason: current.reason ?? null,
      }))
    }
  }

  const beforeTasks = supervisionTaskIndex(previous)
  const afterTasks = supervisionTaskIndex(next)
  for (const id of [...afterTasks.keys()].sort()) {
    const before = beforeTasks.get(id)
    const current = afterTasks.get(id)
    if (before === undefined || current === undefined) continue
    if (before.status !== current.status) {
      out.push(supervisionEventOf('task.status.changed', id, time, { from: before.status ?? null, to: current.status ?? null }))
    }
    if ((before.assignee ?? null) !== (current.assignee ?? null)) {
      out.push(supervisionEventOf('task.assignee.changed', id, time, { from: before.assignee ?? null, to: current.assignee ?? null }))
    }
  }

  return out.slice(-MAX_SUPERVISION_EVENTS)
}

/**
 * Merge a new event batch into the published history.
 *
 * De-duplicates by the stable id (the FIRST occurrence is kept, so the order in
 * which facts were observed never changes an id's position) and keeps the
 * newest `limit` events.
 *
 * @param {object[]} existing
 * @param {object[]} incoming
 * @param {number} [limit]
 * @returns {object[]}
 */
export function mergeSupervisionEvents(existing, incoming, limit = MAX_SUPERVISION_EVENTS) {
  const bound = Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : MAX_SUPERVISION_EVENTS)
  const out = []
  const seen = new Set()
  for (const event of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!supervisionIsPlainObject(event) || typeof event.id !== 'string' || seen.has(event.id)) continue
    seen.add(event.id)
    out.push(event)
  }
  return out.length > bound ? out.slice(-bound) : out
}

// --------------------------------------------------------------- internals

function supervisionIsPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function supervisionEventOf(type, entityId, at, detail = {}) {
  return { id: `${type}|${entityId}|${at}`, type, entityId, at, ...detail }
}

/** Compact agent facts, derived only from the projection node (+ its assignment). */
function supervisionAgentOf(node, assignmentsById, roleOf) {
  const assignment = typeof node.assignmentId === 'string' ? assignmentsById.get(node.assignmentId) ?? null : null
  const role = roleOf(node)
  const delegation = supervisionDelegationOf(assignment)
  return {
    id: String(node.id),
    name: typeof node.title === 'string' && node.title !== '' ? node.title : String(node.id),
    role: role.roleId,
    roleLabel: role.label,
    declaredRole: role.raw,
    roleSource: role.source,
    status: typeof node.status === 'string' ? node.status : STATUS.UNKNOWN,
    statusReason: typeof node.statusReason === 'string' ? node.statusReason : null,
    statusSource: typeof node.statusSource === 'string' ? node.statusSource : null,
    statusAt: Number.isFinite(Number(node.statusAt)) ? Number(node.statusAt) : null,
    projectId: typeof node.projectId === 'string' ? node.projectId : 'unassigned',
    projectTitle: typeof node.projectTitle === 'string' ? node.projectTitle : null,
    parentId: typeof node.parentId === 'string' ? node.parentId : null,
    taskId: typeof node.taskId === 'string' ? node.taskId : null,
    assignmentId: typeof node.assignmentId === 'string' ? node.assignmentId : null,
    assignmentStatus: typeof node.assignmentStatus === 'string'
      ? node.assignmentStatus
      : (typeof assignment?.status === 'string' ? assignment.status : null),
    delegation,
    healthUntil: Number.isFinite(Number(node.healthUntil)) ? Number(node.healthUntil) : null,
    updatedAt: Number.isFinite(Number(node.updatedAt)) ? Number(node.updatedAt) : null,
  }
}

/** The recorded delegation facts, or null. Never inferred. */
function supervisionDelegationOf(assignment) {
  const delegation = assignment?.delegation
  if (!supervisionIsPlainObject(delegation)) return null
  const depth = Number(delegation.depth)
  if (!Number.isFinite(depth) || depth < 0) return null
  return {
    depth: Math.trunc(depth),
    rootTaskId: typeof delegation.rootTaskId === 'string' ? delegation.rootTaskId : null,
    parentAssignmentId: typeof delegation.parentAssignmentId === 'string' ? delegation.parentAssignmentId : null,
    projectId: typeof delegation.projectId === 'string' ? delegation.projectId : null,
    requestedBy: typeof delegation.requestedBy === 'string' ? delegation.requestedBy : null,
  }
}

/** The declared super-orchestrator agent, or null (never a fabricated node). */
function supervisionWorkspaceAgentOf(agents, roleOf, nodes) {
  const nodeById = new Map(nodes.map(node => [String(node.id), node]))
  const candidates = agents.filter(agent => agent.role === 'super_orchestrator')
  if (candidates.length === 0) return null
  const ranked = candidates.map(agent => {
    const node = nodeById.get(agent.id)
    const root = node !== undefined && (node.parentId === null || node.parentId === undefined || node.orphan === true || node.parentCycle === true)
    return { agent, key: [root ? 0 : 1, -(Number(node?.updatedAt) || 0), agent.id] }
  })
  ranked.sort((left, right) => supervisionCompareKeys(left.key, right.key))
  const best = ranked[0].agent
  return {
    id: best.id,
    name: best.name,
    role: 'super_orchestrator',
    declaredRole: best.declaredRole,
    status: best.status,
    projectId: best.projectId,
    statusReason: best.statusReason,
  }
}

function supervisionCompareKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

/** Workspace status from real facts only. */
function supervisionStatusOf({ mode, stoppedAt, instance, enabled }) {
  if (supervisionIsPlainObject(instance) && instance.primary === false) {
    return { status: 'blocked', reason: 'secondary_instance' }
  }
  if (stoppedAt !== null && stoppedAt !== undefined) {
    return { status: 'blocked', reason: 'stopped_by_operator' }
  }
  if (mode === 'off') {
    // Mode off means OBSERVING: the layer is never reported active.
    return { status: 'idle', reason: 'mode_off' }
  }
  if (enabled !== true) return { status: 'idle', reason: 'supervision_disabled' }
  return { status: 'active', reason: 'supervision_active' }
}

function supervisionBuildProjects({ nodes, agents, agentsById, blocks, crossProjectDependencies, roleOf }) {
  const byProject = new Map()
  for (const node of nodes) {
    const id = typeof node.projectId === 'string' ? node.projectId : 'unassigned'
    if (!byProject.has(id)) {
      byProject.set(id, {
        id,
        title: typeof node.projectTitle === 'string' && node.projectTitle !== '' ? node.projectTitle : id,
        nodes: [],
      })
    }
    byProject.get(id).nodes.push(node)
  }
  const projects = []
  for (const group of [...byProject.values()].sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))) {
    const projectAgents = group.nodes.map(node => agentsById.get(String(node.id))).filter(agent => agent !== undefined)
    const projectBlocks = blocks.filter(block => block.projectId === group.id)
    const counts = {
      agents: projectAgents.length,
      running: projectAgents.filter(agent => agent.status === STATUS.RUNNING).length,
      waiting: projectAgents.filter(agent => agent.status === STATUS.WAITING_USER).length,
      unread: projectAgents.filter(agent => agent.status === STATUS.FINISHED_UNREAD).length,
      failed: projectAgents.filter(agent => agent.status === STATUS.FAILED).length,
      interrupted: projectAgents.filter(agent => agent.status === STATUS.INTERRUPTED).length,
      blocked: projectBlocks.length,
    }
    // Project status is a derived label over real counts/blocks, with a reason.
    const status = projectBlocks.length > 0
      ? 'blocked'
      : (counts.running > 0 ? 'active' : 'idle')
    const reason = projectBlocks.length > 0
      ? `blocked:${projectBlocks[0].kind}`
      : (counts.running > 0 ? 'agents_running' : 'no_active_agent')
    projects.push({
      id: group.id,
      title: group.title,
      status,
      reason,
      orchestrator: supervisionProjectOrchestratorOf(group.nodes, roleOf),
      agents: projectAgents,
      counts,
      blocks: projectBlocks,
      crossProjectDependencies: crossProjectDependencies.filter(dependency => (
        dependency.fromProjectId === group.id || dependency.toProjectId === group.id
      )),
    })
  }
  return projects
}

/** The project orchestrator: only a DECLARED `orchestrator`, deterministic. */
function supervisionProjectOrchestratorOf(nodes, roleOf) {
  const candidates = nodes
    .filter(node => roleOf(node).roleId === 'orchestrator')
    .map(node => {
      const root = node.parentId === null || node.parentId === undefined || node.orphan === true || node.parentCycle === true
      return { node, key: [root ? 0 : 1, -(Number(node.updatedAt) || 0), String(node.id)] }
    })
    .sort((left, right) => supervisionCompareKeys(left.key, right.key))
  if (candidates.length === 0) return null
  const best = candidates[0].node
  return {
    id: String(best.id),
    name: typeof best.title === 'string' && best.title !== '' ? best.title : String(best.id),
    role: 'orchestrator',
    declaredRole: typeof best.role === 'string' ? best.role : null,
    status: typeof best.status === 'string' ? best.status : STATUS.UNKNOWN,
    projectId: typeof best.projectId === 'string' ? best.projectId : 'unassigned',
  }
}

/**
 * Blocks from real facts only. Every entry names its source and timestamp:
 *   `agent_failed`, `agent_interrupted`, `provider_cooldown`, `task_blocked`,
 *   `cross_project_prerequisite`.
 */
function supervisionBuildBlocks({ agents, taskboard, crossProjectDependencies, now }) {
  const blocks = []
  for (const agent of agents) {
    if (agent.status === STATUS.FAILED) {
      blocks.push({
        id: `agent_failed|${agent.projectId}|${agent.id}`,
        kind: 'agent_failed',
        projectId: agent.projectId,
        agentId: agent.id,
        reason: agent.statusReason ?? 'agent_failed',
        at: agent.statusAt ?? now,
        source: agent.statusSource ?? 'projection',
      })
    } else if (agent.status === STATUS.INTERRUPTED) {
      blocks.push({
        id: `agent_interrupted|${agent.projectId}|${agent.id}`,
        kind: 'agent_interrupted',
        projectId: agent.projectId,
        agentId: agent.id,
        reason: agent.statusReason ?? 'agent_interrupted',
        at: agent.statusAt ?? now,
        source: agent.statusSource ?? 'assignment',
      })
    } else if (agent.status === STATUS.PROVIDER_UNAVAILABLE) {
      blocks.push({
        id: `provider_cooldown|${agent.projectId}|${agent.id}`,
        kind: 'provider_cooldown',
        projectId: agent.projectId,
        agentId: agent.id,
        reason: agent.statusReason ?? 'provider_unavailable',
        at: agent.statusAt ?? now,
        source: 'host_health',
        until: agent.healthUntil,
      })
    }
  }
  for (const task of taskboard.tasks) {
    const projectId = supervisionProjectIdOf(task)
    if (task.status === 'blocked' || task.blocked === true) {
      blocks.push({
        id: `task_blocked|${projectId}|${task.id}`,
        kind: 'task_blocked',
        projectId,
        taskId: task.id,
        reason: 'task_board_blocked',
        at: task.updatedAt ?? now,
        source: 'taskboard',
      })
    }
  }
  for (const dependency of crossProjectDependencies) {
    if (dependency.satisfied === true) continue
    const task = taskboard.tasks.find(entry => entry.id === dependency.fromTaskId)
    if (task === undefined || supervisionTaskStatusOf(task) === SUPERVISION_DONE_TASK_STATUS) continue
    blocks.push({
      id: `cross_project_prerequisite|${dependency.fromTaskId}|${dependency.toTaskId}`,
      kind: 'cross_project_prerequisite',
      projectId: dependency.fromProjectId,
      taskId: dependency.fromTaskId,
      blockedByTaskId: dependency.toTaskId,
      reason: `cross_project_prerequisite_pending:${dependency.toTaskId}`,
      at: dependency.at,
      source: 'taskboard',
    })
  }
  const unique = new Map()
  for (const block of blocks) unique.set(block.id, block)
  return [...unique.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_SUPERVISION_BLOCKS)
}

/** Cross-project `dependsOn` edges: `from` depends on `to` (real Task Board data). */
function supervisionBuildCrossProjectDependencies({ tasks, dependencies, now }) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const out = []
  // The Task Board read model (contract D) already resolves the cross-project
  // flag; when it supplies the edges, use ITS verdict instead of re-deriving it.
  const declaredEdges = Array.isArray(dependencies)
    ? dependencies.filter(edge => supervisionIsPlainObject(edge) && edge.crossProject === true)
    : null
  if (declaredEdges !== null) {
    for (const edge of declaredEdges) {
      const task = byId.get(edge.taskId)
      const dependency = byId.get(edge.dependsOnTaskId)
      if (task === undefined || dependency === undefined) continue
      out.push(supervisionDependencyEdgeOf(task, dependency, now))
    }
  } else {
    for (const task of tasks) {
      for (const dependencyId of task.dependsOn) {
        const dependency = byId.get(dependencyId)
        if (dependency === undefined) continue
        if (!supervisionProjectsDiffer(task, dependency)) continue
        out.push(supervisionDependencyEdgeOf(task, dependency, now))
      }
    }
  }
  const unique = new Map()
  for (const dependency of out) unique.set(dependency.id, dependency)
  return [...unique.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_SUPERVISION_DEPENDENCIES)
}

function supervisionDependencyEdgeOf(task, dependency, now) {
  return {
    id: `taskboard|${task.id}|${dependency.id}`,
    fromTaskId: task.id,
    fromProjectId: supervisionProjectIdOf(task),
    toTaskId: dependency.id,
    toProjectId: supervisionProjectIdOf(dependency),
    source: 'taskboard',
    satisfied: supervisionTaskStatusOf(dependency) === SUPERVISION_DONE_TASK_STATUS,
    at: Math.max(Number(task.updatedAt) || 0, Number(dependency.updatedAt) || 0) || now,
  }
}

function supervisionProjectIdOf(task) {
  if (typeof task?.projectId === 'string' && task.projectId !== '') return task.projectId
  if (typeof task?.workspaceId === 'string' && task.workspaceId !== '') return task.workspaceId
  return 'unknown'
}

function supervisionProjectsDiffer(left, right) {
  const leftProject = typeof left?.projectId === 'string' && left.projectId !== '' ? left.projectId : null
  const rightProject = typeof right?.projectId === 'string' && right.projectId !== '' ? right.projectId : null
  if (leftProject !== null && rightProject !== null) return leftProject !== rightProject
  const leftWorkspace = typeof left?.workspaceId === 'string' ? left.workspaceId : ''
  const rightWorkspace = typeof right?.workspaceId === 'string' ? right.workspaceId : ''
  if (leftWorkspace !== '' && rightWorkspace !== '') return leftWorkspace !== rightWorkspace
  return false
}

function supervisionTaskStatusOf(task) {
  if (task?.trashedAt !== undefined && task?.trashedAt !== null) return 'trashed'
  return typeof task?.status === 'string' ? task.status : 'unknown'
}

function supervisionDependenciesOf(task) {
  return Array.isArray(task?.dependsOn) ? task.dependsOn.map(String) : []
}

/**
 * Readiness, mirroring `orchestrator/dag.js#readinessOf` (which is not part of
 * the browser bundle). A test pins both implementations against the same
 * fixtures; the rule is: status `todo` and every prerequisite `done` (never
 * `in_review`).
 */
function supervisionReadinessOf(task, tasksById) {
  const status = supervisionTaskStatusOf(task)
  if (status === 'trashed') return { ready: false, reason: 'trashed' }
  if (status !== 'todo') return { ready: false, reason: `status:${status}` }
  const blockers = []
  const missing = []
  for (const dependencyId of supervisionDependenciesOf(task)) {
    const dependency = tasksById.get(dependencyId)
    if (dependency === undefined) {
      missing.push(dependencyId)
      continue
    }
    if (supervisionTaskStatusOf(dependency) !== SUPERVISION_DONE_TASK_STATUS) blockers.push(dependencyId)
  }
  if (missing.length > 0) return { ready: false, reason: `unknown_prerequisite:${missing.join(',')}` }
  if (blockers.length > 0) return { ready: false, reason: `blocked_by:${blockers.join(',')}` }
  return { ready: true, reason: 'ready' }
}

function supervisionLaunchesWithinHour(assignments, now) {
  const cutoff = now - SUPERVISION_HOUR_MS
  return assignments
    .filter(assignment => assignment?.previousSessionId === null || assignment?.previousSessionId === undefined)
    .map(assignment => Number(assignment?.startedAt))
    .filter(at => Number.isFinite(at) && at > cutoff).length
}

/**
 * Recommendation proposals. Pure and local: `applies:false`, `status:'proposed'`.
 * Nothing here writes the Task Board.
 */
function supervisionBuildRecommendations({ tasks, assignments, proposals, policy, config, inFlight, usedThisHour }) {
  const out = []
  const tasksById = new Map(tasks.map(task => [task.id, task]))
  const activeTaskIds = new Set(assignments
    .filter(assignment => SUPERVISION_ACTIVE_ASSIGNMENT_STATUSES.includes(assignment?.status))
    .map(assignment => String(assignment?.taskId)))
  const pendingProposalTaskIds = new Set(proposals
    .filter(proposal => proposal?.status === 'pending')
    .map(proposal => String(proposal?.taskId)))
  const withinLimits = inFlight < config.maxConcurrentDelegations && usedThisHour < config.maxDelegationsPerHour
  const worktreeCapable = policy?.executionBackend === 'taskboard' || policy?.executionBackend === 'contract'

  const push = (kind, task, reason, evidence) => {
    if (out.length >= MAX_SUPERVISION_RECOMMENDATIONS) return
    const projectId = supervisionProjectIdOf(task)
    out.push({
      id: `proposal|${kind}|${task.id}`,
      kind,
      taskId: task.id,
      projectId,
      reason,
      evidence,
      status: 'proposed',
      // A proposal is NEVER applied by this module: there is no write path.
      applies: false,
    })
  }

  // delegate: a READY task with no assignment, only when the capability is
  // gated (supervision enabled) and inside the delegation limits.
  if (withinLimits) {
    for (const task of tasks) {
      if (supervisionTaskStatusOf(task) !== 'todo') continue
      const readiness = supervisionReadinessOf(task, tasksById)
      if (!readiness.ready) continue
      if (activeTaskIds.has(String(task.id)) || pendingProposalTaskIds.has(String(task.id))) continue
      if (typeof task.assignee === 'string' && task.assignee !== '') continue
      if (task.activeExecution === true) continue
      if (task.execution?.mode === 'scheduled') continue
      if (task.isolation === 'worktree' && !worktreeCapable) continue
      push('delegate', task, 'task_ready_and_unassigned', {
        readiness: readiness.reason,
        status: task.status,
        inFlight,
        usedThisHour,
      })
    }
  }

  // unblock: a blocked card whose prerequisites are all done.
  for (const task of tasks) {
    if (task.status !== 'blocked') continue
    const dependencies = supervisionDependenciesOf(task)
    if (dependencies.length === 0) continue
    const known = dependencies.map(id => tasksById.get(id))
    if (known.some(dependency => dependency === undefined)) continue
    if (!known.every(dependency => supervisionTaskStatusOf(dependency) === SUPERVISION_DONE_TASK_STATUS)) continue
    push('unblock', task, 'prerequisites_done_but_card_blocked', { prerequisites: dependencies })
  }

  // priority: only when the Task Board really exposes priorities, and only for a
  // real project-level contention (two projects blocked on one another).
  const hasPriorities = tasks.some(task => task.priority !== undefined && task.priority !== null && task.priority !== '')
  if (hasPriorities) {
    const edges = new Map()
    for (const task of tasks) {
      for (const dependencyId of task.dependsOn) {
        const dependency = tasksById.get(dependencyId)
        if (dependency === undefined) continue
        if (!supervisionProjectsDiffer(task, dependency)) continue
        if (supervisionTaskStatusOf(task) === SUPERVISION_DONE_TASK_STATUS) continue
        const key = `${supervisionProjectIdOf(task)}>${supervisionProjectIdOf(dependency)}`
        if (!edges.has(key)) edges.set(key, [])
        edges.get(key).push({ task, dependency })
      }
    }
    const emitted = new Set()
    for (const [key, list] of [...edges.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      const [fromProjectId, toProjectId] = key.split('>')
      if (fromProjectId === toProjectId || fromProjectId === 'unknown' || toProjectId === 'unknown') continue
      const reverse = edges.get(`${toProjectId}>${fromProjectId}`)
      if (reverse === undefined) continue
      const pairKey = [fromProjectId, toProjectId].sort().join('<>')
      if (emitted.has(pairKey)) continue
      emitted.add(pairKey)
      const candidates = [...list, ...reverse].sort((left, right) => left.task.id.localeCompare(right.task.id))
      const chosen = candidates[0].task
      push('priority', chosen, 'cross_project_contention', {
        projects: [fromProjectId, toProjectId],
        tasks: candidates.map(entry => entry.task.id).sort(),
        priorities: candidates.map(entry => ({ taskId: entry.task.id, priority: entry.task.priority ?? null })),
      })
    }
  }

  // reassign: only ever a proposal — the Task Board exposes no board-facing
  // write API. The real fact is a finished board delegation whose card is still
  // in progress.
  for (const assignment of assignments) {
    if (!['failed', 'interrupted', 'stopped'].includes(assignment?.status)) continue
    const task = tasksById.get(String(assignment?.taskId))
    if (task === undefined || task.status !== 'in_progress') continue
    push('reassign', task, `assignment_${assignment.status}_without_claim_release`, {
      assignmentId: assignment.id ?? null,
      assignmentStatus: assignment.status,
      assignee: typeof task.assignee === 'string' ? task.assignee : null,
      capability: 'proposal_only',
      writeApi: 'unavailable',
    })
  }

  return out
    .sort((left, right) => (SUPERVISION_RECOMMENDATION_KIND_ORDER[left.kind] ?? 9) - (SUPERVISION_RECOMMENDATION_KIND_ORDER[right.kind] ?? 9)
      || left.taskId.localeCompare(right.taskId))
    .slice(0, MAX_SUPERVISION_RECOMMENDATIONS)
}

/** Explicit capability matrix: implemented / proposal-only / unavailable + why. */
function supervisionCapabilities({ config, taskboard }) {
  const enabled = config.enabled === true
  const hasPriorities = taskboard.available === true
    && taskboard.tasks.some(task => task.priority !== undefined && task.priority !== null && task.priority !== '')
  const priority = hasPriorities ? 'proposal_only' : 'unavailable'
  const priorityReason = hasPriorities
    ? 'taskboard_write_api_unavailable'
    : (taskboard.available === true ? 'taskboard_priorities_unavailable' : 'taskboard_unavailable')
  const values = {
    observe: true,
    recommend: enabled,
    delegate: enabled ? 'gated' : 'unavailable',
    reassign: 'proposal_only',
    priority,
    receiveOrchestratorReports: 'unavailable',
    kanbanWrite: 'unavailable',
  }
  const reasons = {}
  if (!enabled) {
    reasons.delegate = 'supervision_disabled'
    reasons.recommend = 'supervision_disabled'
  }
  reasons.reassign = 'taskboard_write_api_unavailable'
  reasons.priority = priorityReason
  reasons.receiveOrchestratorReports = 'no_inbound_orchestrator_report_channel'
  reasons.kanbanWrite = 'taskboard_write_api_unavailable'
  return { values, reasons }
}

function supervisionNormalizeTaskboard(input) {
  const source = supervisionIsPlainObject(input) ? input : null
  const available = source?.available === true
  const rawTasks = available && Array.isArray(source?.tasks) ? source.tasks : []
  const tasks = []
  for (const raw of rawTasks) {
    if (!supervisionIsPlainObject(raw) || typeof raw.id !== 'string' || raw.id === '') continue
    tasks.push({
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      priority: raw.priority ?? null,
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
      projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      assignee: typeof raw.assignee === 'string'
        ? raw.assignee
        : (typeof raw.claimedBy === 'string' ? raw.claimedBy : null),
      revision: raw.revision ?? raw.version ?? null,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : null,
      blocked: raw.blocked === true,
      execution: supervisionIsPlainObject(raw.execution) ? { mode: raw.execution.mode ?? null } : null,
      activeExecution: raw.activeExecution === true,
      isolation: typeof raw.isolation === 'string' ? raw.isolation : null,
    })
    if (tasks.length >= MAX_SUPERVISION_TASKS) break
  }
  const total = available
    ? (Number.isFinite(Number(source?.count)) ? Number(source.count) : rawTasks.length)
    : 0
  return {
    available,
    reason: available
      ? (typeof source?.reason === 'string' ? source.reason : null)
      : (typeof source?.reason === 'string' && source.reason !== '' ? source.reason : 'taskboard_unavailable'),
    source: source?.source === 'live' || source?.source === 'simulated' ? source.source : (available ? 'live' : 'absent'),
    count: total,
    truncated: total > tasks.length,
    tasks,
    // The adapter's resolved edges (with its own cross-project verdict). Kept as
    // `null` when the source does not supply them so the builder re-derives the
    // edges from the tasks instead of silently reporting none.
    dependencies: available && Array.isArray(source?.dependencies)
      ? source.dependencies
        .filter(edge => supervisionIsPlainObject(edge) && typeof edge.taskId === 'string' && typeof edge.dependsOnTaskId === 'string')
        .slice(0, MAX_SUPERVISION_DEPENDENCIES)
      : null,
    capabilities: supervisionNormalizeTaskboardCapabilities(source?.capabilities),
    notes: typeof source?.notes === 'string' ? source.notes : null,
  }
}

function supervisionNormalizeTaskboardCapabilities(input) {
  const source = supervisionIsPlainObject(input) ? input : {}
  return {
    read: source.read === true,
    proposeReassignment: source.proposeReassignment === true,
    proposePriority: source.proposePriority === true,
    proposeBlocked: source.proposeBlocked === true,
    writeKanban: source.writeKanban === true,
    requestReview: source.requestReview === true,
  }
}

function supervisionAgentIndex(supervision) {
  const index = new Map()
  for (const project of Array.isArray(supervision?.projects) ? supervision.projects : []) {
    for (const agent of Array.isArray(project?.agents) ? project.agents : []) {
      if (supervisionIsPlainObject(agent) && typeof agent.id === 'string') index.set(agent.id, agent)
    }
  }
  return index
}

function supervisionProjectIndex(supervision) {
  const index = new Map()
  for (const project of Array.isArray(supervision?.projects) ? supervision.projects : []) {
    if (supervisionIsPlainObject(project) && typeof project.id === 'string') index.set(project.id, project)
  }
  return index
}

function supervisionTaskIndex(supervision) {
  const index = new Map()
  const tasks = Array.isArray(supervision?.taskboard?.tasks) ? supervision.taskboard.tasks : []
  for (const task of tasks) {
    if (supervisionIsPlainObject(task) && typeof task.id === 'string') index.set(task.id, task)
  }
  return index
}
