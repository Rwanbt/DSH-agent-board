/**
 * DSH executor adapter: the REAL native implementation, built on the host
 * services the board already uses.
 *
 *   ctx.agents.list() / get(id) / create(options)   live agents, status, launch
 *   ctx.sessions.list() / get(id)                   live Session objects + headers
 *   ctx.subagents.listChildren(parentSessionId)     durable direct-child catalog
 *
 * Two honesty rules drive this file:
 *   1. A capability is declared only when the matching service method exists on
 *      the ctx handed to the factory. A headless host without `ctx.subagents`
 *      therefore does not advertise `getChildren`.
 *   2. A status is only reported when the host exposes it. `ctx.agents.get(id)`
 *      returns an Agent whose `status` is `'idle' | 'running'`; a Session with
 *      no live Agent has no status fact, so it is reported as `unknown` with
 *      `statusSource: 'session'`, never as idle/finished.
 *
 * Deliberately NOT declared (and why):
 *   - resume:          this adapter never calls `ctx.agents.resume`.
 *   - openSession:     opening a session in the host UI is a client action; no
 *                      host service is bound here.
 *   - readLastOutput:  no session-output read is used by this build (the board
 *                      keeps previews in its own host state).
 *   - getModel:        `SessionHeader` carries no model. The live Agent exposes
 *                      `agent.model.current()`, but that is a live-agent fact,
 *                      not a session-header fact, so the adapter does not claim
 *                      a per-session model read.
 *
 * @module dsh-agent-board/executors/dsh
 */

import { AdapterError, defineAdapter } from '../contracts/adapters.js'

