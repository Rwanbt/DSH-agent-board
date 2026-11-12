# Task Board public API v1 — live audit and connector validation

Date: 2026-11-12 (Europe/Paris). Audited read-only against the installed
**Task Board 0.12.0** and implemented as `src/connectors/taskboard-public.js`.

This document separates three kinds of evidence, deliberately:

1. **Observed live** — HTTP probes against the running host, no token.
2. **Verified against the real code** — the client exercised against the *built*
   `dsh-taskboard` service module in an isolated process/temporary ledger.
3. **Verified against a local contract server** — the repo test file
   `tests/taskboard-public.test.js` (in-process `node:http` fixture).

Nothing below claims a live authenticated success that was not observed.

---

## 1. Environment and method

| Fact | Value |
| --- | --- |
| OS / Node | Windows 11, Node.js v26.13.0 |
| Agent Board repo | `D:\App\DSH-agent-board`, branch `feat/agent-board-superagent` |
| Task Board repo | `D:\App\dsh-taskboard`, branch `feat/universal-sync`, HEAD `e6aaece` |
| Task Board version | `0.12.0` (`package.json`) |
| Installed plugin link | `C:\Users\barat\.dsh\profiles\desktop\node_modules\dsh-taskboard` → `D:\App\dsh-taskboard` |
| Running GUI origin | `http://127.0.0.1:62124` (PID 27792) |
| Public API base | `/dsh-taskboard/public/v1` |

Earlier origins from the task brief (`62715`) and from a previous host start
(`56117`) are **not listening** any more (connection refused); `62124` is the
current, authoritative host.

Probe method (PowerShell, no token sent, no token read/printed):

```powershell
$base = 'http://127.0.0.1:62124/dsh-taskboard/public/v1'
Invoke-WebRequest "$base/meta" -SkipHttpErrorCheck
Invoke-WebRequest "$base/projects" -SkipHttpErrorCheck
Invoke-WebRequest "$base/tasks?limit=5" -SkipHttpErrorCheck
```

## 2. Observed live results

| Method | Path | HTTP | Response body |
| --- | --- | --- | --- |
| GET | `/dsh-taskboard/public/v1/meta` | **503** | `{"ok":false,"error":{"code":"public_api_disabled","message":"public API is disabled: configure DSH_TASKBOARD_PUBLIC_TOKEN"}}` |
| GET | `/dsh-taskboard/public/v1/projects` | **503** | same envelope |
| GET | `/dsh-taskboard/public/v1/tasks?limit=5` | **503** | same envelope |

Facts that follow directly from the observations:

- The public API surface **is mounted** in the running 0.12.0 plugin (a missing
  route would be `404`, not this envelope; the built `lib/host/public-api.js`
  contains the same code).
- The surface is **currently disabled**, not merely unauthorized: `503
  public_api_disabled` is returned before the bearer check.
- No token is configured in the **running host process**. This is proven by the
  503 itself: `authorised()` reads `process.env[DSH_TASKBOARD_PUBLIC_TOKEN]` on
  every request, so an inherited token would produce `401` for these unkeyed
  probes, and a valid token would produce `200`. The extra environment checks
  (below) are consistent but not the proof.
- No authenticated read, claim, write, fencing or SSE behavior can be validated
  against the live host in this configuration.

Supporting check (presence only; values were never read or printed):

| Scope | `DSH_TASKBOARD_PUBLIC_TOKEN` present |
| --- | --- |
| current PowerShell process | no |
| Windows user environment | no |
| Windows machine environment | no |

## 3. Which key the Task Board reads, and where

The token is **not** a GUI setting, a profile file, or a repository file. It is
read from the process environment:

| Item | Location |
| --- | --- |
| Env var name | `DSH_TASKBOARD_PUBLIC_TOKEN` — `D:\App\dsh-taskboard\src\shared\public-api.ts:24` |
| Token reader | `token: () => process.env[PUBLIC_API_TOKEN_ENV]` — `D:\App\dsh-taskboard\src\index.ts:314` |
| Service construction | `new PublicApiService({ store, workspaces, now, token })` — `src/index.ts:310-315` |
| Auth check | `authorised()` — `src/host/public-api.ts:180-186`; constant-time SHA-256 + `timingSafeEqual` (`secureEqual`, lines 81-86) |
| Route mount | `pathname.startsWith(PUBLIC_API_PREFIX)` — `src/host/routes.ts:480-486` |
| Installed build | `lib/host/public-api.js`, `lib/index.js` (the plugin `main` is `lib/index.js`) |

