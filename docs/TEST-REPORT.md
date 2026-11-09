# Test report — Agent Board MVP

Run date: 2026-11-09 (Europe/Paris). Host: DSH `0.2.2-rc.1`, profile `desktop`,
GUI `http://127.0.0.1:62337`. Everything below was executed on this machine; no
result is inferred from a mock unless it says so.

## 1. Commands and raw results

| Command | Result |
|---|---|
| `node --test tests/` | **53 pass, 0 fail**, ~0.6 s wall clock |
| `node scripts/build-client.mjs` | bundle built, 61 972 bytes, 4 modules |
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
