/**
 * Lot 11 — the load contract is the smallest of three real-time facts.
 *
 * The product claim is "supervise fifty sessions by handling exceptions": a
 * ceiling that comes from the machine or from the token pool must be explained,
 * never discovered as a silent freeze, and a measured usage must never be
 * invented when no provider reported one.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  LOAD_LIMITS,
  LOAD_SOURCES,
  effectiveLoadCeiling,
  hardwareCeilingOf,
  tokenAccountOf,
  tokenCeilingOf,
  tokenUsageOf,
} from '../src/contracts/load-budget.js'
import { normalizeHardwareFacts, normalizeTokenPool } from '../src/contracts/concurrency.js'

test('the machine ceiling comes from cores and free memory, never from a table', () => {
  // Calibration: a session mostly WAITS on a provider, so this is an anti-overload
  // guard (eight sessions per core), not a throughput governor.
  assert.equal(hardwareCeilingOf({ parallelism: 8 }), 64)
  assert.equal(hardwareCeilingOf({ parallelism: 1 }), 8, 'a single core still carries its share')
  assert.equal(hardwareCeilingOf({ parallelism: 50 }), 400)
  // Free memory is the second signal and the tighter one wins.
  assert.equal(hardwareCeilingOf({ parallelism: 16, freeBytes: 4 * 128 * 1024 * 1024 }), 4)
  assert.equal(hardwareCeilingOf({ parallelism: 2, freeBytes: 64 * 128 * 1024 * 1024 }), 16)
  // No headroom left is a real answer, not an unlimited one.
  assert.equal(hardwareCeilingOf({ parallelism: 8, freeBytes: 1024 }), 0)
  // Nothing known means no ceiling of this kind, never a refusal.
  assert.equal(hardwareCeilingOf({}), null)
  assert.equal(hardwareCeilingOf(), null)
  assert.equal(hardwareCeilingOf({ parallelism: 'wide', freeBytes: 'lots' }), null)
})

test('an explicit machine description replaces the measured one', () => {
  assert.equal(normalizeHardwareFacts(null), null)
  assert.equal(normalizeHardwareFacts({}), null)
  assert.equal(normalizeHardwareFacts({ parallelism: 0, freeBytes: 1 }), null)
  assert.equal(normalizeHardwareFacts({ parallelism: 4, freeBytes: 0 }), null)
  assert.deepEqual(normalizeHardwareFacts({ parallelism: 64, freeBytes: 64 * 1024 ** 3 }), { parallelism: 64, freeBytes: 64 * 1024 ** 3 })
})

test('the token ceiling divides the remaining pool by the price of a turn', () => {
  // No declared pool: the money binds nothing.
  assert.equal(tokenCeilingOf({}), null)
  assert.equal(tokenCeilingOf({ budget: null, consumed: 10_000 }), null)
  assert.equal(tokenCeilingOf({ budget: '' }), null)
  // A pool is a pool: what is left pays for whole turns only.
  assert.equal(tokenCeilingOf({ budget: 300_000, tokensPerTurn: 60_000 }), 5)
  assert.equal(tokenCeilingOf({ budget: 300_000, consumed: 120_000, tokensPerTurn: 60_000 }), 3)
  assert.equal(tokenCeilingOf({ budget: 300_000, consumed: 299_000, tokensPerTurn: 60_000 }), 0)
  assert.equal(tokenCeilingOf({ budget: 300_000, consumed: 400_000, tokensPerTurn: 60_000 }), 0, 'overspending never goes negative')
  // Until a turn was measured, the documented fallback price applies.
  assert.equal(tokenCeilingOf({ budget: 180_000 }), 3)
  assert.equal(tokenCeilingOf({ budget: 180_000, tokensPerTurn: 0 }), 3)
  assert.equal(tokenCeilingOf({ budget: 0 }), 0, 'zero budget is zero, not unlimited')
  assert.equal(normalizeTokenPool(undefined, 7), 7)
  assert.equal(normalizeTokenPool(-5, 7), 7)
  assert.equal(normalizeTokenPool(1000.9), 1000)
  assert.equal(normalizeTokenPool(0), 0)
})

test('the effective ceiling is the smallest fact and it says which one binds', () => {
  const free = effectiveLoadCeiling({})
  assert.equal(free.ceiling, null)
  assert.equal(free.binding, LOAD_SOURCES.none)
  assert.equal(free.blocked, false)

  const operatorFirst = effectiveLoadCeiling({ operator: 3, hardware: 10, tokens: 20 })
  assert.equal(operatorFirst.ceiling, 3)
  assert.equal(operatorFirst.binding, LOAD_SOURCES.operator)

  const machine = effectiveLoadCeiling({ hardware: 2, tokens: 20 })
  assert.equal(machine.ceiling, 2)
  assert.equal(machine.binding, LOAD_SOURCES.hardware)

  const money = effectiveLoadCeiling({ hardware: 9, tokens: 1 })
  assert.equal(money.ceiling, 1)
  assert.equal(money.binding, LOAD_SOURCES.tokens)

  // A tie is reported as the source the operator can see first.
  assert.equal(effectiveLoadCeiling({ operator: 4, tokens: 4 }).binding, LOAD_SOURCES.operator)

  // A computed zero is an announced stop, not a silent freeze.
  const broke = effectiveLoadCeiling({ operator: 8, tokens: 0, running: 3 })
  assert.equal(broke.ceiling, 0)
  assert.equal(broke.blocked, true)
  assert.equal(broke.binding, LOAD_SOURCES.tokens)
  assert.equal(broke.running, 3)
  const tokenReason = broke.reasons.find(reason => reason.source === LOAD_SOURCES.tokens)
  assert.deepEqual(tokenReason, { source: LOAD_SOURCES.tokens, limit: 0, raw: 0, reached: true, blocked: true })
  assert.equal(broke.reasons.find(reason => reason.source === LOAD_SOURCES.operator).reached, false)

  // The machine never blocks everything: this very process runs there, and a
  // free-memory reading is noisy. The raw figure stays published.
  const starved = effectiveLoadCeiling({ hardware: 0 })
  assert.equal(starved.ceiling, 1, 'one session can always run on the machine we are in')
  assert.equal(starved.reasons.find(reason => reason.source === LOAD_SOURCES.hardware).raw, 0)
  assert.equal(starved.blocked, false)
})

test('a measured usage is read from the provider, never invented', () => {
  const measured = tokenUsageOf({ totalTokens: 12_000, baseline: { kind: 'usage', tokens: 5, usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 40, cacheWriteTokens: 10 } } })
  assert.deepEqual(measured, { inputTokens: 900, outputTokens: 300, cacheReadTokens: 40, cacheWriteTokens: 10, billedTokens: 1_200 })
  // `totalTokens` alone is the CURRENT request pressure: reading it as a cost
  // would report a bill nobody was charged.
  assert.equal(tokenUsageOf({ totalTokens: 120_000, baseline: { kind: 'estimated', tokens: 120_000 } }), null)
  assert.equal(tokenUsageOf({ baseline: { kind: 'none', tokens: 0 } }), null)
  assert.equal(tokenUsageOf({}), null)
  assert.equal(tokenUsageOf(null), null)
  assert.equal(tokenUsageOf('nonsense'), null)
  assert.equal(tokenUsageOf({ baseline: { kind: 'usage', usage: {} } }).billedTokens, 0)
})

test('a wave counter only adds what was not already counted', () => {
  assert.deepEqual(tokenAccountOf({ previous: 0, measured: 1_200 }), { billedTokens: 1_200, delta: 1_200 })
  // A continuation re-measures the SAME session: only the extra is billed.
  assert.deepEqual(tokenAccountOf({ previous: 1_200, measured: 1_900 }), { billedTokens: 1_900, delta: 700 })
  // A recycled id or a provider that stopped reporting never subtracts.
  assert.deepEqual(tokenAccountOf({ previous: 1_900, measured: 400 }), { billedTokens: 400, delta: 0 })
  assert.deepEqual(tokenAccountOf({ previous: null, measured: null }), { billedTokens: 0, delta: 0 })
  assert.deepEqual(tokenAccountOf({}), { billedTokens: 0, delta: 0 })
})

test('the load contract stays on the host: the client only renders what is published', async () => {
  const root = new URL('../src/client/', import.meta.url)
  const names = await readdir(root, { recursive: true })
  const sources = names.filter(name => typeof name === 'string' && name.endsWith('.js'))
  assert.ok(sources.length >= 5, 'the client source tree is non-empty')
  for (const name of sources) {
    const text = await readFile(join(root.pathname.replace(/^\//, ''), name), 'utf8')
    assert.ok(!text.includes('load-budget'), `${name} must not import the host-only load contract`)
  }
})