There is no fallback source: a grep of `src/` finds `PUBLIC_API_TOKEN_ENV` only
in `src/shared/public-api.ts` and `src/index.ts`. The value is read per request
from the host process' environment, which is fixed at process start — so
changing an environment variable requires **restarting the host**, not just
reloading the page.

## 4. Exact setup procedure

1. Generate a high-entropy secret (32 random bytes, base64/hex). Keep it out of
   the repository, this document, chat and screenshots.
2. Put it in the environment of the process that **launches the DSH host**, not
   in `cordis.yml`, `package.json`, or any repo file:
   - session-scoped (a terminal that then launches the host):
     `$env:DSH_TASKBOARD_PUBLIC_TOKEN = '<secret>'` then start DSH from that
     terminal;
   - persistent user variable:
     `[Environment]::SetEnvironmentVariable('DSH_TASKBOARD_PUBLIC_TOKEN','<secret>','User')`
     then restart the host (and its shortcut/service supervisor) so the new
     process inherits it.
3. **Restart the host.** The running process keeps its original environment;
   the page reload is not enough.
4. Verify, without ever printing the token:
   - unkeyed: `Invoke-WebRequest "$base/meta" -SkipHttpErrorCheck` → expect
     **401** `{"code":"unauthorized"}` (503 means the restart did not inherit the
     variable; 200 means the surface is open without a key, which would be a
     defect);
   - keyed: send `-Headers @{ Authorization = "Bearer $env:DSH_TASKBOARD_PUBLIC_TOKEN" }`
     → expect **200** `{"ok":true,"value":{"apiVersion":1,...}}`.
5. Never echo the token; `describePublicTaskBoard()` only exposes
   `tokenPresent: true/false`.

Why restart is required: `src/index.ts:314` reads `process.env` at request time,
but Windows processes receive their environment when they are created. A
`setx`/User-variable change does not mutate the already-running host.

## 5. Capability matrix — as implemented by 0.12.0

Source: `src/host/public-api.ts` route table (lines 217-251) and handlers.
Every write is bearer-authenticated; every response is
`{ok:true,value}` / `{ok:false,error:{code,message}}`.

| Client method | HTTP | Success | Implemented behavior |
| --- | --- | --- | --- |
| `meta()` | GET `/meta` | 200 | `apiVersion:1`, product `dsh-taskboard`, event vocabulary, features, `donePolicy:'user-only'`, `writePolicy:'explicit'` |
| `projects()` | GET `/projects` | 200 | `[{id,title,path}]` = DSH workspaces |
| `listTasks({status,workspaceId,eligible,limit,cursor})` | GET `/tasks` | 200 | summaries + `next` cursor (offset as string); `limit` clamped 1..100; `eligible=true` = todo, unblocked, all prerequisites human-`done` |
| `task(id)` | GET `/tasks/:id` | 200 | full view incl. dependencies, executions (`managedBy`, `fencingToken`), `allowedActions` |
| `dependencies(id)` | GET `/tasks/:id/dependencies` | 200 | DAG state + prerequisite details |
| `execution(id)` | GET `/executions/:id` | 200 | execution envelope view |
| `events({since,limit})` | GET `/events` | 200 | normalized events ring (2 000), `oldestSeq/latestSeq`, explicit `resync:true` when history is missing |
| `claim({taskId,actor,workspaceId,sessionId,idempotencyKey})` | POST `/executions/claim` | **201** | atomic ledger mutation; `in_progress`+claim; replay by key returns the same envelope for the same actor; another actor/key holder gets `already_claimed`; unmet prerequisites `dependency_blocked`; cross-workspace `forbidden` |
| `attachSession(id,{actor,sessionId,ifFencingToken})` | POST `/executions/:id/session` | 200 | binds the initial session (contract §4.2; the route is `session`, the client method name is `attachSession`); a different session is `version_conflict` |
| `attempt(id,{actor,reason,sessionId,ifFencingToken})` | POST `/executions/:id/attempts` | 200 | closes current attempt `failed`, opens `n+1`, increments `fencingToken`, keeps claim/execution |
| `handoff(id,{actor,fromSessionId,toSessionId,reason,ifFencingToken})` | POST `/executions/:id/handoff` | 200 | transfers session, increments fence; wrong `fromSessionId`/stale fence `stale_execution` |
| `complete(id,{actor,outcome,ifFencingToken,comment?,report?})` | POST `/executions/:id/complete` | 200 | `succeeded` → `in_review`; `failed`/`cancelled` → `todo`; claim released; same outcome replay is idempotent; non-owner `forbidden`; **cannot reach `done`** |
| `interrupt(id,{actor,ifFencingToken,reason})` | POST `/executions/:id/interrupt` | 200 | alias of `complete` with `outcome:'cancelled'` |
| — (not exposed by GOAL6 §4.1) | POST `/executions/:id/report` | 200 | the server supports a separate structured report; the client accepts `report` on `complete()` instead and does not expose a separate method |
| — (not used) | GET `/events/stream` | 200 | SSE exists and requires the bearer header; the v1 client is poll-based and does not consume SSE |

