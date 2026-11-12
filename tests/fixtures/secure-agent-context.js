/** Minimal DSH setup fake: setup precedes publication; failures roll back.
 * Models allow:[] masking inherited tools, own-scope exemption, actual resolved
 * definitions passed to executor.describe, and monotonic guards. Not a DSH E2E.
 */
export function secureAgentContext({ sessionId, globalTools = [], ownTools = [], permissionPresets, onPermission } = {}) {
  const state = { restrictions: [], guards: [], executor: null, permission: null, disposed: false }
  const session = { id: sessionId }
  const presets = permissionPresets ?? {
    resolve: name => {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) throw new Error('unknown preset')
      return { sandbox: name, approval: 'ask' }
    },
    set: (target, name) => { if (target !== session) throw new Error('wrong session'); state.permission = name; onPermission?.(target, name) },
    current: target => { if (target !== session) throw new Error('wrong session'); return state.permission },
  }
  const tools = {
    restrict(filter) { state.restrictions.push(filter); return () => {} },
    guard(guard) { state.guards.push(guard); return () => {} },
    setExecutor(executor) { state.executor = executor; return () => {} },
    definitions() {
      const inherited = globalTools.filter(tool => state.restrictions.every(filter =>
        (filter.allow === undefined || filter.allow.includes(tool.name)) && !filter.deny?.includes(tool.name)))
      return [...inherited, ...ownTools]
    },
    describeResolved() { return state.executor?.describe(tools.definitions()) },
    async execute(input) {
      const denial = state.guards.map(guard => guard(input)).find(Boolean)
      if (denial) throw new Error(typeof denial === 'string' ? denial : denial.reason)
      return state.executor.execute(input)
    },
  }
  const agentCtx = { get: name => ({ tools, permissionPresets: presets })[name] }
  return { agentCtx, session, state, tools }
}

/** Convenience for existing handle-returning host fakes. */
export async function setupAgentHandle(options, handle, config = {}) {
  await applyAgentSetup(options, handle.agent, secureAgentContext({ sessionId: options.sessionId, ...config }))
  return handle
}

/** Invoke the inspected CreateAgentOptions.setup contract, including commit. */
export async function applyAgentSetup(options, agent, fixture = secureAgentContext({ sessionId: options.sessionId })) {
  agent.session = fixture.session
  agent.ctx = fixture.agentCtx
  try {
    const commit = await options.setup?.(fixture.agentCtx, agent)
    commit?.commit()
    return fixture
  } catch (error) {
    fixture.state.disposed = true
    agent.cancel?.({ kind: 'disposed' })
    throw error
  }
}
