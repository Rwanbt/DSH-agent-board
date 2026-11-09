/**
 * Task checkpoint and controlled handoff.
 *
 * When a provider switch can no longer happen inside the in-flight request,
 * the board must persist enough reality to resume the WORK in a new session
 * under the same logical assignment: cwd, git HEAD/branch/status/commits,
 * tests already run, the last useful assistant text, external actions already
 * attempted, and what remains.
 *
 * Reconciliation is deliberately conservative: an action whose remote effect
 * is unknown is marked `verify`, never replayed blindly.
 *
 * @module dsh-agent-board/recovery/checkpoint
 */

import { newId, truncate } from '../contracts/model.js'

/**
 * @param {object} input
 * @param {object} input.assignment
 * @param {string} input.sessionId
 * @param {string} [input.lastText]
 * @param {object} [input.git]        { head, branch, status, commits, changedFiles }
 * @param {object[]} [input.tests]    [{ name, outcome }]
 * @param {object[]} [input.actions]  [{ kind, target, idempotent, effect: 'confirmed'|'unknown' }]
 * @param {string[]} [input.stepsDone]
 * @param {string[]} [input.stepsRemaining]
 * @param {number} [input.now]
 */
export function buildCheckpoint({
  assignment,
  sessionId,
  lastText = '',
  git = null,
  tests = [],
  actions = [],
  stepsDone = [],
  stepsRemaining = [],
  now = Date.now(),
}) {
  return {
    id: newId('ckpt'),
    at: now,
    assignmentId: assignment?.id ?? null,
    taskId: assignment?.taskId ?? null,
    sessionId,
    lastText: truncate(lastText, 800),
    git: git === null ? null : {
      head: git.head ?? null,
      branch: git.branch ?? null,
      status: truncate(typeof git.status === 'string' ? git.status : '', 1200),
      commits: Array.isArray(git.commits) ? git.commits.slice(0, 20) : [],
      changedFiles: Array.isArray(git.changedFiles) ? git.changedFiles.slice(0, 200) : [],
    },
    tests: Array.isArray(tests) ? tests.slice(0, 30) : [],
    actions: Array.isArray(actions)
      ? actions.slice(0, 30).map(action => ({
        kind: String(action.kind ?? 'unknown'),
        target: String(action.target ?? ''),
        idempotent: action.idempotent === true,
        effect: action.effect === 'confirmed' ? 'confirmed' : 'unknown',
      }))
      : [],
    stepsDone: stepsDone.slice(0, 50),
    stepsRemaining: stepsRemaining.slice(0, 50),
    schemaVersion: 1,
  }
}

/**
 * Compare the checkpoint with what is actually observable now. A mismatch is
 * reported, never "fixed" by overwriting the checkpoint.
 */
export function reconcileCheckpoint(checkpoint, observed = {}) {
  const drift = []
  if (checkpoint === null || checkpoint === undefined) {
    return { consistent: false, drift: ['missing_checkpoint'], verify: [] }
  }
  if (observed.head !== undefined && checkpoint.git?.head !== undefined && observed.head !== null && observed.head !== checkpoint.git.head) {
    drift.push('git_head_changed')
  }
  if (observed.branch !== undefined && checkpoint.git?.branch !== undefined && observed.branch !== null && observed.branch !== checkpoint.git.branch) {
    drift.push('git_branch_changed')
  }
  const status = typeof observed.status === 'string' ? observed.status : null
  if (status !== null && status !== (checkpoint.git?.status ?? '')) drift.push('worktree_changed')
  const verify = (checkpoint.actions ?? [])
    .filter(action => action.effect === 'unknown' && action.idempotent === false)
    .map(action => `${action.kind}:${action.target}`)
  return { consistent: drift.length === 0, drift, verify }
}

/**
 * The opening message of the resumed session. It states the identity link, the
 * observable state, and the two prohibitions that keep the handoff safe:
 * no blind replay of unverified external effects, and never `done` as the
 * final state (a human confirms that).
 */
export function handoffPrompt(checkpoint, { task, fromRoute, toRoute, reason } = {}) {
  const from = fromRoute === undefined || fromRoute === null ? 'unknown route' : `${fromRoute.provider}/${fromRoute.model}`
  const to = toRoute === undefined || toRoute === null ? 'configured fallback' : `${toRoute.provider}/${toRoute.model}`
  const lines = [
    'AGENT BOARD — CONTROLLED HANDOFF',
    `Task: ${task?.id ?? checkpoint.taskId ?? 'unknown'} — ${truncate(task?.title ?? '', 200)}`,
    `Reason: ${reason ?? 'provider failure after work started'}`,
    `Previous session: ${checkpoint.sessionId ?? 'unknown'}`,
    `Route change: ${from} -> ${to}`,
    '',
    'Observable state at the checkpoint:',
    `- Working directory: ${checkpoint.git?.branch ? `branch ${checkpoint.git.branch}` : 'unknown branch'}${checkpoint.git?.head ? ` @ ${String(checkpoint.git.head).slice(0, 12)}` : ''}`,
    `- Worktree status: ${checkpoint.git?.status === '' || checkpoint.git?.status === undefined ? 'clean or unknown' : truncate(checkpoint.git.status, 400)}`,
    `- Last useful segment: ${checkpoint.lastText === '' ? '(none captured)' : truncate(checkpoint.lastText, 400)}`,
    `- Steps already done: ${checkpoint.stepsDone.length === 0 ? '(not itemized)' : checkpoint.stepsDone.join('; ')}`,
    `- Steps remaining: ${checkpoint.stepsRemaining.length === 0 ? '(not itemized)' : checkpoint.stepsRemaining.join('; ')}`,
  ]
  if ((checkpoint.actions ?? []).length > 0) {
    lines.push('- External actions already attempted:')
    for (const action of checkpoint.actions) {
      lines.push(`  * ${action.kind} ${action.target} (${action.effect === 'confirmed' ? 'confirmed' : 'effect unknown — verify before replaying'})`)
    }
  }
  lines.push(
    '',
    'Rules for this resumed turn:',
    '1. Re-read the repository and task state before writing anything; do not trust this summary over the files.',
    '2. Never replay an external action whose effect is unknown — verify it first.',
    '3. Continue the task to `in_review` at most; `done` is reserved to the human operator.',
    '4. If the state contradicts this checkpoint, stop and report the divergence.',
  )
  return lines.join('\n')
}

/** A compact, serializable description the client renders under the card. */
export function describeHandoff(checkpoint, toRoute) {
  return {
    checkpointId: checkpoint?.id ?? null,
    previousSessionId: checkpoint?.sessionId ?? null,
    to: toRoute === null || toRoute === undefined ? null : `${toRoute.provider}/${toRoute.model}`,
    at: checkpoint?.at ?? null,
    drift: checkpoint?.git === null || checkpoint?.git === undefined ? ['no_git_snapshot'] : [],
  }
}
