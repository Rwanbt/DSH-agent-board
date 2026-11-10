/**
 * Layered route policy: global → project → role → task, most-restrictive-wins.
 *
 * Each layer is an optional plain object. Only the route keys below are read;
 * a layer may also carry unrelated policy fields (mode, permissions, …) and
 * those are ignored. This keeps the resolver reusable by the host without
 * copying the whole board policy.
 *
 * The four layers are ordered from least to most specific. The resolution is
 * deliberately conservative:
 *   - `allowedProviders` = intersection of the non-empty lists (a route must be
 *     allowed everywhere it is mentioned);
 *   - `deniedProviders`  = union (a single refusal removes the provider);
 *   - `allowCloudFallback` = AND of the explicit booleans (absence grants
 *     nothing: an unstated layer does not forbid, but any `false` wins); a
 *     local-only project also forces it to `false`;
 *   - `locality` = `local` if any layer asks for local-only;
 *   - `maxRetries` / `maxSwitches` = minimum of the explicit values;
 *   - `cooldownMs` = maximum of the explicit values (the longest wait wins);
 *   - `routeChain` = the MOST SPECIFIC non-empty chain, then filtered by the
 *     allowed/denied sets and by local-only.
 *
 * Ill-formed input never throws: a layer that is not a plain object, an
 * unknown layer (none of the route keys), and an invalid field value are
 * ignored and recorded in `warnings` (`{ layer, code, detail }`), so the host
 * can log a decision instead of crashing on a hand-edited config.
 *
 * @module dsh-agent-board/routing/policy
 */

import { routeKey } from './router.js'

/** Layer names, least → most specific. */
export const ROUTE_POLICY_LAYERS = Object.freeze(['global', 'project', 'role', 'task'])

/** Documented defaults when no layer sets a value. */
export const ROUTE_POLICY_DEFAULTS = Object.freeze({
  allowedProviders: Object.freeze([]),
  deniedProviders: Object.freeze([]),
  providersConflict: false,
  // Absence does not forbid cloud fallback; an explicit `false` in ANY layer
  // does. The host passes the operator policy (which defaults to `false`).
  allowCloudFallback: true,
  locality: null,
  maxRetries: 2,
  maxSwitches: 2,
  cooldownMs: 60_000,
  routeChain: Object.freeze([]),
})

const ROUTE_KEYS = new Set([
  'allowedProviders',
  'deniedProviders',
  'allowCloudFallback',
  'locality',
  'localOnly',
  'maxRetries',
  'maxSwitches',
  'cooldownMs',
  'retryCooldownMs',
  'routeChain',
])

const MAX_WARNINGS = 32

/**
 * Resolve the effective route policy from four optional layers.
 *
 * @param {object} [input]
 * @param {object} [input.global]  least specific layer
 * @param {object} [input.project] project mandate
 * @param {object} [input.role]    role preset
 * @param {object} [input.task]    card-level override
 * @returns {{allowedProviders:string[], deniedProviders:string[], providersConflict:boolean,
 *   allowCloudFallback:boolean, locality:'local'|'remote'|null, maxRetries:number,
 *   maxSwitches:number, cooldownMs:number, routeChain:object[],
 *   warnings:{layer:string,code:string,detail:string}[]}}
 */
export function resolveRoutePolicy({ global, project, role, task } = {}) {
  const raw = { global, project, role, task }
  const warnings = []
  const layers = []
  for (const name of ROUTE_POLICY_LAYERS) {
    const layer = readLayer(name, raw[name], warnings)
    if (layer !== null) layers.push({ name, layer })
  }
  const ordered = layers // already least → most specific

  const values = key => ordered
    .filter(entry => entry.layer[key] !== undefined)
    .map(entry => ({ name: entry.name, value: entry.layer[key] }))

  const allowedSets = []
  for (const entry of values('allowedProviders')) {
    const list = stringList(entry.value)
    if (list === null) {
      warn(warnings, entry.name, 'invalid_value', 'allowedProviders must be an array of non-empty strings')
      continue
    }
    if (list.length > 0) allowedSets.push(list)
  }
  const deniedProviders = []
  for (const entry of values('deniedProviders')) {
    const list = stringList(entry.value)
    if (list === null) {
      warn(warnings, entry.name, 'invalid_value', 'deniedProviders must be an array of non-empty strings')
      continue
    }
    for (const provider of list) if (!deniedProviders.includes(provider)) deniedProviders.push(provider)
  }
  let allowedProviders = []
  if (allowedSets.length > 0) {
    allowedProviders = allowedSets[0].filter(provider => allowedSets.every(set => set.includes(provider)))
  }
  allowedProviders = allowedProviders.filter(provider => !deniedProviders.includes(provider))
  // `isRouteAllowed()` reads an empty allow-list as "no restriction", so a
  // disjoint intersection cannot be encoded as []. The explicit flag keeps the
  // most-restrictive meaning available to the host: when true, NO provider is
  // allowed. The chain is emptied for the same reason.
  const providersConflict = allowedSets.length > 0 && allowedProviders.length === 0
  if (providersConflict) {
    warn(warnings, 'policy', 'providers_conflict', 'allowedProviders resolves to no provider (empty intersection or all denied); no provider is allowed')
  }

  let allowCloudFallback = null
  for (const entry of values('allowCloudFallback')) {
    if (typeof entry.value !== 'boolean') {
      warn(warnings, entry.name, 'invalid_value', 'allowCloudFallback must be a boolean')
      continue
    }
    allowCloudFallback = allowCloudFallback === null ? entry.value : allowCloudFallback && entry.value
  }

  let locality = null
  for (const entry of values('locality')) {
    if (entry.value === 'local') locality = 'local'
    else if (entry.value === 'remote') locality = locality ?? 'remote'
    else warn(warnings, entry.name, 'invalid_value', "locality must be 'local' or 'remote'")
  }
  for (const entry of values('localOnly')) {
    if (entry.value === true) locality = 'local'
    else if (entry.value !== false) warn(warnings, entry.name, 'invalid_value', 'localOnly must be a boolean')
  }
  if (locality === 'local') allowCloudFallback = false
  if (allowCloudFallback === null) allowCloudFallback = ROUTE_POLICY_DEFAULTS.allowCloudFallback

  const maxRetries = minOf(values('maxRetries'), warnings, 'maxRetries', ROUTE_POLICY_DEFAULTS.maxRetries)
  const maxSwitches = minOf(values('maxSwitches'), warnings, 'maxSwitches', ROUTE_POLICY_DEFAULTS.maxSwitches)
  const cooldownMs = maxOf(
    [...values('cooldownMs'), ...values('retryCooldownMs')],
    warnings,
    'cooldownMs',
    ROUTE_POLICY_DEFAULTS.cooldownMs,
  )

  const routeChain = resolveChain(ordered, { allowedProviders, deniedProviders, locality, providersConflict }, warnings)

  return {
    allowedProviders,
    deniedProviders,
    providersConflict,
    allowCloudFallback,
    locality,
    maxRetries,
    maxSwitches,
    cooldownMs,
    routeChain,
    warnings,
  }
}

