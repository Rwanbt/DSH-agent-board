/** Execute one native owner operation, not GUI routes impersonating a user.
 * A disposable, read-only Agent supplies real project/actor identity. No prompt
 * or model turn is ever sent. The native tool pipeline owns validation/audit,
 * and its normal approval, claim and dependency rules remain in force.
 */
import { canonicalIntentPayload } from '../superagent/decisions.js'
import { createSecuredAgent, secureWorkerAgent } from './security.js'

/** Is the exact owner tool callable through this host's pipeline? */
export function nativeToolAvailable(ctx, name) {
  const tools = ctx?.get?.('tools')
  return typeof ctx?.agents?.create === 'function' && typeof tools?.execute === 'function'
    && typeof tools?.get === 'function' && tools.get(name) !== undefined
}

export function nativeToolsReady(ctx) {
  return nativeToolAvailable(ctx, 'taskboard_delete')
}

/**
 * Run exactly one native tool call. The guard pins the agent, the call id, the
 * tool name and the canonical arguments, so a fabricated or retargeted call is
 * denied even if the model-facing pipeline is compromised.
 */
export async function runNativeTool(ctx, { workspace, name, args, beforeExecute, interpret, timeoutMs = 10_000 }) {
  if (!nativeToolAvailable(ctx, name)) return { ok: false, reason: 'native_tool_unavailable' }
  if (!workspace?.path) return { ok: false, reason: 'payload_invalid' }
  const expected = canonicalIntentPayload(args)
  const callId = `call-agentboard-${globalThis.crypto.randomUUID()}`
  const sessionId = `session-agentboard-operation-${globalThis.crypto.randomUUID()}`
  let handle
  let tools
  let outcome
  let disposed = null
  try {
    beforeExecute()
    handle = await createSecuredAgent(ctx.agents, { sessionId, meta: { cwd: workspace.path } }, (agentCtx, agent) => {
      secureWorkerAgent(agentCtx, agent, 'read-only')
      tools = agentCtx?.get?.('tools')
      if (typeof tools?.guard !== 'function' || typeof tools?.execute !== 'function'
        || typeof tools?.executable !== 'function' || !tools.executable(name, agent)) {
        throw Object.assign(new Error('native_tool_unavailable'), { code: 'native_tool_unavailable' })
      }
      tools.guard(exec => {
        try { beforeExecute() } catch { return { reason: 'operation_authorization_changed' } }
        if (exec.agent !== agent || exec.callId !== callId || exec.name !== name
          || canonicalIntentPayload(exec.arguments) !== expected) return { reason: 'operation_tool_forbidden' }
        return undefined
      })
    })
    beforeExecute()
    const batch = await tools.execute({
      agent: handle.agent, signal: AbortSignal.timeout(timeoutMs), maxParallelToolCalls: 1,
      calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
    })
    const entry = batch?.results?.length === 1 ? batch.results[0] : null
    const result = entry?.callId === callId ? entry.result : null
    if (result?.isError === true) outcome = { ok: false, reason: result.error?.info?.code ?? 'native_tool_error' }
    else if (result?.isError !== false || !result.value || typeof result.value !== 'object') outcome = { ok: false, reason: 'native_tool_bad_result' }
    else outcome = interpret(result.value)
  } catch (error) {
    outcome = { ok: false, reason: typeof error?.code === 'string' ? error.code : 'native_tool_error' }
  } finally {
    if (handle) {
      try { await handle.dispose(); disposed = true } catch {
        disposed = false
        outcome = { ok: false, reason: 'operation_session_cleanup_failed', effect: outcome ?? null }
      }
    }
  }
  return { ...outcome, sessionId, disposed }
}

export async function executeNativeTaskDelete(ctx, { workspace, taskId, taskVersion, reason, beforeExecute }) {
  if (typeof taskId !== 'string' || !Number.isInteger(taskVersion)) return { ok: false, reason: 'payload_invalid' }
  return runNativeTool(ctx, {
    workspace, name: 'taskboard_delete', beforeExecute,
    args: { id: taskId, ifVersion: taskVersion, reason },
    interpret: value => {
      if (value.pendingApproval) return { ok: true, pendingApproval: value.pendingApproval, value }
      if (value.trashed === true) return { ok: true, value }
      return { ok: false, reason: 'native_tool_bad_result' }
    },
  })
}

export async function executeNativeScheduledCreate(ctx, { workspace, task, beforeExecute }) {
  return runNativeTool(ctx, {
    workspace, name: 'taskboard_create', beforeExecute, args: task,
    interpret: value => (value.task && typeof value.task.id === 'string' && value.task.id !== ''
      ? { ok: true, value }
      : { ok: false, reason: 'native_tool_bad_result' }),
  })
}
