# Agent executors and their real capabilities

Agent Board is designed to supervise engines other than DSH, but a capability
matrix is only useful if it is true. The rule in code is simple: **an adapter
declares a capability only if it implements a callable method with that name**.
`defineAdapter()` throws at registration when a declared capability has no
method, and `createAdapterRegistry().describe()` reports the *declared* matrix —
a skeleton with throwing stubs cannot look like a working integration.

The authoritative executor definitions live in `src/executors/`:

| File | Contents |
|---|---|
| `src/executors/dsh.js` | the real DSH executor adapter factory |
| `src/executors/skeletons.js` | `claude-code`, `codex`, `opencode` — declare nothing |
| `src/executors/index.js` | `createExecutors({ ctx })` registry facade |

`src/connectors/registry.js` still carries the panel's older hand-built
`executors` summary (`create`/`observe`/`cancel` keys). It predates the
vocabulary below and is not the capability contract; `createExecutors()` is.

## Capability vocabulary

The executor vocabulary is closed per adapter kind
(`CAPABILITIES_BY_KIND.executor` in `src/contracts/adapters.js`):

| Capability | Meaning | Implementing method |
|---|---|---|
| `discover` | enumerate known sessions/agents | `discover()` |
| `observe` | status facts for one session, with provenance | `observe(sessionId)` |
| `getSession` | session metadata (cwd, parent, origin, preset…) | `getSession(sessionId)` |
| `getChildren` | direct sub-agents of a parent session | `getChildren(parentSessionId)` |
| `launch` | start a new agent session | `launch(options)` |
| `cancel` | stop the current turn/agent | `cancel(sessionId)` |
| `resume` | rebuild an agent on a persisted session | `resume(sessionId)` |
| `openSession` | open the session in the host UI | `openSession(sessionId)` |
| `readLastOutput` | last final output of a session | `readLastOutput(sessionId)` |
| `getModel` | provider/model selection for a session | `getModel(sessionId)` |
| `getStatus` | cheap status probe | `getStatus(sessionId)` |

Work-source and forge capabilities (`list`, `get`, `subscribe`, `create`,
`update`, `comment`, `transition`, `run`) are unchanged; declaring a
work-source capability on an executor (or vice versa) is refused. The
work-source/forge matrix itself remains in `docs/CONTRACTS.md`.

## Executor matrix

`validated live` means "this adapter was exercised against a real engine", not
"the underlying host APIs exist". A `—` means the adapter does not implement the
capability at all.

| Engine | Kind | discover | observe | getSession | getChildren | launch | cancel | resume | openSession | readLastOutput | getModel | getStatus | Validated live | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `dsh` | executor | ✅ | ✅ | ✅ | ✅* | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | **No** | Native `ctx.agents` / `ctx.sessions` / `ctx.subagents`. *`getChildren` is declared only when the given ctx has `subagents.listChildren`. Not wired into the host launch path yet. |
| `claude-code` | executor | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **No** | Installed one-shot external provider; the board holds no activation handle and creates no child Session. Skeleton declares nothing. |
| `codex` | executor | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **No** | No Codex subagent provider installed in this profile; nothing to bind. Skeleton declares nothing. |
| `opencode` | executor | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | **No** | No OpenCode subagent provider installed; nothing to bind. Skeleton declares nothing. |

`tests/adapters-capabilities.test.js` asserts this matrix, the
declared ⊆ implemented rule, the empty skeleton declarations, the presence of
notes, and that no adapter claims `resume` without a `resume()` method.

## DSH executor (`src/executors/dsh.js`)

`createDshExecutor(ctx)` reads the host services directly and declares each
capability only when the matching method exists on that ctx:

| Capability | Implementation | Fact source |
|---|---|---|
| `discover` | `ctx.agents.list()` merged with `ctx.sessions.list()` | Agent `status`, Session `header` |
| `observe` | `ctx.agents.get(id)`, else `ctx.sessions.get(id)` | `AgentStatus` (`'idle' \| 'running'`); a Session without a live Agent is `unknown` |
| `getStatus` | same probe as `observe`, status only | as above |
| `getSession` | `ctx.sessions.get(id)` / `ctx.agents.get(id)?.session` | `SessionHeader` |
| `getChildren` | `ctx.subagents.listChildren(parentId)` | durable `subagentCatalog`; `mode: 'external'` entries are leaves |
| `launch` | `ctx.agents.create({ sessionId, meta:{cwd}, agentOptions })` | live agent factory |
| `cancel` | `agent.cancel({ kind: 'user' })` | the host Stop cause |

Conditional declarations are deliberate: a headless host without
`ctx.subagents` does **not** advertise `getChildren`, and a sessions-only host
does **not** advertise `launch`/`cancel`. Tests cover both shapes.

