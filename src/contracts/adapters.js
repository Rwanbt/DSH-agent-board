/**
 * Adapter contract: work sources (Task Board, GitHub Issues, Jira, Linear…),
 * forges (GitHub, GitLab, Forgejo/Gitea, Bitbucket…) and agent executors
 * (DSH today, then Claude Code / Codex / OpenCode).
 *
 * The contract is capability-based on purpose: no adapter is assumed to offer
 * every operation. `capabilities` is the authoritative feature-flag matrix the
 * UI and the orchestrator read, and `describe()` is what the board reports so
 * nobody can mistake a skeleton for a validated integration.
 *
 * @module dsh-agent-board/contracts/adapters
 */

/** Operations a work source may implement. */
export const WORK_SOURCE_CAPABILITIES = Object.freeze([
  'list',
  'get',
  'subscribe',
  'create',
  'update',
  'comment',
  'transition',
  // Execution request handled by the external system's own executor (the Task
  // Board creates the session/execution/worktree; the board only observes).
  'run',
])

/** Operations a forge may implement. */
export const FORGE_CAPABILITIES = Object.freeze([
  'list',
  'get',
  'subscribe',
  'create',
  'update',
  'comment',
  'transition',
  // CI/check-runs read (a forge-native fact, never a task status).
  'checks',
  // Open a change request. Merging is deliberately NOT a forge capability: it is
  // a separate critical human decision and no adapter may claim it implicitly.
  'open_pr',
])

/**
 * Operations an agent executor may implement. Each entry is a distinct
 * supervision primitive, so an executor can declare exactly the slice it
 * really supports:
 *   - discover:      enumerate known sessions/agents
 *   - observe:       status facts for one session (running/idle/unknown + source)
 *   - getSession:    session metadata (cwd, parent, origin, preset…)
 *   - getChildren:   direct sub-agents of a parent session
 *   - launch:        start a new agent session
 *   - cancel:        stop the current turn/agent
 *   - resume:        rebuild an agent on a persisted session
 *   - openSession:   open the session in the host UI
 *   - readLastOutput: last final output of a session
 *   - getModel:      provider/model selection for a session
 *   - getStatus:     cheap status probe
 *
 * Every capability is named like its implementing method, so registration can
 * refuse a declaration whose method is missing (see defineAdapter).
 */
export const EXECUTOR_CAPABILITIES = Object.freeze([
  'discover',
  'observe',
  'getSession',
  'getChildren',
  'launch',
  'cancel',
  'resume',
  'openSession',
  'readLastOutput',
  'getModel',
  'getStatus',
])

/**
 * The union, kept for callers that probe "does this adapter have any known
 * capability". `CAPABILITIES_BY_KIND` is the authoritative per-kind vocabulary
 * used by registration and by the public matrix.
 */
export const CAPABILITIES = Object.freeze([
  ...new Set([...WORK_SOURCE_CAPABILITIES, ...FORGE_CAPABILITIES, ...EXECUTOR_CAPABILITIES]),
])

export const CAPABILITIES_BY_KIND = Object.freeze({
  'work-source': WORK_SOURCE_CAPABILITIES,
  forge: FORGE_CAPABILITIES,
  executor: EXECUTOR_CAPABILITIES,
  // A model router routes requests; it does not implement work-source, forge or
  // executor operations. Kept explicit so the vocabulary stays closed.
  'model-router': Object.freeze([]),
})

export const KINDS = Object.freeze(['work-source', 'forge', 'executor', 'model-router'])

/**
 * Capability -> implementing method. Most capabilities are named like their
 * method; `run` is an execution request implemented by `runTask`.
 */
export const CAPABILITY_METHODS = Object.freeze({ run: 'runTask' })

export function methodOfCapability(capability) {
  return CAPABILITY_METHODS[capability] ?? capability
}

export function hasCapability(adapter, capability) {
  return typeof adapter?.[methodOfCapability(capability)] === 'function'
}

/**
 * One adapter capability probe, safe to call from routes. With a `kind`, the
 * result is restricted to that kind's vocabulary (what the matrix shows);
 * without it, the union is probed (backward compatible).
 */
export function capabilitiesOf(adapter, kind) {
  const vocabulary = kind === undefined ? CAPABILITIES : (CAPABILITIES_BY_KIND[kind] ?? CAPABILITIES)
  const out = {}
  for (const capability of vocabulary) {
    out[capability] = hasCapability(adapter, capability)
  }
  return out
}

