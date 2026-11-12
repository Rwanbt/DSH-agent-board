# Known limitations and prioritized backlog

This file is the honest counterpart of `docs/GOAL3-DELIVERY.md`,
`docs/GOAL4-DELIVERY.md`, `docs/TEST-REPORT.md` and `docs/e2e/GOAL3-E2E.md`.
Nothing below is hidden behind a green check, and a simulated integration is
never labelled live.

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
| 12b | **`data-recent` has no visual consumer.** The `recentlyFinished` view flag is emitted on the card (`data-recent`) but no CSS rule uses it; the green mark is driven by the unread status. | Cosmetic; documented rather than inventing a new visual. | **P2** |
| 13 | **Notifications are badges only** (sidebar count, chips). No toast/OS notification and no per-kind routing. | The "urgent intervention" emphasis is visual only. | **P2** |
| 14 | **Locale may fall back to English** if `ctx.get('locale')` is not ready when the client module activates. | Cosmetic. | **P2** |
| 15 | **`waiting_agent` is not a status.** No native per-parent wait signal exists (investigated: `agent/status` is idle/running; `subagents` exposes awaited calls and child events; `uiSession.sessionStatus` has running/pendingInteraction/completionUnread). A parent awaiting a child stays `running`. | The goal asked for the state; inventing it would be worse than documenting the absence. | **P2 for DSH** — needs a native projection to promote it |
| 16 | **No forge write / ticket sync**, by design and by goal scope: GitHub read-only, the other forges and Jira/Linear are skeletons that declare nothing. | Out of scope. | non-goal |
| 17 | **Legacy dead routes** from hot reload (`/dsh-agent-board/api`, `/api/v1`) can answer 500 in a long-lived process; the shipped client uses `/api/v2`, and a restart clears them. | None for the shipped path. | **P3** |
| 18 | **GitHub adapter not validated live** (fake-API contract only, no token exercised). | Explicitly reported as unvalidated. | **P2** |
| 19 | **No board-facing Task Board write API**, so coordination stays read-only: reassignment/priority/blocked/Kanban changes are local proposals (`applies:false`, `writes_unavailable`). The expected endpoints are documented in `docs/TASKBOARD-COORDINATION.md`. | The Super Orchestrator cannot apply a cross-project decision itself; an operator still acts in the Task Board. | **P0 for a live coordination** |
| 20 | **No inbound orchestrator-report channel.** A project orchestrator cannot push a report to the supervision layer; `receiveOrchestratorReports` is `unavailable` (`no_inbound_orchestrator_report_channel`). The layer observes real facts instead of trusting self-reports. | Aggregation is observation-based, not a message protocol. | **P2 for DSH** |
| 21 | **The Super Orchestrator is the host supervision layer, not an autonomous agent.** It has no model, no session and no self-spawning; it observes, proposes and gates board-owned delegations. The role grants no extra permission. | Anyone expecting a self-directed super-agent must know it is a policy/observability layer. | non-goal kept |
| 22 | **Deduction is text-based, not semantic.** A role is declared or deduced from the session/goal/task title with a fixed keyword table; an agent whose text carries no role signal gets the documented productive default (`worker`, marked inferred), and text with an ambiguous keyword can be mapped to the wrong role. The deduction is always labelled « déduit », keeps the raw declared name and is never used to grant a permission. The isolated E2E profile declares no role, so it exercises the deduced/default path, not a hand-declared team. | A role label may be approximate; it is never authoritative. | **P2** |
| 23 | **Delegation limits cover board-owned launches only.** The board enforces depth/concurrency/hourly/cycle rules on launches it performs; it cannot stop a launched agent from spawning sub-agents inside DSH (the native runtime owns that). Depth is read from the journal, never guessed. | A cascade inside one agent session is outside this gate. | **P1 for a full guarantee** |
| 24 | **The real Task Board exposes no priority/milestone field** (urgency is not forged into priority), and cross-project edges only cover tasks inside the bounded read snapshot (500 tasks / 1 000 edges). | Priority recommendations stay `unavailable`; very large ledgers are truncated deterministically. | **P2** |
| 25 | **Bundle size grew** from ~179 KB to ~499 KB uncompressed because the 32 SVG data URIs (~83 KB) and the new pure modules are concatenated in one file; there is no code-splitting in this no-bundler build. | One cached file, gzip-compressed by the host; no runtime cost measured as a problem. | **P3** |
| 26 | **Visual validation is Windows Chromium only.** Desktop/mobile, light/dark, all views and both inspectors were inspected in an isolated DSH host with five workspaces and 21 real sessions (roles deduced from the declared session text, `déduit` marked); a real Android device, macOS and Linux rendering are unverified. | A platform rendering difference is unverified. | **P2** |
| 27 | **No cross-plugin deep link to a Task Board task.** The DSH client exposes `layout.selectPanel(panelId)` but no documented "open this task" navigation, and the Task Board's panel id is not a public contract. The card/preview therefore shows the linked task id and its workflow state; it does not guess a panel id. | The operator copies/reads the id instead of jumping to the card. | **P2** |
| 28 | **No virtualisation of the cockpit grid.** 150 agents are 150 memoized cards in one CSS grid; the model stays at ~2.7 ms per round for 150 nodes (tested), but the DOM/paint cost of >100 cards was not measured on a low-end device. | A very large board may scroll less smoothly than a windowed list. | **P2** |
| 29 | **`En revue` needs a readable Task Board ledger.** Without the ledger the indicator shows `—` with the real reason; there is no "planification" count because no runtime field measures it. No percentage or completion measure is invented. | One indicator is unavailable when the integration is. | **P2 for DSH/Task Board** |
| 30 | **The GOAL 5 evidence host is simulated at the edges.** The isolated host used a scripted OpenAI-compatible provider and a simulated Task Board; the DSH host, the plugin, the sessions, the projection and the UI are real. A real provider outage or a real ledger was not exercised in this round. | The UI contract is proven; a real-integration behaviour difference is not excluded. | **P2** |
| 31 | **`Historique` opens the drawer, not a filter**, because the drawer keeps search/filtering/pagination and does not flood the cockpit with ended sessions. | One deviation from the mockup's chip semantics. | non-issue |
| 32 | **The status dot sits bottom-left** on the mascot, not bottom-right as drawn in the mockup, because the kit's role pictogram is bottom-right (product correction of 2026-11-11). Attention cards also state the status in words. | Deliberate visual deviation, documented. | non-issue |
| 33 | **No sub-agent in the GOAL 5 visual evidence.** The isolated host was populated with 21 real top-level sessions; the scripted provider never spawns a sub-agent, so the descendant badge and the sub-agent rows are verified by tests and the GOAL 4 evidence, not by a cockpit screenshot. | One visual case is not reproduced live. | **P3** |
| 34 | **The mobile band hides the mini orchestrator avatars** (they stay in the expandable details and on desktop) to keep the band at 57 px, as the mockup does. | One deviation, documented. | non-issue |

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

