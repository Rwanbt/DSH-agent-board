# Performance: session projection

**These numbers come from synthetic fixtures. No live DSH host was load-tested.**
The benchmark builds deterministic snapshots (5/20/50/150 live agents, 1,000
historical sessions, plus a 1,000-deep chain) and times the pure projection. It
does not measure a real session store, real event traffic, React rendering or
network I/O.

Artifacts for the recorded run: `docs/bench/projection-bench.json` (machine
readable) and `docs/bench/projection-bench.txt` (table).

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Pro, `Windows_NT 10.0.26100` (x64) |
| CPU | 13th Gen Intel(R) Core(TM) i7-13620H, 10 cores / 16 logical CPUs |
| RAM | 15.7 GB |
| Node | v26.13.0 |
| Date | 2026-11-10 |
| Fixtures | `scripts/bench/fixtures.mjs` (seeded mulberry32, deterministic) |
| Iterations | 5 warmup + 40 measured, nearest-rank p50/p95/max |

The machine was shared with other processes during the recorded run (other
agents were running their own tests), so p95/max are noticeably above p50. The
medians were stable across repeated runs; the thresholds in the regression test
are deliberately far above both.

## What is measured

| Measurement | How |
|---|---|
| `buildProjection` | `performance.now()` around the pure build, same input object reused |
| `aggregateSubtrees` | same projection, timed separately |
| Retained heap | `--expose-gc`: two forced GCs before and after holding the projection, median of 3 samples; omitted without the flag |
| `/state` payload | `JSON.stringify` of a trimmed `/state` value (acks/previews/turnEnd/assignments + bounded-empty collections), UTF-8 bytes |
| Client rebuilds | the REAL `createBoardStore` with a fake client ctx, a fake clock, 50 native notifications over 1,000 simulated ms, 200 ms coalescing; a renderer is emulated by calling `getSnapshot()` from the store subscription |

Fixture composition (live scenarios): ~60 % roots / ~40 % sub-agents (some at
depth 2), status mix 20 % running, 10 % waiting_user, 20 % finished_unread,
10 % failed, 20 % finished_read, 10 % idle, 10 % unavailable; host
`turnEnd`/`acks`/`previews`/recovering assignments; a `subagentCatalog` on every
parent; four workspaces. The 1,000-session scenario is flat history (no
running agents). The deep-chain scenario links 1,000 sessions as one parent
chain to exercise the cycle guard.

## Results (recorded run)

| Scenario | Nodes | build p50 | build p95 | build max | aggregate p50 | aggregate p95 | Heap (retained) | `/state` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `live-5` | 5 | 0.095 ms | 0.225 ms | 1.915 ms | 0.006 ms | 0.018 ms | ~0 MB | 0.9 KB |
| `live-20` | 20 | 0.232 ms | 0.392 ms | 1.403 ms | 0.025 ms | 0.038 ms | ~0 MB | 3.3 KB |
| `live-50` | 50 | 0.318 ms | 0.822 ms | 5.175 ms | 0.015 ms | 0.027 ms | ~0 MB | 7.9 KB |
| `live-150` | 150 | 0.510 ms | 0.810 ms | 1.072 ms | 0.042 ms | 0.075 ms | 0.02 MB | 23.3 KB |
| `history-1000` | 1,000 | 2.955 ms | 4.258 ms | 5.968 ms | 0.256 ms | 0.724 ms | 0.11 MB | 144.4 KB |
| `deep-chain-1000` | 1,000 | 3.178 ms | 6.388 ms | 10.014 ms | 0.313 ms | 0.682 ms | ~0 MB | 34.0 KB |

Heap values below ~0.1 MB are at the GC noise floor and are shown as `~0`.

Client store, `live-150` payload, 50 native notifications over 1,000 simulated
ms with the real 200 ms coalescing window: **5 projection rebuilds** (90 %
fewer rebuilds than notifications). The count is deterministic under the fake
clock.

## Interpretation

- **The projection is linear in the number of nodes.** 150 agents cost 0.51 ms
  median; 1,000 historical sessions cost 2.96 ms median. The 1,000-deep chain
  costs 3.18 ms median, the same order as the flat 1,000-session run, so the
  current colour-marked cycle detection has no quadratic ancestor scan.
- **The thresholds are regression guards, not capacity limits.** They are two to
  three orders of magnitude above the measured medians (see below).
- **`aggregateSubtrees` is not a cost centre.** 0.26 ms median at 1,000 nodes.
- **Retained memory is small.** 0.02 MB at 150 agents and 0.11 MB at 1,000
  sessions (excluding the fixture data shared with the projection).
