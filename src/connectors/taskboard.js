/**
 * Task Board adapter — the ONE real work source in this MVP.
 *
 * It speaks the Task Board's own HTTP contract (`GET /dsh-taskboard/state`)
 * and deliberately implements READ-ONLY capabilities. The board must never
 * become a second writer of the ledger, and it must never move a task to
 * `done`: claim and `in_review` are done by the agent session it launches, and
 * `done` stays a human action in the Task Board UI.
 *
 * @module dsh-agent-board/connectors/taskboard
 */

import { AdapterError, defineAdapter } from '../contracts/adapters.js'

export const TASKBOARD_STATE_PATH = '/dsh-taskboard/state'

/**
 * Normalize one Task Board `TaskRecord` (schema 0.10.2) into the board's shape.
 *
 * Field names are the ones the real ledger uses — `version` (not `revision`),
 * `executions[]` with `outcome`, `claimedBy`, `isolation`, `execution.mode`.
 * Reading a wrong field name here silently pinned every idempotency key to the
 * same value and hid the Task Board's own active executions from the
 * orchestrator, so both are contract-tested in tests/connectors.test.js.
 */
function normalizeTask(raw, ledgerRevision) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') return null
  const executions = Array.isArray(raw.executions) ? raw.executions : []
  const runningExecution = executions.find(execution => execution?.outcome === 'running') ?? null
  const lastExecution = executions.length > 0 ? executions[executions.length - 1] : null
  const revision = raw.version ?? raw.revision ?? raw.rev ?? null
  return {
    id: raw.id,
    system: 'dsh-taskboard',
    externalId: raw.id,
    canonicalId: `dsh-taskboard:${raw.id}`,
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    urgency: typeof raw.urgency === 'string' ? raw.urgency : 'normal',
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
    projectId: raw.projectId ?? null,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    trashedAt: raw.trashedAt ?? null,
    // The Task Board's own optimistic-concurrency version of THIS task.
    revision,
    version: raw.version ?? null,
    execution: raw.execution ?? null,
    model: raw.model ?? null,
    claimedBy: typeof raw.claimedBy === 'string' ? raw.claimedBy : null,
    claimedAt: raw.claimedAt ?? null,
    claim: typeof raw.claimedBy === 'string' ? raw.claimedBy : null,
    permission: raw.permission ?? null,
    isolation: raw.isolation ?? null,
    branch: typeof raw.branch === 'string' ? raw.branch : null,
    waitingForHuman: raw.waitingForHuman === true,
    blocked: raw.blocked === true,
    checklistSize: Array.isArray(raw.checklist) ? raw.checklist.length : 0,
    // Derived, read-only: is the Task Board ALREADY running this task? The board
    // must not launch a second executor for it.
    activeExecution: runningExecution !== null,
    activeExecutionId: runningExecution?.id ?? null,
    lastExecutionOutcome: lastExecution?.outcome ?? null,
    executionsTotal: executions.length,
    updatedAt: raw.updatedAt ?? null,
    ledgerRevision,
    raw: undefined,
  }
}

/**
 * @param {object} options
 * @param {string} options.baseUrl      same-origin GUI origin, e.g. http://127.0.0.1:62337
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createTaskboardAdapter({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('agent-board: taskboard adapter needs a base URL')

  async function getJson(path) {
    const url = new URL(path, baseUrl).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    } catch (error) {
      throw new AdapterError(`task board unreachable: ${String(error?.message ?? error)}`, {
        code: 'unreachable', retryable: true, adapterId: 'dsh-taskboard', cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new AdapterError(`task board returned HTTP ${response.status}`, {
        code: `http_${response.status}`, retryable: response.status >= 500, adapterId: 'dsh-taskboard',
      })
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new AdapterError('task board returned invalid JSON', { code: 'invalid_json', cause: error, adapterId: 'dsh-taskboard' })
    }
    if (body === null || typeof body !== 'object' || body.ok !== true) {
      throw new AdapterError(`task board refused the read: ${String(body?.error ?? 'unknown error')}`, {
        code: 'refused', adapterId: 'dsh-taskboard',
      })
    }
    return body.value
  }

  const adapter = defineAdapter({
    id: 'dsh-taskboard',
    kind: 'work-source',
    title: 'DSH Task Board',
    capabilities: ['list', 'get'],
    status: 'available',
    validatedLive: false,
    notes: 'Read-only. Claim/in_review are performed by the launched agent session; done stays human-only.',
    async list() {
      const state = await getJson(TASKBOARD_STATE_PATH)
      // The ledger exposes `revision` (global monotonic counter), not `rev`.
      const ledgerRevision = state?.revision ?? state?.rev ?? null
      const tasks = Array.isArray(state?.tasks) ? state.tasks : []
      return {
        items: tasks.map(task => normalizeTask(task, ledgerRevision)).filter(task => task !== null),
        meta: {
          ledgerRevision,
          doneCount: Number(state?.doneCount) || 0,
          queue: state?.queue ?? null,
          tasksTotal: tasks.length,
        },
      }
    },
    async get(id) {
      const { items } = await adapter.list()
      return items.find(task => task.id === id) ?? null
    },
    describe() {
      return {
        id: 'dsh-taskboard',
        kind: 'work-source',
        title: 'DSH Task Board',
        status: 'available',
        validatedLive: adapter.validatedLive === true,
        capabilities: {
          list: true, get: true, subscribe: false, create: false,
          update: false, comment: false, transition: false,
        },
        notes: adapter.notes,
        baseUrl,
      }
    },
  })
  return adapter
}
