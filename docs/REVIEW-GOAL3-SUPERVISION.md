# Independent review — GOAL 3 supervision / UI

Branch `goal3/supervision-orchestration`, working tree at review time (HEAD `5acd3b5` plus
uncommitted GOAL 3 changes; the review targets were last modified in `47f34c0` and the later
commits `ad4dccf`/`0964333`/`c7b55cc` touch host/routing/docs only, so every finding below was
re-verified against the current tree). Reviewer did not write this code; every claim below was
checked against the code and, where executable, against a test.

- **Scope**: `src/supervisor/projection.js`, `src/contracts/model.js`, `src/board/view.js`,
  `src/board/interaction.js`, `src/client/core.js`, `src/client/app.js`, `src/client/ui/*`,
  generated `src/client.js`, and the supervision tests.
- **Method**: read the modules, then break them with pure-function experiments and two review
  test files (`tests/review-supervision-behaviour.test.js`,
  `tests/review-supervision-artifact.test.js`). No `src/**` file was modified and
  `src/client.js` was **not** regenerated (it was rebuilt in memory and diffed instead).
- **Baseline before this review's files**: `node --test tests/` → 264 tests, 264 pass, 0 fail.

## Verdict

**No P0.** The validated UX is structurally preserved (per-project trees, individual cards,
parent/child branches, collapsible subtrees, running ring, yellow waiting card, green unread
mark, old history hidden, single click = last answer, double click = open, mobile open button,
keyboard, persisted read state). `src/client.js` is byte-identical to the concatenated modules
and contains no `innerHTML`/`eval`.

**5 P1s block "status/preview honesty"** (the two non-negotiables of GOAL 3): a failed turn can
be shown as a green unread result, a native aborted turn is shown as finished, and a partial
answer can be labelled final on two fallback paths. **13 P2s** cover ack coverage gaps, model
history provenance, a doc/contract conflict, a spec conflict, two weak tests and a client
robustness gap.

The red tests in the full suite at review time are **not from this review**: they belong to the
backend reviewer's concurrent files (latest run: 1 failure, `FINDING R9`). This review's 13
reproductions are `todo` tests, so they report their assertion failure without turning the suite
red (counts below).

## Findings

