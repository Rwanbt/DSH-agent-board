# Architecture

```text
[ Agent Board panel (browser, React via the DSH module table) ]
        │  native subscriptions: sessions.list, uiSession.sessionStatus, workspaces.list
        │  host state: GET /state + SSE /events, commands /mode /policy /stop /ack /tick
        ▼
[ Host plugin: supervisor + orchestrator + router + recovery  (src/host/index.js) ]
        │  ctx.agents.create / inject / followup / cancel      ctx.on('session/event')
        ├── WorkSourceAdapter  dsh-taskboard (read-only, live)  · GitHub (read-only, unvalidated)
        │                      GitLab/Forgejo/Gitea/Bitbucket/Jira/Linear (skeletons)
        ├── AgentExecutorAdapter  DSH (live) · Claude Code/Codex/OpenCode (skeletons)
        ├── ModelRouter  classify → retry / switch / handoff       (src/routing)
        └── Recovery      checkpoint → reconcile → new session     (src/recovery)
        ▼
[ Durable state ]  $DSH_HOME/agent-board/state.json (atomic tmp+rename)
                   $DSH_HOME/agent-board/audit.jsonl (append-only)
```

The browser can be closed: the host half keeps the timer, the journal and the
launches alive. The panel is a pure projection of native + host state.

## Status classification

`src/supervisor/projection.js` is the only place that decides a status. It also
returns `statusReason`, `statusSource` and `statusAt`: a status without
provenance is not allowed to be invented. Six different facts are kept apart
(session, turn, agent, assignment, provider, task, user read-state).

| Priority | Signal | Status |
|---|---|---|
| 1 | host fact: the session left the runtime (`hostState.gone`), even with a stale turn end — a live row updated at/after the tombstone wins | `unknown` (`session_gone`) |
| 2 | no row, no native status and no assignment | `unknown` |
| 3 | `sessionStatus.pendingInteraction` (approval / plan-review / question) | `waiting_user` |
| 4 | `row.running` or `sessionStatus.running` | `running` |
| 5 | assignment in route recovery | `recovering` |
| 6 | assignment status ∈ {interrupted, failed, stopped, superseded}, no turn end newer than it | `interrupted` |
| 7 | no live session row (catalog-only, deleted) | `unknown` (`no_row_for_session`) |
| 8 | recorded turn-end error whose provider is inside an injected health cooldown | `provider_unavailable` |
| 9 | last durable `turn/end` reason kind ∈ {error, failed}, not acknowledged | `failed` |
| 10 | native-only failure (`mobilePushLifecycle.lastTurnEnd`), no host turn end or a stale completed one | `failed` (visible until the persisted ack covers it) |
| 11 | `agentAvailable:false` | `unavailable` |
| 12 | turn ended **completed**, ack cursor at/after it | `finished_read` |
| 13 | turn ended **completed**, ack cursor before it | `finished_unread` |
| 14 | native `completionUnread` and the ack is older than the session activity (no activity timestamp: the ack decides) | `finished_unread` |
| 15 | native turn end observed after the fact and **completed** | `finished_read` (history) |
| 16 | any other turn-end kind (aborted, blocked, interrupted, recovered error, unknown, max-tokens) | `idle` with an explicit reason |
| 17 | no signal | `idle` |

`interrupted` and `provider_unavailable` never replace a real signal: the first
only applies when no later turn proves the session moved on, the second needs an
injected health table whose `cooldownUntil` is still in the future and whose
failure the session has not passed. No injected health table means the status
never appears (a failed turn stays `failed`). Both `failed` and `interrupted`
cards are acknowledged by the persisted read cursor: the status never changes,
only the attention flag (`seen`).

Only a `completed` turn end is a result. The newest turn-end fact wins: a
native failure or abort the host missed is not hidden by a stale completed host
end (`failed` / `idle` with a native reason), and a recovered host error is
history, never `finished_unread`. An archived session is history whatever its
status (`isAttention` returns false), so an old unread result cannot occupy the
home view for ever.

There is deliberately no `waiting_agent` status. The candidate native sources
were checked: `agent/status` only carries idle/running, `subagents` exposes
awaited helpers (`waitForChildren`, `drainChildren`) plus child lifecycle events
(`subagent/start`, `subagent/end`) but no per-parent "blocked on a child"
projection value, and `uiSession.sessionStatus` only carries running /
pendingInteraction / completionUnread. A parent awaiting a child stays
`running: true`, so that state cannot be told apart from work without inventing
a signal.

`recentlyFinished` (with `finishedAt`) is a VIEW flag, not a status: it is true
only for a real turn end whose timestamp is inside a bounded window. Age never
changes a status, and a native-only turn end (no timestamp) is never "recent".
It is exposed on the card as `data-recent`; no CSS rule consumes it yet (the
green mark is driven by the unread status, not by this flag), which is a known
P2 gap rather than a hidden behaviour.

