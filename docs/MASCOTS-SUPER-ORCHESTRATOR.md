# Mascots, supervision and the Super Orchestrator layer

Status: **implemented and tested**, with explicit limits (see
[Capability matrix](#capability-matrix)). This document describes what ships,
what the runtime really supports, and how to rebuild or extend it.

- Branch: `feat/agent-board-mascots-super-orchestrator`
- Assets: the approved kit `agent-board-mascottes-svg-15-roles-super-orchestrator`,
  integrated **byte-identical** (15 roles, 6 silhouettes, crown/bolt emblem).
- Everything below is a projection of native/host facts. The panel never invents
  a status, a role, a percentage or a delegation.

## 1. The 15 roles

| Role | Family | Shape | Colour | Scope |
|---|---|---|---|---|
| Super Orchestrator | governance | triangle | `#7043DB` | workspace |
| Orchestrator | governance | triangle | `#8D55EA` | project |
| Architect | governance | triangle | `#895AED` | project |
| Knowledge Manager | governance | triangle | `#A572F3` | project |
| Planner | coordination | rounded square | `#228FFD` | project |
| Dispatcher | coordination | rounded square | `#03B4E2` | project |
| Observer | coordination | rounded square | `#5F92C7` | project |
| Worker | execution | cloud | `#36CB5E` | project |
| Researcher | execution | cloud | `#25C5A6` | project |
| Integrator | execution | cloud | `#12AD86` | project |
| Optimizer | execution | cloud | `#8ECF10` | project |
| Reviewer | quality | circle | `#FB8819` | project |
| Auditor | quality | circle | `#EB7E25` | project |
| Verifier | validation | diamond | `#FEBF0D` | project |
| Guardian | protection | hexagon | `#FE6560` | project |

The **Super Orchestrator** keeps the governance triangle with a more intense
violet (`#7043DB`) and a floating gold crown. The **bolt** drawing is an emblem
variant of the *same* role (`super_orchestrator_bolt`), never a 16th role; it is
selected by `policy.supervision.emblem` (`'crown'|'bolt'`).

The palette is authoritative and test-enforced: `AGENT_ROLES` is compared with
`src/assets/agent-bots/roles.json` on every run, so a hand-edited colour fails
the suite.

## 2. Assets and rendering

```text
src/assets/agent-bots/
  roles.json            the kit reference (schemaVersion 3)
  full/*.svg            16 drawings (15 roles + bolt), 256x256 viewBox
  compact/*.svg         16 drawings without rays/shadow, for dense lists
scripts/build-assets.mjs      -> src/client/ui/agent-bots-assets.js
scripts/mascot-gallery.mjs    -> one HTML gallery of the 32 files (dev utility)
```

- The SVGs are served **inside the plugin**: the build turns each file into a
  base64 `data:image/svg+xml` URI (`AGENT_BOT_ASSETS`), so the panel needs no
  static route, no network request, no external asset and no CSP exception. The
  bytes are the approved ones, never redrawn.
- `full` is used from 48 px, `compact` below (`dabAvatarVariantForSize`).
- The `<img>` is decorative; the wrapper owns the accessible name. There is no
  HTML sink anywhere in the client (`innerHTML`, `dangerouslySetInnerHTML`,
  `eval`, `new Function`, `document.write` are test-forbidden).
- Rebuild: `node scripts/build-assets.mjs && node scripts/build-client.mjs`.
  `node scripts/mascot-gallery.mjs [out.html]` writes a visual gallery.

## 3. Role resolution: declared first, deduced second

`src/contracts/agent-roles.js` resolves a role in this order:

1. **Declared** role/name: exact role id (`worker`, `knowledge_manager`,
   case-insensitive) or a documented alias (`lead`/`coordinator` →
   `orchestrator`, `qa`/`tester` → `verifier`, `dev`/`developer` → `worker`,
   `scout`/`explorer` → `researcher`, `security` → `guardian`, …), accent- and
   case-insensitive.
2. **Deduced** from text the runtime already declares (session title, goal
   objective, linked Task Board task title): an ordered, word-bounded keyword
   table maps e.g. "code review" → Reviewer, "audit/conformité" → Auditor,
   "validate/test/QA" → Verifier, "security/permissions" → Guardian,
   "performance/benchmark" → Optimizer, "documentation/memory" →
   Knowledge Manager, "merge/integration" → Integrator, "research/explore" →
   Researcher, "architecture/design/UI" → Architect, "plan/sprint/roadmap" →
   Planner, "dispatch/assign" → Dispatcher, "monitor/observe" → Observer,
   "lead/orchestrate/coordinate" → Orchestrator, "implement/build/fix" → Worker.
   Text with no keyword yields the productive default `worker`
   (`defaulted:true`). Deduction is always `source:'inferred'`, carries the
   matched token/rule, is visibly labelled **« déduit »** and is announced to
   assistive technology — it is never presented as a declared role.
3. Only an agent with **no declared role and no usable text at all** keeps the
   neutral **generic identity** (grey person mark, no colour, no mascot).

A model/provider is **never** an input: the same DeepSeek model can be a Worker,
a Reviewer and a Planner at the same time. Nothing about parent/child links or
launches changes a role either. The original declared string is preserved in
`rawRole` and shown in the tooltip/inspector.

## 4. Status is independent from role colour

The mascot colour always means the role. Runtime status is a **separate dot**
anchored **bottom-left** of the mascot (so it never covers the role pictogram
the kit draws bottom-right: network, wrench, search, …), plus the existing status
mark and text. Mapping from the board's real statuses (`src/contracts/model.js`):

| Plugin status | Tone | Meaning |
|---|---|---|
| `running` | `active` | the agent is working |
| `waiting_user` | `waiting` | needs a human decision |
| `recovering` | `planning` | route switch / recovery in progress |
| `interrupted` | `interrupted` | launch stopped, superseded or its session vanished |
| `provider_unavailable` | `blocked` | the provider is inside its cooldown |
| `failed` | `blocked` | the turn ended in error |
| `finished_unread` | `unread` | a result exists and was not read |
| `finished_read` | `done` | a result exists and was read |
| `idle` | `idle` | no signal |
| `unknown` | `gone` | no live row / deleted session |
| `unavailable` | `gone` | the runtime says the agent is gone |

`reviewing` is **not** an agent status: it is the Task Board workflow state
`in_review` of the **linked task**, shown by a separate chip. An agent whose
permanent role is Reviewer never becomes "in review" because of it.

## 5. UI

- **Card**: mascot, name, the resolved role chip (a deduced role is visibly
  marked « déduit » with its matching signal; family in the role tooltip and the
  inspector), project context (the group heading, the tooltip and the
  inspector), linked Task Board state, active
  heading, the tooltip and the inspector), linked Task Board state, active
  sub-agent count, and the *real* activity (`N tours · M étapes`). There is no
  progress bar and no percentage: the runtime exposes no reliable completion
  measure, so inventing one is forbidden.
- **Supervision band** (top): the workspace layer, mode, status and reason,
  aggregate counters, blockages, cross-project dependencies, recommendations
  explicitly tagged *proposition — non appliquée*, and the full capability matrix
  with the real reason of every unavailable row.
- **Views**: `Projets` (the existing view and its semantics, now with mascots and
  role information in the cards) and `Hiérarchie`
  (`workspace → project → declared orchestrator → agents`). A project without a
  declared orchestrator shows an explicit gap, never a fabricated node.
- **Filters**: project (existing), role, agent status, Task Board state (only
  when the integration is available), plus the existing text search/attention
  filter. They apply to both views; new preferences are persisted in the
  existing `DAB_UI_KEY` store, validated and bounded on read.
- **Accessibility**: every avatar/band control has an accessible name, the band
  is keyboard-operable (`aria-expanded`), focus rings use the DSH brand token,
  the only looping animation is the existing running ring and it is disabled
  under `prefers-reduced-motion`. Agent status is always exposed as text in the
card's accessible name and in the inspector; the band counters render a coloured
dot plus a number with an accessible label (the colour is never the only channel
for assistive technology, and the count labels are visible on demand via the
tooltip/label).
- **Responsive**: the existing container-query layout still switches at 720px;
  the band stacks and the capability matrix becomes one column on phones.

## 6. The Super Orchestrator layer

`src/supervisor/super-orchestrator.js` is a **pure projection** of real facts:

```js
buildSupervision({ projection, hostState, taskboard, now }) -> {
  workspace, projects, blocks, crossProjectDependencies,
  recommendations, capabilities, capabilityReasons, limits, taskboard
}
```

- The workspace node is the **host supervision layer** (the board's policy
  engine), marked `synthetic: true` and labelled *"Couche de supervision (non un
  agent)"*. It is not an LLM agent and no AI session is created for it.
