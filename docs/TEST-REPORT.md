# Test report — Agent Board MVP

Run date: 2026-11-09 (Europe/Paris). Host: DSH `0.2.2-rc.1`, profile `desktop`,
GUI `http://127.0.0.1:62337`. Everything below was executed on this machine; no
result is inferred from a mock unless it says so.

> **GOAL 4 update (2026-11-11, branch `feat/agent-board-mascots-super-orchestrator`).**
> The suite is now **411 tests / 411 pass / 0 fail / 0 skipped** (~2.2 s), including
> the artifact-integrity check that rebuilds `src/client.js` in memory and compares
> it byte-for-byte with the committed bundle. New coverage: the 32 approved SVGs and
> the exact palette, role aliases/generic fallback, avatar rendering (React stub),
> the hierarchy view, the supervision/delegation limits, and the read-only Task
> Board coordination model. The isolated real-DSH-host E2E still passes (15/15,
> fake provider + simulated Task Board). Visual evidence:
> `docs/e2e/screenshots/goal4-*.png`; delivery and limits:
> `docs/GOAL4-DELIVERY.md`, `docs/MASCOTS-SUPER-ORCHESTRATOR.md`,
> `docs/REVIEW-GOAL4.md`, `docs/LIMITATIONS.md` (rows 19–27).
> **Not tested:** a real Task Board write/coordination API (none exists), a
> populated panel whose agents declare the 15 roles (the simulated profile declares
> none, so the generic identity is what was inspected), a real screen reader,
> non-Windows rendering, and a live 15 s supervision soak.

> **GOAL 3 update (2026-11-10, branch `goal3/supervision-orchestration`).** The
> suite is now **315 tests / 315 pass / 0 fail / 0 todo**, stable over three
> consecutive runs, plus a **live isolated-host E2E** (`docs/e2e/GOAL3-E2E.md`,
> 15/15 assertions, exit 0). Evidence classes: unit/pure (routing, budget,
> fencing, projection), contract simulation (Task Board extension against
> `tests/fixtures/fake-taskboard-server.mjs`), host integration (real HTTP API
> against fakes), live isolated DSH host (fake OpenAI-compatible provider +
> simulated Task Board extension), synthetic benchmarks
> (`docs/PERFORMANCE.md`). **Not tested:** a real Task Board implementing the
> extension, a real provider outage, Linux, crash injection, live load.
> See `docs/GOAL3-DELIVERY.md`, `docs/REVIEW-GOAL3-BACKEND.md`,
> `docs/REVIEW-GOAL3-SUPERVISION.md`. The GOAL 1/GOAL 2 sections below are kept
> as historical evidence.

> **GOAL 2 update (same day, branch `fix/agent-board-runtime-e2e`).** The
> original report below is kept as the GOAL 1 evidence. The suite is now
> **112 tests / 112 pass / 0 fail**; see §10 for the exact GOAL 2 commands,
> the new test files, and what remains **NON TESTÉ**. The GOAL 2 audit matrix
> is `docs/GOAL2-AUDIT-MATRIX.md`.

## 1. Commands and raw results

| Command | Result |
|---|---|
| `node --test tests/` (GOAL 1) | **53 pass, 0 fail**, ~0.6 s wall clock |
| `node scripts/build-client.mjs` (GOAL 1) | bundle built, 61 972 bytes, 4 modules |
| `node --check src/host/index.js` | exit 0 |
| `node --check src/client.js` | exit 0 |
| `node --check src/client/core.js` | exit 0 |
| `plugin_manager install_bundle D:\App\DSH-agent-board` | `application: applied`, `warnings: []` |

Test files: `projection.test.js` (statuses, tree, collapse, preview, grouping,
no time inference), `dag.test.js` (OFF/supervised/autonomous, DAG, mandate,
concurrency, budget, stop plan), `lease.test.js` (lease conflict, fencing,
idempotency, restart reconciliation), `router.test.js` (classification and the
three failover stages), `journal.test.js` (atomic/serialized writes, corrupt
quarantine, audit), `connectors.test.js` (Task Board normalize/read-only,
GitHub honesty, checkpoint/handoff), `host-integration.test.js` (real plugin
`apply()` with a fake DSH context: propose → approve → launch, duplicate
refusal, simulated 503 → handoff, stop, restart reconciliation, route
lifecycle), `client-core.test.js` (store merge, ack, SSE, error path).

