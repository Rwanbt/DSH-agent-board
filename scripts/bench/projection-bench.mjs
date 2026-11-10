#!/usr/bin/env node
/**
 * Projection benchmark: synthetic fixtures, deterministic inputs.
 *
 * Measures, for 5 / 20 / 50 / 150 live agents, 1,000 historical sessions and
 * one 1,000-deep chain (the cycle-guard worst case):
 *   - buildProjection() p50 / p95 / max over >= 30 iterations after warmup,
 *   - aggregateSubtrees() p50 / p95 / max,
 *   - retained heap delta after forced GC when `--expose-gc` is present,
 *   - serialized size of a trimmed /state payload,
 * and, with the REAL createBoardStore and a fake client ctx, the rebuild count
 * during a simulated 1 s burst of 50 native notifications (200 ms coalescing).
 *
 * The JSON summary goes to stdout; the human-readable table goes to stderr.
 * Both are also written under `docs/bench/` (override with `--out=DIR`), so the
 * repository root never collects stray benchmark files.
 *
 * Usage:
 *   node [--expose-gc] scripts/bench/projection-bench.mjs [--iterations=40] [--warmup=5] [--out=docs/bench]
 *
 * THESE ARE SYNTHETIC FIXTURES. No live host was load-tested.
 *
 * @module dsh-agent-board/scripts/bench/projection-bench
 */

import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildProjection } from '../../src/supervisor/projection.js'
import { aggregateSubtrees } from '../../src/board/view.js'
import { createBoardStore } from '../../src/client/core.js'
import {
  buildDeepChainScenario,
  buildHistoryScenario,
  buildLiveScenario,
  createClientCtx,
  projectionInput,
  trimmedStatePayload,
} from './fixtures.mjs'
import { createFakeClock, round, summarize, timeSync } from './measure.mjs'

const argv = process.argv.slice(2)

function optionOf(name, fallback) {
  const hit = argv.find(argument => argument.startsWith(`--${name}=`))
  if (hit === undefined) return fallback
  const value = Number(hit.slice(name.length + 3))
  return Number.isFinite(value) ? value : fallback
}

const iterations = Math.max(30, Math.floor(optionOf('iterations', 40)))
const warmup = Math.max(0, Math.floor(optionOf('warmup', 5)))
const gcAvailable = typeof globalThis.gc === 'function'

