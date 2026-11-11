# GOAL 4 — integration contract (executed)

> **Status: implemented.** This was the shared contract used to build the change
> in parallel. It is kept as the reviewable interface record; the user-facing
> documentation is [MASCOTS-SUPER-ORCHESTRATOR.md](MASCOTS-SUPER-ORCHESTRATOR.md)
> and the delivery evidence is [GOAL4-DELIVERY.md](GOAL4-DELIVERY.md).

Branch: `feat/agent-board-mascots-super-orchestrator`
Base: `goal3/supervision-orchestration` @ `905e367`

This is the **shared contract** for the mascots + supervision + Super Orchestrator
work. Every agent codes against it so the modules can be developed in parallel on
disjoint files. The Lead owns final integration, the generated bundle, docs and
commits.

## Ground rules (non-negotiable)

- **No new dependency.** Plain ES modules, Node >= 22, no bundler. The browser
  artifact is a concatenation (`scripts/build-client.mjs`); a name defined in a
  module is a global for the modules after it.
- **Edit only your files.** `src/client.js` and `scripts/build-client.mjs` are
  Lead-only. `docs/GOAL4-CONTRACT.md` is Lead-only.
- **Style**: 2-space indent, single quotes, no semicolons, a JSDoc header per
  module, `node:test` + `assert/strict` for tests.
- **Honesty**: never invent a status, a percentage, a role or a capability. If
  the runtime cannot do it, expose `available:false` / `unavailable` with a
  reason. No mock data in a production path. Existing statuses and colours of the
  kit are authoritative.
- **Fidelity**: the 15 mascots are the approved SVGs. Never redraw, simplify,
  recolour or re-proportion them. Role colour is never used to express status.
- **Compatibility**: keep every existing view, status, API field, test and
  preference working. Additive changes only unless this document says otherwise.
- Run `node --test tests/` before reporting. Do not disable or weaken a test.

## Files by owner

| Owner | Files |
|---|---|
| A — assets & avatar | `src/assets/agent-bots/**`, `src/contracts/agent-roles.js`, `src/client/ui/agent-bots-assets.js` (generated), `src/client/ui/avatar.js`, `scripts/build-assets.mjs`, `tests/agent-bots-*.test.js`, `tests/agent-roles.test.js` |
| B — supervision UI | `src/board/hierarchy.js`, `src/client/ui/hierarchy.js`, `src/client/ui/card.js`, `src/client/ui/tree.js`, `src/client/ui/toolbar.js`, `src/client/ui/styles.js`, `src/client/ui/strings.js`, `src/client/ui/preview.js`, `src/client/ui/history.js`, `src/client/app.js`, `tests/hierarchy.test.js` |
| C — super orchestrator runtime | `src/supervisor/super-orchestrator.js`, `src/orchestrator/delegation.js`, `src/contracts/model.js`, `src/host/index.js`, `tests/super-orchestrator.test.js`, `tests/delegation.test.js` |
| D — Task Board | `src/connectors/taskboard-coordination.js`, `src/connectors/taskboard.js`, `src/connectors/registry.js`, `docs/TASKBOARD-COORDINATION.md`, `tests/taskboard-coordination.test.js` |
| Lead | `scripts/build-client.mjs`, `src/client.js`, `package.json`, all other docs, integration tests |

A and B share one interface: B renders `<DabAgentAvatar>` and calls the pure
helpers from `src/contracts/agent-roles.js`. B never edits A's files.
C consumes D's read model; C is the only one wiring `src/host/index.js`.

## A — assets, role registry, avatar

### Assets

Copy the approved kit into the repo, byte-identical:

```text
D:\App\DSH-agent-board\.kit-inspect\agent-board-svg-15-roles\   (source, delete after copy)
  full/*.svg  compact/*.svg  roles.json
→ src/assets/agent-bots/{full,compact}/*.svg   +   src/assets/agent-bots/roles.json
```

