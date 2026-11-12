/** Fail-closed DSH boundaries. Contracts inspected on DSH 0.2.2-rc.2.
 * All registrations below MUST use the factory-supplied agentCtx (never host ctx).
 */
import { allowedPermissionOf } from '../contracts/model.js'

function refusal(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function service(ctx, name, methods) {
  const value = ctx?.get?.(name)
  if (!value || methods.some(method => typeof value[method] !== 'function')) {
    throw refusal(`security_service_unavailable:${name}`)
  }
  return value
}

/** Use factory setup before publication; reject compatibility factories that ignore it. */
export async function createSecuredAgent(agents, options, setup) {
  let securedAgent
  const handle = await agents.create({
    ...options,
    setup: async (agentCtx, agent) => {
      if (!agent || agent.id !== options.sessionId) throw refusal('security_agent_identity_mismatch')
      await setup(agentCtx, agent)
      securedAgent = agent
    },
  })
  if (!securedAgent || handle?.agent !== securedAgent) {
    try { await handle?.dispose?.() } catch { /* security failure remains primary */ }
    throw refusal('security_setup_not_applied')
  }
  return handle
}

/**
 * Tools-free assessment. allow:[] removes global AND inherited capabilities.
 * DSH deliberately exempts own-scope registrations, so the selected executor
 * verifies the actual resolved definitions on EVERY prompt assembly and refuses
 * incompatible presets/plugins rather than exposing their tools. No guessed
 * create({tools:[]}) option, name denylist, or prompt-based confinement.
 * A monotonic guard and executor rejection also block fabricated calls/PTC.
 */
export function secureAssessmentAgent(agentCtx) {
  const tools = service(agentCtx, 'tools', ['restrict', 'guard', 'setExecutor'])
  tools.restrict({ allow: [] })
  tools.guard(() => ({
    reason: 'assessment_tools_forbidden',
    info: { name: 'AssessmentToolsForbidden', code: 'ASSESSMENT_TOOLS_FORBIDDEN' },
  }))
  tools.setExecutor({
    describe(definitions) {
      if (!Array.isArray(definitions) || definitions.length !== 0) {
        throw refusal('assessment_toolset_not_empty')
      }
      return { schemas: [], knownNames: [] }
    },
    async execute() { throw refusal('assessment_tools_forbidden') },
  })
}

/** Missing card permission is explicitly read-only, never deployment default. */
export function effectiveWorkerPermission(policy, requested) {
  const permission = requested === undefined || requested === null || requested === '' ? 'read-only' : requested
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permission)
    || allowedPermissionOf(policy, permission) === null) {
    throw refusal(`permission_not_allowed:${String(permission)}`)
  }
  return permission
}

/** Apply AND verify the effective preset before agent publication or any work. */
export function secureWorkerAgent(agentCtx, agent, permission) {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permission)) throw refusal('permission_invalid')
  if (!agent?.session) throw refusal('security_session_unavailable')
  const presets = service(agentCtx, 'permissionPresets', ['resolve', 'set', 'current'])
  if (presets.resolve(permission)?.sandbox !== permission) throw refusal('permission_preset_mismatch')
  presets.set(agent.session, permission)
  const applied = presets.current(agent.session)
  if (applied !== permission || presets.resolve(applied)?.sandbox !== permission) {
    throw refusal('permission_verification_failed')
  }
}