- **The client coalescing works.** 50 notifications produced 5 rebuilds, not 50.
- **The `/state` payload is the first thing that would hurt at scale.** It grows
  linearly with finished agents because each carries a preview (the host
  truncates previews to 600 characters). The measured trimmed payload is
  144.4 KB at 1,000 sessions. The host currently emits the full state on each
  change frame; at the synthetic burst rate of 50 notifications/s that is
  ~7.2 MB/s (50 × 144.4 KB) if every notification produced a frame. That is
  arithmetic on two measured values, not a live measurement — but it is the
  only measured number here that suggests a real scaling risk.

## Measured recommendations

1. **Keep the full projection rebuild.** At 1,000 sessions it is 2.96 ms median;
   an incremental index would add state and invalidation bugs for no measured
   benefit at this scale.
2. **Keep the current cycle detection.** The deep-chain case is within ~8 % of
   the flat case at p50, so there is no quadratic scan to remove.
3. **Keep the 200 ms client coalescing window.** It removes 90 % of rebuilds in
   the simulated burst.
4. **If history grows, bound the `/state` payload or coalesce/delta the SSE
   frames.** The measured payload (144.4 KB at 1,000 sessions) is the first
   limit; preview text dominates it. No projection change is needed.
5. **Do not optimise `aggregateSubtrees` yet.** 0.26 ms median at 1,000 nodes.

## Regression thresholds

`tests/perf-projection.test.js` uses these deliberately generous limits so a
shared Windows CI machine does not flake:

| Assertion | Threshold | Measured |
|---|---|---|
| 150 live agents, median build | < 250 ms | 0.51 ms |
| 1,000 historical sessions, median build | < 1,200 ms | 2.96 ms |
| 1,000 vs 125 historical sessions | ratio < 8× (0.5 ms timer floor) | ~4–7× raw, below the floor-adjusted 8× |
| `aggregateSubtrees`, 150 agents, median | < 250 ms | 0.04 ms |
| Client rebuilds, 50 notifications / 1 s | ≤ 8 | 5 |
| `buildOverview` + `buildBoardView`, 15 agents, mean (50 rounds) | < 250 ms | 0.36 ms |
| `buildOverview` + `buildBoardView`, 50 agents, mean | < 250 ms | 0.90 ms |
| `buildOverview` + `buildBoardView`, 150 agents, mean | < 250 ms | 2.68 ms |
| Cockpit component render, 150 cards (VDOM only, React stub) | < 1,000 ms | ~16 ms |

The cockpit model is rebuilt only when its real inputs change (`projection`,
filter, query, project, indicator focus, selection, minute tick); card rendering
is memoized on the facts a card displays, and the toolbar never rebuilds the
hierarchy on a compact-mode toggle or a selection.

The 125-session build is sub-millisecond; the 0.5 ms floor prevents timer noise
from producing a false super-linear verdict. It does not hide a quadratic
implementation: 64× the 125-session cost would exceed the 8× ratio by a wide
margin.

## Reproduce

```bash
node scripts/bench/projection-bench.mjs              # timings + client store
node --expose-gc scripts/bench/projection-bench.mjs  # adds the heap column
node --test tests/perf-projection.test.js
node --test tests/overview.test.js                   # cockpit model + 15/50/150 guard
```

Both benchmark invocations write `docs/bench/projection-bench.json` and
`docs/bench/projection-bench.txt` (override with `--out=DIR`); the JSON summary
is also printed to stdout and the table to stderr.

## Limits

- Synthetic fixtures only; no live host, real session store or event stream was
  load-tested.
- No React/browser rendering, network or SSE throughput was measured.
- One machine, Node 26, shared with other processes during the run.
- Heap numbers exclude the fixture data shared with the projection.
- The 50-notifications/s burst is a synthetic upper bound, not an observed DSH
  notification rate.

## GOAL 6 update — projection re-run and additive payload cost

Two measurements were added with the Super Agent work. Both are synthetic and
say so.

### Re-run of the projection benchmark (2026-11-12, same fixtures)

| Scenario | Nodes | build p50 | build p95 | aggregate p50 |
|---|---|---|---|---|
| `live-150` | 150 | 0.164 ms | 0.278 ms | 0.012 ms |
| `history-1000` | 1,000 | 1.020 ms | 1.678 ms | 0.084 ms |
| `deep-chain-1000` | 1,000 | 0.965 ms | 1.612 ms | 0.119 ms |

