# GOAL 5 — responsive cockpit (UX refresh): delivery record

Date: 2026-11-11 · Branch: `feat/agent-board-responsive-cockpit` (base:
`feat/agent-board-mascots-super-orchestrator`, which already contains `dev`).

The approved mockup (`agent_board_mockup.zip`: `agent_board_mockup.html`,
`desktop.png`, `mobile.png`, `desktop-mobile-concept.png`,
`AUDIT-UX-AGENT-BOARD.md`) is the reference for layout, density, card treatment,
typography hierarchy, mascot usage, responsive behaviour and interactions. This
document records what was reproduced, what was measured on the **integrated**
plugin, and every deliberate deviation.

## 1. What changed

- **The global cockpit is the default view.** All projects are shown at once on
  desktop *and* mobile; the projects tree and the workspace hierarchy stay one
  click away and keep their saved preference.
- **One compact header** (title, real agent count, live state, the three real
  supervision modes, stop, refresh, history, settings popover) and **one filter
  bar** (search, `En cours / Tout / À traiter / Historique`, view switch,
  filters popover). No second navigation bar, no duplicated DSH sidebar.
- **Super Orchestrator band** (62 px) with the official crowned mascot, the real
  workspace status and mode, the real project count, the real declared
  orchestrator count, mini avatars of those orchestrators, and an expandable body
  that reuses the existing supervision details (capabilities with reasons,
  recommendations, blocks, cross-project dependencies, Task Board availability).
- **Four real indicators** (`Actifs`, `À traiter`, `En revue`, `Autres`) computed
  from the projection, each one a filter for the grid; `En revue` is the linked
  Task Board `in_review` state; when the ledger is unreadable it is a disabled
  control showing `—`, with the real reason in its accessible name.
- **Attention-first sections** (`Besoin d'attention`, `Agents en cours`,
  `Autres activités`) over an adaptive grid of supervision cards.
- **AgentCard v2 (global presentation)**: mascot + separate status dot, name,
  project, status word, real task line when there is one, descendant badge,
  failover mark, explicit "open session" button, one click = inspect.
- **Inspector**: right-side **drawer** on desktop (overlays the grid, never
  shrinks it) and **bottom sheet** on mobile (66–78 % of the panel, scrollable,
  safe-area padding, grip, explicit close, `aria-modal`, focus trap, Escape,
  focus restored to the grid).
- **Mobile mosaic**: two columns from 720 px down (one column below 340 px),
  ~122 px cards, the whole card tappable, the session opened by an explicit
  button, and **all projects shown** — the single-project mobile mode is gone.
- **Projects / hierarchy / compact / history preserved** and reachable from the
  same toolbar; history keeps its search, filtering, pagination and drawer.

## 2. Architecture

```
projection ─► board/view.js       visibility, attention policy, sorting
           ─► board/overview.js   flat cockpit model (sections, buckets, pinning)
           ─► board/hierarchy.js  workspace → project → orchestrator → teams
                    │
                    ▼
             client/app.js         state, persisted preferences, routing
                    ├─ ui/toolbar.js    header + filter bar + popovers
                    ├─ ui/superbar.js   Super Orchestrator band
                    ├─ ui/overview.js   indicators + global grid + cards
                    ├─ ui/inspector.js  drawer / bottom sheet shell
                    ├─ ui/hierarchy.js  supervision details + hierarchy view
                    ├─ ui/tree.js       projects tree / compact grid
                    ├─ ui/preview.js    inspector content (unchanged)
                    └─ ui/history.js    history drawer (unchanged)
```

`src/board/overview.js` is pure, unit-tested and the only place that decides
sections and indicator buckets. The React layer renders its output and never
re-derives a status, a section or a count. `client/app.js` stays the only owner
of the persisted preferences.

### Indicator buckets (each node counted exactly once)

Precedence **attention > active > review > other**, over every non-blank node:

- `attention`: `waiting_user`, `provider_unavailable`, unseen `failed` /
  `interrupted`;
- `active`: `running`, `recovering`;
- `review`: linked Task Board state `in_review` (a ledger fact);
- `other`: everything else (unread results, read sessions, seen failures).