| ID | Sev | Area | Location | Finding | Reproduction |
|---|---|---|---|---|---|
| S1 | **P1** | Status | `src/supervisor/projection.js:228-232` | A native-only `aborted`/`blocked` turn end becomes `finished_read` ("Terminé"), not `idle` as `docs/ARCHITECTURE.md:72-73` states. | `tests/review-supervision-behaviour.test.js:264` |
| S2 | **P1** | Status | `src/supervisor/projection.js:196-204` (cond. at `:200`) | A failure the host missed (restart: stale host `turnEnd` `completed`, native `lastTurnEnd` `error`) is hidden: the card becomes a green `finished_unread` result instead of `failed`. | `:271` |
| S3 | **P1** | Status | `src/supervisor/projection.js:210-217` | A turn end whose kind is `unknown` (host fallback at `src/host/index.js:521-523`) or a recovered error (`recoveredAt`) becomes `finished_unread` with `unread:true` — a green pill for a turn that never completed. | `:278` |
| V1 | **P1** | Preview | `src/supervisor/projection.js:475-484` (`final: true` at `:481`) | The native `turnOutline` response of an errored/aborted turn is labelled `final:true`; the panel shows it as "last line of the final answer". Only the host-captured path checks the turn-end kind. | `:243` |
| V2 | **P1** | Preview | `src/supervisor/projection.js:485-488` (`final: true` at `:487`) | An assignment checkpoint (`lastText` = last mid-turn assistant segment) is labelled `final:true` when the assignment failed/was interrupted and no host `turnEnd` exists. | `:251` |
| M1 | P2 | Model | `src/supervisor/projection.js:374` + `src/client/core.js:150-156` | A board assignment route change is recorded in the card's model history as `reason:'model_change', source:'native'`, and reverting when the assignment disappears adds a second fake native change. | `:310` |
| M2 | P2 | Model | `src/supervisor/projection.js:319-341` | Documented precedence is "injected/native first, then the assignment"; the code applies the assignment first and an injected resolver's `null` falls back to the assignment. A later native model change is invisible while an assignment exists. Existing test `tests/supervision-identity.test.js:68-84` asserts the opposite of the comment. | `:319` |
| R1 | P2 | Read | `src/supervisor/projection.js:200-204`; `src/host/index.js:1950` | Native-only failures hard-code `_seen:false`; the host persists `acks[id].lastTurnEnd` but the projection never reads it, so such a card stays on the attention view forever (only a browser-local dismiss hides it). | `:286` |
| R2 | P2 | Read | `src/supervisor/projection.js:219-227` | Native `completionUnread` is only acknowledged when `seenAt >= updatedAt`; a row without `updatedAt` can never be cleared (green pill sticks). | `:294` |
| R3 | P2 | Read | `src/supervisor/projection.js:173-186` (`_seen` at `:185`) | An interrupted assignment with neither `endedAt` nor `startedAt` can never be `seen`, even after a persisted ack. | `:302` |
| V3 | P2 | View | `src/board/view.js:25-39`, `:112-121` | An archived session that is `finished_unread`/`failed`/`running` is still shown on the default attention view, although the module's own policy (`:6-12`) and the "History" drawer call archived sessions history. | `:326` |
| G1 | P2 | Status | `src/supervisor/projection.js:152-156`; `src/host/index.js:457-469` | `gone` is a permanent, never-reconciled tombstone (bounded to 500/120 entries) and outranks a **live running row**: a resurrected/relisted session id stays `unknown` forever. | `:335` |
| C1 | P2 | Client | `src/client/core.js:211-220`; crash at `src/supervisor/projection.js:604` | Any JSON object is accepted as host state: `{"hello":1}` wipes `acks`/`turnEnd`/`mode` (green pill and statuses reset), and `{"assignments":{}}` makes `getSnapshot()` throw inside React's render path. The comment claims both frame paths validate. | `:344` |
| U1 | P2 | UI | `src/client/ui/card.js:107` | `recentlyFinished` is emitted as `data-recent` but no CSS rule or component consumes it: the "recent unread" view flag has no visual effect, and the green mark is not recency-scoped. | grep `data-recent` → only `card.js` |
| D1 | P2 | Docs/UX | `docs/ARCHITECTURE.md:82-84` vs `src/board/interaction.js:60-64`, `src/client/ui/strings.js:120,235` | Docs say Enter/Space = preview and Shift+Enter = open; code has Enter = open, Space = preview, no Shift+Enter handling (the UI hint matches the code, not the doc). | `tests/review-supervision-behaviour.test.js:152` |
| T1 | P2 | Test | `tests/supervision-identity.test.js:293-310` | The "linear on a deep chain" test only asserts `< 1500 ms`; a quadratic upward walk on the same 2000-node fixture takes ~49 ms, so the test cannot detect the regression it exists for. | `tests/review-supervision-artifact.test.js:109` |
| T2 | P2 | Test | `tests/board-view.test.js:192-198` | The "only the running mark animates" test counts `/animation:\s*dab-/` lines; a second animation declared with `animation-name:` keeps the test green. | `tests/review-supervision-artifact.test.js:88` |
| X1 | P2 | Spec | `src/supervisor/projection.js:189-193` | Spec conflict, needs a decision: the review brief requires the green pill to "never disappear by eviction", but a catalog-only child (runtime row gone) is `unknown` (pill gone), which `docs/ARCHITECTURE.md:70-72` explicitly documents as correct. | manual: catalog-only child with `turnEnd` |

Severity key: **P0** = ship-blocking/security/data loss (none), **P1** = violates a stated
non-negotiable rule (status/preview honesty, validated UX), **P2** = robustness, contract/doc
conflict, or test-quality.

## P1 detail

### S1 — native `aborted`/`blocked` becomes `finished_read`

`classifyStatusDetailed` checks `INTERRUPTED_TURN_KINDS` only for a **host-recorded** turn end
(`:210-213`). The native fallback (`end === null`, native `mobilePushLifecycle.lastTurnEnd`)
falls through to `:228-232` and returns `finished_read` for *any* non-error reason, including
`aborted`, `blocked`, `cancelled`, `unknown`.

```
native-only lastTurnEnd=aborted  -> finished_read  reason=native_history:aborted
native-only lastTurnEnd=blocked  -> finished_read  reason=native_history:blocked
```

`docs/ARCHITECTURE.md:72-73` is explicit: "`aborted` and `blocked` turns are `idle` with an
explicit reason, never `finished`". The host path is correct; only the native path is not.
Impact: after a restart (or when the host missed the event), a user-cancelled/blocked turn
shows a grey "Terminé" card. Fix direction: reuse the same kind switch in the native branch
(`aborted`/`blocked` → `idle`, unknown kind → not `finished_read`).