- Project orchestrators are only agents whose **declared** role resolves to
  `orchestrator`; otherwise `null` (visible gap).
- Status: `off` ⇒ `idle` (observing), Stop or a secondary instance ⇒ `blocked`,
  otherwise `active`. Never inferred from elapsed time.
- Blocks come from failed/interrupted agents, provider cooldowns, Task Board
  tasks blocked or with an unsatisfied prerequisite. Each block keeps its source.
- Recommendations are local proposals (`applies:false`): `delegate` (a ready task
  within the limits), `unblock`, `priority` (only when the ledger exposes
  priorities — the real Task Board does not), `reassign` (proposal only).
- `supervisionEvents(previous, next)` derives bounded, deduplicated events with
  stable ids (`agent.status.changed`, `agent.task.assigned`, `agent.blocked`,
  `agent.delegated`, `project.status.changed`, `task.status.changed`, …) from real
  transitions only. The host publishes them on `/state` and the SSE stream; the
  SSE stream is the existing inter-plugin event channel, so no new bus was added.

### Delegation limits

`src/orchestrator/delegation.js` adds a gate that can only **narrow** the
existing `authorizeLaunch` authority:

| Policy field (`policy.supervision`) | Default | Effect |
|---|---|---|
| `enabled` | `true` | turns the layer and its gates on/off |
| `emblem` | `'crown'` | `'crown'` or `'bolt'` (same role, visual variant) |
| `maxConcurrentDelegations` | `2` | board-launched assignments in flight |
| `maxDelegationsPerHour` | `6` | sliding-hour budget |
| `maxDelegationDepth` | `1` | a delegated launch may not delegate again |
| `allowCrossProjectDelegation` | `false` | a subtask in another project/workspace |