### Why the missing capabilities are not declared

| Capability | Why not |
|---|---|
| `resume` | this adapter never calls `ctx.agents.resume`; exposing it would claim a restart path the board does not use |
| `openSession` | opening a session in the UI is a client action; no host open-in-UI service is bound here |
| `readLastOutput` | the board keeps previews in its own host state; no session-output read is performed |
| `getModel` | `SessionHeader` has no model field. `agent.model.current()` exists for a **live** agent, but that is a live-agent fact, not a session-header fact, so no per-session model read is claimed |

`validatedLive` is `false` even though the host's existing orchestrator uses the
same `ctx.agents` APIs: the *adapter factory* is not wired into the launch path
yet, so it has only been exercised against a fake ctx.

**To promote to validated live:** construct `createExecutors({ ctx })` in the
host, route `launchTask`/Stop/observe through the adapter, then run one real
launch → observe → cancel cycle and record it. No capability has to be added for
that; only `validatedLive` changes.

## Claude Code: what the installed provider actually does

Evidence: read-only inspection of the installed
`@deepseek-ai/dsh-subagent-claude-code` **0.2.2-rc.1** in
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-subagent-claude-code`
(`package.json`, `README.md`, `lib/index.js`, `lib/types/*.d.ts`).

Its provider interface, exactly:

```js
class ClaudeCodeProvider {
  name                      // providerName, default 'claude-code'
  capabilities = NO_START_CAPABILITIES
                            // { agentOptions:false, agentPreset:false,
                            //   outputSchema:false, depthLimit:false }
  inheritsParentContext = false
  async start(request)      // one fresh Agent SDK query + CLI process
}
// registered with: ctx.subagents.registerProvider(new ClaudeCodeProvider(...))
```

| Question | Answer | Consequence for this matrix |
|---|---|---|
| Start an activation? | **Yes.** `ctx.subagents.startActivation({ provider: 'claude-code', request })` starts one fresh Agent SDK query/process and returns a child id; the final answer (or a safe failure diagnostic) arrives as the activation result. | A future adapter could declare `launch`. |
| List children? | Only through the shared seam: `ctx.subagents.listChildren(parentSessionId)` reads the parent-owned `subagentCatalog`; external runs appear as `mode: 'external'` leaves. The provider itself has no list method. | `getChildren` would be a seam capability, not a provider one. |
| Resume / continue? | **No.** "There is no continuation, resume, pooling, progress stream, or product-session persistence"; external children "expose one execution and reject continuation". | `resume` must stay undeclared, permanently for this provider. |
| Interrupt? | Only the shared activation owns cancellation: `dispose()` cancels the exact activation, and `ctx.subagents.interruptByParent()` interrupts a running descendant. The provider has no cancel method. | `cancel` would require the board to hold the activation handle. |
| Observe / getSession / getStatus? | **No.** No local child Session is created; the parent log keeps the external task identity and terminal result, not a session to observe. | `observe`, `getSession`, `getStatus`, `readLastOutput`, `openSession` stay undeclared. |
| getModel? | The model is fixed per provider instance in Profile configuration (`model` field), not queryable per run. | `getModel` stays undeclared. |
| Agent preset / structured output / depth? | Rejected by the shared service (`NO_START_CAPABILITIES`). | The adapter must not promise preset selection or structured output. |

The board's `claude-code` entry therefore declares **nothing** and has
`status: 'unavailable'`: no `startActivation` call, no activation-handle
registry, and no external-run persistence exist in this build.

**To promote:** add a board adapter that calls
`ctx.subagents.startActivation({ provider: 'claude-code', request })`, records
the returned child id + activation handle, declares `launch` (and later
`cancel` via `dispose()`, `getChildren` via the catalog, `getStatus` from the
activation lifecycle). Keep `resume`, `observe`, `getSession`,
`readLastOutput`, `getModel` and `openSession` undeclared. It becomes
`validatedLive` only after a real end-to-end run (a fake LLM server is not a
Claude Code validation).

## Codex and OpenCode

Neither provider is installed in the desktop profile inspected for this build
(`@deepseek-ai/dsh-subagent-codex` is only a devDependency of the Claude Code
plugin; no OpenCode provider package exists), so neither registers a
`ctx.subagents` provider and there is no start/observe/cancel API to bind.
Both entries declare nothing.

**To promote either one:** install its DSH subagent bundle, inspect its provider
contract (start? continuation? cancellation? model selection?), wire the same
activation-handle pattern as above, and add a live E2E proof. Until then the
matrix stays empty.

## Verifying

```bash
node --test tests/adapters-capabilities.test.js
node --test tests/connectors.test.js
```

The first file asserts the executor matrix, the second keeps the existing
work-source/forge path green.
