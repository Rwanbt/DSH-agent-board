# GOAL 3 E2E — isolated real DSH host + fake OpenAI-compatible provider + fake Task Board

- Date: 2026-11-10
- Started: 2026-11-10T11:11:13.673Z
- Verdict: **PASS** (15/15 assertions passed, 2 scenario(s) executed)
- DSH CLI: `C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` (0.2.2-rc.1)
- Disposable `DSH_HOME`: `D:\App\dsh-e2e-home-goal3`
- Profile: `e2e` (created from the shipped `web` template, plugin installed with `link:D:/App/DSH-agent-board`)
- Model provider: **simulated** OpenAI-compatible server on `127.0.0.1` (port 52134 primary, 52135 backup)
- Task Board: **simulated** ledger on `127.0.0.1:52136` — every response carries `x-simulated-taskboard: true`
- Credentials: **none**. The provider route uses an invented environment value; the desktop profile was never read or written.

## Commands actually run

```powershell
$env:DSH_HOME = 'D:\App\dsh-e2e-home-goal3'
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

### a-contract-model-turn — Autonomous tick leases a canonical execution, runs a real session turn on the fake provider, attaches, settles to in_review

- Contract: `{"version":1,"ok":true,"writes":true,"degraded":false,"absent":false,"simulated":true,"reason":"contract_ok","features":["execution.lease","execution.attach","execution.report","execution.release","execution.settle","execution.fencing","execution.idempotency","execution.reroute"],"missing":[],"missingWrite":[],"at":1794309078179}`
- Tick: `[{"kind":"launch","taskId":"tb-e2e-contract","ok":true,"assignmentId":"asg-baac8595-ebd0-464f-8e30-bdcb06c2e4e8","sessionId":"session-agentboard-f932d7a9-d309-41d5-92b0-1457c36196a5","executionId":"exec-1","leaseId":"lease-1"}]`
- Session: `session-agentboard-f932d7a9-d309-41d5-92b0-1457c36196a5` — `turnEnd`: `{"at":1794309078630,"kind":"completed","error":null}`
- Fake provider requests: `[{"seq":1,"status":200,"chunks":6,"model":"e2e-fake-gpt"}]`
- Assignment: `status=done`, `backend=contract`, `leaseId=lease-1`, `executionId=exec-1`
- Simulated Task Board calls (by the REAL product): `["POST /dsh-taskboard/tasks/tb-e2e-contract/executions/lease","POST /dsh-taskboard/executions/lease-1/attach","POST /dsh-taskboard/executions/lease-1/settle"]`
- Simulated ledger task: `status=in_review`, executions: `[{"id":"exec-1","outcome":"succeeded","previousExecutionId":null,"hasReport":true}]`
- SSE: 3 frame(s), 3 named — sample below.

```text
event: state
data: {"schemaVersion":1,"mode":"off","stoppedAt":null,"policy":{"mode":"off","maxConcurrent":2,"maxRetries":2,"maxSwitches":2,"proposalTtlMs":1800000,"leaseTtlMs":600000,"retryCooldownMs":300000,"maxAttemptsPerRevision":4,"allowedWorkspaces":[],"allowedProviders":[],"allowedPermissions":["read-only","workspace-write"],"executionBackend":"board","allowCloudFallback":false,"autoResumeOnRestart":false,"serializeSameWorkspace":false,"routeChain":[],"projectPolicies":{},"autonomyBudget":{"maxTasksPerHour":6},"requestsPerHour":120,"contractBoardReport":true,"settlementRetryMs":60000,"allowUnverifiedHandoff":false},"acks":{},"previews":{},"turnEnd":{},"proposals":[],"recentProposals":
```

### b-contract-failover — A scripted 429 on the primary provider makes the board release attempt 1 and lease a SECOND execution with previousExecutionId on the backup route

- Tick: `[{"kind":"launch","taskId":"tb-e2e-failover","ok":true,"assignmentId":"asg-339dac9c-5eb3-49b7-a6cb-a4e7d4cebe31","sessionId":"session-agentboard-3c5a345b-a733-4e57-bec1-efe6c8b52af7","executionId":"exec-2","leaseId":"lease-2"}]`
- `routeEvents`: `[{"at":1794309090233,"taskId":"tb-e2e-failover","assignmentId":"asg-339dac9c-5eb3-49b7-a6cb-a4e7d4cebe31","from":"e2e-primary/e2e-fake-gpt","to":"e2e-backup/e2e-fake-backup-gpt","action":"switch","reason":"switch_after_rate_limit","kind":"rate_limit"}]`
- Primary provider: 1 × 429, 0 × 200.
- Backup provider: 1 × 200.
- Assignments: `[{"attempt":0,"status":"superseded","provider":"e2e-primary","leaseId":"lease-2","executionId":"exec-2","history":[]},{"attempt":1,"status":"done","provider":"e2e-backup","leaseId":"lease-3","executionId":"exec-3","history":["rate_limit"]}]`
- Simulated executions: `[{"id":"exec-2","outcome":"cancelled","previousExecutionId":null,"route":"e2e-primary","hasReport":false},{"id":"exec-3","outcome":"succeeded","previousExecutionId":"exec-2","route":"e2e-backup","hasReport":true}]`
- Final simulated ledger status: `in_review` (never `done`)
- Audit: `["launch","tick","handoff","turn_done"]`

## Assertions

- ✅ **0. the fake OpenAI-compatible provider answers GET /v1/models** — {"status":200,"models":["e2e-fake-gpt"]}
- ✅ **a1. the execution contract negotiated with writes=true** — {"version":1,"ok":true,"writes":true,"degraded":false,"absent":false,"simulated":true,"reason":"contract_ok","features":["execution.lease","execution.attach","execution.report","execution.release","execution.settle","execution.fencing","execution.idempotency","execution.reroute"],"missing":[],"missingWrite":[],"at":1794309078179}
- ✅ **a2. POST /tick launched a real board session on the contract backend** — {"action":{"kind":"launch","taskId":"tb-e2e-contract","ok":true,"assignmentId":"asg-baac8595-ebd0-464f-8e30-bdcb06c2e4e8","sessionId":"session-agentboard-f932d7a9-d309-41d5-92b0-1457c36196a5","executionId":"exec-1","leaseId":"lease-1"},"backend":"contract","sessionId":"session-agentboard-f932d7a9-d309-41d5-92b0-1457c36196a5"}
- ✅ **a3. the model turn completed on the fake provider** — {"turnEnd":{"at":1794309078630,"kind":"completed","error":null},"primary":[{"status":200,"chunks":6}]}
- ✅ **a4. the simulated Task Board received lease -> attach -> settle** — [{"method":"POST","path":"/dsh-taskboard/tasks/tb-e2e-contract/executions/lease","status":"accepted"},{"method":"POST","path":"/dsh-taskboard/executions/lease-1/attach","status":"accepted"},{"method":"POST","path":"/dsh-taskboard/executions/lease-1/settle","status":"accepted"}]
- ✅ **a5. the settled execution is in_review with a report and is NEVER done** — {"status":"in_review","executions":[{"id":"exec-1","outcome":"succeeded","hasReport":true,"previousExecutionId":null}]}
- ✅ **a6. the board audit recorded contract settlement** — ["mode_changed","launch","tick","mode_changed","turn_done","contract_settled"]
- ✅ **a7. SSE /events delivered a named state frame** — {"frames":3,"named":3,"error":null,"sample":"event: state\ndata: {\"schemaVersion\":1,\"mode\":\"off\",\"stoppedAt\":null,\"policy\":{\"mode\":\"off\",\"maxConcurrent\":2,\"maxRetries\":2,\"maxSwitches\":2,\"proposalTtlMs\":1800000,\"leaseTtlMs\":600000,\"retryCooldownMs\":300000,\"maxAttemptsPerRev
- ✅ **b1. the scripted 429 was classified as rate_limit and routed to a switch** — {"primarySaw429":true,"routeEvents":["switch:rate_limit"]}
- ✅ **b2. the board switched to the backup provider route** — {"at":1794309090233,"taskId":"tb-e2e-failover","assignmentId":"asg-339dac9c-5eb3-49b7-a6cb-a4e7d4cebe31","from":"e2e-primary/e2e-fake-gpt","to":"e2e-backup/e2e-fake-backup-gpt","action":"switch","reason":"switch_after_rate_limit","kind":"rate_limit"}
- ✅ **b3. attempt 1 execution was released and executed on the primary provider** — {"sawRelease":true,"first":{"id":"exec-2","outcome":"cancelled","route":{"provider":"e2e-primary","model":"e2e-fake-gpt"}}}
- ✅ **b4. a SECOND canonical execution carries previousExecutionId** — {"executions":[{"id":"exec-2","previousExecutionId":null,"outcome":"cancelled","route":"e2e-primary"},{"id":"exec-3","previousExecutionId":"exec-2","outcome":"succeeded","route":"e2e-backup"}]}
- ✅ **b5. the second session ran on the backup route and completed** — {"backupTurnEnd":{"at":1794309090523,"kind":"completed","error":null},"backup200":true}
- ✅ **b6. the card ended in_review with the second execution report, never done** — {"status":"in_review","second":{"outcome":"succeeded","hasReport":true}}
- ✅ **b7. audit recorded release/handoff/settle** — ["launch","route_decision","contract_released","handoff","turn_done","contract_settled"]

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
POST /tasks/tb-e2e-contract-direct/executions/lease -> HTTP 202 {"leaseId":"lease-4","executionId":"exec-4","taskId":"tb-e2e-contract-direct","taskVersion":2,"route":null,"attempt":1,"fence":4,"expiresAt":1794309212234,"state":"leased"}
POST lease replay (same key)           -> HTTP 200 (idempotent, same lease)
POST lease (different key)             -> HTTP 409 {"code":"lease_conflict","message":"task tb-e2e-contract-direct already has an active lease (lease-4)","leaseId":"lease-4","fence":4}
POST attach                            -> HTTP 200 {"leaseId":"lease-4","sessionId":"session-e2e-contract","executionId":"exec-4","state":"attached","attachedAt":1794309092236}
POST report                            -> HTTP 200 {"leaseId":"lease-4","reportRevision":1,"acceptedAt":1794309092237}
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
  "homeRemoved": "D:\\App\\dsh-e2e-home-goal3",
  "screenshots": [
    "goal3-ux-1366x768-dark-card-preview.png",
    "goal3-ux-1366x768-dark.png",
    "goal3-ux-1366x768-light.png",
    "goal3-ux-390x844-dark.png",
    "goal3-ux-390x844-light.png"
  ],
  "desktopProfileTouched": false,
  "finishedAt": "2026-11-10T11:11:32.342Z"
}
```

