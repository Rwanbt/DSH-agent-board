/**
 * Tiny measurement helpers shared by the benchmark and its regression test.
 * No dependencies; `performance.now()` is the monotonic clock.
 *
 * @module dsh-agent-board/scripts/bench/measure
 */

export function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

/**
 * Time `iterations` synchronous calls after `warmup` untimed calls.
 *
 * @param {() => unknown} fn
 * @param {{ iterations?: number, warmup?: number }} [options]
 * @returns {number[]} per-iteration durations in milliseconds
 */
export function timeSync(fn, { iterations = 40, warmup = 5 } = {}) {
  for (let index = 0; index < warmup; index += 1) fn()
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  return samples
}

/** Nearest-rank percentile (p in 0..100) of an unsorted sample array. */
export function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

/** Median of a sample array. */
export function median(samples) {
  return percentile(samples, 50)
}

/** p50 / p95 / max / min, rounded for reporting. */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null
  return {
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    max: round(Math.max(...samples)),
    min: round(Math.min(...samples)),
  }
}

/**
 * Deterministic replacement for the global timer pair, used to simulate the
 * client store's 200 ms coalescing window without depending on machine load.
 * Install, drive with `advanceTo(ms)`, then `restore()` in a `finally`.
 */
export function createFakeClock() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let now = 0
  let nextId = 1
  const timers = new Map()
  globalThis.setTimeout = (callback, delayMs = 0) => {
    const id = nextId
    nextId += 1
    timers.set(id, { at: now + Number(delayMs), callback })
    return id
  }
  globalThis.clearTimeout = id => {
    timers.delete(id)
  }
  return {
    /** Run every due timer in time order up to `target`, then set the clock. */
    advanceTo(target) {
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.at) {
            due = timer
            dueId = id
          }
        }
        if (due === null) break
        timers.delete(dueId)
        now = due.at
        due.callback()
      }
      now = target
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}
