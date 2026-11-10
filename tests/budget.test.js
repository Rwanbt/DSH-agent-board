import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BUDGET_DEFAULTS,
  HOURLY_WINDOW_MS,
  METERING_UNAVAILABLE_REASON,
  consume,
  describeBudget,
  resolveBudgetLimits,
} from '../src/routing/budget.js'

const NOW = 10_000_000
const HOUR = HOURLY_WINDOW_MS

test('defaults are the documented ceilings', () => {
  assert.deepEqual(resolveBudgetLimits(), BUDGET_DEFAULTS)
  assert.equal(HOURLY_WINDOW_MS, 3_600_000)
  assert.deepEqual(
    resolveBudgetLimits({ maxConcurrent: 3, autonomyBudget: { maxTasksPerHour: 9 }, requestsPerHour: 70, maxRetries: 1, maxSwitches: 0, cooldownMs: 30_000 }),
    { maxConcurrent: 3, tasksPerHour: 9, requestsPerHour: 70, maxRetries: 1, maxSwitches: 0, cooldownMs: 30_000 },
  )
  // `retryCooldownMs` is accepted as an alias for the host policy key.
  assert.equal(resolveBudgetLimits({ retryCooldownMs: 1234 }).cooldownMs, 1234)
})

test('concurrency: start is bounded, release frees the slot, input stays pure', () => {
  const base = { limits: resolveBudgetLimits({ maxConcurrent: 2 }) }
  const first = consume(base, { kind: 'start' }, NOW)
  assert.equal(first.ok, true)
  assert.equal(first.usage.concurrent, 1)
  const second = consume(first.usage, { kind: 'start' }, NOW)
  assert.equal(second.usage.concurrent, 2)
  const refused = consume(second.usage, { kind: 'start' }, NOW)
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'concurrency_limit')
  assert.equal(refused.usage.concurrent, 2, 'a refused event consumes nothing')
  const released = consume(refused.usage, { kind: 'release' }, NOW)
  assert.equal(released.ok, true)
  assert.equal(released.reason, 'released')
  assert.equal(released.usage.concurrent, 1)
  assert.equal(consume({ concurrent: 0 }, { kind: 'release' }, NOW).usage.concurrent, 0, 'release never goes negative')
  assert.equal(base.concurrent, undefined, 'the input usage was not mutated')
})

test('tasksPerHour slides at the hour boundary', () => {
  const limits = resolveBudgetLimits({ tasksPerHour: 1 })
  // An entry exactly one window old is outside the sliding window.
  const boundary = consume({ limits, tasks: [NOW - HOUR] }, { kind: 'task' }, NOW)
  assert.equal(boundary.ok, true)
  assert.deepEqual(boundary.usage.tasks, [NOW])
  // One millisecond younger is inside the window and consumes the slot.
  const inside = consume({ limits, tasks: [NOW - HOUR + 1] }, { kind: 'task' }, NOW)
  assert.equal(inside.ok, false)
  assert.equal(inside.reason, 'tasks_per_hour_exhausted')
  assert.deepEqual(inside.usage.tasks, [NOW - HOUR + 1])
})

test('requestsPerHour is counted independently from tasks', () => {
  const limits = resolveBudgetLimits({ requestsPerHour: 2, tasksPerHour: 10 })
  let usage = { limits }
  usage = consume(usage, { kind: 'request' }, NOW).usage
  usage = consume(usage, { kind: 'request' }, NOW).usage
  const refused = consume(usage, { kind: 'request' }, NOW)
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'requests_per_hour_exhausted')
  assert.equal(consume(usage, { kind: 'task' }, NOW).ok, true, 'the task window is untouched')
})

test('retry and switch counters are bounded and refused events are not counted', () => {
  const limits = resolveBudgetLimits({ maxRetries: 1, maxSwitches: 1, cooldownMs: 0 })
  const retry = consume({ limits }, { kind: 'retry' }, NOW)
  assert.equal(retry.ok, true)
  const retryRefused = consume(retry.usage, { kind: 'retry' }, NOW)
  assert.equal(retryRefused.ok, false)
  assert.equal(retryRefused.reason, 'max_retries_reached')
  assert.equal(retryRefused.usage.retries, 1)

  const switchOk = consume({ limits }, { kind: 'switch' }, NOW)
  assert.equal(switchOk.ok, true)
  const switchRefused = consume(switchOk.usage, { kind: 'switch' }, NOW)
  assert.equal(switchRefused.reason, 'max_switches_reached')
  assert.equal(switchRefused.usage.switches, 1)
})

