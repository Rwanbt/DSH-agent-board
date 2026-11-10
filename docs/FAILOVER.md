# Failover, layered routing policy, budgets and fencing

This document is the contract for the failover path. The modules below are
**pure**: they take plain JSON, return plain JSON, never read a clock they were
not given, never mutate their input and never crash on malformed config. The
host (`src/host/index.js`) is the only owner of timers, sessions and state; the
wiring signatures it must call are listed at the end.

Status: implemented and unit-tested (see *Tests*). Host wiring is the remaining
step, and it is what closes `docs/LIMITATIONS.md` items 10 (automatic return to
the primary) and 17 (fencing enforced on writes).

## The three stages

| Stage | Trigger (from `classifyFailure`) | Decision | Honest limit |
|---|---|---|---|
| 1. Retry | `retryable` (429, 5xx, timeout, transport) | same route, bounded by `maxRetries`, exponential backoff + jitter that honours `Retry-After` | the delay is really awaited; a Stop during the wait suppresses the retry (`retry_suppressed`) |
| 2. Switch | `switchable` (auth/quota/model unavailable/config/overload/rate limit…) | next entry of the explicit `routeChain`, filtered by allowed/denied providers, cooldown and `maxSwitches` | only the explicit chain; no “any model” fallback |
| 3. Handoff | `requiresHandoff` (error after the first streamed chunk) or chain exhausted | checkpoint + **new session** on the next route, assignment starts `recovering` | a partial stream is never “resumed in the same request”; external effects are listed as `effect:unknown` |

The classifier refuses two shortcuts on purpose: a **policy/safety refusal** is
never routed around, and a **CI/test/code failure** (`notModel`) is not a model
outage. `planRoute()` returns `stop` for both.

A Stop landing during a retry, a switch/handoff or the handoff authorization
wins: the board is the single writer and re-checks its stop epoch.

## Automatic return to the primary

`planPrimaryReturn({ policy, currentRoute, atSafeBoundary, health, now })`
decides whether the failed-over assignment may go back to `policy.routeChain[0]`
— the route the operator asked for first. It only returns at a **safe
boundary**: a finished attempt (or a fresh assignment that has not started its
first turn yet). While a stream is in flight, or after a partial stream, the
current route must finish the turn.

| Condition (check order) | `action` | `reason` |
|---|---|---|
| no current route | `keep` | `no_current_route` |
| chain empty / no primary | `keep` | `no_primary_route` |
| current route is the primary (`routeKey` equal) | `keep` | `already_primary` |
| `atSafeBoundary !== true` | `keep` | `not_at_safe_boundary` |
| `shouldReturnToPrimary()` says no | `keep` | `primary_return_refused` |
| primary provider not in `allowedProviders` | `keep` | `provider_not_allowed` |
| local-only policy, remote primary | `keep` | `cloud_fallback_forbidden_for_local_model` |
| primary provider in cooldown (`cooldownUntil > now`) | `keep` | `primary_in_cooldown` |
| otherwise | `return` | `primary_available` |

`route` is the route to use for the **next** turn: the primary on `return`, the
current route on `keep`. The host sets `atSafeBoundary: true` only on a clean
`turn/end` with no partial output; after a host restart a fresh assignment may
start on the primary immediately.

## Layered route policy

`resolveRoutePolicy({ global, project, role, task })` resolves four optional
layers, ordered least → most specific: `global` → `project` → `role` → `task`.
A layer is any plain object carrying at least one route key; unrelated fields
(`mode`, `maxConcurrent`, permissions, …) are ignored so the host can pass its
whole policy as the `global` layer.

Most-restrictive-wins rules:

| Key | Rule | Default |
|---|---|---|
| `allowedProviders` | intersection of the **non-empty** lists; a route must be allowed by every layer that names providers. Layer order sets the result order; empty lists do not restrict | `[]` = no restriction |
| `deniedProviders` | union; a single refusal removes the provider everywhere | `[]` |
| `providersConflict` | derived `true` when layers named providers but the intersection (after denials) is empty. **When true, no provider is allowed** and the chain is empty — `isRouteAllowed()` reads `[]` as “no restriction”, so the host must honour the flag explicitly | `false` |
| `allowCloudFallback` | AND of the explicit booleans (a single `false` wins). An unstated layer grants nothing but does not forbid either | `true` (absence) |
| `locality` | `local` if any layer says `locality:'local'` or `localOnly:true`; `local` forces `allowCloudFallback:false` | `null` |
| `maxRetries` | minimum of the explicit integers | `2` |
| `maxSwitches` | minimum of the explicit integers | `2` |
| `cooldownMs` | maximum of the explicit integers (the longest wait wins). `retryCooldownMs` is accepted as an alias for the host policy key | `60000` |
| `routeChain` | the **most specific non-empty** chain (task → role → project → global), then filtered by the allow/deny sets and by local-only. `provider/model` strings are accepted; routes are de-duplicated; unknown locality counts as `remote` | `[]` |

