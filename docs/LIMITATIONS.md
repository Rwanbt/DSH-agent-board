# Known limitations and prioritized backlog

This file is the honest counterpart of `docs/GOAL3-DELIVERY.md`,
`docs/TEST-REPORT.md` and `docs/e2e/GOAL3-E2E.md`. Nothing below is hidden behind
a green check, and a simulated integration is never labelled live.

## Functional gaps

| # | Gap | Impact | Priority |
|---|---|---|---|
| 1 | **The Task Board execution contract is PROPOSED and SIMULATED.** The real `dsh-taskboard` 0.11.0 has no `/contract` route, so `executionBackend:'contract'` is refused against it (`contract_unavailable`, zero writes) and the two legacy backends remain the only live paths. | The unified record+failover flow is proven against a simulated server only. | **P0 for a live integration** — `docs/TASKBOARD-CONTRACT.md` lists exactly what the Task Board must implement |
| 2 | **No contract lease renewal.** A single model turn longer than the lease TTL (120 s in the simulation) is not renewed; the extension has no `renew` route. The board's own assignment lease is renewed by the watchdog, which is a different fact. | A very long turn could lose its reservation on a real server. | **P1** |
| 3 | **No live provider outage was provoked.** Retry/switch/handoff are unit- and host-tested, and the isolated E2E drives a scripted 429/5xx against a FAKE OpenAI-compatible provider. No real 429/5xx/quota was produced, and `dsh-llm-fallbacks` is still not installed. | A real provider error shape may differ from the classifier's assumptions. | **P1** |
| 4 | **Only DSH is a real executor.** Claude Code, Codex and OpenCode remain honest skeletons that declare no capability; the installed `dsh-subagent-claude-code` plugin is research-only in this build (`docs/ADAPTERS.md`). | Multi-engine supervision/launch is architecture, not a live feature. | **P1** |
| 5 | **No external-effect reconciliation.** Mutating tool calls are captured as `effect:unknown` and the resumed session is told to verify them; the board cannot confirm a commit/comment/push itself. | A resumed agent could still duplicate an effect if it ignores the instruction. | **P1** |
| 6 | **Fencing is intra-host/task-scoped.** `checkFencing` refuses a stale token or a released lease, and the instance lock covers two hosts; a hostile stale writer inside one host is out of threat scope. | Low in a single-operator deployment. | **P1** |
| 7 | **No process-crash injection mid-handoff.** Restart reconciliation, the lease watchdog and the fencing guards are tested at the plugin/state level, not by killing the DSH process at a precise point. | Restart behaviour is believed correct but not demonstrated under a kill -9. | **P1** |
| 8 | **Budget is bounded but not metered.** Concurrency, tasks/hour, requests/hour, retries, switches and cooldown are enforced; token and cost are reported `{available:false, reason:'provider_metering_unavailable'}` because no provider returns usable data. | No monetary guarantee is claimed. | **P1** |
| 9 | **A second host with an OLD build** (without `instance.lock`) can still clobber the state; the lock protects builds that run it. | Disappears once all hosts run this version. | **P2** |
| 10 | **Synthetic performance only.** The benchmarks in `docs/PERFORMANCE.md` use deterministic fixtures (5/20/50/150 agents, 1 000 sessions); the live host was not load-tested. | Numbers are a lower bound on real work, not a capacity claim. | **P2** |
| 11 | **Windows-only validation.** `node --test`, the isolated E2E and the benchmarks ran on Windows 11; Linux is untested. | Path/locking behaviour on Linux is unverified. | **P2** |
| 12 | **Client build is a concatenation, no typecheck** (`scripts/build-client.mjs`). It is validated by `node --check` and the tests, not by `tsc`. | Weakest authoring guarantee in the repo. | **P2** |
| 13 | **Notifications are badges only** (sidebar count, chips). No toast/OS notification and no per-kind routing. | The "urgent intervention" emphasis is visual only. | **P2** |
| 14 | **Locale may fall back to English** if `ctx.get('locale')` is not ready when the client module activates. | Cosmetic. | **P2** |
| 15 | **`waiting_agent` is not a status.** No native per-parent wait signal exists (investigated: `agent/status` is idle/running; `subagents` exposes awaited calls and child events; `uiSession.sessionStatus` has running/pendingInteraction/completionUnread). A parent awaiting a child stays `running`. | The goal asked for the state; inventing it would be worse than documenting the absence. | **P2 for DSH** — needs a native projection to promote it |
| 16 | **No forge write / ticket sync**, by design and by goal scope: GitHub read-only, the other forges and Jira/Linear are skeletons that declare nothing. | Out of scope. | non-goal |
| 17 | **Legacy dead routes** from hot reload (`/dsh-agent-board/api`, `/api/v1`) can answer 500 in a long-lived process; the shipped client uses `/api/v2`, and a restart clears them. | None for the shipped path. | **P3** |
| 18 | **GitHub adapter not validated live** (fake-API contract only, no token exercised). | Explicitly reported as unvalidated. | **P2** |

## Non-goals kept as non-goals

- Agent Board never writes the Task Board ledger, never moves a task to `done`,
  and never pins/changes the model stored on a card.
- Agent Board does not pretend that a partial stream was resumed in the same
  request: it hands the **task** off to a new session.
- No second kanban, no task registry, no cron scheduler, no forge connector.
- A simulated contract is never presented as a live integration.

## Suggested order

1. **P0** — the Task Board implements the execution contract
   (`docs/TASKBOARD-CONTRACT.md`), including `renew`; then re-run
   `scripts/e2e/run-e2e.mjs` against the **real** plugin and replace the
   simulated leg of the E2E.
2. **P1** — provoke a real provider outage on a sacrificial route; crash-inject a
   handoff; effect read-back through the contract/forge; promote one external
   engine (Claude Code) from skeleton to declared capabilities.
3. **P2** — Linux CI run, load test on a populated host, cost metering if a
   provider exposes it, notifications, TypeScript build.