- `src/assets/agent-bots/` holds 16 identities × 2 variants = **32 SVG** (15 roles
  + the `super_orchestrator_bolt` emblem variant, which is **not** a 16th role).
- No `package.json` change is needed for the assets (they are inlined at build
  time); the Lead adds `src/assets` to `files` if needed.

### `src/contracts/agent-roles.js` (pure, no DOM, imported by host AND client)

```js
export const AGENT_ROLES = Object.freeze({
  // 15 entries, EXACT kit data: id, label, family, shape, color, gradient, scope, description
  // family ∈ governance | coordination | execution | quality | validation | protection
})
export const AGENT_ROLE_IDS = Object.freeze(Object.keys(AGENT_ROLES))
export const AGENT_FAMILIES = Object.freeze({ /* governance, coordination, execution, quality, validation, protection */ })
export const AGENT_ROLE_ALIASES = Object.freeze({ /* documented declared-name aliases, see below */ })
export const AGENT_TONES = Object.freeze({
  // kit status palette + documented extensions; every entry: { color, labelKey }
})
export const AGENT_STATUS_TONE = Object.freeze({
  // the 11 EXISTING plugin statuses -> tone key; no new status
})
export function dabResolveAgentRole(value) // -> { roleId|null, source:'explicit'|'alias'|'generic', raw }
export function dabAvatarVariantForSize(size) // -> 'full' | 'compact' (compact under 48px)
export function dabAgentAvatarModel(input) // -> the pure avatar view model, see below
```

Rules:

- `AGENT_ROLES[*].color` and `.gradient` must equal `roles.json` (add a test that
  reads `roles.json` and compares — palette drift is a bug).
- `AGENT_ROLE_ALIASES` maps **declared names only** (never inferred from a model,
  a parent/child link or a launch). Minimum documented set: role ids, kebab/snake
  and display forms (`super-orchestrator`, `Knowledge Manager`), plus explicit
  team-member synonyms: `lead`/`coordinator` → `orchestrator`, `qa`/`tester` →
  `verifier`, `dev`/`developer` → `worker`, `scout`/`explorer` → `researcher`,
  `security` → `guardian`, `perf` → `optimizer`, `review` → `reviewer`,
  `monitor` → `observer`, `planning` → `planner`, `integration` → `integrator`,
  `audit` → `auditor`, `knowledge`/`memory` → `knowledge_manager`,
  `architecture`/`arch` → `architect`. Every alias is a declared name, and the
  original string is always preserved in the model (`raw`), never rewritten.
- Unknown role → `roleId: null`, `source:'generic'`, **no** guessed colour or
  mascot. The UI shows a neutral generic identity; data is untouched.
- `AGENT_STATUS_TONE` covers exactly: `running, waiting_user, recovering,
  interrupted, provider_unavailable, finished_unread, finished_read, failed,
  idle, unknown, unavailable`. Mapping (documented in code):
  `running→active`, `waiting_user→waiting`, `recovering→planning`,
  `interrupted→interrupted`, `provider_unavailable→blocked`, `failed→blocked`,
  `finished_unread→unread`, `finished_read→done`, `idle→idle`,
  `unknown→gone`, `unavailable→gone`.
  Extensions (`unread`, `done`, `gone`, `interrupted`) exist because the kit's six
  tones cannot distinguish real plugin statuses; they are statuses, not roles,
  and never drive the mascot colour.
- `AGENT_TONES` colours: the kit's six hex values unchanged, extensions chosen for
  contrast on both themes and documented.
- `Task Board workflow states` are a **separate** vocabulary (`todo`,
  `in_progress`, `in_review`, `blocked`, `done`) mapped by `AGENT_TASK_STATE_TONE`
  (`in_review → reviewing`, `blocked → blocked`, `done → done`, `in_progress →
  active`, `todo → idle`). `reviewing` belongs to the linked task, never to an
  agent whose role is Reviewer.

`dabAgentAvatarModel(input)`:

```js
input = { role, name, status, taskState, size = 40, variant, emblem = 'crown', sources = null }
// sources: { [roleId]: { full, compact } } — the data-URI map; injected so the
// function stays pure and unit-testable. `sources=null` yields src:null (generic).
output = {
  roleId, roleLabel, family, shape, color, gradient,
  resolution: 'explicit'|'alias'|'generic', rawRole,
  variant, size, src,              // src = data URI from sources[roleId][variant], else null
  emblem: 'crown'|'bolt',          // only meaningful for super_orchestrator
  status, tone, toneColor, toneLabelKey,
  taskState, taskTone, taskToneLabelKey,
  altParts: [/* name, role label, status label key, task label key */],
}
```

### `src/client/ui/agent-bots-assets.js` (GENERATED — never hand-edit)

`scripts/build-assets.mjs` reads `src/assets/agent-bots/{full,compact}` and emits:

```js
/* GENERATED FILE — run node scripts/build-assets.mjs */
export const AGENT_BOT_ASSETS = Object.freeze({
  worker: { full: 'data:image/svg+xml;base64,...', compact: '...' },
  // ... 16 identities including super_orchestrator and super_orchestrator_bolt
})
```

Base64 keeps the SVG bytes exact and needs no runtime encoding. The generator
exports its pure builder so a test can regenerate in memory and fail on drift.

### `src/client/ui/avatar.js`

`DabAgentAvatar(props)` — React via `React.createElement` only:

- props: `{ role, name, status, taskState, size, variant, emblem, selected, decorative }`
- renders `span.dab-avatar[data-role][data-tone]` containing the `<img>` (or the
  neutral generic mark when `src === null`) and a separate status dot
  (`span.dab-avatar-dot`), never an HTML sink, never `dangerouslySetInnerHTML`;
