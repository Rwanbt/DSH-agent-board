# Task Board coordination (read-only, P3)

> **Status: read-only. There is no board-facing write API today.**
>
> This layer maps the Task Board's own `GET /dsh-taskboard/state` records into a
> bounded read model for the supervision/orchestration layers. It has **no write
> method**, performs **no HTTP request itself**, and never edits the Task Board
> ledger. The write capabilities below are `false`; the proposal builder returns a
> local recommendation (`applies:false`) or an explicit `writes_unavailable`
> refusal with the endpoints the Task Board *would* have to expose. Those
> endpoints are marked **PROPOSED** and do not exist in the real plugin
> (0.10/0.11). No simulated contract is presented as a live integration.

## Why this layer exists: agents vs tasks

The two systems own different facts and must not blur them:

| Fact | Owner | This layer |
|---|---|---|
| Agent identity, sessions, sub-agent tree, activity/status, routing and failover | Agent Board | never read from the Task Board |
| Tasks, subtasks, Kanban columns/statuses, dependencies, urgency/priority, milestones, forge sync | **Task Board** | **read only** |
| Claiming a task and moving it `in_progress → in_review` | the launched agent session, through the official `taskboard_*` tools | never performed here |
| `done` | the human operator in the Task Board UI | **never** performed anywhere in the Agent Board |

The Agent Board supervises *agents* and reads *tasks*. It is not a second Kanban
engine, not a second Task Board writer, and not a forge sync service. The Task
Board stays the single source of truth for everything in its column.

The Task Board exposes no board-facing, versioned write contract. Its own GUI
surfaces are not a negotiated contract for this adapter and are **not used**: the
board will not bypass the Task Board's tool guards and become a second writer.
Promotion therefore means "the Task Board implements and announces the proposed
endpoints below", exactly as `docs/TASKBOARD-CONTRACT.md` requires for execution.

## Module and host wiring

- Module: `src/connectors/taskboard-coordination.js` — plain ESM, no import, no
  `fetch`, no clock, no I/O. Deterministic: the same input produces the same
  output.
- Exports: `readCoordinationModel`, `buildCoordinationProposal`,
  `COORDINATION_CAPABILITIES`, `COORDINATION_LIMITS`, `COORDINATION_NOTES`,
  `PROPOSED_COORDINATION_ENDPOINTS`.
- Host contract: the host reads the Task Board once (the existing
  `adapter.list()` path) and passes the **state** plus the **meta** it knows:

  ```js
  readCoordinationModel(taskboardState, {
    source: 'live' | 'simulated' | 'absent',  // the host's provenance fact
    simulated?: boolean,                       // equivalent to source:'simulated'
    reason?: string | null,                    // why it is unavailable
    ledgerRevision?: number | null,            // accepted, not part of the model
    tasksTotal?: number | null,                // accepted, not part of the model
  })
  ```

  `taskboardState` may be any of: the raw `/dsh-taskboard/state` `value`, its
  `{ ok:true, value }` envelope, the connector's `list()` result
  (`{ items, meta }`), or a bare task array (`list().items`). All four are
  normalized to the same identity fields.
  When the host cannot reach the Task Board it passes `null` and a reason; the
  mapper never probes or retries.

## Read model shape

```js
{
  available: boolean,
  reason: string | null,          // null when available; stable code otherwise
  source: 'live' | 'simulated' | 'absent',
  tasks: [{
    id, title, status, priority,  // priority null when the board sends none
    workspaceId, projectId,       // projectId is the normalized owning project
    dependsOn: string[],          // sorted, de-duplicated, <= 32 per task
    assignee,                     // from claimedBy; null when unclaimed
    revision,                     // per-task `version`, never the ledger revision
  }],
  dependencies: [{ taskId, dependsOnTaskId, crossProject }],
  capabilities: {
    read: true,
    proposeReassignment: false, proposePriority: false, proposeBlocked: false,
    writeKanban: false, requestReview: false,
  },
  notes: 'Task Board remains the source of truth; this adapter never writes.',
}
```

Field rules (never invented, absent stays null/[]):

