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

/** Operations a work source or forge may implement. */
export const CAPABILITIES = Object.freeze([
  'list',
  'get',
  'subscribe',
  'create',
  'update',
  'comment',
  'transition',
])

export const KINDS = Object.freeze(['work-source', 'forge', 'executor', 'model-router'])

/** One adapter capability probe, safe to call from routes. */
export function capabilitiesOf(adapter) {
  const out = {}
  for (const capability of CAPABILITIES) {
    out[capability] = typeof adapter?.[capability] === 'function'
  }
  return out
}

export class AdapterError extends Error {
  constructor(message, { code = 'adapter_error', cause, retryable = false, adapterId } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AdapterError'
    this.code = code
    this.retryable = retryable
    this.adapterId = adapterId
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
  for (const capability of declared) {
    if (!CAPABILITIES.includes(capability)) throw new Error(`agent-board: adapter ${definition.id} declares unknown capability ${capability}`)
    if (typeof definition[capability] !== 'function') {
      throw new Error(`agent-board: adapter ${definition.id} declares capability "${capability}" without implementing it`)
    }
  }
  const capabilities = capabilitiesOf(definition)
  const effective = []
  for (const capability of CAPABILITIES) {
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
      return [...adapters.values()].map(adapter => ({
        id: adapter.id,
        kind: adapter.kind,
        title: adapter.title ?? adapter.id,
        status: adapter.status,
        validatedLive: adapter.validatedLive,
        capabilities: capabilitiesOf(adapter),
        declaredCapabilities: [...(adapter.capabilities ?? [])],
        notes: adapter.notes ?? '',
      }))
    },
  }
}
