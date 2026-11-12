/**
 * Execution-contract adapter over the REAL Task Board public-v1 API.
 *
 * The host's execution path speaks `lease -> attach -> release|settle`
 * (`taskboard-contract.js`). Installed Task Board builds (0.12.x) do not serve
 * that proposed `/contract` extension, but they do serve public-v1 with the
 * same guarantees: idempotent claim, actor ownership, fencing, `in_review` on
 * success and `done` reserved to the human. This adapter maps one onto the
 * other so the already-tested host path drives the canonical ledger.
 *
 *   leaseExecution  -> POST /executions/claim        (idempotencyKey required)
 *   attachSession   -> POST /executions/:id/session
 *   releaseLease    -> POST /executions/:id/interrupt (task returns to todo)
 *   settleExecution -> POST /executions/:id/complete  (succeeded => in_review)
 *
 * @module dsh-agent-board/connectors/taskboard-public-contract
 */
import { TASKBOARD_CONTRACT_FEATURES, executionIdempotencyKey } from './taskboard-contract.js'

export const PUBLIC_CONTRACT_ACTOR = 'dsh-agent-board'

function failureOf(result, fallback = 'unknown') {
  return { ok: false, code: result?.code ?? fallback, message: result?.message ?? fallback, status: Number(result?.status) || 0 }
}

/**
 * @param {ReturnType<import('./taskboard-public.js').createPublicTaskBoardClient>} client
 * @param {{actor?: string}} [options]
 */
export function createPublicContractAdapter(client, { actor = PUBLIC_CONTRACT_ACTOR } = {}) {
  let negotiation = null
  const fences = new Map()

  async function contract() {
    if (client?.configured !== true) {
      negotiation = { ok: false, writes: false, absent: true, reason: 'public_v1_not_configured', features: new Set(), missing: [], missingWrite: [] }
      return negotiation
    }
    const meta = await client.meta()
    const features = meta.ok === true ? meta.value?.features ?? {} : {}
    const writes = meta.ok === true && meta.value?.writePolicy === 'explicit' && features.claim === true
    negotiation = meta.ok === true
      ? {
          version: Number(meta.value?.apiVersion) || 1,
          ok: true,
          writes,
          degraded: !writes,
          absent: false,
          simulated: false,
          reason: writes ? 'public_v1_ok' : 'public_v1_claim_unavailable',
          features: writes ? new Set(TASKBOARD_CONTRACT_FEATURES) : new Set(),
          missing: [],
          missingWrite: writes ? [] : ['claim'],
        }
      : { ok: false, writes: false, absent: meta.code === 'not_found', reason: `public_v1_${meta.code ?? 'unreachable'}`, features: new Set(), missing: [], missingWrite: [] }
    return negotiation
  }

  function fenceOf(id) {
    const token = fences.get(id)
    return token === undefined ? {} : { ifFencingToken: token }
  }

  function idOf(view) {
    if (!view || typeof view !== 'object') return null
    if (typeof view.executionId === 'string' && view.executionId !== '') return view.executionId
    return typeof view.id === 'string' && view.id !== '' ? view.id : null
  }

  function remember(view) {
    const id = idOf(view)
    if (id !== null && Number.isFinite(Number(view.fencingToken))) fences.set(id, Number(view.fencingToken))
  }

  async function leaseExecution(taskId, { attempt = 1, idempotencyKey = null } = {}) {
    const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : executionIdempotencyKey({ taskId, attempt })
    const result = await client.claim({ taskId: String(taskId), actor, idempotencyKey: key })
    if (result.ok !== true) return failureOf(result)
    const execution = result.value?.execution
    const executionId = idOf(execution)
    if (executionId === null) return { ok: false, code: 'bad_response', message: 'claim response is missing the execution id', status: Number(result.status) || 0 }
    remember(execution)
    return { ok: true, status: result.status, value: { leaseId: executionId, executionId, attempt: Number(attempt) || 1 } }
  }

  async function attachSession(leaseId, { sessionId } = {}) {
    const result = await client.attachSession(leaseId, { actor, sessionId, ...fenceOf(leaseId) })
    if (result.ok !== true) return failureOf(result)
    remember(result.value)
    return { ok: true, status: result.status, value: { leaseId, sessionId } }
  }

  async function releaseLease(leaseId, { reason = null } = {}) {
    const result = await client.interrupt(leaseId, { actor, ...(reason ? { reason: String(reason).slice(0, 500) } : {}), ...fenceOf(leaseId) })
    if (result.ok !== true) return failureOf(result)
    fences.delete(leaseId)
    return { ok: true, status: result.status, value: result.value }
  }

  async function settleExecution(leaseId, { outcome, report = null } = {}) {
    const result = await client.complete(leaseId, { actor, outcome, ...(report ? { report } : {}), ...fenceOf(leaseId) })
    if (result.ok !== true) return failureOf(result)
    fences.delete(leaseId)
    return { ok: true, status: result.status, value: result.value }
  }

  async function submitReport() {
    return { ok: false, code: 'unsupported', message: 'reports are carried by settle on public-v1', status: 0 }
  }

  return {
    kind: 'public-v1',
    baseUrl: client?.baseUrl ?? null,
    negotiation: () => negotiation,
    supports: feature => negotiation?.ok === true && negotiation.features.has(feature),
    contract,
    leaseExecution,
    attachSession,
    submitReport,
    releaseLease,
    settleExecution,
  }
}
