/**
 * Route planning for the three fallback stages:
 *   1. bounded retry on the same route (429/5xx/timeout/transport, Retry-After),
 *   2. model/provider switch through an explicit chain (capabilities, budget,
 *      allowed providers, cooldown),
 *   3. task checkpoint + handoff when the in-flight request cannot be repaired
 *      (an error after the first streamed chunk, an exhausted chain).
 *
 * Honest limits, encoded here rather than hidden:
 *   - a partial stream is never reported as "resumed in the same request";
 *   - a policy/safety refusal is never bypassed through an alternate provider;
 *   - a code/CI failure is not a model failure (`classifyFailure` marks it);
 *   - a local-only project can forbid cloud fallback.
 *
 * @module dsh-agent-board/routing/router
 */

export function routeKey(route) {
  if (route === null || typeof route !== 'object') return 'unknown/unknown'
  return `${route.provider ?? 'unknown'}/${route.model ?? 'unknown'}`
}

export function backoffDelay(attempt, { baseMs = 500, capMs = 30_000, retryAfterMs = null, rng = Math.random } = {}) {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  const jitter = Math.floor(exponential * 0.2 * rng())
  const chosen = Math.max(exponential + jitter, Number(retryAfterMs) || 0)
  return Math.min(capMs, chosen)
}

export function isRouteAllowed(route, policy, fromRoute) {
  // A DENY-list wins over everything: the layered resolver reports it, and a
  // pinned card model must not be able to reach a denied provider.
  const denied = Array.isArray(policy?.deniedProviders) ? policy.deniedProviders : []
  if (denied.length > 0 && denied.includes(route.provider)) return { ok: false, reason: 'provider_denied' }
  // A local-only layer forbids ANY remote route, even when `fromRoute` is not
  // itself local (a launch has no previous route).
  if (policy?.locality === 'local' && route.locality === 'remote') return { ok: false, reason: 'local_only_route_required' }
  const allowed = Array.isArray(policy?.allowedProviders) ? policy.allowedProviders : []
  if (allowed.length > 0 && !allowed.includes(route.provider)) return { ok: false, reason: 'provider_not_allowed' }
  const fromLocal = fromRoute?.locality === 'local'
  if (route.locality === 'remote' && fromLocal && policy?.allowCloudFallback === false) {
    return { ok: false, reason: 'cloud_fallback_forbidden_for_local_model' }
  }
  return { ok: true, reason: 'allowed' }
}

export function cooldownActive(health, provider, now) {
  const entry = health?.[provider]
  const until = Number(entry?.cooldownUntil)
  return Number.isFinite(until) && until > now
}

/**
 * Choose the next route in the chain.
 * @returns {{route: object|null, reason: string}}
 */
export function nextRoute({ chain, currentRoute, policy, health, now, tried = [] }) {
  const currentKey = routeKey(currentRoute)
  for (const candidate of chain ?? []) {
    const key = routeKey(candidate)
    if (key === currentKey) continue
    if (tried.includes(key)) continue
    const allowed = isRouteAllowed(candidate, policy, currentRoute)
    if (!allowed.ok) continue
    if (cooldownActive(health, candidate.provider, now)) continue
    return { route: candidate, reason: 'chain_next' }
  }
  return { route: null, reason: 'chain_exhausted' }
}

/**
 * The single routing decision after a failure.
 *
 * @param {object} input
 * @param {object} input.failure      output of classifyFailure()
 * @param {number} [input.retries]    same-route retries already spent
 * @param {number} [input.switches]   provider switches already spent
 * @param {object} [input.currentRoute]
 * @param {object[]} [input.chain]
 * @param {object} input.policy
 * @param {object} [input.health]
 * @param {number} [input.now]
 * @param {string[]} [input.triedRoutes]
 * @returns {{action:'retry'|'switch'|'handoff'|'stop'|'blocked', delayMs:number, nextRoute:object|null, reason:string, cooldownUntil:number|null}}
 */
