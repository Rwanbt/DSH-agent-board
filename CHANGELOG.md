# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-15

The load release: the board stops counting STARTS per hour and starts measuring
what a launch costs right now — the machine it runs on and the tokens it bills.

### Added

- **Real-time load contract** (`src/contracts/load-budget.js`): the effective
  ceiling is the smallest of the operator's own value, the machine (parallelism
  and free memory, or an explicit pair) and the remaining token pool. The binding
  source is published with every `/state`, plus each reason's effective AND raw
  figure, so a queue is explained instead of looking dead.
- **Measured token pool**: `ctx.get('tokenMeter')` (the inject-free read) turns
  the provider-reported usage into a ceiling; `policy.load.tokenBudget` is the
  pool and `policy.load.tokensPerTurn` its price (measured, else the documented
  fallback). `POST /api/v2/load/reset` starts a new wave and is audited.
- **Migration of the old ceilings** (once, audited as `load_model_migrated`): a
  document written by 0.1.0 carries `maxConcurrentDelegations: 2` and
  `maxDelegationsPerHour: 6`; those two documented defaults become `null` ("no
  ceiling of its own", the load model decides) while a value the operator chose
  is preserved.
- **Cockpit**: the settings panel shows the published load (running/ceiling and
  the binding fact), edits the token pool and starts a new wave.

### Changed

- `maxDelegationsPerHour` is no longer the lever: it is an advanced safety valve,
  shown last, and an explicit `null` now means "no rate limit at all".
- A spent pool or a full machine QUEUES a card (`load_exhausted`); a running
  session is never preempted to make room.

### Fixed

- A `null` rate limit was compared with `<`/`>=`, so "unlimited" refused every
  delegation (`src/orchestrator/delegation.js`, `src/supervisor/super-orchestrator.js`).
- Two documents declaring the same line were collapsed into one work item, so a
  distinct section could be skipped as already done.
- Reading an undeclared Cordis service as a property throws; the executor probe
  now answers `undefined` for an absent capability instead of aborting its caller.

## [0.2.0] - 2026-11-15

The production-ready autonomy release: the cockpit sees the inbox, a finished turn
is no longer taken for finished work, concurrency is configuration instead of a
constant, and one operator can supervise fifty sessions by exception.

### Added

- **Decisions contract v1** (`src/contracts/decisions-schema.js`): one versioned
  payload `{schemaVersion, pending, recent, summary}`, strict on emit and tolerant
  on decode (the legacy flat array of a 0.1.0 host still reads). The cockpit inbox
  badge and the panel now show the real pending decisions.
- **Turn-outcome classifier** (`src/host/turn-outcome.js`): `verified_done` /
  `needs_continuation` / `failed`, with `MAX_CONTINUATIONS = 3`, a validated
  structured completion report, and a proof requirement (new commit, validated
  report, or a moved card). `turnFinished` and `workVerified` are separate facts.
- **Operator `reopen`**: `POST /api/v2/assignments/:id/reopen {reason}` puts a
  settled item back in the dispatchable pool, with the reason journaled.
- **Work identity vs content fingerprint** (`src/orchestrator/project-work.js`):
  identity is the locator (document + line, issue number), content is title +
  objective + criteria + referenced block. A reworded line is a new revision of
  the same item; a moved line keeps its proven state. Pure
  `migrateWorkJournalV1toV2` for a journal written by 0.1.0.
- **One effective autonomy level** (`effectiveAutonomyOf` in
  `src/contracts/mandate.js`): global ∩ project ∩ integration, published as
  `autonomy` and `mandate.effectiveLevels`; the cockpit reads only that.
- **Configurable concurrency** (`src/contracts/concurrency.js`): unlimited is
  explicit (`null`), a freeze is still `0`, per-project and per-provider ceilings
  queue instead of failing, and the Super Agent budget is policy.
- **Per-worktree concurrency**: the lock is the working tree, so distinct
  worktrees run in parallel while a shared directory stays serialised across both
  backends.
- **Attention queue** (`src/supervisor/attention.js`): pending decisions,
  unverified work, permission/tree/budget blocks in one ranked, deduplicated queue
  with a suggested action, an effort estimate and a per-project digest; plus the
  product KPIs (`interventionsPerHour`, `medianTimeToDecisionMs`,
  `sessionsPerOperator`, `itemsBlockedOnHuman`), graded trust suggestions (never an
  automatic permission promotion) and an exceptions-only cockpit mode from 8
  agents.
- **Bulk decision answer** (`POST /api/v2/superagent/decisions/bulk`): one gesture,
  every grant still single-use.
- **Mobile band**: a 56 px single-row status strip at ≤430 px with one exception
  badge, instead of a ~185 px wrapped panel.
- **Concurrency settings in the inspector**: global, supervision, Super Agent agents
  and per-provider ceilings, plus an inherited per-project ceiling, with an exact
  running/limit readout (`null` spelled "unlimited").
- **Grouped approval in the inbox** and **Do not disturb**: same-scope approvals
  are answered in one gesture (each grant single-use), and DND mutes the
  notification flag while the badge keeps counting.
- **Graded trust is surfaced**: the settings list the "approved N times without
  incident" proposals; nothing is promoted automatically.
- **CI** (`.github/workflows/ci.yml`) on push/PR to `dev` and `main`:
  `npm run check`, bundle freshness, `git diff --check`.
- **Privacy guard** (`tests/no-personal-traces.test.js`) and personal paths
  replaced by the `<user>` placeholder in every tracked file.
- **Release checklist** (`docs/RELEASE-CHECKLIST.md`), ADRs 0001/0002, and
  `scripts/smoke-host.mjs` / `scripts/verify-live.mjs` extended with the new
  invariants and the prepared (not executed) live steps.
- **50-session performance budget** documented in `docs/PERFORMANCE.md`.

### Changed

- The published `superagent.decisions` is the versioned object; the client decodes
  it (the `Array.isArray` guess is gone).
- An unknown `turn/end` kind and `cancelled` are failures, never `done`.
- `max-tokens` never settles `done` and never asks for review.
- The dry run publishes `limits.effectiveConcurrent` and
  `limits.maxConcurrentAgents` from policy.
- The published mandate carries `effectiveLevels` and `autonomy`; the published
  identity level is derived, never a stale copy.

### Fixed

- The decisions inbox was always empty in the UI (host object vs client array).
- A truncated turn was recorded as `DONE`/`succeeded` and its card moved to
  `in_review`.
- `/mandate/level` left `superagent.identity.level` stale, so the banner showed L0
  after an operator selected L3.
- The work-item fingerprint hashed the title, so a moved line lost its history and
  a reworded line kept a stale "done".
- Concurrency was capped at 2/8/16 whatever the operator asked for.

### Security

- No new credential read; the credential-key allow-list test still passes.
- Shared-state writes remain fenced and single-writer; the release scripts never
  print a token.

### Known limitations

See `docs/LIMITATIONS.md` (Lot 10 addendum) — notably: fifty simultaneous HOST
sessions need worktree isolation, which only the `taskboard`/`contract` backends
provide; no live provider outage or 50-session host was exercised in this round.
