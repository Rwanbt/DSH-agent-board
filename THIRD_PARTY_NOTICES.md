# Third-party notices

This project does **not** vendor or copy source code from the projects below.
They were cloned (shallow) and read during the audit that preceded the
implementation; the table records what was retained as knowledge, with the
pinned commit and the license observed at that commit.

| Project | Commit | License | What was retained |
|---|---|---|---|
| [ccll/dsh-activity-pane](https://github.com/ccll/dsh-activity-pane) | `f7c23a7752d12c6e7c26be2240baa488bcc35548` | MIT | Knowledge of the native `sessions.list` / `uiSession.sessionStatus` / `uiWorkspace.openSession` contracts, and of the “final segment of the last turn” idea. Our projection, UI, CSS and click handling are original. |
| [Rwanbt/dsh-taskboard](https://github.com/Rwanbt/dsh-taskboard) | `056e039f01dca85451610df6977b7ef934fb3a81` | Apache-2.0 | Knowledge of the `ctx.agents.create` + `inject`/`followup` launch pattern, the `/dsh-taskboard` HTTP+SSE contract used read-only here, and the human-only `done` rule. No file copied; no ledger access. |
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | MIT | Conceptual vocabulary (mandate, assignment, trigger, channel). No code transplanted. |
| [Anil-matcha/open-duet](https://github.com/Anil-matcha/open-duet) | `32dd0edbc1f074e68727c82b39b77db1b4200eb9` | see upstream repository | Audited only; not integrated. |
| [omdsh-dev/dsh-llm-fallbacks](https://github.com/omdsh-dev/dsh-llm-fallbacks) | `32d58e75ea9ab72e4f35beb9d85df8d71d213fe7` | MIT | Knowledge of its documented limitation (post-first-chunk errors cannot be replaced in the same request), which motivated the task-level handoff. The plugin is not installed and no API is claimed. |

DeepSeek Harness itself (`@deepseek-ai/*` packages, version `0.2.2-rc.1`) is used
as a runtime platform through its public plugin services. Its packages remain
under their own licenses and are not redistributed here.

If a future change copies code from one of these projects, the corresponding
license text and copyright notice must be added to this file before release.