Server-side facts worth keeping explicit:

- `donePolicy:'user-only'` is advertised; no public route can set `done`.
- The server treats `idempotencyKey` on claim as optional; the Agent Board
  client requires it locally (GOAL6 §4.1) because an unkeyed claim cannot be
  replayed after a transport failure.
- `ifFencingToken` becomes **mandatory** on the server as soon as
  `fencingToken > 1` (`checkFence`, `src/host/public-api.ts:404-410`).
- A `managedBy:'board'` (host-driven) execution is refused to the public API.

## 6. Error-code table

Documented server codes (contract §6, implemented in `PublicApiError`):

| Code | HTTP | Meaning |
| --- | --- | --- |
| `public_api_disabled` | 503 | no token configured in the host; whole surface disabled |
| `unauthorized` | 401 | missing/invalid bearer token |
| `invalid_input` | 400 | malformed payload/parameter |
| `not_found` | 404 | unknown task/execution/route |
| `forbidden` | 403 | wrong workspace, non-owner actor, host-managed execution |
| `already_claimed` | 409 | task held by another actor / key belongs to another actor |
| `dependency_blocked` | 409 | prerequisites not human-`done` |
| `version_conflict` | 409 | incompatible state (not todo, already settled, different session) |
| `stale_execution` | 409 | missing/stale `ifFencingToken` |
| `internal` | 500 | internal error, generic message |

Client-local codes (no trusted HTTP envelope):

| Code | Status | Meaning |
| --- | --- | --- |
| `unconfigured` | 0 | missing/invalid baseUrl, missing token, or no fetch implementation; **no request is sent** |
| `invalid_input` | 0 | local guard (e.g. claim without `idempotencyKey`, `done` outcome, malformed argument) |
| `unreachable` | 0 | transport failure (fetch threw) |
| `timeout` | 0 | real `AbortController` timeout (`timeoutMs`, default 4000) |
| `bad_response` | received status | response was not an `{ok,value}` envelope (e.g. malformed JSON with 200) |
| `http_error` | received status | non-2xx response without a usable error code |

Mapping rules in `src/connectors/taskboard-public.js`:

- a documented code in the envelope is passed through **verbatim** (no
  normalization that would lose `dependency_blocked` vs `already_claimed`);
- an unknown code from a newer server is also passed through verbatim;
- when no code is present, the status is mapped as above;
- the token is never present in a result, an error message or a log line; any
  occurrence of the token in a transport message is replaced by `[redacted]`.

## 7. Client implementation notes

`src/connectors/taskboard-public.js` exports:

```js
createPublicTaskBoardClient({ baseUrl, token, fetchImpl?, now?, timeoutMs? })
// => { configured, baseUrl, meta, projects, listTasks, task, dependencies,
//      execution, events, claim, attachSession, attempt, handoff, complete,
//      interrupt }   // every method: {ok:true,value} | {ok:false,code,message,status}

capabilitiesOf(meta)
// => { meta: {state:'available'|'unsupported'|'unconfigured', reason},
//      projects: …, claim: …, attachSession: …, attempt: …, handoff: …,
//      complete: …, interrupt: …, … }
// reasons: null, meta_unavailable, unsupported_api_version:<v>,
// unexpected_product, unsupported_auth, done_policy_not_user_only,
// feature_not_announced:<feature>

describePublicTaskBoard({ baseUrl, token })
// => { configured, baseUrl, tokenPresent }   // no token, ever
```

- **Base URL derivation:** explicit argument only. A bare origin gets
  `/dsh-taskboard/public/v1` appended; an explicit path (reverse proxy) is
  preserved; URL credentials are dropped. Nothing is discovered at import time
  and the module performs no network access on import.
- **Timeout:** one `AbortController` + `setTimeout` per request, cleared in
  `finally`; abort maps to `timeout` (status 0), not to a hung promise.
