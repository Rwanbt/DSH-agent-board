/**
 * Leases, fencing tokens and idempotency for task assignments.
 *
 * A lease makes ownership explicit and expirable; the fencing token makes a
 * stale writer detectable; the idempotency key makes a repeated event or a
 * restart converge on ONE assignment instead of launching twice.
 *
 * @module dsh-agent-board/orchestrator/lease
 */

import { idempotencyKey, newId } from '../contracts/model.js'

export const LEASE_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  RECOVERING: 'recovering',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
  SUPERSEDED: 'superseded',
})

export function createLease({ owner, now, ttlMs }) {
  return {
    owner: String(owner),
    acquiredAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
  }
}

export function leaseValid(lease, now) {
  if (lease === null || typeof lease !== 'object') return false
  const expiresAt = Number(lease.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function renewLease(lease, now, ttlMs = lease?.ttlMs ?? 0) {
  return { ...lease, expiresAt: now + ttlMs, ttlMs }
}

/**
 * Try to take ownership. Returns `{ok:true, lease, fencingToken}` or a refusal
 * carrying the current holder — never a silent takeover.
 */
export function acquireLease(existing, { owner, now, ttlMs }) {
  const current = existing?.lease
  if (leaseValid(current, now) && current.owner !== owner) {
    return { ok: false, reason: 'lease_held', holder: current.owner, expiresAt: current.expiresAt }
  }
  return {
    ok: true,
    lease: createLease({ owner, now, ttlMs }),
    fencingToken: (Number(existing?.fencingToken) || 0) + 1,
  }
}

/** A fenced write is accepted only when the caller holds the newest token. */
export function fenceAccepts(assignment, fencingToken) {
  return Number(assignment?.fencingToken) === Number(fencingToken)
}

/**
 * The next monotonic fencing token for an assignment (1 for a new record).
 * The host stores it on the new lease and passes it to the writer; every
 * later takeover must move it forward.
 *
 * @param {object} [assignment]
 * @returns {number}
 */
export function nextFencingToken(assignment) {
  const current = Number(assignment?.fencingToken)
  return (Number.isFinite(current) && current > 0 ? Math.trunc(current) : 0) + 1
}

const TERMINAL_ASSIGNMENT_STATUSES = Object.freeze([
  LEASE_STATUS.DONE,
  LEASE_STATUS.FAILED,
  LEASE_STATUS.STOPPED,
  LEASE_STATUS.INTERRUPTED,
  LEASE_STATUS.SUPERSEDED,
])

/**
 * Enforce fencing on a write: a writer may act on an assignment only when it
 * presents the CURRENT token of a LIVE lease.
 *
 * Refusals (in check order):
 *   `unknown_assignment`    — no assignment record;
 *   `invalid_fencing_token` — the presented/recorded token is not a number;
 *   `stale_fencing_token`   — another owner has already taken over;
 *   `lease_released`        — the assignment ended, or has no lease;
 *   `lease_expired`         — the TTL elapsed (the watchdog may take over);
 *   `wrong_owner`           — optional `owner` does not match the lease owner.
 *
 * @param {object} input
 * @param {object} input.assignment
 * @param {number} input.token
 * @param {number} [input.now]
 * @param {string} [input.owner]  expected lease owner, when known
 * @returns {{ok:boolean, reason:string}}
 */
export function checkFencing({ assignment, token, now = Date.now(), owner } = {}) {
  if (assignment === null || typeof assignment !== 'object' || Array.isArray(assignment)) {
    return { ok: false, reason: 'unknown_assignment' }
  }
  const presented = Number(token)
  if (!Number.isFinite(presented)) return { ok: false, reason: 'invalid_fencing_token' }
  const current = Number(assignment.fencingToken)
  if (!Number.isFinite(current)) return { ok: false, reason: 'invalid_fencing_token' }
  if (Math.trunc(current) !== Math.trunc(presented)) return { ok: false, reason: 'stale_fencing_token' }
  if (TERMINAL_ASSIGNMENT_STATUSES.includes(assignment.status)) return { ok: false, reason: 'lease_released' }
  const lease = assignment.lease
  if (lease === null || typeof lease !== 'object') return { ok: false, reason: 'lease_released' }
  if (!leaseValid(lease, now)) return { ok: false, reason: 'lease_expired' }
  // Owner is optional so the existing three-field call stays valid; when the
  // host knows which session/owner is writing, a mismatch is refused.
  if (owner !== undefined && owner !== null && lease.owner !== String(owner)) {
    return { ok: false, reason: 'wrong_owner' }
  }
  return { ok: true, reason: 'ok' }
}

export function assignmentKey({ taskId, revision, attempt = 0 }) {
  return idempotencyKey({ workItem: `taskboard:${taskId}`, revision: revision ?? 0, attempt })
}

/**
 * One durable assignment per idempotency key. Re-using a key returns the
 * existing record; that is what makes duplicate events and restarts safe.
 */
export function ensureAssignment(assignments, draft) {
  const key = draft.idempotencyKey ?? assignmentKey(draft)
  const existing = (assignments ?? []).find(assignment => assignment.idempotencyKey === key)
  if (existing !== undefined) return { created: false, assignment: existing }
  const assignment = {
    id: draft.id ?? newId('asg'),
    idempotencyKey: key,
    authorizationAction: draft.authorizationAction === 'delegate' ? 'delegate' : 'launch',
    taskId: String(draft.taskId),
    taskTitle: typeof draft.taskTitle === 'string' ? draft.taskTitle : null,
    taskDescription: typeof draft.taskDescription === 'string' ? draft.taskDescription : null,
    taskPrompt: typeof draft.taskPrompt === 'string' ? draft.taskPrompt : null,
    taskPermission: typeof draft.taskPermission === 'string' ? draft.taskPermission : null,
    taskIsolation: typeof draft.taskIsolation === 'string' ? draft.taskIsolation : null,
    revision: draft.revision ?? null,
    attempt: Number(draft.attempt) || 0,
    workspaceId: String(draft.workspaceId ?? ''),
    sessionId: draft.sessionId ?? null,
    previousSessionId: draft.previousSessionId ?? null,
    model: draft.model ?? null,
    // Three execution owners: the board (plain session), the Task Board executor
    // (`taskboard`) and the negotiated `contract` backend (Task Board execution,
    // board-created session). An unknown value falls back to `board`.
    backend: draft.backend === 'taskboard' ? 'taskboard' : (draft.backend === 'contract' ? 'contract' : 'board'),
    executionId: typeof draft.executionId === 'string' ? draft.executionId : null,
    routeHistory: Array.isArray(draft.routeHistory) ? draft.routeHistory : [],
    switches: Number(draft.switches) || 0,
    retries: Number(draft.retries) || 0,
    ...(typeof draft.reason === 'string' ? { reason: draft.reason } : {}),
    ...(Number.isFinite(Number(draft.recoveringAt)) ? { recoveringAt: Number(draft.recoveringAt) } : {}),
    status: draft.status ?? LEASE_STATUS.STARTING,
    lease: draft.lease ?? null,
    fencingToken: Number(draft.fencingToken) || 1,
    startedAt: draft.startedAt ?? Date.now(),
    endedAt: null,
    error: null,
    checkpoint: null,
  }
  return { created: true, assignment }
}

/**
 * Reconcile board-owned assignments after a host restart: an assignment we
 * believed running but whose live agent is gone becomes `interrupted` (visible,
 * resumable) — never silently relaunched.
 */
export function reconcileAfterRestart(assignments, { now, isLive }) {
  const changes = []
  for (const assignment of assignments ?? []) {
    // `recovering` is a live state too: a host that died mid-handoff must not
    // leave a recovery record that consumes a concurrency slot forever.
    if (![LEASE_STATUS.STARTING, LEASE_STATUS.RUNNING, LEASE_STATUS.RECOVERING].includes(assignment?.status)) continue
    if (isLive(assignment) === true) continue
    assignment.status = LEASE_STATUS.INTERRUPTED
    assignment.endedAt = now
    assignment.error = assignment.error ?? 'host_restart_or_session_lost'
    assignment.lease = null
    changes.push({ assignmentId: assignment.id, taskId: assignment.taskId, status: assignment.status })
  }
  return changes
}

export function markAssignment(assignment, patch) {
  return { ...assignment, ...patch }
}
