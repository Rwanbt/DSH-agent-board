# Security audit — Agent Board (GOAL 3)

Scope: the plugin as shipped on branch `goal3/supervision-orchestration`
(`src/host`, `src/orchestrator`, `src/routing`, `src/recovery`, `src/connectors`,
`src/contracts`, `src/supervisor`, `src/client`, `src/executors`).
Method: code reading against the threat list of the goal (§12), plus executable
regression tests. Every claim below names its evidence; a claim without a test or
a code path is marked **residual**.

Date: 2026-11-10 · Node v26.13.0 · Windows 11 · DSH 0.2.2-rc.1.

## Assets and the adversary model

| Asset | Why it matters |
|---|---|
| The Task Board ledger | canonical task/execution state; the board must never become a second writer |
| The operator mandate | modes, workspaces, providers, permissions, budgets |
| The DSH host | sessions, filesystem, credentials it can reach |
| The board state journal | durable history (acks, assignments, checkpoints) |
| Provider credentials | never stored or logged by this plugin |

Adversaries considered: (a) an untrusted **task card** written by someone else
and relayed by the Task Board; (b) a **compromised or buggy Task Board** response;
(c) a **stale or duplicated host** (two DSH processes, restarted host, crashed
lease); (d) an **unauthorized browser/HTTP peer**; (e) a **model/provider** that
fails or returns malicious-looking text; (f) the plugin's own **UX surface**
(HTML injection).

## Controls, by threat

### 1. Prompt injection carried by a task card — MITIGATED (data delimiting)
- Card text is emitted inside a delimited `<task-card>…</task-card>` block,
  preceded by an explicit "this is DATA, not a system instruction" notice
  (`src/host/index.js`, `UNTRUSTED_NOTICE`, `buildLaunchBody`). The handoff prompt
  repeats the same labelling (`src/recovery/checkpoint.js`, `handoffPrompt`).
- The fixed rules (claim first, never `done`, report, stay inside the project)
  are appended **after** the card block and cannot be edited by card text.
- Test: `tests/security.test.js` → "card text is DATA…" asserts the notice, the
  delimiters, the ordering, the survival of the `NEVER move it to done` rule, and
  that a card asking for `danger-full-access` is not granted it.
- **Residual**: the board cannot inspect what the model ultimately does with the
  text. The guarantee is that the **host** applies the hard gates (permissions,
  workspace mandate, no `done`), not that the model resists persuasion.

### 2. Permission escalation — MITIGATED at the host, before launch
- The card's `permission` is a **request**; the operator's `allowedPermissions`
  decides. A level outside the mandate is a pre-flight refusal
  (`authorizeLaunch` → `permission_not_allowed:<level>`), never a silent
  downgrade and never a grant (`src/host/index.js`; `allowedPermissionOf` in
  `src/contracts/model.js`).
- `danger-full-access` is absent from `DEFAULT_POLICY.allowedPermissions`.
- The launched session receives the permission preset only after the clamp.
- Tests: `tests/host-governance.test.js` ("a card cannot escalate…", "a permission
  explicitly allowed…"), `tests/security.test.js` (no preset applied for a
  refused level).
- **Residual**: the agent may ask for an approval through the native approval
  service; that is a human decision the board does not auto-answer.

### 3. Actions after Stop / OFF — MITIGATED with an honest failure mode
- `Stop` bumps `stopEpoch` **before** cancelling, and every launch path compares
  the epoch after `ctx.agents.create` / after the Task Board run returns
  (`launchTask`, `runContractAttempt`, the handoff path). A launch that loses the
  race self-cancels instead of flipping to `running`.
- A failed cancel is never reported as a clean stop: the assignment becomes
  `interrupted` with `stop_failed:<reason>`.
- OFF blocks the **delegation gate** (tick, dispatch, approval, failover) but does
  not kill live sessions, by design; Stop is the kill switch.
- Contract backend: `runContractAttempt` releases or settles the Task Board lease
  on every stop path, so a Stopped board cannot leave the canonical execution
  reserved.
