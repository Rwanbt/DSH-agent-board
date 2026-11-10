# Agent Board (DSH plugin)

A card-and-branch cockpit for **DeepSeek Harness**: one card per session and
sub-agent, grouped by project, with real native statuses, click-to-preview,
double-click-to-open, a supervisor that actually launches Task Board work in
OFF / SUPERVISED / AUTONOMOUS modes, and a task-level failover/recovery path.

> **Status: PARTIAL (honest).** The panel runs live in DSH 0.2.2-rc.1, a real
> Task Board task was launched, implemented and moved to `in_review` by a real
> DSH session, and the UI interactions were exercised in a browser. The GOAL 2
> pass fixed the runtime P0s (live SSE, truthful states, durable acknowledgement,
> one authorization gate, single-writer state, real Task Board 0.10.2 contract,
> bounded retries) and added 152 automated tests; its behaviour was also exercised
> against a real isolated DSH instance (plugin activation, Task Board HTTP
> contract, real session launch, restart/resume gate, lock takeover, SSE, bounded
> retry). What remains **NOT TESTED** is a successful model turn on that isolated
> instance (a fresh `DSH_HOME` has no credentials — none were copied), a live
> provider outage, live forges/webhooks, and load/Linux.
> See [docs/TEST-REPORT.md](docs/TEST-REPORT.md),
> [docs/GOAL2-AUDIT-MATRIX.md](docs/GOAL2-AUDIT-MATRIX.md) and
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before trusting a claim.

## Branches

| Branch | Role |
|---|---|
| `main` | MVP baseline (`ec955fb`): panel, orchestration, simulated failover. |
| `dev` | Integration branch: GOAL 1 UX + GOAL 2 runtime audit/corrections, 152 tests. This is the branch to build and try. |
| `fix/agent-board-runtime-e2e` | Feature history of the GOAL 2 corrections and review rounds (merged into `dev`). |

The remote contains `dev` only; `main` can be published separately when the
baseline must be visible. Nothing is pushed to a forge on the plugin's behalf:
the board itself never pushes, merges or opens PRs.

## What it does

- **Cards & branches** — sessions from the native `sessions.list` snapshot,
  sub-agents from the `subagentCatalog` projection and/or `parentId`, grouped by
  DSH workspace, collapsible sub-trees, compact mode, responsive down to a
  phone viewport, DSH theme tokens (light/dark).
- **Exact statuses** — `running` (animated ring), `waiting_user` (yellow, from
  `uiSession.sessionStatus.pendingInteraction`), `recovering` (route switch in
  progress), `finished_unread` (green, until an explicit acknowledgement),
  `finished_read` (grey), `failed` (red, from the durable `turn/end` reason or
  the native lifecycle), `unavailable` (the runtime says the agent is gone),
  `idle`, `unknown` (never faked as “finished”). Elapsed time never infers a
  status, and each card exposes the reason/source of its status.
- **Click = preview, double-click = open** — a single click expands the last
  useful assistant segment, the expected action, the model/provider and the
  assigned task; a double-click (or the explicit “Open session” button, for
  touch/keyboard) navigates through `uiWorkspace.openSession`.
- **Orchestration** — OFF (observe only), SUPERVISED (proposals wait for
  approval), AUTONOMOUS (launches inside the mandate), plus a separate
  **Stop executions** action that cancels in-flight agents and blocks new
  delegation until **Resume**. OFF, Stop, approval and manual dispatch all pass
  through one host-side authorization gate.
- **Restart-safe** — assignments carry leases, idempotency keys and a
  persisted JSON state + JSONL audit journal; a single-writer instance lock
  prevents two DSH hosts from clobbering the same state; an assignment whose
  agent is gone becomes `interrupted` instead of being relaunched, and durable
  autonomy requires an explicit resume after a restart.
- **Failover** — error classification (429 and rate-limit wording, 5xx,
  timeout, transport, quota, auth, model unavailable, context overflow, partial
  stream), bounded retry that honours `Retry-After`, provider switch along an
  explicit chain, and checkpoint → handoff into a compatible session when the
  in-flight request cannot be repaired. Policy refusals and CI/code failures
  are never treated as provider outages.

## Requirements

- DSH `0.2.2-rc.1` (the only release this build was exercised on), Web GUI.
- Node.js `>=22` for the build/test scripts (`node --test`, no bundler, no
  runtime dependency).
- A DSH profile where the plugin can be added (the plugin never edits the DSH
  source tree).

## Install

The bundle is a normal DSH plugin (no DSH source changes):

```text
plugin_manager install_bundle  target=D:\App\DSH-agent-board
```

or from a shell with `dsh` on PATH:

```sh
dsh plugin --profile desktop add D:\App\DSH-agent-board
```