`attention + active + review + other === agents` is asserted by tests, including
a 150-node fixture. Indicators are **global**: they do not change with the
search, the view filter or a stat focus; `counts.shown` is the number of rendered
cards.

### Sections (attention first, never hide an intervention)

| Section | Nodes |
| --- | --- |
| `attention` | `waiting_user`, `provider_unavailable`, unseen `failed`/`interrupted` |
| `running` | `running`, `recovering` (real state kept, never promoted to a role) |
| `other` | unread results, seen failures/interruptions, read/idle |

The default filter (`En cours`) keeps the existing `isAttention` policy, so an
unread result or a waiting agent is never hidden because it is old. `À traiter`
is intervention-only. `Tout` shows every non-blank node; a non-empty search
overrides the view filter, exactly like `buildBoardView`.

### Inspector and acknowledgement

Selecting a result acknowledges it (existing board behaviour, unchanged). The
inspected card is **pinned** in the overview while its inspector is open, so it
cannot vanish under the operator's eyes and keyboard focus has a target; the pin
respects the project, search, agent filters and the active indicator.

## 3. Responsive measurements (real integrated host)

Container width = the Agent Board panel, not the window. Captured from the
running plugin in an isolated DSH host.

| Viewport | Panel | Columns | Card | Band | Toolbar | Overflow-x |
| --- | --- | --- | --- | --- | --- | --- |
| 1920×1080 | 1640 px | 6 | 261×103 | 62 | 95 | no |
| 1366×900 | 1086 px | 4 | 257×92 | 62 | 95 | no |
| 1024×768 | 744 px | 3 | 231×92 | 62 | 95 | no |
| 768×900 | 712 px | 2 | 342×104 | 57 | 125 | no |
| 390×844 | 390 px | 2 | 181×104 | 57 | 125 | no |
| 360×780 | 360 px | 2 | 166×104 | 57 | 125 | no |
| 320×720 | 320 px | 1 | 295×84 | 57 | 163 | no |

The 240–290 px desktop card target holds from 1024 px up (230 px at the 744 px
panel, where a third 248 px column would not fit). The mobile card is 122 px,
against the 110–120 px target (+2 px); the band is 57 px on mobile (target 60–75
closed), the desktop band 62 px, the desktop toolbar 95 px (52–60 header +
40–45 filter row).

## 4. Evidence (screenshots from the integrated plugin)

Captured with Playwright on the real plugin served by an isolated DSH host
(`DSH_HOME` under `D:\App\_e2e`, disposable profile, simulated provider and
simulated Task Board). Five real workspaces (Ravum, Ravum Flow, Unifia,
Tonium, e2e-project), 21 real sessions, 3 real project orchestrators deduced
from the declared session text, real Task Board `in_review` tasks.

Limits of this evidence: the isolated host contains no sub-agent session (the
scripted provider never calls the sub-agent tool), so the descendant badge and
the sub-agent hierarchy are covered by the pure/render tests and the earlier
GOAL 4 evidence, not by these cockpit screenshots. One real failed session is
shown in `cockpit-1920-attention.png`; it was acknowledged later by normal use,
which is why the other captures show 0 in "À traiter".

