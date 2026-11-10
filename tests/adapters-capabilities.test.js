import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITIES,
  CAPABILITIES_BY_KIND,
  EXECUTOR_CAPABILITIES,
  defineAdapter,
  methodOfCapability,
} from '../src/contracts/adapters.js'
import { createDshExecutor } from '../src/executors/dsh.js'
import { createExecutors } from '../src/executors/index.js'
import { createConnectors } from '../src/connectors/registry.js'

const NOW = 1_800_000_000_000

function session(id, header = {}) {
  return { id, header: { id, createdAt: NOW - 1000, ...header } }
}

function agent(id, { status = 'idle', session: sessionValue, model } = {}) {
  const calls = []
  return {
    id,
    status,
    session: sessionValue ?? session(id),
    model: { current: () => model ?? { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    cancel(cause) { calls.push(cause) },
    __calls: calls,
  }
}

/**
 * Fake host context with the exact services the DSH executor reads. Data:
 *   root         session + live running agent
 *   child        session + live idle agent (sub-agent header)
 *   session-only live session without a live agent (status must stay unknown)
 *   ghost        absent everywhere
 */
function fakeCtx({ withAgents = true, withSessions = true, withSubagents = true } = {}) {
  const rootSession = session('root', { cwd: 'D:\\App\\proj' })
  const childSession = session('child', {
    cwd: 'D:\\App\\proj',
    parentSession: 'root',
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'preset-1',
  })
  const sessionOnly = session('session-only', { cwd: 'D:\\App\\other' })
  const rootAgent = agent('root', { status: 'running', session: rootSession })
  const childAgent = agent('child', { status: 'idle', session: childSession })
  const agents = [rootAgent, childAgent]
  const sessions = [rootSession, childSession, sessionOnly]
  const calls = { create: [], children: [] }

  const ctx = {
    __calls: calls,
    __agents: agents,
    __rootAgent: rootAgent,
  }
  if (withAgents) {
    ctx.agents = {
      list: () => agents,
      get: id => agents.find(candidate => candidate.id === id),
      create: async options => {
        calls.create.push(options)
        const created = agent(options.sessionId, { status: 'idle', session: session(options.sessionId, options.meta ?? {}) })
        return { agent: created, dispose: async () => {} }
      },
    }
  }
  if (withSessions) {
    ctx.sessions = {
      list: () => sessions,
      get: id => sessions.find(candidate => candidate.id === id),
    }
  }
  if (withSubagents) {
    ctx.subagents = {
      listChildren: async parentId => {
        calls.children.push(parentId)
        return [
          { id: 'external-run-1', mode: 'external', label: 'Claude Code run', createdAt: NOW },
          { id: 'child', mode: 'continuable', label: 'Child task', createdAt: NOW - 500 },
        ]
      },
    }
  }
  return ctx
}

const DSH_MATRIX = Object.freeze(['cancel', 'discover', 'getChildren', 'getSession', 'getStatus', 'launch', 'observe'])

test('executor vocabulary is closed per kind and part of the union', () => {
  for (const capability of EXECUTOR_CAPABILITIES) {
    assert.ok(CAPABILITIES.includes(capability), capability)
    assert.ok(CAPABILITIES_BY_KIND.executor.includes(capability), capability)
    assert.equal(CAPABILITIES_BY_KIND.forge.includes(capability), false, `${capability} must not be a forge capability`)
  }
})

test('dsh adapter declares exactly the capabilities its ctx supports', () => {
  const adapter = createDshExecutor(fakeCtx())
  assert.deepEqual([...adapter.capabilities].sort(), DSH_MATRIX)
  assert.equal(adapter.capabilities.includes('resume'), false, 'this adapter never calls ctx.agents.resume')
  assert.equal(adapter.capabilities.includes('getModel'), false, 'SessionHeader carries no model')
  assert.equal(adapter.capabilities.includes('openSession'), false)
  assert.equal(adapter.capabilities.includes('readLastOutput'), false)
  assert.equal(adapter.validatedLive, false, 'the adapter factory is not wired into the host launch path yet')
  assert.ok(adapter.notes.trim() !== '', 'every adapter must explain its matrix')
})

test('capabilities are conditional: no ctx.subagents means no getChildren', () => {
  const adapter = createDshExecutor(fakeCtx({ withSubagents: false }))
  assert.equal(adapter.capabilities.includes('getChildren'), false)
  assert.equal(typeof adapter.getChildren, 'undefined')
  assert.deepEqual([...adapter.capabilities].sort(), DSH_MATRIX.filter(capability => capability !== 'getChildren'))
})

test('a sessions-only ctx cannot launch or cancel', () => {
  const adapter = createDshExecutor(fakeCtx({ withAgents: false }))
  assert.deepEqual([...adapter.capabilities].sort(), ['discover', 'getChildren', 'getSession', 'getStatus', 'observe'])
  assert.equal(typeof adapter.launch, 'undefined')
  assert.equal(typeof adapter.cancel, 'undefined')
})

test('a ctx without agents or sessions is refused instead of pretending', () => {
  assert.throws(
    () => createDshExecutor(fakeCtx({ withAgents: false, withSessions: false })),
    error => error.code === 'context_unavailable' && error.adapterId === 'dsh',
  )
})

test('discover merges live sessions and agents; only an Agent yields a status', async () => {
  const adapter = createDshExecutor(fakeCtx())
  const { items } = await adapter.discover()
  assert.deepEqual(items.map(item => item.sessionId), ['child', 'root', 'session-only'])
  const byId = new Map(items.map(item => [item.sessionId, item]))
  assert.equal(byId.get('root').status, 'running')
  assert.equal(byId.get('root').running, true)
  assert.equal(byId.get('root').statusSource, 'agent')
  assert.equal(byId.get('child').status, 'idle')
  assert.equal(byId.get('child').parentSessionId, 'root')
  assert.equal(byId.get('child').origin, 'subagent')
  assert.equal(byId.get('session-only').status, 'unknown')
  assert.equal(byId.get('session-only').running, null)
  assert.equal(byId.get('session-only').statusSource, 'session')
  assert.equal(byId.get('session-only').cwd, 'D:\\App\\other')
})

test('observe reports agent facts and never invents a status', async () => {
  const adapter = createDshExecutor(fakeCtx())
  const running = await adapter.observe('root')
  assert.equal(running.status, 'running')
  assert.equal(running.running, true)
  assert.equal(running.agentAvailable, true)
  assert.equal(running.statusSource, 'agent')
  assert.equal(running.session.cwd, 'D:\\App\\proj')

  const sessionOnly = await adapter.observe('session-only')
  assert.equal(sessionOnly.status, 'unknown')
  assert.equal(sessionOnly.running, null)
  assert.equal(sessionOnly.available, true)
  assert.equal(sessionOnly.agentAvailable, false)
  assert.equal(sessionOnly.statusSource, 'session')

  const ghost = await adapter.observe('ghost')
  assert.equal(ghost.status, 'unknown')
  assert.equal(ghost.available, false)
  assert.equal(ghost.statusSource, 'none')
})

test('getStatus is the cheap probe and mirrors observe', async () => {
  const adapter = createDshExecutor(fakeCtx())
  const status = await adapter.getStatus('child')
  assert.equal(status.sessionId, 'child')
  assert.equal(status.status, 'idle')
  assert.equal(status.statusSource, 'agent')
  assert.ok(Number.isFinite(status.observedAt))
  assert.equal((await adapter.getStatus('ghost')).status, 'unknown')
})

test('getSession returns header facts, or null when the session is unknown', async () => {
  const adapter = createDshExecutor(fakeCtx())
  const root = await adapter.getSession('root')
  assert.equal(root.sessionId, 'root')
  assert.equal(root.cwd, 'D:\\App\\proj')
  assert.equal(root.running, true)
  assert.equal(root.agentAvailable, true)

  const child = await adapter.getSession('child')
  assert.equal(child.parentSessionId, 'root')
  assert.equal(child.origin, 'subagent')
  assert.equal(child.agentPreset, 'preset-1')
  assert.equal(child.delegationDepth, 1)

  const sessionOnly = await adapter.getSession('session-only')
  assert.equal(sessionOnly.status, null)
  assert.equal(sessionOnly.running, null)
  assert.equal(await adapter.getSession('ghost'), null)
})

test('getChildren reads the durable catalog and marks external leaves', async () => {
  const ctx = fakeCtx()
  const adapter = createDshExecutor(ctx)
  const { parentSessionId, items } = await adapter.getChildren('root')
  assert.equal(parentSessionId, 'root')
  assert.deepEqual(ctx.__calls.children, ['root'])
  assert.equal(items.length, 2)
  const external = items.find(item => item.sessionId === 'external-run-1')
  assert.equal(external.mode, 'external')
  assert.equal(external.external, true)
  assert.equal(external.label, 'Claude Code run')
  const local = items.find(item => item.sessionId === 'child')
  assert.equal(local.external, false)
  assert.equal(local.mode, 'continuable')
})

test('launch creates through ctx.agents.create and keeps message delivery out', async () => {
  const ctx = fakeCtx()
  const adapter = createDshExecutor(ctx)
  const launched = await adapter.launch({
    sessionId: 'new-1',
    cwd: 'D:\\App\\proj',
    agentOptions: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  })
  assert.deepEqual(ctx.__calls.create, [{
    sessionId: 'new-1',
    meta: { cwd: 'D:\\App\\proj' },
    agentOptions: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  }])
  assert.equal(launched.sessionId, 'new-1')
  assert.equal(launched.agent.id, 'new-1')
  assert.equal(typeof launched.handle.dispose, 'function')
  await assert.rejects(() => adapter.launch({}), error => error.code === 'invalid_request')
})

test('cancel uses the user cause and refuses an absent agent', async () => {
  const ctx = fakeCtx()
  const adapter = createDshExecutor(ctx)
  const result = await adapter.cancel('root')
  assert.deepEqual(result, { ok: true, sessionId: 'root' })
  assert.deepEqual(ctx.__rootAgent.__calls, [{ kind: 'user' }])
  const missing = await adapter.cancel('ghost')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'no_live_agent')
})

test('executor registry keeps three skeletons that declare nothing', () => {
  const matrix = createExecutors({ ctx: fakeCtx() }).describe().executors
  assert.deepEqual(matrix.map(entry => entry.id), ['dsh', 'claude-code', 'codex', 'opencode'])
  const dsh = matrix.find(entry => entry.id === 'dsh')
  assert.equal(dsh.kind, 'executor')
  assert.deepEqual(Object.keys(dsh.capabilities).sort(), [...EXECUTOR_CAPABILITIES].sort())
  assert.equal(dsh.capabilities.launch, true)
  assert.equal(dsh.capabilities.resume, false)
  assert.equal(dsh.capabilities.getModel, false)
  assert.equal(dsh.validatedLive, false)
  for (const skeleton of matrix.filter(entry => entry.id !== 'dsh')) {
    assert.equal(skeleton.status, 'unavailable', skeleton.id)
    assert.deepEqual(skeleton.declaredCapabilities, [], skeleton.id)
    assert.deepEqual(Object.values(skeleton.capabilities).filter(Boolean), [], skeleton.id)
    assert.ok(skeleton.notes.trim() !== '', skeleton.id)
    assert.equal(skeleton.validatedLive, false, skeleton.id)
  }
})

test('declared capabilities are a subset of implemented methods in both registries', () => {
  const adapters = [
    ...createExecutors({ ctx: fakeCtx() }).list(),
    ...createConnectors({ baseUrl: 'http://127.0.0.1:1' }).list(),
  ]
  assert.ok(adapters.length > 0)
  for (const adapter of adapters) {
    assert.ok(adapter.notes.trim() !== '', `${adapter.id}: notes are required`)
    for (const capability of adapter.capabilities) {
      assert.equal(
        typeof adapter[methodOfCapability(capability)],
        'function',
        `${adapter.id} declares ${capability} without a method`,
      )
    }
  }
})

test('no adapter claims resume without a resume method', () => {
  const adapters = [
    ...createExecutors({ ctx: fakeCtx() }).list(),
    ...createConnectors({ baseUrl: 'http://127.0.0.1:1' }).list(),
  ]
  for (const adapter of adapters) {
    if (!adapter.capabilities.includes('resume')) continue
    assert.equal(typeof adapter.resume, 'function', `${adapter.id} claims resume without resume()`)
  }
})

test('registration refuses an off-vocabulary capability and a missing method', () => {
  assert.throws(
    () => defineAdapter({ id: 'x', kind: 'executor', title: 'X', capabilities: ['launch'] }),
    /declares capability "launch" without implementing it/,
  )
  assert.throws(
    () => defineAdapter({ id: 'y', kind: 'work-source', title: 'Y', capabilities: ['launch'], launch() {} }),
    /not part of the work-source vocabulary/,
  )
  assert.throws(
    () => defineAdapter({ id: 'z', kind: 'executor', title: 'Z', capabilities: ['not-real'], notReal() {} }),
    /declares unknown capability not-real/,
  )
})
