# Known limitations and prioritized backlog

This file is the honest counterpart of `docs/TEST-REPORT.md`. Nothing below is
hidden behind a green check.

## Functional gaps

| # | Gap | Impact | Priority |
|---|---|---|---|
| 1 | **No Task Board execution record on the default backend.** With `executionBackend:'board'` the board launches a plain `ctx.agents` session, so `taskboard_execution_report` refuses with “no running execution … of yours”. The `taskboard` backend fixes this by delegating to `POST /tasks/:id/run`, at the cost of model-level failover. | Medium: choose failover or the execution record, explicitly. | **P1** — both backends are implemented and tested; the trade-off must be documented per project |
| 2 | **Model/provider unknown for native sessions.** `sessions.list` does not expose the model, and the board does not subscribe to the model-directory remote. Board-launched cards show it from the assignment. | Low–medium: criterion “current model” is only met for board-owned sessions. | **P1** |
| 3 | **No live failover proof.** Stage 2/3 are covered by unit + host-integration tests with a fake agent registry; no real 429/5xx was provoked and `dsh-llm-fallbacks` is not installed, so its public contract was never evaluated. | Medium: a real provider error shape may differ. | **P1** |
| 4 | **No process-reboot test.** Persistence and reconciliation are tested at the plugin/state level, not by restarting the DSH process. `resume_requires_confirmation` is unit-tested only. | Medium: restart behaviour is believed correct but not demonstrated live. | **P1** |
| 5 | **Isolation is backend-dependent.** With `executionBackend:'board'` a `isolation:'worktree'` card is SKIPPED with an explicit reason (never run in the shared workspace). `executionBackend:'taskboard'` lets the Task Board create the worktree. | Medium: worktree cards require the taskboard backend. | **P1** — native `ctx.worktrees` support on the board backend |
| 6 | **Task permission is clamped.** `permissionPresets.set` is best-effort and the policy `allowedPermissions` default never grants `danger-full-access`. A task that needs it must be dispatched outside the board. | Low–medium, by design. | **P1** |
| 7 | **No “hide idle” filter.** The panel renders every session (74 in this profile), which is a lot of idle cards. Compact mode helps but does not filter. | Low: UI density. | **P2** |
| 8 | **Notifications are badges only** (sidebar count, chips). No toast/OS notification, and no per-kind routing of urgent interventions. | Low: spec asked for discreet notifications; badges satisfy the “no spam” part, not the “urgent” emphasis. | **P2** |
| 9 | **No cost budget.** The autonomy budget counts tasks/hour; token/cost ceilings are not enforced. | Low–medium. | **P2** |
| 10 | **No automatic return to the primary route.** `shouldReturnToPrimary()` exists but is not wired to a safe boundary. | Low. | **P2** |
| 11 | **Client build is a concatenation, no typecheck.** The host/client are plain ESM (like the MIT reference), checked by `node --check` and tests; there is no `tsc`. | Low: fewer authoring guarantees. | **P2** |
| 12 | **Language race.** If `ctx.get('locale')` is not ready when the client module activates, the panel falls back to English for that page load even in a French shell. | Cosmetic. | **P2** — re-resolve the locale at render time |
| 13 | **Legacy dead routes** in the current host process (`/dsh-agent-board/api`, `/api/v1`) answer 500 after the hot-reload iterations; the shipped client uses `/api/v2`. | None for the shipped path; disappears on restart. | **P3** |
| 14 | **GitHub adapter not validated live.** Read-only issues/PRs with bounded pagination and rate-limit classification; the contract, pagination bound, quota/auth/transport classification and secret hygiene are tested against a FAKE GitHub API. No live repository, token or webhook was used. | Low: explicitly reported as unvalidated. | **P2** |
| 15 | **No `dsh-llm-fallbacks` integration.** The plugin is not installed; the router is task-level. A true in-request fallback needs the virtual chain routing explicitly. | Medium. | **P1** (if the operator wants in-request failover) |
| 16 | **No external-effect reconciliation.** The board lists mutating tool calls as `effect:unknown` and tells the resumed session to verify them; it cannot verify a commit/comment/push/PR itself. | Medium: a resumed agent could still double an effect if it ignores the instruction. | **P1** — needs forge/Task Board read-back |
| 17 | **`fencingToken` is recorded but not enforced on writes.** The instance lock and lease watchdog cover multi-host and ghost-slot cases, not a hostile stale writer inside one host. | Low. | **P1** |
| 18 | **Isolated-instance E2E is partial.** A disposable `DSH_HOME` + `--profile e2e` was booted and proved plugin activation, the real Task Board contract, a real launch, the restart/resume gate, lock takeover and SSE. No model turn can succeed there without credentials (no secret was copied), so the full task→`in_review` flow is not proven on this build. | High for “A→Z validated” claims. | **P1** — run the same harness with a fake OpenAI-compatible provider |
| 19 | **Multi-writer protection is process-local only.** An OLD build (without `instance.lock`) running concurrently can still clobber the state; the lock protects new builds against each other. | Low: disappears once all hosts run this version. | **P2** |

## Non-goals kept as non-goals

- The board never sets `done`.
- The board never writes the Task Board ledger.
- The board does not pretend that a partial stream was resumed in the same
  request.
- No forge (GitLab/Jira/Linear/…) is announced as integrated; the skeletons say
  “not validated live” and now report no capability at all.

## Suggested order

1. P1 — isolated DSH instance E2E with a fake provider; live failover on a
   sacrificial route; process-restart rehearsal; native worktree isolation on
   the board backend; external effect reconciliation; model display for native
   sessions.
2. P2 — hide-idle filter, notifications, cost budget, locale refresh, TypeScript
   build, fencing enforcement, forge live validation + webhooks.
