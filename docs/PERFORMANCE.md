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

The 125-session build is sub-millisecond; the 0.5 ms floor prevents timer noise
from producing a false super-linear verdict. It does not hide a quadratic
implementation: 64× the 125-session cost would exceed the 8× ratio by a wide
margin.

## Reproduce

```bash
node scripts/bench/projection-bench.mjs              # timings + client store
node --expose-gc scripts/bench/projection-bench.mjs  # adds the heap column
node --test tests/perf-projection.test.js
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
