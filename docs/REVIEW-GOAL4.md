# Independent review — GOAL 4 (mascots, supervision, Super Orchestrator, Task Board coordination)

- Reviewer: `qa-reviewer` (independent; did not write any reviewed code)
- Branch: `feat/agent-board-mascots-super-orchestrator`
- Base: `905e367` (`goal3/supervision-orchestration`)
- Reviewed state: working tree at 2026-11-11 ~16:04, after `supervision-ui` went
  inactive and the Lead rebuilt the bundle. All GOAL 4 changes are still
  uncommitted (`git status`: 20 modified + new/untracked files).
- Generated bundle: `src/client.js` = 412 548 bytes; all 19 concatenated sections
  match the current source modules.
- Test suite: **407/407 pass, 0 fail, 0 skipped** (`node --test tests/`, ~2.2 s).

## Verdict

**PASS WITH FINDINGS.**

No P0 and no P1 defect was found. The core safety claims hold: the 15+bolt kit is
byte-identical and script-free, role colours never encode status, unknown roles
never get a guessed identity, the supervision node is an honest synthetic layer,
recommendations are permanent proposals, the Task Board adapter is read-only, the
delegation gate is additive to `authorizeLaunch` and refuses before any
lease/session, and depth is read from the journal.

Four P2 findings are worth addressing. Two are ship-blocking for the **docs**
(placeholders + a "branch is clean" claim that is currently false) and one small
but real correctness gap (role-filter validation). The supervision-startup /
coordination-read findings are runtime limitations that should be tracked and, if
cheap, fixed before the commit; they do not invalidate the architectural claim.

> Note on the stale bundle: at 15:49 the suite was 404/405 because
> `supervision-ui` was still editing 8 client modules after the last build. That
> was confirmed as in-progress work (mtimes), not a code defect. After the Lead's
> final rebuild, the artifact-integrity test passes and the suite is 407/407.

## Findings