## 2. Live end-to-end — the gate that matters

A real Task Board task was created and the board was set to AUTONOMOUS:

| Fact | Value |
|---|---|
| Task | `t-mw9q6fpe-qfjnvy` — “E2E Agent Board — écrire un fichier de preuve puis passer en revue” |
| Assignment | `asg-ebf10668-6bbf-43b4-a325-01e56afb8d7e` (`running`) |
| Session created by the board | `session-agentboard-ed7b4df5-50f7-41f5-96ed-23a5d285d588` |
| Route | `opencode-go/deepseek-v4.1-flash` |
| Claim | task `in_progress (v2)`, claim owner `agent session-agentboard-ed7b4` |
| Deliverable | `docs/AGENT-BOARD-E2E.md` (151 bytes, UTC timestamp + task id) |
| Comment / report | comment at 2026-11-09T20:42:09Z with file content and verification |
| Final Task Board status | **`in_review (v5)`** — never `done` |
| Human confirmation | still required and untouched |

The launched session used the official `taskboard_*` tools to claim, verify and
move the task. The board itself performed **no ledger write**.

Known deviation observed live: `taskboard_execution_report` was refused twice
with “no running execution and no settled execution of yours to report on”
because the board launches a plain agent session, not a Task Board execution
record. The agent reported this instead of forcing it. See
`docs/LIMITATIONS.md` (P0 backlog item).

## 3. UI checks (real browser, authenticated desktop session)

| Check | Result | Evidence |
|---|---|---|
| Panel entry registered in the global rail | ✅ | sidebar button “Agent Board” |
| Panel renders sessions grouped by project | ✅ | snapshot: App / default-workspace / Ravum / Ravum-flow, live counts |
| Running status uses the animated ring | ✅ | 3–4 running cards during the run |
| Unread after a finished turn | ✅ | badge “1”, card chip `unread` |
| One click = preview, no navigation | ✅ | expanded text: last assistant segment, task id, model, cwd, “Ouvrir la session” |
| Ack persisted host-side | ✅ | `acks` contains the session id; card becomes `finished, consulted` |
| Double click = open session | ✅ | page title becomes “Agent Board — E2E …”, board hidden |
| Explicit “Open session” button | ✅ | rendered in the expanded card (mobile/keyboard path) |
| Light / dark tokens | ✅ | `docs/screenshots/agent-board-light.png`, `agent-board-dark.png` |
| Mobile viewport (390×844) | ✅ | `docs/screenshots/agent-board-mobile.png` |
| Orchestrator control reflects host state | ✅ | `aria-pressed` = Autonomous after POST /mode |
| Stop button disabled when nothing runs | ✅ | disabled attribute in the snapshot |

Not exercised live: 30-agent scale beyond the user’s real 74-session workspace
(the panel rendered 74 sessions, i.e. above the 30 requested), waiting/failed
cards from natural events (unit-tested), and keyboard-only traversal (focus
styles are implemented; no dedicated a11y audit was run).

## 4. Failover tests — simulated, clearly labelled

`router.test.js` covers: 429 (Retry-After respected), 5xx, timeout,
transport, quota, 401, context overflow, partial stream, chain exhaustion,
`maxSwitches`, provider cooldown, local-only restriction, policy refusal, and
CI/code failures (`notModel`, no switch).

`host-integration.test.js` drives the real host plugin with a fake DSH agent
registry: an error **after** an assistant message was captured produces a
checkpoint (`git` snapshot when available), marks the old assignment
`superseded`, opens a second session on the next route (`backup/medium`), links
`previousSessionId`, and records the route event. `stop` then cancels the live
agent.

**This is not a live provider outage test.** No real 429/5xx was provoked
against a configured provider, and `dsh-llm-fallbacks` is not installed. Gate 4
is therefore PARTIAL.

## 5. Restart / persistence

- State survived several plugin remove/install cycles: after reload,
  `mode=autonomous`, the assignment and the ack cursor were still present
  (`state.json`).
- `host-integration.test.js` writes a state file with a `running` assignment,
  boots the plugin with a registry that has no live agent, and asserts the
  assignment becomes `interrupted`, is reported in `reconcileNotes`, and that
  **no session is created** (no double launch).
