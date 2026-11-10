import test from 'node:test'
import assert from 'node:assert/strict'

import { buildProjection } from '../src/supervisor/projection.js'
import { aggregateSubtrees } from '../src/board/view.js'
import { createBoardStore } from '../src/client/core.js'
import {
  buildHistoryScenario,
  buildLiveScenario,
  createClientCtx,
  projectionInput,
  trimmedStatePayload,
} from '../scripts/bench/fixtures.mjs'
import { createFakeClock, median, timeSync } from '../scripts/bench/measure.mjs'

// Deliberately small iteration counts: the thresholds are generous by two to
// three orders of magnitude, so a slow shared CI machine cannot flake them.
const ITERATIONS = 31
const WARMUP = 5

// The 125-session build is sub-millisecond on this machine class. A floor keeps
// timer noise from producing a false super-linear verdict; it does not hide a
// quadratic implementation: 64x the 125-session cost would still exceed the 8x
// ratio by a wide margin.
const RATIO_FLOOR_MS = 0.5

function medianBuildOf(fixture) {
  const input = projectionInput(fixture)
  // Fail fast on a broken fixture, outside the timed loop.
  buildProjection(input)
  return median(timeSync(() => buildProjection(input), { iterations: ITERATIONS, warmup: WARMUP }))
}

test('150 live agents build well under the generous budget', () => {
  const fixture = buildLiveScenario(150)
  const projection = buildProjection(projectionInput(fixture))
  assert.equal(projection.nodes.length, 150)
  // The fixture must exercise the status mix, not 150 idle rows.
  assert.ok(projection.counts.running > 0, 'running agents present')
  assert.ok(projection.counts.waiting_user > 0, 'waiting agents present')
  assert.ok(projection.counts.finished_unread > 0, 'unread results present')
  assert.ok(projection.counts.failed > 0, 'failures present')
  const ms = medianBuildOf(fixture)
  assert.ok(ms < 250, `150 agents median ${ms.toFixed(3)} ms exceeds the 250 ms budget`)
})

test('1,000 historical sessions build well under the generous budget', () => {
  const fixture = buildHistoryScenario(1000)
  const projection = buildProjection(projectionInput(fixture))
  assert.equal(projection.nodes.length, 1000)
  assert.equal(projection.roots.length, 1000)
  assert.ok(projection.counts.failed > 0, 'the history fixture includes failures')
  const ms = medianBuildOf(fixture)
  assert.ok(ms < 1200, `1000 sessions median ${ms.toFixed(3)} ms exceeds the 1200 ms budget`)
})

test('projection cost scales linearly with historical sessions (no quadratic scan)', () => {
  const smallMs = medianBuildOf(buildHistoryScenario(125))
  const largeMs = medianBuildOf(buildHistoryScenario(1000))
  const ratio = largeMs / Math.max(smallMs, RATIO_FLOOR_MS)
  assert.ok(
    ratio < 8,
    `1000/125 ratio ${ratio.toFixed(2)} (${smallMs.toFixed(3)} ms -> ${largeMs.toFixed(3)} ms) is super-linear`,
  )
})

test('aggregateSubtrees stays linear and totals every node', () => {
  const fixture = buildLiveScenario(150)
  const projection = buildProjection(projectionInput(fixture))
  const aggregates = aggregateSubtrees(projection)
  assert.equal(aggregates.size, projection.nodes.length)
  const samples = timeSync(() => aggregateSubtrees(projection), { iterations: ITERATIONS, warmup: WARMUP })
  const ms = median(samples)
  assert.ok(ms < 250, `aggregateSubtrees median ${ms.toFixed(3)} ms exceeds the 250 ms budget`)
})

test('client store coalesces a simulated 1 s burst of 50 native notifications', async () => {
  const fixture = buildLiveScenario(150)
  const ctx = createClientCtx(fixture)
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: trimmedStatePayload(fixture) }),
  })
  const store = createBoardStore(ctx, { fetchImpl, EventSourceImpl: undefined })
  const clock = createFakeClock()
  try {
    await store.refreshHost()
    store.subscribe(() => store.getSnapshot()) // emulate a renderer
    store.getSnapshot() // bind native subscriptions + baseline
    clock.advanceTo(200) // drain the refreshHost window
    const before = store.getStats()
    for (let index = 0; index < 50; index += 1) {
      clock.advanceTo((index + 1) * 20)
      if (index % 2 === 0) ctx.notifySessions()
      else ctx.notifyStatus()
    }
    clock.advanceTo(1260) // flush the last 200 ms window
    const rebuilds = store.getStats().rebuilds - before.rebuilds
    assert.ok(rebuilds >= 1, 'the burst must produce at least one rebuild')
    assert.ok(
      rebuilds <= 8,
      `50 notifications over 1000 ms produced ${rebuilds} rebuilds: the 200 ms coalescing window is broken`,
    )
  } finally {
    store.destroy()
    clock.restore()
  }
})
