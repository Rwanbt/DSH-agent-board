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

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AdapterError, defineAdapter } from '../contracts/adapters.js'
import { negotiateContract, TASKBOARD_CONTRACT_ENDPOINTS } from './taskboard-contract.js'

export const TASKBOARD_STATE_PATH = TASKBOARD_CONTRACT_ENDPOINTS.state
export const TASKBOARD_RUN_PATH = '/dsh-taskboard/tasks'
/** PROPOSED extension probe. Real 0.10/0.11 Task Boards answer 404 here. */
export const TASKBOARD_CONTRACT_PATH = TASKBOARD_CONTRACT_ENDPOINTS.contract
/** Bearer-authenticated board-content API (audit A03). */
export const TASKBOARD_PUBLIC_PREFIX = '/dsh-taskboard/public/v1'

/**
 * Resolve the local Task Board public token, mirroring the Task Board's own
 * resolution order (explicit env, then the 0600 file it creates on first use).
 * Both plugins run for the same OS user; this is the zero-configuration path.
 */
export function resolveTaskboardToken(env = process.env) {
  const explicit = typeof env.DSH_TASKBOARD_PUBLIC_TOKEN === 'string' ? env.DSH_TASKBOARD_PUBLIC_TOKEN.trim() : ''
  if (explicit.length > 0) return explicit
  if (env.DSH_TASKBOARD_PUBLIC_TOKEN_DISABLE_LOCAL === '1') return undefined
  try {
    const override = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
    const text = readFileSync(join(resolve(override), 'taskboard', 'public-api.token'), 'utf8').trim()
    return text.length >= 32 ? text : undefined
  } catch {
    return undefined
  }
}

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
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : ''
  const claimedBy = typeof raw.claimedBy === 'string' ? raw.claimedBy : null
  // The real TaskRecord has no `projectId`: `workspaceId` IS the owning project
  // ("Owning project: a DSH workspace id"). `projectId` keeps its historical
  // raw-only meaning so no existing consumer changes behaviour; `project` is the
  // normalized, read-only identity the coordination read model consumes.
  const hasRawProjectId = typeof raw.projectId === 'string' && raw.projectId !== ''
  const normalizedProjectId = hasRawProjectId ? raw.projectId : (workspaceId !== '' ? workspaceId : null)
  return {
    id: raw.id,
    system: 'dsh-taskboard',
    externalId: raw.id,
    canonicalId: `dsh-taskboard:${raw.id}`,
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    urgency: typeof raw.urgency === 'string' ? raw.urgency : 'normal',
    workspaceId,
    projectId: raw.projectId ?? null,
    project: {
      id: normalizedProjectId,
      workspaceId,
      source: normalizedProjectId === null ? 'none' : (hasRawProjectId ? 'projectId' : 'workspaceId'),
    },
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    trashedAt: raw.trashedAt ?? null,
    // The Task Board's own optimistic-concurrency version of THIS task.
    revision,
    version: raw.version ?? null,
    execution: raw.execution ?? null,
    model: raw.model ?? null,
    claimedBy,
    claimedAt: raw.claimedAt ?? null,
    claim: claimedBy,
    // Read-only alias of the claim holder (`claimedBy`); null when unclaimed. A
    // lease placeholder (`lease:<id>`) is passed through as the Task Board
    // reports it, never rewritten.
    assignee: claimedBy,
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
    // NOT present in the real TaskRecord 0.10/0.11 (`TaskRecord` has no
    // `priority` and no `milestone`; the board's own priority marker is
    // `urgency`, which is NOT copied here because that would forge a field the
    // Task Board never sent). Passed through untouched when a future/other board
    // supplies them; otherwise null. Consumers must treat null as "unknown", not
    // as "normal".
    priority: raw.priority ?? null,
    milestone: raw.milestone ?? null,
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
export function createTaskboardAdapter({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 4000, token = undefined }) {
  if (typeof baseUrl !== 'string' || baseUrl === '') throw new Error('agent-board: taskboard adapter needs a base URL')
  // Injectable token resolver (tests pin it); default = the same-user local file.
  const tokenOf = typeof token === 'function' ? token : () => resolveTaskboardToken()

  // Last negotiation result (null = never probed) and the last `/state` meta,
  // used only to make a refusal message honest — never to infer write support.
  let contractState = null
  let lastStateMeta = null

  /**
   * Probe the PROPOSED execution-contract extension. It never throws: an absent
   * route negotiates as `absent` and this adapter keeps its read-only shape.
   * Being able to read the extension is NOT a permission to write with it; the
   * board must use `createTaskBoardContractClient` for that.
   */
  async function probeContract() {
    const url = new URL(TASKBOARD_CONTRACT_PATH, baseUrl).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(url, {
        method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal,
      })
    } catch (error) {
      contractState = negotiateContract({
        stateMeta: lastStateMeta,
        probeError: { code: 'unreachable', status: 0, message: String(error?.message ?? error) },
      })
      return contractState
    } finally {
      clearTimeout(timer)
    }
    const status = Number(response?.status) || 0
    if (response === null || response?.ok !== true) {
      contractState = negotiateContract({
        stateMeta: lastStateMeta,
        probeError: { code: `http_${status}`, status, message: `contract probe returned HTTP ${status}` },
      })
      return contractState
    }
    let contract = null
    let probeError = null
    try {
      const envelope = await response.json()
      contract = envelope?.ok === true ? envelope.value : null
      if (contract === null) {
        probeError = { code: 'refused', status, message: 'contract probe answered without ok:true' }
      }
    } catch (error) {
      probeError = { code: 'invalid_json', status, message: `contract probe returned invalid JSON: ${String(error?.message ?? error)}` }
    }
    contractState = negotiateContract({ contract, stateMeta: lastStateMeta, probeError })
    return contractState
  }

  async function getJson(path) {
    return requestJson('GET', path)
  }

  /** Serializable snapshot of the last negotiation (a Set is not JSON-safe). */
  function contractSummary() {
    if (contractState === null) return null
    return {
      ok: contractState.ok,
      version: contractState.version,
      features: [...contractState.features],
      missing: [...contractState.missing],
      degraded: contractState.degraded,
      absent: contractState.absent,
      writes: contractState.writes,
      reason: contractState.reason,
    }
  }

  async function requestJson(method, path, body = undefined) {
    const url = new URL(path, baseUrl).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
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
    let envelope
    try {
      envelope = await response.json()
    } catch (error) {
      throw new AdapterError('task board returned invalid JSON', { code: 'invalid_json', cause: error, adapterId: 'dsh-taskboard' })
    }
    if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
      const message = typeof envelope?.error === 'object' ? envelope.error?.message : envelope?.error
      throw new AdapterError(`task board refused the request: ${String(message ?? 'unknown error')}`, {
        code: 'refused', adapterId: 'dsh-taskboard',
      })
    }
    return envelope.value
  }

  /**
   * Bearer-authenticated board-content write (create / update / comment).
   * The token is the local file the Task Board creates for same-user plugins;
   * without it the methods refuse BEFORE any network call.
   */
  async function publicJson(method, path, body = undefined) {
    const token = tokenOf()
    if (token === undefined) {
      throw new AdapterError('Task Board public API token is unavailable', { code: 'taskboard_writes_unavailable', adapterId: 'dsh-taskboard' })
    }
    const url = new URL(`${TASKBOARD_PUBLIC_PREFIX}${path}`, baseUrl).toString()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (error) {
      throw new AdapterError(`task board public API unreachable: ${String(error?.message ?? error)}`, {
        code: 'unreachable', retryable: true, adapterId: 'dsh-taskboard', cause: error,
      })
    } finally {
      clearTimeout(timer)
    }
    let envelope = null
    try { envelope = await response.json() } catch { envelope = null }
    if (response.ok !== true || envelope?.ok !== true) {
      const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : `http_${response.status}`
      const message = typeof envelope?.error?.message === 'string' ? envelope.error.message : `public API returned HTTP ${response.status}`
      throw new AdapterError(message, { code, retryable: response.status >= 500, adapterId: 'dsh-taskboard' })
    }
    return envelope.value
  }

  const adapter = defineAdapter({
    id: 'dsh-taskboard',
    kind: 'work-source',
    title: 'DSH Task Board',
    capabilities: ['list', 'get', 'run', 'create', 'update', 'comment'],
    status: 'available',
    validatedLive: false,
    notes: 'Read-only ledger. `run` delegates execution to the Task Board executor (session/execution/worktree created by it); claim/in_review are performed by the session; done stays human-only.',
    async list() {
      const state = await getJson(TASKBOARD_STATE_PATH)
      // The ledger exposes `revision` (global monotonic counter), not `rev`.
      const ledgerRevision = state?.revision ?? state?.rev ?? null
      const tasks = Array.isArray(state?.tasks) ? state.tasks : []
      lastStateMeta = { ledgerRevision, tasksTotal: tasks.length, doneCount: Number(state?.doneCount) || 0 }
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
    /**
     * Ask the Task Board's OWN executor to run this task.
     *
     * This is deliberately NOT a ledger write: the Task Board creates the
     * session, the execution record, the claim, the permission/preset and the
     * worktree. The board only records `executionId` + `sessionId` and observes
     * the session. Contract: `POST /dsh-taskboard/tasks/:id/run` -> 202
     * `{ ok:true, value:{ ok:true, executionId, sessionId } }`.
     */
    async runTask(id, { reuseWorktree = false } = {}) {
      const value = await requestJson(
        'POST',
        `${TASKBOARD_RUN_PATH}/${encodeURIComponent(String(id))}/run`,
        reuseWorktree === true ? { reuse: true } : {},
      )
      if (value === null || typeof value !== 'object' || value.ok !== true || typeof value.sessionId !== 'string') {
        throw new AdapterError('task board did not start an execution', { code: 'run_refused', adapterId: 'dsh-taskboard' })
      }
      return {
        executionId: typeof value.executionId === 'string' ? value.executionId : null,
        sessionId: value.sessionId,
      }
    },
    /** True when the local public token exists, so board writes can be offered. */
    writesReady() {
      return tokenOf() !== undefined
    },
    /** Create one card in the Task Board's own ledger. */
    async create(input) {
      return publicJson('POST', '/tasks', input)
    },
    /**
     * Edit one card. The Task Board requires `ifVersion`: read the current
     * version first, then send the patch. A concurrent edit surfaces as
     * `version_conflict` and the proposal fails (it is re-proposed later).
     */
    async update(id, patch = {}) {
      const taskId = encodeURIComponent(String(id))
      const view = await publicJson('GET', `/tasks/${taskId}`)
      const ifVersion = typeof patch.ifVersion === 'number' ? patch.ifVersion : view?.version
      if (typeof ifVersion !== 'number') {
        throw new AdapterError('task board did not report a version', { code: 'version_conflict', adapterId: 'dsh-taskboard' })
      }
      const { ifVersion: _ignored, ...rest } = patch
      return publicJson('POST', `/tasks/${taskId}/update`, { ...rest, ifVersion })
    },
    /** Append one comment to a card. */
    async comment(id, body) {
      return publicJson('POST', `/tasks/${encodeURIComponent(String(id))}/comments`, { body })
    },
    /**
     * Probe the PROPOSED execution-contract extension. Never throws and never
     * writes: a 404 (every real 0.10/0.11 Task Board) negotiates as absent.
     */
    contract() {
      return probeContract()
    },
    /** Last negotiation snapshot, or null before `contract()` was called. */
    contractStatus() {
      return contractSummary()
    },
    describe() {
      return {
        id: 'dsh-taskboard',
        kind: 'work-source',
        title: 'DSH Task Board',
        status: 'available',
        validatedLive: adapter.validatedLive === true,
        capabilities: {
          list: true, get: true, run: true, subscribe: false,
          // Board-content writes use the Task Board's bearer-authenticated
          // public API; the host reports them unavailable when no local token
          // exists (never a silent success).
          create: tokenOf() !== undefined,
          update: tokenOf() !== undefined,
          comment: tokenOf() !== undefined,
          transition: false,
        },
        notes: adapter.notes,
        baseUrl,
        // PROPOSED extension probe result (null until probed). Informational
        // only: `writes` is what a contract client would require.
        contract: contractSummary(),
      }
    },
  })
  return adapter
}
