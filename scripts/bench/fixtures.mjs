/**
 * Deterministic synthetic fixtures for the projection benchmark.
 *
 * These are NOT live host snapshots. They are shaped like the DSH 0.2.2-rc.1
 * client `sessions.list` snapshot, `uiSession.sessionStatus` map, board host
 * state and `workspaces.list` snapshot, with a seeded PRNG so every run builds
 * byte-identical inputs.
 *
 * @module dsh-agent-board/scripts/bench/fixtures
 */

export const NOW = 1_800_000_000_000
const HOUR = 3_600_000

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const PROJECT_PATHS = Object.freeze([0, 1, 2, 3].map(index => `D:\\App\\proj-${index}`))

function projectPathOf(index) {
  return PROJECT_PATHS[index % PROJECT_PATHS.length]
}

function workspaceItemsFor(ids, byId) {
  return PROJECT_PATHS.map((path, index) => ({
    workspaceId: `w-${index}`,
    title: `Project ${index}`,
    path,
    sessionIds: ids.filter(id => byId[id].cwd === path),
  }))
}

function baseValues(index) {
  return {
    modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, next: null },
    turnOutline: [{ turn: 1, prompt: 'p', response: `Agent ${index} finished.\nAll checks pass.` }],
    userQuestions: { active: [], settled: [] },
    plan: { active: false, pending: false },
    mobilePushLifecycle: { lastTurnEnd: { turn: 1, reason: 'completed' } },
    sessionStats: { turns: 1, steps: 4, toolMs: 10, llmMs: 20 },
  }
}

const PREVIEW_TEXT = 'Implemented the change, ran the full test suite and verified the result on this machine. '.repeat(2).trim()

/**
 * Apply one of the ten deterministic status shapes to a row.
 * Returns the fixture-level status fact used by the projection.
 *
 * 0,1 running · 2 waiting_user · 3,4 finished_unread · 5 failed
 * 6,7 finished_read · 8 idle · 9 unavailable
 */
function applyStatusShape({ id, index, row, statusMap, turnEnd, acks, previews, assignments }) {
  const kind = index % 10
  const at = NOW - index * 1000
  if (kind === 0 || kind === 1) {
    row.running = true
    statusMap.set(id, { running: true, completionUnread: false })
    previews[id] = { text: 'Working through the next step…', at }
    return 'running'
  }
  if (kind === 2) {
    row.running = true
    row.projectionValues.userQuestions.active = [{ question: 'Which branch should I merge into?' }]
    statusMap.set(id, { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false })
    return 'waiting_user'
  }
  if (kind === 3 || kind === 4) {
    turnEnd[id] = { at, kind: 'completed' }
    statusMap.set(id, { running: false, completionUnread: true })
    previews[id] = { text: PREVIEW_TEXT, at: at - 10 }
    return 'finished_unread'
  }
  if (kind === 5) {
    turnEnd[id] = { at, kind: 'error', error: 'provider 500' }
    statusMap.set(id, { running: false, completionUnread: false })
    previews[id] = { text: PREVIEW_TEXT, at: at - 10 }
    return 'failed'
  }
  if (kind === 6 || kind === 7) {
    turnEnd[id] = { at, kind: 'completed' }
    acks[id] = { seenAt: at + 1 }
    previews[id] = { text: PREVIEW_TEXT, at: at - 10 }
    statusMap.set(id, { running: false, completionUnread: false })
    return 'finished_read'
  }
  if (kind === 9) {
    row.agentAvailable = false
    statusMap.set(id, { running: false, completionUnread: false })
    return 'unavailable'
  }
  statusMap.set(id, { running: false, completionUnread: false })
  if (index % 40 === 0) {
    assignments.push({
      id: `asg-${id}`,
      sessionId: id,
      taskId: `task-${index}`,
      status: 'recovering',
      reason: 'partial_output_handoff:server_error',
      recoveringAt: at,
      routeHistory: [{ from: 'primary/big', to: 'backup/medium', reason: 'switch_after_server_error' }],
    })
    return 'recovering'
  }
  return 'idle'
}

function projectionInputOf(fixture) {
  return {
    list: fixture.list,
    statusMap: fixture.statusMap,
    hostState: fixture.hostState,
    workspaces: fixture.workspaces,
    now: fixture.now,
  }
}

/**
 * `agents` live agents: ~60 % roots, ~40 % sub-agents (some at depth 2), with
 * the full status mix, host turn-end/ack/preview/assignment facts and a
 * sub-agent catalog on every parent.
 */
