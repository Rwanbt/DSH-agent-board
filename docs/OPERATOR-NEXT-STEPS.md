# Operator next steps — closing the three external gaps

Everything that does not require a secret is delivered and proven. This page is
the exact checklist for the three remaining operator decisions. Each step is
independent; none of them touches a project repository.

Verify the current state at any time (read-only, tokens never printed):

```powershell
node scripts/verify-live.mjs
```

Expected today: `verdict: "incomplete"`, `taskboardPublic.configured:false`,
`github.configured:false` (or `true` if you already set a repository), and the
real `state.json` summary (`schemaVersion:2`, `scopeMode:none`, L0).

---

## 1. Task Board public API (unlocks live writes + the full chain)

The installed Task Board answers **503 `public_api_disabled`** until a token is
configured. The token is an operator secret: the agent never creates it.

```powershell
# 1) set a User-scoped variable (choose a long random value)
$token = -join ((48..57) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
[Environment]::SetEnvironmentVariable('DSH_TASKBOARD_PUBLIC_TOKEN', $token, 'User')

# 2) fully restart DSH (quit the app; a page refresh is not enough)

# 3) verify (read-only)
node scripts/verify-live.mjs
#    expect: taskboardPublic.configured = true
#            capabilities.claim/unclaim/attach/report/release/settle = "available"
```

Then probe from the board (same result, host-side):

```http
POST /dsh-agent-board/api/v2/integrations/taskboard/probe
```

What becomes possible: real `claim → attachSession → complete` writes against
the installed ledger, on a temporary task you create for the test. The
**execution backend remains `contract`**: the public-v1 client is wired as an
integration + probe, not as the launch lifecycle. Turning that into the default
backend is a separate change that must be validated live first (it touches
lease→attach→settle, Stop and failover).

Rollback: remove the variable and restart DSH. The board immediately reports
`public_api_disabled` again; nothing was migrated.

---

## 2. GitHub writes (already validated on a disposable repo)

Writes are off by default and double-gated:

1. Config: `githubRepository: 'owner/name'` and `allowGithubWrites: true`.
2. Token: `GITHUB_TOKEN` as a **User** environment variable (never in the UI).
3. Mandate: select the project, level **L3** for issue/comment, **L4** for
   `open_pr`, and tick the matching action.

Read-only check first: `node scripts/verify-live.mjs` (`github.configured:true`,
`items` count, `writeEnabled:false` — the verifier never writes).

Live write rehearsal on a **disposable** repository (creates an issue, a comment,
a branch, a PR; never merges; never deletes):

```powershell
$env:GITHUB_REPOSITORY = '<owner>/<disposable-repo>'
node scripts/e2e/github-live.mjs
```

Expected: 11 green assertions, `docs/e2e/GITHUB-LIVE-E2E.json`. Delete the
repository afterwards (§3). **Never point this script at a real project repo.**

---

## 3. Disposable test repository cleanup

`Rwanbt/agent-board-e2e-disposable` is archived/private with its issues and PRs
closed. Deleting it needs the `delete_repo` scope, which the agent must not grant
for you:

```powershell
gh auth refresh -h github.com -s delete_repo
gh repo delete Rwanbt/agent-board-e2e-disposable --yes
```

---

## 4. One real LLM cycle (optional proof)

The desktop profile is `mode:off` with an unconfigured mandate, so no real model
call was ever made on it. To prove the real provider path without authorizing
any work:

1. Cockpit → **Projets**: select one workspace, level **L0** (observe only), keep
   every action unchecked; **Enregistrer** and **Confirmer**.
2. **Super Agent**: start it, add a directive (“observe only, do not act”), then
   run **one cycle** (`POST /superagent/cycle`).
3. Expected: a real model call, a validated assessment, and **zero** launch
   (scope/level refuse); the cycle is recorded in the activity list.
4. Revert: stop the Super Agent and set mode **OFF**.

If the assessment is rejected by the strict validator, the cycle is refused
safely (no effect) — that is a known P1 (see `GOAL6-DELIVERY.md` §10).

---

## 5. Rollback (any time)

```powershell
# stop DSH, then:
Copy-Item "$env:USERPROFILE\.dsh\agent-board\state.json" "state.backup.json"
# reinstall the previous version, then RESTORE the v1 document:
Copy-Item "$env:USERPROFILE\.dsh\agent-board\state.json.v1-backup" `
          "$env:USERPROFILE\.dsh\agent-board\state.json" -Force
# start DSH
```

The host wrote `state.json.v1-backup` automatically before migrating. Restoring
it is **mandatory**: the previous release cannot read schemaVersion 2 and would
overwrite it with defaults (verified). The Task Board ledger is never touched by
an Agent Board rollback.