- A real DSH process reboot was **not** performed (it would end the session
  running this test). Gate 5 is PARTIAL.

## 6. Defects found by testing (and fixed)

| Defect | How found | Fix |
|---|---|---|
| Ack posted `{}` → 400 `sessionId_required` | browser E2E: read cursor never persisted | `ack` receives the id string (client), verified persisted |
| `POST /policy` reset the mode to `off` | live API call returned `mode: off` | policy merge keeps the current mode unless it is explicitly provided |
| Unload did not remove the HTTP route → “duplicate route” on reinstall | install cycle failed | route + timers registered through `ctx.effect`; regression test added |

Residual live-process artifact: the current DSH process still hosts the routes
of the two iterations that ran before the lifecycle fix (`/dsh-agent-board/api`
and `/api/v1` answer 500). The shipped client uses `/api/v2`; a host restart
removes the orphans. This is a development artifact, not a shipped route.

## 7. Observed resources (whole host, not attributable to the plugin)

| Metric | Value |
|---|---|
| DSH desktop host working set | 837 MB |
| Private memory | 1 036 MB |
| Cumulative CPU time of the host process | 533.9 s (process lifetime) |
| Test suite wall clock | ~0.6 s |

No per-plugin memory attribution is claimed: the host bundles ~229 entries and
the user’s real workload.

## 8. Definition-of-done matrix (specification §8)

| # | Criterion | Verdict | Justification |
|---|---|---|---|
| 1 | Panel loads in DSH with sessions/sub-agents, exact statuses, click preview, double-click open | **PASS** | live panel, 74 sessions, 3 running, preview + navigation + ack verified; language falls back to English when the locale service is not ready at activation |
| 2 | Orchestrator toggle really launches tasks; supervised asks approval | **PASS** | live AUTONOMOUS launch of a real task; SUPERVISED propose→approve→launch covered by the host integration test and the same API path |
| 3 | A Task Board task is taken to `in_review` with proof, `done` human-only | **PASS** | `t-mw9q6fpe-qfjnvy` → `in_review (v5)`, comment + file, agent refused `done` |
| 4 | A provider switch A→B is tested, and an interruption yields a controlled resume or a visible blocked state | **PARTIAL** | switch/handoff/blocked covered by unit + host integration with a simulated 503 after partial output; no live provider outage was provoked |
| 5 | Observation, task state and in-flight operations survive a restart without double launch | **PARTIAL** | persistence verified across plugin reloads and a persisted-state reconciliation test; no process reboot, no doubled launch observed but also not provoked live |
| 6 | Build, unit/integration/E2E results reported without falsification | **PASS** | 53/53, syntax checks, real E2E, failures documented above |

**Overall: PARTIAL** — criteria 1, 2, 3 and 6 pass; 4 and 5 are simulated and
must not be read as live provider-outage or reboot guarantees.

## 9. Residual risks

1. `taskboard_execution_report` cannot attach to a board-launched plain
   session — the execution report is missing from the Task Board card even
   though the work is complete (mitigation: comment contains the full report).
2. The failover path is exercised with a fake agent registry; a real provider
   error could surface a different error shape (the classifier infers HTTP
   status from the message when no status field is present).
3. The current host process carries two dead API routes from the development
   iterations (see §6).
4. A DSH upgrade may rename `uiSession.sessionStatus` or
   `uiWorkspace.openSession`; the UI then degrades to `unknown`/no navigation
   rather than crashing.

## 10. GOAL 2 — runtime truth, governance and failover run

Branch `fix/agent-board-runtime-e2e`, base `75b40d8` (GOAL 1 UX commit).
Every command below was run in this workspace on 2026-11-09.

| Command | Result |
|---|---|
| `node --test tests/` | **112 tests, 112 pass, 0 fail**, ~0.9 s |
| `npm run check` | exit 0 (`node --check` on host + client, then the suite) |
| `node scripts/build-client.mjs` | bundle rebuilt from the 13 authored modules |
| `node --check src/client.js` | exit 0 |
| `node scripts/smoke-host.mjs` | `smoke: OK` |

New test files and what they pin:

