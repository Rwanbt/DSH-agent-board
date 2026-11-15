/**
 * Lot 11 — the REAL-TIME load contract.
 *
 * 0.1.0 throttled the number of starts per rolling hour. That counts starts, not
 * load: six three-second turns and six forty-minute turns obey the same rule, the
 * window is invisible to the operator, and reaching it stops the product for the
 * rest of the hour. The load model replaces it with three simultaneous facts,
 * recomputed at every admission:
 *
 *   1. the OPERATOR's own ceiling (`null` = they set none);
 *   2. what the MACHINE can carry (parallelism + free memory, from `node:os`);
 *   3. what the remaining TOKEN pool can pay for (measured usage, never a guess).
 *
 * The effective ceiling is the smallest finite one and the binding source is
 * published, so the cockpit can say WHY a launch waits instead of looking dead.
 *
 * Two floors are deliberate and different:
 *   - a CONFIGURED ceiling is floored at `MIN_CONCURRENCY` by the operator UI;
 *   - the MACHINE ceiling is floored at `MIN_CONCURRENCY` too (this process is
 *     running on that machine; the raw figure stays published);
 *   - the TOKEN ceiling may reach 0 — a spent pool is money already spent — and
 *     that is not a silent freeze: `blocked` and its source are published and the
 *     cockpit raises one exception.
 *
 * This module is pure: the host feeds it numbers, the client never imports it.
 */

import { concurrencyReached, normalizeConcurrencyLimit, normalizeTokenPool } from './concurrency.js'

/**
 * Where an admission decision came from. `none` means "nothing binds": the
 * operator set no ceiling, the machine has room and the pool is unlimited.
 */
export const LOAD_SOURCES = Object.freeze({
  operator: 'operator',
  tokens: 'tokens',
  hardware: 'hardware',
  none: 'none',
})

/**
 * Why a launch waits behind the load model. Stable across the API and the panel.
 */
export const LOAD_REASONS = Object.freeze({
  exhausted: 'load_exhausted',
})

/**
 * Everything that turns machine facts into a session count, in one frozen
 * object so the host, the tests and the documentation cannot drift apart.
 */
export const LOAD_LIMITS = Object.freeze({
  /** A ceiling the operator configures never means "freeze by typo". */
  MIN_CONCURRENCY: 1,
  /**
   * A board session is mostly WAITING on a provider: the CPU only bursts when it
   * runs a shell, a build or a test. Eight sessions per core is the deliberate
   * calibration — this is an anti-overload guard, not a throughput governor; the
   * operator's own ceiling and the token pool are the product knobs.
   */
  SESSIONS_PER_CORE: 8,
  /** Free memory one more live session needs before it is worth starting. */
  BYTES_PER_SESSION: 128 * 1024 * 1024,
  /** Price of one turn before any usage was measured on this install. */
  DEFAULT_TOKENS_PER_TURN: 60_000,
})

function wholeCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.trunc(number)
}

/**
 * How many sessions the machine can carry, or `null` when nothing is known.
 *
 * Both signals are optional and independent; the tighter known one wins. An
 * unknown dimension contributes no ceiling (a plugin must not refuse to work
 * because `node:os` answered nothing), and a known one contributes its real
 * figure — including 0, which means "no headroom left".
 *
 * @param {{parallelism?: number, freeBytes?: number}} [facts]
 * @param {typeof LOAD_LIMITS} [limits]
 * @returns {number|null}
 */
export function hardwareCeilingOf({ parallelism, freeBytes } = {}, limits = LOAD_LIMITS) {
  const cores = wholeCount(parallelism)
  const bytes = Number.isFinite(Number(freeBytes)) ? Math.max(0, Number(freeBytes)) : 0
  const candidates = []
  if (cores > 0) candidates.push(Math.max(limits.MIN_CONCURRENCY, cores * limits.SESSIONS_PER_CORE))
  if (bytes > 0) candidates.push(Math.floor(bytes / limits.BYTES_PER_SESSION))
  if (candidates.length === 0) return null
  return Math.max(0, Math.min(...candidates))
}

/**
 * How many sessions the remaining token pool can still pay for, or `null` when
 * the operator declared no pool.
 *
 * The price of a turn is measured on this install once enough turns completed;
 * until then the documented fallback applies. `budget` is the size of the pool,
 * `consumed` what the current work wave already spent.
 *
 * @param {{budget?: unknown, consumed?: unknown, tokensPerTurn?: unknown}} [input]
 * @param {typeof LOAD_LIMITS} [limits]
 * @returns {number|null}
 */
export function tokenCeilingOf({ budget, consumed, tokensPerTurn } = {}, limits = LOAD_LIMITS) {
  const pool = normalizeTokenPool(budget, null)
  if (pool === null) return null
  const spent = wholeCount(consumed)
  const price = wholeCount(tokensPerTurn) || limits.DEFAULT_TOKENS_PER_TURN
  const remaining = Math.max(0, pool - spent)
  return Math.floor(remaining / price)
}

/**
 * The one ceiling an admission decision uses, plus what binds it.
 *
 * @param {{operator?: unknown, hardware?: unknown, tokens?: unknown}} [input]
 * @returns {{ceiling: number|null, binding: string, blocked: boolean,
 *   running: number|null, reasons: {source: string, limit: number|null, reached: boolean, blocked: boolean}[]}}
 */
