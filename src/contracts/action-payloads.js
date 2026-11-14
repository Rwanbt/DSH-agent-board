/** Canonical bytes shared by automatic execution and exact approval replay. */
import { BOARD_PAYLOAD_ACTIONS, sanitizeBoardPayload } from './board-writes.js'

export function sanitizeActionPayload(action, raw) {
  if (BOARD_PAYLOAD_ACTIONS.includes(action)) return sanitizeBoardPayload(action, raw)
  if (!['launch', 'delegate', 'open_pr', 'delete_task', 'policy_change'].includes(action)) return { ok: false, reason: 'no_adapter_for_action' }
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, reason: 'payload_invalid' }
  }
  const source = raw ?? {}
  const allowed = action === 'open_pr' ? ['title', 'body', 'head', 'base', 'repository']
    : action === 'delete_task' ? ['reason'] : action === 'policy_change' ? ['priority', 'maxTasksPerHour'] : []
  const fields = Object.keys(source).filter(key => !allowed.includes(key))
  if (fields.length) return { ok: false, reason: 'payload_field_forbidden', fields }
  const payload = {}
  if (action === 'policy_change') {
    for (const key of allowed) {
      if (!Object.hasOwn(source, key)) continue
      if (!Number.isInteger(source[key]) || source[key] < 0 || source[key] > (key === 'priority' ? 9 : 100)) return { ok: false, reason: 'payload_invalid' }
      payload[key] = source[key]
    }
    return Object.keys(payload).length ? { ok: true, payload } : { ok: false, reason: 'payload_invalid' }
  }
  for (const key of allowed) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'string') return { ok: false, reason: 'payload_invalid' }
    if (['head', 'base', 'repository'].includes(key) && source[key].trim().length > 120) return { ok: false, reason: 'payload_invalid' }
    payload[key] = source[key].trim().slice(0, key === 'body' ? 2000 : key === 'reason' ? 500 : key === 'title' ? 200 : 120)
  }
  if (action === 'delete_task' && !payload.reason) return { ok: false, reason: 'payload_invalid' }
  if (action === 'open_pr') {
    if (payload.repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repository)) return { ok: false, reason: 'payload_invalid' }
    if (!payload.title || !payload.head || !payload.base || payload.head === payload.base) return { ok: false, reason: 'payload_invalid' }
    for (const key of ['head', 'base']) {
      const ref = payload[key]
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.includes('//')
        || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return { ok: false, reason: 'payload_invalid' }
    }
  }
  return { ok: true, payload }
}
