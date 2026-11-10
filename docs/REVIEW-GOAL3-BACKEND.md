# GOAL 3 — independent backend review (orchestration, routing, contract, recovery)

- **Reviewer:** independent review A (backend), no implementation history.
- **Branch:** `goal3/supervision-orchestration`.
- **Reviewed range:** `8f9ebff..ad4dccf` plus the working tree at review start. The
  branch moved **while this review was running**: `0964333` and `c7b55cc` landed
  mid-review and fix findings R1–R8 below. R10 is a regression introduced by
  `0964333`; R9, R11–R13 are still open on `c7b55cc` (+ the working tree).
- **Method:** read every module in scope and its tests; then tried to break the
  behaviour with executable experiments — host-level tests driving the real
  `apply()` HTTP API against `tests/fixtures/fake-taskboard-server.mjs`, pure
  module probes (`node --input-type=module -e …`), and mutation runs on a throwaway
  copy of `src/` + `tests/` under `%TEMP%` (the repo itself was never mutated).
- **Added tests (write scope):** `tests/review-backend-contract-race.test.js`,
  `tests/review-backend-restart-lease.test.js`, `tests/review-backend-policy.test.js`,
  `tests/review-backend-invariants.test.js`. They assert the *desired* behaviour, so
  a red test is a finding, not a broken test.
- **Fixture caveat:** every contract test runs against a **SIMULATED** Task Board
  extension (`x-simulated-contract: true`). Nothing here is evidence of a live
  `dsh-taskboard` integration (the real 0.11 plugin has no `/contract` route).

## Verdict

**APPROVE WITH FIXES.** The unified contract backend is structurally sound — the
lease→session→attach→settle order, the local `done` refusal, the "no emulation"
negotiation and the single-writer/restart model all held up under attack. But the
review found **one open P1 (R10, a lease leak introduced by the decide-early fix)**
and **one open P2 (R9, journal bound bypass)**, plus three P2 risk/hardening items
(R11–R13). R1–R8 were real defects found here; they are fixed on the branch and
each now has a non-regression test that fails on `ad4dccf`.

## Findings (open on `c7b55cc`)

| # | Sev | Where | Impact | Test / repro |
|---|-----|-------|--------|--------------|
| R10 | **P1** | `src/host/index.js:1085-1097` (`decidedEarly`), called at `:1102`; `stopExecutions` at `:1823` | A **Stop that lands while the contract LEASE request is in flight** leaves the canonical execution leased forever: `stopExecutions` cannot release because `leaseId` is not known yet (`:1863`), and `decidedEarly` now returns before the old fencing path that released it. The card stays `in_progress`/claimed by a lease nobody will release (until the server TTL, if any). | `node --test --test-name-pattern "FINDING R10" tests/review-backend-contract-race.test.js` — leases=`["leased"]`, assignment=`interrupted (stop_failed:agent_unavailable)`, task stays `in_progress` |
| R9 | P2 | `src/orchestrator/journal.js:323-325` | The assignment bound is bypassed when the active count ≥ `maxAssignments`: `ended.slice(-Math.max(0, maxAssignments - active.length))` becomes `slice(-0)`, which keeps **every** ended assignment instead of none. A caller asking for a tighter bound gets an unbounded document. The host uses the default (200) today, so this is latent. | `node --test --test-name-pattern "FINDING R9" tests/review-backend-invariants.test.js`; also `compactState({maxAssignments:0})` keeps all ended records |
| R11 | P2 | `src/host/index.js:1519` (`recordBudget('retry')`), `:1617` (`recordBudget('switch')`) | The hourly retry/switch ceilings are **counted but never enforced**: the `consume()` result is discarded, so when the sliding-hour ceiling is reached the retry/handoff still happens. `describeBudget()` still advertises `enforceable.maxRetries/maxSwitches: true` (`src/routing/budget.js:193-194`). | Proposal: two tasks under `{maxRetries:2}`; fail task A twice (hourly retries = 2), then fail task B — its retry is dispatched although the hourly ceiling is exhausted. Fix: check the result and suppress, or set those `enforceable` flags to `false`. |
| R12 | P2 | `src/host/index.js:1345` (`authorizeHandoff` catch) | If the Task Board read fails, the handoff proceeds **unverified** (`{ok:true, reason:'unverified'}`). A card that was trashed / moved / claimed by a foreign executor during the run is then continued in a new session. The audit records `handoff_unverified`, but the ownership invariant is not enforced. | Proposal: inject a 500 on `GET /dsh-taskboard/state` after the launch, emit a 503 turn end, assert no second session is created (or require an explicit operator retry). |
| R13 | P2 | `src/host/index.js:462-471` (`releaseContractLease`), `:474-494` (`settleContractExecution`) | A failed settle/release is fire-and-forget with no durable retry. A terminal assignment with `settleError` (or a lease release that hit the network) is never retried: restart reconciliation only touches active assignments, and no tick retries it. On a server without TTL enforcement the canonical execution stays `running`/leased. | Proposal: persist `pendingSettle`/`pendingRelease` on the assignment and retry at startup and on tick (bounded, idempotent); test by making `fetch` fail once for `/settle`, then restarting. |

