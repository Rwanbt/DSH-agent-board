# Agent Board (DSH plugin)

A card-and-branch cockpit for **DeepSeek Harness**: one card per session and
sub-agent, grouped by project, with real native statuses and model/provider, a
supervisor that launches Task Board work in OFF / SUPERVISED / AUTONOMOUS modes,
a failover path that switches model/provider and hands the task off, and a
**unified execution backend** that keeps the Task Board as the canonical
execution record while the board keeps the model failover.

> **Status: PARTIAL (honest).** The supervision cockpit, the orchestration gates,
> the routing/budget/fencing layer and the unified execution contract are
> implemented and tested (see `docs/GOAL3-DELIVERY.md` for the exact evidence
> classes). The execution contract is a **proposed extension of the Task Board**
> and is currently proved against a **simulated** server
> (`tests/fixtures/fake-taskboard-server.mjs`): the real `dsh-taskboard` 0.11.0
> does not implement it yet, so `executionBackend:'contract'` is refused against
> it (`contract_unavailable`) and the two legacy backends remain the live paths.
> A real isolated DSH host was booted with a fake OpenAI-compatible provider and
> the full task → session → model turn → lease/attach/settle → `in_review` path
> was exercised **without user credentials**; a real provider outage and a real
> Task Board extension were **not** exercised. See
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before trusting a claim.

## Branches

| Branch | Role |
|---|---|
| `main` | MVP baseline (`ec955fb`): panel, orchestration, simulated failover. |
| `dev` | Integration branch: GOAL 1 UX + GOAL 2 runtime audit/corrections + GOAL 3 supervision/orchestration, the branch to build and try. |
| `fix/agent-board-runtime-e2e` | Feature history of the GOAL 2 corrections and review rounds (merged into `dev`). |
| `goal3/supervision-orchestration` | GOAL 3 work: unified execution contract, layered routing/budget/fencing, supervision fidelity, adapters, benchmarks, reviews (to be merged into `dev`). |

The board never pushes, merges or opens a PR on a forge: the forge adapters are
read-only and the Task Board stays the sole owner of tickets and executions.

## What it does

- **Cards & branches** — sessions from the native `sessions.list` snapshot,
  sub-agents from the `subagentCatalog` projection and/or `parentId`, grouped by
  DSH workspace, collapsible sub-trees, compact mode, responsive down to a phone
  viewport, DSH theme tokens (light/dark).
- **Exact statuses, with provenance** — `running` (animated ring),
  `waiting_user` (yellow, from `uiSession.sessionStatus.pendingInteraction`),
  `recovering` (route switch in progress), `interrupted` (an assignment was
  stopped/superseded or its session vanished), `provider_unavailable` (only when
  an injected provider-health table is inside its cooldown),
  `finished_unread` (green, until an explicit acknowledgement), `finished_read`
  (grey), `failed` (red, from the durable `turn/end` reason or the native
  lifecycle), `unavailable` (the runtime says the agent is gone), `idle`,
  `unknown` (a deleted session keeps `session_gone`, never “finished”).
  `recentlyFinished` is a view flag, not a status. Elapsed time never infers a
  status, and each card exposes the reason/source of its status. There is
  deliberately **no `waiting_agent`** status: DSH exposes no trustworthy
  per-parent wait signal (documented in `docs/ARCHITECTURE.md`).
- **Model / provider, honestly** — the card and inspector show the model the
  session really uses (native `modelSelection` projection) with a
  `native`/`assignment`/`unknown` source; a model change updates the chip and
  appends to the route history **without** creating a second card. A native
  session never borrows the board's route.
- **Click = preview, double-click = open** — a single click expands the last
  useful assistant segment, the expected action, the model/provider and the
  assigned task; a double-click (or the explicit “Open session” button, for
  touch/keyboard) navigates through `uiWorkspace.openSession`.
- **Orchestration** — OFF (observe only), SUPERVISED (proposals wait for
  approval), AUTONOMOUS (launches inside the mandate), plus a separate
  **Stop executions** action that cancels in-flight agents and blocks new
  delegation until **Resume**. OFF, Stop, approval, manual dispatch and failover
  handoff all pass through host-side authorization gates.
- **Unified execution backends** — `board` (failover, no canonical record),
  `taskboard` (canonical record via the Task Board executor, model pinned) and
  `contract` (canonical record **and** failover: the board leases the execution,
  creates the session, attaches it, settles it; a handoff leases a second attempt
  with `previousExecutionId`). The contract backend refuses to run when the
  extension is absent instead of faking an execution.
- **Routing & budgets** — explicit chain, bounded retry honouring `Retry-After`,
  switch with allow-list/cooldown/local-only, handoff with a checkpoint,
  **return to the primary route** at a safe boundary, per-project layered policy
  (most-restrictive-wins; a conflict authorizes no route), and enforced
  concurrency/tasks/requests/retries/switches budgets. Token and cost are
  reported unavailable because no provider substantiates them.
- **Restart-safe** — assignments carry leases + fencing tokens + idempotency
  keys, a persisted JSON state and JSONL audit journal, a single-writer instance
  lock, a lease watchdog, and fencing that refuses a stale writer. A restart
  reconciles (never relaunches silently) and releases the Task Board lease of an
  interrupted attempt.