/** Resolve a Cordis service by property first, then by `ctx.get(name)`. */
function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  const direct = ctx[name]
  if (direct !== undefined) return direct
  if (typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function headerOf(session) {
  const header = session?.header
  return header !== null && typeof header === 'object' ? header : null
}

/** Normalize a live `Session` (dsh-session) to the adapter's session fact. */
function sessionFactOf(session) {
  const header = headerOf(session)
  const sessionId = typeof session?.id === 'string' ? session.id : (typeof header?.id === 'string' ? header.id : '')
  const delegationDepth = Number(header?.delegationDepth)
  return {
    sessionId,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    parentSessionId: typeof header?.parentSession === 'string' ? header.parentSession : null,
    origin: typeof header?.origin === 'string' ? header.origin : null,
    agentPreset: typeof header?.agentPreset === 'string' ? header.agentPreset : null,
    delegationDepth: Number.isFinite(delegationDepth) ? delegationDepth : null,
    createdAt: Number.isFinite(Number(header?.createdAt)) ? Number(header.createdAt) : null,
  }
}

/** `AgentStatus` is exactly `'idle' | 'running'`; anything else is unknown. */
function statusOf(agent) {
  if (agent?.status === 'running') return 'running'
  if (agent?.status === 'idle') return 'idle'
  return 'unknown'
}

/**
 * Build the DSH executor adapter for one host context.
 *
 * @param {object} ctx cordis host context carrying `agents`, `sessions` and
 *   (optionally) `subagents`.
 * @returns {object} a frozen adapter definition
 */
export function createDshExecutor(ctx) {
  const agents = serviceOf(ctx, 'agents')
  const sessions = serviceOf(ctx, 'sessions')
  const subagents = serviceOf(ctx, 'subagents')

  if (agents === undefined && sessions === undefined) {
    throw new AdapterError('dsh executor requires ctx.agents or ctx.sessions', {
      code: 'context_unavailable',
      adapterId: 'dsh',
    })
  }

  const canListAgents = typeof agents?.list === 'function'
  const canListSessions = typeof sessions?.list === 'function'
  const canGetAgent = typeof agents?.get === 'function'
  const canGetSession = typeof sessions?.get === 'function'
  const canCreate = typeof agents?.create === 'function'
  const canListChildren = typeof subagents?.listChildren === 'function'

  const getAgent = id => {
    if (!canGetAgent) return undefined
    try {
      return agents.get(String(id))
    } catch {
      return undefined
    }
  }
  const getSession = id => {
    if (!canGetSession) return undefined
    try {
      return sessions.get(String(id))
    } catch {
      return undefined
    }
  }

  const capabilities = []
  if (canListAgents || canListSessions) capabilities.push('discover')
  if (canGetAgent || canGetSession) capabilities.push('observe', 'getSession', 'getStatus')
  if (canListChildren) capabilities.push('getChildren')
  if (canCreate) capabilities.push('launch')
  if (canGetAgent) capabilities.push('cancel')

  const definition = {
    id: 'dsh',
    kind: 'executor',
    title: 'DeepSeek Harness',
    status: 'available',
    // The host already uses ctx.agents/sessions in its launch path, but this
    // adapter factory is not wired into it yet: unit-tested against a fake ctx,
    // not exercised live as an adapter.
    validatedLive: false,
    notes: 'Native ctx.agents / ctx.sessions / ctx.subagents. A capability is declared only when the matching service method exists on the given ctx (getChildren requires ctx.subagents.listChildren). Not declared: resume (ctx.agents.resume is not called), openSession (no host open-in-UI service), readLastOutput (no session-output read), getModel (SessionHeader has no model). Not yet wired into the host launch path, so validatedLive is false.',
    capabilities,
  }

  if (capabilities.includes('discover')) {
    definition.discover = async () => {
      const byId = new Map()
      if (canListSessions) {
        for (const session of sessions.list()) {
          const fact = sessionFactOf(session)
          if (fact.sessionId === '') continue
          byId.set(fact.sessionId, { ...fact, status: 'unknown', running: null, agentAvailable: false, statusSource: 'session' })
        }
      }
      if (canListAgents) {
        for (const agent of agents.list()) {
          const id = String(agent?.id ?? '')
          if (id === '') continue
          const base = byId.get(id) ?? sessionFactOf(agent?.session)
          const status = statusOf(agent)
          byId.set(id, {
            ...base,
            sessionId: id,
            status,
            running: status === 'running',
            agentAvailable: true,
            statusSource: 'agent',
          })
        }
      }
      return { items: [...byId.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)) }
    }
  }

  if (capabilities.includes('observe')) {
    definition.observe = async sessionId => {
      const id = String(sessionId)
      const agent = getAgent(id)
      const session = getSession(id)
      const observedAt = Date.now()
      if (agent !== undefined) {
        const status = statusOf(agent)
        return {
          sessionId: id,
          status,
          running: status === 'running',
          available: true,
          agentAvailable: true,
          statusSource: 'agent',
          observedAt,
          session: session === undefined ? null : sessionFactOf(session),
        }
      }
      if (session !== undefined) {
        // A live Session without a live Agent has no status fact of its own.
        return {
          sessionId: id,
          status: 'unknown',
          running: null,
          available: true,
          agentAvailable: false,
          statusSource: 'session',
          observedAt,
          session: sessionFactOf(session),
        }
      }
      return {
        sessionId: id,
        status: 'unknown',
        running: null,
        available: false,
        agentAvailable: false,
        statusSource: 'none',
        observedAt,
        session: null,
      }
    }
  }

  if (capabilities.includes('getStatus')) {
    definition.getStatus = async sessionId => {
      const observed = await definition.observe(sessionId)
      return {
        sessionId: observed.sessionId,
        status: observed.status,
        statusSource: observed.statusSource,
        observedAt: observed.observedAt,
      }
    }
  }

  if (capabilities.includes('getSession')) {
    definition.getSession = async sessionId => {
      const id = String(sessionId)
      const session = getSession(id)
      const agent = getAgent(id)
      if (session === undefined && agent === undefined) return null
      const fact = sessionFactOf(session ?? agent.session)
      const status = agent === undefined ? null : statusOf(agent)
      return {
        ...fact,
        sessionId: id,
        status,
        running: status === null ? null : status === 'running',
        agentAvailable: agent !== undefined,
      }
    }
  }

  if (capabilities.includes('getChildren')) {
    definition.getChildren = async parentSessionId => {
      const parentId = String(parentSessionId)
      const entries = await subagents.listChildren(parentId)
      const items = (Array.isArray(entries) ? entries : [])
        .map(entry => {
          const sessionId = typeof entry?.id === 'string'
            ? entry.id
            : (typeof entry?.sessionId === 'string' ? entry.sessionId : '')
          const createdAt = Number(entry?.createdAt)
          return {
            sessionId,
            mode: typeof entry?.mode === 'string' ? entry.mode : 'unknown',
            label: typeof entry?.label === 'string' ? entry.label : null,
            createdAt: Number.isFinite(createdAt) ? createdAt : null,
            // `mode: 'external'` entries have no local child Session (one-shot
            // providers such as Claude Code): they are leaves, not observable.
            external: entry?.mode === 'external',
          }
        })
        .filter(entry => entry.sessionId !== '')
      return { parentSessionId: parentId, items }
    }
  }

  if (capabilities.includes('launch')) {
    definition.launch = async options => {
      const { sessionId, cwd, agentOptions } = options ?? {}
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new AdapterError('dsh executor launch requires a sessionId', { code: 'invalid_request', adapterId: 'dsh' })
      }
      // The caller keeps message delivery (inject/followup) and workspace
      // attachment: launch only establishes the agent/session pair.
      const handle = await agents.create({
        sessionId,
        ...(typeof cwd === 'string' && cwd !== '' ? { meta: { cwd } } : {}),
        ...(agentOptions !== null && typeof agentOptions === 'object' ? { agentOptions } : {}),
      })
      return { sessionId, agent: handle?.agent ?? null, handle }
    }
  }

  if (capabilities.includes('cancel')) {
    definition.cancel = async sessionId => {
      const id = String(sessionId)
      const agent = getAgent(id)
      if (agent === undefined) return { ok: false, sessionId: id, reason: 'no_live_agent' }
      // Same user-cause cancellation the host's Stop path uses. The turn settles
      // asynchronously; the adapter never reports a status it has not observed.
      agent.cancel({ kind: 'user' })
      return { ok: true, sessionId: id }
    }
  }

  return defineAdapter(definition)
}
