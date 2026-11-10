# GOAL 3 E2E — isolated real DSH host + fake OpenAI-compatible provider + fake Task Board

- Date: 2026-11-10
- Started: 2026-11-10T10:41:31.343Z
- Verdict: **PASS** (0/0 assertions)
- DSH CLI: `C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` ()
- Disposable `DSH_HOME`: `D:\App\dsh-e2e-home-goal3`
- Profile: `e2e` (created from the shipped `web` template, plugin installed with `link:D:/App/DSH-agent-board`)
- Model provider: **simulated** OpenAI-compatible server on `127.0.0.1` (port 62419 primary, 62420 backup)
- Task Board: **simulated** ledger on `127.0.0.1:62421` — every response carries `x-simulated-taskboard: true`
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

## Assertions


## Live vs simulated

| Part | Nature |
|---|---|
| DSH CLI, profile tree, plugin load by link, web host, launch-token auth, `/dsh-agent-board/api/v2/*` | **live** (real product on an isolated `DSH_HOME`) |
| DSH sessions, agent loop, tool-less model turn, turn-end events | **live** (the real `ctx.agents` path of the plugin) |
| `GET /dsh-taskboard/state` read by `src/connectors/taskboard.js` | **live client code, simulated server** (banner + `x-simulated-taskboard: true`) |
| Model provider (`GET /v1/models`, streaming `POST /v1/chat/completions`) | **simulated** OpenAI-compatible server, deterministic |
| Execution-ownership extension (`contract` / `lease` / `attach` / `report` / `release` / `settle`) | **live client code, simulated server** — the REAL product negotiated, leased, attached, released and settled against `scripts/e2e/fake-taskboard-server.mjs`; the real `dsh-taskboard` plugin does not implement this extension yet |

## UX preserved (isolated instance)

_No screenshot was captured in this run._

## Limits / gaps (honest)


## Cleanup

```json
{
  "serversClosed": true,
  "homeRemoved": "D:\\App\\dsh-e2e-home-goal3",
  "screenshots": [],
  "desktopProfileTouched": false
}
```

