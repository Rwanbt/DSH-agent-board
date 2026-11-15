# ADR 0001 — Turn end is not work done

- **Status**: Accepted
- **Date**: 2026-11-15
- **Scope**: `src/host/turn-outcome.js`, host `onTurnEnd`, work-item readiness, decisions inbox

## Context

A `turn/end` event is a statement about the MODEL, not about the work: it says the
model stopped producing tokens, not that a change exists. The host nevertheless
treated `completed` — and even `max-tokens`, a truncated answer — as `DONE` and
settled the canonical execution as `succeeded`, which asked the Task Board to move
the card to `in_review`. A run cut in half by the token limit therefore reached the
ledger looking finished, and nothing re-ran it: the operator was told "done" by a
green card while the work did not exist.

## Decision

One pure classifier (`classifyTurnEnd`) decides between three verdicts from
observable facts only:

- `verified_done` — the host holds a proof: a new commit on the working branch
  (compared with the HEAD captured at launch), a validated structured result
  (`{status:"done", summary, testsRun|commit}` — a bare `{"status":"done"}` is NOT
  proof), or a Task Board card the agent really moved;
- `needs_continuation` — the turn ended without proof and the bounded budget
  (`MAX_CONTINUATIONS = 3`) is not spent: the SAME session is re-prompted with an
  explicit "prove it" instruction;
- `failed` — no proof and nothing left to try, or the ending itself carried a
  failure (`error`, `cancelled`, unknown kinds).

`turnFinished` and `workVerified` are journaled as two different facts. Only
`verified_done` settles the assignment `done`, only it calls
`settleContractExecution(..., 'succeeded')`, and only a verified, non-reopened
attempt marks a project work item completed. An operator `reopen` returns an item
to the dispatchable pool with a journaled reason.

## Alternatives rejected

- **Trust the model's claim.** Cheapest, and it is exactly the failure: an agent
  can always type `{"status":"done"}`. A structured result must therefore carry
  evidence (tests run or a commit) to count.
- **Treat every completion as a failure unless a human confirms.** Safer, but it
  reintroduces the human bottleneck the product exists to remove.
- **Infer success from "no error".** Silence is not evidence; an empty diff is the
  most common false positive.

## Consequences

- A truncated or unproven turn no longer reaches `in_review`; the operator sees an
  inbox entry after the bounded continuations instead of a green card.
- A provider call is spent on each continuation, bounded to 3 per attempt.
- A journal written by 0.1.0 has no `workVerified`: it stays trusted (`!== false`)
  so an upgrade never re-dispatches every historical item.
- The card-move proof collapses to "the ledger status changed since launch"; a
  ledger that cannot be read only removes one source, never fakes one.
