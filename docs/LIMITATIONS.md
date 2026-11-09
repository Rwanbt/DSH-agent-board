# Known limitations and prioritized backlog

This file is the honest counterpart of `docs/TEST-REPORT.md`. Nothing below is
hidden behind a green check.

## Functional gaps

| # | Gap | Impact | Priority |
|---|---|---|---|
| 1 | **No Task Board execution record.** The board launches a plain `ctx.agents` session, so `taskboard_execution_report` refuses with “no running execution … of yours”. The agent’s comment carries the report instead. | Medium: the Task Board card lacks its execution report/merge evidence. | **P0** — bridge to the Task Board `run` path, or register the execution before launching |
| 2 | **Model/provider unknown for native sessions.** `sessions.list` does not expose the model, and the board does not subscribe to the model-directory remote. Board-launched cards show it from the assignment. | Low–medium: criterion “current model” is only met for board-owned sessions. | **P1** |
| 3 | **No live failover proof.** Stage 2/3 are covered by unit + host-integration tests with a fake agent registry; no real 429/5xx was provoked and `dsh-llm-fallbacks` is not installed. | Medium: a real provider error shape may differ. | **P1** |
| 4 | **No process-reboot test.** Persistence and reconciliation are tested at the plugin/state level, not by restarting the DSH process. | Medium: restart behaviour is believed correct but not demonstrated live. | **P1** |
| 5 | **Isolation ignored.** `task.isolation` (worktree) is not applied; the session runs in the workspace directory. | Medium: two simultaneous tasks in the same workspace can collide. | **P1** — call `ctx.worktrees.create` before the launch |
| 6 | **Task permission best-effort only.** `permissionPresets.set` is called when available, but this was not verified with a non-default permission. | Low–medium. | **P1** |
| 7 | **No “hide idle” filter.** The panel renders every session (74 in this profile), which is a lot of idle cards. Compact mode helps but does not filter. | Low: UI density. | **P2** |
| 8 | **Notifications are badges only** (sidebar count, chips). No toast/OS notification, and no per-kind routing of urgent interventions. | Low: spec asked for discreet notifications; badges satisfy the “no spam” part, not the “urgent” emphasis. | **P2** |
| 9 | **No cost budget.** The autonomy budget counts tasks/hour; token/cost ceilings are not enforced. | Low–medium. | **P2** |
| 10 | **No automatic return to the primary route.** `shouldReturnToPrimary()` exists but is not wired to a safe boundary. | Low. | **P2** |
| 11 | **Client build is a concatenation, no typecheck.** The host/client are plain ESM (like the MIT reference), checked by `node --check` and tests; there is no `tsc`. | Low: fewer authoring guarantees. | **P2** |
| 12 | **Language race.** If `ctx.get('locale')` is not ready when the client module activates, the panel falls back to English for that page load even in a French shell. | Cosmetic. | **P2** — re-resolve the locale at render time |
| 13 | **Legacy dead routes** in the current host process (`/dsh-agent-board/api`, `/api/v1`) answer 500 after the hot-reload iterations; the shipped client uses `/api/v2`. | None for the shipped path; disappears on restart. | **P3** |
| 14 | **GitHub adapter not validated live.** Only issue/PR listing is implemented, CI status is not wired, and no token/repository was used. | Low: explicitly reported as unvalidated. | **P2** |
| 15 | **No `dsh-llm-fallbacks` integration.** The plugin is not installed; the router is task-level. A true in-request fallback needs the virtual chain routing explicitly. | Medium. | **P1** (if the operator wants in-request failover) |

## Non-goals kept as non-goals

- The board never sets `done`.
- The board never writes the Task Board ledger.
- The board does not pretend that a partial stream was resumed in the same
  request.
- No forge (GitLab/Jira/Linear/…) is announced as integrated; the skeletons say
  “not validated live”.

## Suggested order

1. P0 — attach board launches to a Task Board execution (or run through its
   supported run API).
2. P1 — live failover test on a sacrificial route; process-restart rehearsal;
   worktree isolation; model display for native sessions.
3. P2 — hide-idle filter, notifications, cost budget, locale refresh, TypeScript
   build.