| Field | Source | Default when absent |
|---|---|---|
| `id`, `title`, `status` | TaskRecord | record without a string `id` is dropped; `title: ''`; `status: 'unknown'` |
| `priority` | raw `priority`, passed through untouched | `null` — **the real 0.10/0.11 TaskRecord has no `priority` field**; its own priority marker is `urgency`, which is deliberately **not** copied into `priority` |
| `workspaceId` | raw `workspaceId` | `''` |
| `projectId` | raw `projectId`, else the adapter's normalized `project.id`, else `workspaceId` | `null` |
| `dependsOn` | raw `dependsOn`, strings only, de-duplicated, sorted, capped at 32 (the Task Board's own `MAX_TASK_DEPENDENCIES`) | `[]` |
| `assignee` | raw `assignee` when present, else `claimedBy` (a `lease:<id>` placeholder is passed through as the Task Board reports it) | `null` |
| `revision` | raw per-task `revision`/`version` | `null` — the global ledger `revision` is never used as a task revision (that would silently re-key idempotency) |
| `milestone`, `updatedAt` | adapter read model only; **not** part of the coordination task shape | adapter default `null`; the real 0.11 record has no `milestone` |

Normalization details:

- **Trashed cards are excluded** from the coordination model (`trashedAt` set):
  they are not actionable work. The adapter still exposes them for the ledger
  view.
- **Owning project**: `workspaceId` *is* the project in the real Task Board
  ("Owning project: a DSH workspace id"). `projectId` therefore falls back to it;
  a raw `projectId` wins when a future record carries one. This keeps
  cross-project detection meaningful without borrowing a field the Task Board
  does not send.
- **`crossProject`** is `true` only when both tasks are present, both project
  identities are known, and they differ. An unresolved prerequisite (missing,
  filtered or truncated) is **not** labelled cross-project; the edge is kept so
  the consumer still sees the declared dependency.
- **Bounded**: at most 500 tasks and 1 000 dependency edges
  (`COORDINATION_LIMITS`), selected deterministically after sorting by id. When
  truncation happens, `notes` says so factually (counts only); the base note is
  always present.
- **Deterministic**: tasks sorted by id, dependencies sorted by
  `(taskId, dependsOnTaskId)`, `dependsOn` sorted per task, locale-independent
  comparison. Payload order does not affect the result. A duplicated task id in
  a malformed payload keeps the first occurrence.

## Capability matrix

| Capability | State | Meaning |
|---|---|---|
| `read` | **implemented** | the pure mapper above |
| local proposals (`delegate`, `unblock`) | **implemented, proposal-only** | the supervision layer's own decisions; `applies:false`, `status:'proposed'`, no Task Board write |
| `proposeReassignment` | **unavailable** | no board-facing API; `writes_unavailable` + PROPOSED endpoint |
| `proposePriority` | **unavailable** | no board-facing API; `writes_unavailable` + PROPOSED endpoint |
| `proposeBlocked` | **unavailable** | no board-facing API; `writes_unavailable` + PROPOSED endpoint |
| `writeKanban` (column move) | **unavailable** | no board-facing API; `writes_unavailable` + PROPOSED endpoint |
| `requestReview` (`in_review` move) | **unavailable** | the launched session performs it with `taskboard_move`; this adapter never does |

`buildCoordinationProposal(model, request)`:

- `{ kind: 'delegate' | 'unblock', taskId, reason, evidence? }` → `{ ok:true,
  proposal }` only when the read model is available **and** the task exists.
  Both kinds are local supervision decisions (launch an agent, proceed once
  prerequisites are done) and need no Task Board write. The proposal is
  `{ id, kind, taskId, projectId, reason, evidence, applies:false,
  status:'proposed' }`; the id is stable (`dsh-agent-board:coordination:<kind>:<taskId>`)
  and the evidence is a bounded, JSON-safe, deterministically keyed copy.
- Every write-oriented kind (`reassign`/`reassignment`, `priority`, `blocked`,
  `move`/`kanban`, `review`) → `{ ok:false, code:'writes_unavailable',
  message, expectedEndpoints }`. Two independent gates are checked: this module
  must implement the capability (`COORDINATION_CAPABILITIES` is `false`) **and**
  the read model must advertise it. A forged `model.capabilities` flag therefore
  cannot unlock a write.
- Refusals never throw and never return a proposal: `taskboard_unavailable`
  (with the model's reason), `task_not_found`, `invalid_request`,
  `invalid_kind`, `writes_unavailable`.
- A recommendation without a non-empty `reason` is not emitted
  (`invalid_request`); reasons are bounded to 500 chars.

## Absence behavior

A missing, unreachable or malformed Task Board is **not** an error for the Agent
Board. `readCoordinationModel` returns:

```js
{ available:false, reason:'taskboard_absent' | 'taskboard_unreachable' |
  'taskboard_malformed', source:'absent' | <host source>, tasks:[], dependencies:[],
  capabilities:{ ...all false }, notes }
```

The Agent Board keeps supervising agents, launching sessions and showing its
existing views. UI actions that would need the Task Board are disabled with the
reason; nothing is fabricated, retried against a guessed route, or degraded into
a fake task. `buildCoordinationProposal` refuses with the same reason.

## Duplicate / out-of-order tolerance (what the board expects)

The Task Board is the authority and may serve snapshots and events that arrive
duplicated, reordered or stale (polling, restarts, concurrent users). The board
therefore:

1. treats every read as a **complete snapshot**, not a patch stream: no
   incremental merge, no assumption that an earlier event was observed;
2. does **not** assume dependency edges are complete or ordered: prerequisites
   may be missing from a bounded/filtered snapshot, and `crossProject:false` is
   "not proven", never "proven same-project";
3. never treats a proposal as applied: `applies:false` is permanent for this
   build, and a Task Board re-read always wins over a local recommendation;
4. tolerates duplicate ids (first occurrence wins) and out-of-order task arrays
   deterministically (sorted by id), so two hosts observing the same snapshot
   produce the same model;
5. never assumes a `done` transition is safe to infer from a local state: `done`
   is human-only and is never requested, proposed or emulated.

Consumers must also tolerate a `source:'simulated'` model (tests only) and must
never present it as live.

## What the Task Board would need to expose (PROPOSED, absent today)

These mirror `docs/TASKBOARD-CONTRACT.md` and are **not implemented** by the real
plugin; the board never calls them. `PROPOSED_COORDINATION_ENDPOINTS` carries the
same data programmatically.

| Capability | Method | Path | Body (fenced) |
|---|---|---|---|
| `proposeReassignment` | POST | `/dsh-taskboard/tasks/:id/coordination/reassign` | `assignee`, `expectedVersion`, `idempotencyKey`, `reason` |
| `proposePriority` | POST | `/dsh-taskboard/tasks/:id/coordination/priority` | `priority`, `expectedVersion`, `idempotencyKey`, `reason` |
| `proposeBlocked` | POST | `/dsh-taskboard/tasks/:id/coordination/block` | `blocked`, `expectedVersion`, `idempotencyKey`, `reason` |
| `writeKanban` | POST | `/dsh-taskboard/tasks/:id/coordination/column` | `status`, `expectedVersion`, `idempotencyKey`, `reason` |
| `requestReview` | POST | `/dsh-taskboard/tasks/:id/coordination/review` | `expectedVersion`, `idempotencyKey`, `reason` |

Promotion requirements before the board would perform one write:

1. **Negotiation first**: the Task Board announces the capability in the
   versioned contract probe (the existing PROPOSED
   `GET /dsh-taskboard/contract`), and the board intersects it with what it
   implements. A 404 or a partial announcement means "no write", never "try
   anyway".
2. **Optimistic concurrency**: `expectedVersion` is the per-task `version` the
   board last read; a mismatch is `version_conflict` and the board must re-read.
3. **Idempotency**: every write carries an `idempotencyKey`; a replay returns the
   same outcome and never duplicates an effect.
4. **Validated bodies** and explicit refusals: every route returns the same
   `{ ok:true, value } | { ok:false, error:{ code, message } }` envelope as the
   existing Task Board routes; unknown ids are `not_found`, invalid input is
   `invalid_input`.
5. **No `done` path**: no route may reach `done`; `in_review` is the furthest a
   coordination write may go, and `done` stays the human action.
6. **No new ledger file / no board writer**: the routes are the single Task
   Board-owned mutation surface; the board itself still owns no task state.
7. **Honest advertisement**: a partial implementation announces only what it
   implements, and the board then refuses every write (the mandatory set rule of
   the execution contract).

Until all of that exists, the honest answer is `writes_unavailable` with the
endpoint listed, which is what this module returns.

## Non-goals (explicit)

- No Kanban engine, no task registry, no subtask/milestone management, no
  scheduler, no forge sync, no second source of truth.
- No Task Board write method, no ledger read/write, no `done` transition, no
  model/prompt pinning on a card.
- No fabricated capability, no silent retry on a guessed route, no mock task in a
  production path, no simulated contract labelled live.
- No hard dependency on the Task Board: its absence degrades the coordination
  surface only.

## Evidence

- `node --test tests/taskboard-coordination.test.js` — **15 tests, 15 pass**:
  realistic mapping, envelope/list input, malformed/partial state, absent state,
  bounded/deterministic output, cross-project edges, proposal purity
  (`applies:false`, no write export, no `fetch`), unknown-task and
  unavailable-capability refusals, adapter read-model additions and "no write
  capability", plus one simulator-backed read-only integration test against
  `tests/fixtures/fake-taskboard-server.mjs` (every response banner-labelled
  `x-simulated-contract: true`).
- `node --check src/connectors/taskboard.js`,
  `node --check src/connectors/taskboard-coordination.js`,
  `node --check tests/taskboard-coordination.test.js` — no syntax error.
- `node --test tests/` — 374 tests, 373 pass, 1 fail at the time of this work.
  The only failure is `tests/review-supervision-artifact.test.js`
  ("`src/client.js` is byte-identical to the concatenated current modules"):
  the Lead-owned generated bundle has not been rebuilt after concurrent
  teammate changes to bundled client/contract modules. It does not involve this
  layer — `src/connectors/taskboard.js` and the coordination module are host
  modules and are not part of the client concatenation (`PARTS` in the artifact
  test). The 15 coordination tests pass in that same run.

What that evidence does **not** prove: that the real Task Board exposes any
coordination write route (it does not), that a live write was ever performed (it
was not), or that the board is a second writer (it is not).