Every launch (tick, `/dispatch`, proposal approval) is journaled with
`assignment.delegation { depth, rootTaskId, parentAssignmentId, projectId,
requestedBy }`; depth is **read from the journal**, never guessed, and a handoff
*continues* the record instead of deepening it. Refusals are explicit
(`delegation_depth_exceeded`, `delegation_budget_exhausted`, `delegation_cycle`,
`cross_project_not_allowed`, …), audited as `delegation_refused`, and happen
before any lease or session, so a refusal consumes nothing. A dependency cycle is
detected on the Task Board graph. The super-orchestrator role **grants no
permission**: the workspace mandate, allowed permissions/providers and isolation
rules are unchanged.

## 7. Task Board separation

`src/connectors/taskboard-coordination.js` is the only reader used by the
supervision layer. It maps the real `GET /dsh-taskboard/state` records into a
bounded read model (tasks, `dependsOn`, cross-project edges, per-task version) and
exposes **no write method**. `buildCoordinationProposal()` returns a local
recommendation with `applies:false`; reassignment/priority/blocked/Kanban writes
are `writes_unavailable` because the Task Board exposes no board-facing write API.
The proposed endpoints the Task Board would need are documented in
[TASKBOARD-COORDINATION.md](TASKBOARD-COORDINATION.md) and are never called.
When the Task Board is absent or unreachable, `available:false` + reason is
published (the band shows a "Task Board indisponible" notice with that reason and
the Task Board state filter is rendered disabled with it). The read is bounded to
one attempt per minute, is started at boot and on the first `/state`, so the
default `off` mode (which never ticks) still sees a reachable ledger; a failed
read is retried on the next window, never silently hidden.