| id | severity | file:line | evidence | impact | suggested fix |
|---|---|---|---|---|---|
| R1 | **P2** | `src/board/hierarchy.js:87`, `src/client/app.js:40-59`, `src/client/ui/toolbar.js:57` | `normalizeHierarchyFilters` validates `status` and `taskState` against whitelists but accepts **any** non-empty `role` string. Probe: `normalizeHierarchyFilters({role:'not-a-role'}) -> {role:'not-a-role'}`. `DabSelect` falls back to `options[0]` when the value is unknown, so the toolbar shows "Tous les rôles" while the filter still hides every agent. | A stale/corrupt persisted preference (or a future removed role id) empties both views while the toolbar shows no active filter. Contradicts the contract "persisted … with validation and bounds" and the docs/comment claim that unknown values "are dropped on read" (`app.js:40`, `docs/MASCOTS-SUPER-ORCHESTRATOR.md:121,235`). Recoverable via the "Effacer les filtres" button. | Validate `role` against `AGENT_ROLE_IDS` + `GENERIC_ROLE_FILTER` (drop otherwise); add a test with an invalid role. |
| R2 | **P2** | `src/host/index.js:172,252,443,2402-2407`; `src/supervisor/super-orchestrator.js:312`; `src/client/core.js:324` | `liveProjection` starts `null` and is built **only** inside the 15 s `projectionTimer` (`buildProjection(` has exactly one call site). The startup broadcast (`host:443`) and the first SSE frame (`host:2225`) therefore publish `supervision` with `nodes: []` → `counts` 0 and no blocks. After 15 s the projection populates, but the timer only broadcasts when `publishedSupervisionEvents.length` changed; `mergeSupervisionEvents` keeps the length constant at the 50-event cap (verified: before=50, after=50 → no broadcast), and a newly observed agent produces **no** event by design (baseline), so the first populated payload is not pushed. | On a quiet board, `host.supervision` can remain the empty startup payload indefinitely (until a user action causes `touch()`/broadcast). The panel's counters come from its own projection, so the visible counters stay correct, but `workspace.agent`, `delegation.inFlight`, blocks/recommendations and the Task Board state stay stale. API consumers see `at = now` with zero counts while agents exist. | Build the projection once before the first publish (or on first `publicExtra`), and detect event change by newest-id/last-id (or have `mergeSupervisionEvents` return a changed flag) instead of length. Add a host test that a quiet timer tick pushes the populated payload. |
| R3 | **P2** | `src/host/index.js:1560,2040,2359-2366`; `src/client/ui/toolbar.js:127`; `src/client/ui/hierarchy.js:184`; `src/board/hierarchy.js:326` | The coordination model is refreshed only on handoff/tick/approval/dispatch. The default mode is `off`, the timer skips ticks in `off`, the Refresh button only re-fetches `/state`, and `GET /state` never reads the ledger. Consequently `supervision.taskboard.available` stays `false` (and the Task Board state filter never appears) until a tick/launch happens. The UI never renders `workspace.taskboard.available/reason`: the filter is silently absent and the band only reports missing *supervision* (`supervisionUnavailable`), not a missing Task Board read. | Contract B/D require the Task Board absence to be "reported, never silently guessed" and actions disabled *with a reason*. As built, a reachable Task Board is functionally invisible in `off` mode, and an unreachable one is indistinguishable from "no proposals" unless the operator opens the band and reads the `priority` capability reason. | Read the coordination model once at startup (bounded, cached) or allow `/state` to trigger a debounced read; render a band notice from `workspace.taskboard.available === false` with its `reason`; render the task-state select disabled with the reason instead of omitting it. |
| R4 | **P2** | `docs/GOAL4-DELIVERY.md:141,143`; `docs/MASCOTS-SUPER-ORCHESTRATOR.md:213`; `docs/TEST-REPORT.md:8` | The delivery report still contains `COMMITS_PLACEHOLDER` and says "the branch is clean and ready" while `git status` shows 20 modified + untracked paths and no GOAL 4 commit. MASCOTS points to `docs/TEST-REPORT.md` for "the exact count of the final run", but that file (last modified 2026-11-10) still says **315 tests / 315 pass**, while the suite is 407. | The delivered report is internally inconsistent/incomplete and overclaims repository state — exactly the kind of "green check" the docs claim not to hide behind. | After committing, replace both placeholders with the commit list and a verified "clean" statement; update `TEST-REPORT.md` (or drop the reference and point to `GOAL4-DELIVERY.md`). |
| R5 | **P3** | `docs/ARCHITECTURE.md:209-212` | "The same function runs in the host … **and in the panel**, so both compute the same supervision from the same inputs". The panel never calls `buildSupervision`; it consumes `host.supervision` (`src/client/app.js:144-176`). The function is present in the bundle only as a definition (no call site). | Docs overclaim a client-side recomputation / "no second source of truth" guarantee that is implemented by *publishing one payload*, not by running the function twice. | Reword: the pure module is shared and the host publishes the single payload the panel renders. |
| R6 | **P3** | `docs/MASCOTS-SUPER-ORCHESTRATOR.md:125`; `src/client/ui/hierarchy.js:62-66,152-160` | "Status is never conveyed by colour alone." The band/project status counters render a coloured dot plus a bare number; the status name exists only in `title`/`aria-label`, not as visible text. | Sighted users must rely on colour to tell running/waiting/failed counts apart; the accessibility claim is stronger than the implementation. | Add a short visible label (or a legend) for counters, or soften the claim to "status is always exposed to assistive technology via labels". |
| R7 | **P3** | `docs/MASCOTS-SUPER-ORCHESTRATOR.md:106`; `docs/GOAL4-DELIVERY.md:14`; `README.md:45-52` | Docs say the card shows "resolved role/family"; the final card renders the role chip only (family remains in the role tooltip and the inspector), by the Lead's own polish comment (`src/client/ui/card.js:86-88`). README says the `Projets` view is "unchanged" although its cards gained mascots/roles/counts and its layout changed. | Minor documentation drift; a reader looking for a family chip on the card will not find one. | Say "role chip on the card, family in the tooltip/inspector"; say "existing view, unchanged semantics". |
| R8 | **P3** | `docs/CONTRACTS.md:31`; `src/host/index.js:1051` | "Every delegation is gated by `authorizeLaunch` **then** `evaluateDelegation`". The host skips `evaluateDelegation` entirely when `policy.supervision.enabled === false` (documented behaviour in MASCOTS/LIMITATIONS). | Absolute wording is false for the disabled-layer case. | Add "when the supervision layer is enabled". |
| R9 | **P3** | `src/connectors/taskboard-coordination.js:194-206`; `src/supervisor/super-orchestrator.js:538,607` | The coordination task shape deliberately omits `updatedAt`, but the supervisor reads `task.updatedAt` for task blocks and cross-project edges, falling back to `now`. | A Task Board block's `at` is therefore the observation time on every rebuild (it moves), not the fact time; "each block carries … a timestamp" (`MASCOTS:148`) can be read as fact time. `id` stays stable, so events are unaffected. | Either carry `updatedAt` in the coordination task (it is a real ledger field) or name/comment the field `observedAt` for task-sourced blocks. |
| R10 | **P3** | `docs/LIMITATIONS.md:25` | Says the bundle grew to "~405 KB"; actual `src/client.js` is 412 548 bytes after the final fixes. | Stale number in an otherwise precise limitations table. | Update the figure (or say "~410 KB"). |
| R11 | **P3** | repository root `.kit-inspect/` (untracked, not in `.gitignore`) | The approved source kit (32 SVGs + `roles.json` + previews + generator) is still present. The contract says "source, delete after copy". `git add -A` would commit a duplicate of the assets. | Duplicate asset payload in the repo and a second "source of truth" for the kit. | Delete `.kit-inspect/` (as the Lead planned) before committing, or add it to `.gitignore`. |
| R12 | **P3** | `src/client/ui/hierarchy.js:166,183` | The band toggle carries `aria-controls="dab-supervision-body"`, but the body (and its `id`) is `null` when collapsed, so the reference is dangling in the default state. | Some assistive technologies report a broken relationship; the button itself remains usable (`aria-expanded` is correct). | Render the region with `hidden` when collapsed, or drop `aria-controls` and keep `aria-expanded`. |

