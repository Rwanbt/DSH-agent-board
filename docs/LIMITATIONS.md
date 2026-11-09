# Known limitations and prioritized backlog

This file is the honest counterpart of `docs/TEST-REPORT.md`. Nothing below is
hidden behind a green check.

## Functional gaps

| # | Gap | Impact | Priority |
|---|---|---|---|
| 1 | **No Task Board execution record.** The board launches a plain `ctx.agents` session, so `taskboard_execution_report` refuses with “no running execution … of yours”. The agent’s comment carries the report instead. | Medium: the Task Board card lacks its execution report/merge evidence. | **P0** — bridge to the Task Board `run` path, or register the execution before launching |
| 2 | **Model/provider unknown for native sessions.** `sessions.list` does not expose the model, and the board does not subscribe to the model-directory remote. Board-launched cards show it from the assignment. | Low–medium: criterion “current model” is only met for board-owned sessions. | **P1** |
| 3 | **No live failover proof.** Stage 2/3 are covered by unit + host-integration tests with a fake agent registry; no real 429/5xx was provoked and `dsh-llm-fallbacks` is not installed, so its public contract was never evaluated. | Medium: a real provider error shape may differ. | **P1** |
| 4 | **No process-reboot test.** Persistence and reconciliation are tested at the plugin/state level, not by restarting the DSH process. `resume_requires_confirmation` is unit-tested only. | Medium: restart behaviour is believed correct but not demonstrated live. | **P1** |
| 5 | **Isolation refused, not applied.** A card with `isolation:'worktree'` is now SKIPPED with an explicit reason instead of running in the shared workspace. Worktree runs need the Task Board’s own executor or `ctx.worktrees.create`. | Medium: those cards are not executed by the board at all. | **P1** |
| 6 | **Task permission is clamped.** `permissionPresets.set` is best-effort and the policy `allowedPermissions` default never grants `danger-full-access`. A task that needs it must be dispatched outside the board. | Low–medium, by design. | **P1** |
| 7 | **No “hide idle” filter.** The panel renders every session (74 in this profile), which is a lot of idle cards. Compact mode helps but does not filter. | Low: UI density. | **P2** |
| 8 | **Notifications are badges only** (sidebar count, chips). No toast/OS notification, and no per-kind routing of urgent interventions. | Low: spec asked for discreet notifications; badges satisfy the “no spam” part, not the “urgent” emphasis. | **P2** |
| 9 | **No cost budget.** The autonomy budget counts tasks/hour; token/cost ceilings are not enforced. | Low–medium. | **P2** |
| 10 | **No automatic return to the primary route.** `shouldReturnToPrimary()` exists but is not wired to a safe boundary. | Low. | **P2** |
| 11 | **Client build is a concatenation, no typecheck.** The host/client are plain ESM (like the MIT reference), checked by `node --check` and tests; there is no `tsc`. | Low: fewer authoring guarantees. | **P2** |
| 12 | **Language race.** If `ctx.get('locale')` is not ready when the client module activates, the panel falls back to English for that page load even in a French shell. | Cosmetic. | **P2** — re-resolve the locale at render time |
| 13 | **Legacy dead routes** in the current host process (`/dsh-agent-board/api`, `/api/v1`) answer 500 after the hot-reload iterations; the shipped client uses `/api/v2`. | None for the shipped path; disappears on restart. | **P3** |
| 14 | **GitHub adapter not validated live.** Only issue/PR listing is implemented, CI status is not wired, and no token/repository was used. | Low: explicitly reported as unvalidated. | **P2** |
| 15 | **No `dsh-llm-fallbacks` integration.** The plugin is not installed; the router is task-level. A true in-request fallback needs the virtual chain routing explicitly. | Medium. | **P1** (if the operator wants in-request failover) |
| 16 | **No external-effect reconciliation.** The board lists mutating tool calls as `effect:unknown` and tells the resumed session to verify them; it cannot verify a commit/comment/push/PR itself. | Medium: a resumed agent could still double an effect if it ignores the instruction. | **P1** — needs forge/Task Board read-back |
| 17 | **`fencingToken` is recorded but not enforced on writes.** The instance lock and lease watchdog cover multi-host and ghost-slot cases, not a hostile stale writer inside one host. | Low. | **P1** |
| 18 | **No isolated-instance E2E in this delivery.** A fresh `DSH_HOME` has no credentials; a fake OpenAI-compatible provider plus a `--profile` bootstrap is the documented path (`docs/audit/D-tests-coverage.md`) but was not executed. | High for “A→Z validated” claims: the new runtime paths are unit/integration tested, not live-E2E tested. | **P1** |
| 19 | **Multi-writer protection is process-local only.** An OLD build (without `instance.lock`) running concurrently can still clobber the state; the lock protects new builds against each other. | Low: disappears once all hosts run this version. | **P2** |

## Non-goals kept as non-goals

- The board never sets `done`.
- The board never writes the Task Board ledger.
- The board does not pretend that a partial stream was resumed in the same
  request.
- No forge (GitLab/Jira/Linear/…) is announced as integrated; the skeletons say
  “not validated live” and now report no capability at all.

## Suggested order

1. P0 — attach board launches to a Task Board execution (or run through its
   supported run API).
2. P1 — isolated DSH instance E2E with a fake provider; live failover on a
   sacrificial route; process-restart rehearsal; worktree isolation; external
   effect reconciliation; model display for native sessions.
3. P2 — hide-idle filter, notifications, cost budget, locale refresh, TypeScript
   build, fencing enforcement.
