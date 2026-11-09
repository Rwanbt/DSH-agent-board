# Provenance, versions and compatibility

Audit performed at the start of the session (2026-11-09), before any code was
written. Reference repositories were cloned with `--depth 1` into
`D:\App\_dsh-refs` for inspection only; nothing from them is vendored here.

## Host

| Component | Version | Evidence |
|---|---|---|
| DeepSeek Harness desktop runtime | `0.2.2-rc.1` | `app.asar/dsh/package.json` (`@deepseek-ai/dsh-desktop-runtime`) |
| Active profile | `desktop` | `DSH_PROFILE=desktop`, `~/.dsh/profiles/desktop` |
| Web GUI origin | `http://127.0.0.1:62337` | runtime context / `webServer.getOrigin()` |

## Reference repositories

| Repository | Version | Commit | License | Role in this build |
|---|---|---|---|---|
| [ccll/dsh-activity-pane](https://github.com/ccll/dsh-activity-pane) | 0.18.0 | `f7c23a7752d12c6e7c26be2240baa488bcc35548` | MIT | **Studied**, not vendored. Source of the native data model used here: `sessions.list` snapshot (`ids`/`byId`/`projectionsBySession.subagentCatalog`), `uiSession.sessionStatus` (`running`, `pendingInteraction`, `completionUnread`), `uiWorkspace.openSession`. Our projection and UI are independently written, with the requested click/double-click semantics. |
| [Rwanbt/dsh-taskboard](https://github.com/Rwanbt/dsh-taskboard) | 0.10.2 | `056e039f01dca85451610df6977b7ef934fb3a81` | Apache-2.0 | **Studied.** Source of the working pattern used here: `ctx.agents.create({sessionId, meta:{cwd}, agentOptions})` + `agent.inject()`/`followup()`, the `/dsh-taskboard` HTTP+SSE shape, and the human-only `done` rule. The board only reads `/dsh-taskboard/state`; it never writes the ledger. No source file was copied. |
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 0.1.0 | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | MIT | **Studied** conceptually (Source → Trigger → Thread → Eval → Mandate → Ticket → Assignment → Executor → Channel, dedupe/policies/recovery). No code transplanted; the vocabulary (mandate, assignment, channel) informed the contracts. |
| [Anil-matcha/open-duet](https://github.com/Anil-matcha/open-duet) | n/a | `32dd0edbc1f074e68727c82b39b77db1b4200eb9` | see repo | **Audited only.** Not integrated; its persistent-agent/memory model did not map onto a DSH plugin without a larger port. |
| [omdsh-dev/dsh-llm-fallbacks](https://github.com/omdsh-dev/dsh-llm-fallbacks) | 0.8.2 | `32d58e75ea9ab72e4f35beb9d85df8d71d213fe7` | MIT | **Studied, not installed.** Its documented limitation (an error after the first chunk may not be replaced inside the same request) is exactly why this plugin implements a task-level checkpoint/handoff stage. The virtual `FallbacksChain` mechanism was not wired: the profile does not run the plugin, so no live chain integration is claimed. |

## Compatibility matrix

| Combination | Status | How established |
|---|---|---|
| DSH 0.2.2-rc.1 (desktop) + Agent Board | ✅ live | panel registered, sessions projected, real launch + `in_review` |
| DSH 0.2.2-rc.1 + dsh-taskboard 0.10.2 | ✅ read-only | `GET /dsh-taskboard/state` used live during the E2E task |
| Agent Board + dsh-activity-pane | ⚪ not tested | activity-pane was not installed in this profile; no shared service is registered by this plugin |
| Agent Board + dsh-llm-fallbacks | ⚪ not tested | plugin not installed; the router is task-level and independent |
| Agent Board + older DSH (< 0.2.2) | ⚪ unknown | `uiSession.sessionStatus` and `uiWorkspace.openSession` are required for exact statuses/navigation; the code degrades to `unknown`/no navigation if absent |

## Licenses kept

- This project: MIT (`LICENSE`).
- No third-party source file is copied, so no notice is required for the
  references above; `THIRD_PARTY_NOTICES.md` records the reviewed projects and
  their licenses anyway, with the exact usage (“studied”, not “vendored”).
- The plugin icon (`icon.svg`) is original artwork authored for this project.

## Reproducing the audit

```sh
git ls-remote --heads https://github.com/ccll/dsh-activity-pane.git
git clone --depth 1 <repo> && git -C <repo> rev-parse HEAD
```

The manifest above is the pinned result of that audit; `README.md` in DSH’s
`app.asar` was read with `scripts/asar-peek.mjs` (a read-only ASAR reader added
for this audit, because shell tools cannot read inside `app.asar`).
