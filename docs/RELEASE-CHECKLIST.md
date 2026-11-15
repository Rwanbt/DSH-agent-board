# Release checklist — reproducible recipe

This is the ordered recipe to declare a build fit to ship. Every step says whether
it runs HERE (offline, deterministic) or requires the operator's real DSH instance
or a real provider. A step that was not executed stays `UNVERIFIED — to be run by
the operator`; nothing is marked green from reading the code.

Legend: **LOCAL** = runs in CI or in this repository · **LIVE** = needs the real
DSH host, a provider, or the real Task Board · **EVIDENCE** = what to keep.

## 0. Preconditions

| # | Check | Kind | Command / evidence |
|---|---|---|---|
| 0.1 | Clean branch, no stray files | LOCAL | `git status --porcelain` is empty |
| 0.2 | Node version | LOCAL | `node --version` ≥ the `engines.node` floor (22) |
| 0.3 | Bundle is generated, never edited | LOCAL | `npm run client && git diff --exit-code src/client.js` |
| 0.4 | No personal traces | LOCAL | `node --test tests/no-personal-traces.test.js` |

## 1. Offline gates (CI does exactly this)

| # | Check | Kind | Command | Expected |
|---|---|---|---|---|
| 1.1 | Syntax + whole suite | LOCAL | `npm run check` | `fail 0`, and the test count in the summary |
| 1.2 | Whitespace / conflict markers | LOCAL | `git diff --check` | no output |
| 1.3 | Smoke of the new invariants | LOCAL | `node scripts/smoke-host.mjs` | `smoke: OK` |
| 1.4 | Projection + 50-session budget | LOCAL | `node --expose-gc scripts/bench/projection-bench.mjs` | table written to `docs/bench/` |
| 1.5 | The OPERATOR's own document replays | LOCAL | `node scripts/replay-state.mjs [path]` | `wouldChangeAnything: false` once migrated, and a non-zero `load.ceiling` with its `binding` fact |

EVIDENCE: the final `npm run check` summary (test count, `pass`, `fail`) and the
CI run URL once this branch is pushed.

## 2. Isolated host (no operator profile involved)

| # | Check | Kind | Command | Expected |
|---|---|---|---|---|
| 2.1 | Host boots on a disposable home | LOCAL | `node scripts/smoke-host.mjs` (module level) or the isolated E2E below | modules load, no state written outside the temp home |
| 2.2 | Full isolated E2E | LOCAL | `node scripts/e2e/run-e2e.mjs` | `docs/e2e/GOAL3-E2E-*.json` regenerated |
| 2.3 | `/selftest` shallow probe | LIVE | `GET /dsh-agent-board/api/v2/selftest` | `value.checks` all `ok:true` |
| 2.4 | `/selftest` deep probe (ephemeral session) | LIVE | `POST /dsh-agent-board/api/v2/selftest` `{ "deep": true, "confirm": "EPHEMERAL_SESSION" }` | one session created then disposed, never prompted |
| 2.5 | Dry run writes nothing | LIVE | `GET /dsh-agent-board/api/v2/dry-run` | `writes: 0`, `limits.effectiveConcurrent` present |
| 2.6 | The load model answers on this machine | LIVE | `node scripts/replay-state.mjs` then `GET /api/v2/state` | a non-zero `load.ceiling`, a `load.binding`, `load.reasons[].raw` populated |
| 2.7 | Fifty sessions, one operator | LIVE | follow `docs/LIVE-50-SESSIONS.md` | record `load.*` at steady state and the RAM used; verdict in `docs/PERFORMANCE.md` |

EVIDENCE: the JSON payloads, and the disposable home path you used.

## 3. The decisions contract (Lot 1)

| # | Check | Kind | How | Expected |
|---|---|---|---|---|
| 3.1 | Inbox is visible | LIVE | open the cockpit, Super Agent panel | the pending decision from a cycle appears (badge > 0) |
| 3.2 | Answer removes it from pending | LIVE | answer it in the panel | pending −1, the entry moves to `recent` as `answered` |
| 3.3 | One answer, one action | LIVE | replay the same answer | no second launch/effect; the intent keeps `usedAt` |
| 3.4 | Expiry is enforced | LIVE | answer an overdue decision | `409 decision_expired`, nothing mutates |
| 3.5 | Restart keeps the inbox | LIVE | restart the host, reload | the same pending decisions are still published |

