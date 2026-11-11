# GOAL 4 delivery — mascots, supervision and Super Orchestrator

- Date: 2026-11-11
- Branch: `feat/agent-board-mascots-super-orchestrator` (from `goal3/supervision-orchestration` @ `905e367`)
- Breadth: P0 mascots + P1 supervision UI + P2 Super Orchestrator layer + P3 Task Board coordination
- Verdict: **PASS with documented limits** (see [Capability matrix](MASCOTS-SUPER-ORCHESTRATOR.md#capability-matrix) and [LIMITATIONS](LIMITATIONS.md))

## 1. Delivered

| P | Deliverable | State |
|---|---|---|
| P0 | 15 mascots + bolt emblem, 32 SVGs byte-identical to the approved kit, inlined as data URIs | **implemented** |
| P0 | `AgentRole` registry, exact palette, declared-name aliases, documented text deduction, generic fallback | **implemented** |
| P0 | Reusable `DabAgentAvatar` (full/compact, size, status dot, selection, accessible name) | **implemented** |
| P1 | Role-aware cards (mascot, role chip + « déduit » provenance, project context, linked task state, sub-agents, real activity) | **implemented** |
| P1 | Supervision band + `Hiérarchie` view (workspace → project → declared orchestrator → agents) | **implemented** |
| P1 | Role / status / Task Board state filters, persisted and bounded | **implemented** |
| P1 | Light/dark, phone layout, keyboard, reduced motion, contrast-safe badges | **implemented** (visual pass below) |
| P2 | `buildSupervision` pure projection (projects, blocks, cross-project deps, recommendations) | **implemented** |
| P2 | Delegation gate (concurrency, hourly, depth, cycle, cross-project) additive to `authorizeLaunch` | **implemented** |
| P2 | Supervision events (bounded, stable ids, deduplicated) on `/state` + SSE | **implemented** |
| P3 | Task Board coordination read model (tasks, `dependsOn`, cross-project edges) | **implemented — read only** |
| P3 | Coordination proposals | **proposal only** (no board-facing write API) |
| P3 | Reassignment / priority / Kanban writes | **unavailable** (documented endpoints, never called) |

### Role deduction (post-delivery adjustment)

The first delivery only resolved **declared** roles, so a profile whose agents
declare none (like the isolated E2E) showed the generic grey identity on every
card while only the Super Orchestrator had a mascot. That is now fixed: an
undeclared role is **deduced from text the runtime already declares** (session
title, goal objective, linked Task Board task title) with an ordered,
word-bounded keyword table, always marked `source:'inferred'`, labelled
**« déduit »** on the card and in the inspector, with the matched signal in the
tooltip. A declared role always wins; a model/provider is never an input; only an
agent with no declared role and no usable text keeps the generic identity.
Verified on the isolated host: all three E2E cards now render the Worker mascot
with "Worker · déduit" (default, no keyword), and the gallery still proves the 15
declared roles. Evidence: `docs/e2e/screenshots/goal5-inferred-roles.png`.

## 2. Architecture

The full description, role table, status mapping and capability matrix live in
[MASCOTS-SUPER-ORCHESTRATOR.md](MASCOTS-SUPER-ORCHESTRATOR.md). In short:

- the mascot colour is the **role**; runtime status is a separate dot derived from
  the board's existing 11 statuses; Task Board workflow states are a third,
  separate vocabulary (`in_review` ≠ Reviewer);
- the Super Orchestrator is the **host supervision layer** (`synthetic:true`, no
  model, no session), aggregating real facts and gating board-owned delegations;
- the Task Board remains the source of truth for tasks, dependencies, Kanban,
  priorities, milestones and forge sync;
- no second agent engine, no new event bus: the existing `ctx.agents` launch path
  and the existing SSE state stream are reused.

## 3. Main files

```text
src/assets/agent-bots/{full,compact}/*.svg   approved kit, byte-identical (32 files)
src/assets/agent-bots/roles.json             kit reference (palette test source)
scripts/build-assets.mjs                     SVG -> data URI module
scripts/mascot-gallery.mjs                   dev gallery of the 32 drawings
src/contracts/agent-roles.js                 roles, aliases, tones, avatar model
src/client/ui/agent-bots-assets.js           GENERATED data URIs
src/client/ui/avatar.js                      DabAgentAvatar
src/board/hierarchy.js                       pure hierarchy built on buildBoardView
src/client/ui/hierarchy.js                   supervision band + hierarchy view
src/client/ui/{card,tree,toolbar,styles,strings,preview,history}.js   enriched UI
src/supervisor/super-orchestrator.js         pure supervision + events
src/orchestrator/delegation.js               delegation gate
src/contracts/model.js                       additive `policy.supervision`
src/host/index.js                            supervision/events/coordination wiring
src/connectors/taskboard.js                  additive read fields
src/connectors/taskboard-coordination.js     coordination read model (no write)
```

The browser artifact `src/client.js` is generated (`scripts/build-client.mjs`, 19
modules) and integrity-tested byte-for-byte.

## 4. Build

```sh
node scripts/build-assets.mjs   # 16 identities x 2 variants -> data URIs
node scripts/build-client.mjs   # src/client.js (19 modules)
node --test tests/              # full suite
node scripts/smoke-host.mjs     # module/DAG smoke
node scripts/mascot-gallery.mjs # optional: HTML gallery of the 32 SVGs
```

Artifact location: `D:\App\DSH-agent-board\src\client.js` (served by DSH on the
next page load; the plugin itself is installed by `link:` in the isolated E2E
profile and can be installed with `plugin_manager install_bundle`).

## 5. Tests

- `node --test tests/` — **412 tests, 412 pass, 0 fail** (including the
  artifact-integrity byte comparison of the generated `src/client.js`, a host
  regression test proving the supervision payload is built eagerly from the real
  agents before the 15 s projection timer, the declared→deduced role tests, and a
  CSS regression test pinning the status dot to the bottom-left).
- Isolated real DSH host E2E (`scripts/e2e/run-e2e.mjs --keep-running`): **15/15
  assertions PASS** with the new build (fake OpenAI-compatible provider, simulated
  Task Board, no credentials); the board audit shows the new `delegation_allowed`
  fact on a real launch. The harness still carries its GOAL 3 report label; its
  evidence was not committed over the GOAL 3 record, the assertions are quoted
  here and the run is reproducible with the command above.
- Asset tests: presence, variants, bolt emblem, `viewBox`, exact palette,
  no script/external reference, data-URI byte equality, generated-module drift.
- Role/avatar tests: aliases, declared-first precedence, documented text deduction
  (accent/case/word-boundary cases, default worker, no signal ⇒ generic),
  model-never-a-role, 11 statuses mapped, review-vs-Reviewer, size/variant,
  generic without src, component render smoke with a React stub.
- Hierarchy tests: one/many projects, missing orchestrator, `supervision:null`,
  unknown roles, filters, 150-agent build (~11 ms).
- Supervision/delegation tests: multi-project aggregation, blocks, cross-project
  deps, off ⇒ idle, stopped ⇒ blocked, proposals only, unavailable capabilities,
  Task Board absent, stable/deduped events, and every delegation refusal.
- Task Board coordination tests: realistic/malformed/absent state, cross-project
  edges, bounded deterministic output, no write, forged capability refused.
- Artifact integrity: `src/client.js` is regenerated from modules and compared
  byte-for-byte by `tests/review-supervision-artifact.test.js`; no HTML sink, no
  `eval`, no `new Function`, no `document.write`; the single CSS animation rule is
  asserted.

## 6. Visual verification (actually inspected)

Environment: isolated DSH host (`D:\App\dsh-e2e-home-goal4`), profile `e2e`, fake
OpenAI-compatible provider + simulated Task Board, Playwright Chromium.

| Check | Result |
|---|---|
| Panel opens from the DSH rail, light 1366×768 | OK, zero console errors |
| Supervision band expanded (capability reasons visible) | OK |
| `Hiérarchie` view, honest "Aucun orchestrateur déclaré" | OK |
| Dark theme 1366×768 | OK |
| Phone 390×844 | OK (stacked band, full-width cards, caret on the header line) |
| Task Board state readable in default `off` mode | OK (filter present after the bounded startup read) |
| Keyboard: Enter toggles the band | OK (`aria-expanded` + `aria-controls` resolve to the hidden body) |
| Role mascots (15 + bolt) rendered from the exact data URIs | OK, gallery |
| Status dot clear of the role pictogram (bottom-left) | OK (numeric + zoomed render) |
| Undeclared agents get a deduced mascot, marked « déduit » | OK, all E2E cards (Worker default) |
| Status-colour independence | OK (dot separate; Worker stays green when not running) |

Evidence: `docs/e2e/screenshots/goal4-1366-light-projects.png`,
`goal4-1366-light-hierarchy.png`, `goal4-1366-dark-hierarchy.png`,
`goal4-390-light-hierarchy.png`, `goal4-mascots-gallery.png`,
`goal5-inferred-roles.png`, `goal6-status-dot-bottom-left.png`,
`goal6-status-dot-zoom.png`.

What was **not** exercised visually: a populated panel with agents whose declared
role resolves to the 15 mascots (the simulated profile's agents declare no role,
so they show the generic identity); a macOS/Linux Chromium; a real screen reader.

## 7. Known limits

See [LIMITATIONS.md](LIMITATIONS.md) rows 19–27. The important ones for this goal:

1. no board-facing Task Board write API ⇒ reassignment/priority/Kanban stay
   proposals (`writes_unavailable`);
2. no inbound orchestrator-report channel;
3. the Super Orchestrator is a policy/observability layer, not an autonomous agent;
4. delegation limits cover board-owned launches only;
5. a role is declared or **deduced from the runtime's own declared text** (title,
   goal, task title) with a fixed keyword table; the deduction is labelled
   « déduit » and never grants a permission, and an agent with no text at all
   keeps the generic identity;
6. no cross-plugin deep link to a Task Board task (no documented client
   navigation API), so the card/preview shows the linked task id and state.

## 8. Commits and PR

Branch `feat/agent-board-mascots-super-orchestrator`, base `905e367`:

```text
2562ac0 feat(mascots): integrate the 15 approved SVG roles and a reusable AgentAvatar
33be998 feat(ui): role-aware cards, supervision band, hierarchy view and filters
b3bdd35 feat(supervision): Super Orchestrator layer, delegation limits and host events
8a065ef feat(taskboard): read-only coordination model with documented proposals
b9db3a6 build(client): bundle the mascot, hierarchy and supervision modules
ab73c76 docs(goal4): integration notes, delivery evidence and independent review
9fc9810 docs(goal4): record the pushed branch and pull request
a90c992 feat(roles): deduce undeclared roles from declared text (marked "déduit")
8cd3e89 docs(goal4): record the role deduction and the final 411-test result
90a1186 docs(goal4): replace the commit placeholders with the recorded hashes
c69ed55 fix(ui): anchor the status dot bottom-left, clear of the role pictogram
(this commit) docs(goal4): record the dot position and the final 412-test result
```

The working tree is clean after this commit. The branch was pushed to
`origin/feat/agent-board-mascots-super-orchestrator` (never to `dev`/`main`) and
the pull request is **https://github.com/Rwanbt/DSH-agent-board/pull/1** (base
`dev`). It is not merged: merging is a user decision.

The independent review is [REVIEW-GOAL4.md](REVIEW-GOAL4.md): **PASS WITH
FINDINGS**, no P0/P1. Its four P2 findings were closed before the commits (role
filter validation, eager supervision projection + payload-change broadcast, Task
Board read at startup + visible unavailability, report/test-count placeholders);
the P3 doc/a11y wordings were corrected and the stray kit folder was removed.