### S2 — a missed failure is shown as a green unread result

The native error branch is gated by `(end === null || end.recoveredAt !== undefined)` (`:200`).
When the host has a **stale** `completed` turn end (persisted before a restart) and the runtime's
last turn ended in `error` during the host's downtime, the native error is ignored and the card
is classified from the stale completed end → `finished_unread` (green, `unread:true`).

```
host turnEnd {at: NOW-90s, kind:'completed'} + native lastTurnEnd {reason:'error'}
-> finished_unread   (expected: failed)
```

The native fallback exists precisely for the "host missed the event" case
(`:200-204` comment), so preferring a stale host end defeats it. Fix direction: when the native
last turn end is an error and the host end does not prove a later completion, prefer `failed`
(conservative); or timestamp the native fact.

### S3 — `unknown` / recovered turn ends become `finished_unread`

`:210-217` treats every host turn end that is not an error or an interrupted kind as a
completed result. Two cases are not completions:

- `kind: 'unknown'` — the host's own fallback when it cannot read `reason`
  (`src/host/index.js:521-523`). The preview (`:465`) and `recentlyFinished` (`:697`) both
  exclude `unknown`, so the panel says "no final answer yet" while the card shows a green
  "unread result".
- `kind: 'error'` with `recoveredAt` — the failure branch is skipped and the card is shown as a
  green unread result (there is no completed turn).

```
host turnEnd {kind:'unknown'}                      -> finished_unread (unread:true, preview.final:false)
host turnEnd {kind:'error', recoveredAt: NOW-1s}   -> finished_unread
```

Fix direction: only `completed`-class kinds (not `unknown`, not a recovered error) may produce
`finished_read`/`finished_unread`; otherwise `idle` (or `failed` for the recovered error until a
new turn completes).

### V1 — errored turn outline labelled final

`previewOf` correctly marks a **host-captured** segment `partial` when the turn-end kind is
error/aborted/unknown (`:460-473`). The outline fallback (`:475-484`) has no such check: it
returns the last non-open outline response with `final:true`. Because `running` is false after a
failure, the errored turn's own partial response is no longer "open" and is returned as final.

```
turnOutline [{turn:1, response:'I started the refactor and the provider failed'}]
+ turnEnd {kind:'error'}
-> preview {final:true, partial:false, source:'outline'}   status: failed
```

