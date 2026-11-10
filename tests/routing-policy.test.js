import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveRoutePolicy, ROUTE_POLICY_DEFAULTS } from '../src/routing/policy.js'

test('empty input resolves to the documented defaults', () => {
  assert.deepEqual(resolveRoutePolicy(), {
    allowedProviders: [],
    deniedProviders: [],
    providersConflict: false,
    allowCloudFallback: ROUTE_POLICY_DEFAULTS.allowCloudFallback,
    locality: null,
    maxRetries: 2,
    maxSwitches: 2,
    cooldownMs: 60_000,
    routeChain: [],
    warnings: [],
  })
})

test('allowedProviders is the intersection of the non-empty lists, in the first layer order', () => {
  const policy = resolveRoutePolicy({
    global: { allowedProviders: ['c', 'a', 'b'] },
    project: { allowedProviders: ['a', 'c'] },
    role: { allowedProviders: [] }, // empty = no restriction, ignored
    task: { allowedProviders: ['c'] },
  })
  assert.deepEqual(policy.allowedProviders, ['c'])
  assert.equal(policy.providersConflict, false)
  assert.deepEqual(policy.warnings, [])
})

test('a disjoint allow-list intersection allows NO provider and says so', () => {
  const policy = resolveRoutePolicy({
    global: { allowedProviders: ['a'], routeChain: [{ provider: 'a', model: 'm' }] },
    project: { allowedProviders: ['b'] },
  })
  assert.deepEqual(policy.allowedProviders, [])
  assert.equal(policy.providersConflict, true)
  assert.deepEqual(policy.routeChain, [], 'the chain cannot be used when no provider is allowed')
  assert.ok(policy.warnings.some(w => w.code === 'providers_conflict'))
})

test('deniedProviders is the union and removes providers from the allow-list', () => {
  const policy = resolveRoutePolicy({
    global: { allowedProviders: ['x', 'y', 'z'], deniedProviders: ['y'] },
    role: { deniedProviders: ['z', 'y'] },
  })
  assert.deepEqual(policy.allowedProviders, ['x'])
  assert.deepEqual(policy.deniedProviders, ['y', 'z'])
})

test('allowCloudFallback is the AND of the explicit booleans; absence grants nothing', () => {
  assert.equal(resolveRoutePolicy({}).allowCloudFallback, true)
  assert.equal(resolveRoutePolicy({ global: { allowCloudFallback: true }, project: { allowCloudFallback: true } }).allowCloudFallback, true)
  assert.equal(resolveRoutePolicy({ global: { allowCloudFallback: true }, project: { allowCloudFallback: false } }).allowCloudFallback, false)
  assert.equal(resolveRoutePolicy({ task: { allowCloudFallback: false } }).allowCloudFallback, false)
})

test('locality stays local if any layer asks for it, and forbids cloud fallback', () => {
  const local = resolveRoutePolicy({
    global: { allowCloudFallback: true },
    role: { locality: 'local' },
  })
  assert.equal(local.locality, 'local')
  assert.equal(local.allowCloudFallback, false, 'local-only is stricter than allowCloudFallback:true')
  assert.equal(resolveRoutePolicy({ global: { locality: 'remote' }, task: { localOnly: true } }).locality, 'local')
  assert.equal(resolveRoutePolicy({ global: { locality: 'remote' } }).locality, 'remote')
})

test('maxRetries and maxSwitches take the minimum; cooldown takes the maximum', () => {
  const policy = resolveRoutePolicy({
    global: { maxRetries: 4, maxSwitches: 4, cooldownMs: 1000 },
    project: { maxRetries: 1 },
    role: { maxSwitches: 0 },
    task: { cooldownMs: 5000 },
  })
  assert.equal(policy.maxRetries, 1)
  assert.equal(policy.maxSwitches, 0)
  assert.equal(policy.cooldownMs, 5000)
  // `retryCooldownMs` is accepted as an alias for the host policy key.
  assert.equal(resolveRoutePolicy({ global: { retryCooldownMs: 2000 } }).cooldownMs, 2000)
})

test('routeChain is the most specific non-empty chain', () => {
  const global = { provider: 'g', model: 'g1' }
  const project = { provider: 'p', model: 'p1' }
  const task = { provider: 't', model: 't1' }
  assert.deepEqual(
    resolveRoutePolicy({ global: { routeChain: [global] }, project: { routeChain: [project] }, task: { routeChain: [task] } }).routeChain,
    [{ ...task, locality: 'remote' }],
  )
  assert.deepEqual(
    resolveRoutePolicy({ global: { routeChain: [global] }, project: { routeChain: [project] } }).routeChain,
    [{ ...project, locality: 'remote' }],
  )
})