export class AdapterError extends Error {
  constructor(message, { code = 'adapter_error', cause, retryable = false, adapterId, retryAfterMs = null } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AdapterError'
    this.code = code
    this.retryable = retryable
    this.adapterId = adapterId
    // A retryable quota must tell the caller when it may retry.
    this.retryAfterMs = Number.isFinite(Number(retryAfterMs)) ? Number(retryAfterMs) : null
  }
}

/**
 * Validate an adapter declaration. Declaring a capability without the method
 * is a bug we refuse at registration time instead of discovering at runtime.
 */
export function defineAdapter(definition) {
  if (definition === null || typeof definition !== 'object') throw new Error('agent-board: adapter definition must be an object')
  if (typeof definition.id !== 'string' || definition.id === '') throw new Error('agent-board: adapter id is required')
  if (!KINDS.includes(definition.kind)) throw new Error(`agent-board: adapter ${definition.id} has an unknown kind ${String(definition.kind)}`)
  const declared = Array.isArray(definition.capabilities) ? definition.capabilities : []
  const vocabulary = CAPABILITIES_BY_KIND[definition.kind] ?? []
  for (const capability of declared) {
    if (!CAPABILITIES.includes(capability)) throw new Error(`agent-board: adapter ${definition.id} declares unknown capability ${capability}`)
    if (!vocabulary.includes(capability)) {
      throw new Error(`agent-board: adapter ${definition.id} declares capability "${capability}" that is not part of the ${definition.kind} vocabulary`)
    }
    if (!hasCapability(definition, capability)) {
      throw new Error(`agent-board: adapter ${definition.id} declares capability "${capability}" without implementing it`)
    }
  }
  const capabilities = capabilitiesOf(definition, definition.kind)
  const effective = []
  for (const capability of vocabulary) {
    if (declared.includes(capability) && capabilities[capability] === true) effective.push(capability)
  }
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze(effective),
    status: definition.status ?? 'available',
    validatedLive: definition.validatedLive === true,
    notes: definition.notes ?? '',
  })
}

/**
 * A deliberately unavailable adapter: it exists so the board can report the
 * truth ("integration not implemented / not validated live") instead of
 * pretending every forge works.
 */
export function createSkeletonAdapter({ id, kind, title, reason, validatedLive = false }) {
  const adapter = defineAdapter({
    id,
    kind,
    title,
    capabilities: [],
    status: 'unavailable',
    validatedLive,
    notes: reason,
    describe() {
      return { id, kind, title, capabilities: [], status: 'unavailable', validatedLive, notes: reason }
    },
  })
  const fail = async () => {
    throw new AdapterError(`${id}: ${reason}`, { code: 'not_implemented', adapterId: id })
  }
  return Object.freeze({ ...adapter, list: fail, get: fail })
}

/** Registry of adapters, keyed by id. Re-registration replaces. */
export function createAdapterRegistry() {
  const adapters = new Map()
  return {
    register(definition) {
      const adapter = defineAdapter(definition)
      adapters.set(adapter.id, adapter)
      return () => {
        if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id)
      }
    },
    get(id) {
      return adapters.get(id)
    },
    has(id) {
      return adapters.has(id)
    },
    list() {
      return [...adapters.values()]
    },
    /** The public, serializable capability matrix. */
    describe() {
      return [...adapters.values()].map(adapter => {
        const vocabulary = CAPABILITIES_BY_KIND[adapter.kind] ?? CAPABILITIES
        return {
          id: adapter.id,
          kind: adapter.kind,
          title: adapter.title ?? adapter.id,
          status: adapter.status,
          validatedLive: adapter.validatedLive,
          // Report the DECLARED (and therefore effective) capabilities, not "does
          // a method exist": a skeleton carries throwing stubs and must not look
          // like a working integration in the matrix. Only the adapter's own
          // kind vocabulary is reported, so an executor row never grows
          // work-source columns (and vice versa).
          capabilities: Object.fromEntries(vocabulary.map(capability => [capability, (adapter.capabilities ?? []).includes(capability)])),
          declaredCapabilities: [...(adapter.capabilities ?? [])],
          notes: adapter.notes ?? '',
        }
      })
    },
  }
}
