# ADR 0003 — Limit the load in real time, not the starts per hour

- Status: accepted
- Date: 2026-11-15
- Supersedes: the hourly throttle as the product lever (0.1.0)

## Context

0.1.0 limited how many launches the board could START inside a rolling hour
(`maxDelegationsPerHour: 6`) next to a fixed concurrency ceiling
(`maxConcurrentDelegations: 2`). The operator asked for the opposite: supervise
around fifty sessions across ten projects by handling exceptions only.

Three facts made the hourly counter the wrong lever:

1. It counts starts, not load: six three-second turns and six forty-minute turns
   obey the same rule.
2. It is invisible: nothing in the cockpit explains a window that opened an hour
   ago, so reaching it looks like a bug.
3. It stops the product: with `0` — the value that a careful operator tries to
   "turn it off" — nothing launches at all, and nothing says why.

Two resources are actually scarce and both are measurable in real time: the
machine the sessions run on, and the tokens the operator pays for.

## Decision

The admission gate reads one effective ceiling, recomputed on every launch:

```
ceiling = min(operator ceiling, machine ceiling, token ceiling)
binding = the smallest finite one
```

- **machine**: `availableParallelism()` and `freemem()`, or an explicit
  `policy.load.hardware` pair when the operator knows the box (or a test must not
  depend on it). Calibration is deliberately generous — eight sessions per core,
  128 MiB of free memory each — because a session mostly WAITS on a provider:
  this is an anti-overload guard, never a throughput governor.
- **tokens**: `policy.load.tokenBudget` divided by the price of a turn
  (`policy.load.tokensPerTurn`, measured on this install, else
  `DEFAULT_TOKENS_PER_TURN`), against the usage `ctx.tokenMeter` reports. No
  provider usage means no measurement — the model never invents a bill.
- **operator**: every existing ceiling keeps its own gate (global, supervision,
  per-project, per-provider); the load model only adds what nothing else sees.

Consequences that were chosen explicitly:

- A **machine** ceiling is floored at one: the process is running on that
  machine, and `freemem()` is noisy enough to be unusable as a hard stop. The
  raw figure stays published.
- A **token** ceiling may reach 0 — that is money already spent — and it is
  published as `blocked` with its source, never applied silently.
- A **configured** ceiling is floored at one by the UI; to stop everything the
  operator uses Pause (`POST /mandate/pause`), which is explicit and reversible.
- The hourly field survives as an advanced safety valve and can express "no rate
  limit" (`null`). The 0.1.0 defaults are lifted once on upgrade, audited as
  `load_model_migrated`; a deliberate non-default value is preserved.

## Alternatives rejected

- **Keep the hourly counter and raise it.** Same count of starts, same blind
  spot, and it still stops the product for the rest of the hour.
- **Derive everything from the account balance.** An account can be signed out or
  unavailable; a gate that cannot read its own input must not refuse work.
- **Trust `freemem()` alone.** Windows reports a fraction of the memory that is
  actually available; the published raw value plus an explicit override is
  honest, a silent refusal is not.

## Consequences

- A card can now queue for a reason that is neither the project nor the provider;
  the refusal names the binding fact, and the cockpit shows it.
- The board needs one optional DSH service to bill work. Absent, the model binds
  on hardware only and publishes `tokens.measurable: false`.
- Requests are never preempted: the ceiling governs admissions, not running work.