/** Median retained heap delta over 3 forced-GC samples, or null without gc. */
function heapDeltaOf(fn) {
  if (!gcAvailable) return null
  const samples = []
  for (let index = 0; index < 3; index += 1) {
    globalThis.gc()
    globalThis.gc()
    const before = process.memoryUsage().heapUsed
    const held = fn()
    // Keep the retained projection alive across the second collection.
    void held
    globalThis.gc()
    globalThis.gc()
    const after = process.memoryUsage().heapUsed
    samples.push(after - before)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

function benchFixture(fixture) {
  const input = projectionInput(fixture)
  const projection = buildProjection(input)
  const buildMs = summarize(timeSync(() => buildProjection(input), { iterations, warmup }))
  const aggregateMs = summarize(timeSync(() => aggregateSubtrees(projection), { iterations, warmup }))
  const statePayloadBytes = Buffer.byteLength(JSON.stringify(trimmedStatePayload(fixture)), 'utf8')
  return {
    id: fixture.id,
    kind: fixture.kind,
    agents: fixture.agents,
    nodes: projection.nodes.length,
    roots: projection.roots.length,
    counts: projection.counts,
    buildMs,
    aggregateMs,
    statePayloadBytes,
    statePayloadKB: round(statePayloadBytes / 1024, 1),
  }
}

/**
 * Run the REAL client store against a fake ctx and count projection rebuilds
 * during 50 native notifications spread over one simulated second. A renderer
 * is emulated by calling getSnapshot() from the store subscription. The fake
 * clock makes the count deterministic regardless of machine load.
 */
async function benchClientStore(fixture) {
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
    store.subscribe(() => store.getSnapshot())
    store.getSnapshot() // bind native subscriptions + compute the baseline
    clock.advanceTo(200) // drain the refreshHost coalescing window
    const before = store.getStats()
    const notifications = 50
    const burstMs = 1000
    const intervalMs = burstMs / notifications
    for (let index = 0; index < notifications; index += 1) {
      clock.advanceTo((index + 1) * intervalMs)
      if (index % 2 === 0) ctx.notifySessions()
      else ctx.notifyStatus()
    }
    clock.advanceTo(burstMs + 260) // flush the last window
    const after = store.getStats()
    const rebuilds = after.rebuilds - before.rebuilds
    return {
      scenario: fixture.id,
      notifications,
      rebuilds,
      notifyWindowMs: 200,
      burstMs,
      listenerCount: ctx.listenerCount(),
      coalesced: rebuilds < notifications,
    }
  } finally {
    store.destroy()
    clock.restore()
  }
}

function tableOf(results, clientStore) {
  const rows = results.map(result => [
    result.id,
    result.nodes,
    result.buildMs.p50.toFixed(3),
    result.buildMs.p95.toFixed(3),
    result.buildMs.max.toFixed(3),
    result.aggregateMs.p50.toFixed(3),
    result.aggregateMs.p95.toFixed(3),
    result.heapDeltaMB === undefined ? 'n/a' : result.heapDeltaMB.toFixed(2),
    result.statePayloadKB.toFixed(1),
  ])
  const header = ['scenario', 'nodes', 'build p50', 'p95', 'max', 'agg p50', 'agg p95', 'heap MB', 'state KB']
  const widths = header.map((label, column) => Math.max(label.length, ...rows.map(row => String(row[column]).length)))
  const format = row => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ')
  return [
    format(header),
    widths.map(width => '-'.repeat(width)).join('  '),
    ...rows.map(format),
    '',
    `client store: ${clientStore.notifications} native notifications / ${clientStore.burstMs} ms -> ${clientStore.rebuilds} rebuilds (window ${clientStore.notifyWindowMs} ms, coalesced=${clientStore.coalesced})`,
  ].join('\n')
}

function optionString(name, fallback) {
  const hit = argv.find(argument => argument.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const fixtures = [
  buildLiveScenario(5),
  buildLiveScenario(20),
  buildLiveScenario(50),
  buildLiveScenario(150),
  buildHistoryScenario(1000),
  buildDeepChainScenario(1000),
]

// Timing pass first: no forced GC may interleave with the measured samples.
const timed = fixtures.map(benchFixture)
// Then the real client store, then the heap pass (forced GC disturbs timings).
const clientStore = await benchClientStore(buildLiveScenario(150))
const heapById = new Map()
if (gcAvailable) {
  for (const fixture of fixtures) {
    heapById.set(fixture.id, heapDeltaOf(() => buildProjection(projectionInput(fixture))))
  }
}
const results = timed.map(result => {
  const heapDeltaBytes = heapById.get(result.id)
  if (heapDeltaBytes === undefined) return result
  return { ...result, heapDeltaBytes, heapDeltaMB: round(heapDeltaBytes / (1024 * 1024), 2) }
})

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')
const outOption = optionString('out', 'docs/bench').trim()
const outDir = resolve(repoRoot, outOption === '' ? 'docs/bench' : outOption)
const jsonPath = resolve(outDir, 'projection-bench.json')
const tablePath = resolve(outDir, 'projection-bench.txt')
const toPosix = value => value.replaceAll('\\', '/')

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalMemGB: round(os.totalmem() / (1024 ** 3), 1),
  },
  method: {
    synthetic: true,
    liveHostLoadTested: false,
    fixtures: 'scripts/bench/fixtures.mjs (seeded mulberry32, deterministic)',
    iterations,
    warmup,
    percentile: 'nearest-rank',
    gcAvailable,
    heap: gcAvailable
      ? 'median retained heap delta over 3 samples, forced GC before and after'
      : 'omitted (rerun with --expose-gc)',
    statePayload: 'trimmed /state payload: per-agent acks/previews/turnEnd/assignments + bounded-empty collections',
    clientStore: 'REAL createBoardStore + fake ctx, fake clock: 50 notifications over 1000 ms, 200 ms coalescing',
  },
  artifacts: {
    json: toPosix(relative(repoRoot, jsonPath)),
    table: toPosix(relative(repoRoot, tablePath)),
  },
  scenarios: results,
  clientStore,
}

const table = tableOf(results, clientStore)
process.stderr.write(`${table}\n`)
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
await mkdir(outDir, { recursive: true })
await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
await writeFile(tablePath, `${table}\n`, 'utf8')