`updatedAt` is displayed but never used to infer a status. A sub-agent whose row
disappears is `unknown`, not “finished”; a deleted session keeps an explicit
`session_gone` reason. `aborted`, `blocked`, `interrupted`, `unknown` and
`max-tokens` turns are `idle` with an explicit reason, never `finished`.

The preview follows the same honesty rule: only a segment that closed a
completed turn is `final`. A segment from an errored, aborted or unknown turn is
`partial`, an outline response is attributed to its own turn (the newest one when
the closing fact carries no turn number), and a board checkpoint is only final
when its assignment completed (`status: done`); the panel then shows “no final
answer yet” instead of a misleading final line.

## Click semantics

- single click → expand the preview (and POST `/ack` if unread);
- double click → `uiWorkspace.openSession(id)`;
- **keyboard**: `Enter` opens the session (the card's primary action, matching
  the visible hint) and `Space` expands the preview; the interaction arbiter
  cancels a pending single-click action when the double click arrives
  (`src/board/interaction.js`).
- explicit **Open session** button → same navigation (mobile/keyboard);
- focus ring uses `--dsw-alias-brand-primary`; the running ring is disabled by
  `prefers-reduced-motion`.

Reading a session in the native main view is also recognised: when the runtime
reports `retainedBy.mainView > 0`, the board acknowledges the session so an old
consulted card does not keep polluting the home view.

## Orchestration

`src/orchestrator/dag.js` (pure) decides one tick:

1. mode `off` → nothing;
2. only Task Board tasks with status `todo` and every prerequisite `done`
   (never `in_review`) are candidates;
3. a task with an active assignment or a pending proposal is skipped; so is a
   task the Task Board already runs (`executions[].outcome === 'running'`),
   claims (`claimedBy`), schedules (`execution.mode === 'scheduled'`) or that
   requires worktree isolation this build cannot provide;
4. the workspace must be inside the mandate (empty allow-list = all visible);
5. supervised emits a proposal, autonomous launches while `maxConcurrent` slots
   remain and the hourly budget is not exhausted.

Every launch path — timer tick, `POST /dispatch`, proposal approval — goes
through one `authorizeLaunch()` gate. OFF, Stop, the workspace mandate, the
provider allow-list, the permission allow-list and the concurrency limit are
therefore enforced in one place; no route can bypass them. A **failover handoff**
has its own `authorizeHandoff()` gate (same mandate/permission/isolation/route
rules, plus a FRESH Task Board read: a trashed, terminal or differently-claimed
card suppresses the recovery) and re-checks the stop epoch after
`ctx.agents.create` returns, so a Stop that lands during the handoff wins.

Three execution backends exist (`policy.executionBackend`):

- `board` (default) — the host creates the session with `ctx.agents`, so a
  failure can switch model/provider and hand the task off. The Task Board gets
  no execution record for it (its `run` path was not used).
- `taskboard` — the host calls the Task Board's own `POST /tasks/:id/run`; the
  Task Board creates the session, execution record, claim, permission and
  worktree, and the host only observes the returned session. The model is pinned
  on the card, so failover is refused with `backend_no_failover` instead of
  faked. Worktree-isolated cards are only runnable this way.
- `contract` — the **unified** backend. It needs the negotiated execution
  contract (`docs/TASKBOARD-CONTRACT.md`): the Task Board leases the canonical
  execution (`POST /tasks/:id/executions/lease`), the board creates the session
  itself (so a model/provider switch stays possible) and attaches it
  (`POST /executions/:leaseId/attach`), then closes the execution with
  `settle {outcome, report, requestReview}`. The card moves to `in_review`
  through the Task Board's own settle path; `done` is refused locally by the
  client and server-side. A failover handoff releases the current lease and
  leases a **new attempt** carrying `previousExecutionId`, so the attempt chain
  stays canonical. When the extension is absent the launch is refused with
  `contract_unavailable` and **no POST is made**: the board never emulates an
  execution it does not own. A worktree-isolated card is accepted only when the
  lease returns a prepared directory; otherwise the card is refused
  (`worktree_isolation_unavailable`) rather than run in the shared workspace.

The contract backend is proved against a **simulated** Task Board extension
(`tests/fixtures/fake-taskboard-server.mjs`, every response stamped
`x-simulated-contract: true`); the real Task Board does not implement those
routes yet. That simulation is never presented as a live integration.

### Routing, budgets and fencing

`routing/policy.js` resolves the effective route policy from the operator's
global layer and the per-project layer (`policy.projectPolicies[workspaceId]`)
with most-restrictive-wins semantics; a conflicting provider set
(`providersConflict`) authorizes **no** route and is a pre-launch refusal
(`route_policy_conflict`), never an empty allow-list read as "everything
allowed". `routing/budget.js` enforces concurrency, tasks/hour, requests/hour,
retries, switches and cooldown; token and cost metrics are reported as
`{available:false, reason:'provider_metering_unavailable'}` because the provider
supplies no data. `planPrimaryReturn()` brings an attempt back to the primary
route at a safe boundary (a finished attempt, provider not cooling down,
allow-list permissive); the decision is recorded on the assignment
(`primaryReturn`) and in the audit, never applied silently mid-stream.
`checkFencing()` refuses a write from a stale token or an ended lease, and a
`turn/end` from a superseded owner is ignored (`takeoverRefusal`).

