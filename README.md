# Agent Board (DSH plugin)

A card-and-branch cockpit for **DeepSeek Harness**: one card per session and
sub-agent, grouped by project, with real native statuses, click-to-preview,
double-click-to-open, a supervisor that actually launches Task Board work in
OFF / SUPERVISED / AUTONOMOUS modes, and a task-level failover/recovery path.

> **Status: PARTIAL (honest).** The panel runs live in DSH 0.2.2-rc.1, a real
> Task Board task was launched, implemented and moved to `in_review` by a real
> DSH session, and the UI interactions were exercised in a browser. The
> provider-switch and process-restart gates are covered by automated
> integration tests, **not** by a live provider outage or a real host reboot.
> See [docs/TEST-REPORT.md](docs/TEST-REPORT.md) and
> [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before trusting a claim.

## What it does

- **Cards & branches** — sessions from the native `sessions.list` snapshot,
  sub-agents from the `subagentCatalog` projection and/or `parentId`, grouped by
  DSH workspace, collapsible sub-trees, compact mode, responsive down to a
  phone viewport, DSH theme tokens (light/dark).
- **Exact statuses** — `running` (animated ring), `waiting_user` (yellow, from
  `uiSession.sessionStatus.pendingInteraction`), `finished_unread` (green),
  `finished_read` (grey), `failed` (red, from the durable `turn/end` reason),
  `idle`, `unknown` (never faked as “finished”). Elapsed time never infers a
  status.
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

State lives in `$DSH_HOME/agent-board/` (`state.json`, `audit.jsonl`); remove
that directory to forget read cursors, previews and assignments.

## Use

- **Panel** — click a card to preview, double-click (or “Open session”) to
  navigate. Collapse a sub-tree with the chevron; “Compact cards” switches to a
  flat one-line list.
- **Orchestration** — pick OFF, SUPERVISED or AUTONOMOUS. In SUPERVISED the
  board lists proposals with Approve/Reject; in AUTONOMOUS it launches ready
  tasks up to `maxConcurrent`.
- **Stop executions** — separate from OFF: it cancels the live agents of the
  in-flight assignments.
- **Read cursors** — expanding an unread card posts an ack; the state is
  persisted host-side, so the card stays grey after a refresh.

## Configuration

The plugin has no `Config` schema yet; the policy is editable at runtime
through the panel API and is persisted in `state.json`:

```http
POST /dsh-agent-board/api/v2/policy
{ "policy": { "maxConcurrent": 2, "maxSwitches": 2,
              "allowedWorkspaces": [], "allowedProviders": [],
              "allowCloudFallback": false,
              "routeChain": [{"provider":"opencode-go","model":"deepseek-v4.1-flash"}],
              "autonomyBudget": {"maxTasksPerHour": 6} } }
```

`allowedWorkspaces: []` means “every workspace visible to the board”. The
Task Board is read-only from the board’s perspective; the launched session does
the claiming and the `in_review` transition, and `done` stays human-only.

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
node --test tests/            # 133 tests, ~1.0 s
node scripts/build-client.mjs # regenerate src/client.js
node --check src/client.js && node --check src/host/index.js
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Contracts & adapters](docs/CONTRACTS.md)
- [Provenance & compatibility](docs/PROVENANCE.md)
- [Test report (PASS/PARTIAL/FAIL)](docs/TEST-REPORT.md)
- [Known limitations & backlog](docs/LIMITATIONS.md)

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
