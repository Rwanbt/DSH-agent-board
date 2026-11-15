/**
 * Concurrency limits: ONE source of truth.
 *
 * The product exists to let one developer supervise dozens of AI sessions at
 * once, but every ceiling used to be a hard-coded clamp (`0..8`, `0..16`, the
 * literal `maxConcurrentAgents: 2`): the technical limit became the product
 * limit. Every knob is now configurable, with three explicit rules:
 *
 *   1. DEFAULTS DO NOT MOVE. The documented default of each limit is the 0.1.0
 *      value, so an upgrade changes no behaviour silently.
 *   2. `null` means UNLIMITED, explicitly (`UNLIMITED`). `0` keeps its historical
 *      meaning: ZERO slots, i.e. a deliberate freeze. Inverting `0` into "no
 *      ceiling" would turn an operator's freeze into an unlimited grant — the
 *      one silent behaviour change a safety-minded product must never make (an
 *      existing test pins `maxDelegationsPerHour: 0` = no delegation at all).
 *   3. `CONCURRENCY_HARD_CEILING` only guards a typing mistake (someone types
 *      100000). It is not a product cap and it is not reachable by accident.
 *
 * Pure: no clock, no I/O, no randomness.
 *
 * @module dsh-agent-board/contracts/concurrency
 */

/**
 * Anti-typo guard. A limit above this is clamped to it; it is deliberately far
 * above anything a machine+provider pair can sustain (50 sessions is the tested
 * product target).
 */
export const CONCURRENCY_HARD_CEILING = 256

/** The value that means "no ceiling at all". */
export const UNLIMITED = null

/** Documented defaults. Identical to 0.1.0 on purpose (no silent change). */
export const CONCURRENCY_DEFAULTS = Object.freeze({
  global: 2,
  supervisorConcurrent: 2,
  // A project inherits the global ceiling until the operator caps it.
  project: UNLIMITED,
  superagentAgents: 2,
  cyclesPerHour: 6,
  modelCallsPerHour: 12,
})

/** Reason codes, stable across the API and the panel. */
export const CONCURRENCY_REASONS = Object.freeze({
  global: 'concurrency_limit',
  project: 'project_concurrency_limit',
  provider: 'provider_concurrency_limit',
})

/**
 * Normalise a TOKEN POOL, in tokens.
 *
 * `null`, `undefined`, an empty string and any unreadable value mean "no pool"
 * (nothing binds on money). `0` is a real pool of zero — everything is spent.
 * Unlike a concurrency ceiling there is no anti-typo cap: a pool is a quantity,
 * not a number of slots.
 *
 * @param {unknown} value
 * @param {number|null} [fallback]
 * @returns {number|null}
 */
export function normalizeTokenPool(value, fallback = null) {
  return normalizeQuantity(value, fallback)
}

/** Hard ceiling of a rate limit: a typo, never a product cap. */
export const RATE_HARD_CEILING = 10_000

/**
 * Normalise a RATE limit (starts per hour, model calls per hour).
 *
 * `null` means no rate limit at all — Lot 11 turned that into the default, since
 * a counter over time measures starts, not load. `0` stays a real zero (no call
 * at all), which is what 0.1.0 documented and what an existing test pins.
 *
 * @param {unknown} value
 * @param {number|null} [fallback]
 * @param {number} [ceiling]
 * @returns {number|null}
 */
export function normalizeHourlyRate(value, fallback = null, ceiling = RATE_HARD_CEILING) {
  const count = normalizeQuantity(value, fallback)
  return count === null ? null : Math.min(ceiling, count)
}

/** A non-negative whole quantity, or `null` when the value is not one. */
function normalizeQuantity(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  if (typeof value === 'boolean') return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.trunc(number)
}

/**
 * Normalise one limit. `null` (or an absent value with a `null` fallback) means
 * unlimited; a finite value is truncated and clamped to `0..CONCURRENCY_HARD_CEILING`
 * where 0 is a real zero (a freeze), not "unlimited".
 *
 * @param {unknown} value
 * @param {number|null} [fallback] applied when the value is not finite
 * @returns {number|null}
 */
export function normalizeConcurrencyLimit(value, fallback = UNLIMITED) {
  if (value === null) return UNLIMITED
  const effective = value === undefined ? fallback : value
  if (effective === null || effective === undefined) return UNLIMITED
  if (typeof effective === 'string' && effective.trim() === '') return UNLIMITED
  const number = Number(effective)
  if (!Number.isFinite(number)) return fallback === null || fallback === undefined ? UNLIMITED : normalizeConcurrencyLimit(null, null)
  return Math.min(CONCURRENCY_HARD_CEILING, Math.max(0, Math.trunc(number)))
}

