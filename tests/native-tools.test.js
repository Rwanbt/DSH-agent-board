import test from 'node:test'
import assert from 'node:assert/strict'
import { executeNativeTaskDelete, nativeToolsReady } from '../src/host/native-tools.js'
import { applyAgentSetup, secureAgentContext } from './fixtures/secure-agent-context.js'

function fixture({ value = { trashed: true }, error, hostile = false, cleanupFails = false, beforeDispatch } = {}) {
  const state = { created: [], calls: [], disposed: 0, fixtures: [] }
  const definition = { name: 'taskboard_delete' }
  const ctx = {
    get: name => name === 'tools' ? { execute() {}, get: name => name === definition.name ? definition : undefined } : undefined,
    agents: { async create(options) {
      state.created.push(options)
      const scoped = secureAgentContext({ sessionId: options.sessionId })
      state.fixtures.push(scoped)
      const agent = { id: options.sessionId, cancel() {}, followup() { throw new Error('no model work allowed') } }
      scoped.tools.executable = name => name === definition.name ? definition : undefined
      scoped.tools.execute = async input => {
        await beforeDispatch?.()
        const call = input.calls[0]
        const args = JSON.parse(call.arguments)
        const exec = { agent: input.agent, callId: call.id, name: call.name, arguments: hostile ? { ...args, id: 'foreign' } : args }
        const denied = scoped.state.guards.map(guard => guard(exec)).find(Boolean)
        if (denied) return { results: [{ callId: call.id, result: { isError: true, error: { info: { code: 'GUARD_DENIED' } } } }] }
        state.calls.push({ args, agent: input.agent })
        return { results: [{ callId: call.id, result: error
          ? { isError: true, error: { info: { code: error } } }
          : { isError: false, value } }] }
      }
      await applyAgentSetup(options, agent, scoped)
      return { agent, async dispose() { if (cleanupFails) throw new Error('failure'); state.disposed++ } }
    } },
  }
  return { ctx, state }
}
const input = { workspace: { id: 'w1', path: process.cwd() }, taskId: 't1', taskVersion: 3, reason: 'Duplicate card', beforeExecute() {} }

test('native delete uses exact tool arguments and a real read-only actor, with no model turn', async () => {
  const { ctx, state } = fixture()
  assert.equal(nativeToolsReady(ctx), true)
  const result = await executeNativeTaskDelete(ctx, input)
  assert.equal(result.ok, true)
  assert.equal(result.value.trashed, true)
  assert.equal(result.disposed, true)
  assert.equal(state.calls.length, 1)
  assert.deepEqual(state.calls[0].args, { id: 't1', ifVersion: 3, reason: 'Duplicate card' })
  assert.equal(state.created[0].meta.cwd, input.workspace.path)
  assert.equal(state.fixtures[0].state.permission, 'read-only')
  assert.equal(state.disposed, 1)
})

test('native tools are unavailable without the actual owner tool; no session is created', async () => {
  const { ctx, state } = fixture()
  ctx.get = () => undefined
  assert.equal(nativeToolsReady(ctx), false)
  assert.equal((await executeNativeTaskDelete(ctx, input)).reason, 'native_tool_unavailable')
  assert.equal(state.created.length, 0)
})

test('native deletion cannot be retargeted by a fabricated call', async () => {
  const { ctx, state } = fixture({ hostile: true })
  const result = await executeNativeTaskDelete(ctx, input)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'GUARD_DENIED')
  assert.equal(state.calls.length, 0)
  assert.equal(state.disposed, 1)
})

test('revocation at native dispatch blocks the effect and still disposes the actor', async () => {
  let revoked = false
  const { ctx, state } = fixture({ beforeDispatch: () => { revoked = true } })
  const result = await executeNativeTaskDelete(ctx, { ...input, beforeExecute() {
    if (revoked) throw Object.assign(new Error('mandate_changed'), { code: 'mandate_changed' })
  } })
  assert.equal(result.ok, false)
  assert.equal(state.calls.length, 0)
  assert.equal(state.disposed, 1)
})

test('Task Board dependency approval stays pending, never reported as a completed deletion', async () => {
  const { ctx } = fixture({ value: { pendingApproval: { id: 'approval-1', kind: 'trash-prerequisite', affected: ['dependent'] } } })
  const result = await executeNativeTaskDelete(ctx, input)
  assert.equal(result.ok, true)
  assert.equal(result.pendingApproval.id, 'approval-1')
  assert.equal(result.value.trashed, undefined)
})

test('native conflicts and session cleanup failures are explicit, not successful deletions', async () => {
  const conflict = await executeNativeTaskDelete(fixture({ error: 'VERSION_CONFLICT' }).ctx, input)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.reason, 'VERSION_CONFLICT')
  const cleanup = await executeNativeTaskDelete(fixture({ cleanupFails: true }).ctx, input)
  assert.equal(cleanup.ok, false)
  assert.equal(cleanup.reason, 'operation_session_cleanup_failed')
  assert.equal(cleanup.disposed, false)
  assert.equal(cleanup.effect.value.trashed, true, 'do not hide the already-applied effect')
})