export function effectiveLoadCeiling({ operator, hardware, tokens, running = null } = {}) {
  // The machine ceiling is FLOORED at one: this process is running on that
  // machine, and `freemem()` style metrics are noisy enough to report a fraction
  // of a session while the box is perfectly able to run one. The raw measured
  // value stays published, so a machine genuinely at its limit is visible
  // instead of being silently ignored.
  const hardwareRaw = normalizeConcurrencyLimit(hardware, null)
  const hardwareLimited = hardwareRaw === null ? null : Math.max(LOAD_LIMITS.MIN_CONCURRENCY, hardwareRaw)
  // Declaration order IS the tie rule: an operator's own ceiling is reported
  // first because it is the one they can see and change, then the money, then
  // the machine.
  const entries = [
    { source: LOAD_SOURCES.operator, limit: normalizeConcurrencyLimit(operator, null), raw: normalizeConcurrencyLimit(operator, null) },
    { source: LOAD_SOURCES.tokens, limit: normalizeTokenPool(tokens, null), raw: normalizeTokenPool(tokens, null) },
    { source: LOAD_SOURCES.hardware, limit: hardwareLimited, raw: hardwareRaw },
  ]
  const count = Number.isFinite(Number(running)) && running !== null && running !== undefined ? Math.max(0, Math.trunc(Number(running))) : null
  const finite = entries.filter(entry => entry.limit !== null)
  const ceiling = finite.length === 0 ? null : Math.min(...finite.map(entry => entry.limit))
  const binding = ceiling === null ? LOAD_SOURCES.none : finite.find(entry => entry.limit === ceiling).source
  const reasons = entries.map(entry => ({
    source: entry.source,
    limit: entry.limit,
    raw: entry.raw,
    reached: concurrencyReached(count ?? 0, entry.limit),
    blocked: entry.limit === 0,
  }))
  return { ceiling, binding, blocked: ceiling === 0, running: count, reasons }
}

/**
 * The price of ONE turn, and where it comes from.
 *
 * A declared value wins (the operator knows their workload). Otherwise the price
 * is MEASURED on this install once enough turns completed: the fallback constant
 * is a start-up default, never a permanent assumption. `minTurns` exists because
 * one huge turn is not an average.
 *
 * @param {{declared?: unknown, tokens?: unknown, turns?: unknown, minTurns?: number}} [input]
 * @returns {{perTurn: number|null, source: 'declared'|'measured'|'fallback'}}
 */
export function tokensPerTurnOf({ declared, tokens, turns, minTurns = MEASURED_TURNS_MINIMUM } = {}) {
  const exact = normalizeTokenPool(declared, null)
  if (exact !== null && exact > 0) return { perTurn: exact, source: 'declared' }
  const measuredTurns = wholeCount(turns)
  const measuredTokens = wholeCount(tokens)
  if (measuredTurns >= minTurns && measuredTokens > 0) {
    return { perTurn: Math.max(1, Math.round(measuredTokens / measuredTurns)), source: 'measured' }
  }
  return { perTurn: null, source: 'fallback' }
}

/** Turns needed before a measured average replaces the fallback constant. */
export const MEASURED_TURNS_MINIMUM = 3

/**
 * Read the provider-reported usage out of a DSH `TokenMeasurement`.
 *
 * `totalTokens` of that object is the CURRENT request pressure, not the cost:
 * the accumulated usage lives in `baseline.usage` and only exists once a
 * provider reported one. No usage means `null` — the load model must never
 * invent a bill.
 *
 * @param {unknown} measurement
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, billedTokens: number}|null}
 */
export function tokenUsageOf(measurement) {
  const record = measurement !== null && typeof measurement === 'object' ? measurement : null
  const baseline = record?.baseline
  if (baseline === null || typeof baseline !== 'object' || baseline.kind !== 'usage') return null
  const usage = baseline.usage
  if (usage === null || typeof usage !== 'object') return null
  const inputTokens = wholeCount(usage.inputTokens)
  const outputTokens = wholeCount(usage.outputTokens)
  const cacheReadTokens = wholeCount(usage.cacheReadTokens)
  const cacheWriteTokens = wholeCount(usage.cacheWriteTokens)
  // Billed = what the provider charged as tokens: prompt plus completion. Cache
  // buckets are reported apart because their price is provider-dependent.
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, billedTokens: inputTokens + outputTokens }
}

/**
 * The DELTA one finished attempt adds to the wave counter.
 *
 * `totalTokens` of a session is cumulative for that session, so re-measuring it
 * (a continuation, a retry, a settlement) must only add what was not already
 * counted. A measurement that went backwards — a recycled session id, a provider
 * that stopped reporting — never subtracts: the wave is a floor, not a balance.
 *
 * @param {{previous?: unknown, measured?: unknown}} [input]
 * @returns {{billedTokens: number, delta: number}}
 */
export function tokenAccountOf({ previous, measured } = {}) {
  const before = wholeCount(previous)
  const now = wholeCount(measured)
  return { billedTokens: now, delta: Math.max(0, now - before) }
}