An assignment is created once per `(task, revision, attempt)` idempotency key,
with a lease (`leaseTtlMs`). One LIVE assignment per task, but a finished,
stopped or interrupted attempt no longer bricks the task: the next explicit
launch becomes a new attempt. A watchdog expires a lease whose agent is gone
into `interrupted`, so `maxConcurrent` cannot be consumed forever.
`reconcileAfterRestart` does the same at boot and never relaunches silently.
Overlapping ticks coalesce (`tickInFlight`), and a single-writer `instance.lock`
keeps a second DSH host read-only instead of clobbering `state.json`; the takeover of a stale lock is a rename-based compare-and-swap, so two hosts can never both win. A durable
autonomous mode requires an explicit resume after a restart
(`resume_requires_confirmation`) unless `autoResumeOnRestart` is set.

The launched session receives two messages, following the pattern proven by
`dsh-taskboard`: an `inject()` framing line (producer-owned source kind
`dsh-agent-board`), then a `followup()` user body. The card text is delimited and
labelled as data (prompt-injection guard); the instructions ask the session to
claim the task, work inside the project, report, comment and move it to
`in_review` — never `done`. The permission level is taken from the card only
when the operator's `allowedPermissions` mandate grants it.

**Stop** is separate from OFF: it bumps a `stopEpoch`, calls
`agent.cancel({kind:'user'})` on every in-flight assignment, blocks new
delegation (tick, dispatch, approval, failover) until `POST /resume` — switching mode does NOT lift it — and records
`stopped_by_operator`. A launch in flight during the stop self-cancels when
`ctx.agents.create` returns. If the cancel itself fails, the assignment becomes
`interrupted` with `stop_failed:<reason>` — it never pretends to be stopped. OFF
does not kill anything.

## Failover, three stages

1. **Retry** (`src/routing/router.js`) — 429 and rate-limit wording, 5xx,
   timeout, transport; bounded exponential backoff with jitter that honours
   `Retry-After` (the delay is really awaited, and suppressed if the operator
   stops the board meanwhile), cooldown, `maxRetries`.
2. **Switch** — explicit chain (global → project → role → task by convention),
   allowed providers, provider cooldown, `maxSwitches` accumulated across
   attempts, and a local-only policy (`allowCloudFallback:false`) that forbids
   routing a local model to the cloud.
3. **Handoff** — when the turn already produced output (classified
   `partial_stream`) or the chain is exhausted: build a checkpoint (cwd, git
   HEAD/branch/status/commits/changed files, the task card, the last assistant
   segment, tool calls with a possible external effect listed as
   `effect:unknown`), then open a new session on the next route. The new
   assignment starts in `recovering` — the card shows the reason and the
   source→target route — and keeps `previousSessionId` + the whole
   `routeHistory`; the panel renders that history, so a switch never hides the
   previous provider. A stop that lands during the recovery suppresses it.

The classifier refuses two shortcuts on purpose: a policy/safety refusal is
never bypassed through another provider, and a CI/test/code failure is not a
model outage (`notModel`).

Honest limit: after the first streamed chunk the **same request** is not
resumed; the board hands the **task** off to a new session and says so. External
effects cannot be confirmed by the board (it never sees tool results); the
resumed session is told to verify before replaying, which is a guard, not a
reconciliation.

## Storage

`StateStore` writes `state.json` through a temp file + rename, serializes
writes, retries a Windows rename lock (EPERM/EBUSY/EACCES) a bounded number of
times, cleans leaked temp files at boot, and quarantines an unreadable file
(`state.json.corrupt-<ts>`) instead of destroying it. A failed write no longer
poisons the queue. Compaction never drops a `turnEnd` that has no ack (bounded
by a hard ceiling), so the green “unread” pill cannot disappear by itself.
`audit.jsonl` records decisions (`launch`, `launch_refused`, `tick`,
`route_decision`, `handoff`, `mode_changed`, `ack`, `unack`, `stop_all`,
`retry_suppressed`, restart reconciliation).

`instance.lock` is the single-writer guard: the lock-owning host writes, ticks
and mutates; a secondary host serves reads and answers `409 not_primary` to
commands, instead of silently overwriting the journal.

## Security posture

- Every HTTP route checks `ctx.connection.requestRejection` first; a secondary
  instance refuses every mutation.
- No ledger writes: the Task Board remains the single source of truth.
- The board never writes `done`. A launched session cannot either: the Task Board's own `taskboard_move` refuses `done` at code level (`requires explicit user confirmation`). The prompt states it too, but the guarantee is the tool guard, not the prompt.
- The card's permission is clamped by the policy `allowedPermissions`; the
  default mandate never grants `danger-full-access` from a ledger row.
- Card text is delimited and labelled as untrusted data in every prompt.
- The board never stores credentials; it references no secret from the profile.
