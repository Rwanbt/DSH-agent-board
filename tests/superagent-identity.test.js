import test from 'node:test'
import assert from 'node:assert/strict'

import { createIdentity, normalizeIdentity, publicIdentityOf, markCycle, requestRecycle } from '../src/superagent/identity.js'

test('createIdentity is deterministic and defaults to L0/idle', () => {
  const first = createIdentity({ now: 1700000000000 })
  const second = createIdentity({ now: 1700000000000 })
  assert.deepEqual(first, second)
  assert.equal(first.level, 'L0')
  assert.equal(first.status, 'idle')
  assert.equal(first.generation, 0)
  assert.equal(first.name, 'Super Agent')
  assert.match(first.agentId, /^super-agent-[0-9a-f]{16}$/)
  assert.equal(first.model, null)
  assert.equal(first.session.active, false)
  assert.equal(first.session.recycledCount, 0)

  const pinned = createIdentity({
    now: 1,
    model: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      fallback: [{ provider: 'backup', model: 'other' }],
    },
  })
  assert.equal(pinned.model.provider, 'deepseek')
  assert.equal(pinned.model.reasoningEffort, 'high')
  assert.deepEqual(pinned.model.fallback, [{ provider: 'backup', model: 'other' }])
})

test('normalizeIdentity never throws on hostile input and drops unknown/prototype keys', () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},'
    + '"agentId":null,"level":"L9","status":"hacked","generation":"7","createdAt":"12345",'
    + '"model":{"provider":"p","model":"m","apiKey":"sk-verysecret123"},"transcript":["secret"]}',
  )
  const normalized = normalizeIdentity(hostile, { now: 99 })
  assert.equal(normalized.level, 'L0')
  assert.equal(normalized.status, 'idle')
  assert.equal(normalized.generation, 7)
  assert.equal(normalized.createdAt, 12345)
  assert.equal(normalized.transcript, undefined)
  assert.equal(normalized.apiKey, undefined)
  assert.equal(normalized.constructor, Object)
  assert.equal(normalized.model.apiKey, undefined)
  assert.equal({}.polluted, undefined, 'prototype pollution must not leak into Object.prototype')

  for (const garbage of [null, undefined, [], 'string', 42, true, () => {}, Symbol('x')]) {
    const result = normalizeIdentity(garbage, { now: 5 })
    assert.equal(typeof result.agentId, 'string')
    assert.equal(result.agentId.length > 0, true)
    assert.equal(result.level, 'L0')
    assert.equal(result.createdAt, 5)
  }
})

test('normalization bounds strings, clamps numbers and coerces timestamp strings', () => {
  const normalized = normalizeIdentity(
    {
      agentId: 'a'.repeat(5000),
      name: 'n'.repeat(5000),
      level: 'l3',
      status: 'THINKING',
      generation: 999999999,
      session: { sessionId: 's'.repeat(5000), recycledCount: -5, lastTurnAt: '7' },
    },
    { now: 0 },
  )
  assert.equal(normalized.agentId.length, 200)
  assert.equal(normalized.name.length, 400)
  assert.equal(normalized.level, 'L3')
  assert.equal(normalized.status, 'thinking')
  assert.equal(normalized.generation, 1000000)
  assert.equal(normalized.session.sessionId.length, 120)
  assert.equal(normalized.session.recycledCount, 0)
  assert.equal(normalized.session.lastTurnAt, 7)
})

test('publicIdentityOf never exposes secrets, session transcripts or extra keys', () => {
  const identity = {
    ...createIdentity({ now: 10 }),
    session: { sessionId: 'sess-secret', transcript: ['user: hi'], lastError: 'token=abc123456' },
    token: 'tok_live_987654321',
    headers: { authorization: 'Bearer zzzzzzzzzz' },
    messages: [{ role: 'user', content: 'secret' }],
  }
  const published = publicIdentityOf(identity)
  const serialized = JSON.stringify(published)
  assert.equal('session' in published, false)
  assert.equal('token' in published, false)
  assert.equal('headers' in published, false)
  assert.equal(serialized.includes('sess-secret'), false)
  assert.equal(serialized.includes('tok_live_987654321'), false)
  assert.equal(serialized.includes('zzzzzzzzzz'), false)
  assert.equal(serialized.includes('secret'), false)
  assert.deepEqual(Object.keys(published).sort(), ['agentId', 'createdAt', 'generation', 'level', 'model', 'name', 'status'])

  const withText = publicIdentityOf({ ...identity, name: 'token=abc123456', agentId: 'bearer abcdefghijklmnop' })
  assert.equal(withText.name.includes('abc123456'), false)
  assert.equal(withText.agentId.includes('abcdefghijklmnop'), false)
  assert.equal(publicIdentityOf(null).level, 'L0')
})

test('markCycle is deterministic, increments generation and maps outcomes', () => {
  const base = createIdentity({ now: 100, agentId: 'a1' })
  const thinking = markCycle(base, { at: 200, outcome: 'thinking' })
  assert.deepEqual(thinking, markCycle(base, { at: 200, outcome: 'thinking' }))
  assert.equal(thinking.generation, 1)
  assert.equal(thinking.status, 'idle')
  assert.equal(thinking.session.lastTurnAt, 200)
  assert.equal(thinking.session.lastError, null)

  const failed = markCycle(thinking, { at: '300', outcome: 'failed' })
  assert.equal(failed.generation, 2)
  assert.equal(failed.status, 'error')
  assert.equal(failed.session.lastTurnAt, 300)
  assert.notEqual(failed.session.lastError, null)

  const paused = markCycle({ ...base, status: 'paused' }, { at: 400, outcome: 'ok' })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.generation, 1)
  assert.deepEqual(base, createIdentity({ now: 100, agentId: 'a1' }), 'markCycle must not mutate its input')
})

test('requestRecycle closes the session, bumps counters, redacts and respects stop', () => {
  const base = {
    ...createIdentity({ now: 100, agentId: 'a1' }),
    generation: 4,
    session: {
      sessionId: 's1',
      active: true,
      createdAt: 100,
      endedAt: null,
      recycledCount: 2,
      recycleReason: null,
      lastTurnAt: 150,
      lastError: null,
    },
  }
  const recycled = requestRecycle(base, 'token=abc123456 leaked in logs')
  assert.deepEqual(recycled, requestRecycle(base, 'token=abc123456 leaked in logs'))
  assert.equal(recycled.status, 'idle')
  assert.equal(recycled.generation, 5)
  assert.equal(recycled.session.active, false)
  assert.equal(recycled.session.sessionId, null)
  assert.equal(recycled.session.recycledCount, 3)
  assert.equal(recycled.session.recycleReason.includes('abc123456'), false)
  assert.equal(recycled.session.recycleReason.length <= 400, true)

  const stopped = requestRecycle({ ...base, status: 'stopped' }, 'rotate')
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.generation, 5)
})
