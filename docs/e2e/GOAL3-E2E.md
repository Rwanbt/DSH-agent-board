# GOAL 3 E2E — isolated real DSH host + fake OpenAI-compatible provider + fake Task Board

- Date: 2026-11-12
- Started: 2026-11-12T01:08:56.722Z
- Verdict: **PASS** (29/29 assertions passed, 4 scenario(s) executed)
- DSH CLI: `C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` (0.2.2-rc.1)
- Disposable `DSH_HOME`: `C:\Users\barat\AppData\Local\Temp\dsh-e2e-home-goal3`
- Profile: `e2e` (created from the shipped `web` template, plugin installed with `link:D:/App/DSH-agent-board`)
- Model provider: **simulated** OpenAI-compatible server on `127.0.0.1` (port 50728 primary, 50729 backup)
- Task Board: **simulated** ledger on `127.0.0.1:50730` — every response carries `x-simulated-taskboard: true`
- Credentials: **none**. The provider route uses an invented environment value; the desktop profile was never read or written.

## Commands actually run

```powershell
$env:DSH_HOME = 'C:\Users\barat\AppData\Local\Temp\dsh-e2e-home-goal3'
& 'C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile e2e --from-default-profile web --dump-config
& 'C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile e2e add link:D:/App/DSH-agent-board
& 'C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --profile e2e --port 0 --no-open   # prints dsh web: http://127.0.0.1:<port>/?token=…
```

The orchestrator then exchanged the launch token for the signed session cookie and used the board API:

```text
GET  /dsh-agent-board/api/v2/state
POST /dsh-agent-board/api/v2/policy   { executionBackend: "contract", routeChain: [e2e-primary, e2e-backup], maxRetries: 0, maxSwitches: 1 }
GET  /dsh-agent-board/api/v2/contract  -> { writes: true, version: 1 }
POST /dsh-agent-board/api/v2/mode     { mode: "autonomous" }
POST /dsh-agent-board/api/v2/tick
GET  /dsh-agent-board/api/v2/events   (SSE)
```

## What ran and what was observed

### 0-mandate-gate — A real host refuses every launch until the operator confirms an explicit mandate; dry-run writes nothing

- Tick: `[]`
- `routeEvents`: `[]`
- Primary provider: 0 × 429, 0 × 200.
- Backup provider: 0 × 200.
- Assignments: `[]`
- Simulated executions: `[]`
- Final simulated ledger status: `` (never `done`)
- Audit: `[]`

### a-contract-model-turn — Autonomous tick leases a canonical execution, runs a real session turn on the fake provider, attaches, settles to in_review

- Contract: `{"version":1,"ok":true,"writes":true,"degraded":false,"absent":false,"simulated":true,"reason":"contract_ok","features":["execution.lease","execution.attach","execution.report","execution.release","execution.settle","execution.fencing","execution.idempotency","execution.reroute"],"missing":[],"missingWrite":[],"at":1794445740478}`
- Tick: `[{"kind":"launch","taskId":"tb-e2e-contract","ok":true,"assignmentId":"asg-03fe8801-1b54-4bed-a67d-1ecfc42f255d","sessionId":"session-agentboard-0d1a2bd2-f7d9-4099-9647-5ce56cd7cea1","executionId":"exec-1","leaseId":"lease-1"}]`
- Session: `session-agentboard-0d1a2bd2-f7d9-4099-9647-5ce56cd7cea1` — `turnEnd`: `{"at":1794445740841,"kind":"completed","error":null}`
- Fake provider requests: `[{"seq":1,"status":200,"chunks":6,"model":"e2e-fake-gpt"}]`
- Assignment: `status=done`, `backend=contract`, `leaseId=lease-1`, `executionId=exec-1`
- Simulated Task Board calls (by the REAL product): `["POST /dsh-taskboard/tasks/tb-e2e-contract/executions/lease","POST /dsh-taskboard/executions/lease-1/attach","POST /dsh-taskboard/executions/lease-1/settle"]`
- Simulated ledger task: `status=in_review`, executions: `[{"id":"exec-1","outcome":"succeeded","previousExecutionId":null,"hasReport":true}]`
- SSE: 3 frame(s), 3 named — sample below.