- **Security posture** — card text is delimited **data** (prompt-injection
  guard), a card can never widen its permission, every route goes through the
  connection trust gate, checkpoints are bounded and secret-redacted, no client
  module has an HTML sink, and no credential is read or logged. Full audit:
  `docs/SECURITY-AUDIT.md`.

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

or from a shell:

```sh
dsh plugin --profile desktop add link:D:/App/DSH-agent-board
```

Then refresh the Web GUI once (client artifacts are served per page load).
The **Agent Board** entry appears in the global panel rail. Full procedure,
configuration table and rollback: `docs/INSTALL-ROLLBACK.md`.

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
  tasks up to `maxConcurrent` and the hourly budget.
- **Stop executions** — separate from OFF: it cancels the live agents of the
  in-flight assignments and blocks new delegation (tick, dispatch, approval,
  failover) until **Resume**; switching mode does not lift a Stop.
- **Read cursors** — expanding an unread card (or reading the session in the
  native main view) posts an ack; the state is persisted host-side, so the card
  stays grey after a refresh.

## Configuration

The policy is editable at runtime through the panel API and is persisted in
`state.json`:

```http
POST /dsh-agent-board/api/v2/policy
{ "policy": { "executionBackend": "board",
              "maxConcurrent": 2, "maxRetries": 2, "maxSwitches": 2,
              "allowedWorkspaces": [], "allowedProviders": [],
              "allowedPermissions": ["read-only","workspace-write"],
              "allowCloudFallback": false,
              "routeChain": [{"provider":"opencode-go","model":"deepseek-v4.1-flash"}],
              "projectPolicies": { "ws-123": { "allowedProviders": ["opencode-go"], "maxSwitches": 1 } },
              "autonomyBudget": {"maxTasksPerHour": 6}, "requestsPerHour": 120,
              "retryCooldownMs": 300000, "maxAttemptsPerRevision": 4,
              "contractBoardReport": true } }
```

`allowedWorkspaces: []` means “every workspace visible to the board”.
`executionBackend: "board"` creates the session itself (model-level failover
possible); `"taskboard"` delegates to the Task Board executor
(`POST /dsh-taskboard/tasks/:id/run`: execution record, permission, worktree)
and explicitly gives up model failover; `"contract"` uses the proposed execution
contract (`docs/TASKBOARD-CONTRACT.md`) to keep BOTH. The Task Board ledger is
read-only from the board's perspective; `done` stays human-only.

## Safety invariants

- `done` is never set by the board or a launched agent.
- The Task Board ledger is never written by the board; only the official
  `taskboard_*` tools act on it, from the launched session, or the proposed
  execution contract (lease/attach/report/release/settle, never `done`).
- One host owns `$DSH_HOME/agent-board` at a time (`instance.lock`); a secondary
  host serves reads and refuses mutations (409 `not_primary`).
- A card cannot widen its own permission beyond the policy mandate; a worktree
  card is skipped (board backend), delegated (taskboard backend) or run only in a
  lease-provided directory (contract backend) — never unisolated in the shared
  workspace.
- A stale writer cannot settle an assignment another writer owns (fencing); a
  Stop that lands during a launch/handoff wins the race.
- The plugin never pushes, merges or opens a PR.

## HTTP API (same-origin, authenticated by the DSH browser session)

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-agent-board/api/v2/state` | full board state + adapter matrix + contract + budget |
| GET | `/dsh-agent-board/api/v2/events` | SSE stream of the same state |
| GET | `/dsh-agent-board/api/v2/adapters` | capability matrix |
| GET | `/dsh-agent-board/api/v2/contract` | execution-contract negotiation (`?refresh=1` re-probes) |
| POST | `/mode` | `{mode: off\|supervised\|autonomous}` |
| POST | `/policy` | merge a policy patch (re-negotiates the contract when needed) |
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
node --test tests/            # full suite (unit + contract + host integration + security + perf)
node scripts/build-client.mjs # regenerate src/client.js after editing src/client/**
node scripts/smoke-host.mjs   # fast module/DAG smoke check
node scripts/e2e/run-e2e.mjs  # isolated real DSH host + fake provider + simulated contract
node scripts/bench/projection-bench.mjs   # 5/20/50/150 agents, 1000 sessions
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Contracts & adapters](docs/CONTRACTS.md)
- [Task Board execution contract (proposed, simulated)](docs/TASKBOARD-CONTRACT.md)
- [Failover, routing policy and budgets](docs/FAILOVER.md)
- [Agent engine adapters](docs/ADAPTERS.md)
- [Performance benchmarks](docs/PERFORMANCE.md)
- [Security audit](docs/SECURITY-AUDIT.md)
- [GOAL 3 delivery report](docs/GOAL3-DELIVERY.md)
- [Independent reviews](docs/REVIEW-GOAL3-BACKEND.md) · [supervision/UI](docs/REVIEW-GOAL3-SUPERVISION.md)
- [Install, configure, roll back](docs/INSTALL-ROLLBACK.md)
- [Provenance & compatibility](docs/PROVENANCE.md)
- [Test report](docs/TEST-REPORT.md)
- [Known limitations & backlog](docs/LIMITATIONS.md)

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
