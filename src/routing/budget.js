/**
 * Bounded budgets for autonomous routing: concurrency, tasks/hour,
 * requests/hour, retry and switch counters, and the retry cooldown.
 *
 * Scope honesty: these are the ceilings the board can actually enforce,
 * because it owns the launch, request and retry paths. TOKEN and MONETARY
 * budgets are NOT enforceable here — providers expose no trustworthy
 * per-request meter to the board, and the board never writes a ledger. The
 * snapshot therefore reports those metrics as
 * `{ available: false, reason: 'provider_metering_unavailable' }` unless the
 * host supplies real metering data; even then it is an observation, not a
 * guarantee.
 *
 * Everything is pure: `consume()` returns a NEW usage object and never mutates
 * the one it receives. Hourly windows slide on the supplied `now`, so tests
 * never need a timer.
 *
 * Usage shape (plain JSON, safe for the journal):
 *   {
 *     limits: { maxConcurrent, tasksPerHour, requestsPerHour, maxRetries,
 *               maxSwitches, cooldownMs },
 *     concurrent: number,
 *     tasks: number[],        // launch timestamps inside the current hour
 *     requests: number[],     // provider-request timestamps inside the hour
 *     retries: number,
 *     switches: number,
 *     lastEventAt: number|null,
 *     lastFailureAt: number|null,
 *   }
 *
 * @module dsh-agent-board/routing/budget
 */

const HOUR_MS = 3_600_000

/** Sliding window used by every hourly ceiling. */
export const HOURLY_WINDOW_MS = HOUR_MS

/** Documented defaults. The host may override every one through the policy. */
export const BUDGET_DEFAULTS = Object.freeze({
  maxConcurrent: 2,
  tasksPerHour: 6,
  requestsPerHour: 120,
  maxRetries: 2,
  maxSwitches: 2,
  cooldownMs: 60_000,
})

/** Reason reported for a metric the provider cannot substantiate. */
export const METERING_UNAVAILABLE_REASON = 'provider_metering_unavailable'

/**
 * Normalise a policy (or a bare limits object) into the numeric budget limits.
 * Unknown/invalid values fall back to the documented defaults.
 *
 * @param {object} [policy]
 * @returns {{maxConcurrent:number, tasksPerHour:number, requestsPerHour:number,
 *   maxRetries:number, maxSwitches:number, cooldownMs:number}}
 */
export function resolveBudgetLimits(policy = {}) {
  const source = policy !== null && typeof policy === 'object' ? policy : {}
  const autonomy = source.autonomyBudget !== null && typeof source.autonomyBudget === 'object'
    ? source.autonomyBudget
    : {}
  return {
    maxConcurrent: limitOf(source.maxConcurrent, BUDGET_DEFAULTS.maxConcurrent),
    tasksPerHour: limitOf(source.tasksPerHour ?? autonomy.maxTasksPerHour, BUDGET_DEFAULTS.tasksPerHour),
    requestsPerHour: limitOf(source.requestsPerHour, BUDGET_DEFAULTS.requestsPerHour),
    maxRetries: limitOf(source.maxRetries, BUDGET_DEFAULTS.maxRetries),
    maxSwitches: limitOf(source.maxSwitches, BUDGET_DEFAULTS.maxSwitches),
    cooldownMs: limitOf(source.cooldownMs ?? source.retryCooldownMs, BUDGET_DEFAULTS.cooldownMs),
  }
}

/**
 * Count one event against the budget, or refuse it without counting.
 *
 * Events (`event.kind`):
 *   'start'   acquire a concurrency slot          → refused: `concurrency_limit`
 *   'release' release a slot                       → never refused (`released`)
 *   'task'    record a task launch                 → `tasks_per_hour_exhausted`
 *   'request' record one provider request          → `requests_per_hour_exhausted`
 *   'retry'   record a same-route retry            → `max_retries_reached` |
 *                                                    `cooldown_active`
 *   'switch'  record a provider switch             → `max_switches_reached` |
 *                                                    `cooldown_active`
 *   'failure' record a failure timestamp for the cooldown (`recorded`)
 *
 * `event.at` defaults to `now`. `event.failureAt` overrides `usage.lastFailureAt`
 * for the cooldown check. `event.limits` overrides `usage.limits` for one call.
 * An unknown event kind is refused (`unknown_event_kind`), never silently
 * counted.
 *
 * @param {object} usage
 * @param {{kind:string, at?:number, failureAt?:number, limits?:object}} event
 * @param {number} [now]
 * @returns {{ok:boolean, reason:string, usage:object}}
 */