test('the cooldown applies to retries/switches and expires inclusively', () => {
  const limits = resolveBudgetLimits({ maxRetries: 5, cooldownMs: 5000 })
  const cooling = consume({ limits, lastFailureAt: 1000 }, { kind: 'retry' }, 5999)
  assert.equal(cooling.ok, false)
  assert.equal(cooling.reason, 'cooldown_active')
  const ready = consume({ limits, lastFailureAt: 1000 }, { kind: 'retry' }, 6000)
  assert.equal(ready.ok, true)
  // An explicit failureAt wins over the recorded one.
  const overridden = consume({ limits, lastFailureAt: 1000 }, { kind: 'switch', failureAt: 4000 }, 5000)
  assert.equal(overridden.ok, false)
  assert.equal(overridden.reason, 'cooldown_active')
})

test('a failure event records the timestamp the cooldown is measured from', () => {
  const recorded = consume({}, { kind: 'failure', at: 42 }, NOW)
  assert.equal(recorded.ok, true)
  assert.equal(recorded.reason, 'recorded')
  assert.equal(recorded.usage.lastFailureAt, 42)
  assert.equal(recorded.usage.lastEventAt, 42)
})

test('an unknown event kind is refused, never silently counted', () => {
  const result = consume({ retries: 1, switches: 1 }, { kind: 'teleport' }, NOW)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown_event_kind')
  assert.equal(result.usage.retries, 1)
  assert.equal(result.usage.switches, 1)
})

test('describeBudget returns the serialisable snapshot the API/UI consumes', () => {
  const usage = {
    limits: resolveBudgetLimits({ maxConcurrent: 3, tasksPerHour: 5, requestsPerHour: 10, maxRetries: 2, maxSwitches: 2, cooldownMs: 60_000 }),
    concurrent: 1,
    tasks: [NOW - 1000, NOW - 2000, NOW - HOUR],
    requests: [NOW - 5000],
    retries: 1,
    switches: 0,
    lastFailureAt: NOW - 1000,
  }
  const snapshot = describeBudget({}, usage, NOW)
  assert.deepEqual(snapshot.limits, {
    maxConcurrent: 3, tasksPerHour: 5, requestsPerHour: 10, maxRetries: 2, maxSwitches: 2, cooldownMs: 60_000,
  })
  assert.deepEqual(snapshot.used, {
    concurrency: 1,
    tasksLastHour: 2,
    requestsLastHour: 1,
    retries: 1,
    switches: 0,
    cooldownRemainingMs: 59_000,
  })
  assert.deepEqual(snapshot.remaining, { concurrency: 2, tasks: 3, requests: 9, retries: 1, switches: 2 })
  assert.deepEqual(snapshot.window, { durationMs: HOUR, from: NOW - HOUR, to: NOW })
  assert.equal(snapshot.enforceable.tokens, false)
  assert.equal(snapshot.enforceable.cost, false)
  // Pure JSON: round-trips without loss and without throwing.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  // The usage input is not mutated.
  assert.equal(usage.concurrent, 1)
  assert.equal(usage.tasks.length, 3)
})

test('describeBudget reports token/cost as unavailable unless real metering is supplied', () => {
  const unavailable = describeBudget({}, { concurrent: 0 }, NOW)
  assert.deepEqual(unavailable.metering.tokens, { available: false, reason: METERING_UNAVAILABLE_REASON })
  assert.deepEqual(unavailable.metering.cost, { available: false, reason: METERING_UNAVAILABLE_REASON })

  const partial = describeBudget({}, { tokens: { used: 'lots', limit: 10 } }, NOW)
  assert.deepEqual(partial.metering.tokens, { available: false, reason: METERING_UNAVAILABLE_REASON })

  const metered = describeBudget({}, {
    tokens: { used: 1200, limit: 10_000 },
    cost: { used: 1.5, limit: 10, currency: 'EUR' },
  }, NOW)
  assert.deepEqual(metered.metering.tokens, { available: true, unit: 'tokens', used: 1200, limit: 10_000, remaining: 8800 })
  assert.deepEqual(metered.metering.cost, { available: true, unit: 'usd', used: 1.5, limit: 10, remaining: 8.5, currency: 'EUR' })
})

test('describeBudget accepts the board policy shape (autonomyBudget/maxConcurrent)', () => {
  const snapshot = describeBudget({ maxConcurrent: 4, maxRetries: 1, autonomyBudget: { maxTasksPerHour: 3 } }, {}, NOW)
  assert.equal(snapshot.limits.maxConcurrent, 4)
  assert.equal(snapshot.limits.tasksPerHour, 3)
  assert.equal(snapshot.limits.maxRetries, 1)
  assert.equal(snapshot.limits.requestsPerHour, BUDGET_DEFAULTS.requestsPerHour)
  assert.equal(snapshot.used.tasksLastHour, 0)
})
