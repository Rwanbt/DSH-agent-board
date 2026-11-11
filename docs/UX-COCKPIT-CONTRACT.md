# Agent Board — responsive cockpit contract (UX refresh)

Reference mockup: `agent_board_mockup.zip` (`agent_board_mockup.html`, `desktop.png`,
`mobile.png`, `desktop-mobile-concept.png`, `AUDIT-UX-AGENT-BOARD.md`), approved on
2026-11-11. This document is the engineering contract of the refresh: it fixes the
component boundaries, the data contracts and the responsive rules so the prototype
is reproduced without inventing a second source of truth.

## Non-negotiable invariants

1. The projection (`supervisor/projection.js`) stays the only source of agents,
   projects, statuses, parentage and activity. The cockpit only re-arranges it.
2. The status vocabulary does not change (11 native-ish statuses). The Task Board
   workflow state stays a **separate** vocabulary, rendered as its own chip.
3. The mascot colour is identity; the status stays a separate dot / mark. The dot
   sits **bottom-left** on the avatar (product decision of GOAL 4, kept here even
   though the mockup draws it bottom-right: the role pictogram lives bottom-right).
4. No fake agent, no fake supervision, no percentage, no invented task or
   activity. A missing capability is rendered with its real reason.
5. DeepSeek Harness theme tokens (`--dsw-alias-*`, `--dsw-elevation-*`,
   `--dsw-radius-*`) only. No hard-coded dark palette from the mockup.
6. Responsive decisions use the panel width (container query `dab`), never
   `window.innerWidth`: Agent Board often lives in a narrow side panel.
7. Task Board keeps ownership of tasks and Kanban; Agent Board only reads the
   ledger and links to it. No Kanban UI is duplicated here.

## Layering

```
projection ──► board/view.js        visibility, attention policy, sorting
           ──► board/overview.js    flat cockpit model: sections, stats, cards
           ──► board/hierarchy.js   workspace → project → orchestrator → teams
                    │
                    ▼
             client/app.js          state, preferences, routing
                    ├─ ui/toolbar.js       header + filter bar + controls
                    ├─ ui/superbar.js      Super Orchestrator band (real)
                    ├─ ui/overview.js      indicators + global grid + cards
                    ├─ ui/inspector.js     desktop drawer / mobile bottom sheet
                    ├─ ui/hierarchy.js     projects/hierarchy views (existing)
                    ├─ ui/tree.js          tree + compact grid (existing)
                    ├─ ui/preview.js       inspector content (existing)
                    └─ ui/history.js       history drawer (existing)
```

`src/board/overview.js` is pure and unit-tested; the React layer only renders its
output. `client/app.js` remains the only owner of the persisted UI state.

## Data contract — `buildOverview(projection, options)`

```js
const overview = buildOverview(projection, {
  filter,        // 'attention' | 'action' | 'all' | 'recent'
  query,         // free-text search (name, role, project, task, model, session)
  project,       // project id or null
  dismissed,     // Set<nodeId> (existing "dismiss" preference)
  roles,         // Map<nodeId, role> from buildHierarchyView (optional)
  taskStates,    // Map<taskId, TaskBoardState> | null
  taskTitles,    // Map<taskId, string> | null
  filters,       // { role, status, taskState } normalized agent filters
  focus,         // null | 'active' | 'attention' | 'review' | 'other'
  now,
})
```

Result (stable shape, memo-friendly):

```js
{
  sections: [ { id: 'attention'|'running'|'other', entries: [Entry] } ],
  entries: [Entry],          // flat, section order preserved
  counts: {
    total, agents,           // every node / every non-blank node of the projection
    active, attention, review, other,   // mutually exclusive buckets
    shown,                   // entries.length
    reviewAvailable,         // Task Board ledger readable?
  },
  filter, query, focus,
}
```

`Entry` = `{ node, role, projectTitle, parentTitle, taskState, taskTitle,
descendants, depth, tier }`. No derived status is added.

### Section policy (attention first, never hide an intervention)

| Section | Nodes |
| --- | --- |
| `attention` | `waiting_user`; `provider_unavailable`; `failed` unseen; `interrupted` unseen |
| `running` | `running`; `recovering` (real state shown as-is, never promoted) |
| `other` | `finished_unread`, seen failures, seen interruptions, idle/read/unknown |

Within a section: `sortAttention()` from `board/view.js` (attention tier, then most
recent activity, then title, then id). Sections keep the fixed order above.

### Indicator buckets (each node counted exactly once)

Precedence: **attention > active > review > other**.

- `attention`: same predicate as the attention section.
- `active`: `running` or `recovering`, not already counted as attention.
- `review`: linked Task Board state is `in_review` (a real ledger fact), not already
  counted. `reviewAvailable` is false when the ledger is not readable; the UI then
  shows `—` with the real reason instead of a fabricated number.
- `other`: everything left (unread results, read sessions, seen failures).

### Filters

- View filter: `attention` (default, "En cours" — includes every intervention),
  `action` ("À traiter": `waiting_user`, `provider_unavailable`, unseen
  `failed`/`interrupted`), `all` ("Tous"), `recent` (existing 24 h window).
  "Historique" is a **button** opening the existing history drawer: it never
  floods the grid and keeps search/pagination.