### R10 detail (the important one)

Reproduction scenario (deterministic, delayed `fetch` on the lease POST):

1. Boot the host with `executionBackend:'contract'` and a complete (simulated) contract.
2. `POST /tick`; hold the `POST …/executions/lease` request for 120 ms.
3. `POST /stop` while it is in flight. `stopExecutions()` finds the assignment
   `starting`, the session does not exist yet (`agent_unavailable`), sets it
   `interrupted`, and skips the release because `assignment.leaseId` is still
   `undefined` (`:1863`).
4. The lease response arrives, `leaseId` is stored, the session is created, then
   `decidedEarly('create')` sees the terminal `interrupted` status, cancels the
   session and **returns without releasing the lease**.

The canonical execution is now leased with no owner (the board has already
forgotten it) and the card is `in_progress`. The old `ad4dccf` code released the
lease here through the fencing refusal; `0964333` removed that path without adding
a release to `decidedEarly`. Suggested fix: record `leaseReleasedAt`/`settledAt`
on the assignment and, in `decidedEarly`, release the lease when neither is set
(idempotent release is already safe in the contract; a release after a settle is
refused, so the guard must be explicit).

## Findings found in this review and already fixed on the branch (verified)

These were reproduced against `ad4dccf`; each now has a test that is red on
`ad4dccf` and green on `c7b55cc`. The fix commits are `0964333` and `c7b55cc`.

| # | Sev (then) | Defect on `ad4dccf` | Fix | Non-regression test |
|---|-----------|---------------------|-----|---------------------|
| R1 | P1 | Handoff released the previous contract lease **fire-and-forget** (`ad4dccf:src/host/index.js:1530`) and then immediately requested the next lease. A slow release loses the race: the new lease is refused `lease_conflict`, the failover attempt is `FAILED`, and the task is not continued. | `0964333`: release is awaited before the new attempt. | `FINDING R1` (delayed `/release` ⇒ failover still creates the second session) |
| R2 | P2 | Stop during the contract **attach** was reported as `contract_attach_refused` / `interrupted`, the agent was cancelled twice and an already-settled lease was released again (`contract_release_failed` noise). | `0964333`: `decidedEarly('attach')` keeps a `stopped` decision. | `FINDING R2` (status `stopped`, one cancel, zero release calls) |
| R3 | P1 | After a restart, `releaseContractLease` ran **before** the new process negotiated the contract, so the client refused locally (`not_negotiated`) and the lease stayed attached to a session that no longer existed. | `0964333`: `await ensureContract()` (also when a restored contract assignment exists) before releasing. | `FINDING R3` (two-host restart; lease `released`, audit `contract_released`) |
| R4 | P2 | A turn that completed while the contract launch was finishing was rewritten to `interrupted (fencing_refused:lease_released)` by the post-create fencing check, and the completed session was cancelled. | `0964333`: `decidedEarly('create')` lets a `done` decision win. | `FINDING R4` (status stays `done`, no cancel, no release-after-settle) |
| R5 | P1 | A **local-only project layer** could still launch on a remote primary: the filtered chain came back empty, `effectiveRoutePolicy` fell back to the unfiltered global chain (`ad4dccf:623`), and `isRouteAllowed()` only checked cloud fallback when coming *from* a local route — a fresh launch has no previous route. | `c7b55cc`: `defaultRoute()` returns `null` under `locality:'local'`; `authorizeLaunch` refuses `no_route_allowed`; `isRouteAllowed` refuses remote under a local-only layer. | `FINDING R5` + `CLEAN: a local-only project layer launches a local route` |
| R6 | P1 | `deniedProviders` was resolved by `resolveRoutePolicy` but **dropped** by `effectiveRoutePolicy` and never checked by `isRouteAllowed`, so a card-pinned model could reach a denied provider. | `c7b55cc`: deny-list enforced in `isRouteAllowed` (`provider_denied`). | `FINDING R6` (pinned `cloud` + project deny-list ⇒ no session, refusal reason `provider_denied`) |
| R7 | P2 | A `requiresHandoff` failure bypassed `maxSwitches`: with `maxSwitches:0` a partial-stream failure still handed the task to another provider. | `c7b55cc`: the handoff branch checks `switches >= maxSwitches` first (`router.js:114-115`). | `FINDING R7` (pure `planRoute`, switches 0/0 and 1/1) |
| R8 | P2 | `describeBudget` advertised `enforceable.requestsPerHour:true`, but the host never recorded a request: a `requestsPerHour:1` policy never refused anything. | `c7b55cc`: `recordBudget('request')` on launch/retry/handoff. | `FINDING R8` (a launch must be metered, or the flag must be false) |