Client store: 50 notifications / 1,000 ms → **5 rebuilds** (coalesced). These are
**faster** than the earlier baseline on the same machine (0.510 / 2.955 / 3.178 ms
p50); no regression is observed, but cross-run comparison is noisy and the
absolute numbers remain synthetic.

Command: `node scripts/bench/projection-bench.mjs` → `docs/bench/projection-bench.*`.

### Additive `/state` payload (the new sections)

`scripts/bench/payload-bench.mjs` measures the GOAL 6 sections only (mandate,
portfolio, capabilities, superagent, host) with worst-case bounded lists
(40 directives, 20 pending decisions, 30 activity rows):

| Fixture | mandate | portfolio | capabilities | superagent | **total** |
|---|---|---|---|---|---|
| 5 projects / 25 tasks | 1.3 KB | 2.0 KB | 1.0 KB | 30.1 KB | **34.9 KB** |
| 100 projects / 500 tasks | 8.1 KB | 32.8 KB | 1.0 KB | 61.0 KB | **103.4 KB** |

The Super Agent share is dominated by the **bounded** directive/pending-decision
lists, not by the ledger: the host publishes `directives.slice(-40)`,
`decisions.pending.slice(0,20)` and `activity.slice(-40)`, so it cannot grow with
history. The portfolio grows with the project count (not with task count: tasks
are collapsed to counters). SSE sends the whole state per coalesced frame
(120 ms window), so on a 100-project install each frame is ≈ 100 KB on localhost;
this was not measured over a real SSE transport, and it is one more reason to keep
the project list bounded/selected.

Commands: `node scripts/bench/payload-bench.mjs` and
`node scripts/bench/payload-bench.mjs --projects=5 --tasks=5 --out=payload-bench-small.json`
→ `docs/bench/payload-bench*.json`.

Limits: size only, no serialization latency, no SSE throughput, no browser JSON
parsing measured.

## Lot 5 update — the 50-session budget (production-ready autonomy)

The product target is **one developer supervising 50 simultaneous AI sessions
across 10 projects**. This section records what that costs on the projection and
payload side, measured with the same deterministic fixtures as above.

Re-run (2026-11-15, same machine, `node --expose-gc scripts/bench/projection-bench.mjs`):

| Scenario | Nodes | build p50 | build p95 | aggregate p95 | /state payload | heap delta |
|---|---|---|---|---|---|---|
| live-5 | 5 | 0.051 ms | 0.079 ms | 0.007 ms | 0.9 KB | ~0 MB |
| live-20 | 20 | 0.108 ms | 0.207 ms | 0.017 ms | 3.3 KB | ~0 MB |
| **live-50** | **50** | **0.167 ms** | **0.432 ms** | **0.009 ms** | **7.9 KB** | **~0 MB** |
| live-150 | 150 | 0.233 ms | 0.421 ms | 0.027 ms | 23.3 KB | 0.02 MB |
| history-1000 | 1000 | 1.449 ms | 2.052 ms | 0.142 ms | 144.4 KB | 0.11 MB |

Client coalescing: **50 native notifications in 1 000 ms → 5 projection rebuilds**
(200 ms window), i.e. one rebuild per ~10 events, not one per event.

### Budget this supports

- **Rendering**: a 50-session board rebuilds in well under 1 ms p95; at 60 fps the
  projection is not the cost. The DOM is (see `docs/LIMITATIONS.md`, no
  virtualisation).
- **Network**: 7.9 KB per `/state` frame at 50 sessions, so the SSE stream is not
  the bottleneck on localhost; the portfolio/project count dominates it, not the
  session count.
- **Scheduling**: with the ceilings lifted (`maxConcurrent: null`), one tick
  dispatches 50 items; the host test
  `tests/concurrency-limits.test.js` proves 50 dispatches across 10 projects and
  the work-tree lock (10 parallel shared-tree launches, 40 queued). 50 *simultaneous
  host sessions* additionally require worktree isolation, which only the
  `taskboard`/`contract` backends provide.
- **Attention**: the operator-facing cost is the one measured by the attention
  KPIs (`interventionsPerHour`, `medianTimeToDecision`, `itemsBlockedOnHuman`),
  not by the projection.

### What is NOT measured

- A live host with 50 real provider sessions (no provider quota was consumed):
  `UNVERIFIED — to be run by the operator`.
- Browser paint/DOM cost of 50+ cards on a low-end device.
- Provider rate limits: enforced as a queue, not benchmarked.