export function planRoute({
  failure,
  retries = 0,
  switches = 0,
  currentRoute,
  chain = [],
  policy = {},
  health = {},
  now = Date.now(),
  triedRoutes = [],
  rng = Math.random,
}) {
  const maxRetries = Number.isFinite(Number(policy.maxRetries)) ? Number(policy.maxRetries) : 2
  const maxSwitches = Number.isFinite(Number(policy.maxSwitches)) ? Number(policy.maxSwitches) : 2

  if (failure?.notModel === true) {
    return { action: 'stop', delayMs: 0, nextRoute: null, reason: `not_a_model_failure:${failure.kind}`, cooldownUntil: null }
  }
  if (failure?.switchable === false && failure?.retryable === false) {
    return { action: 'stop', delayMs: 0, nextRoute: null, reason: `not_switchable:${failure?.kind ?? 'unknown'}`, cooldownUntil: null }
  }

  const candidate = nextRoute({ chain, currentRoute, policy, health, now, tried: triedRoutes })
  const next = candidate.route

  // Stage 3 first for a stream that already produced output: the same request
  // cannot be replayed, so the TASK is handed off to a compatible session.
  // The switch budget still applies: a handoff to another route IS a switch.
  if (failure?.requiresHandoff === true) {
    if (switches >= maxSwitches) {
      return { action: 'blocked', delayMs: 0, nextRoute: null, reason: 'max_switches_reached', cooldownUntil: null }
    }
    if (next !== null) {
      return { action: 'handoff', delayMs: 0, nextRoute: next, reason: `partial_output_handoff:${failure.kind}`, cooldownUntil: null }
    }
    return { action: 'blocked', delayMs: 0, nextRoute: null, reason: 'partial_output_and_no_alt_route', cooldownUntil: null }
  }

  // Stage 1: bounded same-route retry.
  if (failure?.retryable === true && retries < maxRetries) {
    const delayMs = backoffDelay(retries, { retryAfterMs: failure.retryAfterMs, rng })
    return {
      action: 'retry',
      delayMs,
      nextRoute: null,
      reason: `retry_${failure.kind}`,
      cooldownUntil: failure.kind === 'rate_limit' ? now + delayMs : null,
    }
  }

  // Stage 2: switch route within policy, cooldown and switch budget.
  if (failure?.switchable === true && switches < maxSwitches) {
    if (next !== null) {
      return { action: 'switch', delayMs: 0, nextRoute: next, reason: `switch_after_${failure.kind}`, cooldownUntil: null }
    }
    return { action: 'blocked', delayMs: 0, nextRoute: null, reason: candidate.reason, cooldownUntil: null }
  }

  if (switches >= maxSwitches) {
    return { action: 'blocked', delayMs: 0, nextRoute: null, reason: 'max_switches_reached', cooldownUntil: null }
  }
  return { action: 'blocked', delayMs: 0, nextRoute: null, reason: `no_recovery_for_${failure?.kind ?? 'unknown'}`, cooldownUntil: null }
}

/** Record one provider health event; returns the next health table (pure copy). */
export function recordHealth(health, { provider, kind, at = Date.now(), cooldownMs = 60_000, threshold = 2 }) {
  const table = { ...(health ?? {}) }
  const current = table[provider] ?? { failures: 0, cooldownUntil: null }
  const failures = current.failures + 1
  table[provider] = {
    failures,
    lastFailureKind: kind,
    lastFailureAt: at,
    cooldownUntil: failures >= threshold ? at + cooldownMs : current.cooldownUntil ?? null,
  }
  return table
}

/** Returning to the primary is only allowed at a safe boundary (a finished turn). */
export function shouldReturnToPrimary({ policy, currentRoute, atSafeBoundary }) {
  const primary = policy?.routeChain?.[0]
  if (primary === undefined || currentRoute === undefined || currentRoute === null) return false
  if (routeKey(primary) === routeKey(currentRoute)) return false
  return atSafeBoundary === true
}

/**
 * Decide whether the failover chain may come back to the PRIMARY route.
 *
 * The primary is `policy.routeChain[0]` — the route an operator asked for
 * first. Coming back is only honest at a safe boundary: a finished attempt
 * (or a fresh attempt that never started, e.g. after a restart). It is never
 * allowed while a stream is in flight, because a partial stream cannot be
 * replayed and the new route must finish the turn instead.
 *
 * The call is pure and mirrors `planRoute()`: the host calls it when a turn
 * ends, before the next turn starts, and applies `route` for the next turn.
 *
 * Refusal reasons, in check order:
 *   `no_current_route`  — nothing is routed yet (no failover to undo);
 *   `no_primary_route`  — the chain has no primary (empty/absent chain);
 *   `already_primary`   — the current route IS the primary;
 *   `not_at_safe_boundary` — the host did not confirm a finished attempt;
 *   `provider_not_allowed` / `cloud_fallback_forbidden_for_local_model`;
 *   `primary_in_cooldown` — provider health still marks the primary cooling.
 *
 * @param {object} input
 * @param {object} [input.policy]          resolved policy (see resolveRoutePolicy)
 * @param {object} [input.currentRoute]    route of the last attempt
 * @param {boolean} [input.atSafeBoundary] true only after a finished attempt
 * @param {object} [input.health]          provider health table
 * @param {number} [input.now]             clock for the cooldown check
 * @returns {{action:'return'|'keep', route:object|null, reason:string}}
 */
export function planPrimaryReturn({ policy, currentRoute, atSafeBoundary, health, now = Date.now() } = {}) {
  const keep = reason => ({ action: 'keep', route: currentRoute ?? null, reason })
  if (currentRoute === undefined || currentRoute === null) return keep('no_current_route')
  const primary = policy?.routeChain?.[0]
  if (primary === undefined || primary === null) return keep('no_primary_route')
  if (routeKey(primary) === routeKey(currentRoute)) return keep('already_primary')
  if (atSafeBoundary !== true) return keep('not_at_safe_boundary')
  // Keep the historical predicate as the single safe-boundary authority: a
  // change there must not silently widen what this planner allows.
  if (!shouldReturnToPrimary({ policy, currentRoute, atSafeBoundary })) return keep('primary_return_refused')
  const allowed = isRouteAllowed(primary, policy, currentRoute)
  if (!allowed.ok) return keep(allowed.reason)
  if (cooldownActive(health, primary.provider, now)) return keep('primary_in_cooldown')
  return { action: 'return', route: primary, reason: 'primary_available' }
}