No findings were found in the P0/P1 classes. For completeness, two P3-level test
gaps are noted under "Tests" below (missing regression tests for R1/R2 and for the
card memo comparator) rather than as defects.

## What I verified (by review scope)

### 1. Fidelity — PASS

- All 32 SVGs under `src/assets/agent-bots/{full,compact}` are **SHA-256 identical**
  to `.kit-inspect/agent-board-svg-15-roles` (32/32; `roles.json` hash equal).
- No `<script`, event handler, `javascript:`, `<image`, `foreignObject`, external
  `href`/`src`, external `url()`, or embedded raster in any SVG (grep and tests).
- 15 role ids + `super_orchestrator_bolt`; the bolt is **not** in `AGENT_ROLES` /
  `AGENT_ROLE_IDS` and is looked up as `super_orchestrator_bolt` while the model's
  `roleId` stays `super_orchestrator` (`agent-roles.js:322-334`; tests).
- Palette: `AGENT_ROLES` colour/gradient/family/shape/description are compared to
  `roles.json` on every run (`tests/agent-roles.test.js:47-67`); the six kit tones
  keep the kit hex values and the four extensions are documented.
- Role colour is **never painted by the client**: no `data-role`/hex rule exists in
  `styles.js`; the only role colour is inside the SVG. Status is a separate
  `data-tone` dot/chip whose palette is the status palette; tests assert a failed
  Worker stays green and the dot colour is separate.

