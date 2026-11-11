# Independent review — GOAL 5 responsive cockpit

Reviewer: separate QA agent (read-only), HEAD `44e05e0`, 2026-11-11.
Verdict: **PASS WITH FINDINGS** — 0 × P0, 1 × P1, 6 × P2, 6 × P3.
The reviewer ran the full suite (446/446 at the time), verified the bundle is
byte-identical to a rebuild, checked that the bundle has no ESM syntax or HTML
sink, inspected the screenshots and the CSS scope. Its clean list: no invented
percentage/status/task, mutually exclusive and filter-independent buckets,
honest `reviewAvailable=false`, Task Board state never rendered as an agent
status, roles never derived from the model, `aria-modal`/Escape/Tab-trap/focus
restore present, default view `global`, 2-column mobile mosaic, 240–290 px
desktop cards, stop reachable on narrow, no secrets.

Every finding was addressed; the resolutions are listed below and the code
touched by each is in the fix commit that follows this record.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | **P1** | Within-section ordering was a silent no-op: `sortAttention` was called with `Entry` wrappers (no `status`/`updatedAt`), so every comparison returned 0. | `buildOverview` now sorts `(a, b) => sortAttention(a.node, b.node)`; a new shuffled-input test proves the tier + recency order (it would fail on the old code). |
| 2 | P2 | Header "N agents" used `counts.total` (includes blank sessions) while the indicators use non-blank agents (21 vs 17). | `agentTotal` (overview `counts.agents`) is passed to the toolbar; the header now equals the indicator sum. |
| 3 | P2 | Narrow-menu stop control lost its accessible name when the text is hidden. | The stop button now carries `aria-label` (stop / resume / no-execution) and a descriptive `title`; the narrow menu reuses the labelled control. |
| 4 | P2 | No visible keyboard focus on the primary card. | `.dab-gcard:focus-visible` draws a 2 px brand outline (verified live with Tab: `solid 2px`). |
| 5 | P2 | A `<button>` nested inside `role="button"`, and the card used `aria-pressed` while it opens a dialog. | The card and the explicit open button are now SIBLINGS in `.dab-gcard-wrap`; the card exposes `aria-haspopup="dialog"` + `aria-expanded`. A test asserts no nested button. |
| 6 | P2 | Coarse-pointer targets were 36/32/30 px while the contract said ≥ 40 px. | 40 px controls (chips, segments, icon buttons, stop) and a 36 px card action under a coarse pointer; the contract states the real values. |
| 7 | P2 | Contract said the narrow header is one line but the mockup's title + subtitle block is two. | The contract now describes the real design: compact two-line title block, no second row of controls (as the mockup). |
| 8 | P2 | The unreadable-ledger reason was hover-only on a non-focusable `div`. | The unavailable indicator is a disabled `<button>` with the reason in `aria-label`/`title` and `aria-disabled`. |
| 9 | P2 | The collapsed band did not say it is the supervision LAYER (not an agent). | A visible "Supervision" marker (tooltip: full layer sentence) is rendered in the band at both widths; the state word is hidden on narrow to keep 57 px. |
| 10 | P3 | `recent` filter had no cockpit chip but could be persisted. | A persisted `recent` value migrates to the default "En cours"; `recent` stays a model/history filter, documented. |
| 11 | P3 | `DabSelect` ids contained spaces; Escape closed both the select and the parent popover. | Stable slug ids; the select stops propagation on Escape/Tab. |
| 12 | P3 | Card memo comparator omitted `error`, `waitingDetail`, `archived`, project/parent title and role label. | The comparator now includes every field the card renders. |
| 13 | P3 | No unit test for `arbiter.select`; focus/popover behaviours are only verified live. | A `select()` test was added (immediate inspect, no open); the focus/popover contract is explicitly listed as live-verified, not unit-tested, in the limitations. |
| 14 | P3 | The narrow menu showed the mode twice, with two labels ("Observation" vs "Arrêt"). | The redundant mode select was removed; the segmented control is the single source. |
| 15 | P3 | The scrim hard-codes `#000`. | Documented as a deliberate neutral overlay (a scrim darkens in both themes); the contract now says so. |
| 16 | P3 | Persisted arrays were bounded on read but could grow on write. | Arrays are capped on write and in the in-memory setters (200 folds/expansions, 500 dismissals, most recent kept). |

Reviewed and intentionally not changed: the mobile band hides the mini
orchestrator avatars (mockup fidelity, they remain in the details); the card's
`data-calm` styling; `dabEnabled`/`data-recent` cosmetics.

Final state after the fixes: suite **448/448**, bundle rebuilt, live checks on
the isolated host: band 62 px (1366) / 57 px (390), layer marker visible at both,
no nested button, `aria-haspopup=dialog`, keyboard focus ring solid 2 px, header
count equals the indicator sum, 0 console errors.
