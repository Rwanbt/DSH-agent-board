# Contracts and adapters

All shapes are plain JSON so they survive the journal, the HTTP API and a
future storage migration. Canonical definitions live in
`src/contracts/model.js` and `src/contracts/adapters.js`.

## Domain model

| Name | Shape (abridged) | Invariants |
|---|---|---|
| `ProjectRef` | `{ id, path, title }` | `id` = DSH workspace id when known, otherwise the path |
| `WorkItemRef` | `{ system, externalId, canonicalId, revision, authority, url }` | `canonicalId = "<system>:<externalId>"`; `authority` names which system owns which field |
| `AgentNode` | projection output: `{ id, parentId, projectId, title, status, statusReason, statusSource, statusAt, model, preview, expectedAction, assignmentId, taskId, previousSessionId, routeHistory, viewing }` | one node per agent; parent/child from `parentId` or the sub-agent catalog |
| `Assignment` | `{ id, idempotencyKey, taskId, taskTitle, taskDescription, revision, attempt, sessionId, previousSessionId, model, status, lease, fencingToken, checkpoint, routeHistory, switches, retries }` | exactly one LIVE assignment per task; a new attempt gets a new key |
| `Mandate` | policy: `{ mode, maxConcurrent, allowedWorkspaces, allowedProviders, allowedPermissions, executionBackend, routeChain, maxSwitches, autonomyBudget }` | autonomous work only inside the mandate |
| `Checkpoint` | `{ id, at, sessionId, git, tests, actions, stepsDone, stepsRemaining, lastText }` | an action with unknown effect is never replayed blindly |
| `RoutePolicy` | `routeChain[]` entries `{ provider, model, locality?, reasoningEffort? }` | an explicit chain, no implicit “any model” fallback |
| `ProviderHealthEvent` | `{ failures, lastFailureKind, lastFailureAt, cooldownUntil }` per provider | a provider in cooldown is skipped |
| `AuditEvent` | `{ at, type, ... }` | append-only JSONL, bounded in memory |

Statuses: `running`, `waiting_user`, `recovering`, `finished_unread`, `finished_read`,
`failed`, `idle`, `unknown`, `unavailable`. Assignment statuses: `starting`, `running`, `recovering`,
`done`, `failed`, `stopped`, `interrupted`, `superseded`.

## Adapter capabilities

A work source or forge declares only the operations it really implements:

```js
defineAdapter({
  id: 'my-system', kind: 'work-source' | 'forge' | 'executor',
  capabilities: ['list', 'get'],          // must exist as methods
  validatedLive: false,                    // honesty flag, rendered in the UI
  notes: 'why this is not validated yet',
  list(), get(),                           // implemented operations
})
```

`capabilitiesOf(adapter)` returns the full flag matrix; the panel shows it under
**Adapters** with a “non validé live” tag when applicable. Declaring a
capability without the method throws at registration instead of failing at use.

Unavailable adapters are explicit skeletons (`createSkeletonAdapter`) that throw
`AdapterError('not_implemented')` and report `status: 'unavailable'`. They are
not mocks presented as working integrations.

### Current matrix

Values are the DECLARED capabilities, which are also what `POST /tick` may use.
A skeleton carries throwing `list`/`get` stubs for typing, but declares nothing,
so the matrix reports all `false` for it.

| Adapter | Kind | list | get | create/update/comment/transition | Validated live |
|---|---|---|---|---|---|
| `dsh-taskboard` | work source | ✅ | ✅ | ❌ (by design: read-only ledger) | ✅ (read) · `run` opt-in |
| `github` | forge | ✅ | ✅ | ❌ | ❌ (fake-API contract only, no live repo/token) |
| `gitlab`, `forgejo`, `gitea`, `bitbucket` | forge | ❌ | ❌ | ❌ | ❌ (skeleton) |
| `jira`, `linear` | work source | ❌ | ❌ | ❌ | ❌ (skeleton) |
| executor `dsh` | executor | — | — | declared from the live `ctx.agents`/`ctx.sessions`/`ctx.subagents` methods only | ❌ as an adapter (unit-tested against a fake ctx; the host launch path is separate) |
| executor `claude-code`, `codex`, `opencode` | executor | — | — | ❌ (skeletons declare nothing) | ❌ |

