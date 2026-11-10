# Task Board execution contract (proposal v1)

> ## ⚠️ SIMULATED, NOT A LIVE INTEGRATION
>
> The extension described here **does not exist in the real Task Board plugin**
> (`D:\App\dsh-taskboard`, 0.10/0.11). No route in this document has ever been
> served by anything except `tests/fixtures/fake-taskboard-server.mjs`, a
> simulated `node:http` server that stamps **every** response with
> `x-simulated-contract: true`.
>
> - The implementation in `src/connectors/taskboard-contract.js` is a **client
>   for a proposed protocol**, not a working integration.
> - The adapter is not "validated live" and must not be described as such.
> - The real plugin was **read only** to copy its real shapes; it was not
>   edited, and no ledger file was read or written.
> - The harness never silently degrades into a fake execution: when
>   `/dsh-taskboard/contract` is absent (every real 0.10/0.11 Task Board) every
>   write method refuses with `not_negotiated` before any HTTP request.

## Why this extension exists

The Agent Board consumes the Task Board's canonical data only through its HTTP
contract (`GET /dsh-taskboard/state`) and, opt-in, its own executor
(`POST /dsh-taskboard/tasks/:id/run`). Two execution backends exist and they
are incompatible at exactly the point that matters:

| Backend | Session owner | Model/provider failover | Task Board execution record |
|---|---|---|---|
| `board` (default) | Agent Board (`ctx.agents`) | **yes** (route chain) | **none** — `taskboard_execution_report` is refused (“no running execution of yours”) |
| `taskboard` | Task Board executor (`POST /tasks/:id/run`) | **no** — the model is pinned on the card (`backend_no_failover`) | **yes** |

So today an operator must choose between failover and a truthful execution
record. Neither backend may edit the Task Board ledger (the board is not a
second writer, `done` is human-only). The missing piece is a **narrow, versioned
extension** that lets the board own the session while the Task Board remains the
single writer of its own execution data.

## Contract at a glance

- **Extension version:** `TASKBOARD_CONTRACT_VERSION = 1` (integer, strictly
  increasing).
- **Transport:** same-origin HTTP, JSON envelopes identical to the Task Board's
  existing ones: `200 { ok:true, value }` or `4xx/5xx { ok:false, error:{ code,
  message, ...detail } }`.
