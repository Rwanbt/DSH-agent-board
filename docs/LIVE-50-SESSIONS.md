# Live protocol — fifty sessions, one operator

This is the missing measurement. Everything in the load model is proven against
fixtures and a fake `tokenMeter`; nothing has been run against a real provider
with real sessions. This protocol is the one that turns `P11-1` (machine
calibration) from a heuristic into a fact, and it is the only step that can raise
the confidence of the whole release.

Time box: one hour. Nothing here writes to a repository or a ledger you care
about: use a throwaway project.

## 0. Preconditions

- DSH running with this plugin, and a Task Board backend that supports worktree
  isolation (`taskboard` or `contract`). On the `board` backend every card shares
  the project directory, so the tree lock serialises and the number you measure is
  the tree, not the load (`P5-1`).
- At least 10 projects registered, 50 claimable `todo` cards (5 per project).
- A token pool you are willing to burn: start with `tokenBudget` generous (or
  empty = no pool) so the MACHINE is the only binding fact during the run.

## 1. Record the baseline (2 min)

```bash
node scripts/replay-state.mjs
```

Keep the JSON. It gives `machine.parallelism`, `machine.freeBytes`, and the
computed `load.ceiling` with its `binding` before any work starts.

## 2. Launch and observe (15 min)

Open the cockpit, then in Settings → Concurrency set:

- global ceiling: empty (unlimited)
- supervision ceiling: empty
- per-provider ceiling: one provider at 50, or empty
- token pool: empty for this run

Start the board and wait for steady state (no launch for 60 s). Then record, from
`GET /api/v2/state` (`load` is published there) or the panel:

| Field | Where | What it tells you |
|---|---|---|
| `load.ceiling` | `state.load` | how many sessions the model allows |
| `load.binding` | `state.load` | which fact decides (`hardware` / `tokens` / `operator`) |
| `load.running` | `state.load` | how many actually run |
| `load.reasons[].raw` | `state.load` | the REAL measured figure (free bytes, pool) |
| `load.tokens.measured` | `state.load` | provider-reported tokens so far |
| `attention.items[].reason` | `state.attention` | `load_exhausted` rows, with their title |

Also note by hand:

- sessions actually launched (count), and the wall-clock time to reach it;
- any card queued with `load_exhausted` while `running < ceiling` (that would be a
  bug: the gate must not refuse below its own ceiling);
- Task Manager / `Get-Process` at steady state: total RAM of the DSH process.

## 3. Read the result (5 min)

Three outcomes, three different follow-ups:

1. **`binding: hardware`, `load.running` ≈ 50, RAM comfortable.** The calibration
   (8 sessions/core, 128 MiB each) holds. Change `P11-1` from "heuristic" to
   "measured on <machine>" in `docs/LIMITATIONS.md` and paste the numbers.
2. **`binding: hardware`, `load.running` well below 50 because `freeBytes` is
   small, while the process is clearly fine.** `freemem()` is lying (it does on
   Windows). Declare the machine instead: `policy.load.hardware = { parallelism,
   freeBytes }` with what the box really has, and record why.
3. **`binding: hardware`, `load.running` ≈ 50, RAM exhausted or swaps.** The
   guard is too generous: lower `SESSIONS_PER_CORE` or raise
   `BYTES_PER_SESSION` in `src/contracts/load-budget.js`, and say so with the
   numbers. This is the only outcome that requires a code change.

Then, for the token pool (10 min):

- set `tokenBudget` to a value you can check by hand (for instance 20 turns'
  worth), start a new wave (`Nouvelle vague`), and let the board run until it
  queues with `load_exhausted`;
- compare `load.tokens.spent` with what the provider dashboard says for the same
  period. The model bills `inputTokens + outputTokens` from
  `baseline.usage`; cache reads are reported apart and their discount is
  provider-specific (`P11-2`). A gap of more than ~10 % means the price per turn
  needs the provider's own pricing, not ours.

## 4. What would FALSIFY the model

Write these down if you see them; each one is a design bug, not a tuning issue:

- a launch queued with `load_exhausted` while `running < load.ceiling`;
- `load.binding: "tokens"` with an empty `tokenBudget`;
- `load.ceiling: 0` with an empty pool and free RAM (the machine floor must keep
  at least one session runnable);
- `load.tokens.spent` moving downwards without a wave reset;
- any `500` on `/state` while the board is running (that was the incident class:
  an unguarded service probe).

## 5. Record it

Add a row to `docs/PERFORMANCE.md` with the machine, the numbers, and the verdict,
and update `P11-1` / `P11-2` in `docs/LIMITATIONS.md`. Until then, both stay
open, and the honest answer to "does it hold at fifty?" remains: not measured.
