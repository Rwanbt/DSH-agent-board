# Contracts and adapters

All shapes are plain JSON so they survive the journal, the HTTP API and a
future storage migration. Canonical definitions live in
`src/contracts/model.js` and `src/contracts/adapters.js`.

## Domain model

| Name | Shape (abridged) | Invariants |
|---|---|---|
| `ProjectRef` | `{ id, path, title }` | `id` = DSH workspace id when known, otherwise the path |
| `WorkItemRef` | `{ system, externalId, canonicalId, revision, authority, url }` | `canonicalId = "<system>:<externalId>"`; `authority` names which system owns which field |
| `AgentNode` | projection output: `{ id, parentId, projectId, title, status, model, preview, expectedAction, assignmentId, taskId, routeHistory }` | one node per agent; parent/child from `parentId` or the sub-agent catalog |
| `Assignment` | `{ id, idempotencyKey, taskId, revision, attempt, sessionId, previousSessionId, model, status, lease, fencingToken, checkpoint, routeHistory }` | exactly one live assignment per idempotency key |
| `Mandate` | policy: `{ mode, maxConcurrent, allowedWorkspaces, allowedProviders, routeChain, maxSwitches, autonomyBudget }` | autonomous work only inside the mandate |
| `Checkpoint` | `{ id, at, sessionId, git, tests, actions, stepsDone, stepsRemaining, lastText }` | an action with unknown effect is never replayed blindly |
| `RoutePolicy` | `routeChain[]` entries `{ provider, model, locality?, reasoningEffort? }` | an explicit chain, no implicit “any model” fallback |
| `ProviderHealthEvent` | `{ failures, lastFailureKind, lastFailureAt, cooldownUntil }` per provider | a provider in cooldown is skipped |
| `AuditEvent` | `{ at, type, ... }` | append-only JSONL, bounded in memory |

Statuses: `running`, `waiting_user`, `finished_unread`, `finished_read`,
`failed`, `idle`, `unknown`. Assignment statuses: `starting`, `running`,
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

| Adapter | Kind | list | get | create/update/comment/transition | Validated live |
|---|---|---|---|---|---|
| `dsh-taskboard` | work source | ✅ | ✅ | ❌ (by design: read-only) | ✅ (read) |
| `github` | forge | ✅ | ✅ | ❌ | ❌ (no live repo/token used) |
| `gitlab`, `forgejo`, `gitea`, `bitbucket` | forge | ❌ | ❌ | ❌ | ❌ (skeleton) |
| `jira`, `linear` | work source | ❌ | ❌ | ❌ | ❌ (skeleton) |
| executor `dsh` | executor | — | — | create/observe/cancel via `ctx.agents` | ✅ |
| executor `claude-code`, `codex`, `opencode` | executor | — | — | ❌ | ❌ (skeleton) |

### Task Board bridge

`src/connectors/taskboard.js` talks only to `GET /dsh-taskboard/state` (the
board’s own HTTP contract), normalizes each task, and exposes **no write
method**. That is deliberate:

- the Task Board ledger is not read or written directly;
- claiming and `in_review` are performed by the launched agent session through
  the official `taskboard_*` tools;
- `done` remains a human action.

If a future Task Board version exposes a typed service for executions, the
orchestrator should attach its assignments to it (this build only launches plain
sessions — see `docs/LIMITATIONS.md`).

## Non-negotiable rules encoded in code

1. `done` is never set by the board or by a launched agent.
2. No work item is written by the board; external systems stay authoritative.
3. Two identical events produce one assignment (`idempotencyKey`).
4. A blocked or `in_review` prerequisite is never launched through.
5. OFF creates nothing; Stop cancels; they are distinct controls.
6. A policy refusal and a CI/code failure never trigger a provider switch.
7. A partial stream is reported as a handoff, never as a resumed request.
