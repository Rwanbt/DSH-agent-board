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

`src/supervisor/projection.js` is the only place that decides a status:

| Priority | Signal | Status |
|---|---|---|
| 1 | `sessionStatus.pendingInteraction` (approval / plan-review / question) | `waiting_user` |
| 2 | `row.running` or `sessionStatus.running` | `running` |
| 3 | last durable `turn/end` reason kind ∈ {error, failed} | `failed` |
| 4 | turn ended, ack cursor before it, or `completionUnread` | `finished_unread` |
| 5 | turn ended, ack cursor at/after it | `finished_read` |
| 6 | no signal | `idle` |
| 7 | row missing / disconnected | `unknown` |

`updatedAt` is displayed but never used to infer a status. A sub-agent whose row
disappears is `unknown`, not “finished”.

## Click semantics

- single click / Enter / Space → expand the preview (and POST `/ack` if unread);
- double click or Shift+Enter → `uiWorkspace.openSession(id)`;
- explicit **Open session** button → same navigation (mobile/keyboard);
- focus ring uses `--dsw-alias-brand-primary`; the running ring is disabled by
  `prefers-reduced-motion`.

## Orchestration

`src/orchestrator/dag.js` (pure) decides one tick:

1. mode `off` → nothing;
2. only Task Board tasks with status `todo` and every prerequisite `done`
   (never `in_review`) are candidates;
3. a task with an active assignment or a pending proposal is skipped;
4. the workspace must be inside the mandate (empty allow-list = all visible);
5. supervised emits a proposal, autonomous launches while `maxConcurrent` slots
   remain, and the hourly budget is not exhausted.

An assignment is created once per `(task, revision, attempt)` idempotency key,
with a lease (`leaseTtlMs`) and a fencing token. `reconcileAfterRestart` turns a
running assignment whose live agent is gone into `interrupted` and never
relaunches it silently.

The launched session receives two messages, following the pattern proven by
`dsh-taskboard`: an `inject()` framing line (producer-owned source kind
`dsh-agent-board`), then a `followup()` user body. The framing asks the session
to claim the task, work inside the project, report, comment and move it to
`in_review` — never `done`.

**Stop** is separate from OFF: it calls `agent.cancel({kind:'user'})` on every
in-flight assignment and records `stopped_by_operator`. OFF does not kill
anything.

## Failover, three stages

1. **Retry** (`src/routing/router.js`) — 429/5xx/timeout/transport, bounded
   exponential backoff with jitter, `Retry-After`, cooldown, `maxRetries`.
2. **Switch** — explicit chain (global → project → role → task by convention),
   allowed providers, provider cooldown, `maxSwitches`, and a local-only policy
   (`allowCloudFallback:false`) that forbids routing a local model to the cloud.
3. **Handoff** — when the turn already produced output (classified
   `partial_stream`) or the chain is exhausted: build a checkpoint (cwd, git
   HEAD/branch/status/commits/changed files, last assistant segment, tests,
   attempted external actions), reconcile it, then open a new session on the
   next route with the previous session id recorded on the new assignment and
   the route change in `routeEvents`.

The classifier refuses two shortcuts on purpose: a policy/safety refusal is
never bypassed through another provider, and a CI/test/code failure is not a
model outage (`notModel`).

Honest limit: after the first streamed chunk the **same request** is not
resumed; the board hands the **task** off to a new session and says so.

## Storage

`StateStore` writes `state.json` through a temp file + rename, serializes
writes, and quarantines an unreadable file (`state.json.corrupt-<ts>`) instead
of destroying it. `audit.jsonl` records decisions (`launch`, `tick`,
`route_decision`, `handoff`, `mode_changed`, `ack`, `stop_all`, restart
reconciliation). Previews, turn-end facts and the audit tail are bounded.

## Security posture

- Every HTTP route checks `ctx.connection.requestRejection` first.
- No ledger writes: the Task Board remains the single source of truth.
- `done` is never set by the board or by the launched agent.
- The board never stores credentials; it references no secret from the profile.