`docs/ARCHITECTURE.md:75-78`: "only a segment that closed a completed turn is `final`; a segment
from an errored, aborted or unknown turn is `partial`". The panel shows this text under "last
line of the final answer". Fix direction: pass the turn-end kind into the outline branch and mark
it partial (or skip the current turn's entry) when the last turn did not complete.

### V2 — checkpoint labelled final after a failed launch

The third preview source (`:485-488`) returns `assignment.checkpoint.lastText` with
`final:true` whenever the session is not running. `lastText` is the last captured assistant
segment (`src/host/index.js:1477`), i.e. a mid-run snapshot used for handoff, and the assignment
may be `failed`/`interrupted`/`stopped`.

```
assignment {status:'failed', checkpoint:{lastText:'half done, calling a tool...'}} (no turnEnd)
-> preview {final:true, source:'checkpoint'}   status: interrupted
```

Fix direction: a checkpoint is never a final answer; expose it as `partial` (or as a separate
`checkpoint` field the panel renders as "handoff snapshot").

## P2 detail (short)

- **M1 model history provenance** — `resolveNodeModel` returns the assignment model; the store
  feeds that into `trackModelChange`, whose entry is hard-coded `source:'native'`. Result:
  `p/m1 → backup/m2 (model_change, native)` appears in the card's "route changes" for a board
  route switch, and when the assignment record disappears the chip reverts and logs
  `backup/m2 → p/m1` as another native change. Fix: record the resolved source on the entry
  (`source: model.source`) and do not treat an assignment↔native transition as a native model
  change.
- **M2 model precedence contract** — `resolveNodeModel`'s own doc (`:319-322`) says
  injected/native first, assignment second, and that an injected resolver's `null` means
  "unknown" with no fallback; the code applies the assignment first (`:336-340`) and falls back to
  it. Consequence: while a session has any assignment record, a real `model/selection` change
  never updates the chip or the history. `tests/supervision-identity.test.js:68-84` locks the
  implementation, not the documented contract — pick one and align doc + code + tests.
- **R1/R2/R3 ack coverage gaps** — three inputs can never be acknowledged: (a) native-only
  failures (`_seen:false`; `acks[id].lastTurnEnd` written by the host but never read);
  (b) native `completionUnread` without `updatedAt`; (c) interrupted assignments without
  `endedAt`/`startedAt`. `docs/ARCHITECTURE.md:53-55` says both `failed` and `interrupted` are
  acknowledged by the persisted read cursor. Consequence: a card pinned on the attention view
  (R1 is permanent; the others until the row/assignment changes). Fix: derive `seen` from the
  ack cursor even without a timestamp (e.g. `acks[id].seenAt >= acks[id].lastTurnEnd` when the
  native fact is the only end), and treat "ack exists and no newer activity" as read.
- **V3 archived attention** — `isAttention` ignores `archived`, and `includedByFilter` checks
  `isAttention` before the archived guard, so an archived unread/failed/running session is shown
  on the default view. Fix: archived nodes are history for every filter except `all`/search.
- **G1 gone tombstone** — `gone` is written on `session/disposed`/`api-session/removed` and never
  expired or reconciled; priority 1 outranks a live running row. Fix: ignore a `gone` entry older
  than the row's `updatedAt`, or clear it when the id is listed again.
- **C1 client robustness** — `applyStreamFrame` accepts any object as host state. A valid JSON
  frame `{"hello":1}` replaces the state (mode/acks/turnEnd lost → the card flips from
  `finished_read` to `idle`); `{"assignments":{}}` throws inside `getSnapshot`
  (`for (const assignment of hostState.assignments ?? [])`, `projection.js:604`), i.e. inside
  React's render. Fix: validate the frame shape (arrays for `assignments`/`proposals`, object for
  `acks`/`turnEnd`/`previews`) and keep the previous state on a malformed frame; make
  `buildProjection` tolerant of non-array `assignments`.
