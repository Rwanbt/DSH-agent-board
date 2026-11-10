# GOAL 3 — Delivery report (supervision cockpit and autonomous orchestration)

**Branch:** `goal3/supervision-orchestration` (from `dev`)
**Base:** `8f9ebff` (merge of the GOAL 2 runtime and the validated UX v2)
**Date:** 2026-11-10
**Environment:** DSH `0.2.2-rc.1`, Node `v26.13.0`, Windows 11

> Verdict and the exact test counts are in the last section. Nothing below claims
> a live integration that was not actually exercised: the distinction between
> unit / simulated / host-integration / live-isolated-host evidence is explicit
> everywhere.

## 1. What was asked, what was delivered

| Goal area | Delivery | Evidence |
|---|---|---|
| §3 Reliable supervision of sessions and sub-agents | statuses `interrupted`, `provider_unavailable` added; `recentlyFinished` view flag; deleted session stays `unknown` with `session_gone`; orphan/cycle handled with `parentReason`; **native model/provider** resolved from the real `modelSelection` session projection; a model change keeps ONE card with history; `waiting_agent` deliberately NOT invented (documented investigation) | `src/supervisor/projection.js`, `tests/supervision-status.test.js`, `tests/supervision-identity.test.js`, `docs/ARCHITECTURE.md` |
| §4 Preserve the validated UX | no redesign: cards, per-project trees, branches, collapsible subtrees, active ring, yellow human pill, green unread pill, old history hidden, click/double-click/mobile/keyboard preserved; one compact model/provider chip added | `docs/e2e/GOAL3-E2E.md` (screens), `tests/board-view.test.js`, `tests/interaction.test.js` |
| §5 OFF / SUPERVISED / AUTONOMOUS | already gated by one `authorizeLaunch`; now also counts the budget and refuses a conflicting route policy; Stop remains separate and blocks delegation | `src/host/index.js`, `tests/host-governance.test.js` |
| §6 Versioned Task Board integration | **new** `src/connectors/taskboard-contract.js`: negotiation, lease, attach, report, release, settle; all-or-nothing write gate; `docs/TASKBOARD-CONTRACT.md` formal proposal; simulated implementation with idempotency/conflict semantics | `tests/taskboard-contract.test.js`, `tests/fixtures/fake-taskboard-server.mjs` |
| §6.3 One unified execution backend | **new** `executionBackend:'contract'`: lease → board-created session (failover stays possible) → attach → settle + `requestReview`; a handoff leases a **second attempt** with `previousExecutionId`; worktree isolation honoured or refused; absent extension = `contract_unavailable`, zero POSTs | `tests/unified-backend.test.js` |
| §7 Multi-model / multi-provider routing | explicit chain, retry/switch/handoff; **return to primary** at a safe boundary; per-project layered policy (most-restrictive-wins, conflict = refusal); token/cost explicitly unavailable | `src/routing/{router,policy,budget}.js`, `docs/FAILOVER.md`, `tests/routing-*.test.js`, `tests/budget.test.js` |
| §8 Continuity and resilience | fencing enforced on writes (`checkFencing`), a superseded writer cannot settle; restart releases the contract lease; one-writer lock, atomic journal, coalesced ticks, bounded retries | `tests/fencing.test.js`, `tests/resilience.test.js`, `tests/unified-backend.test.js` |
| §9 Multi-engine adapters | honest executor capability registry (`discover…getStatus`), real DSH adapter, skeletons declaring nothing; Claude Code/Codex/OpenCode capability research | `src/executors/*`, `docs/ADAPTERS.md`, `tests/adapters-capabilities.test.js` |
| §10 Supervision performance | deterministic benchmarks 5/20/50/150 agents + 1 000 historical sessions, p50/p95, linear-scaling guard | `docs/PERFORMANCE.md`, `tests/perf-projection.test.js` |
| §11 Budgets and limits | concurrency, tasks/hour, requests/hour, retries, switches, cooldown enforced; token/cost reported unavailable | `src/routing/budget.js`, `docs/FAILOVER.md` |
| §12 Security | audit + executable controls: prompt-injection delimiting, permission clamp, trust gate, secret redaction, no HTML sink, no credential reads | `docs/SECURITY-AUDIT.md`, `tests/security.test.js` |
| §13.5 E2E on a real isolated host | disposable `DSH_HOME`, fake OpenAI-compatible provider, simulated Task Board extension: task → session → real model turn → lease/attach/settle → `in_review`, then 429 → release → second execution on the backup route | `docs/e2e/GOAL3-E2E.md`, `scripts/e2e/run-e2e.mjs` |
| §15 Independent review | two fresh reviewers (backend orchestration/routing/contract; supervision/UI), findings + non-regression tests | `docs/REVIEW-GOAL3-BACKEND.md`, `docs/REVIEW-GOAL3-SUPERVISION.md` |
| §17 Deliverables | code, commits, architecture, orchestrator/adapter/contract/failover docs, recovery procedure, tests, E2E report, benchmarks, security audit, review reports, compatibility, install/rollback, residual limits | this file + linked docs |

