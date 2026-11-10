# Install, configure, roll back

This procedure is written for a DSH `0.2.2-rc.1` desktop/web profile on Windows
(the same steps apply on Linux with the POSIX paths). It never touches the Task
Board repository and never writes the Task Board ledger.

## 1. Prerequisites

| Requirement | Check |
|---|---|
| DSH host | `dsh --version` → `0.2.2-rc.1` (`package.json` → `dsh.compatibility.dshReleases`) |
| Node | `node --version` → `>=22` (the plugin is plain ESM, no build step for the host) |
| A DSH workspace directory | the board only launches inside a registered workspace |
| Optional: Task Board | `dsh-taskboard` installed in the same profile (read-only source, `run` opt-in) |

## 2. Install the plugin (link mode, development)

```powershell
# from the DSH profile directory
cd "$env:USERPROFILE\.dsh\profiles\desktop"
dsh plugin --profile desktop add link:D:/App/DSH-agent-board
# restart DeepSeek Harness so the host half and the client module table reload
```

Equivalent manual form in `~/.dsh/profiles/desktop/package.json`:

```json
{ "dependencies": { "dsh-agent-board": "link:D:/App/DSH-agent-board" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-agent-board" ] } } }
```

The plugin declares `dsh.bundle.patch` (`cordis.patch.yml`) and a web client
(`dsh.client.inject: ["slots"]`), so no extra loader entry is needed.

## 3. Verify the installation

```powershell
$origin = "http://127.0.0.1:62337"   # the GUI origin printed by the app
# 1. host state answers 200 with mode "off"
Invoke-RestMethod "$origin/dsh-agent-board/api/v2/state" | ConvertTo-Json -Depth 3

# 2. the adapter matrix is exposed (Task Board read capability, honest flags)
Invoke-RestMethod "$origin/dsh-agent-board/api/v2/adapters" | ConvertTo-Json -Depth 6

# 3. the execution contract is probed (absent on a real 0.10/0.11 Task Board)
Invoke-RestMethod "$origin/dsh-agent-board/api/v2/contract" | ConvertTo-Json -Depth 4
```

Expected: `mode: off`, `instance.primary: true`, and `contract.absent: true` on a
real Task Board (the proposed routes do not exist there yet) with
`state.contract.writes: false`. The panel is visible in the GUI sidebar; the
board does nothing until a mode is selected.

## 4. Configure

Everything is one JSON document, via `POST /dsh-agent-board/api/v2/policy`
(`{ "policy": { … } }`):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `off` | `off` / `supervised` / `autonomous` (also `POST /mode`) |
| `executionBackend` | `board` | `board` (failover, no canonical record), `taskboard` (canonical record, pinned model), `contract` (both, needs the negotiated extension) |
| `maxConcurrent` | 2 | live assignments |
| `allowedWorkspaces` | `[]` | empty = every visible workspace |
| `allowedProviders` | `[]` | empty = policy-defined; non-empty = allow-list |
| `allowedPermissions` | `read-only`, `workspace-write` | a card can never grant itself more |
| `routeChain` | `[]` | ordered `{provider, model, locality?, reasoningEffort?}` |
| `projectPolicies` | `{}` | per-workspace route overrides (most-restrictive-wins) |
| `maxRetries` / `maxSwitches` | 2 / 2 | retry and switch budgets |
| `retryCooldownMs` / `leaseTtlMs` | 5 min / 10 min | pacing and lease lifetime |
| `maxAttemptsPerRevision` | 4 | bounded automatic relaunches |
| `autonomyBudget.maxTasksPerHour` | 6 | hourly cap |
| `requestsPerHour` | 120 | hourly provider-request cap |
| `allowCloudFallback` | `false` | a local model never falls back to the cloud |
| `contractBoardReport` | `true` | attach a board-observed settlement report |
| `autoResumeOnRestart` | `false` | autonomy requires an explicit `POST /resume` after a restart |

Stop is independent from OFF: `POST /stop` cancels in-flight work and blocks new
delegation until `POST /resume`; switching mode does not lift it.

## 5. Roll back

The board owns no external state except `$DSH_HOME/agent-board/`, and it never
writes the Task Board, so rollback is additive and safe:

```powershell
# 1. stop the board (no new delegation, live sessions cancelled)
Invoke-RestMethod -Method Post "$origin/dsh-agent-board/api/v2/stop" -Body '{}' -ContentType application/json

# 2. uninstall the plugin
cd "$env:USERPROFILE\.dsh\profiles\desktop"
dsh plugin --profile desktop remove dsh-agent-board
# restart DeepSeek Harness

# 3. optional: keep or purge the durable state
Copy-Item "$env:USERPROFILE\.dsh\agent-board\state.json" "$env:USERPROFILE\.dsh\agent-board\state-backup.json"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\agent-board"
```

Rolling back does **not** need to reverse a task: the board never moved a card to
`done`, never wrote the ledger, and a contract lease it could not release expires
on the Task Board side.

## 6. Isolated trial instance (no risk to the real profile)

```powershell
$env:DSH_HOME = "D:\App\dsh-e2e-home-goal3"
dsh --profile e2e --from-default-profile web --dump-config | Out-Null
dsh plugin --profile e2e add link:D:/App/DSH-agent-board
dsh --profile e2e --port 0 --no-open    # token URL printed in the console
```

`scripts/e2e/run-e2e.mjs` automates this and points the board at a fake
OpenAI-compatible provider and a simulated Task Board extension, with no
credentials. See `docs/e2e/GOAL3-E2E.md`.

## 7. Compatibility and branch policy

- The plugin declares compatibility with DSH `0.2.2-rc.1`; any other release is
  untested and must be reported as such.
- GOAL 3 development happened on `goal3/supervision-orchestration`, branched from
  `dev`. `main` and the Task Board repository were not modified.
- Removing the plugin leaves no route registered (the route is disposed through
  `ctx.effect`), so a later re-activation does not collide.