## Clean areas — what I tried

- **Contract client/server semantics** (`src/connectors/taskboard-contract.js`,
  `tests/fixtures/fake-taskboard-server.mjs`): negotiation matrix (absent /
  unreachable / partial / newer / malformed), every write refused locally before
  HTTP when the extension is absent or partial, idempotent attach/lease/release/
  settle, stale-version `version_conflict`, foreign-claim `claim_conflict`,
  `done` refused locally **and** by the server, no POST for an absent contract.
  No new finding. Residual spec gap: the fixture accepts `settle` on a lease that
  was never attached (see R4), which is how a succeeded execution can be recorded
  without a session id; the proposal should state whether attach is mandatory
  before settle.
- **Fencing** (`checkFencing`/`takeoverRefusal`): the token check, the
  `lease_expired` exemption and the "terminal status is not writable" rule behave
  as documented (pure tests). **But the host never advances a token for an
  existing assignment** (`acquireLease` is only ever called with `undefined` at
  `src/host/index.js:869`; `nextFencingToken` is imported and unused), and the
  `owner` passed is always the lease owner, so `stale_fencing_token`/`wrong_owner`
  are unreachable in the host. See the mutation result below.
- **`planPrimaryReturn` / primary return**: strict safe-boundary predicate, cooldown,
  allow-list and local-only refusals all covered by `tests/routing-primary.test.js`;
  the host only applies it when launching a **new** attempt (`launchTask` refuses a
  live duplicate first), so it cannot be applied to a live stream. Clean.
- **Layer policy conflicts**: `providersConflict` (empty intersection or all
  denied) is a hard refusal at the launch gate (`route_policy_conflict`); a
  non-object/array project layer is ignored with a warning and cannot crash the
  host (`normalizeProjectPolicies`, `readLayer`). Clean. (The new deny-list check
  in `isRouteAllowed` is what makes a *denied* provider a refusal instead of an
  empty allow-list, which would read as "unrestricted".)
- **Budget**: sliding-hour boundary is inclusive-correct (`at > now - HOUR`);
  `recordBudget('task')` happens once, after the assignment is durable, and a
  refused launch consumes nothing — pinned by `CLEAN: a refused launch consumes no
  budget…`. Token/cost stay `available:false` (correct); the request/retry/switch
  claims are covered by R8/R11.
- **Persistence / restart**: a contract `leaseId`/`executionId` survives a restart
  and is released (R3 test); `compactState` keeps every live assignment
  (`CLEAN: compactState keeps live assignments…`); the only defect is the bound
  arithmetic (R9).
- **Exit paths of `runContractAttempt`**: lease refusal (no lease), worktree
  unavailable (awaited release), Stop/fencing during create and attach
  (`decidedEarly`), attach refused (cancel + release), Stop during attach
  (`stopped`, settled once), throw between lease and attach (awaited release).
  The one hole is Stop **during the lease request** (R10). `settleContractExecution`
  has no `settledAt` guard, but I could not reach a double settle on `c7b55cc`
  (the previous double-close was R2, fixed); a guard is still cheap defence.
- **Prompt injection through the card** is the sibling reviewer's area; note only
  that `handoffPrompt()` injects the card text without the `UNTRUSTED_NOTICE`
  used by `buildLaunchBody()` (weaker framing on the resumed session).

## False-positive tests / mutation results

- **Fencing is not exercised end-to-end.** In a throwaway copy of the repo I
  replaced the bodies of `fencingRefusal` and `takeoverRefusal` with `return null`
  (and, separately, made `checkFencing` always return `{ok:true}`), then ran the
  six host-level test files (`unified-backend`, `host-governance`, `resilience`,
  `host-integration`, `backend-taskboard`, `supervision-status`):
  **46/46 still pass in both mutations.** `tests/fencing.test.js` protects the pure
  function only; no test proves the host relies on a refusal. Given that the token
  never advances in the host, the checks are defensive (the real protection is the
  single-writer instance lock). Either add a host-level takeover test (bump the
  token / replace the lease mid-turn) or document the checks as defence-in-depth.