The executor capability vocabulary is `discover, observe, getSession,
getChildren, launch, cancel, resume, openSession, readLastOutput, getModel,
getStatus` (`src/contracts/adapters.js`). A declared capability without a
callable method throws at registration, and the DSH adapter declares a
capability only when the matching service method exists on the given `ctx`. See
`docs/ADAPTERS.md` for the full matrix and the promotion requirements.

### Task Board bridge

`src/connectors/taskboard.js` talks only to `GET /dsh-taskboard/state` (the
board’s own HTTP contract) and exposes **no write method**. It reads the REAL
0.10/0.11 record fields (the profile installs 0.11.0; the fields are unchanged
since 0.10): per-task `version` (never the global ledger `revision`),
`claimedBy`, `execution.mode`, `isolation`, `executions[].outcome`. That
deliberate mapping is what lets the orchestrator refuse a task the Task Board
already runs, claims or schedules:

- the Task Board ledger is not read or written directly;
- claiming and `in_review` are performed by the launched agent session through
  the official `taskboard_*` tools;
- `done` remains a human action.

This build launches plain `ctx.agents` sessions, so the Task Board has no
execution record for them: `taskboard_execution_report` is refused by the Task
Board tool. That gap is tracked as P0 in `docs/LIMITATIONS.md`; the honest fix is
to run through the Task Board’s own `POST /dsh-taskboard/tasks/:id/run` path, not
to fake an execution.

This build has three execution backends, chosen by `policy.executionBackend`:

- **`board`** (default): the board creates the session itself. It can switch
  model/provider on failure, but the Task Board gets no execution record, so
  `taskboard_execution_report` is refused there.
- **`taskboard`**: the board calls `POST /dsh-taskboard/tasks/:id/run` and the
  **Task Board's own executor** creates the session, execution record, claim,
  permission/preset and worktree. The board records `executionId` + `sessionId`
  and observes the session. The model is pinned on the card, so model-level
  failover is explicitly unavailable on this backend (`backend_no_failover`).
  `task.isolation:'worktree'` cards are only runnable on this backend or the
  next one.
- **`contract`** (unified): requires the negotiated execution contract
  (`docs/TASKBOARD-CONTRACT.md`, currently **simulated**). The board leases the
  canonical execution, creates the session (so failover stays possible),
  attaches it, and settles it with a board-observed report + `requestReview`.
  The Task Board keeps task identity, execution identity, reservation, claim,
  dependencies, permissions, worktree and the validation status; the board keeps
  the agent identity, technical sessions, sub-agent tree, model history,
  delegation decisions, activity statuses, recovery attempts and the routing
  policy. One execution can be linked to several successive sessions through
  `previousExecutionId` when a handoff happens. Settling never requests `done`.

The contract client exposes `contract()`, `leaseExecution()`, `attachSession()`,
`submitReport()`, `releaseLease()`, `settleExecution()`; every call resolves to
`{ok:true,status,value}` or `{ok:false,code,status,message}` and never throws.
Writes are refused wholesale unless the complete mandatory feature set was
negotiated (a partial extension is more dangerous than an absent one).

## Non-negotiable rules encoded in code

1. The board never writes `done`; the launched session cannot either — the Task Board `taskboard_move` tool refuses `done` at code level. The prompt repeats it, but the enforcement is the tool guard.
2. No work item is written by the board; external systems stay authoritative.
3. One LIVE assignment per task (`idempotencyKey` = task + revision + attempt);
   a duplicate tick, dispatch or proposal never starts a second session.
4. A blocked or `in_review` prerequisite is never launched through.
5. OFF creates nothing; Stop cancels and blocks new delegation until Resume;
   they are distinct controls, and both also gate approval and `/dispatch`.
6. A policy refusal and a CI/code failure never trigger a provider switch.
7. A partial stream is reported as a handoff, never as a resumed request.
8. A task already running/claimed/scheduled by the Task Board is skipped with an
   explicit reason; a worktree-isolated card is only runnable through the Task
   Board executor (`executionBackend:'taskboard'`).
9. A card cannot grant itself a permission level the policy mandate does not
   allow; the refusal is a pre-flight reason, not a silent downgrade.
10. Only one host process writes the board state (`instance.lock`); a secondary
    host serves reads and refuses mutations.
11. `/run` is an execution request, not a ledger write: the board never edits a
    task, never moves it to `done`, and never changes the model pinned on a card.