### 2. Role resolution — PASS

- Exact ids (case-insensitive), declared-name aliases, kebab/snake/display forms,
  accents and spacing (`tests/agent-roles.test.js:108-167`); every documented alias
  is checked against its declared role and `raw` is preserved.
- Unknown/empty/non-string values → `roleId:null`, `source:'generic'`, no colour,
  no `src`; the avatar renders a neutral person glyph, not a mascot.
- Model/provider never implies a role: the resolver only reads `role`/`name`;
  projection `role` comes from the declared team-member name; the explicit test
  "a model string is never used to infer a role" passes.
- `in_review` is a Task Board-state tone (`reviewing`) only; an agent whose role is
  Reviewer never becomes "reviewing" by itself (test asserts both directions).

### 3. Supervision honesty — PASS with R2/R3 caveats

- `workspace.synthetic:true`, `id:'workspace:supervision'`, role
  `super_orchestrator`, labelled as the supervision layer in the panel; a real
  agent is exposed only when a declared role resolves to `super_orchestrator`,
  otherwise `null` (`super-orchestrator.js:155-168,371-391`; tests).
- Project orchestrators only for declared `orchestrator`; otherwise `null` and the
  hierarchy shows "Aucun orchestrateur déclaré" (tests + UI).
- Workspace status from real facts only: `off → idle`, Stop/secondary instance →
  `blocked`, otherwise `active`; mode `off` never active. Counts/blocks are
  aggregated from projection/assignment/Task Board facts.
- Recommendations are `status:'proposed'`, `applies:false`, never mutated into the
  Task Board model; unavailable capabilities carry a real reason
  (`capabilityReasons`), and the capability matrix renders them.
- No progress bar/percentage anywhere; activity is the real
  `sessionStats.turns/steps` only.
- Caveats: R2 (empty/stale initial payload, missed push), R3 (Task Board read
  visibility), R9 (block timestamps).

### 4. Delegation safety — PASS

- `launchTask` calls `authorizeLaunch` first, then the gate, and the gate runs
  **before** `acquireLease`, `ensureAssignment`/`state.assignments.push`, session
  creation and Task Board `runTask` (`host/index.js:1041-1131`).
- The five limits are enforced in `evaluateDelegation`: depth, concurrency, sliding
  hour, cross-project and dependency cycle, plus duplicate live assignment,
  mandate/permission/route; every refusal is an explicit reason and is audited.
- A refused launch returns before `recordBudget('task'/'request')`, creates no
  assignment/session/lease; the host integration test asserts `created.length === 0`
  and the audit `delegation_refused` for a budget refusal.
- Depth comes from `assignment.delegation.depth` written at launch; a missing
  record reads as 0, never guessed from a timer/session/parent. A handoff copies
  the same record (`requestedBy:'board:handoff'`) without deepening it and is
  excluded from the hourly count (`previousSessionId`), covered by unit tests and
  the `agent.delegated` event test.
- The super role adds no permission: the permission check reuses
  `allowedPermissionOf`; `danger-full-access` is refused when not granted.
- Refusal reasons are never silently downgraded; `/dispatch`, tick and approval all
  go through `launchTask` (no alternate session-creating path).

### 5. Task Board separation — PASS with R3 caveat

- `taskboard-coordination.js` has no import/fetch/clock; only pure mapping and
  proposal construction. No write method exists; write-oriented kinds return
  `writes_unavailable` with the PROPOSED endpoint, and two independent gates
  (`COORDINATION_CAPABILITIES` false + model advertisement) prevent a forged flag
  from unlocking a write.
- `taskboard.js` additions are read-only fields (`project`, `assignee`, `priority`,
  `milestone`); `priority` is not forged from `urgency`; `claimedBy` is preserved.