- **Feature flags** (announced by the server, intersected with the board's list):

  | Feature | Meaning |
  |---|---|
  | `execution.lease` | `POST /tasks/:id/executions/lease` |
  | `execution.attach` | `POST /executions/:leaseId/attach` |
  | `execution.report` | `POST /executions/:leaseId/report` |
  | `execution.release` | `POST /executions/:leaseId/release` |
  | `execution.settle` | `POST /executions/:leaseId/settle` |
  | `execution.fencing` | lease `fence` is monotonic and enforced |
  | `execution.idempotency` | duplicate lease/attach/release/settle are harmless |
  | `execution.reroute` | a released attempt may be followed by a new attempt (optional) |

- **Write gate:** the board performs **no** write unless the whole set
  `lease · attach · report · release · settle · fencing · idempotency` is
  present. A half-implemented extension is more dangerous than an absent one: a
  lease without `release`/`settle` would strand a claim forever. `reroute` is
  optional; missing it only degrades the rationale text, never the safety gate.

## Resources

| Method | Path | Purpose | Idempotency key |
|---|---|---|---|
| GET | `/dsh-taskboard/contract` | capability negotiation | — |
| POST | `/dsh-taskboard/tasks/:id/executions/lease` | acquire one fenced attempt | `idempotencyKey` **required** |
| POST | `/dsh-taskboard/executions/:leaseId/attach` | bind the board-owned DSH session | `(leaseId, sessionId)` **required** |
| POST | `/dsh-taskboard/executions/:leaseId/report` | store the structured report | latest accepted report wins, revision returns |
| POST | `/dsh-taskboard/executions/:leaseId/release` | abandon the attempt (reroute/cancel) | `leaseId` alone |
| POST | `/dsh-taskboard/executions/:leaseId/settle` | record the outcome, optionally `in_review` | `leaseId` alone |

A lease/execution id is opaque; the simulated server uses `lease-<n>` /
`exec-<n>`. The real plugin is expected to use its existing id generators.

### `GET /dsh-taskboard/contract`

```json
{
  "ok": true,
  "value": {
    "contract": {
      "version": 1,
      "features": ["execution.lease", "execution.attach", "execution.report",
                   "execution.release", "execution.settle",
                   "execution.fencing", "execution.idempotency", "execution.reroute"],
      "product": "dsh-taskboard",
      "leaseTtlMs": 120000
    }
  }
}
```

Absent route: `404 { ok:false, error:{ code:"not_found", message:"…" } }`.
The board treats a 404 as **absent** and stops there; it never probes a guessed
alternative route and never infers write support from `/state`.

### `GET /dsh-taskboard/state` (unchanged, real 0.10.2 shape)

The extension adds **no** required change to the read contract. The board keeps
reading `value.revision` (global ledger revision), per-task `version`,
`claimedBy`, `execution.mode`, `isolation` and `executions[].outcome`, and the
proposal additionally asks for a `value.meta` block so the board can log which
ledger revision it negotiated against (the simulated server serves
`meta:{ ledgerRevision, tasksTotal, simulated:true }`).

### Lease — `POST /tasks/:id/executions/lease`

```json
{
  "route": { "provider": "primary", "model": "big", "reasoningEffort": "high" },
  "attempt": 1,
  "previousExecutionId": null,
  "expectedVersion": 3,
  "idempotencyKey": "dsh-agent-board:lease:t-contract-1:1",
  "requestedAt": 1762764600000
}
```

- `route` is the **currently selected** route, so the execution record shows the
  model/provider that actually ran — that is how the board can fail over (a new
  attempt) without lying about which route ran.
- `expectedVersion` is the per-task `version` the board last read; a mismatch is
  a `version_conflict` (the board must re-read `/state` and decide again).
- `idempotencyKey` is derived from `(taskId, attempt)` by
  `executionIdempotencyKey()`; replays of the same key return the **same**
  lease, a different key while a lease is active is a `lease_conflict`.

Response `202`:

```json
{
  "ok": true,
  "value": {
    "leaseId": "lease-1", "executionId": "exec-1", "taskId": "t-contract-1",
    "taskVersion": 4, "route": { "provider": "primary", "model": "big" },
    "attempt": 1, "fence": 7, "expiresAt": 1762764720000, "state": "leased"
  }
}
```

Server obligations: one active lease per task; `fence` strictly increases across
leases of the same task; TTL enforced (`leaseTtlMs`, default proposal 2 min);
claim/`in_progress` is set by the lease (the board does not edit the task); a
task with a foreign `claimedBy` or a running execution whose session is not
this lease is refused with `claim_conflict`.

### Attach — `POST /executions/:leaseId/attach`

```json
{ "sessionId": "session-abc", "route": { "provider": "primary", "model": "big" } }
```

Response `200`:

```json
{ "ok": true, "value": { "leaseId": "lease-1", "sessionId": "session-abc",
  "executionId": "exec-1", "state": "attached", "attachedAt": 1762764610000 } }
```

- **Idempotent:** the same lease + the same session returns the same record and
  **does not** bump the task version.
- A different session on the same lease is refused with `claim_conflict`.
- Attaching a released/settled lease is `invalid_input` (422).
- Attach is what sets the real `claimedBy = sessionId`; before attach the lease
  holder is recorded as `lease:<leaseId>` (a session id does not exist yet).

### Report — `POST /executions/:leaseId/report`

Body is the **same** `ExecutionReport` the Task Board already stores:

```json
{
  "summary": "Implemented the contract client and the simulated server.",
  "changedFiles": ["src/connectors/taskboard-contract.js"],
  "checks": ["node --test tests/"],
  "artifacts": [],
  "risk": "Only the simulated server proves the protocol."
}
```

Validation: `summary` 1…2000 chars; arrays of ≤300-char strings, capped at
50/50/30; `risk` ≤2000 chars. Response `200`:
`{ ok:true, value:{ leaseId, reportRevision, acceptedAt } }`. A report after
release/settle is `invalid_input` (422).

### Release — `POST /executions/:leaseId/release`

```json
{ "reason": "provider 429: rerouting to the backup route" }
```

Response `200`:
`{ ok:true, value:{ leaseId, state:"released", reason, releasedAt, taskVersion } }`.

- Idempotent: releasing twice returns the first release record.
- The attempt's execution record becomes `outcome:"cancelled"` with the reason
  as `error`; the claim is cleared and the task returns to `todo`, so a NEW
  attempt (new `attempt` number, new idempotency key, `previousExecutionId`
  pointing at the abandoned execution) can be leased. Both attempts stay in
  `executions[]` — this is the reconciliation the board needs for failover.
- Releasing a settled lease is `invalid_input`.

### Settle — `POST /executions/:leaseId/settle`

```json
{ "outcome": "succeeded", "requestReview": true, "report": { "summary": "…", "changedFiles": [], "checks": [], "artifacts": [], "risk": "" } }
```

- `outcome` ∈ `succeeded | failed | cancelled`. **`done` is not an outcome**:
  the client refuses it locally and the server refuses it with `invalid_input`.
- Response `200`:
  `{ ok:true, value:{ leaseId, executionId, taskId, outcome, taskVersion, status, reportRevision } }`.
- `requestReview: true` (succeeded only) means the Task Board moves the task
  `in_progress → in_review`; `false` keeps it `in_progress` for the session to
  decide. A failed/cancelled settle releases the claim and returns the task to
  `todo`. **No settle path can reach `done`** — that stays the human action in
  the Task Board UI.
- Settle is idempotent per lease (the second call returns the stored record).

## Errors

All errors are `{ ok:false, code, status, message }` on the client side — never a
thrown raw value. `status` is the HTTP status when a response was received and
`0` for a local refusal (no request sent).

| Code | HTTP (proposal) | Meaning |
|---|---|---|
| `not_negotiated` | — (local, status 0) | extension absent, version incompatible, partial feature set, or `contract()` not called. **No write is attempted.** |
| `lease_conflict` | 409 | another active lease on the task, or a replay of an attempt that already ended |
| `version_conflict` | 409 | `expectedVersion` is stale; re-read `/state` |
| `claim_conflict` | 409 | the task is claimed by another session, or the lease is attached to another session |
| `not_found` | 404 | unknown task / lease, or the contract route is absent |
| `invalid_input` | 400 / 422 | malformed body, invalid outcome (`done`), report out of bounds, illegal lifecycle transition |
| `unreachable` | — (status 0) | transport failure; retryable, never a silent success |
| `bad_response` | — | the server answered with an envelope the client cannot trust |
| `http_error` | other | unclassified HTTP failure, preserved with its status |

The client maps the Task Board's own code vocabulary when the server uses it
(`invalid_transition` → `invalid_input`, `stale_request` → `version_conflict`,
etc.) instead of leaking vendor-specific strings into the orchestrator.

## Versioning and capability negotiation

`negotiateContract({ contract, stateMeta, probeError })` is pure and returns:

```js
{
  ok,               // the version is compatible
  version,          // server version or null
  features: Set,    // INTERSECTION of announced and known features
  missing: [],      // known features the server does not announce
  missingWrite: [], // missing features from the mandatory write set
  degraded,         // true when the extension is usable but incomplete
  absent,           // true only for a 404 probe
  writes,           // everything mandatory is present
  simulated,        // the server says it is a simulation (tests only)
  reason,           // contract_ok | contract_ok_degraded | partial_features |
                    // unsupported_version | contract_endpoint_absent |
                    // contract_probe_failed | contract_route_missing | contract_malformed
  probe             // the probe error that produced the decision, if any
}
```

Rules:

1. **404 is authoritative.** A missing `/dsh-taskboard/contract` route means
   “no extension”, even if `/state` carries a `meta.contractVersion` hint. The
   board never reconstructs the write API from the read payload.
2. **A newer major version is refused** (`unsupported_version`), not guessed.
3. **Partial support degrades but never writes.** `ok:true, degraded:true,
   writes:false`; the orchestrator keeps the task on the existing backends and
   records the missing features in its audit reason.
4. **Transport failures are `contract_probe_failed`**, retryable, and equally
   non-writing.
5. Negotiation is never cached across processes and never inferred from a
   capability matrix; `client.contract()` must succeed in this session before
   any write, and each method re-checks the gate.

## The §6.3 ten-step flow, and which layer owns each step

1. **Read** `GET /dsh-taskboard/state` — board reads `version`, `claimedBy`,
   `executions[]`. *(this layer: `adapter.list()`)*
2. **Negotiate** `GET /dsh-taskboard/contract`. *(this layer: `client.contract()`)*
3. **Lease** `POST …/executions/lease` with route, attempt, expectedVersion and
   idempotency key. *(this layer)*
4. **Attach** `POST …/:leaseId/attach` with the real session id. *(this layer)*
5. **Execute** the turn(s) on the board-owned session — route failover happens
   here. *(orchestrator, out of scope for this layer; the current build does not
   wire steps 3–7 into `POST /tick`)*
6. **Report** `POST …/:leaseId/report` with the structured report. *(this layer)*
7. **Settle** `POST …/:leaseId/settle` with outcome + `requestReview`.
   *(this layer)*
8. **Verify** `/state` shows one finished execution and `in_review`, claim
   released. *(this layer: `adapter.list()`)*
9. **Release** only for an abandoned attempt (reroute/cancel). *(this layer;
   unused on the happy path)*
10. **`done`** is confirmed by the human in the Task Board UI — never by the
    board, never by this client. *(not implemented anywhere, by design)*

`tests/taskboard-contract.test.js` asserts the ordering of steps 1, 2, 3, 4, 6,
7, 8 in the server call log, that step 9 is absent on the happy path, and that
no request or task state ever carries `done`.

## What the Task Board must implement (explicit)

1. **Route** `GET /dsh-taskboard/contract` returning the version + the exact
   feature names above, and **404** when the extension is not built.
2. **Lease route** `POST /tasks/:id/executions/lease` with: one active lease per
   task, monotonic `fence`, TTL (`leaseTtlMs`), `expectedVersion` guard,
   `claim_conflict` against a foreign `claimedBy`/running execution,
   `lease_conflict` for a second key, replay-by-key idempotency, and creation of
   a real `ExecutionRecord` (`outcome:"running"`, `trigger`, `startedAt`,
   `isolation`, plus the extension fields `leaseId`, `attempt`, `route`).
3. **Attach route** with the same lease/session idempotency (same session →
   same record, no version bump; different session → `claim_conflict`) and
   `claimedBy = sessionId`.
4. **Report route** that stores the existing `ExecutionReport` on the execution
   and returns a revision; refused after the attempt ends.
5. **Release route** that ends the attempt as `cancelled`, records the reason,
   clears the claim, returns the task to `todo`, and is idempotent.
6. **Settle route** that records `succeeded|failed|cancelled`, is idempotent,
   maps `requestReview:true` to `in_progress → in_review`, and **cannot** reach
   `done`.
7. **Idempotency store** (task + key → lease) that survives a host restart, or
   an explicit documented TTL after which a replay is a `lease_conflict`
   instead of a second execution.
8. **Lease expiry watchdog** so an abandoned lease releases the claim.
9. **Capability advertisement honesty**: never announce a feature the host does
   not implement; a partial implementation must announce only what it has, and
   the board will then refuse every write.
10. **No new ledger file, no new write surface for the board.** These routes are
    the ONE writer path for execution state; the board still never edits a task
    and never writes `done`.

## What the Agent Board does when the extension is absent

- `src/connectors/taskboard.js` keeps `id`, `capabilities`
  (`list`/`get`/`run`), `validatedLive:false` and the existing read-only
  `state` mapping; `contract()` only adds a **probe** that never throws.
- The two existing backends stay exactly as they are: `board` (failover, no
  execution record) and `taskboard` (`POST /tasks/:id/run`, execution record, no
  model failover). The board selects one per project policy.
- The refusal is **explicit and reason-coded**: a would-be contract write
  returns `not_negotiated` with the probe reason (`contract_endpoint_absent`,
  `partial_features`, `unsupported_version`, `contract_probe_failed`), which the
  orchestrator records in its audit trail. There is no fake execution, no
  synthetic `executionId`, no ledger edit, no retry against `/run`.
- Because the connector is **not wired into `POST /tick`** in this build, the
  only way to exercise it today is the contract tests below.

## Evidence (simulated)

Files:

- `src/connectors/taskboard-contract.js` — negotiation + client, dependency-free ESM
- `src/connectors/taskboard.js` — read-only adapter + non-throwing `contract()` probe
- `tests/fixtures/fake-taskboard-server.mjs` — SIMULATED `node:http` server (real
  `/state` shape + proposed extension, `x-simulated-contract: true` on every response)
- `tests/taskboard-contract.test.js` — 14 contract tests
- this document

Commands that produced the evidence (run from `D:\App\DSH-agent-board`,
branch `goal3/supervision-orchestration`):

```powershell
node --test tests/taskboard-contract.test.js
# tests 14 / pass 14 / fail 0

node --test tests/
# tests 207 / pass 207 / fail 0
```

Both runs were executed on Windows with Node.js v26.13.0 while other teammates
were landing unrelated work on the same branch. The suite reported **152/152
passing** at the start of this task (before the 14 contract tests were added);
the larger full-suite count includes concurrent teammate tests
(`tests/budget.test.js`, `tests/routing-*.test.js`, …), which is why this
document quotes the file-level count of its own layer and the full-suite count
separately.

What these commands **do not** prove: that the real Task Board accepts any of
this (it does not implement it), that a live socket can be authenticated, or
that `/tick` uses the client. No live plugin was contacted.

## Open questions for the Task Board owners

1. **Ten-step numbering.** §6.3 was not available verbatim to this teammate; the
   ten steps above are the reconstruction used by the tests. Please confirm the
   mapping (especially whether “verify” is step 8 and “human done” is step 10).
2. **Lease TTL / renew.** Is 120 s the right default, and is an explicit
   `POST …/:leaseId/renew` needed for long single-turn work, or is TTL
   re-assertion on each report enough?
3. **`claimedBy` before attach.** Is `lease:<leaseId>` acceptable as a
   placeholder holder, or must the holder always be a real session id (attach
   then becomes mandatory for every state transition)?
4. **Release destination.** Should release return the task to `todo` (proposed),
   or stay `in_progress` to keep a reroute chain visibly in progress?
5. **Execution-record shape.** Are `leaseId`, `attempt`, `route` acceptable as
   optional fields on `ExecutionRecord`, or does the plugin prefer a separate
   `attempts[]` array?
6. **Report placement.** Reuse `ExecutionRecord.report` (proposed) or a
   per-attempt report collection?
7. **Settle → in_review ownership.** Should settle perform the
   `in_progress → in_review` move (proposed, `requestReview`), or must the agent
   session still do the move itself so the Task Board's tool-level guards apply?
8. **Auth/CSRF and multi-host fencing.** These POSTs are on the same-origin GUI
   surface; what token/CSRF rule applies, and does `fence` need to be enforced
   against other host processes, not just other leases?
9. **Partial extensions.** The board currently refuses ALL writes when one
   mandatory feature is missing. Confirm that is preferable to a per-feature
   opt-in policy.
10. **Idempotency storage.** Dedicated key store with a documented retention
    window, or reuse the ledger's existing `version` fencing?