```text
event: state
data: {"schemaVersion":2,"mode":"autonomous","stoppedAt":null,"policy":{"mode":"autonomous","maxConcurrent":2,"maxRetries":2,"maxSwitches":2,"proposalTtlMs":1800000,"leaseTtlMs":600000,"retryCooldownMs":300000,"maxAttemptsPerRevision":4,"allowedWorkspaces":[],"allowedProviders":[],"allowedPermissions":["read-only","workspace-write"],"executionBackend":"board","allowCloudFallback":false,"autoResumeOnRestart":false,"serializeSameWorkspace":false,"routeChain":[],"projectPolicies":{},"autonomyBudget":{"maxTasksPerHour":6},"requestsPerHour":120,"contractBoardReport":true,"settlementRetryMs":60000,"allowUnverifiedHandoff":false,"supervision":{"enabled":true,"emblem":"crown","maxConcur
```

### b-contract-failover — A scripted 429 on the primary provider makes the board release attempt 1 and lease a SECOND execution with previousExecutionId on the backup route

- Tick: `[{"kind":"launch","taskId":"tb-e2e-failover","ok":true,"assignmentId":"asg-feb95cb8-d0eb-4c1d-a8a8-5f6177c7280b","sessionId":"session-agentboard-ddd3d9b0-1ba0-438f-a682-0d8f97a5ac32","executionId":"exec-2","leaseId":"lease-2"}]`
- `routeEvents`: `[{"at":1794445752551,"taskId":"tb-e2e-failover","assignmentId":"asg-feb95cb8-d0eb-4c1d-a8a8-5f6177c7280b","from":"e2e-primary/e2e-fake-gpt","to":"e2e-backup/e2e-fake-backup-gpt","action":"switch","reason":"switch_after_rate_limit","kind":"rate_limit"}]`
- Primary provider: 1 × 429, 0 × 200.
- Backup provider: 1 × 200.
- Assignments: `[{"attempt":0,"status":"superseded","provider":"e2e-primary","leaseId":"lease-2","executionId":"exec-2","history":[]},{"attempt":1,"status":"done","provider":"e2e-backup","leaseId":"lease-3","executionId":"exec-3","history":["rate_limit"]}]`
- Simulated executions: `[{"id":"exec-2","outcome":"cancelled","previousExecutionId":null,"route":"e2e-primary","hasReport":false},{"id":"exec-3","outcome":"succeeded","previousExecutionId":"exec-2","route":"e2e-backup","hasReport":true}]`
- Final simulated ledger status: `in_review` (never `done`)
- Audit: `["delegation_allowed","launch","tick","handoff","turn_done"]`

### c-three-projects — Three projects: A at L4 and priority 1, B at L3, C out of scope — only A then B launch, C is never touched, one slot is shared fairly

- Tick: `[]`
- `routeEvents`: `[]`
- Primary provider: 0 × 429, 0 × 200.
- Backup provider: 0 × 200.
- Assignments: `[]`
- Simulated executions: `[]`
- Final simulated ledger status: `` (never `done`)
- Audit: `[]`

## Assertions

