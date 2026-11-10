/**
 * Executor skeletons: engines Agent Board is designed to supervise but does
 * NOT integrate in this build. Each one declares ZERO capabilities, so the
 * public matrix cannot mistake it for a working executor.
 *
 * Evidence behind the Claude Code notes (read-only inspection of the installed
 * `@deepseek-ai/dsh-subagent-claude-code` 0.2.2-rc.1 plugin in the desktop
 * profile, plus its README):
 *   - it registers a provider on `ctx.subagents` (`providerName: 'claude-code'`)
 *     with `capabilities = NO_START_CAPABILITIES` and `start(request)`;
 *   - every accepted run is a fresh one-shot Agent SDK query/process: "there is
 *     no continuation, resume, pooling, progress stream, or product-session
 *     persistence";
 *   - no local child Session is created; the parent catalog records an
 *     `external` leaf (`mode: 'external'`), which the shared
 *     `ctx.subagents.listChildren()` can list;
 *   - cancellation belongs to the shared activation (`dispose()` /
 *     `interruptByParent`), not to the provider, and this board does not hold
 *     an activation handle;
 *   - the model is fixed per provider instance in configuration, not queryable
 *     per run.
 *
 * @module dsh-agent-board/executors/skeletons
 */

import { createSkeletonAdapter } from '../contracts/adapters.js'

export const EXECUTOR_SKELETONS = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    kind: 'executor',
    title: 'Claude Code',
    reason: 'Installed @deepseek-ai/dsh-subagent-claude-code 0.2.2-rc.1 is a one-shot external provider on ctx.subagents: it can start a fresh Agent SDK run and return its final answer, but it creates no local child Session, cannot resume/continue, exposes no per-session status/output/model, and its cancellation belongs to the shared activation handle this board does not hold. Declares nothing until a board adapter wires ctx.subagents.startActivation and records the external run.',
  }),
  Object.freeze({
    id: 'codex',
    kind: 'executor',
    title: 'Codex',
    reason: 'No Codex subagent provider is installed in this profile, and no Codex adapter is wired in this build. Declares nothing: there is no host API to start, observe or cancel a Codex session.',
  }),
  Object.freeze({
    id: 'opencode',
    kind: 'executor',
    title: 'OpenCode',
    reason: 'No OpenCode subagent provider is installed in this profile, and no OpenCode adapter is wired in this build. Declares nothing: there is no host API to start, observe or cancel an OpenCode session.',
  }),
])

/** One fresh skeleton adapter per engine, in a stable order. */
export function createExecutorSkeletons() {
  return EXECUTOR_SKELETONS.map(skeleton => createSkeletonAdapter({
    id: skeleton.id,
    kind: skeleton.kind,
    title: skeleton.title,
    reason: skeleton.reason,
    validatedLive: false,
  }))
}