## GOAL 6 update (2026-11-12) — supersedes parts of the table above

These entries are the honest status after the Super Agent work; the historical
rows stay for audit, but where they conflict this section wins.

| # | Gap | Impact | Priority |
|---|---|---|---|
| G1 | **GitHub read + writes are live-validated on a disposable private repository** (issue, comment, PR, checks, idempotence, 2026-11-12; repo archived afterwards), but **not** on any real project repository (writes are off by default and mandate-gated). Merge, protected-branch push and issue deletion are **not implemented** (separate critical decisions). Idempotence bound after a host restart: the marker search covers one 100-item page plus a bounded search fallback; if that fallback is unavailable, a duplicate is possible (documented, not claimed otherwise). The full `issue → Task Board task → worker → PR/checks` chain remains blocked by G2. | No claim beyond the tested scope. | **P1** |
| G2 | **Task Board public-v1 writes are not live.** Installed 0.12.0 answers `503 public_api_disabled` because `DSH_TASKBOARD_PUBLIC_TOKEN` is not configured on the host. The client and contract are implemented and tested (local server + isolated real build), but no write was observed against the running instance. | Task Board remains the canonical reader; the unified execution backend stays on the negotiated contract. | **P1** |
| G3 | **The public-v1 execution backend is not wired into the host.** `lease → attach → settle` still uses the legacy negotiated contract. Switching transports without a live token would add a double-write risk. | One transport, not two; documented. | **P1** |
| G4 | **Assessment strictness.** A model output missing `schemaVersion`/`directiveEcho` is rejected with no effect (`invalid_assessment`); a repair loop is not implemented. | A cycle can be lost safely instead of acting wrongly. | **P1** |
| G5 | **Directive conflicts are lexical**, not semantic (explicit polarity markers on the same normalized subject). Ambiguous prose never conflicts. | Two contradictory prose directives may coexist; the operator sees both. | **P2** |
| G6 | **An approval is consumed at authorization time**, not at session creation: a failed `ctx.agents.create` still spends the decision (conservative). | Operator asks again; no duplicate effect. | **P2** |
| G7 | **Model discovery may be absent.** Without `ctx.llm`, `/superagent/model` refuses (`model_discovery_unavailable`) and the runtime falls back to the host's default model selection. | No invented model is ever used. | **P2** |
| G8 | **Item 1 above is re-scoped.** Task Board 0.12.0 does publish a versioned public-v1 API, but the legacy `/contract` route is still absent and the public surface is disabled on this install; the simulated contract leg therefore remains the only exercised execution contract. | Same as G2/G3. | — |