- `tests/host-governance.test.js` — OFF refuses approval and `/dispatch`; Stop
  blocks new delegation and cancels live agents; a stop during an in-flight
  launch cancels the created session; a stop suppresses failover recovery; a
  stopped attempt can be relaunched as a new attempt; a card cannot escalate to
  `danger-full-access`; a worktree card is not run unisolated; the SSE stream
  uses the named `state` event.
- `tests/lock.test.js` — single-writer instance lock (create/refuse/stale
  takeover/corrupt/heartbeat/release/pid liveness).
- `tests/journal.test.js` — a failed write no longer poisons the queue, Windows
  rename retry, stale tmp cleanup, unacked `turnEnd` protection.
- `tests/projection.test.js` — native-only failure stays visible, preview of an
  errored turn is `partial`, `recovering` and `unavailable` are distinct,
  `viewing` (native main view), ack vs `completionUnread`.
- `tests/connectors.test.js` — real Task Board 0.10.2 field mapping (`version`,
  `claimedBy`, `executions`), legacy `rev` alias, skeleton capability honesty.
- `tests/router.test.js` — rate-limit wording, transport-in-message, deleted
  model, 403 auth vs policy.
- `tests/dag.test.js` — tasks already running/claimed/scheduled by the Task
  Board are skipped, worktree cards skipped, workspace serialization.

### What is NOT tested (explicit)

- **No isolated-instance E2E in this delivery.** A fresh `DSH_HOME` has no
  `.credentials.yaml`; the documented path (`dsh --profile e2e
  --from-default-profile web`, `--port 0`, fake OpenAI-compatible provider,
  `link:` plugins) was not executed. The new runtime paths are therefore
  **unit/integration tested, not live-E2E tested**.
- **No process restart** of the DSH host (would kill the session hosting this
  work). Restart reconciliation and the resume gate are observed at plugin
  level only.
- **No real provider outage** and no `dsh-llm-fallbacks` (not installed).
- **No forge call** (GitHub/GitLab): no credential, no repository, no webhook.
- **No Linux run**, no 30-agent/200-session load test, no uninstall rehearsal.
- **The live GOAL 1 E2E evidence in §2–§9** was produced by the PREVIOUS build
  (65 tests). It is real, but it does not exercise the GOAL 2 code paths.

### Live evidence of the multi-writer defect fixed here

On the running instance (`~/.dsh/agent-board`), `GET /state` returned
`mode:"off"` with 16 acks while `state.json` on disk (same time window) held
`mode:"autonomous"`, `acks:{}` and a newer `lastTick`; four leaked
`state.json.tmp-2096-*` files were present. That divergence is what the
single-writer lock, the write-queue fix and the tmp cleanup address.

### Live evidence collected for the client half (host process NOT restarted)

The GUI host still runs the previous host build, so host-side changes are not
live. The client bundle is served from disk and was reloaded in the real page:

| Check | Result |
|---|---|
| Boot bundle `…/plugins/??…dsh-agent-board/client.js&rev=ae33…` | 5 525 192 bytes, `new Function` parse OK |
| Bundle contains the fix | `addEventListener('state'` present, `statusRecovering`, `native_view`, `post('/resume'` present |
| Real SSE endpoint from the page | `GET /dsh-agent-board/api/v2/events` connected, **1 named `state` frame received, 0 unnamed** — the old `onmessage` path received none, which is the fixed P0 |
| Page reload | no `dsh-agent-board: import failed`; only the pre-existing `deepseek-account` profile error remains |

This proves the SSE defect and its fix against the live host. It does NOT prove
the host-side orchestration/durability changes, which need a host restart.

## 11. GOAL 2 — second batch: resilience, forge contract, Task Board backend

Same branch, after the first delivery commit. Every command run in this
workspace on 2026-11-09.

| Command | Result |
|---|---|
| `node --test tests/` | **152 tests, 137 pass, 0 fail**, ~1.0 s |
| `node scripts/build-client.mjs` | bundle rebuilt, 13 modules |
| `node --check src/client.js` | exit 0 |
| `node --check` on every `src/**/*.js` | exit 0 |

New coverage in this batch:

- `tests/resilience.test.js` (6) — a `turn/end` that lands while
  `ctx.agents.create` is still in flight settles the assignment (never flipped
  back to `running`); duplicate and unknown `turn/end` events are ignored;
  the lease watchdog interrupts a running assignment whose live agent is gone;
  a restart in autonomous mode requires an explicit `/resume` before delegating;
  overlapping ticks coalesce and concurrent dispatches start exactly one
  session; a stale lock from a dead process is taken over.