test('routeChain is filtered by the allowed/denied sets and by local-only', () => {
  const remoteA = { provider: 'a', model: 'm', locality: 'remote' }
  const remoteB = { provider: 'b', model: 'm', locality: 'remote' }
  const localC = { provider: 'c', model: 'm', locality: 'local' }
  assert.deepEqual(
    resolveRoutePolicy({ global: { allowedProviders: ['b'], routeChain: [remoteA, remoteB] } }).routeChain,
    [remoteB],
  )
  assert.deepEqual(
    resolveRoutePolicy({ global: { deniedProviders: ['a'], routeChain: [remoteA, remoteB] } }).routeChain,
    [remoteB],
  )
  assert.deepEqual(
    resolveRoutePolicy({ global: { routeChain: [remoteA, localC] }, task: { locality: 'local' } }).routeChain,
    [localC],
  )
  // Filtering can legitimately empty the chain (the planner then blocks).
  assert.deepEqual(
    resolveRoutePolicy({ global: { allowedProviders: ['b'], routeChain: [remoteA] } }).routeChain,
    [],
  )
})

test('routeChain accepts "provider/model" strings and de-duplicates routes', () => {
  const chain = resolveRoutePolicy({ global: { routeChain: ['a/m1', 'b/m2', 'a/m1'] } }).routeChain
  assert.deepEqual(chain, [
    { provider: 'a', model: 'm1', locality: 'remote' },
    { provider: 'b', model: 'm2', locality: 'remote' },
  ])
})

test('a chain whose entries are all malformed falls back to the less specific layer', () => {
  const project = { provider: 'p', model: 'p1', locality: 'local' }
  const policy = resolveRoutePolicy({
    project: { routeChain: [project] },
    task: { routeChain: [null, { provider: 'x' }, 42] },
  })
  assert.deepEqual(policy.routeChain, [project])
  assert.ok(policy.warnings.some(w => w.layer === 'task' && w.code === 'invalid_value'))
})

test('ill-formed layers and values are ignored with a warning, never thrown', () => {
  const policy = resolveRoutePolicy({
    global: 'nope',
    project: [],
    role: {},
    task: { foo: 1 },
  })
  assert.deepEqual(policy.allowedProviders, [])
  assert.deepEqual(
    policy.warnings.map(w => `${w.layer}:${w.code}`).sort(),
    ['global:layer_not_object', 'project:layer_not_object', 'role:unknown_layer', 'task:unknown_layer'],
  )
})

test('ill-formed field values are ignored and do not poison the other layers', () => {
  const policy = resolveRoutePolicy({
    global: { allowedProviders: 'a', maxRetries: 'x', allowCloudFallback: 'false', locality: 'moon' },
    project: { maxRetries: 3, allowedProviders: ['a', 'b'] },
  })
  assert.deepEqual(policy.allowedProviders, ['a', 'b'])
  assert.equal(policy.maxRetries, 3)
  assert.equal(policy.allowCloudFallback, true)
  assert.equal(policy.locality, null)
  assert.ok(policy.warnings.some(w => w.layer === 'global' && w.code === 'invalid_value'))
})

test('unrelated policy keys on a recognised layer are ignored without noise', () => {
  const policy = resolveRoutePolicy({ global: { allowedProviders: ['a'], mode: 'off', maxConcurrent: 4 } })
  assert.deepEqual(policy.allowedProviders, ['a'])
  assert.deepEqual(policy.warnings, [])
})

test('resolveRoutePolicy never mutates or throws on garbage input', () => {
  const layers = {
    global: { allowedProviders: ['a'], routeChain: [{ provider: 'a', model: 'm' }] },
    project: { maxRetries: 1 },
    role: null,
    task: undefined,
  }
  const snapshot = JSON.stringify(layers)
  const first = resolveRoutePolicy(layers)
  assert.equal(JSON.stringify(layers), snapshot)
  assert.equal(first.maxRetries, 1)
  // Non-object / cyclic-ish junk still resolves.
  assert.doesNotThrow(() => resolveRoutePolicy({ global: 42, project: () => {}, role: Symbol('x') }))
})