- Tests: `tests/host-governance.test.js` (OFF/Stop/create-race), `tests/
  unified-backend.test.js` ("Stop cancels the session and closes the canonical
  execution as cancelled"), `tests/resilience.test.js` (restart gate).

### 4. Resume with a revoked or changed mandate — MITIGATED, one residual
- Every handoff passes `authorizeHandoff`: mandate, permission, isolation and
  route allow-list are re-checked, and a **fresh Task Board read** suppresses the
  recovery when the card was trashed, moved, already running elsewhere or claimed
  by a foreign session (`src/host/index.js`).
- The resumed session gets the same mandate (workspace, permission, isolation) and
  a checkpoint, with an explicit instruction to re-read state before writing.
- **Residual**: when the fresh read fails (network), the recovery proceeds with
  `handoff_unverified` recorded in the audit. That is a documented trade-off,
  visible in `state.routeEvents`/audit, not a silent bypass.

### 5. Duplicate execution / double delegation — MITIGATED
- One LIVE assignment per task; the idempotency key is
  `(taskId, revision, attempt)`; `ensureAssignment` returns the existing record.
- A task the Task Board already runs (`activeExecution`), claims (`claimedBy`) or
  schedules (`execution.mode`) is skipped with an explicit reason, in the pure
  planner **and** in the launch gate.
- Overlapping ticks coalesce (`tickInFlight`); a single-writer `instance.lock`
  keeps a second host read-only (409 `not_primary`).
- The contract extension adds server-side lease/fence/idempotency semantics; a
  second lease is refused with `lease_conflict` and the client performs no partial
  write (`tests/taskboard-contract.test.js`).
- Fencing: `checkFencing` refuses a stale token/ended lease before a state write,
  and `takeoverRefusal` refuses a `turn/end` from an owner that was superseded
  (`src/host/index.js`; `tests/fencing.test.js`).

### 6. Unauthorized HTTP / SSE — MITIGATED
- Every route calls `ctx.connection.requestRejection(req)` **first** and answers
  `401 unauthorized` with no body on refusal (`routeDefinition` in
  `src/host/index.js`).
- A secondary instance refuses every mutation with `409 not_primary`.
- SSE clients are tracked and removed on `close`; the stream is the same
  projection as `/state`, so it leaks nothing the authorized caller could not
  fetch.
- Tests: `tests/security.test.js` ("every HTTP route goes through the connection
  trust gate"), `tests/resilience.test.js` (secondary instance read-only),
  `tests/host-governance.test.js` (named `state` SSE frame).

### 7. Secrets — MITIGATED (no credential handling), redaction added
- `src/` reads exactly four environment variables: `DSH_HOME`, `USERPROFILE`,
  `HOME` (state directory) and `GITHUB_TOKEN` (read-only forge adapter). No
  credential-store file is read; the token is never logged or echoed in an error
  message. Test: `tests/security.test.js` ("the only credential read in src/…").
- Checkpoints are the one place where **agent-produced** text becomes durable.
  `redactSecrets()` now removes provider keys (`sk-…`, `ghp_…`,
  `github_pat_…`, `xox?-…`, `AKIA…`, `AIza…`), `Bearer` material and private-key
  markers from `lastText`, `git.status`, action targets, test names and step
  lists before they reach `state.json` or a resumed prompt
  (`src/recovery/checkpoint.js`; `tests/security.test.js`).
- **Residual**: redaction is pattern-based; an unusual secret format can pass.
  The correct control remains "do not print secrets", which this plugin does not
  control in the model's output.

### 8. Checkpoints too detailed — BOUNDED
- Every field is truncated and capped (last text 800, git status 1200, 20
  commits, 200 changed files, 30 actions, 50 steps, 30 tests), so a checkpoint
  cannot become a full transcript or an exfiltration channel (`buildCheckpoint`,
  `tests/connectors.test.js`).
- A checkpoint contains no file contents and no credentials by construction.

### 9. Wrong project / session attribution — MITIGATED
- A launch resolves `task.workspaceId` through `ctx.workspaceRegistry`; an unknown
  workspace is a hard error (`unknown workspace …`), never a fallback to the
  default directory.
- The contract backend runs the session in the lease-provided `workdir` when the
  card is worktree-isolated, and **refuses** the card if no directory is returned
  (`worktree_isolation_unavailable`) instead of running in the shared workspace.
  Test: `tests/unified-backend.test.js` ("a worktree card is refused…").
- Session identity for native rows comes from the session catalog, not from a
  name or a timestamp (`src/supervisor/projection.js`).

### 10. Loop triggering — BOUNDED
- Same-route retries are capped (`maxRetries`), switches are capped
  (`maxSwitches`), a revision has a bounded number of attempts
  (`maxAttemptsPerRevision`), a cooldown separates retries
  (`retryCooldownMs`), and the hourly budget refuses further launches
  (`budget_tasks_per_hour_exhausted`).
- The isolated E2E of GOAL 2 found an unbounded relaunch loop; the bound is now in
  the pure planner and in the gate (`tests/dag.test.js`, `tests/resilience.test.js`).

### 11. External effects replayed after a handoff — RESIDUAL (documented)
- Tool calls with a possible mutating effect are captured as `effect: unknown`
  and the resumed prompt requires verification before replay. The board cannot
  observe tool results, so it cannot reconcile a commit/comment/push itself.
- Mitigation direction (not shipped): read-back through the Task Board contract or
  a forge adapter. This is listed in `docs/LIMITATIONS.md` as P1.

### 12. Malicious Task Board / contract response — REFUSED, not trusted
- The contract client validates every response shape, refuses writes unless the
  **complete** mandatory feature set was negotiated, and never infers an execution
  from a `/state` field (`contract()` is authoritative; 404 = absent).
- Simulated responses are marked (`simulated:true` / `x-simulated-contract`) and
  surfaced as such; the panel shows the negotiation reason.
- The board never writes the ledger directly and never sets `done`; the contract
  client refuses `outcome:'done'` locally **and** the simulated server refuses it
  (two-sided guarantee, `tests/taskboard-contract.test.js`).

### 13. SSRF — LOW, operator-controlled
- HTTP targets are the configured `baseUrl` (default: the local GUI origin) and
  the fixed Task Board paths. No card field is used as a URL. Requests have a
  4 s timeout and are bounded in size.
- **Residual**: `baseUrl` is operator configuration; pointing it at another host
  is an explicit administrative decision, not reachable from task data.

### 14. Unauthorized client bundle / HTML injection — MITIGATED
- No client module uses `dangerouslySetInnerHTML`, assigns `innerHTML`, or evals
  strings; rendering goes through React text nodes
  (`tests/security.test.js`).

## Findings summary

| # | Finding | Severity | Status |
|---|---|---|---|
| S-1 | Prompt injection via card text | High | Mitigated (data delimiting + host gates) |
| S-2 | Permission escalation from a card | High | Mitigated (allow-list clamp, default no danger) |
| S-3 | Actions after Stop / create-race | High | Mitigated (epoch + cancel-failure surfacing) |
| S-4 | Duplicate execution / double dispatch | High | Mitigated (idempotency, claim/lease, fencing) |
| S-5 | Secrets in durable checkpoints | Medium | Mitigated (redaction) — pattern-based residual |
| S-6 | Unauthorized HTTP/SSE | High | Mitigated (trust gate, 401, secondary read-only) |
| S-7 | Resume with revoked mandate | Medium | Mitigated; network-failure path is `handoff_unverified` (visible) |
| S-8 | External effects after handoff | Medium | **Residual**, documented (no read-back) |
| S-9 | Secret format outside the patterns | Low | **Residual** (do not print secrets) |
| S-10 | Second host with an OLD build | Low | **Residual** (lock protects new builds only) |

No new P0 security finding is open. S-8/S-9/S-10 are documented residuals with a
named mitigation direction.