export function buildLiveScenario(agents, { seed = 0x5eed } = {}) {
  if (!Number.isInteger(agents) || agents < 1) throw new Error('buildLiveScenario: agents must be a positive integer')
  const random = mulberry32(seed + agents * 7919)
  const roots = Math.max(1, Math.round(agents * 0.6))
  const subagentCount = agents - roots
  const byId = {}
  const ids = []
  const statusMap = new Map()
  const turnEnd = {}
  const acks = {}
  const previews = {}
  const assignments = []

  const add = row => {
    byId[row.id] = row
    ids.push(row.id)
  }

  for (let index = 0; index < roots; index += 1) {
    const id = `root-${index}`
    const row = {
      id,
      displayTitle: `Root agent ${index}`,
      running: false,
      blank: false,
      updatedAt: NOW - index * 1000,
      cwd: projectPathOf(index),
      projectionValues: baseValues(index),
    }
    add(row)
    applyStatusShape({ id, index, row, statusMap, turnEnd, acks, previews, assignments })
  }

  for (let offset = 0; offset < subagentCount; offset += 1) {
    const index = roots + offset
    const id = `sub-${offset}`
    // Most sub-agents are direct children; every seventh one is a depth-2
    // child of an earlier sub-agent, so the tree walk is exercised.
    const nested = offset >= roots && offset % 7 === 0
    const parentId = nested ? `sub-${offset - roots}` : `root-${offset % roots}`
    const row = {
      id,
      parentId,
      origin: 'subagent',
      displayTitle: `Sub-agent ${offset}`,
      running: false,
      blank: false,
      updatedAt: NOW - index * 1000,
      cwd: byId[parentId].cwd,
      projectionValues: {
        ...baseValues(index),
        subagent: { label: `Child task ${offset}`, mode: 'continuable' },
      },
    }
    add(row)
    applyStatusShape({ id, index, row, statusMap, turnEnd, acks, previews, assignments })
  }

  // Every parent declares its direct children, like the real subagentCatalog.
  const projectionsBySession = {}
  for (const id of ids) {
    const children = ids.filter(childId => byId[childId].parentId === id)
    if (children.length === 0) continue
    projectionsBySession[id] = {
      values: {
        subagentCatalog: children.map(childId => ({
          id: childId,
          label: byId[childId].projectionValues.subagent?.label ?? byId[childId].displayTitle,
          mode: 'continuable',
        })),
      },
    }
  }

  // A tiny amount of PRNG use keeps the fixture honest about being seeded; it
  // perturbs only timestamps, never statuses.
  for (const id of ids) byId[id].updatedAt += Math.floor(random() * 5)

  return {
    id: `live-${agents}`,
    kind: 'live',
    agents,
    now: NOW,
    list: { phase: 'ready', ids, byId, projectionsBySession },
    statusMap,
    hostState: { turnEnd, acks, previews, assignments },
    workspaces: { items: workspaceItemsFor(ids, byId), archivedSessionIds: [] },
  }
}

/**
 * `history` flat historical sessions: no parents, no running agents, a mix of
 * read results, failures and idle rows. This is the linear-scaling fixture.
 */
export function buildHistoryScenario(history, { seed = 0x4e57 } = {}) {
  if (!Number.isInteger(history) || history < 1) throw new Error('buildHistoryScenario: history must be a positive integer')
  const random = mulberry32(seed + history * 104_729)
  const byId = {}
  const ids = []
  const statusMap = new Map()
  const turnEnd = {}
  const acks = {}
  const previews = {}

  for (let index = 0; index < history; index += 1) {
    const id = `hist-${index}`
    const kind = index % 10
    const row = {
      id,
      displayTitle: kind === 0 ? `CRON-F free periodic ${index}` : `Historical session ${index}`,
      running: false,
      blank: false,
      updatedAt: NOW - (history - index) * 60_000 + Math.floor(random() * 1000),
      cwd: projectPathOf(index),
      projectionValues: baseValues(index),
    }
    byId[id] = row
    ids.push(id)
    const at = NOW - (history - index) * 60_000
    if (kind === 0) {
      turnEnd[id] = { at, kind: 'error', error: 'provider 500' }
      statusMap.set(id, { running: false, completionUnread: false })
      previews[id] = { text: PREVIEW_TEXT, at: at - 10 }
    } else if (kind <= 3) {
      turnEnd[id] = { at, kind: 'completed' }
      acks[id] = { seenAt: at + 1 }
      previews[id] = { text: PREVIEW_TEXT, at: at - 10 }
      statusMap.set(id, { running: false, completionUnread: false })
    } else if (kind === 4) {
      turnEnd[id] = { at, kind: 'completed' }
      statusMap.set(id, { running: false, completionUnread: true })
      previews[id] = { text: PREVIEW_TEXT, at: at - 10 }
    } else {
      statusMap.set(id, { running: false, completionUnread: false })
    }
  }

  return {
    id: `history-${history}`,
    kind: 'history',
    agents: history,
    now: NOW,
    list: { phase: 'ready', ids, byId, projectionsBySession: {} },
    statusMap,
    hostState: { turnEnd, acks, previews, assignments: [] },
    workspaces: { items: workspaceItemsFor(ids, byId), archivedSessionIds: [] },
  }
}

