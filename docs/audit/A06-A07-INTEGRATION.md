# A06 / A07 security integration

Inspected, read-only, on installed DSH **0.2.2-rc.2**: `Service.listService` exact contracts for `agents`, `tools`, `permissionPresets`; `Event.listEvents` for `agent/pre-step`; installed package sources. No profile or server mutations.

## Host patch (integrated with lead's permission)

The changes below are now applied only in the import, `createSession`, and `ensureSuperAgentSession` sections; other host edits belong to the lead.

```js
import { createSecuredAgent, effectiveWorkerPermission, secureAssessmentAgent, secureWorkerAgent } from './security.js'
```

In `ensureSuperAgentSession`, replace `await ctx.agents.create(options)` with:

```js
await createSecuredAgent(ctx.agents, options, secureAssessmentAgent)
```

In `createSession`, resolve the explicit permission before creating an agent:

```js
const permission = effectiveWorkerPermission(state.policy, task.permission)
const handle = await createSecuredAgent(ctx.agents, options,
  (agentCtx, agent) => secureWorkerAgent(agentCtx, agent, permission))
```

Delete the former optional/caught permission setter block. Keep title-setting optional. Do not inject framing, work messages, attach work, or return a launch success before secure creation resolves. Propagate creation errors into existing assignment/lease failure settlement; integration tests must verify lease release and visible failure. Do not reuse any pre-fix assessment agent (restart/recycle).

## Why these are real enforcement boundaries

Installed `dsh-agent-loop/src/index.ts:628–655` calls `setup(agent.ctx, agent)` after session attachment but **before agent publication**, under rollback. Rejection cancels/disposes the unpublished agent. `createSecuredAgent` additionally rejects and disposes a compatibility factory that ignores setup or returns a different agent.

Installed `dsh-tools/src/index.ts:162–188` accepts `{ allow: [] }`; only `{}` is an invalid empty filter. This masks global and inherited tools, including future registrations. **Own-scope tools are exempt** (`199–225`). Therefore a scoped executor also verifies that the *actual resolved definitions* received by `describe` are empty, exposes zero schemas/known names, and rejects all raw execution. A monotonic scoped guard denies capability dispatch too. This is stronger than model instructions, filesystem read-only, or a tool-name denylist.

Installed `dsh-agent-loop/src/agent.ts:298–303` resolves tools and assembles the prompt **before** `agent/pre-step`. `dsh-tools/src/index.ts:113–116` passes the admitted selection's definitions to the executor during assembly. No speculative `tools.resolve` probe is performed and no invented `CreateAgentOptions.tools` option is used. Every assessment step is checked, not only initial creation.

Installed `dsh-tools/src/index.ts:325–328` permits one executor per exact scope. A conflicting agent-local executor or any remaining admitted own-scope tools intentionally makes assessment unavailable. Preset-level executor selection can be overridden by the nearer agent scope. An incompatible deployment must use a genuinely tools-free compatible preset, not relax these checks.

Worker default is explicitly `read-only` (and must be permitted by the board policy), not deployment default. `permissionPresets.resolve(permission).sandbox` must match the requested mode; setter must succeed; `current(agent.session)` must report that same effective preset. Missing service/session/method, unknown name, wrong configured sandbox, setter failure, and ineffective setter all reject setup before work. DSH's permission preset controls its sandbox/approval knobs, not arbitrary plugin business effects; A06 separately blocks all assessment tools.

## Compatibility test fakes

Use `applyAgentSetup(options, agent)` from `tests/fixtures/secure-agent-context.js` **before publication/return**, await it, and preserve setup rejection. It supplies `agent.session`, scoped `tools`, and `permissionPresets`; the optional fixture permits explicit failure cases. A fake that ignores setup is deliberately rejected, not silently exempted. Before simulating an assessment response, call the fixture's `tools.describeResolved()` to model actual step admission/assembly. These are contract fakes, not a real-runtime E2E test.

Affected fake creators found in: `goal6-superagent-host`, `review-backend-policy`, `review-backend-invariants`, `review-backend-contract-race`, `review-backend-restart-lease`, `unified-backend`, `contract-resilience`, `resilience`, `goal6-host-gate`, `goal6-github-writes`, `security`, `host-supervision`, `super-orchestrator`, `host-integration`, `host-governance`, `backend-taskboard` tests. Some do not exercise agent creation in their scenarios; update only applicable paths without weakening failure tests.

## Evidence

`node --test tests/host-security.test.js`: tests malicious assessment input, global/plugin mutation capabilities, late own-scope registration, fabricated calls including `run_code`, missing security APIs, ignored factory setup disposal, explicit worker default/mandate refusal, successful verified worker setup, absent service, unknown/mismatched preset, throwing setter and ineffective setter rollback. Host integration additionally verifies missing assessment confinement APIs cause zero model work, and a worker preset failure cancels the unpublished worker, delivers zero framing/work, releases the canonical lease, returns the task to todo, and records a visible failure. Additional requested host regressions cover canonical project/task mismatches, exact-once saved approval payloads, expiry-independent deduplication, version/mandate invalidation, model arbitration non-authority, normalized approved create payload, and minimal mandate patch semantics.