- `tests/forge-contract.test.js` (8) — fake GitHub API: bounded `Link`
  pagination (3 pages max, truncation flag), exhausted quota is `rate_limited`
  + retryable with a delay, 401 is a non-retryable credential refusal, 5xx and
  transport errors are retryable, the token never appears in an error, `get()`
  returns the forge revision usable as a conflict token, and the declared
  capability matrix stays read-only.
- `tests/backend-taskboard.test.js` (5) — `executionBackend:'taskboard'` runs a
  worktree card through `POST /dsh-taskboard/tasks/:id/run` without creating a
  board session, records `executionId` + `sessionId` + `backend`, a refused run
  fails the assignment, a provider error is visible as `backend_no_failover`
  with no handoff session, Stop cancels the Task Board session, and an unknown
  backend falls back to `board`.
- `tests/dag.test.js` — a permission outside the mandate is skipped with
  `permission_not_allowed:<level>`; the widened mandate allows it.
- `tests/host-governance.test.js` — permission refused before launch; an allowed
  permission is applied through `permissionPresets`.

### Explicit NOT TESTED (unchanged)

No isolated-instance DSH E2E, no real provider outage, no `dsh-llm-fallbacks`,
no live forge/webhook, no process restart, no Linux, no load test. The
`taskboard` backend is contract-tested against a fake HTTP API, not against a
live Task Board instance from this process.

## 12. GOAL 2 — isolated-instance E2E (real DSH host)

Detailed, redacted evidence: [`docs/e2e/isolated-instance-evidence.md`](e2e/isolated-instance-evidence.md).

| Check | Result |
|---|---|
| Fresh `DSH_HOME` + `dsh --profile e2e` (from `web`) + `link:` plugins | profile created and booted, no network needed |
| Plugin activation (real host) | `/dsh-agent-board/api/v2/state` 200, `instance.primary: true`, 0 console errors |
| Task Board contract (real HTTP) | `sync.ok: true`, real ledger `revision`/`tasks`, capability `run: true` |
| Real task + real launch | task `t-mw9ue95x-90qkvm` created (201), autonomous tick launched a real `ctx.agents` session |
| Model turn | **FAILED as expected**: no credentials in the isolated home (no secret copied) |
| Defect found by E2E #1 | unbounded automatic relaunch (6 sessions in ~20 s) → **fixed** with `retryCooldownMs` + `maxAttemptsPerRevision` |
| Defect found by E2E #2 | "no API key" classified `unknown` (2 retries) → **fixed** as non-retryable `AUTH` |
| Restart (process killed, same home) | `stale_lock_taken_over`, primary true, `resume_requires_confirmation`, `/dispatch` 409 before `/resume` |
| Post-fix bounded retry | tick after resume: `autonomy_budget_exhausted`, then `max_attempts_reached`, **0 new session** |
| SSE (real host, new client) | 1 named `state` frame, 0 unnamed |

Tests: **152/152**. The isolated home was deleted afterwards; the real profile
and port 62337 were untouched.

Still NOT tested: a successful model turn / full task→in_review flow in the
isolated instance, the `taskboard` backend against a live Task Board executor,
load, Linux, uninstall.

## 13. GOAL 2 — independent review round

An independent read-only review of `75b40d8..HEAD` found 3 P1 and 16 P2 issues.
All P1s and the material P2s are fixed here; the rest are documented below.