export function consume(usage, event, now = Date.now()) {
  const source = normalizeUsage(usage)
  const limits = resolveBudgetLimits(event?.limits ?? source.limits)
  const current = { ...source, limits, ...pruneUsage(source, now) }
  const at = Number.isFinite(Number(event?.at)) ? Number(event.at) : now
  const kind = typeof event?.kind === 'string' ? event.kind : ''

  switch (kind) {
    case 'start': {
      if (current.concurrent >= limits.maxConcurrent) {
        return { ok: false, reason: 'concurrency_limit', usage: current }
      }
      return { ok: true, reason: 'ok', usage: { ...current, concurrent: current.concurrent + 1, lastEventAt: at } }
    }
    case 'release': {
      return { ok: true, reason: 'released', usage: { ...current, concurrent: Math.max(0, current.concurrent - 1), lastEventAt: at } }
    }
    case 'task': {
      if (current.tasks.length >= limits.tasksPerHour) {
        return { ok: false, reason: 'tasks_per_hour_exhausted', usage: current }
      }
      return { ok: true, reason: 'ok', usage: { ...current, tasks: [...current.tasks, at], lastEventAt: at } }
    }
    case 'request': {
      if (current.requests.length >= limits.requestsPerHour) {
        return { ok: false, reason: 'requests_per_hour_exhausted', usage: current }
      }
      return { ok: true, reason: 'ok', usage: { ...current, requests: [...current.requests, at], lastEventAt: at } }
    }
    case 'retry': {
      if (current.retries >= limits.maxRetries) {
        return { ok: false, reason: 'max_retries_reached', usage: current }
      }
      const cooling = cooldownRefusal(current, event, limits, now)
      if (cooling !== null) return { ok: false, reason: cooling, usage: current }
      return { ok: true, reason: 'ok', usage: { ...current, retries: current.retries + 1, lastEventAt: at } }
    }
    case 'switch': {
      if (current.switches >= limits.maxSwitches) {
        return { ok: false, reason: 'max_switches_reached', usage: current }
      }
      const cooling = cooldownRefusal(current, event, limits, now)
      if (cooling !== null) return { ok: false, reason: cooling, usage: current }
      return { ok: true, reason: 'ok', usage: { ...current, switches: current.switches + 1, lastEventAt: at } }
    }
    case 'failure': {
      return { ok: true, reason: 'recorded', usage: { ...current, lastFailureAt: at, lastEventAt: at } }
    }
    default:
      return { ok: false, reason: 'unknown_event_kind', usage: current }
  }
}

/**
 * Serialisable snapshot for the HTTP API / the panel.
 *
 * @param {object} policy  board policy or a bare limits object
 * @param {object} usage
 * @param {number} [now]
 * @returns {object} plain JSON: limits, used, remaining, window, metering,
 *   enforceable flags. Token/cost metrics are `{available:false, reason}` when
 *   the provider supplies no real data.
 */
export function describeBudget(policy, usage, now = Date.now()) {
  const source = normalizeUsage(usage)
  const limits = resolveBudgetLimits({ ...(source.limits ?? {}), ...(policy ?? {}) })
  const current = { ...source, limits, ...pruneUsage(source, now) }
  const cooldownRemainingMs = Number.isFinite(current.lastFailureAt)
    ? Math.max(0, limits.cooldownMs - Math.max(0, now - current.lastFailureAt))
    : 0
  return {
    at: now,
    window: { durationMs: HOURLY_WINDOW_MS, from: now - HOURLY_WINDOW_MS, to: now },
    limits,
    used: {
      concurrency: current.concurrent,
      tasksLastHour: current.tasks.length,
      requestsLastHour: current.requests.length,
      retries: current.retries,
      switches: current.switches,
      cooldownRemainingMs,
    },
    remaining: {
      concurrency: Math.max(0, limits.maxConcurrent - current.concurrent),
      tasks: Math.max(0, limits.tasksPerHour - current.tasks.length),
      requests: Math.max(0, limits.requestsPerHour - current.requests.length),
      retries: Math.max(0, limits.maxRetries - current.retries),
      switches: Math.max(0, limits.maxSwitches - current.switches),
    },
    // The board can enforce these ceilings itself: it owns the paths.
    enforceable: {
      concurrency: true,
      tasksPerHour: true,
      requestsPerHour: true,
      maxRetries: true,
      maxSwitches: true,
      cooldownMs: true,
      tokens: false,
      cost: false,
    },
    metering: {
      tokens: meteringSnapshot(source.tokens, { unit: 'tokens' }),
      cost: meteringSnapshot(source.cost, { unit: 'usd', currency: true }),
    },
  }
}

function meteringSnapshot(raw, { unit, currency = false }) {
  const unavailable = { available: false, reason: METERING_UNAVAILABLE_REASON }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unavailable
  const used = Number(raw.used)
  const limit = Number(raw.limit)
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit < 0) return unavailable
  const snapshot = { available: true, unit, used, limit, remaining: Math.max(0, limit - used) }
  if (currency) snapshot.currency = typeof raw.currency === 'string' && raw.currency !== '' ? raw.currency : 'USD'
  return snapshot
}

function cooldownRefusal(current, event, limits, now) {
  if (!(limits.cooldownMs > 0)) return null
  const failureAt = Number.isFinite(Number(event?.failureAt)) ? Number(event.failureAt) : current.lastFailureAt
  if (!Number.isFinite(failureAt)) return null
  const elapsed = now - failureAt
  // Elapsed time is allowed: at exactly cooldownMs the wait is over.
  return elapsed < limits.cooldownMs ? 'cooldown_active' : null
}

function normalizeUsage(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {}
  return {
    limits: source.limits !== null && typeof source.limits === 'object' ? { ...source.limits } : null,
    concurrent: nonNegativeNumber(source.concurrent, 0),
    tasks: timestampList(source.tasks),
    requests: timestampList(source.requests),
    retries: nonNegativeNumber(source.retries, 0),
    switches: nonNegativeNumber(source.switches, 0),
    lastEventAt: finiteOrNull(source.lastEventAt),
    lastFailureAt: finiteOrNull(source.lastFailureAt),
    tokens: source.tokens !== null && typeof source.tokens === 'object' ? { ...source.tokens } : null,
    cost: source.cost !== null && typeof source.cost === 'object' ? { ...source.cost } : null,
  }
}

/** Drop hourly entries that fell out of the sliding window (pure). */
function pruneUsage(usage, now) {
  const cutoff = now - HOURLY_WINDOW_MS
  return {
    tasks: usage.tasks.filter(at => at > cutoff),
    requests: usage.requests.filter(at => at > cutoff),
  }
}

function timestampList(value) {
  if (!Array.isArray(value)) return []
  return value.map(Number).filter(Number.isFinite)
}

function limitOf(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.trunc(number)
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  return Math.trunc(number)
}

function finiteOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