Malformed input is ignored, never thrown. `warnings` is a bounded array of
`{ layer, code, detail }` with codes:

- `layer_not_object` — the layer is not a plain object (array, string, number…);
- `unknown_layer` — the object has none of the route keys (a typo such as
  `allowedProvider`, or a layer that only carries unrelated board policy);
- `invalid_value` — a recognised key has an invalid value or the chain has
  malformed entries (the valid part is kept);
- `providers_conflict` — cross-layer conflict, `layer` is `'policy'`.

A layer whose chain has only malformed entries falls back to the next less
specific chain.

## Budgets

`consume()` is the enforcement point the host calls **before** an action.
Ceilings are the ones the board really owns (launch, request, retry, switch):

| Limit | Default | Source key |
|---|---|---|
| `maxConcurrent` | `2` | `policy.maxConcurrent` |
| `tasksPerHour` | `6` | `policy.tasksPerHour` or `policy.autonomyBudget.maxTasksPerHour` |
| `requestsPerHour` | `120` | `policy.requestsPerHour` |
| `maxRetries` | `2` | `policy.maxRetries` |
| `maxSwitches` | `2` | `policy.maxSwitches` |
| `cooldownMs` | `60000` | `policy.cooldownMs` (alias `retryCooldownMs`) |

`resolveBudgetLimits(policy)` normalises those numbers (invalid values fall back
to the defaults). The persisted usage is plain JSON:

```js
{
  limits: { maxConcurrent, tasksPerHour, requestsPerHour, maxRetries, maxSwitches, cooldownMs },
  concurrent: 0, tasks: [/* launch timestamps */], requests: [/* request timestamps */],
  retries: 0, switches: 0, lastEventAt: null, lastFailureAt: null
}
```

`consume(usage, event, now)` returns `{ ok, reason, usage }` and never mutates
its input. A **refused event consumes nothing**. The hourly windows slide:
entries with `at > now - 3600000` count, so an entry exactly one hour old is
outside the window. `now` and `event.at` are supplied by the host, so tests need
no timer.

| `event.kind` | Effect | Refusal reasons |
|---|---|---|
| `start` | acquire a concurrency slot | `concurrency_limit` |
| `release` | free a slot (clamped at 0) | never refused (`released`) |
| `task` | record a task launch | `tasks_per_hour_exhausted` |
| `request` | record one provider request | `requests_per_hour_exhausted` |
| `retry` | record a same-route retry | `max_retries_reached`, `cooldown_active` |
| `switch` | record a provider switch | `max_switches_reached`, `cooldown_active` |
| `failure` | record `lastFailureAt` for the cooldown | never refused (`recorded`) |

The cooldown is measured from `event.failureAt`, else `usage.lastFailureAt`. It
is over when `now - failureAt >= cooldownMs`. `event.limits` overrides
`usage.limits` for one call. An unknown kind is refused
(`unknown_event_kind`), never silently counted.

`describeBudget(policy, usage, now)` is the serialisable snapshot for the HTTP
API / the panel:

```js
{
  at, window: { durationMs, from, to },
  limits: { maxConcurrent, tasksPerHour, requestsPerHour, maxRetries, maxSwitches, cooldownMs },
  used: { concurrency, tasksLastHour, requestsLastHour, retries, switches, cooldownRemainingMs },
  remaining: { concurrency, tasks, requests, retries, switches },
  enforceable: { concurrency: true, tasksPerHour: true, requestsPerHour: true,
                 maxRetries: true, maxSwitches: true, cooldownMs: true,
                 tokens: false, cost: false },
  metering: {
    tokens: { available: false, reason: 'provider_metering_unavailable' },
    cost:   { available: false, reason: 'provider_metering_unavailable' }
  }
}
```

When the host supplies **real** metering (`usage.tokens = { used, limit }`,
`usage.cost = { used, limit, currency? }`, all finite and non-negative) the
metric becomes `{ available: true, unit, used, limit, remaining, currency? }`.
That is still an **observation**, not a guarantee.

## What is NOT enforceable, and why

- **Token and monetary budgets are not enforceable by this board.** DSH exposes
  no per-request token/cost meter the board can trust: providers report usage
  asynchronously, with different granularity and different retry/refund rules,
  and the board never talks to provider billing APIs and never writes a ledger.
  Claiming a hard token/cost ceiling would be a fake guarantee. The snapshot
  therefore says `provider_metering_unavailable` unless the host has real data,
  and even then `enforceable.tokens/cost` stay `false`. Use the provider's own
  quota/limit controls for a hard stop.
- **A partial stream is not resumed.** The same request cannot be replayed after
  output was emitted; stage 3 hands off the *task* to a new session.
- **External effects are not reconciled.** The board never sees tool results, so
  mutating tool calls are recorded as `effect:unknown` and the resumed session is
  told to verify before replaying.
- **A policy refusal is not a failover.** Another provider must not be used to
  bypass a safety/policy decision.
- **Fencing is a host-local guard.** It rejects a stale writer inside this host;
  it does not protect against an old build that ignores it, nor against an
  external system writing the task card.