## 2. Architecture after GOAL 3

```text
[ Agent Board panel ]
   native: sessions.list (+ per-session modelSelection projection), uiSession.sessionStatus
   host:   GET /state, GET /contract, SSE /events; POST /mode /policy /stop /resume /tick /ack /dispatch
        │
[ Host plugin ]
   supervise: projection statuses (with provenance) + native model + host health
   orchestrate: mode gate → mandate → dependency eligibility (Task Board) → concurrency → budget
   execute:  backend board | taskboard | contract
   failover: retry → switch → handoff(new session, checkpoint, same logical task)
   recover:  restart reconciliation, lease watchdog, fencing, checkpoint verification
        │
[ Task Board ]  canonical task + execution + claim + worktree + validation
   reads ONLY /dsh-taskboard/state (+ /contract probe)
   writes ONLY through the proposed execution contract (lease/attach/report/release/settle)
```

Full detail: `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/FAILOVER.md`,
`docs/TASKBOARD-CONTRACT.md`, `docs/ADAPTERS.md`, `docs/PERFORMANCE.md`.

## 3. Test inventory (evidence classes)

| Class | What it proves | Command |
|---|---|---|
| Unit (pure) | routing decisions, budget windows, fencing, projection statuses, view grouping | `node --test tests/` |
| Contract simulation | Task Board extension semantics against a simulated server (`x-simulated-contract: true`) | `node --test tests/taskboard-contract.test.js` |
| Host integration | the real HTTP API + real host code against fakes (`ctx`, fetch) | `node --test tests/host-*.test.js tests/unified-backend.test.js tests/security.test.js` |
| Live isolated host | real DSH process, real plugin, real HTTP, real model request to a fake provider; simulated Task Board extension | `node scripts/e2e/run-e2e.mjs` |
| Benchmarks | projection at 5/20/50/150 agents and 1 000 sessions (synthetic fixtures) | `node scripts/bench/projection-bench.mjs` |

**Not tested / not claimed:** a real Task Board implementing the proposed
extension; a real provider outage (429/5xx) on a real provider; Linux; a
multi-host deployment; process-level crash injection during a handoff.

## 4. Residual limits (also in `docs/LIMITATIONS.md`)

1. The Task Board execution contract is **simulated**: the real 0.10/0.11 plugin
   has no `/contract` route, so `executionBackend:'contract'` is refused against
   it (`contract_unavailable`), by design. The two legacy backends remain.
2. **No contract lease renewal**: a single turn longer than the lease TTL is not
   renewed (proposed `POST …/renew`).
3. External effects remain `effect:unknown`; the board cannot reconcile a
   commit/comment/push after a handoff.
4. Secret redaction is pattern-based.
5. `dsh-llm-fallbacks` is still not installed; in-request fallback is out of
   scope by design (the board hands the TASK off, never fakes request resumption).
6. Performance numbers are synthetic fixtures, not a live load test.

## 5. Branch and commits

```
goal3/supervision-orchestration
  5488797 chore(ux): checkpoint the in-progress UX v2 client work before GOAL 3
  8f9ebff merge: GOAL 2 runtime + UX v2 checkpoint into GOAL 3 branch
  5acd3b5 feat(goal3): unified Task Board execution contract, layered routing/budget/fencing, supervision statuses
  …       (this delivery: reviews, docs, E2E evidence, fixes)
```

`main` and `D:\App\dsh-taskboard` were not modified.

## 6. Verdict

See the final section of `README.md` / the session report: **PARTIAL** — every
independently testable P0 item is implemented and tested (including a live
isolated-host E2E with a fake provider), but the Task Board execution contract
is a **simulated** extension and no live provider outage was provoked, so the
"real integration" part of §6.3/§13.4 cannot be claimed.