/**
 * Per-provider (or per provider/model) concurrency ceilings. Bounded and
 * sanitised: an unknown key or a non-numeric value is dropped, never trusted.
 *
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
export function normalizeProviderConcurrency(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  let kept = 0
  for (const [key, limit] of Object.entries(value)) {
    if (kept >= 20) break
    if (typeof key !== 'string' || key.trim() === '') continue
    const normalized = normalizeConcurrencyLimit(limit, null)
    if (normalized === null) continue
    out[key.trim()] = normalized
    kept += 1
  }
  return out
}

/** Does the current load reach the (possibly unlimited) ceiling? */
export function concurrencyReached(running, limit) {
  const normalized = normalizeConcurrencyLimit(limit, UNLIMITED)
  if (normalized === null) return false
  return Math.max(0, Number(running) || 0) >= normalized
}
/**
 * The EFFECTIVE global concurrency: the board policy and the supervision layer
 * both apply, and once either of them is unlimited the other one is the ceiling.
 * `supervision: { enabled:false }` disables that layer's own ceiling.
 *
 * @param {{global?: unknown, supervisorConcurrent?: unknown, supervisionEnabled?: boolean, running?: number}} [input]
 * @returns {{global: number|null, supervision: number|null, effective: number|null, unlimited: boolean, running: number}}
 */
export function effectiveConcurrencyOf({
  global = CONCURRENCY_DEFAULTS.global,
  supervisorConcurrent = CONCURRENCY_DEFAULTS.supervisorConcurrent,
  supervisionEnabled = true,
  running = 0,
} = {}) {
  const globalLimit = normalizeConcurrencyLimit(global, CONCURRENCY_DEFAULTS.global)
  const supervisionLimit = supervisionEnabled === false
    ? UNLIMITED
    : normalizeConcurrencyLimit(supervisorConcurrent, CONCURRENCY_DEFAULTS.supervisorConcurrent)
  let effective
  if (globalLimit === null) effective = supervisionLimit
  else if (supervisionLimit === null) effective = globalLimit
  else effective = Math.min(globalLimit, supervisionLimit)
  return {
    global: globalLimit,
    supervision: supervisionLimit,
    effective,
    unlimited: effective === null,
    running: Math.max(0, Number(running) || 0),
  }
}

/** Provider key a per-provider ceiling is registered under. */
export function providerKeyOfRoute(route) {
  if (route === null || typeof route !== 'object') return null
  const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
  if (provider === '') return null
  const model = typeof route.model === 'string' ? route.model.trim() : ''
  return model === '' ? provider : `${provider}/${model}`
}

/**
 * Active load per provider, keyed by BOTH `provider` and `provider/model`, so a
 * ceiling may be declared at either granularity.
 *
 * @param {object[]} assignments
 * @returns {Record<string, number>}
 */
export function providerLoadOf(assignments) {
  const load = {}
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    if (assignment === null || typeof assignment !== 'object') continue
    if (!['starting', 'running', 'recovering'].includes(assignment.status)) continue
    const provider = typeof assignment.model?.provider === 'string' ? assignment.model.provider : ''
    if (provider === '') continue
    load[provider] = (load[provider] ?? 0) + 1
    const key = providerKeyOfRoute(assignment.model)
    if (key !== null && key !== provider) load[key] = (load[key] ?? 0) + 1
  }
  return load
}

/**
 * The most specific ceiling that applies to a route, or null.
 *
 * @param {Record<string, number>} providerConcurrency
 * @param {object|null} route
 * @returns {{key: string, limit: number}|null}
 */
export function providerCeilingOf(providerConcurrency, route) {
  if (providerConcurrency === null || typeof providerConcurrency !== 'object') return null
  const key = providerKeyOfRoute(route)
  if (key === null) return null
  const exact = providerConcurrency[key]
  if (Number.isFinite(Number(exact))) return { key, limit: Number(exact) }
  const provider = typeof route?.provider === 'string' ? route.provider : ''
  const byProvider = providerConcurrency[provider]
  if (Number.isFinite(Number(byProvider))) return { key: provider, limit: Number(byProvider) }
  return null
}
