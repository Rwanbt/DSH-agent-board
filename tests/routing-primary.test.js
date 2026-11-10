import test from 'node:test'
import assert from 'node:assert/strict'

import { planPrimaryReturn, shouldReturnToPrimary } from '../src/routing/router.js'

const primary = { provider: 'primary', model: 'big', locality: 'remote' }
const backup = { provider: 'backup', model: 'medium', locality: 'remote' }
const local = { provider: 'local', model: 'small', locality: 'local' }

test('return to the primary route at a safe boundary', () => {
  const plan = planPrimaryReturn({
    policy: { routeChain: [primary, backup] },
    currentRoute: backup,
    atSafeBoundary: true,
    health: {},
    now: 1000,
  })
  assert.equal(plan.action, 'return')
  assert.equal(plan.reason, 'primary_available')
  assert.deepEqual(plan.route, primary)
  assert.equal(shouldReturnToPrimary({ policy: { routeChain: [primary, backup] }, currentRoute: backup, atSafeBoundary: true }), true)
})

test('never return while a stream is in flight (no safe boundary)', () => {
  for (const atSafeBoundary of [false, undefined, null, 0]) {
    const plan = planPrimaryReturn({
      policy: { routeChain: [primary, backup] },
      currentRoute: backup,
      atSafeBoundary,
      health: {},
      now: 1000,
    })
    assert.equal(plan.action, 'keep')
    assert.equal(plan.reason, 'not_at_safe_boundary')
    assert.deepEqual(plan.route, backup)
  }
  // The safe boundary is strict: only the boolean `true` counts.
  assert.equal(shouldReturnToPrimary({ policy: { routeChain: [primary, backup] }, currentRoute: backup, atSafeBoundary: 'yes' }), false)
})

test('keep when there is nothing to return to', () => {
  assert.deepEqual(
    planPrimaryReturn({ policy: { routeChain: [] }, currentRoute: backup, atSafeBoundary: true }),
    { action: 'keep', route: backup, reason: 'no_primary_route' },
  )
  assert.deepEqual(
    planPrimaryReturn({ policy: {}, currentRoute: backup, atSafeBoundary: true }),
    { action: 'keep', route: backup, reason: 'no_primary_route' },
  )
  assert.deepEqual(
    planPrimaryReturn({ policy: { routeChain: [primary] }, currentRoute: null, atSafeBoundary: true }),
    { action: 'keep', route: null, reason: 'no_current_route' },
  )
  assert.deepEqual(planPrimaryReturn(), { action: 'keep', route: null, reason: 'no_current_route' })
})

test('keep when the current route IS the primary', () => {
  const plan = planPrimaryReturn({
    policy: { routeChain: [primary, backup] },
    currentRoute: { provider: 'primary', model: 'big' },
    atSafeBoundary: true,
    health: {},
    now: 1000,
  })
  assert.equal(plan.action, 'keep')
  assert.equal(plan.reason, 'already_primary')
})

test('the provider allow-list still applies to the primary route', () => {
  const plan = planPrimaryReturn({
    policy: { routeChain: [primary, backup], allowedProviders: ['backup'] },
    currentRoute: backup,
    atSafeBoundary: true,
    health: {},
    now: 1000,
  })
  assert.equal(plan.action, 'keep')
  assert.equal(plan.reason, 'provider_not_allowed')
})

test('a local-only policy forbids returning to a remote primary', () => {
  const plan = planPrimaryReturn({
    policy: { routeChain: [primary], allowCloudFallback: false },
    currentRoute: local,
    atSafeBoundary: true,
    health: {},
    now: 1000,
  })
  assert.equal(plan.action, 'keep')
  assert.equal(plan.reason, 'cloud_fallback_forbidden_for_local_model')
})

test('provider cooldown blocks the return until it expires, boundary inclusive', () => {
  const health = { primary: { failures: 2, cooldownUntil: 5000 } }
  const cooling = planPrimaryReturn({
    policy: { routeChain: [primary, backup] },
    currentRoute: backup,
    atSafeBoundary: true,
    health,
    now: 4999,
  })
  assert.equal(cooling.action, 'keep')
  assert.equal(cooling.reason, 'primary_in_cooldown')
  const expired = planPrimaryReturn({
    policy: { routeChain: [primary, backup] },
    currentRoute: backup,
    atSafeBoundary: true,
    health,
    now: 5000,
  })
  assert.equal(expired.action, 'return')
})

test('planPrimaryReturn is pure: the policy, route and health inputs are not mutated', () => {
  const policy = { routeChain: [primary, backup] }
  const health = { primary: { cooldownUntil: 5000 } }
  const snapshot = JSON.stringify({ policy, health, primary, backup })
  planPrimaryReturn({ policy, currentRoute: backup, atSafeBoundary: true, health, now: 1000 })
  assert.equal(JSON.stringify({ policy, health, primary, backup }), snapshot)
})