Offline equivalents (already in CI): `tests/decisions-schema.test.js`,
`tests/decisions-contract-host.test.js`.

## 4. Turn end is not work done (Lot 2)

| # | Check | Kind | How | Expected |
|---|---|---|---|---|
| 4.1 | A truncated turn continues | LIVE | provoke a `max-tokens` end (tiny output budget) | assignment stays `running`, `continuations` +1, a continuation prompt is sent |
| 4.2 | The budget is bounded | LIVE | let it truncate 4 times | assignment `failed`, `needsHuman: true`, an urgent decision in the inbox |
| 4.3 | No proof, no `in_review` | LIVE | complete a turn without a commit or a report | no Task Board `in_review`; the attempt is continued |
| 4.4 | Proof settles it | LIVE | complete a turn with a commit | assignment `done`, `workVerified: true`, `evidence.kind: commit`, card `in_review` |
| 4.5 | Reopen puts it back | LIVE | `POST /assignments/:id/reopen {"reason":"…"}` | 200, `workVerified:false`, item dispatchable again, audit entry |

Offline equivalents: `tests/turn-outcome.test.js`, `tests/turn-outcome-host.test.js`.

## 5. Concurrency (Lot 5)

| # | Check | Kind | How | Expected |
|---|---|---|---|---|
| 5.1 | Ceilings are configurable | LIVE | `POST /policy {"policy":{"maxConcurrent":null,"supervision":{"maxConcurrentDelegations":null}}}` | both read back `null` (unlimited) |
| 5.2 | 50 sessions launch | LIVE | 50 todo cards over 10 projects, distinct worktrees | `running` reaches the number the machine/provider sustains |
| 5.3 | The shared tree serialises | LIVE | two cards, `isolation:'none'`, same project | the second stays queued (`project_work_in_progress`) |
| 5.4 | Provider limit queues | LIVE | `providerConcurrency: {"<provider>/<model>": 1}` with two cards | one runs, the other is queued, neither fails |

Offline equivalents: `tests/concurrency-limits.test.js`.

## 6. Attention economy (Lot 5b)

| # | Check | Kind | How | Expected |
|---|---|---|---|---|
| 6.1 | Silence by default | LIVE | 20 healthy sessions | the band shows no badge, the queue is empty |
| 6.2 | One root cause, one row | LIVE | block 10 sessions with the same permission | ONE queue entry with `occurrences: 10` |
| 6.3 | KPIs are real | LIVE | act twice in an hour | `interventionsPerHour` = 2, `medianTimeToDecisionMs` from real timestamps |
| 6.4 | Bulk approval stays single-use | LIVE | answer two same-scope decisions in one gesture | both consumed once, replay refused |

Offline equivalents: `tests/attention.test.js`, `tests/attention-cockpit.test.js`.

## 7. Stop / restart / failover

| # | Check | Kind | How | Expected |
|---|---|---|---|---|
| 7.1 | Stop stops delegation | LIVE | Stop during a run | no new session, assignment `stopped`/`interrupted`, canonical execution cancelled |
| 7.2 | Restart reconciles | LIVE | kill and restart the host | no assignment left `running`; lease/watchdog reconcile; the inbox survives |
| 7.3 | Failover on a provider error | LIVE | force a 429/5xx on the primary route | a checkpoint + a second attempt on the fallback route, linked to the first |
| 7.4 | Primary lock | LIVE | start a second host on the same home | the follower is read-only (`instance.primary: false`) |

## 8. Sign-off

1. Every LOCAL row above is green in the CI run of the branch.
2. Every LIVE row has been executed by the operator, with the payload/evidence
   kept (a `docs/e2e/` file or a screenshot).
3. `docs/LIMITATIONS.md` is updated with what is still open.
4. The version and `CHANGELOG.md` match the release.
5. Nothing is pushed, no PR is opened, no history is rewritten by the agent: the
   operator does that.

Anything not executed is reported as `UNVERIFIED — to be run by the operator`.
