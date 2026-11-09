import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyFailure, parseRetryAfter, FAILURE } from '../src/routing/classify.js'
import { planRoute, backoffDelay, nextRoute, recordHealth, isRouteAllowed } from '../src/routing/router.js'

const chain = [
  { provider: 'primary', model: 'big', locality: 'remote' },
  { provider: 'backup', model: 'medium', locality: 'remote' },
  { provider: 'local', model: 'small', locality: 'local' },
]

test('classify: common provider failures', () => {
  assert.equal(classifyFailure({ status: 429 }).kind, FAILURE.RATE_LIMIT)
  assert.equal(classifyFailure({ status: 503 }).kind, FAILURE.SERVER_ERROR)
  assert.equal(classifyFailure({ code: 'ETIMEDOUT', message: 'timeout' }).kind, FAILURE.TIMEOUT)
  assert.equal(classifyFailure({ message: 'insufficient quota' }).kind, FAILURE.QUOTA)
  assert.equal(classifyFailure({ status: 401, message: 'invalid api key' }).kind, FAILURE.AUTH)
  assert.equal(classifyFailure({ message: 'maximum context length exceeded' }).kind, FAILURE.CONTEXT_OVERFLOW)
})

test('classify never turns a policy refusal or a code failure into a provider outage', () => {
  const refusal = classifyFailure({ status: 403, message: 'permission denied by policy' })
  assert.equal(refusal.kind, FAILURE.POLICY_REFUSAL)
  assert.equal(refusal.switchable, false)
  const brokenBuild = classifyFailure({ message: 'test suite failed: expected 2 received 3' })
  assert.equal(brokenBuild.kind, FAILURE.NOT_MODEL)
  assert.equal(brokenBuild.notModel, true)
  assert.equal(brokenBuild.switchable, false)
  const plan = planRoute({ failure: brokenBuild, currentRoute: chain[0], chain, policy: {} })
  assert.equal(plan.action, 'stop')
})

test('classify: an error after the first chunk requires a handoff, not a silent replay', () => {
  const failure = classifyFailure({ status: 500, afterFirstChunk: true, message: 'stream broke' })
  assert.equal(failure.requiresHandoff, true)
  const plan = planRoute({ failure, currentRoute: chain[0], chain, policy: {} })
  assert.equal(plan.action, 'handoff')
  assert.equal(plan.nextRoute.provider, 'backup')
})

test('classify: no alternate route after a partial stream is a visible blocked state', () => {
  const failure = classifyFailure({ message: 'connection reset', code: 'ECONNRESET', afterFirstChunk: true })
  const plan = planRoute({ failure, currentRoute: { provider: 'primary', model: 'big' }, chain: [], policy: {} })
  assert.equal(plan.action, 'blocked')
  assert.equal(plan.reason, 'partial_output_and_no_alt_route')
})

test('stage 1: bounded retry honours Retry-After and the retry budget', () => {
  const failure = classifyFailure({ status: 429, retryAfterMs: 4000 })
  const first = planRoute({ failure, retries: 0, currentRoute: chain[0], chain, policy: {} })
  assert.equal(first.action, 'retry')
  assert.ok(first.delayMs >= 4000)
  const exhausted = planRoute({ failure, retries: 5, currentRoute: chain[0], chain, policy: { maxRetries: 2 } })
  assert.notEqual(exhausted.action, 'retry')
})

test('backoff stays bounded and never negative', () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const delay = backoffDelay(attempt, { rng: () => 0.5 })
    assert.ok(delay >= 0)
    assert.ok(delay <= 30_000)
  }
})

test('stage 2: switch walks the chain, skips cooling providers, respects the switch budget', () => {
  const failure = classifyFailure({ status: 503 })
  const afterRetries = planRoute({ failure, retries: 2, switches: 0, currentRoute: chain[0], chain, policy: { maxSwitches: 2, maxRetries: 2 } })
  assert.equal(afterRetries.action, 'switch')
  assert.equal(afterRetries.nextRoute.provider, 'backup')

  const health = recordHealth({}, { provider: 'backup', kind: 'server_error', at: 1000, cooldownMs: 60_000, threshold: 1 })
  const cooling = nextRoute({ chain, currentRoute: chain[0], policy: {}, health, now: 2000 })
  assert.equal(cooling.route.provider, 'local')

  const exhausted = planRoute({ failure, retries: 2, switches: 2, currentRoute: chain[0], chain, policy: { maxSwitches: 2, maxRetries: 2 } })
  assert.equal(exhausted.action, 'blocked')
  assert.equal(exhausted.reason, 'max_switches_reached')
})

test('provider allow-list and local-only policy are enforced', () => {
  assert.equal(isRouteAllowed({ provider: 'ghost', model: 'm' }, { allowedProviders: ['backup'] }, chain[0]).ok, false)
  assert.equal(
    isRouteAllowed({ provider: 'cloud', model: 'm', locality: 'remote' }, { allowCloudFallback: false }, { provider: 'local', model: 'm', locality: 'local' }).reason,
    'cloud_fallback_forbidden_for_local_model',
  )
})

test('Retry-After parses seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000)
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000)
  assert.equal(parseRetryAfter(''), null)
})