| Screenshot | What it shows |
| --- | --- |
| [`cockpit-1920-light.png`](docs/EVIDENCE-SCREENSHOTS.md) | 1920 px, light, 5 projects, 3 real orchestrators, 6 columns |
| [`cockpit-1366-light.png`](docs/EVIDENCE-SCREENSHOTS.md) | 1366 px, light, 4 columns |
| [`cockpit-1920-dark.png`](docs/EVIDENCE-SCREENSHOTS.md) | 1920 px, dark |
| [`cockpit-1366-dark.png`](docs/EVIDENCE-SCREENSHOTS.md) | 1366 px, dark, attention card + red accent |
| [`cockpit-390-light.png`](docs/EVIDENCE-SCREENSHOTS.md) | 390 px, two-column mosaic, one-line header, 57 px band |
| [`cockpit-360-light.png`](docs/EVIDENCE-SCREENSHOTS.md) | 360 px |
| [`cockpit-320-light.png`](docs/EVIDENCE-SCREENSHOTS.md) | 320 px, single-column fallback |
| [`cockpit-1366-inspector.png`](docs/EVIDENCE-SCREENSHOTS.md) | desktop drawer over the grid, pinned card behind |
| [`cockpit-390-sheet.png`](docs/EVIDENCE-SCREENSHOTS.md) | mobile bottom sheet (66 % of the panel, scrollable) |
| [`cockpit-1366-projects.png`](docs/EVIDENCE-SCREENSHOTS.md) | projects tree view preserved |
| [`cockpit-1366-hierarchy.png`](docs/EVIDENCE-SCREENSHOTS.md) | workspace → project → orchestrator → agents |
| [`cockpit-1366-superbar-open.png`](docs/EVIDENCE-SCREENSHOTS.md) | expanded supervision details (7 capabilities) |
| [`cockpit-1366-history.png`](docs/EVIDENCE-SCREENSHOTS.md) | history drawer (search, pagination) |
| [`cockpit-1366-filters.png`](docs/EVIDENCE-SCREENSHOTS.md) | filters popover (project, role, status, Task Board state) |
| [`cockpit-1920-attention.png`](docs/EVIDENCE-SCREENSHOTS.md) | attention section with a real failed session |

## 5. Functional verification on the integrated host

| Check | Result |
| --- | --- |
| Search by project (`Unifia`) | 3 cards (3 Unifia agents) |
| Search by Task Board task title (`chemin nominal`) | 1 card — ledger title really indexed |
| Search by task id / model / project / role | 1 / 16 / 3 / 1 cards |
| `À traiter` filter with no intervention | 0 card + explicit empty state |
| `Tout` | 17 cards (all non-blank nodes) |
| `En cours` (default) | 9 cards; unread results stay visible |
| Indicator `En revue` | 3 cards, `aria-pressed=true`, click again clears |
| Keyboard on a card | Enter opens the inspector, focus moves inside the dialog |
| Escape | closes; focus returns to the grid (first card) |
| Drawer | 390 px wide, overlays the grid, grid width unchanged |
| Bottom sheet | 390 px wide, 66 % of the panel, body scrolls, "Ouvrir la session" present |
| History | drawer with search, 11 rows, load-more |
| Filters popover | 4 selects (project, role, status, Task Board state) |
| Console | 0 error, 0 page error over the whole interaction run |
| Card semantics | no nested button, `role=button` + `aria-haspopup=dialog` + `aria-expanded`, keyboard focus ring (2 px brand) |
| Header count | equals the indicator sum (18 agents, not 21 session rows) |
| Narrow menu stop | labelled control with `aria-label` (stop / resume / nothing to stop) |
| Explicit open button | opens the session and never the inspector |
| Band marker | visible "Supervision" layer chip at 1366 and 390 (state word hidden on narrow) |
| Touch targets | 40 px controls / 36 px card action under a coarse pointer |
| Session open | explicit button; `uiWorkspace.openSession` path unchanged |

## 6. Tests

- Full suite: **448/448** (`node --test tests/`), including
  `tests/cockpit-render.test.js` (20 render/contract tests that concatenate the
  authored modules exactly like the build and hydrate them with a React stub),
  `tests/overview.test.js` (12 pure model tests, including the within-section
  ordering on shuffled input, the 150-node bucket partition and the 15/50/150
  perf guard) and the extended
  `tests/board-view.test.js`.
- An independent read-only QA pass reviewed the branch and its findings were all
  addressed (`docs/REVIEW-GOAL5.md`).
- The bundle (`src/client.js`) is byte-identical to a rebuild
  (`tests/review-supervision-artifact.test.js`).
- Component cost: rendering the 150-card cockpit tree with the React stub takes
  ~16 ms (VDOM construction only; browser paint is not measured).
- Known flake: two timing-sensitive review tests
  (`review-backend-restart-lease`, `review-supervision-artifact`) can fail under
  the full parallel load; they pass alone, serially, and on rerun. Recorded, not
  hidden.

## 7. Deliberate deviations from the mockup

1. **No second application sidebar** — DeepSeek Harness already renders global
   navigation; duplicating it would create two competing navigations.