- Absent/unreachable/malformed state → `available:false` + reason + empty arrays;
  the Agent Board API keeps answering `/state` and the panel keeps working.
- No `done` transition, no execution/sync emulation, no mock data in a production
  path; the proposal builder returns `applies:false`.
- Caveat: R3 (read cadence + absence not surfaced in the panel).

### 6. Quality — PASS

- Bundle: all 19 sections match current sources; artifact-integrity test, no
  `innerHTML`/`dangerouslySetInnerHTML`/`eval`/`new Function`/`document.write` in
  the bundle or modules; only `<img src="data:image/svg+xml;base64,…">` is used.
- No new dependency: `package.json` diff is three `scripts` entries (`assets`,
  `client`, `gallery`); `node --check` OK on all new/changed modules.
- Strings: 219 fr keys = 219 en keys, zero missing; all 142 `dabT` usages resolve.
  Count helpers enforce singular/plural ("1 projet", "4 agents · 3 affichés",
  "1 tour · 1 étape").
- React memo: `dabCardSignature` covers every prop the card reads, including the
  new `role`, `taskState`, `groupedProject`, project/activity fields and the model
  chip inputs; `arbiter` is compared separately. (No regression test exists for
  this comparator.)
- Bounded: supervision events ≤50, blocks ≤100, recommendations ≤50, tasks ≤200,
  deps ≤100; coordination 500 tasks/1 000 edges; per-task `dependsOn` ≤32; all
  arrays copied, no unbounded growth in the new caches.
- Preferences: additive keys validated on read (status/taskState bounded; `role`
  is the R1 exception); old `state.json` without `supervision` reads as
  `SUPERVISION_DEFAULT`; old `/state` consumes the new fields additively.
- Listeners/timers: no new listener in the client components; new host timers are
  the existing projection timer only, cleared on dispose; the band/select handlers
  are removed on unmount (existing `DabSelect` pattern).
- Reduced motion: the only looping animation is the existing running ring and it is
  disabled under `prefers-reduced-motion`; new CSS adds no animation.
- Errors: coordination catch → `available:false` with reason; supervision build
  catch serves the last payload and warns; malformed inputs degrade without throw.
- Perf: hierarchy role resolution is cached per declared role; builds are O(n) in
  agents (150-agent test ~sub-250 ms budget); no O(n²) per-render loop found.

### 7. Tests — PASS (407/407), meaningful, with three gaps

- New suites are substantive, not tautological: hashes/byte equality of data URIs,
  palette vs `roles.json`, drift test of the generated module, aliases/fallback,
  model-never-a-role, review-vs-Reviewer, render-tree assertions with a React stub,
  hierarchy filters/counts, supervision honesty/events, every delegation refusal,
  and Task Board purity/absent/forged-capability cases.
- No test is disabled or weakened (no `.skip`/`.todo`/`only`); `review-supervision-
  artifact.test.js` was extended with the new module list, not relaxed.
- Gaps (not blockers): no test covers the host broadcast trigger (R2), no test
  feeds an invalid persisted role value (R1), and no test guards the card memo
  comparator (source-reviewed only). The readiness parity test does compare
  `supervisionReadinessOf` against `orchestrator/dag.js`.

### 8. Docs — PASS with the overclaims listed

- Honest where it matters: read-only Task Board, no write API, no inbound
  orchestrator reports, limits cover board-owned launches only, no percentage,
  role must be declared, visual validation Windows-Chromium-only, bundle growth.
- Overclaims: R4 (placeholders/clean claim/stale test count), R5 (function "runs in
  the panel"), R6 (colour-alone), R7 (card family/unchanged view), R8 (absolute
  gating), R9 (block timestamps), R10 (bundle size).

## Commands run and results