function readLayer(name, value, warnings) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    warn(warnings, name, 'layer_not_object', `expected a plain object, got ${describe(value)}`)
    return null
  }
  const keys = Object.keys(value)
  if (!keys.some(key => ROUTE_KEYS.has(key))) {
    warn(warnings, name, 'unknown_layer', 'layer has no recognised route-policy key; ignored')
    return null
  }
  return value
}

function resolveChain(ordered, { allowedProviders, deniedProviders, locality, providersConflict }, warnings) {
  if (providersConflict) return []
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const { name, layer } = ordered[index]
    if (layer.routeChain === undefined) continue
    if (!Array.isArray(layer.routeChain)) {
      warn(warnings, name, 'invalid_value', 'routeChain must be an array; ignored')
      continue
    }
    const chain = []
    const seen = new Set()
    let invalid = 0
    for (const entry of layer.routeChain) {
      const route = normalizeChainEntry(entry)
      if (route === null) {
        invalid += 1
        continue
      }
      const key = routeKey(route)
      if (seen.has(key)) continue
      seen.add(key)
      chain.push(route)
    }
    if (invalid > 0) {
      warn(warnings, name, 'invalid_value', `routeChain: ${invalid} malformed entr${invalid === 1 ? 'y' : 'ies'} ignored`)
    }
    if (chain.length === 0) continue
    const filtered = chain.filter(route => {
      if (allowedProviders.length > 0 && !allowedProviders.includes(route.provider)) return false
      if (deniedProviders.includes(route.provider)) return false
      if (locality === 'local' && route.locality !== 'local') return false
      return true
    })
    return filtered
  }
  return []
}

function normalizeChainEntry(entry) {
  if (typeof entry === 'string' && entry !== '') {
    const [provider, ...rest] = entry.split('/')
    const model = rest.join('/')
    if (provider === '' || model === '') return null
    return { provider, model, locality: 'remote' }
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (typeof entry.provider !== 'string' || entry.provider === '') return null
  if (typeof entry.model !== 'string' || entry.model === '') return null
  const route = {
    provider: entry.provider,
    model: entry.model,
    // Unknown locality is not proof of local execution: treat it as remote so
    // a local-only policy cannot be bypassed by an unlabelled chain entry.
    locality: entry.locality === 'local' ? 'local' : 'remote',
  }
  if (typeof entry.reasoningEffort === 'string' && entry.reasoningEffort !== '') {
    route.reasoningEffort = entry.reasoningEffort
  }
  return route
}

function stringList(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

function minOf(entries, warnings, label, fallback) {
  let result = null
  for (const entry of entries) {
    const number = nonNegativeInteger(entry.value)
    if (number === null) {
      warn(warnings, entry.name, 'invalid_value', `${label} must be a non-negative integer`)
      continue
    }
    result = result === null ? number : Math.min(result, number)
  }
  return result === null ? fallback : result
}

function maxOf(entries, warnings, label, fallback) {
  let result = null
  for (const entry of entries) {
    const number = nonNegativeInteger(entry.value)
    if (number === null) {
      warn(warnings, entry.name, 'invalid_value', `${label} must be a non-negative integer`)
      continue
    }
    result = result === null ? number : Math.max(result, number)
  }
  return result === null ? fallback : result
}

function nonNegativeInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return Math.trunc(number)
}

function warn(warnings, layer, code, detail) {
  if (warnings.length >= MAX_WARNINGS) return
  warnings.push({ layer, code, detail: String(detail).slice(0, 200) })
}

function describe(value) {
  if (Array.isArray(value)) return 'array'
  return typeof value
}