| Finding | Fix |
|---|---|
| P1 handoff bypassed the launch gate | `authorizeHandoff()`: after the git capture it re-checks mode/stop, workspace mandate, permission mandate, isolation, route allow-list **and re-reads the Task Board** (trashed / terminal / claimed-by-another / active execution ⇒ `handoff_suppressed:<reason>`). Tests: trashed card and mandate changed mid-run. |
| P1 Stop lost the race against a handoff | the handoff captures `stopEpoch` before `ctx.agents.create` and cancels the new session after it returns (honest `stopped_during_handoff` / `stop_race_cancel_failed`). The recovering assignment now also carries a lease so restart/watchdog can interrupt it. |
| P1 lock takeover was not compare-and-swap | stale takeover is a `rename` to a sanitized quarantine name (only one racer can rename), then `wx` create. A Windows bug found here: the owner id contains `:` and the quarantine path silently failed (ADS), so takeover never worked for real host ids — now sanitized. Concurrent test added. |
| P2 taskboard stop could claim "stopped" without a cancel | now distinguishes cancelled vs `stop_failed:<reason>` exactly like the board backend. |
| P2 `recovering` outside lifecycle guards | recovering assignments get a lease; restart reconciliation and the watchdog include them; DAG counts them as active. |
| P2 `/mode` silently lifted Stop | removed: only `POST /resume` clears `stoppedAt`; test added. |
| P2 a demoted host could still delegate | `onTurnEnd` returns immediately when `isPrimary` is false. |
| P2 SSE frames omitted `instance` | both frames now carry it; client test asserts a follower frame keeps `primary:false`. |
| P2 native-view ack fired once per session | keyed by session activity timestamp and cleared when the view closes. |
| P2 GitHub 403 without rate-limit header | only `x-ratelimit-remaining: 0` is a quota; otherwise credentials rejected. |
| P2 bare 404 = "model deleted" | new `config_error` kind (non-retryable, switchable); the model-unavailable kind requires model wording. |
| P2 `AUTH_PATTERN` matched "401" substrings | word boundaries (`\b401\b`); a policy 403 with `req_401abc` stays a refusal. |
| P2 recovering reason never written | the handoff draft stores `reason`/`recoveringAt`/permission/isolation; lease test pins the persistence. |
| P2 `turnActivity` deleted before use | kept until the next `turn/start`; `afterFirstChunk` now reflects THIS turn. |
| P2 retry bound ignored `done`-but-still-`todo` | a completed assignment whose card is still `todo` obeys the same cooldown/attempt cap. |
| P2 dispose ordering | a synchronous `writeSync` saves the final document BEFORE the lock is released. |
| P2 test honesty | renamed the `/mode off` test, added audit-line assertion to the follower test, concurrent CAS test, bare-404/401-substring tests, handoff lease assertion. |

Still open and documented: the `taskboard` backend can miss a `turn/end` that
fires before `runTask` returns its `sessionId` (the Task Board contract exposes
no execution status); `src/client.js` in the working tree is generated and may
lag when another session edits client sources concurrently (not committed here).

## 14. GOAL 2 — verification round on the review fixes

A second independent read-only pass at HEAD 86dc5b0 confirmed the P1 fixes and
found 5 defects introduced by them. All are fixed here:

| Finding | Fix |
|---|---|
| B1 claim check only survived one hop (`claimedBy` compares to the just-ended session) | the claim is accepted when it belongs to ANY session in this task's assignment history; a FOREIGN claim is still refused. Two-hop test + foreign-claim test added. |
| B2 `activeExecution` had no self-exemption | an active execution is ours when `task.activeExecutionId === assignment.executionId`; otherwise it suppresses. |
| B3 a recovering record interrupted during `createSession` was resurrected to running | the handoff checks `status === recovering` after the create and cancels the new session otherwise (`handoff_settled_early`). |
| B4 the rename takeover was not a true CAS; dispose unlinked the lock directly | a mutually exclusive `instance.lock.takeover` gate (`wx`, TTL-broken) serializes the takeover; `releaseSync()` marks the lock released **and** removes it before shutdown. |
| B5 a queued async write could rename over the synchronous shutdown save | `writeSync()` sets `closed`; every queued write checks it before renaming and aborts. Test: queued write rejects, shutdown document wins. |
| (ii) the client bundle at HEAD lacked the `nativeAcked` fix | the bundle was rebuilt **from HEAD sources only** (not from the concurrently edited worktree) and committed. It contains the SSE `state` listener, `statusRecovering`, `/resume` and the `nativeAcked` Map; it does not contain the other session's UX changes. |

Tests: **152/152**.

Known limit kept: on the `board` backend a handoff session never holds the
ledger claim itself (the Task Board claim is `todo→in_progress` only and the
board may not write the ledger). If the Task Board has not yet settled the
previous session's claim when the resumed session ends, the card can stay
`in_progress` under the old session. The board does not fake a claim transfer;
the operator sees the card and the assignment history.
