# ADR 0002 — Per-worktree concurrency

- **Status**: Accepted
- **Date**: 2026-11-15
- **Scope**: `src/contracts/concurrency.js`, launch preflight, `project-work.js`, routing budget

## Context

Every technical ceiling was a hard-coded clamp: `maxConcurrent` 0..8 (default 2),
`maxConcurrentDelegations` 0..16 (default 2), a literal `maxConcurrentAgents: 2`,
and one synthetic work item per project at a time. A developer can follow about
five sessions by attention; the board could not even run fifty by configuration.
The technical limit had become the product limit.

The "one item per project" rule existed for a real reason: a synthetic dispatch
writes into the project's SHARED directory, so two of them race on the same files
and on `.git/index.lock`. The rule was right about the resource and wrong about
its granularity: what must be serialised is the working TREE, not the project.

## Decision

- One module (`src/contracts/concurrency.js`) owns every normaliser: `null` means
  UNLIMITED, `0` keeps its historical meaning (a real freeze), and a named
  `CONCURRENCY_HARD_CEILING = 256` only guards a typing mistake. Defaults do not
  move (2/2/6/12), so an upgrade changes no behaviour silently.
- `superagent.budget` (agents, cycles/hour, calls/hour) becomes policy, persisted
  and validated like every other limit.
- Per-project (`mandate.projects[id].maxConcurrent`) and per-provider/model
  (`policy.providerConcurrency`) ceilings are enforced at launch. A provider
  ceiling QUEUES the work (the card stays dispatchable); it never fails it.
- The lock key is the working tree: `worktree:<project>:<assignment>` for an
  isolated attempt, `shared:<project>` otherwise. Distinct worktrees run in
  parallel; a shared directory is serialised across BOTH backends (P1-F).
- The effective global value is `min(global, supervision)` computed once, and
  `null` propagates as "unlimited" instead of being coerced to 0 by a raw `>=`.

## Alternatives rejected

- **Raise the clamps to a big number.** Still a ceiling, still not configurable,
  and it hides the real limit (the provider's rate limit, no the board's).
- **`0` = unlimited.** Tempting for symmetry, but an operator typing `0` to freeze
  the board would have unlocked everything: a silent inversion of a safety
  semantic that an existing test pinned. `null` unlocks; `0` freezes.
- **Serialise per project forever.** Safe and slow: it forbids two cards with
  their own worktrees from ever running together, which is most of the target
  parallelism.

## Consequences

- One developer can configure the board to whatever the machine and the provider
  sustain; the tested dispatch path launches 50 items across 10 projects.
- Two shared-tree attempts in the same project still wait for each other, and the
  refusal keeps its name (`project_work_in_progress`).
- Fifty simultaneous HOST sessions additionally require worktree isolation, which
  only the `taskboard`/`contract` backends provide (documented limitation).
- The plan is bounded by the provider's own rate limits, which stay external.
