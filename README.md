<p align="center">
  <img src="docs/demo/demo-dark-desktop.png" alt="Agent Board cockpit (dark theme) — fictional demo dataset" width="100%">
</p>

<h1 align="center">Agent Board</h1>

<p align="center">
  A supervision cockpit for <b>DeepSeek Harness</b>: one card per session and sub-agent,
  an explicit operator mandate, and a Super Agent that advances real projects —
  with or without a Task Board.
</p>

<p align="center">
  <code>Node ≥ 22</code> · <code>DSH 0.2.2-rc.x</code> · <code>MIT</code> ·
  host + client plugin · no runtime dependency
</p>

> **About the screenshots:** they are rendered from the plugin's real client
> bundle with a **fictional dataset** (no personal project, session or path).
> Regenerate them with `node scripts/capture-demo-screenshots.mjs` — see
> [Screenshots](#screenshots).

---

## Why it exists

DSH gives you powerful sessions and sub-agents, but nothing that answers:
*what is running, on which project, with whose permission, and what will it do
next?* Agent Board adds that layer without replacing the runtime: a cockpit, a
deterministic authorization gate, and a durable Super Agent that proposes — and,
inside your mandate, executes.

| What you get | In one line |
|---|---|
| **Cockpit** | One card per session and sub-agent, grouped by project, attention-first, real statuses and model. |
| **Explicit mandate** | `scopeMode` + level L0–L4 + per-action grants. Deny by default; nothing launches outside it. |
| **Super Agent** | A durable identity (memory, directives, decisions) that assesses the portfolio and acts inside the mandate. |
| **Autonomy without a Task Board** | Accepted ADRs, roadmap/TODO checklists and open issues become real dispatched work. |
| **Backlog triage at L4** | One unblocked backlog card can move to `todo` through the owner's own native tool. Never to `done`. |
| **Real executors** | Launch, delegate, comment, create/update, schedule, delete, project policy, GitHub PR, native merge — each behind its own gate. |
| **Auditable safety** | Single-writer lock, leases + fencing, single-use approvals, hash-bound payloads, JSONL audit. |

<details>
<summary><b>Table of contents</b></summary>

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Autonomy model](#autonomy-model)
- [Project-declared work (no Task Board needed)](#project-declared-work-no-task-board-needed)
- [Backlog triage at maximum autonomy (L4)](#backlog-triage-at-maximum-autonomy-l4)
- [Configuration](#configuration)
- [Safety invariants](#safety-invariants)
- [HTTP API](#http-api)
- [Screenshots](#screenshots)
- [Tests](#tests)
- [Documentation](#documentation)
- [Branches](#branches)
- [Status and honest limits](#status-and-honest-limits)
- [License](#license)

</details>

## What it does

- **Mascots & roles** — 15 approved SVG roles (6 silhouettes, exact palette),
  resolved from a **declared** role/name first, then from the text the runtime
  already declares (session/goal/task title) with an ordered keyword table. A
  deduced role is marked « déduit » and announced to assistive technology. The
  mascot colour is identity; runtime status is a separate dot. Assets are inlined
  as data URIs: no external request, no CSP exception.
- **Supervision cockpit (default view)** — every project at once, attention
  first: compact header, one filter bar (search, `En cours / Tout / À traiter /
  Historique`, view switch, filters popover), a Super Orchestrator band with the
  real status, real project/orchestrator counts and mini avatars, four real
  indicators (`Actifs`, `À traiter`, `En revue`, `Autres` — each one a filter),
  and an adaptive grid of supervision cards. `En revue` is the linked Task Board
  `in_review` state and shows `—` with the reason when the ledger is unreadable:
  no percentage, no invented task, no fake activity.
- **Supervision** — a workspace-level Super Orchestrator **layer** (not an AI
  agent) that aggregates real project/agent/task facts, exposes blocks and
  cross-project dependencies, proposes (never applies) reassignments, and gates
  board-owned delegations with concurrency/hourly/depth/cycle limits. The
  `Projets` tree and `Hiérarchie` views keep role/status/task-state filters.
- **Cards & branches** — sessions from the native `sessions.list` snapshot,
  sub-agents from the `subagentCatalog` projection and/or `parentId`, grouped by
  DSH workspace, collapsible sub-trees, compact mode, responsive down to a phone
  viewport with a two-column mosaic, DSH theme tokens (light/dark).
- **Exact statuses, with provenance** — `running`, `waiting_user`,
  `recovering`, `interrupted`, `provider_unavailable`, `finished_unread`,
  `finished_read`, `failed`, `unavailable`, `idle`, `unknown` (a deleted session
  keeps `session_gone`, never “finished”). Elapsed time never infers a status;
  each card exposes the reason/source of its status. There is deliberately **no
  `waiting_agent`** status: DSH exposes no trustworthy per-parent wait signal.
- **Model / provider, honestly** — the card and inspector show the model the
  session really uses (native `modelSelection` projection) with a
  `native`/`assignment`/`unknown` source; a model change updates the chip and
  appends to the route history **without** creating a second card.
- **Click = inspect, explicit button = open** — a click opens the inspector
  (right-side drawer on desktop, bottom sheet on mobile) with the last useful
  assistant segment, the expected action, the model/provider, the parent/children
  and an explicit “Open session” button.
- **Orchestration** — OFF (observe only), SUPERVISED (proposals wait for
  approval), AUTONOMOUS (launches inside the mandate), plus a separate
  **Stop executions** action that cancels in-flight agents and blocks new
  delegation until **Resume**. OFF, Stop, approval, manual dispatch and failover
  handoff all pass through the same host-side gate.
- **Unified execution backends** — `board` (failover, no canonical record),
  `taskboard` (canonical record via the Task Board executor, model pinned) and
  `contract` (canonical record **and** failover). The contract backend refuses to
  run when the extension is absent instead of faking an execution.
- **Autonomy without a Task Board** — accepted ADR follow-ups, roadmap/TODO
  checklists and open forge issues are detected as **work items** and dispatched
  into real worker sessions, one fingerprint per item (completed never replayed,
  failures retried with a delay and a cap). A `Proposed` ADR, a `[decision]` line
  or an assigned/decision-labelled issue is refused as `needs_human_decision`
  instead of being guessed. At L4 the Super Agent can also promote one unblocked
  backlog card per cycle, through the owner's own native tool, never to `done`.
- **Routing & budgets** — explicit chain, bounded retry honouring `Retry-After`,
  switch with allow-list/cooldown/local-only, handoff with a checkpoint,
  **return to the primary route** at a safe boundary, per-project layered policy
  (most-restrictive-wins), enforced concurrency/tasks/requests/retries/switches.
  Token and cost are reported unavailable because no provider substantiates them.
- **Restart-safe** — assignments carry leases + fencing tokens + idempotency
  keys, a persisted JSON state and JSONL audit journal, a single-writer instance
  lock, a lease watchdog, and fencing that refuses a stale writer. A restart
  reconciles (never relaunches silently).
- **Security posture** — card text is delimited **data** (prompt-injection
  guard), a card can never widen its permission, every route goes through the
  connection trust gate, checkpoints are bounded and secret-redacted, no client
  module has an HTML sink, and no credential is read or logged.

## Quick start

**Requirements:** DSH `0.2.2-rc.1` (the release this build was exercised on), the
Web GUI, Node.js `>= 22` for the build/test scripts (no bundler, no runtime
dependency), and a DSH profile where the plugin can be added (the plugin never
edits the DSH source tree).

```text
plugin_manager install_bundle  target=D:\App\DSH-agent-board
```

or from a shell:

```sh
dsh plugin --profile desktop add link:D:/App/DSH-agent-board
```

Then refresh the Web GUI once (client artifacts are served per page load). The
**Agent Board** entry appears in the global panel rail. Full procedure,
configuration table and rollback: [docs/INSTALL-ROLLBACK.md](docs/INSTALL-ROLLBACK.md).

Uninstall: `plugin_manager remove_bundle target=dsh-agent-board`.

**Using the panel** — click a card to inspect it, double-click (or “Open
session”) to navigate; the chevron collapses a sub-tree, “Compact cards” switches
to a flat one-line list. OFF / SUPERVISED / AUTONOMOUS pick the orchestration
mode; **Stop executions** cancels the live agents and blocks new delegation until
**Resume** without changing the mode. Expanding an unread card posts an ack, and
the read cursor is persisted host-side, so a card stays grey after a refresh.

State lives in `$DSH_HOME/agent-board/` (`state.json`, `audit.jsonl`,
`instance.lock`); remove that directory only when no DSH host is running.

**First run is inert by design.** `state.json` migrates to `schemaVersion: 2`
with `scopeMode: 'none'`, `level: 'L0'`, `requiresConfiguration: true`. Nothing
launches until you configure the mandate (cockpit → *Projets* tab, or
`POST /dsh-agent-board/api/v2/mandate`).

## Autonomy model

The **mandate** is the only authorization source, stored in `state.json`. The
legacy `/policy` endpoint is still accepted but translated into the mandate: it
can never widen it.

- **Scope** — `none` (default) · `selected` (explicit workspace list) · `all`
  (requires the literal confirmation `ALL_PROJECTS`). **An empty list never means
  “all”.**
- **Levels** — `L0` observe · `L1` propose · `L2` supervised launch · `L3`
  routine autonomy (comment, create/update, schedule, push branch) · `L4`
  critical actions plus maximal autonomy (open PR, merge, delete, policy).
  The **most restrictive** rule wins: mode, stop, action grant, level, project
  state, integration ceiling.
- **Actions** — individual grants: `launch`, `launch_work`, `delegate`,
  `create_task`, `update_task`, `promote_task`, `comment`, `open_pr`,
  `push_branch`, `delete_task`, `schedule`, `merge`, `policy_change`. A level
  never implies an action; critical actions always need a single-use approval.
- **Decisions** — the Super Agent never crosses the gate: it writes a
  DecisionInbox item, the operator answers, and an approval is **single-use**.
- **Directives & memory** — persisted operator directives (global/project), a
  bounded memory digest, and per-project model/hourly budget pins.
- **Dry run** — `GET /dry-run` simulates one tick: every candidate with
  `allowed`/`reason`, the detected project work, `writes: 0`.

## Project-declared work (no Task Board needed)

The Super Agent does not need `dsh-taskboard` to advance a project. A project
already states its intent in files a human wrote:

| Source | Read from | Becomes work when |
|---|---|---|
| `adr` | `docs/adr/*.md`, `docs/decisions/*.md`, `adr/`, `decisions/` | the ADR is **Accepted** and declares an unchecked follow-up (`- [ ]`) |
| `roadmap` | `ROADMAP.md`, `docs/ROADMAP.md`, `docs/roadmap.md`, `docs/next-steps.md`, `docs/plan.md` | an unchecked checklist line |
| `todo` | `TODO.md`, `BACKLOG.md`, `docs/TODO.md`, `docs/BACKLOG.md` | an unchecked checklist line |
| `issue` | the project's GitHub `origin` (open issues, when a credential is available) | the issue is open, not a PR, unassigned, no `blocked`/`needs-decision`/`question` label |

A detected item is dispatched with **`launch_work { workItemId }`** (minimum L2,
automatic at L3+): the host re-resolves the id, re-checks readiness, then opens
one real worker session in the project directory with the project's directives
and the item's exact source. The assignment journals the item fingerprint, so a
completed item is never dispatched twice, a failed one is retried with a delay
(3 attempts max), and a **Proposed** ADR or an explicitly marked item
(`[decision]`, assigned/labelled issue) is refused with `needs_human_decision`
and shown in the panel instead of being executed. When no credential exists the
document sources keep working; the forge source is simply empty.

## Backlog triage at maximum autonomy (L4)

`promote_task { reason }` is the only way a card leaves `backlog` without the
operator. At **L4 only** (below that, the operator answers a single-use approval)
the card must be `backlog`, unblocked, not waiting for a human, not carrying
`needsHumanDecision`, unclaimed, not running, with every prerequisite `done`. It
is executed through the owner's native `taskboard_move` tool
(`backlog → todo`, with `ifVersion`), journaled with its reason, commented on the
card, limited to 3 promotions per cycle and blocked for 6 h per card.
**`done` remains unreachable: triage promotes work, it never accepts it.**

### Minimum setup to see it act

1. Start the Super Agent, pick its model (cockpit → *Super Agent*), then set the
   mandate: `scopeMode: 'selected'`, the project workspace ids, `level: 'L3'`
   (or `'L4'` for triage + critical approvals), and `projects.<id>.enabled: true`.
2. Give the project something to declare: an **accepted** ADR with an unchecked
   `- [ ]` follow-up, or a `- [ ]` line in `TODO.md`/`ROADMAP.md`.
3. `GET /dsh-agent-board/api/v2/dry-run` must list it under `work.ready` with
   `writes: 0`. The *Vue d'ensemble* tab shows the same items.
4. Leave the mode on AUTONOMOUS: the next cycle dispatches one item per worker up
   to `maxConcurrent`, and the panel shows a normal session card.

`launch_work` requires `launch_work` **and** `launch`; a read-only project still
dispatches, but the worker is told to produce a change plan and never to claim
the work is done.

## Configuration

The policy below is editable at runtime through the panel API and persisted in
`state.json` (it never widens the mandate):

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

- `allowedWorkspaces: []` on the legacy policy means “every workspace visible”,
  but it is **translated conservatively** into an explicit selected scope.
- `executionBackend: "board"` creates the session itself (model-level failover
  possible); `"taskboard"` delegates to the Task Board executor (execution
  record, permission, worktree) and gives up model failover; `"contract"` uses
  the proposed execution contract ([docs/TASKBOARD-CONTRACT.md](docs/TASKBOARD-CONTRACT.md))
  to keep **both**. The Task Board ledger stays read-only from the board's
  perspective; `done` is human-only.
- **GitHub** — no global repository is required. Each project uses its own
  `remote origin` (a `githubRepository` config value becomes an optional pin: a
  different remote is refused with `forge_project_mismatch`). Reads work as soon
  as a credential is usable: `githubToken` (config) → `GITHUB_TOKEN` →
  `gh auth token`, governed by `githubTokenDiscovery` (`auto`/`env`/`off`).
  Writes require `allowGithubWrites: true` **and** the mandate action; the token
  is only ever sent to `api.github.com`, never logged, published or shown.

## Safety invariants

- `done` is never set by the board or a launched agent.
- The Task Board ledger is never written by the **execution path**: only the
  official `taskboard_*` tools act on it from the launched session, or the
  proposed execution contract (lease/attach/report/release/settle, never `done`).
- One host owns `$DSH_HOME/agent-board` at a time (`instance.lock`); a secondary
  host serves reads and refuses mutations (409 `not_primary`).
- A card cannot widen its own permission beyond the mandate; a worktree card is
  skipped, delegated, or run only in a lease-provided directory — never
  unisolated in the shared workspace.
- A stale writer cannot settle an assignment another writer owns (fencing); a
  Stop that lands during a launch/handoff wins the race.
- Forge **merge, protected-branch push and deletion do not exist**; issue,
  comment and PR creation require `allowGithubWrites` + the mandate action, are
  idempotent (project/type-namespaced keys) and audited. `merge` and
  `delete_task` go through the native DSH services with an exact, single-use
  approval.
- The JSONL audit rotates at 8 MiB (`audit.jsonl.1`, one generation) and records
  `audit_rotated`; older history is exported before it is truncated.

## HTTP API

Same-origin, authenticated by the DSH browser session; every request goes
through `ctx.connection.requestRejection` before the handler runs.

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
| GET/POST | `/mandate` | read / patch the explicit mandate (`scopeMode`, level, actions) |
| POST | `/mandate/confirm` | confirm the configuration (`requiresConfiguration:false`) |
| POST | `/mandate/projects/:id` | project override (enabled, level, model, budget, priority) |
| GET | `/dry-run` | simulate one tick: every candidate with `allowed`/`reason` |
| GET | `/diagnostics` | host diagnostics (state, lock, adapters, model discovery) |
| GET/POST | `/superagent`, `/superagent/start\|stop\|model\|directive\|cycle` | Super Agent runtime and controls |
| POST | `/superagent/decision` | answer a DecisionInbox item (approval is single-use) |
| POST | `/integrations/taskboard/probe` | real public-v1 negotiation (no secret returned) |
| GET | `/forge/checks/:ref` | read CI checks for a ref |
| POST | `/forge/issue`, `/forge/issue/:n/comment`, `/forge/pr` | opt-in GitHub writes (mandate + `allowGithubWrites`), idempotent |

## Screenshots

All screenshots are rendered by the plugin's **real client bundle** with a
**fictional dataset** (*Orion Studio*, *Nebula API*, *Atlas Docs*; invented
sessions, models and paths). No personal project, session id or path appears.
The originals that used to be published were removed from the repository **and
from its whole git history**: see [docs/EVIDENCE-SCREENSHOTS.md](docs/EVIDENCE-SCREENSHOTS.md).

| Projects view — sub-agents visibly linked | Mobile cockpit |
|---|---|
| <img src="docs/demo/demo-dark-projects-desktop.png" alt="Projects view, dark, fictional dataset" width="100%"> | <img src="docs/demo/demo-dark-mobile.png" alt="Mobile cockpit, dark, fictional dataset" width="240"> |

Regenerate any of them:

```sh
node scripts/capture-demo-screenshots.mjs   # 1440x900, 1440x1024 (projects), 390x844
```

The script prints the real viewport and the rendered card/branch/link counts, so
a layout regression is visible without opening the image.

## Tests

```sh
node --test tests/                 # full suite: 690 tests (unit, contract, host, security, perf)
node scripts/build-client.mjs      # regenerate src/client.js after editing src/client/**
node scripts/build-assets.mjs      # regenerate the inlined SVG data URIs (never hand-edit)
node scripts/capture-demo-screenshots.mjs  # regenerate the public demo screenshots
node scripts/smoke-host.mjs        # fast module/DAG smoke check
node scripts/bench/projection-bench.mjs   # 5/20/50/150 agents, 1000 sessions
node scripts/bench/payload-bench.mjs      # additive /state size (bounded sections)
node scripts/e2e/run-e2e.mjs       # isolated real DSH host: migration + gate + failover + 3 projects
node scripts/verify-live.mjs       # read-only status of both live integrations + real state
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Contracts & adapters](docs/CONTRACTS.md)
- [GOAL 6 delivery record (mandate, Super Agent, forge)](docs/GOAL6-DELIVERY.md) · [contract](docs/GOAL6-CONTRACT.md) · [Task Board public-v1 audit](docs/TASKBOARD-PUBLIC-V1-AUDIT.md)
- [Autonomy levels & profiles audit](docs/audit/AUTONOMY-LEVEL-PROFILES-2026-11-14.md) · [permissions/autonomy fixes](docs/audit/PERMISSIONS-AUTONOMY-FIXES-2026-11-13.md)
- [Screenshots: what was removed and why](docs/EVIDENCE-SCREENSHOTS.md) · [GOAL 6 UI evidence](docs/e2e/GOAL6-UI-EVIDENCE.md)
- [Responsive cockpit contract](docs/UX-COCKPIT-CONTRACT.md) · [GOAL 5 delivery record](docs/GOAL5-DELIVERY.md)
- [Mascots, supervision & Super Orchestrator](docs/MASCOTS-SUPER-ORCHESTRATOR.md)
- [Task Board execution contract (proposed, simulated)](docs/TASKBOARD-CONTRACT.md) · [coordination](docs/TASKBOARD-COORDINATION.md)
- [Failover, routing policy and budgets](docs/FAILOVER.md) · [agent engine adapters](docs/ADAPTERS.md) · [performance](docs/PERFORMANCE.md)
- [Security audit](docs/SECURITY-AUDIT.md) · [GOAL 3 delivery report](docs/GOAL3-DELIVERY.md)
- [Install, configure, roll back](docs/INSTALL-ROLLBACK.md) · [operator next steps](docs/OPERATOR-NEXT-STEPS.md)
- [Provenance & compatibility](docs/PROVENANCE.md) · [test report](docs/TEST-REPORT.md) · [known limitations](docs/LIMITATIONS.md)

## Branches

| Branch | Role |
|---|---|
| `main` | Stable line: starts at the MVP baseline (`ec955fb`) and carries the merged integration state — `main` and `dev` point at the same tree. |
| `dev` | Integration branch (default remote branch): all merged work — cockpit, supervision, mandate, real executors, project-declared work, L4 backlog triage. Build and try this one. |

Historical feature branches were merged into `dev`/`main` and their refs were
removed (their commits are in `dev`'s history): GOAL 3
(`goal3/supervision-orchestration`), GOAL 4
(`feat/agent-board-mascots-super-orchestrator`), GOAL 5
(`feat/agent-board-responsive-cockpit`), GOAL 6 (`feat/agent-board-superagent`),
the GOAL 6/7 continuation (`feat/superagent-ux-polish`,
`feat/superagent-assessment-repair`) and the runtime fixes
(`fix/agent-board-runtime-e2e`, `fix/svg-byte-exact-checkout`).

## Status and honest limits

**Status: PARTIAL (honest).** The cockpit, the authorization gates, the
routing/budget/fencing layer, the unified execution contract and the autonomy
work are implemented and tested — but some claims are proved against controlled
doubles, not a live forge or a live Task Board:

- The execution contract is a **proposed extension of the Task Board**, proved
  against a simulated server (`tests/fixtures/fake-taskboard-server.mjs`): the
  real `dsh-taskboard` 0.12.0 does not implement it yet, so
  `executionBackend: 'contract'` is refused against it (`contract_unavailable`)
  and the two legacy backends remain the live paths.
- The real Task Board public API is disabled without a token, so public-v1
  **writes** are not validated live. GitHub writes were validated on a
  disposable repository only; **merge, protected-branch push and deletion do not
  exist**.
- Real DSH sessions were exercised end-to-end (create → turn → lease/attach →
  settle → `in_review`) with a fake OpenAI-compatible provider, without user
  credentials; a real provider outage was **not** exercised.
- Project-declared work and backlog triage are proved by host tests, **not** by a
  live GUI run (the host modules load at DSH startup and the local API requires
  a token).

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) before trusting a claim.

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
