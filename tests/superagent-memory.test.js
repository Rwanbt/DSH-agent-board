import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEMORY_LIMITS,
  buildDigest,
  checkpointOf,
  compactMemory,
  emptyMemory,
  recordDecision,
  recordFact,
} from '../src/superagent/memory.js'

test('emptyMemory and recordFact keep a bounded FIFO of 120 facts', () => {
  const empty = emptyMemory()
  assert.deepEqual(empty, { facts: [], decisions: [], digest: null })
  assert.equal(MEMORY_LIMITS.facts, 120)
  assert.equal(MEMORY_LIMITS.decisions, 120)

  let memory = empty
  for (let index = 0; index < 130; index += 1) {
    memory = recordFact(memory, { text: `fact ${index}`, kind: 'note', scope: 'project', projectId: 'ws1' }, { now: index })
  }
  assert.equal(memory.facts.length, 120)
  assert.equal(memory.facts[0].text, 'fact 10', 'oldest facts are dropped first')
  assert.equal(memory.facts[119].text, 'fact 129')
  assert.equal(memory.facts[0].scope, 'project')
  assert.equal(memory.facts[0].projectId, 'ws1')
  assert.equal(memory.digest, null, 'a mutation invalidates the digest')
  assert.equal(memory.decisions.length, 0)
})

test('recordFact derives deterministic ids from content and the entry counter', () => {
  const base = { facts: [], decisions: [], digest: null }
  const first = recordFact(base, { text: 'same fact', kind: 'note' }, { now: 50 })
  const replay = recordFact(base, { text: 'same fact', kind: 'note' }, { now: 50 })
  assert.deepEqual(first, replay)
  assert.match(first.facts[0].id, /^mem-f-[0-9a-f]{16}$/)
  assert.equal(first.facts[0].at, 50)

  const second = recordFact(first, { text: 'same fact', kind: 'note' }, { now: 51 })
  assert.notEqual(second.facts[1].id, first.facts[0].id, 'the counter keeps ids unique within one memory')

  const emptyFact = recordFact(first, { text: '   ' }, { now: 60 })
  assert.deepEqual(emptyFact.facts, first.facts)
  const hostile = recordFact(null, { __proto__: { polluted: true }, text: 'ok', kind: 'x'.repeat(100) }, { now: 1 })
  assert.equal(hostile.facts[0].kind.length, 40)
  assert.equal({}.polluted, undefined)
})

test('recordDecision bounds summaries, refs and FIFO retention', () => {
  let memory = emptyMemory()
  for (let index = 0; index < 130; index += 1) {
    memory = recordDecision(memory, { summary: `decision ${index}`, kind: 'approval', refs: ['task:1'] }, { now: index })
  }
  assert.equal(memory.decisions.length, 120)
  assert.equal(memory.decisions[0].summary, 'decision 10')

  const bounded = recordDecision(emptyMemory(), {
    summary: 's'.repeat(5000),
    refs: ['r'.repeat(500), ...Array.from({ length: 30 }, (_, index) => `ref-${index}`), ''],
  }, { now: 3 })
  assert.equal(bounded.decisions[0].summary.length, 400)
  assert.equal(bounded.decisions[0].refs.length, 20)
  assert.equal(bounded.decisions[0].refs[0].length, 200)
  assert.equal(bounded.decisions[0].refs[1], 'ref-0')
  assert.equal(recordDecision(bounded, { summary: '' }).decisions.length, 1)
})

test('buildDigest is deterministic, bounded and uses no elapsed-time phrasing', () => {
  const memory = compactMemory({
    facts: [{ text: 'tests are green', kind: 'note' }, { text: 'ws1 is blocked', kind: 'risk', scope: 'project', projectId: 'ws1' }],
    decisions: [{ summary: 'operator approved launch', kind: 'approval', projectId: 'ws1' }],
  }, { now: 900 })
  assert.equal(memory.digest.text, buildDigest(memory, { now: 900 }).text)
  assert.equal(memory.digest.updatedAt, 900)
  assert.equal(memory.digest.facts, 2)
  assert.equal(memory.digest.decisions, 1)
  assert.match(memory.digest.text, /2 facts, 1 decisions/)
  assert.match(memory.digest.text, /tests are green/)
  assert.match(memory.digest.text, /\[approval\] \(ws1\) operator approved launch/)
  assert.equal(/(just now|seconds? ago|minutes? ago|hours? ago|yesterday|elapsed)/i.test(memory.digest.text), false)
  assert.equal(memory.digest.text.length <= MEMORY_LIMITS.digestText, true)

  const huge = buildDigest({ facts: Array.from({ length: 120 }, (_, index) => ({ text: `${index}-${'x'.repeat(400)}` })) }, { now: 0 })
  assert.equal(huge.text.length <= MEMORY_LIMITS.digestText, true)
  assert.match(huge.text, /\[truncated\]$/)
})

