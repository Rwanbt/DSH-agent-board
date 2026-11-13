/**
 * Board-content write payloads the Super Agent may execute.
 *
 * The model payload is already normalized at ingestion (`superagent/brain.js`),
 * but the host must not depend on that: the same go through the ONE approval
 * path stores bytes that were authored by a model and later replayed by a
 * different code path. A field such as `permission`, `model`, `execution` or
 * `isolation` is an OWNER field (operator-owned) and must never travel through
 * a brain write, even when the mandate allowed `update_task`. This module is
 * the single allowlist used by both the automatic and the approved path.
 *
 * `done` is not reachable either: `status` is not an allowed field, and the
 * Task Board public API keeps completion a human action.
 *
 * @module dsh-agent-board/contracts/board-writes
 */

/** Allowed fields and their maximum stored length, per board-content action. */
export const BOARD_PAYLOAD_FIELDS = Object.freeze({
  create_task: Object.freeze({
    text: Object.freeze({ title: 200, description: 2000, urgency: 20 }),
    booleans: Object.freeze([]),
  }),
  update_task: Object.freeze({
    text: Object.freeze({
      title: 200, description: 2000, prompt: 2000, urgency: 20, waitingReason: 500,
    }),
    booleans: Object.freeze(['blocked', 'waitingForHuman']),
  }),
  comment: Object.freeze({
    text: Object.freeze({ body: 4000 }),
    booleans: Object.freeze([]),
  }),
})

/** The only board-content actions with a payload contract. */
export const BOARD_PAYLOAD_ACTIONS = Object.freeze(Object.keys(BOARD_PAYLOAD_FIELDS))

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Return the canonical payload for one board-content action.
 *
 * A field that is not on the allowlist is REFUSED (`payload_field_forbidden`)
 * rather than silently dropped: the operator approved a displayed operation,
 * and executing a different object than the one displayed would be a lie.
 *
 * @param {string} action
 * @param {unknown} raw
 * @returns {{ ok: true, payload: Record<string, string|boolean> }
 *   | { ok: false, reason: 'no_adapter_for_action'|'payload_invalid'|'payload_field_forbidden', fields?: string[] }}
 */
export function sanitizeBoardPayload(action, raw) {
  const spec = BOARD_PAYLOAD_FIELDS[action]
  if (spec === undefined) return { ok: false, reason: 'no_adapter_for_action' }
  if (raw === null || raw === undefined) return { ok: true, payload: {} }
  if (!isRecord(raw)) return { ok: false, reason: 'payload_invalid' }
  const allowed = new Set([...Object.keys(spec.text), ...spec.booleans])
  const forbidden = Object.keys(raw).filter(key => !allowed.has(key)).sort()
  if (forbidden.length > 0) return { ok: false, reason: 'payload_field_forbidden', fields: forbidden }
  const payload = {}
  for (const [key, max] of Object.entries(spec.text)) {
    const value = raw[key]
    if (typeof value !== 'string') continue
    // Empty strings stay for the caller to decide (create_task falls back to
    // the rationale); they are never silently replaced here.
    payload[key] = value.slice(0, max)
  }
  for (const key of spec.booleans) {
    if (typeof raw[key] === 'boolean') payload[key] = raw[key]
  }
  return { ok: true, payload }
}
