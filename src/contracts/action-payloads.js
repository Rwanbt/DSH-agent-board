/** Canonical bytes shared by automatic execution and exact approval replay. */
import { BOARD_PAYLOAD_ACTIONS, sanitizeBoardPayload } from './board-writes.js'

const ACTION_PAYLOAD_FIELDS = Object.freeze({
  launch: [], delegate: [],
  // A work item is resolved by its stable id (the project's own document or
  // issue): the model never supplies the item's content, only its identity.
  launch_work: ['workItemId'],
  // The triage justification is stored on the card and in the audit log.
  promote_task: ['reason'],
  open_pr: ['title', 'body', 'head', 'base', 'repository'],
  delete_task: ['reason'], policy_change: ['priority', 'maxTasksPerHour'],
  schedule: ['title', 'description', 'prompt', 'urgency', 'cron', 'runAt'],
  merge: ['number', 'headSha', 'method', 'repository', 'base', 'baseSha'],
})

export function sanitizeActionPayload(action, raw) {
  if (BOARD_PAYLOAD_ACTIONS.includes(action)) return sanitizeBoardPayload(action, raw)
  if (!Object.hasOwn(ACTION_PAYLOAD_FIELDS, action)) return { ok: false, reason: 'no_adapter_for_action' }
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, reason: 'payload_invalid' }
  }
  const source = raw ?? {}
  const allowed = ACTION_PAYLOAD_FIELDS[action]
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
    if (action === 'merge' && key === 'number') {
      if (!Number.isInteger(source[key]) || source[key] <= 0 || source[key] > 1_000_000_000) return { ok: false, reason: 'payload_invalid' }
      payload[key] = source[key]
      continue
    }
    if (action === 'schedule' && key === 'runAt' && typeof source[key] === 'number') {
      payload.runAt = source[key]
      continue
    }
    if (typeof source[key] !== 'string') return { ok: false, reason: 'payload_invalid' }
    const max = key === 'body' ? 2000 : key === 'reason' ? 500 : key === 'title' ? 200 : key === 'repository' && action === 'merge' ? 512 : 120
    if (['head', 'base', 'repository', 'headSha', 'baseSha'].includes(key) && source[key].trim().length > max) return { ok: false, reason: 'payload_invalid' }
    payload[key] = source[key].trim().slice(0, max)
  }
  if (action === 'schedule') {
    if (!payload.title) return { ok: false, reason: 'payload_invalid' }
    payload.urgency = ['urgent', 'normal', 'relaxed'].includes(payload.urgency) ? payload.urgency : 'normal'
    const cron = typeof payload.cron === 'string' ? payload.cron.trim() : ''
    const hasRunAt = payload.runAt !== undefined && payload.runAt !== ''
    if ((cron !== '') === hasRunAt) return { ok: false, reason: 'payload_invalid' }
    if (cron !== '') {
      const parts = cron.split(/\s+/)
      if (parts.length !== 5 || !parts.every(part => /^[0-9*/,/-]+$/.test(part))) return { ok: false, reason: 'payload_invalid' }
      payload.cron = cron
      delete payload.runAt
    } else {
      const ms = typeof payload.runAt === 'number' ? payload.runAt : Date.parse(String(payload.runAt))
      // A schedule is a future effect: a past instant is refused, never clamped.
      if (!Number.isFinite(ms) || ms <= Date.now()) return { ok: false, reason: 'payload_invalid' }
      payload.runAt = new Date(ms).toISOString()
      delete payload.cron
    }
    return { ok: true, payload }
  }
  if (action === 'merge') {
    if (!payload.number || (payload.headSha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(payload.headSha))) return { ok: false, reason: 'payload_invalid' }
    if (payload.baseSha !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(payload.baseSha)) return { ok: false, reason: 'payload_invalid' }
    if (payload.headSha) payload.headSha = payload.headSha.toLowerCase()
    if (payload.baseSha) payload.baseSha = payload.baseSha.toLowerCase()
    payload.method ??= 'squash'
    if (!['merge', 'squash', 'rebase'].includes(payload.method)) return { ok: false, reason: 'payload_invalid' }
  }
  if (action === 'delete_task' && !payload.reason) return { ok: false, reason: 'payload_invalid' }
  if (action === 'promote_task' && !payload.reason) return { ok: false, reason: 'payload_invalid' }
  if (action === 'launch_work' && !/^work-[a-f0-9]{8,32}$/.test(payload.workItemId ?? '')) {
    return { ok: false, reason: 'payload_invalid' }
  }
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
