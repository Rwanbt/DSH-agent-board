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
    taskId: String(draft.taskId),
    taskTitle: typeof draft.taskTitle === 'string' ? draft.taskTitle : null,
    taskDescription: typeof draft.taskDescription === 'string' ? draft.taskDescription : null,
    taskPrompt: typeof draft.taskPrompt === 'string' ? draft.taskPrompt : null,
    revision: draft.revision ?? null,
    attempt: Number(draft.attempt) || 0,
    workspaceId: String(draft.workspaceId ?? ''),
    sessionId: draft.sessionId ?? null,
    previousSessionId: draft.previousSessionId ?? null,
    model: draft.model ?? null,
    routeHistory: Array.isArray(draft.routeHistory) ? draft.routeHistory : [],
    switches: Number(draft.switches) || 0,
    retries: Number(draft.retries) || 0,
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
    if (assignment?.status !== LEASE_STATUS.STARTING && assignment?.status !== LEASE_STATUS.RUNNING) continue
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