- **U1 dead view flag** — `data-recent` is set on the card but no selector uses it; the green mark
  is driven by `status`, not by `recentlyFinished`. Either style the flag (the brief's "green pill
  for a recent unread result") or drop the attribute and keep the flag as data only.
- **D1 click-semantics doc drift** — the doc and the code disagree on Enter/Shift+Enter; the
  in-product hint (`keyboardHint`) matches the code. Update `docs/ARCHITECTURE.md:82-84` or the
  arbiter.
- **T1/T2 test quality** — see "False-positive tests" below.
- **X1 spec conflict** — the brief says the green pill must not disappear by eviction; the
  implementation (and `ARCHITECTURE`) says a missing runtime row is `unknown`. This is a product
  decision, not a code bug; record it.

## Non-regression tests added (passing, 14)

`tests/review-supervision-behaviour.test.js`
- `:61` age never produces running/finished; `gone` wins over a stale turn end.
- `:73` board ack clears the unread result; a failure stays visible until acked.
- `:90` model identity: unknown stays unknown, an assignment only decorates its own session,
  one card per session.
- `:106` `trackModelChange` bounded per session (8) **and** per memory (512) — the memory bound
  was untested before.
- `:121` filiation: depth-3 chain, orphan and cycle flagged roots, no re-parenting.
- `:142` host preview of error/aborted/blocked/unknown turns is partial, never final.
- `:152` click arbitration: single click waits, double click opens exactly once, Space previews,
  Enter opens.
- `:181` store lifecycle: `destroy()` closes the EventSource, unsubscribes the native sources
  and stops notifying (the existing `__listenerCount` helper was never used).
- `:214` a 200-notification native storm is coalesced into exactly one notification and one
  projection rebuild (no test existed for the 200 ms window).

`tests/review-supervision-artifact.test.js`
- `:62` `src/client.js` is byte-identical to the concatenated current modules (rebuilt in
  memory with the exact `scripts/build-client.mjs` transform) and contains no surviving
  `export`.
- `:69` no `innerHTML`/`dangerouslySetInnerHTML`/`eval(`/`new Function`/`document.write` in the
  bundle or in any module.
- `:82` the reviewed module list equals the build list.
- `:88` CSS weakness probe (passes, demonstrates T2).
- `:109` deep-chain threshold probe (passes, demonstrates T1).

13 reproductions of the findings are declared `{ todo: ... }` (`:243`–`:344`): they execute,
report their assertion failure with the expected/actual values, and keep the suite green until
the finding is fixed. Remove the `todo` flag when fixing.

## False-positive tests (requirement 8)

1. **T2 CSS** — `tests/board-view.test.js:192-198` asserts exactly one line matches
   `animation:\s*dab-` and that the reduced-motion block disables the running ring. Mutating
   `styles.js` by adding `animation-name: dab-pulse` to another rule keeps both assertions green
   (verified in `review-supervision-artifact.test.js:88`). A mutation that ships a second
   animated element is invisible to the test.
2. **T1 deep-chain perf** — `tests/supervision-identity.test.js:293-310` asserts only
   `elapsed < 1500`. The old quadratic per-node upward walk on the same 2000-node fixture runs
   in ~49 ms (measured; `review-supervision-artifact.test.js:109`), so reverting to O(n²) leaves
   the test green. A meaningful guard needs a ratio between n and 2n (or an operation count),
   not a wall-clock ceiling 30× above the baseline.
3. **Preview honesty tests** — `tests/projection.test.js:177-191` covers only the host-captured
   preview. The outline and checkpoint fallbacks (V1/V2) are untested, which is why the suite is
   green with two P1 preview bugs.
4. **Assignment-first model test** — `tests/supervision-identity.test.js:68-84` asserts the
   implementation (assignment wins even when a native selection exists) while the function's own
   contract says native-first. The test passes for the code, not for the documented rule (M2).
5. **SSE validation test** — `tests/client-core.test.js:174-186` only sends invalid JSON / `42`;
   the "same validation on both paths" claim is untested for a valid JSON object, which is the
   failing case (C1).

## What I tried in the clean areas

- **Status precedence**: built a truth table of every input (gone, no row/live/assignment,
  pendingInteraction, running, recovering, terminal-negative assignment, turn-end error,
  native-only error, agentAvailable:false, acked/unacked turn end, native completionUnread,
  native history, no signal) and compared it with `docs/ARCHITECTURE.md:30-47`. Order matches the
  doc; the divergences are the native paths S1/S2/S3 and the ack gaps R1-R3. Age/`updatedAt`
  never produced `running`/`finished` in any probe.
- **Model identity**: unknown stays `{provider:null, model:null, source:'unknown'}`; a second
  card is impossible (identity = session id, catalogs dedupe); an assignment never leaks to
  another session id; `trackModelChange`/`modelHistoryOf` are bounded and idempotent. The issues
  found are provenance (M1) and precedence (M2).
- **Filiation**: depth-3 chains render under one root; orphan keeps its `parentId` and becomes a
  flagged root; a 2-cycle is broken at the smallest id independent of input order; self-parent is
  a one-node cycle; two catalogs claiming one child give one card, the smallest parent and
  `parentContested`; a row/catalog disagreement keeps the row parent and flags the catalog
  claimant; linking is linear (the O(n) colouring walk is correct — only its test is weak, T1).
- **Read state**: board ack → `finished_read`; failed stays `failed` with `seen:true`; native
  viewing ack path inspected (`app.js:145-160`) and is guarded by an activity key; ack state is
  persisted host-side. The gaps are R1-R3 and the X1 spec conflict.
- **Preview (host path)**: a mid-turn segment while running is not final; an errored/aborted/
  blocked/unknown host turn end yields `partial:true`; markdown stripping (`lastUsefulLine`) is
  correct. Only the fallback paths are dishonest (V1/V2).
- **Interactions**: arbiter timers are cancelled on double click and on unmount (`app.js:195`);
  quick-open/branch buttons stop propagation; keyboard Enter/Space handled on the card only
  (`event.target === event.currentTarget`); open guard drops a duplicated open; mobile layout is
  a container query on `.dab-root` (set up at `styles.js:13`), the quick-open button is visible on
  coarse pointers (`styles.js:142`), and the inspector has a full-width mobile variant. The only
  issue is the doc drift D1.
- **Store lifecycle**: `destroy()` clears the pending notify timer, unsubscribes native sources,
  closes the stream and clears listeners (now tested); notifications are coalesced to one per
  window (now tested); `start()` is idempotent (`bound` guard) and SSE handlers are not duplicated.
  The gap is frame validation (C1).
- **Bundle integrity**: rebuilt in memory → byte-identical (175 613 bytes, 13 modules); module
  order matches the dependency order; no ESM leftovers; no `innerHTML`/`eval`.
- **CSS**: exactly one shorthand animation, on the running ring only; `prefers-reduced-motion`
  disables it and removes card/inspector transitions; the new status marks use `--dsw-alias-*`
  tokens with fallbacks; mobile rules are scoped to the `dab` container. Only the animation test
  is weak (T2).

## Full suite (real counts, review time)

`node --test tests/` while the other reviewers were still editing their own files:

```
latest:  tests 311 · pass 294 · fail 4 · todo 13 · cancelled 0 · skipped 0   (exit 1)
earlier: tests 310 · pass 296 · fail 1 · todo 13
```

- Every red test is in the backend reviewer's concurrent files
  (`tests/review-backend-invariants.test.js` FINDING R9, `tests/review-backend-policy.test.js`
  FINDING R5/R6/R8); those files were being modified under the shared working tree, so the
  counts move between runs. They are outside this review's scope.
- This review's files alone: `node --test tests/review-supervision-behaviour.test.js
  tests/review-supervision-artifact.test.js` → **27 tests: 14 pass, 13 todo, 0 fail** (stable
  across runs).
- Baseline before this review's files: 264/264 pass.

Note: the two review test files were picked up by another agent's `git add -A`/commit while the
review was running; this reviewer never ran `git add`, `git commit`, `git stash` or `git switch`
(this document is still untracked).

## Limits

- No live DSH runtime was used: the native projection shapes (`modelSelection`,
  `turnOutline`, `mobilePushLifecycle.lastTurnEnd`, `subagentCatalog`, `completionUnread`,
  `retainedBy`) are taken from the fixtures and the code's documented contract, not from a
  running 0.2.2-rc.1 client.
- React/DOM behaviours (listener cleanup on panel unmount, ResizeObserver, actual mobile
  rendering, ack-on-native-view end to end) were inspected in code and covered indirectly
  (store lifecycle, pure arbiter, CSS container query); they were not exercised in a browser.
- Host-side orchestration/lease/routing code is out of scope (covered by the backend reviewer).

## Post-review status (Lead, after this review)

The independent reviewer's findings were addressed in the branch (commit
`47f34c0` + the supervision reactivation):

- **5 P1 fixed**: native-only `aborted`/`blocked` → `idle`; a native failure wins
  over a stale completed host end; only a `completed` turn end can be a green
  unread result (`unknown`/`recovered`/`max-tokens` → `idle` with a reason); the
  native `turnOutline` of an errored/aborted turn is `partial` and attributed to
  its own turn; a failed/interrupted assignment checkpoint is `partial`.
- **P2 fixed**: native-only failures and `completionUnread`/`interrupted` records
  are ackable without a row `updatedAt`; assignment route changes are no longer
  recorded as native model history; archived sessions are never "attention";
  a live row beats a stale `gone` tombstone; SSE/`/state` frames are shape
  validated (a valid-JSON non-state object is ignored, and a non-array
  `assignments` cannot break the projection).
- **M2 decided (not a bug)**: the board assignment model WINS for a board-owned
  card (it is the route the board created and may have failed over); native
  `modelSelection` is the source for native sessions. The DOC was wrong and now
  states the chosen precedence; the review's todo was replaced by a `DECISION`
  test that pins both directions.
- **X1 decided**: the green mark is a status fact (unread completed turn); it
  never disappears by journal eviction, but a session whose RUNTIME ROW is gone
  is `unknown` (documented in ARCHITECTURE). The two are different facts, not a
  contradiction.
- **U1 accepted as a P2 gap**: `data-recent` is emitted but no CSS consumes it
  yet; documented in ARCHITECTURE rather than inventing a new visual.
- **D1 fixed**: ARCHITECTURE now documents the ACTUAL keyboard semantics
  (Enter = open, Space = preview — matching `interaction.js`, the UI hint and
  `tests/interaction.test.js`).
- **T1/T2** remain weak spots of the two ORIGINAL tests; the reviewer's artifact
  probes (`tests/review-supervision-artifact.test.js`) now fail if the bundle
  diverges from its modules or if the CSS/perf assumptions regress.

**Counts after the fixes:** `node --test tests/` → **315 tests, 315 pass, 0 fail,
0 todo**; the only remaining review markers are gone. `src/client.js` is
regenerated and byte-identical to the concatenated modules (artifact test green).