2. **Status dot bottom-left** on the mascot, not bottom-right: a product
   correction requested on 2026-11-11, because the kit draws the role pictogram
   bottom-right. The dot is also backed by a text status on attention cards, so
   colour is never the only signal.
3. The mockup's "Autonome" pill on the band is a mode, not a status: the band
   shows the **mode** and the **workspace status** as two separate facts.
4. `En revue` counts only the reliable Task Board `in_review` state; there is no
   "planification" number because no runtime field measures it.
5. `Historique` opens the existing drawer (search + pagination) instead of
   flooding the cockpit with dozens of ended sessions.
6. The mobile band hides the mini orchestrator avatars (mockup shows a single
   line); they remain in the expandable details and on desktop.
7. Indicator values are global and filter-independent by design; a stat click
   narrows the grid instead of rewriting the counts.

## 8. Remaining limitations

- No virtualisation: 150 agents are rendered as 150 memoized cards in one CSS
  grid. The model stays at ~2.7 ms per round for 150 nodes, but the DOM cost of
  >100 cards was not measured on a low-end device.
- `En revue` requires a readable Task Board ledger; without one the indicator is
  `—` with the reason (never a fake 0).
- Project orchestrators are found by declared role or by the documented text
  deduction (marked « déduit »); a runtime that declares no role and no usable
  text yields the neutral generic identity.
- The isolated host used a simulated model provider and a simulated Task Board;
  a real provider outage, a real Task Board and a real Android device were not
  exercised in this round.

## 9. Follow-up (2026-11-11, same branch): default view and mobile controls

Three product corrections reported after the first review, all verified on the
integrated host:

1. **The cockpit is really the default view.** The default was already `global`
   in code, but a preference written by an older build (`viewMode: 'projects'`,
   no `schema`) kept pinning the projects tree. `dabReadUi()` now compares the
   stored payload with `DAB_UI_SCHEMA = 2`: a legacy payload is read with the
   cockpit default while every explicit filter, fold and dismissal is preserved,
   and the next write stamps `schema: 2` so an explicit post-upgrade choice is
   honoured again. Verified live: legacy `{viewMode:'projects', filter:'all'}` →
   `data-view="global"` with "Tout" still pressed; choosing "Projets" after the
   upgrade survives a reload (`schema: 2` in storage).
2. **The three view buttons keep a centred, identical pictogram.** Below
   900 px the label is removed from the DOM (not merely hidden by CSS) and the
   buttons become identical squares — 34×30 px, **40×40 px on a coarse pointer**
   — with `justify-content: center` and `display: block` on the SVG. Previously
   the coarse-pointer rule forced `min-height: 40px` on 30 px-wide buttons, so
   the target (and its selected pill) became a tall rectangle around a 16 px
   icon. The search placeholder also shortens to `Rechercher…` at that width so
   the three views do not squeeze it.
3. **The filter trigger sits right of `Historique`, on the same line.** On a
   narrow panel it moved out of the search line into the chip row, whose last
   control it is now; the `⋯` menu keeps the supervision mode, stop and refresh
   only (renamed « Orchestrateur et actions »), so there is a single filters
   entry point. Its popover is anchored to the toolbar and inset 10 px on both
   sides with a 70 vh / 520 px scrollable cap, which removes any possibility of
   opening outside the panel (the old `right: 0` panel could overflow a narrow
   column in a wide window). The stop button inside that menu now shows its word
   (« Arrêt »), the header one stays icon-only.

Evidence: `docs/EVIDENCE-SCREENSHOTS.md`,
`cockpit-360-light.png`, `cockpit-320-light.png`, `cockpit-768-light.png`,
`cockpit-390-menu.png` (re-captured on the integrated host), plus the render
tests « narrow toolbar: the filters trigger sits on the chip row, right of
History », « icon-only view switch: three square targets… », « a legacy
preference cannot pin the pre-cockpit projects default » and the CSS assertions
in `tests/cockpit-render.test.js`. Full suite: **451/451 pass**, bundle rebuilt
(23 modules), no horizontal overflow at 320/360/390/768.