- **The budget module tests are pure.** They were all green while the host never
  metered a request and could not enforce the hourly ceiling (R8/R11). The
  integration gap is now covered by `CLEAN: a refused launch consumes no budget…`
  and `FINDING R8`.
- The contract "absent extension" test is *not* a false positive: removing
  `contractWritesReady()` makes the launch reach `leaseExecution`, which fails
  locally with `contract_lease_refused:not_negotiated`, so the asserted reason
  changes and the test fails. Same for the trashed-card handoff test (removing the
  stop/trash gate creates a session).

## Test counts (real, at handoff)

- `node --test tests/` → **313 tests, 309 pass, 2 fail, 2 todo, 0 skipped,
  0 cancelled** (≈1.9 s). The two failures are exactly the two open findings:
  `FINDING R10` and `FINDING R9`. The 2 `todo` are the sibling reviewer's
  supervision findings (deliberately marked todo, not red).
- This review's four files → **13 tests, 11 pass, 2 fail** (`R10`, `R9`).
- On `ad4dccf` (before the fix commits) the same suite was 264→310 tests with
  R1–R8 red; every R1–R8 test is green on `c7b55cc` for the reason stated in the
  table (R5/R6 additionally assert the *policy refusal reason*, so they cannot
  pass because of an unrelated gate).

## Residual risks

1. **No contract lease renewal** (`docs/LIMITATIONS.md` #2): a turn longer than the
   contract TTL loses the canonical reservation; the settle then fails and the card
   returns to `todo`, so the work is replayed after the retry cooldown. Documented,
   but it is a **duplicate-side-effect** risk, not only a bookkeeping one.
2. **R12** (unverified handoff) and **R13** (no settlement retry) are the two
   availability-vs-safety trade-offs I would not ship without a bounded retry /
   explicit operator acknowledgement.
3. **R10** should be fixed before any long-lived contract deployment: the leaked
   lease is invisible on the card (`interrupted`) and only the server TTL recovers
   it.

## Post-review fixes (Lead, after this review)

All five open findings were closed on the branch (commits `0964333`, `c7b55cc` and
the final integration commit):

| # | Fix | Guarded by |
|---|---|---|
| R10 (P1) | `decidedEarly()` is now async and, when the attempt was decided before its lease was known (Stop during the LEASE request), it releases that lease when neither `settledAt` nor `leaseReleasedAt` is set. `releaseContractLease()` is idempotent (skips a settled/closed execution) and records a bounded `releasePending` retry on failure. | `FINDING R10` green; `tests/unified-backend.test.js` Stop/attach cases |
| R9 (P2) | `compactState()` applies `slice(-0)` explicitly: `keepEnded`/`keepResolved` 0 keeps NONE of the ended/resolved records (same bug fixed for proposals). | `FINDING R9` green |
| R11 (P2) | The hourly retry and switch ceilings are now ENFORCED: a refused `consume('retry')` suppresses the retry (`budget:<reason>`, audit `retry_suppressed`) and a refused `consume('switch')` suppresses the handoff before the current lease is touched. The snapshot's `enforceable` flags are therefore true. | `tests/review-backend-policy.test.js` + `docs/FAILOVER.md` |
| R12 (P2) | A ledger read failure now SUPPRESSES the handoff (`handoff_suppressed:ledger_unreadable`) by default; the optimistic path requires `policy.allowUnverifiedHandoff:true` (default `false`). | `tests/contract-resilience.test.js` (R12) |
| R13 (P2) | A failed settle/release persists `settlement`/`releasePending` (attempts + `nextAt`) and a bounded sweep runs at startup and at the next tick: max 5 attempts, policy-tunable `settlementRetryMs` (default 60 s). Success clears the state; exhaustion is visible (`exhausted:true`). | `tests/contract-resilience.test.js` (R13) |

**Fencing bookkeeping**: a handoff now uses `nextFencingToken()` (the token
genuinely advances: attempt 1 → token 1, attempt 2 → token 2) and the host-level
failover test asserts a LATE `turn/end` from the superseded session cannot settle
the new attempt. The reviewer's mutation point stands in the honest sense that a
single-live-assignment model already removes most stale writers; the fencing
check is the second line of defence, not the only one.

**Real counts after the fixes:** `node --test tests/` → **315 tests, 315 pass,
0 fail, 0 todo**, reproduced 3× consecutively. The final isolated E2E was re-run
on the fixed host: **PASS 15/15**, 2 scenarios, exit 0
(`docs/e2e/GOAL3-E2E.md`).