## 8. Capability matrix

| Capability | State | Evidence / reason |
|---|---|---|
| Observe agents, projects, blocks, dependencies | **implemented** | pure projection + tests |
| Aggregate per-project status | **implemented** | counts from all project nodes |
| Detect blocking/transversal issues | **implemented** | failed/interrupted/cooldown/task facts |
| Recommend delegations/unblocks | **implemented** | proposals, `applies:false` |
| Delegate (launch) | **gated** | existing `authorizeLaunch` + `evaluateDelegation` |
| Reassign a task | **proposal only** | `taskboard_write_api_unavailable` |
| Change a priority | **unavailable** | `taskboard_priorities_unavailable` |
| Receive orchestrator reports | **unavailable** | `no_inbound_orchestrator_report_channel` |
| Write the Kanban / forge sync | **unavailable** | Task Board owns it; no write API |
| Move a task to `done` | **forbidden** | human-only, enforced by the Task Board tool |

## 9. Verification

- `node --test tests/` — see `docs/TEST-REPORT.md` and
  `docs/GOAL4-DELIVERY.md` for the exact count of the final run.
- Asset tests: 15 roles × 2 variants, bolt present, `viewBox`, exact palette,
  no script/external reference, data-URI byte equality, generated-module drift.
- Role tests: aliases, unknown fallback, model-never-a-role, status mapping,
  review-vs-Reviewer, size/variant, generic avatar without src.
- Supervision tests: multi-project aggregation, independent orchestrators,
  cross-project dependencies, blocks, off ⇒ idle, stopped ⇒ blocked, proposals
  only, unavailable capabilities, Task Board absent, stable/deduplicated events,
  and an eager `/state` supervision before any 15 s timer (the startup payload
  must describe the real agents).
- Delegation tests: concurrent/hourly/depth/cycle/cross-project/permission
  refusals create nothing.
- Task Board tests: realistic/malformed/absent state, cross-project edges,
  bounded deterministic output, no write, forged capability cannot unlock a write.
- Real UI on an isolated DSH host (fake provider + simulated Task Board):
  panel, band, hierarchy, light/dark, 1366×768 and 390×844, zero console errors.
  Evidence: `docs/e2e/screenshots/goal4-*.png` (including the 32-drawing gallery).

## 10. Backward compatibility

- `state.json` written before this feature has no `supervision` key: it reads as
  `SUPERVISION_DEFAULT`; existing policy patches keep their other fields.
- Existing UI preferences are preserved; unknown/older values are dropped on
  read. Existing views, statuses, API routes and tests are unchanged.
- The bundle is generated: `src/client.js` is never hand-edited.

## Where the mascots are rendered (GOAL 5 cockpit)

- **Global cockpit cards** (`ui/overview.js`): the mascot is the primary identity
  of every agent, 46 px (full variant) on desktop and 36 px in compact density;
  the status dot stays a separate element, bottom-left, clear of the role
  pictogram.
- **Super Orchestrator band** (`ui/superbar.js`): the crowned emblem by default,
  or the bolt alternative when the host publishes `emblem:'bolt'`; 42 px on
  desktop, 34 px on a narrow panel.
- **Project orchestrator mini avatars**: 26 px (22 px on a narrow panel) for the
  real orchestrators the hierarchy found, never a fabricated one.
- **Inspector** (`ui/preview.js` unchanged): the same resolved role and family,
  with the `déduit` provenance when the role was deduced from declared text.
- **Projects / hierarchy views**: 20–30 px mascots on the existing cards, so the
  role reads the same in every view.

The cockpit never recolours a mascot to express a status, and a role that could
not be declared or deduced keeps the neutral grey identity mark.