- the accessible name is on the wrapper (`role="img"`, `aria-label` composed from
  the model's `altParts` translated through `dabT`); the `<img>` has `alt=""`
  because the wrapper carries the name. `decorative` renders `aria-hidden`;
- no state animation by default; any pulse is disabled under
  `prefers-reduced-motion`.

## B — supervision UI

### `src/board/hierarchy.js` (pure, tested)

```js
export function buildHierarchyView(projection, view, supervision) -> {
  workspace: { role:'super_orchestrator', emblem, status, counts, blocks },
  projects: [{
    id, title, unassigned, folded,
    orchestrator: { id, name, role, status } | null,   // null = no declared orchestrator (honest gap)
    teams: [ { root: node, agents: [node] } ],          // existing trees, reused
    counts: { agents, running, waiting, unread, failed, interrupted },
    blocks: [], crossProjectDependencies: []
  }],
  totals: {...}, filters: {...}
}
```

- It **reuses** `buildBoardView` output; it never re-implements visibility,
  sorting or the attention policy. It only adds the workspace level and the role
  projection per node.
- `supervision` is the host payload (below). `null`/absent must still render
  (structure from the projection only, capabilities `unavailable`, counts still
  real).

### Components

- `DabAgentCard`: add the mascot (compact/full by density), the resolved role
  label, the project, the linked Task Board state chip, the active sub-agent
  count (already `totalChildren`/`groupActive`) and, when available, the real
  activity (`turns`/`steps`) — **never** a percentage or a bar derived from
  elapsed time. Keep the existing status mark, keyboard semantics and ARIA.
- `DabSupervisionBand` (top, collapsed by default when a single project exists):
  super-orchestrator mascot, mode, aggregate counts, blocking items, cross-project
  dependency count, recommendations (with an explicit "proposition — non
  appliquée" tag), and the capability matrix ("non disponible" entries visible).
  Expandable, keyboard reachable, mobile layout stacked.
- `DabHierarchyView`: workspace → project → orchestrator → agents, expandable and
  filterable, no full-width connector lines (compact grouped cards). It must never
  auto-create agents: a missing orchestrator is shown as a gap, not a fake node.
- Toolbar: additive filters — project (exists), role, agent status, view mode
  (`projects` existing | `hierarchy`), and a Task Board-state filter only when the
  integration is available. Persist new preferences in the existing UI store
  (`DAB_UI_KEY`), with validation and bounds.
- Styles: light/dark via existing `--dsw-*` tokens, phone layout, 200% zoom,
  focus rings, reduced motion, and no status colour on the mascot.
- Strings: every new label in `fr` and `en`, including status/tone labels, the
  capability values and the recommendation disclaimer.

## C — Super Orchestrator runtime

### `src/supervisor/super-orchestrator.js` (pure; also included in the client bundle)

```js
export function buildSupervision({ projection, hostState, taskboard = null, now = Date.now() }) -> {
  version: 1, at,
  workspace: {
    id: 'workspace:supervision', synthetic: true,   // a supervision LAYER, labelled as such
    role: 'super_orchestrator', emblem, mode,
    status: 'active'|'idle'|'blocked', reason,
    counts: { projects, agents, running, waiting, unread, failed, interrupted, blocked },
    delegation: { depthLimit, concurrentLimit, hourlyLimit, usedThisHour, inFlight },
  },
  projects: [{ id, title, orchestrator: {...}|null, agents: [...], counts, blocks, crossProjectDependencies }],
  blocks: [{ id, kind, projectId, agentId?, taskId?, reason, at, source }],
  crossProjectDependencies: [{ id, fromTaskId, fromProjectId, toTaskId, toProjectId, source:'taskboard' }],
  recommendations: [{ id, kind:'reassign'|'priority'|'unblock'|'delegate', taskId, projectId, reason, evidence, status:'proposed', applies:false }],
  capabilities: {
    observe: true, recommend: true,
    delegate: 'gated' | 'unavailable',
    reassign: 'proposal_only', priority: 'proposal_only',
    receiveOrchestratorReports: 'unavailable',
    kanbanWrite: 'unavailable',
  },
  limits: {...}, taskboard: { available, reason, tasks, capabilities },
}
export function supervisionEvents(previous, next, at) // bounded, stable ids, real transitions only
```

Rules:

- The workspace node is **the host supervision layer** (policy engine), not a new
  AI agent. It is marked `synthetic:true` and labelled as the supervision layer in
  the UI. A real agent whose **declared** role resolves to `super_orchestrator`
  can be shown as `workspace.agent`; never fabricate one.
- Project orchestrators are only agents whose declared role resolves to
  `orchestrator`; otherwise `null` + a visible gap.
- Status is derived from real facts only (`mode`, `stoppedAt`, instance primary,
  agent statuses). Mode `off` ⇒ supervision `idle` (observing), never `active`.
- Blocking facts: failed/interrupted agents, provider cooldown, Task Board tasks
  `blocked` or with an unsatisfied cross-project prerequisite. Each block carries
  its source.
- Recommendations are **proposals**, never applied by this module:
  - `delegate`: a ready Task Board task with no assignment (same readiness rules as
    `orchestrator/dag.js`), only when capability `delegate` is gated and within
    limits;
  - `unblock`: a blocked task whose prerequisite is finished;
  - `priority`: cross-project contention (two projects blocked on one another)
    only when the Task Board exposes priorities; otherwise `unavailable`;
  - `reassign`: only if a write capability exists — **it does not**, so this stays
    `proposal_only` and must say so.
- Cross-project dependencies come from the Task Board read model (`dependsOn`
  whose task `workspaceId`/`projectId` differs). No Task Board ⇒ empty list with
  `taskboard.available:false` and a reason.
- `supervisionEvents` emits only diffs: `agent.status.changed`, `agent.started`,
  `agent.task.assigned`, `agent.blocked`, `agent.delegated`, `agent.task.completed`,
  `project.status.changed`, `task.status.changed`, `task.assignee.changed`.
  Stable id `${type}|${entityId}|${at}`; bounded (<= 50, newest kept); consumers
  must tolerate duplicates/order, so the host broadcasts the bounded list and the
  ids never change for the same fact.

### `src/orchestrator/delegation.js` (pure, tested)

```js
export function evaluateDelegation({ policy, task, taskboard, assignments, usage, now }) // { allow, reason }
export function delegationDepthOf(assignment)     // real recorded depth, never inferred
export function detectDependencyCycles(tasks)     // { cycles: [[taskId...]], ok }
```

Enforced limits (policy, additive fields in `src/contracts/model.js`):

```js
supervision: {
  enabled: true,
  emblem: 'crown',                 // 'crown' | 'bolt' (same role, visual variant)
  maxConcurrentDelegations: 2,     // board-launched assignments in flight
  maxDelegationsPerHour: 6,        // sliding hour
  maxDelegationDepth: 1,           // a delegated launch may not delegate again
  allowCrossProjectDelegation: false,
}
```

- A delegation may never widen permissions: reuse `allowedPermissionOf` and the
  existing `authorizeLaunch`/`authorizeHandoff` path. The super role grants **no**
  extra right.
- Refusals are explicit reasons (`delegation_depth_exceeded`,
  `delegation_budget_exhausted`, `delegation_cycle`, `cross_project_not_allowed`,
  `supervision_disabled`, …), audited, never silently downgraded.
- The board records `assignment.delegation = { depth, rootTaskId, parentAssignmentId,
  projectId, requestedBy }`; depth is read from the journal, never guessed from a
  timer. A refused delegation must not consume a lease or create a session.

### `src/host/index.js` (Lead-reviewed; minimal diff)

- publish `supervision` and `events` in the public state, bounded;
- read the Task Board coordination model (D) once per tick/refresh and pass it in;
- route supervised ticks/autonomous launches through `evaluateDelegation`;
- audit `delegation_refused` / `delegation_allowed`;
- never write the Task Board ledger; `done` stays human-only.

## D — Task Board coordination

### `src/connectors/taskboard.js` (read model only)

Extend the existing read mapping with `priority`, `milestone`, `updatedAt`,
`assignee` (from `claimedBy`), `dependsOn`, `executions` (already), and never
invent a field. Any addition is read-only.

### `src/connectors/taskboard-coordination.js`

```js
export function readCoordinationModel(taskboardState) -> {
  available: boolean, reason: string|null, source: 'live'|'simulated'|'absent',
  tasks: [{ id, title, status, priority, workspaceId, projectId, dependsOn, assignee, revision }],
  dependencies: [{ taskId, dependsOnTaskId, crossProject }],
  capabilities: {
    read: true,
    proposeReassignment: false, proposePriority: false, proposeBlocked: false,
    writeKanban: false, requestReview: false,
  },
  notes: 'Task Board remains the source of truth; this adapter never writes.'
}
export function buildCoordinationProposal(model, { kind, taskId, reason, evidence }) // pure, applies:false
```

- No write method exists because the Task Board exposes none for the board: the
  adapter returns `{ ok:false, code:'writes_unavailable' }` with the documented
  expected endpoints, exactly like the execution contract does.
- Absent/unreachable Task Board ⇒ `available:false`, `reason`, empty arrays; Agent
  Board keeps working and the UI disables the actions with a reason.

## Integration (Lead)

- Add the modules to `scripts/build-client.mjs` in dependency order:
  `contracts/agent-roles.js`, `supervisor/super-orchestrator.js`,
  `board/hierarchy.js`, `client/ui/agent-bots-assets.js`, `client/ui/avatar.js`,
  `client/ui/hierarchy.js`.
- Run `node scripts/build-assets.mjs`, `node scripts/build-client.mjs`,
  `node --test tests/`, `node scripts/smoke-host.mjs`, then the isolated-host
  visual check (Playwright, desktop/mobile, light/dark, many agents).
- Update `README.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`,
  `docs/LIMITATIONS.md`, and add `docs/MASCOTS-SUPER-ORCHESTRATOR.md`.

## Report format

Each agent reports: files changed, interfaces implemented exactly as above, tests
run + result, honest gaps, and anything the next agent must know. Do not claim a
visual check you did not perform.
