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
provenance is not allowed to be invented. Five different facts are kept apart
(session, turn, agent, task, user read-state).

| Priority | Signal | Status |
|---|---|---|
| 1 | `sessionStatus.pendingInteraction` (approval / plan-review / question) | `waiting_user` |
| 2 | `row.running` or `sessionStatus.running` | `running` |
| 3 | assignment in route recovery | `recovering` |
| 4 | last durable `turn/end` reason kind ∈ {error, failed}, not acknowledged | `failed` |
| 5 | native-only failure (`mobilePushLifecycle.lastTurnEnd`), no board ack possible | `failed` (visible, `seen:false`) |
| 6 | turn ended, ack cursor at/after it | `finished_read` |
| 7 | turn ended, ack cursor before it | `finished_unread` |
| 8 | native `completionUnread` and the ack is older than the session activity | `finished_unread` |
| 9 | native turn end observed after the fact | `finished_read` (history) |
| 10 | `agentAvailable:false` | `unavailable` |
| 11 | no signal | `idle` |
| 12 | row missing / catalog-only | `unknown` |

`updatedAt` is displayed but never used to infer a status. A sub-agent whose row
disappears is `unknown`, not “finished”. `aborted` and `blocked` turns are
`idle` with an explicit reason, never `finished`.

The preview follows the same honesty rule: only a segment that closed a
completed turn is `final`. A segment from an errored, aborted or unknown turn is
`partial` and the panel says so.

## Click semantics

- single click / Enter / Space → expand the preview (and POST `/ack` if unread);
- double click or Shift+Enter → `uiWorkspace.openSession(id)`;
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

Every launch path — timer tick, `POST /dispatch`, proposal approval, failover
handoff — goes through one `authorizeLaunch()` gate. OFF, Stop, the workspace
mandate, the provider allow-list, the permission allow-list and the concurrency
limit are therefore enforced in one place; no route can bypass them.

Two execution backends exist (`policy.executionBackend`):

- `board` (default) — the host creates the session with `ctx.agents`, so a
  failure can switch model/provider and hand the task off. The Task Board gets
  no execution record for it (its `run` path was not used).
- `taskboard` — the host calls the Task Board's own `POST /tasks/:id/run`; the
  Task Board creates the session, execution record, claim, permission and
  worktree, and the host only observes the returned session. The model is pinned
  on the card, so failover is refused with `backend_no_failover` instead of
  faked. Worktree-isolated cards are only runnable this way.

An assignment is created once per `(task, revision, attempt)` idempotency key,
with a lease (`leaseTtlMs`). One LIVE assignment per task, but a finished,
stopped or interrupted attempt no longer bricks the task: the next explicit
launch becomes a new attempt. A watchdog expires a lease whose agent is gone
into `interrupted`, so `maxConcurrent` cannot be consumed forever.
`reconcileAfterRestart` does the same at boot and never relaunches silently.
Overlapping ticks coalesce (`tickInFlight`), and a single-writer `instance.lock`
keeps a second DSH host read-only instead of clobbering `state.json`. A durable
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
delegation (tick, dispatch, approval, failover) until `POST /resume`, and records
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
- `done` is never set by the board or by the launched agent.
- The card's permission is clamped by the policy `allowedPermissions`; the
  default mandate never grants `danger-full-access` from a ledger row.
- Card text is delimited and labelled as untrusted data in every prompt.
- The board never stores credentials; it references no secret from the profile.