/**
 * `depth` sessions linked as one chain (each a sub-agent of the previous).
 * Used to measure the only super-linear path in buildProjection: the per-node
 * ancestor walk of the cycle guard.
 */
export function buildDeepChainScenario(depth, { seed = 0x0dee9 } = {}) {
  if (!Number.isInteger(depth) || depth < 1) throw new Error('buildDeepChainScenario: depth must be a positive integer')
  const random = mulberry32(seed + depth * 31)
  const byId = {}
  const ids = []
  const statusMap = new Map()
  const turnEnd = {}
  const acks = {}
  const previews = {}
  const cwd = 'D:\\App\\chain'

  for (let index = 0; index < depth; index += 1) {
    const id = `chain-${index}`
    const row = {
      id,
      ...(index === 0 ? {} : { parentId: `chain-${index - 1}`, origin: 'subagent' }),
      displayTitle: `Chain node ${index}`,
      running: index % 7 === 0,
      blank: false,
      updatedAt: NOW - (depth - index) * 1000 + Math.floor(random() * 100),
      cwd,
      projectionValues: {
        ...baseValues(index),
        ...(index === 0 ? {} : { subagent: { label: `Chain child ${index}`, mode: 'continuable' } }),
      },
    }
    byId[id] = row
    ids.push(id)
    statusMap.set(id, { running: row.running, completionUnread: false })
    if (index % 9 === 0) {
      turnEnd[id] = { at: NOW - index * 1000, kind: 'completed' }
      acks[id] = { seenAt: NOW - index * 1000 + 1 }
      previews[id] = { text: PREVIEW_TEXT, at: NOW - index * 1000 - 10 }
    }
  }

  return {
    id: `deep-chain-${depth}`,
    kind: 'deep-chain',
    agents: depth,
    now: NOW,
    list: { phase: 'ready', ids, byId, projectionsBySession: {} },
    statusMap,
    hostState: { turnEnd, acks, previews, assignments: [] },
    workspaces: { items: [{ workspaceId: 'w-chain', title: 'Chain', path: cwd, sessionIds: ids }], archivedSessionIds: [] },
  }
}

/** The exact `buildProjection` argument object for a fixture. */
export function projectionInput(fixture) {
  return projectionInputOf(fixture)
}

/**
 * A trimmed, representative `/state` payload: the per-agent maps the host
 * serves (acks, previews, turnEnd, assignments) plus bounded-empty collections.
 * Proposals/routeEvents/audit are bounded by the host and omitted here.
 */
export function trimmedStatePayload(fixture) {
  return {
    schemaVersion: 1,
    mode: 'supervised',
    stoppedAt: null,
    policy: {},
    acks: fixture.hostState.acks,
    previews: fixture.hostState.previews,
    turnEnd: fixture.hostState.turnEnd,
    proposals: [],
    recentProposals: [],
    assignments: fixture.hostState.assignments,
    routeEvents: [],
    health: {},
    lastTick: null,
    sync: null,
    adapters: { adapters: [], executors: [] },
    audit: [],
    projectionSummary: { total: fixture.list.ids.length },
  }
}

/**
 * Fake Cordis client ctx for the REAL `createBoardStore`: only the services the
 * store reads, with manual notification triggers.
 */
export function createClientCtx(fixture) {
  const listeners = { sessions: new Set(), status: new Set(), workspaces: new Set() }
  const subscribe = bucket => listener => {
    listeners[bucket].add(listener)
    return () => listeners[bucket].delete(listener)
  }
  const sessions = {
    list: {
      getSnapshot: () => fixture.list,
      subscribe: subscribe('sessions'),
    },
  }
  const uiSession = {
    sessionStatus: {
      getSnapshot: () => fixture.statusMap,
      subscribe: subscribe('status'),
    },
  }
  const workspaces = {
    list: {
      getSnapshot: () => fixture.workspaces,
      subscribe: subscribe('workspaces'),
    },
  }
  const notify = bucket => {
    for (const listener of listeners[bucket]) listener()
  }
  return {
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'uiSession') return uiSession
      if (name === 'workspaces') return workspaces
      return undefined
    },
    notifySessions: () => notify('sessions'),
    notifyStatus: () => notify('status'),
    listenerCount: () => listeners.sessions.size + listeners.status.size + listeners.workspaces.size,
  }
}