- **Never throws:** a throwing fetch, a `null` response, malformed JSON, a
  malformed envelope, malformed arguments and an unconfigured client all resolve
  to the error shape. `createPublicTaskBoardClient(null)` is valid.
- **Claim idempotency:** absent/empty `idempotencyKey` is refused locally with
  `invalid_input` (status 0) before any request, tested by asserting the fake
  server request log is unchanged.
- **`now`:** accepted for call-site symmetry; public v1 requests carry no
  client timestamp, so it is not sent.
- **Write safety:** `complete()` refuses `outcome:'done'` locally; capabilities
  only mark writes available when `meta.donePolicy === 'user-only'`.

## 8. Validation evidence

### 8.1 Local contract server (repo tests)

`tests/taskboard-public.test.js` starts an in-process `node:http` server that
implements the documented 0.12.0 surface: bearer auth, envelopes, pagination
cursor, claim idempotency, `already_claimed`, `dependency_blocked`,
`stale_execution`, `fencingToken > 1`, 401/503/500, malformed JSON, delayed
response, unknown codes and soft errors on HTTP 200.

Result:

```text
node --test tests/taskboard-public.test.js
tests 11 / pass 11 / fail 0
```

Covered: success for every client method; pagination; claim replay; local
refusal without an idempotency key; fence required after attempt/handoff;
`done` refusal; 401/503/500/bad_response mapping; real timeout (elapsed < 1.5 s
against a 300 ms server delay plus a 40 ms client budget); unknown-code
pass-through; unconfigured clients do not call fetch; throwing fetch; `null`
fetch response; malformed arguments never throw; token absent from every result,
from `JSON.stringify(client)` and from error messages; no console output.

### 8.2 Real Task Board service module (isolated process)

To avoid claiming more than the live host allows, the client was also run
against the **exact installed build**:

```text
D:\App\dsh-taskboard\lib\host\public-api.js
D:\App\dsh-taskboard\lib\host\store.js
```

with a temporary ledger and a test-only token, in a separate process (no live
host contact, no edit of the Task Board repo). Results:

| Probe | Result |
| --- | --- |
| meta / projects / tasks?limit=2 / task / dependencies / events | all 200 `ok:true` |
| claim (201) | `executionId` returned, task `in_progress`, fence 1 |
| attachSession | 200, same execution |
| attempt | 200, attempt 2, **fence 2** |
| handoff (fence 2) | 200, attempt 3, **fence 3** |
| complete without `ifFencingToken` | **409 `stale_execution`** |
| complete with fence 3 + report | 200, `succeeded`; task then `in_review` |
| claim on a card with an unmet prerequisite | **409 `dependency_blocked`** |
| interrupt | 200, `cancelled` |
| wrong token | **401 `unauthorized`** |
| token in results | none (`tokenLeak:false`) |

This proves the client matches the shipped implementation. It does **not** prove
the running host accepts authenticated requests, because that host has the API
disabled.

### 8.3 Full suite

Two runs were needed because teammates were landing files concurrently. The
first run reported `551 tests / 549 pass / 2 fail`, both failures in
`tests/goal6-superagent-host.test.js`; that same file then passed **3/3 on its
own**, so the red was a concurrency artifact, not a regression from this
module. Once the concurrent edits settled, the final run was fully green:

```text
node --test tests/
tests 551 / pass 551 / fail 0
```

The module's own file is green on its own:

```text
node --test tests/taskboard-public.test.js
tests 11 / pass 11 / fail 0
```

## 9. What could NOT be validated live, and why

| Not validated live | Why |
| --- | --- |
| authenticated 200 responses (meta/projects/tasks) | no token in the running host; probes return 503 |
| 401 behavior on the live host | requires a configured token; deliberately not brute-forced or guessed |
| claim/attach/attempt/handoff/complete/interrupt on live data | writes onto the operator's real ledger were not attempted; API disabled |
| live fencing/idempotency persistence across host restarts | API disabled; covered against the real service module in-process and the contract fixture |
| live SSE `/events/stream` | not used by this client (poll-based); requires a token |
| real project/task contents | not readable without auth; no ledger file was read or written |

No token was guessed, brute-forced, read from a file, or printed. The Task Board
repository was not modified: `git -C D:\App\dsh-taskboard status` stayed clean
on `feat/universal-sync` at `e6aaece`. **No defect was found that blocks the
documented v1 contract**, so no hardening worktree/branch/commit was created in
`D:\App\dsh-taskboard`.