| command | result |
|---|---|
| `git status --short`, `git diff --stat HEAD`, `git branch --show-current`, `git log --oneline -8` | branch correct; GOAL 4 changes uncommitted (20 M + untracked); no GOAL 4 commit yet |
| `node --test tests/` (final, after the Lead's rebuild) | **407 tests, 407 pass, 0 fail, 0 skipped**, ~2.2 s |
| `node --test tests/` (intermediate, 15:49, before the final `supervision-ui` edits landed) | 404/405, only failure was the artifact-integrity test; resolved by the Lead's rebuild (verified) |
| read-only per-module bundle comparison (in-memory concatenation, 19 modules) | all 19 sections match current source; bundle 412 548 bytes |
| SHA-256 comparison of all 32 SVGs + `roles.json` vs `.kit-inspect/agent-board-svg-15-roles` | 32/32 identical; `roles.json` identical |
| SVG scan for scripts/external refs/foreignObject/raster | no match in any of the 32 files |
| `node --check` on 11 new/changed modules + `src/client.js` | OK |
| `node scripts/smoke-host.mjs` | `smoke: OK — projection statuses, tree, and one DAG dispatch decision agree` (exit 0) |
| `normalizeHierarchyFilters` probe (`worker`, `not-a-role`, `future_removed_role`, `generic`, `all`, `''`) | invalid role preserved (`not-a-role`, `future_removed_role`) — R1 evidence |
| event-history simulation with 50-event cap | before=50, after=50 → broadcast trigger false — R2 evidence |
| static string audit (fr/en key parity + every `dabT` usage) | 219/219 keys, 142 usages, 0 missing |
| `git diff HEAD -- package.json` | only three `scripts` entries; no dependency |
| grep for HTML sinks/eval/fetch/child_process in new modules and scripts | only `process.env.TEMP` in the dev gallery script (no sink, no network) |
| CSS inspection for animation/reduced motion | one shorthand animation (running ring), disabled under `prefers-reduced-motion`; no new animation |

## What I did not verify

- **I did not run the visual/browser pass.** I reused the Lead's fact (isolated DSH
  host, 1366×768 and 390×844, light/dark, zero console errors) and audited
  accessibility from the code only (ARIA, focus CSS, keyboard handlers, reduced
  motion). I did not see a screenshot rendered by me.
- **No real screen-reader run**, no 200 % zoom, no Windows high-contrast mode, no
  macOS/Linux Chromium; no test of a strict CSP that might reject `data:` images on
  another host.
- **No populated role-aware panel.** The isolated profile declares no roles (as the
  docs admit), so the 15 known-role mascots were verified from the data URIs and
  the gallery, not from agents in a live panel.
- **No real Task Board.** Coordination was verified against the pure mapper and the
  existing simulated fixture; the real 0.10/0.11 plugin exposes none of the
  proposed write endpoints, so no live read/write against the real plugin was
  performed. The E2E 15/15 assertion claim was not re-run by me (no isolated host
  boot in this session); the 407-test suite and smoke check were run.
- **No long-running soak:** the 15 s projection sampling / broadcast behaviour was
  reasoned from code and a cap simulation, not observed over time on a live host.
- **No review of pre-existing GOAL 1–3 behaviour** beyond regressions implied by
  the diff; I did not re-audit the routing/failover/settlement code.

## Recommendation to the Lead

Before committing:

1. Fill `docs/GOAL4-DELIVERY.md` `COMMITS_PLACEHOLDER`/`RUN_RESULT`, commit, then
   verify the "clean" statement and update `docs/TEST-REPORT.md` (R4).
2. Delete or ignore `.kit-inspect/` (R11).
3. Optional but cheap: validate the role filter (R1) and fix the two doc
   overclaims that are one-line edits (R5, R8).

After committing, track R2/R3 as follow-ups: they are the only findings with real
runtime behaviour impact, and both have a small, local fix (eager projection +
change-flag broadcast; one bounded coordination read at startup, plus a band
notice for a missing Task Board). None of the P2 findings touches the security or
write boundaries reviewed above.