test('compactMemory normalizes hostile state and rebuilds the digest', () => {
  for (const garbage of [null, undefined, [], 'x', { facts: 'nope', decisions: {} }, { facts: [null, 42, []], decisions: [{}] }]) {
    const compacted = compactMemory(garbage, { now: 7 })
    assert.deepEqual(Object.keys(compacted).sort(), ['decisions', 'digest', 'facts'])
    assert.equal(Array.isArray(compacted.facts), true)
    assert.equal(Array.isArray(compacted.decisions), true)
    assert.equal(compacted.digest.updatedAt, 7)
  }

  const recycled = compactMemory({ facts: [{ text: 'one' }], decisions: [{ summary: 'two' }] }, { now: 1 })
  assert.deepEqual(compactMemory(recycled, { now: 1 }), recycled, 'compaction is idempotent')

  const oversized = compactMemory({ facts: Array.from({ length: 150 }, (_, index) => ({ text: `f${index}` })), decisions: [] }, { now: 1 })
  assert.equal(oversized.facts.length, 120)
  assert.equal(oversized.facts[0].text, 'f30')
  assert.equal(oversized.facts.at(-1).text, 'f149', 'oversized persisted state keeps the newest facts')
})

test('checkpointOf is compact, JSON-safe and flags every truncation', () => {
  const bigState = {
    identity: { agentId: 'a1', name: 'Agent', level: 'L2', status: 'idle' },
    session: { sessionId: 'sess-secret', active: true, recycledCount: 3, lastTurnAt: 9, transcript: ['secret'] },
    directives: Array.from({ length: 12 }, (_, index) => ({ id: `d${index}`, text: `directive ${index}`, scope: 'global', createdAt: index, status: 'active' })),
    plan: {
      revision: 4,
      updatedAt: 8,
      objectives: Array.from({ length: 8 }, (_, index) => ({ id: `o${index}`, title: `objective ${index}` })),
      nextActions: Array.from({ length: 10 }, (_, index) => ({ id: `n${index}`, action: 'launch', projectId: 'ws1' })),
    },
    memory: {
      facts: Array.from({ length: 30 }, (_, index) => ({ text: `fact ${index}`, kind: 'note' })),
      digest: { text: 'digest text' },
    },
    decisions: Array.from({ length: 7 }, (_, index) => ({ id: `d${index}`, title: `question ${index}`, status: 'pending', urgency: 'normal', action: 'launch' })),
  }
  const checkpoint = checkpointOf(bigState, { now: 1000 })
  assert.deepEqual(checkpoint, JSON.parse(JSON.stringify(checkpoint)))
  assert.equal(checkpoint.identity.agentId, 'a1')
  assert.deepEqual(checkpointOf({ superagent: bigState }, { now: 1000 }), checkpoint, 'accepts the whole board state')
  assert.equal(checkpoint.session.recycledCount, 3)
  assert.equal(checkpoint.plan.objectives.length, MEMORY_LIMITS.checkpointObjectives)
  assert.equal(checkpoint.plan.nextActions.length, MEMORY_LIMITS.checkpointNextActions)
  assert.equal(checkpoint.directives.blocks.length, MEMORY_LIMITS.checkpointBlocks)
  assert.equal(checkpoint.facts.length, MEMORY_LIMITS.checkpointFacts)
  assert.equal(checkpoint.decisions.items.length, MEMORY_LIMITS.checkpointDecisions)
  assert.equal(checkpoint.truncated.facts, true)
  assert.equal(checkpoint.truncated.decisions, true)
  assert.equal(checkpoint.truncated.directives, true)
  assert.equal(checkpoint.truncated.objectives, true)
  assert.equal(checkpoint.truncated.nextActions, true)
  assert.equal(JSON.stringify(checkpoint).includes('sess-secret'), false)
  assert.equal(JSON.stringify(checkpoint).includes('secret'), false)

  const small = checkpointOf(null, { now: 5 })
  assert.equal(small.identity.level, 'L0')
  assert.equal(small.directives.restricted, false)
  assert.equal(small.truncated.facts, false)
  assert.equal(small.digest, null)
})