Then refresh the Web GUI once (client artifacts are served per page load).
The **Agent Board** entry appears in the global panel rail.

Uninstall:

```text
plugin_manager remove_bundle  target=dsh-agent-board
```

State lives in `$DSH_HOME/agent-board/` (`state.json`, `audit.jsonl`,
`instance.lock`); remove that directory only when no DSH host is running to
forget read cursors, previews and assignments.

## Use

- **Panel** — click a card to preview, double-click (or “Open session”) to
  navigate. Collapse a sub-tree with the chevron; “Compact cards” switches to a
  flat one-line list.
- **Orchestration** — pick OFF, SUPERVISED or AUTONOMOUS. In SUPERVISED the
  board lists proposals with Approve/Reject; in AUTONOMOUS it launches ready
  tasks up to `maxConcurrent`.
- **Stop executions** — separate from OFF: it cancels the live agents of the
  in-flight assignments and blocks new delegation (tick, dispatch, approval,
  failover) until **Resume**; switching mode does not lift a Stop.
- **Read cursors** — expanding an unread card (or reading the session in the
  native main view) posts an ack; the state is persisted host-side, so the card
  stays grey after a refresh.

## Configuration

The plugin has no `Config` schema yet; the policy is editable at runtime
through the panel API and is persisted in `state.json`:

```http
POST /dsh-agent-board/api/v2/policy
{ "policy": { "maxConcurrent": 2, "maxSwitches": 2,
              "allowedWorkspaces": [], "allowedProviders": [],
              "allowedPermissions": ["read-only","workspace-write"],
              "executionBackend": "board",
              "allowCloudFallback": false,
              "routeChain": [{"provider":"opencode-go","model":"deepseek-v4.1-flash"}],
              "autonomyBudget": {"maxTasksPerHour": 6},
              "retryCooldownMs": 300000, "maxAttemptsPerRevision": 4 } }
```

`allowedWorkspaces: []` means “every workspace visible to the board”.
`executionBackend: "board"` creates the session itself (model-level failover
possible); `"taskboard"` delegates to the Task Board executor
(`POST /dsh-taskboard/tasks/:id/run`: execution record, permission, worktree)
and explicitly gives up model failover. The Task Board ledger is read-only from
the board's perspective; the launched session does the claiming and the
`in_review` transition, and `done` stays human-only (the Task Board tool refuses
it at code level).

## Safety invariants

- `done` is never set by the board or a launched agent.
- The Task Board ledger is never written by the board; only the official
  `taskboard_*` tools act on it, from the launched session.
- One host owns `$DSH_HOME/agent-board` at a time (`instance.lock`); a secondary
  host serves reads and refuses mutations (409 `not_primary`).
- A card cannot widen its own permission beyond the policy mandate; a worktree
  card is skipped (board backend) or delegated (taskboard backend) — never run
  unisolated in the shared workspace.
- The plugin never pushes, merges or opens a PR.

## HTTP API (same-origin, authenticated by the DSH browser session)

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-agent-board/api/v2/state` | full board state + adapter matrix |
| GET | `/dsh-agent-board/api/v2/events` | SSE stream of the same state |
| GET | `/dsh-agent-board/api/v2/adapters` | capability matrix |
| POST | `/mode` | `{mode: off\|supervised\|autonomous}` |
| POST | `/policy` | merge a policy patch |
| POST | `/stop` | cancel in-flight executions and block new delegation |
| POST | `/ack` | acknowledge one session (`{sessionId, seen?:false}`) |
| POST | `/tick` | run one orchestration tick now |
| POST | `/resume` | clear the operator stop (Stop is not OFF) |
| POST | `/dispatch` | `{taskId}` explicit manual launch |
| POST | `/proposals/:id/decide` | `{approve:boolean}` |

Every request goes through `ctx.connection.requestRejection` before the
handler runs.

## Tests

```sh
node --test tests/            # 152 tests, ~1.0 s
node scripts/build-client.mjs # regenerate src/client.js
node --check src/client.js && node --check src/host/index.js
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Contracts & adapters](docs/CONTRACTS.md)
- [Provenance & compatibility](docs/PROVENANCE.md)
- [Test report (PASS/PARTIAL/FAIL, GOAL 2 §10–§14)](docs/TEST-REPORT.md)
- [GOAL 2 audit matrix (implemented/partial/absent/not-testable)](docs/GOAL2-AUDIT-MATRIX.md)
- [GOAL 2 delivery, rollback and isolated-profile trial](docs/GOAL2-DELIVERY.md)
- [Isolated-instance E2E evidence (redacted)](docs/e2e/isolated-instance-evidence.md)
- [Known limitations & backlog](docs/LIMITATIONS.md)

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