- ✅ **0. the fake OpenAI-compatible provider answers GET /v1/models** — {"status":200,"models":["e2e-fake-gpt"]}
- ✅ **0a. an unconfirmed mandate refuses every launch even in autonomous mode** — {"reason":"requires_configuration","actions":[]}
- ✅ **0b. the refused tick created no session and no assignment** — {"before":0,"after":0}
- ✅ **0c. the published capability is truthful (unavailable + real reason)** — {"state":"unavailable","reason":"scope_none","source":"mandate"}
- ✅ **0d. dry-run is read-only and reports zero writes** — {"writes":0,"candidateCount":0,"allowedCount":0}
- ✅ **0e. dry-run created no assignment** — 
- ✅ **0f. "all projects" without the explicit confirmation is refused** — {"status":409,"error":"all_scope_requires_confirmation"}
- ✅ **0g. after the explicit grant the launch capability becomes available** — {"state":"available","reason":"allowed","source":"mandate"}
- ✅ **0h. the grant is audited and cleared the configuration gate** — {"requiresConfiguration":false}
- ✅ **a1. the execution contract negotiated with writes=true** — {"version":1,"ok":true,"writes":true,"degraded":false,"absent":false,"simulated":true,"reason":"contract_ok","features":["execution.lease","execution.attach","execution.report","execution.release","execution.settle","execution.fencing","execution.idempotency","execution.reroute"],"missing":[],"missingWrite":[],"at":1794445740478}
- ✅ **a2. POST /tick launched a real board session on the contract backend** — {"action":{"kind":"launch","taskId":"tb-e2e-contract","ok":true,"assignmentId":"asg-03fe8801-1b54-4bed-a67d-1ecfc42f255d","sessionId":"session-agentboard-0d1a2bd2-f7d9-4099-9647-5ce56cd7cea1","executionId":"exec-1","leaseId":"lease-1"},"backend":"contract","sessionId":"session-agentboard-0d1a2bd2-f7d9-4099-9647-5ce56cd7cea1"}
- ✅ **a3. the model turn completed on the fake provider** — {"turnEnd":{"at":1794445740841,"kind":"completed","error":null},"primary":[{"status":200,"chunks":6}]}
- ✅ **a4. the simulated Task Board received lease -> attach -> settle** — [{"method":"POST","path":"/dsh-taskboard/tasks/tb-e2e-contract/executions/lease","status":"accepted"},{"method":"POST","path":"/dsh-taskboard/executions/lease-1/attach","status":"accepted"},{"method":"POST","path":"/dsh-taskboard/executions/lease-1/settle","status":"accepted"}]
- ✅ **a5. the settled execution is in_review with a report and is NEVER done** — {"status":"in_review","executions":[{"id":"exec-1","outcome":"succeeded","hasReport":true,"previousExecutionId":null}]}
- ✅ **a6. the board audit recorded contract settlement** — ["delegation_allowed","launch","tick","mode_changed","turn_done","contract_settled"]
- ✅ **a7. SSE /events delivered a named state frame** — {"frames":3,"named":3,"error":null,"sample":"event: state\ndata: {\"schemaVersion\":2,\"mode\":\"autonomous\",\"stoppedAt\":null,\"policy\":{\"mode\":\"autonomous\",\"maxConcurrent\":2,\"maxRetries\":2,\"maxSwitches\":2,\"proposalTtlMs\":1800000,\"leaseTtlMs\":600000,\"retryCooldownMs\":300000,\"max
- ✅ **b1. the scripted 429 was classified as rate_limit and routed to a switch** — {"primarySaw429":true,"routeEvents":["switch:rate_limit"]}
- ✅ **b2. the board switched to the backup provider route** — {"at":1794445752551,"taskId":"tb-e2e-failover","assignmentId":"asg-feb95cb8-d0eb-4c1d-a8a8-5f6177c7280b","from":"e2e-primary/e2e-fake-gpt","to":"e2e-backup/e2e-fake-backup-gpt","action":"switch","reason":"switch_after_rate_limit","kind":"rate_limit"}
- ✅ **b3. attempt 1 execution was released and executed on the primary provider** — {"sawRelease":true,"first":{"id":"exec-2","outcome":"cancelled","route":{"provider":"e2e-primary","model":"e2e-fake-gpt"}}}
- ✅ **b4. a SECOND canonical execution carries previousExecutionId** — {"executions":[{"id":"exec-2","previousExecutionId":null,"outcome":"cancelled","route":"e2e-primary"},{"id":"exec-3","previousExecutionId":"exec-2","outcome":"succeeded","route":"e2e-backup"}]}
- ✅ **b5. the second session ran on the backup route and completed** — {"backupTurnEnd":{"at":1794445752916,"kind":"completed","error":null},"backup200":true}
- ✅ **b6. the card ended in_review with the second execution report, never done** — {"status":"in_review","second":{"outcome":"succeeded","hasReport":true}}
- ✅ **b7. audit recorded release/handoff/settle** — ["launch","route_decision","contract_released","handoff","turn_done","contract_settled"]
- ✅ **c1. the highest-priority project (A) is served first** — 
- ✅ **c2. the second project is served next (no starvation of the lower priority)** — 
- ✅ **c3. the out-of-scope project C is never launched, never claimed, never written** — 
- ✅ **c4. the published portfolio says C is not selected** — 
- ✅ **c5. the published portfolio exposes the effective level of A (L4)** — 
- ✅ **c6. the two launches are distinct sessions and distinct projects** — 

## Live vs simulated

| Part | Nature |
|---|---|
| DSH CLI, profile tree, plugin load by link, web host, launch-token auth, `/dsh-agent-board/api/v2/*` | **live** (real product on an isolated `DSH_HOME`) |
| DSH sessions, agent loop, tool-less model turn, turn-end events | **live** (the real `ctx.agents` path of the plugin) |
| `GET /dsh-taskboard/state` read by `src/connectors/taskboard.js` | **live client code, simulated server** (banner + `x-simulated-taskboard: true`) |
| Model provider (`GET /v1/models`, streaming `POST /v1/chat/completions`) | **simulated** OpenAI-compatible server, deterministic |
| Execution-ownership extension (`contract` / `lease` / `attach` / `report` / `release` / `settle`) | **live client code, simulated server** — the REAL product negotiated, leased, attached, released and settled against `scripts/e2e/fake-taskboard-server.mjs`; the real `dsh-taskboard` plugin does not implement this extension yet |

### Extension semantics, exercised directly as well

```text
GET  /dsh-taskboard/contract           -> HTTP 200 advertised ["execution.lease","execution.attach","execution.report","execution.release","execution.settle","execution.fencing","execution.idempotency","execution.reroute"]
POST /tasks/tb-e2e-contract-direct/executions/lease -> HTTP 202 {"leaseId":"lease-4","executionId":"exec-4","taskId":"tb-e2e-contract-direct","taskVersion":2,"route":null,"attempt":1,"fence":4,"expiresAt":1794445876594,"state":"leased"}
POST lease replay (same key)           -> HTTP 200 (idempotent, same lease)
POST lease (different key)             -> HTTP 409 {"code":"lease_conflict","message":"task tb-e2e-contract-direct already has an active lease (lease-4)","leaseId":"lease-4","fence":4}
POST attach                            -> HTTP 200 {"leaseId":"lease-4","sessionId":"session-e2e-contract","executionId":"exec-4","state":"attached","attachedAt":1794445756596}
POST report                            -> HTTP 200 {"leaseId":"lease-4","reportRevision":1,"acceptedAt":1794445756597}
POST settle                            -> HTTP 200 {"leaseId":"lease-4","executionId":"exec-4","taskId":"tb-e2e-contract-direct","outcome":"succeeded","taskVersion":5,"status":"in_review","reportRevision":2,"simulated":true}
```

## UX preserved (isolated instance)

The Agent Board panel in the isolated instance (same client bundle as the product) was captured by Playwright:

- [`goal3-ux-1366x768-dark-card-preview.png`](screenshots/goal3-ux-1366x768-dark-card-preview.png)
- [`goal3-ux-1366x768-dark.png`](screenshots/goal3-ux-1366x768-dark.png)
- [`goal3-ux-1366x768-light.png`](screenshots/goal3-ux-1366x768-light.png)
- [`goal3-ux-390x844-dark.png`](screenshots/goal3-ux-390x844-dark.png)
- [`goal3-ux-390x844-light.png`](screenshots/goal3-ux-390x844-light.png)


## What this PASS does NOT prove

- **Not the real Task Board extension.** The lease/attach/report/settle protocol was spoken by the real product against `scripts/e2e/fake-taskboard-server.mjs`; the real 0.10/0.11 Task Board does not implement `/dsh-taskboard/contract`.
- **Not a real provider outage.** The 429 is scripted by the fake provider; it proves the classification/failover code path, not behaviour against a live vendor incident (quota, network partitions, partial streams).
- **Not model quality.** The provider is deterministic and tool-less; it proves transport, turn loop and orchestration, not reasoning, tool use, or prompt quality.
- **Not the desktop profile.** The run uses a disposable `DSH_HOME`; the operator's real profile, credentials and sessions were never read or written.

## Limits / gaps (honest)

- The real `dsh-taskboard` plugin (0.10/0.11) does NOT implement the execution-ownership extension. The contract path is proven against a SIMULATED Task Board (clearly headed `x-simulated-taskboard: true`), so it proves the board side of the contract, not a live Task Board integration.
- The Agent Board connector reports `validatedLive: false` by design; the ledger read was made against the simulation.
- The fake provider is deterministic and tool-less; it proves the transport + turn loop, not real model quality or reasoning.
- Only a 429 was driven through the board classifier in this run. 500/401/timeout/partial-stream/unknown-model behaviours are implemented and scriptable in the fake provider but were not routed through a board turn.
- The simulated ledger is updated by the harness only to seed cards; the reviewed transition to `in_review` in the contract scenarios is performed by the REAL board settle call, not by the harness.

## Cleanup

```json
{
  "portClosed": true,
  "serversClosed": true,
  "homeRemoved": "C:\\Users\\barat\\AppData\\Local\\Temp\\dsh-e2e-home-goal3",
  "screenshots": [
    "goal3-ux-1366x768-dark-card-preview.png",
    "goal3-ux-1366x768-dark.png",
    "goal3-ux-1366x768-light.png",
    "goal3-ux-390x844-dark.png",
    "goal3-ux-390x844-light.png"
  ],
  "desktopProfileTouched": false,
  "finishedAt": "2026-11-12T01:22:29.314Z"
}
```