- `focus` narrows to one indicator bucket; clicking the same indicator clears it.
- Agent filters (role / status / Task Board state) apply on top, and are reported
  as active (a visible "clear" control).
- Search matches: title, resolved role id + label, project title, task id, Task
  Board task title when readable, model/provider, session id, goal.

## Components

### `DabToolbar` (rewritten)

- Header row, 52–60 px: title + subtitle (`Cockpit · Tous les projets · N agents`),
  live state (host reachable), supervision mode segmented control (OFF/Supervised/
  Autonomous), **stop** action (never hidden when executions are active), refresh,
  settings popover (host state/adapters) and history.
- Filter row, 40–45 px: search, `En cours / Tous / À traiter / Historique`, view
  switch (`Vue globale / Projets / Hiérarchie`), filter popover (project, role,
  status, Task Board state, compact, clear).
- Narrow (< 720 px): the title block keeps the mockup's compact two lines (title +
  agent count) with the live dot and the `⋯` menu on the same row — no second row
  of controls; the menu holds mode, stop, filters, refresh; the filter area is
  search + view toggle, then a horizontally scrollable chip row. No five-row
  stack.

### `DabSuperOrchestratorBar` (`ui/superbar.js`)

One compact band (60–75 px): official crowned mascot, `Super Orchestrator`, a
visible "Supervision" marker (the layer is not an agent, even collapsed), real
workspace status + mode, `N projects · M orchestrators`, mini avatars of the real
project orchestrators (desktop; in the expandable details on a narrow panel, to
keep the mobile band at ~57 px), and a chevron that expands the
existing supervision details (capabilities, recommendations, blocks, dependencies,
Task Board availability). When no super-orchestrator agent is declared, the band
still renders the supervision **layer** with `supervisionLayer` and never claims an
active agent.

### `DabOverviewStats` (`ui/overview.js`)

Four compact interactive blocks (`Actifs`, `À traiter`, `En revue`, `Autres`), each
value from `overview.counts`, each click setting/clearing `focus`. `aria-pressed`
reflects the selection; the colour is never the only signal (dot + label + value).

### `DabGlobalCard` (`ui/overview.js`)

Default supervision card: mascot + status dot, name, project, task/activity line,
descendant count badge (`↳ n`, only when `n > 0`), failover/blocked accent. One
click = inspect (shared `createClickArbiter`), double click = open, Enter/Space
opens the inspector; an explicit `↗` button opens the session. Geometry is uniform
per section (grid handles it). Reuses `dabCardRole`, `dabMascot` and the existing
strings; no duplicated status logic.

### `DabInspector` (`ui/inspector.js`)

Overlay shell around the existing `DabAgentPreview` content.
Desktop: right-side drawer over the grid (width `min(390px, 92%)`), backdrop,
`aria-modal`, Escape closes, focus restored to the card that opened it.
Narrow: bottom sheet, max-height 78 %, fixed header, scrollable body, explicit
close, safe-area padding, same focus rules. "Ouvrir la session" stays an explicit
button (never double-tap only).

### Views

- `global` — default; all projects at once, sectioned, flat adaptive grid.
- `projects` — existing tree / compact grid, grouped by project (kept).
- `hierarchy` — existing workspace → project → orchestrator → teams (kept).
- History drawer — unchanged behaviour (search, filters, pagination).

## Responsive rules

Reference widths checked on the integrated panel (container width, not window):
320, 360, 390, 430, 600, 720, 768, 1024, 1366, 1920 px, plus a narrow panel inside
a wide desktop window (the real DSH side-panel case).

| Panel width | Layout |
| --- | --- |
| ≥ 1024 px | grid `repeat(auto-fill, minmax(240px, 1fr))`, 4–7 columns |
| 721–1023 px | same grid, 3–4 columns, toolbar wraps into two rows |
| ≤ 720 px | mosaic `repeat(2, minmax(0, 1fr))`, card ≈ 112–120 px high |
| ≤ 340 px | single-column fallback for readability |
| coarse pointer | 40 px controls, 36 px card action, 16 px inputs |

Container queries on `.dab-root` (`container-name: dab`); no window media queries
for layout. Vertical natural scrolling; no infinite canvas, no zoom system.

## Explicit deviations from the mockup (documented, justified)

1. No second application sidebar: DeepSeek Harness already renders navigation.
2. Status dot bottom-left (product correction requested on 2026-11-11).
3. The mockup's "Autonome" pill on the super band is a mode label, not a status;
   the band shows the real mode and the real workspace status separately.
4. "En revue / plan" shows only reliable Task Board `in_review` data (`—` when the
   ledger is unreadable); no planning state is inferred from a role or a name. The
   unavailable indicator is a DISABLED control whose accessible name carries the
   real reason (never a hover-only tooltip).
5. "Historique" opens the existing drawer instead of listing dozens of ended
   sessions inside the cockpit.
6. Indicators count every node once (attention > active > review > other) and are
   computed from the projection, never from the rendered cards.
7. Indicator values are global and filter-independent by design; a stat click
   narrows the grid instead of rewriting the counts.
8. The `recent` (24 h) view filter stays available to the model and the history
   drawer but has no cockpit chip; a persisted `recent` preference is migrated to
   "En cours" so the toolbar never looks unselected.
9. The inspector scrim is a neutral 26 % black overlay in both themes (a scrim
   darkens; it is not a themed surface), documented rather than forced into a
   brand token.