## Fencing decisions

| Condition (check order) | `ok` | `reason` |
|---|---|---|
| no assignment record | `false` | `unknown_assignment` |
| presented or recorded token is not a number | `false` | `invalid_fencing_token` |
| presented token ≠ `assignment.fencingToken` | `false` | `stale_fencing_token` |
| assignment status is terminal (`done`/`failed`/`stopped`/`interrupted`/`superseded`) | `false` | `lease_released` |
| no lease | `false` | `lease_released` |
| `now >= lease.expiresAt` | `false` | `lease_expired` |
| optional `owner` given and `lease.owner` differs | `false` | `wrong_owner` |
| otherwise | `true` | `ok` |

`nextFencingToken(assignment)` returns `(storedToken || 0) + 1` — 1 for a new
assignment — and agrees with `acquireLease()` on every takeover. The host must
store the new token and re-check `checkFencing()` before every state write made
on behalf of an assignment.

## Host wiring: exact signatures

```js
// src/routing/router.js
routeKey(route) → string
backoffDelay(attempt, { baseMs?, capMs?, retryAfterMs?, rng? }) → number
isRouteAllowed(route, policy, fromRoute) → { ok: boolean, reason: string }
cooldownActive(health, provider, now) → boolean
nextRoute({ chain, currentRoute, policy, health, now, tried? }) → { route, reason }
planRoute({ failure, retries?, switches?, currentRoute?, chain?, policy?,
            health?, now?, triedRoutes?, rng? })
  → { action: 'retry'|'switch'|'handoff'|'stop'|'blocked', delayMs, nextRoute, reason, cooldownUntil }
recordHealth(health, { provider, kind, at?, cooldownMs?, threshold? }) → health
shouldReturnToPrimary({ policy, currentRoute, atSafeBoundary }) → boolean
planPrimaryReturn({ policy, currentRoute, atSafeBoundary, health, now })
  → { action: 'return'|'keep', route, reason }

// src/routing/policy.js
resolveRoutePolicy({ global?, project?, role?, task? }) → {
  allowedProviders, deniedProviders, providersConflict, allowCloudFallback,
  locality, maxRetries, maxSwitches, cooldownMs, routeChain, warnings
}

// src/routing/budget.js
resolveBudgetLimits(policy) → { maxConcurrent, tasksPerHour, requestsPerHour, maxRetries, maxSwitches, cooldownMs }
consume(usage, { kind, at?, failureAt?, limits? }, now) → { ok, reason, usage }
describeBudget(policy, usage, now) → snapshot (see above)

// src/orchestrator/lease.js
nextFencingToken(assignment) → number
checkFencing({ assignment, token, now, owner? }) → { ok, reason }
```

Wiring order in the host:

1. **Launch.** `const routePolicy = resolveRoutePolicy({ global: state.policy, project, role, task })`.
   Refuse the launch with `providers_conflict` when that flag is true. Then
   `const limits = resolveBudgetLimits({ ...state.policy, ...routePolicy })`
   (the resolved route policy overrides `maxRetries`/`maxSwitches`/`cooldownMs`;
   `maxConcurrent`/`tasksPerHour`/`requestsPerHour` come from the board policy),
   and build the persisted `usage` with those limits.
2. **Gate the launch.** `consume(usage, { kind: 'start' }, now)` then
   `consume(usage, { kind: 'task' }, now)`; a refusal is a skip reason, never a
   silent launch.
3. **Gate each provider request.** `consume(usage, { kind: 'request' }, now)`.
   On a failure: `consume(usage, { kind: 'failure' }, now)`, then
   `consume(usage, { kind: 'retry'|'switch', failureAt }, now)` before acting.
4. **Recover.** `planRoute({ failure, retries: assignment.retries, switches: assignment.switches, currentRoute: assignment.model, chain: routePolicy.routeChain, policy: routePolicy, health: state.health, now, triedRoutes })`.
   Apply `action`; pass `plan.delayMs` to the awaited backoff.
5. **Return to primary.** On a clean `turn/end`,
   `planPrimaryReturn({ policy: routePolicy, currentRoute: assignment.model, atSafeBoundary: true, health: state.health, now })`;
   on `action:'return'` use `route` for the next turn (never mid-stream).
6. **Fence writes.** Before mutating state for an assignment, or launching a
   replacement writer, `checkFencing({ assignment, token: assignment.fencingToken, now, owner: sessionId })`.
   A refused write is audited (`fence_refused`) and dropped. On takeover use
   `nextFencingToken(assignment)` and persist it.
7. **Expose.** `describeBudget(state.policy, state.budgetUsage, now)` in
   `GET /state`; it is plain JSON and already says what is not enforceable.

## Tests

Deterministic, no timers or sleeps: `tests/routing-primary.test.js`,
`tests/routing-policy.test.js`, `tests/budget.test.js`, `tests/fencing.test.js`.
Run the whole suite with `node --test tests/`.
