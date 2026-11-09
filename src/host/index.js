/**
 * Agent Board host plugin.
 *
 * Responsibilities (browser may be closed; this half keeps working):
 *   - own the durable board state (mode, proposals, assignments, read cursors,
 *     previews, provider health) with an atomic JSON file + JSONL audit log;
 *   - project native session facts it observes into that state;
 *   - orchestrate Task Board work in OFF / SUPERVISED / AUTONOMOUS modes through
 *     the native `ctx.agents` service, with leases, idempotency keys and
 *     restart reconciliation;
 *   - run the task-level failover stages (switch / handoff) with checkpoints;
 *   - serve the `/dsh-agent-board/api` HTTP + SSE contract the panel consumes.
 *
 * It never writes the Task Board ledger and never moves a task to `done`.
 *
 * @module dsh-agent-board/host
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { DEFAULT_POLICY, MODES, STATUS, isMode, newId, normalizePolicy, textOfContent, truncate } from '../contracts/model.js'
import { buildProjection, normalizeSessions } from '../supervisor/projection.js'
import { selectDispatchable, stopPlan, readinessOf } from '../orchestrator/dag.js'
import {
  LEASE_STATUS, acquireLease, assignmentKey, ensureAssignment, reconcileAfterRestart,
} from '../orchestrator/lease.js'
import { StateStore, compactState } from '../orchestrator/journal.js'
import { classifyFailure } from '../routing/classify.js'
import { planRoute, recordHealth, routeKey } from '../routing/router.js'
import { buildCheckpoint, handoffPrompt } from '../recovery/checkpoint.js'
import { createConnectors } from '../connectors/registry.js'

const execFileAsync = promisify(execFile)

export const name = 'dsh-agent-board'
export const inject = ['agents', 'webServer', 'connection', 'workspaceRegistry']

const API_PATH = '/dsh-agent-board/api/v2'
const TICK_MS = 4000
const MAX_PROPOSALS = 8
const MAX_ROUTE_EVENTS = 40
const MAX_ASSIGNMENTS_KEPT = 60
const MAX_AUDIT = 200

const OFFICIAL_PROMPT = `You are executing one Task Board task through the Agent Board.\n\nRules:\n1. The Task Board is the source of truth. Read the task and its comments first.\n2. Claim it (todo -> in_progress) with its current version before editing; if claiming fails, stop and report.\n3. Work only inside this project directory. Respect the task permission and isolation settings.\n4. Implement, then verify what you changed.\n5. Submit taskboard_execution_report, add a comment with the evidence, then move the task to in_review.\n6. NEVER move it to done: a human confirms done. If blocked, say so and stop.\n`

function createDefaultState() {
  return {
    schemaVersion: 1,
    mode: MODES.OFF,
    stoppedAt: null,
    policy: { ...DEFAULT_POLICY },
    acks: {},
    previews: {},
    turnEnd: {},
    proposals: [],
    assignments: [],
    routeEvents: [],
    audit: [],
    health: {},
    lastTick: null,
    sync: null,
  }
}

function publicStateOf(state, adapters, extra = {}) {
  return {
    schemaVersion: 1,
    mode: state.mode,
    stoppedAt: state.stoppedAt,
    policy: state.policy,
    acks: state.acks,
    previews: state.previews,
    turnEnd: state.turnEnd,
    proposals: state.proposals.filter(proposal => proposal.status === 'pending').slice(-MAX_PROPOSALS),
    recentProposals: state.proposals.slice(-MAX_PROPOSALS),
    assignments: state.assignments.slice(-MAX_ASSIGNMENTS_KEPT),
    routeEvents: state.routeEvents.slice(-MAX_ROUTE_EVENTS),
    health: state.health,
    lastTick: state.lastTick,
    sync: state.sync,
    adapters,
    audit: state.audit.slice(-40),
    ...extra,
  }
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  const store = new StateStore({ dir: join(home, 'agent-board'), now: Date.now })
  const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId : undefined
  const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl !== '' ? config.baseUrl : undefined
  const githubRepository = typeof config.githubRepository === 'string' ? config.githubRepository : undefined

  let state = createDefaultState()
  let ready = false
  let disposed = false
  let tickTimer = null
  let saveTimer = null
  const streamClients = new Set()
  const reconcileNotes = []
  let connectors = null
  let liveProjection = null

  const logger = ctx.logger ?? console
  const warn = message => { try { logger.warn?.(`[dsh-agent-board] ${message}`) } catch { /* logging never breaks the board */ } }

  function configuredOrigin() {
    if (baseUrl !== undefined) return baseUrl
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return 'http://127.0.0.1:62337'
    }
  }

  function saveSoon(delayMs = 600) {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void store.write(state).catch(error => warn(`state save failed: ${String(error)}`))
    }, delayMs)
    saveTimer.unref?.()
  }

  function broadcast() {
    if (streamClients.size === 0) return
    const payload = `event: state\ndata: ${JSON.stringify(publicStateOf(state, connectors?.describe() ?? [], { projectionSummary: liveProjection?.counts ?? null }))}\n\n`
    for (const res of streamClients) {
      try {
        res.write(payload)
      } catch {
        streamClients.delete(res)
      }
    }
  }

  function audit(event) {
    state.audit.push({ at: Date.now(), ...event })
    if (state.audit.length > MAX_AUDIT) state.audit = state.audit.slice(-MAX_AUDIT)
    void store.append(event)
  }

  function touch() {
    compactState(state)
    saveSoon()
    broadcast()
  }

  // ---------------------------------------------------------------- startup
  // Every route awaits readiness: a request that lands during startup must not
  // read (or worse, write) the default document that init() is about to load.
  const readyPromise = store.init(createDefaultState()).then(loaded => {
    state = loaded
    state.policy = normalizePolicy(state.policy ?? {})
    if (isMode(state.mode)) state.policy.mode = state.mode
    // Restart reconciliation: an assignment still marked running is only kept
    // when its live agent is genuinely there; otherwise it becomes a visible
    // `interrupted` record. Never relaunch automatically.
    const changes = reconcileAfterRestart(state.assignments, {
      now: Date.now(),
      isLive: assignment => {
        if (typeof assignment.sessionId !== 'string') return false
        try {
          return ctx.agents.get(assignment.sessionId) !== undefined
        } catch {
          return false
        }
      },
    })
    if (changes.length > 0) {
      reconcileNotes.push(...changes)
      audit({ type: 'restart_reconciled', changes })
      void store.write(state).catch(error => warn(`reconcile save failed: ${String(error)}`))
    }
    ready = true
    broadcast()
  }).catch(error => {
    warn(`state store unavailable (${String(error)}); running in memory only`)
    ready = true
  })

  connectors = createConnectors({ baseUrl: configuredOrigin(), githubRepository })

  // ------------------------------------------------------- native observation
  // Preview + turn-end facts come from the session log itself (durable events),
  // never from polling a status endpoint and never from elapsed time.
  const unsubscribe = ctx.on('session/event', (session, event) => {
    try {
      const sessionId = String(session?.id ?? '')
      if (sessionId === '') return
      if (event?.type === 'assistant/message') {
        const data = event.data ?? {}
        const text = textOfContent(data.message?.content ?? data.content ?? data.text)
        if (text.trim() !== '') {
          state.previews[sessionId] = { text: truncate(text.trim(), 600), at: Number(event.time) || Date.now() }
          saveSoon(1500)
        }
        return
      }
      if (event?.type === 'turn/end') {
        const reason = event?.data?.reason ?? {}
        const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
        const error = typeof reason?.error?.message === 'string' ? truncate(reason.error.message, 300) : null
        state.turnEnd[sessionId] = { at: Number(event.time) || Date.now(), kind, error }
        saveSoon()
        void onTurnEnd(sessionId, kind, error)
        return
      }
      if (event?.type === 'turn/start') {
        // A new turn clears the previous error disposition for that session.
        if (state.turnEnd[sessionId]?.kind === 'error') {
          state.turnEnd[sessionId] = { ...state.turnEnd[sessionId], recoveredAt: Number(event.time) || Date.now() }
        }
      }
    } catch (error) {
      warn(`session event handling failed: ${String(error)}`)
    }
  })

  // ----------------------------------------------------------- agent launcher
  function resolveWorkspace(workspaceIdValue) {
    try {
      const registry = ctx.workspaceRegistry
      const byId = registry?.get?.(workspaceIdValue)
      if (byId !== undefined) return byId
      const byPath = registry?.list?.()?.find?.(ws => ws.path === workspaceIdValue)
      if (byPath !== undefined) return byPath
    } catch (error) {
      warn(`workspace lookup failed: ${String(error)}`)
    }
    return undefined
  }

  function defaultRoute() {
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection !== null && selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch { /* optional */ }
    return state.policy.routeChain[0] ?? null
  }

  function routeForTask(task) {
    const pinned = task?.model
    if (pinned !== null && pinned !== undefined && typeof pinned.provider === 'string' && typeof pinned.model === 'string') {
      return { provider: pinned.provider, model: pinned.model, reasoningEffort: pinned.reasoningEffort, locality: pinned.locality ?? 'remote' }
    }
    return defaultRoute()
  }

  function buildLaunchBody(task, assignment) {
    return [
      `Task Board task ${task.id} — ${task.title}`,
      `Project: ${task.workspaceId}`,
      `Urgency: ${task.urgency}`,
      task.dependsOn?.length ? `Prerequisites (already done): ${task.dependsOn.join(', ')}` : 'Prerequisites: none',
      '',
      typeof task.description === 'string' && task.description !== '' ? task.description : '(no description)',
      '',
      OFFICIAL_PROMPT,
      '',
      `Agent Board assignment: ${assignment.id} (attempt ${assignment.attempt}, route ${routeKey(assignment.model)}).`,
    ].join('\n')
  }

  async function createSession({ task, assignment, message, previousSessionId = null }) {
    const workspace = resolveWorkspace(task.workspaceId)
    if (workspace === undefined) {
      throw new Error(`unknown workspace ${JSON.stringify(task.workspaceId)}: the board only launches inside a registered DSH workspace`)
    }
    const sessionId = previousSessionId ?? `session-agentboard-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`
    const route = assignment.model ?? routeForTask(task)
    const agentOptions = route !== null && route !== undefined ? {
      ...(typeof route.provider === 'string' ? { provider: route.provider } : {}),
      ...(typeof route.model === 'string' ? { model: route.model } : {}),
      ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
    } : undefined
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      ...(agentOptions !== undefined ? { agentOptions } : {}),
    })
    try {
      await workspace.attachSession?.(sessionId)
    } catch (error) {
      warn(`attachSession(${sessionId}) failed: ${String(error)}`)
    }
    try {
      const sessions = ctx.get?.('sessions')
      const title = ctx.get?.('sessionTitle')
      const session = sessions?.get?.(sessionId)
      if (session !== undefined && title?.rename !== undefined) title.rename(session, `Agent Board — ${truncate(task.title, 60)}`)
      // Honour the Task Board card's permission level when it declares one.
      // Best-effort: an absent permission service must not block the launch.
      if (typeof task.permission === 'string' && task.permission !== '') {
        const presets = ctx.get?.('permissionPresets')
        if (session !== undefined && typeof presets?.set === 'function') presets.set(session, task.permission)
      }
    } catch { /* cosmetic / optional */ }
    const mkMessage = (text, sourceKind) => ({
      id: `msg-agentboard-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: sourceKind },
    })
    handle.agent.inject(mkMessage(`Agent Board framing — ${task.id} — ${truncate(task.title, 120)}`, 'dsh-agent-board'))
    handle.agent.followup(mkMessage(message, 'user'))
    return { sessionId, handle }
  }

  async function launchTask({ task, proposalId = null }) {
    const revision = task.revision ?? null
    const key = assignmentKey({ taskId: task.id, revision, attempt: 0 })
    const existing = state.assignments.find(assignment => assignment.idempotencyKey === key && assignment.status !== LEASE_STATUS.FAILED)
    if (existing !== undefined) {
      return { ok: false, reason: 'duplicate_assignment', assignmentId: existing.id }
    }
    const acquired = acquireLease(undefined, { owner: 'agent-board', now: Date.now(), ttlMs: state.policy.leaseTtlMs })
    const draft = {
      taskId: task.id,
      revision,
      workspaceId: task.workspaceId,
      attempt: 0,
      idempotencyKey: key,
      model: routeForTask(task),
      status: LEASE_STATUS.STARTING,
      lease: acquired.lease,
      fencingToken: acquired.fencingToken,
      startedAt: Date.now(),
    }
    const { assignment } = ensureAssignment(state.assignments, draft)
    state.assignments.push(assignment)
    if (proposalId !== null) {
      const proposal = state.proposals.find(entry => entry.id === proposalId)
      if (proposal !== undefined) proposal.status = 'approved'
    }
    touch()
    try {
      const { sessionId } = await createSession({ task, assignment, message: buildLaunchBody(task, assignment) })
      assignment.sessionId = sessionId
      assignment.status = LEASE_STATUS.RUNNING
      assignment.lease = { ...acquired.lease, expiresAt: Date.now() + state.policy.leaseTtlMs }
      audit({ type: 'launch', taskId: task.id, assignmentId: assignment.id, sessionId, route: routeKey(assignment.model) })
      touch()
      return { ok: true, assignmentId: assignment.id, sessionId }
    } catch (error) {
      assignment.status = LEASE_STATUS.FAILED
      assignment.endedAt = Date.now()
      assignment.error = truncate(String(error?.message ?? error), 400)
      audit({ type: 'launch_failed', taskId: task.id, assignmentId: assignment.id, error: assignment.error })
      touch()
      return { ok: false, reason: 'launch_failed', error: assignment.error }
    }
  }

  // ------------------------------------------------------------- failover
  async function gatherGit(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return null
    const run = async args => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd, timeout: 4000, windowsHide: true, maxBuffer: 1024 * 1024 })
        return stdout.trim()
      } catch {
        return null
      }
    }
    const head = await run(['rev-parse', 'HEAD'])
    if (head === null) return null
    return {
      head,
      branch: await run(['rev-parse', '--abbrev-ref', 'HEAD']),
      status: (await run(['status', '--porcelain'])) ?? '',
      commits: ((await run(['log', '--oneline', '-5'])) ?? '').split('\n').filter(Boolean),
      changedFiles: ((await run(['diff', '--name-only', 'HEAD'])) ?? '').split('\n').filter(Boolean).slice(0, 200),
    }
  }

  async function onTurnEnd(sessionId, kind, error) {
    const assignment = state.assignments.find(entry => entry.sessionId === sessionId && [LEASE_STATUS.STARTING, LEASE_STATUS.RUNNING].includes(entry.status))
    if (assignment === undefined) return
    const cwd = (() => {
      try {
        return ctx.get?.('workingDirectory')?.get?.(ctx.get?.('sessions')?.get?.(sessionId)) ?? undefined
      } catch {
        return undefined
      }
    })()
    if (kind === 'completed' || kind === 'blocked' || kind === 'max-tokens' || kind === 'aborted') {
      assignment.status = LEASE_STATUS.DONE
      assignment.endedAt = Date.now()
      assignment.outcome = kind
      audit({ type: 'turn_done', taskId: assignment.taskId, assignmentId: assignment.id, kind })
      touch()
      return
    }
    if (kind !== 'error') {
      assignment.status = LEASE_STATUS.DONE
      assignment.endedAt = Date.now()
      assignment.outcome = kind
      touch()
      return
    }
    const failure = classifyFailure({
      message: error ?? 'turn ended in error',
      phase: 'stream',
      // If this turn already produced assistant output, the request cannot be
      // silently replayed: that is a partial-stream case, resolved by handoff.
      afterFirstChunk: Number(state.previews[sessionId]?.at) >= Number(assignment.startedAt),
    })
    const policy = state.policy
    const currentRoute = assignment.model ?? defaultRoute()
    const triedRoutes = assignment.routeHistory.map(entry => entry.to)
    const plan = planRoute({
      failure,
      retries: Number(assignment.retries) || 0,
      switches: Number(assignment.switches) || 0,
      currentRoute,
      chain: policy.routeChain,
      policy,
      health: state.health,
      now: Date.now(),
      triedRoutes,
    })
    state.health = recordHealth(state.health, { provider: currentRoute?.provider ?? 'unknown', kind: failure.kind })
    state.routeEvents.push({
      at: Date.now(),
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      from: currentRoute === null || currentRoute === undefined ? null : routeKey(currentRoute),
      to: plan.nextRoute === null ? null : routeKey(plan.nextRoute),
      action: plan.action,
      reason: plan.reason,
      kind: failure.kind,
    })
    if (state.routeEvents.length > MAX_ROUTE_EVENTS * 4) state.routeEvents = state.routeEvents.slice(-MAX_ROUTE_EVENTS * 2)
    audit({ type: 'route_decision', assignmentId: assignment.id, action: plan.action, reason: plan.reason, kind: failure.kind })
    if (plan.action === 'stop') {
      assignment.status = LEASE_STATUS.FAILED
      assignment.endedAt = Date.now()
      assignment.error = `${failure.kind}: ${failure.message}`
      touch()
      return
    }
    if (plan.action === 'retry') {
      // Same-route retry happens inside the SAME session, bounded, and only
      // because the turn truly ended (no partial stream reaches this branch —
      // partial output is classified PARTIAL_STREAM and routed to handoff).
      assignment.retries = (Number(assignment.retries) || 0) + 1
      assignment.status = LEASE_STATUS.RUNNING
      const agent = ctx.agents.get(sessionId)
      const message = `The previous turn failed with ${failure.kind}. Retry the unfinished work in this session. Do not duplicate side effects that already succeeded; re-read the files first. Report the outcome as usual (at most in_review).`
      try {
        agent?.followup?.({
          id: `msg-agentboard-retry-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: message }],
          source: { kind: 'user' },
        })
      } catch (retryError) {
        assignment.status = LEASE_STATUS.FAILED
        assignment.endedAt = Date.now()
        assignment.error = `retry dispatch failed: ${String(retryError)}`
      }
      touch()
      return
    }
    if (plan.action === 'switch' || plan.action === 'handoff') {
      const task = { id: assignment.taskId, title: assignment.taskTitle ?? assignment.taskId, workspaceId: assignment.workspaceId }
      const checkpoint = buildCheckpoint({
        assignment,
        sessionId,
        lastText: state.previews[sessionId]?.text ?? '',
        git: await gatherGit(cwd),
        actions: [],
        now: Date.now(),
      })
      assignment.checkpoint = checkpoint
      assignment.status = plan.action === 'handoff' ? LEASE_STATUS.SUPERSEDED : LEASE_STATUS.FAILED
      assignment.endedAt = Date.now()
      assignment.error = `${failure.kind}: ${failure.message}`.slice(0, 400)
      const attempt = (Number(assignment.attempt) || 0) + 1
      const key = assignmentKey({ taskId: assignment.taskId, revision: assignment.revision, attempt })
      const nextRoute = plan.nextRoute
      const next = ensureAssignment(state.assignments, {
        taskId: assignment.taskId,
        revision: assignment.revision,
        workspaceId: assignment.workspaceId,
        attempt,
        idempotencyKey: key,
        model: nextRoute,
        status: LEASE_STATUS.STARTING,
        previousSessionId: sessionId,
        routeHistory: [...assignment.routeHistory, { at: Date.now(), from: routeKey(assignment.model), to: routeKey(nextRoute), reason: plan.reason, checkpointId: checkpoint.id }],
        startedAt: Date.now(),
      })
      state.assignments.push(next.assignment)
      try {
        const prompt = handoffPrompt(checkpoint, { task, fromRoute: assignment.model, toRoute: nextRoute, reason: plan.reason })
        const created = await createSession({ task, assignment: next.assignment, message: prompt })
        next.assignment.sessionId = created.sessionId
        next.assignment.status = LEASE_STATUS.RUNNING
        audit({ type: 'handoff', taskId: assignment.taskId, from: sessionId, to: created.sessionId, route: routeKey(nextRoute) })
      } catch (error) {
        next.assignment.status = LEASE_STATUS.FAILED
        next.assignment.error = truncate(String(error?.message ?? error), 400)
        next.assignment.endedAt = Date.now()
        audit({ type: 'handoff_failed', taskId: assignment.taskId, error: next.assignment.error })
      }
      touch()
      return
    }
    assignment.status = LEASE_STATUS.FAILED
    assignment.endedAt = Date.now()
    assignment.error = `no recovery: ${plan.reason}`
    touch()
  }

  // ------------------------------------------------------------ orchestration
  function runningAssignments() {
    return state.assignments.filter(assignment => [LEASE_STATUS.STARTING, LEASE_STATUS.RUNNING].includes(assignment.status))
  }

  async function tick(reason = 'timer') {
    if (!ready || disposed) return { ok: false, reason: 'not_ready' }
    if (state.mode === MODES.OFF) {
      state.lastTick = { at: Date.now(), reason, mode: state.mode, actions: [], skipped: [{ reason: 'mode_off' }] }
      return { ok: true, actions: [] }
    }
    try {
      const listed = await connectors.get('dsh-taskboard').list()
      const tasks = listed.items
      // expire stale proposals
      for (const proposal of state.proposals) {
        if (proposal.status === 'pending' && Date.now() - proposal.createdAt > state.policy.proposalTtlMs) proposal.status = 'expired'
      }
      const remainingProposals = state.proposals.filter(proposal => proposal.status === 'pending')
      const plan = selectDispatchable({
        tasks,
        assignments: state.assignments,
        proposals: remainingProposals,
        policy: { ...state.policy, mode: state.mode },
        now: Date.now(),
      })
      state.sync = { ok: true, at: Date.now(), ledgerRevision: listed.meta?.ledgerRevision ?? null, tasksTotal: listed.meta?.tasksTotal ?? tasks.length, error: null }
      const actions = []
      for (const action of plan.actions) {
        if (action.kind === 'proposal') {
          if (remainingProposals.length >= MAX_PROPOSALS) break
          const proposal = {
            id: newId('prop'),
            taskId: action.task.id,
            title: action.task.title,
            workspaceId: action.workspaceId,
            revision: action.revision,
            createdAt: Date.now(),
            status: 'pending',
            reason: action.reason,
          }
          state.proposals.push(proposal)
          remainingProposals.push(proposal)
          actions.push({ kind: 'proposal', taskId: proposal.taskId, proposalId: proposal.id })
        } else {
          const result = await launchTask({ task: action.task })
          actions.push({ kind: 'launch', taskId: action.task.id, ...result })
        }
      }
      state.lastTick = { at: Date.now(), reason, mode: state.mode, actions, skipped: plan.skipped.slice(0, 40) }
      if (actions.length > 0) audit({ type: 'tick', mode: state.mode, actions })
      touch()
      return { ok: true, actions }
    } catch (error) {
      const message = truncate(String(error?.message ?? error), 300)
      state.sync = { ok: false, at: Date.now(), error: message }
      state.lastTick = { at: Date.now(), reason, mode: state.mode, actions: [], error: message }
      audit({ type: 'tick_failed', error: message })
      touch()
      return { ok: false, reason: 'sync_failed', error: message }
    }
  }

  function startTimer() {
    if (tickTimer !== null) return
    tickTimer = setInterval(() => {
      if (state.mode !== MODES.OFF && state.stoppedAt === null) void tick('timer')
    }, TICK_MS)
    tickTimer.unref?.()
  }
  startTimer()

  async function stopExecutions() {
    const targets = stopPlan(state.assignments)
    const stopped = []
    for (const target of targets) {
      const assignment = state.assignments.find(entry => entry.id === target.assignmentId)
      let cancelled = false
      try {
        const agent = ctx.agents.get(target.sessionId)
        if (typeof agent?.cancel === 'function') {
          agent.cancel({ kind: 'user' })
          cancelled = true
        }
      } catch (error) {
        warn(`cancel(${target.sessionId}) failed: ${String(error)}`)
      }
      if (assignment !== undefined) {
        assignment.status = LEASE_STATUS.STOPPED
        assignment.endedAt = Date.now()
        assignment.error = cancelled ? 'stopped_by_operator' : 'stop_requested_agent_unavailable'
      }
      stopped.push({ ...target, cancelled })
    }
    state.stoppedAt = Date.now()
    audit({ type: 'stop_all', stopped })
    touch()
    return stopped
  }

  // --------------------------------------------------------------- HTTP API
  function sendJson(res, statusCode, value) {
    try {
      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    } catch { /* connection closed */ }
  }

  function readJsonBody(req) {
    return new Promise(resolve => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > 512 * 1024) {
          resolve(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  const routeDefinition = {
    path: API_PATH,
    handler(req, res) {
      try {
        const rejection = ctx.connection?.requestRejection?.(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'Content-Type': 'text/plain' })
          res.end('unauthorized')
          return
        }
        const url = new URL(req.url ?? '/', 'http://agent-board')
        const route = url.pathname.slice(API_PATH.length) || '/'
        const method = req.method ?? 'GET'

        if (method === 'GET' && route === '/state') {
          void readyPromise.then(() => sendJson(res, 200, { ok: true, value: publicStateOf(state, connectors.describe(), { reconcileNotes }) }))
          return
        }
        if (method === 'GET' && route === '/events') {
          void readyPromise.then(() => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
            res.write(`event: state\ndata: ${JSON.stringify(publicStateOf(state, connectors.describe(), { reconcileNotes }))}\n\n`)
            streamClients.add(res)
            const remove = () => streamClients.delete(res)
            req.on('close', remove)
            res.on('close', remove)
          })
          return
        }
        if (method === 'GET' && route === '/adapters') {
          void readyPromise.then(() => sendJson(res, 200, { ok: true, value: connectors.describe() }))
          return
        }
        if (method === 'POST') {
          void (async () => {
            await readyPromise
            const body = await readJsonBody(req)
            if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid_json' })
            if (route === '/mode') {
              const nextMode = body.mode
              if (!isMode(nextMode)) return sendJson(res, 400, { ok: false, error: 'invalid_mode' })
              const previous = state.mode
              state.mode = nextMode
              state.policy.mode = nextMode
              if (nextMode !== MODES.OFF) state.stoppedAt = null
              audit({ type: 'mode_changed', from: previous, to: nextMode })
              touch()
              return sendJson(res, 200, { ok: true, value: { mode: state.mode, stoppedAt: state.stoppedAt } })
            }
            if (route === '/stop') {
              const stopped = await stopExecutions()
              return sendJson(res, 200, { ok: true, value: { stopped } })
            }
            if (route === '/ack') {
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
              if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId_required' })
              state.acks[sessionId] = { seenAt: Date.now(), lastTurnEnd: state.turnEnd[sessionId]?.at ?? null }
              audit({ type: 'ack', sessionId })
              touch()
              return sendJson(res, 200, { ok: true })
            }
            if (route === '/policy') {
              const incoming = { ...state.policy, ...(body.policy ?? {}) }
              if (!isMode(body.policy?.mode)) incoming.mode = state.mode
              const merged = normalizePolicy(incoming, state.policy)
              state.policy = merged
              state.mode = merged.mode
              audit({ type: 'policy_changed', policy: merged })
              touch()
              return sendJson(res, 200, { ok: true, value: merged })
            }
            if (route === '/tick') {
              const result = await tick('manual')
              return sendJson(res, result.ok ? 200 : 502, result)
            }
            const decide = route.match(/^\/proposals\/([^/]+)\/decide$/)
            if (decide !== null) {
              const proposal = state.proposals.find(entry => entry.id === decide[1])
              if (proposal === undefined || proposal.status !== 'pending') return sendJson(res, 404, { ok: false, error: 'proposal_not_pending' })
              if (body.approve !== true) {
                proposal.status = 'rejected'
                audit({ type: 'proposal_rejected', proposalId: proposal.id, taskId: proposal.taskId })
                touch()
                return sendJson(res, 200, { ok: true, value: { approved: false } })
              }
              const listed = await connectors.get('dsh-taskboard').list()
              const task = listed.items.find(item => item.id === proposal.taskId)
              if (task === undefined) return sendJson(res, 409, { ok: false, error: 'task_gone' })
              const readiness = readinessOf(task, new Map(listed.items.map(item => [item.id, item])))
              if (!readiness.ready) return sendJson(res, 409, { ok: false, error: readiness.reason })
              const launched = await launchTask({ task, proposalId: proposal.id })
              return sendJson(res, launched.ok ? 200 : 409, launched)
            }
            const dispatch = route.match(/^\/dispatch$/)
            if (dispatch !== null) {
              const taskId = typeof body.taskId === 'string' ? body.taskId : ''
              if (taskId === '') return sendJson(res, 400, { ok: false, error: 'taskId_required' })
              const listed = await connectors.get('dsh-taskboard').list()
              const task = listed.items.find(item => item.id === taskId)
              if (task === undefined) return sendJson(res, 404, { ok: false, error: 'task_not_found' })
              const readiness = readinessOf(task, new Map(listed.items.map(item => [item.id, item])))
              if (!readiness.ready) return sendJson(res, 409, { ok: false, error: readiness.reason })
              const launched = await launchTask({ task })
              return sendJson(res, launched.ok ? 200 : 409, launched)
            }
            return sendJson(res, 404, { ok: false, error: 'not_found' })
          })().catch(error => sendJson(res, 500, { ok: false, error: truncate(String(error?.message ?? error), 300) }))
          return
        }
        sendJson(res, 404, { ok: false, error: 'not_found' })
      } catch (error) {
        warn(`route failure: ${String(error)}`)
        sendJson(res, 500, { ok: false, error: 'internal_error' })
      }
    },
  }
  // Register through ctx.effect: the fiber's teardown must remove the route.
  // A plain returned disposer is not enough here — a leaked route would block
  // every later activation with "duplicate route" until the Host restarts.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = ctx.webServer.register(routeDefinition)
      return () => {
        try { dispose() } catch { /* already gone */ }
      }
    }, 'dsh-agent-board: http api')
  } else {
    ctx.webServer.register(routeDefinition)
  }

  // Keep a cheap, live projection available for diagnostics (session events are
  // the only inputs; this is not used to infer running/finished from time).
  const projectionTimer = setInterval(() => {
    try {
      const sessions = ctx.get?.('sessions')
      if (sessions?.list === undefined) return
      liveProjection = buildProjection({ list: sessions.list(), statusMap: new Map(), hostState: state, workspaces: {}, now: Date.now() })
    } catch { /* diagnostics only */ }
  }, 15_000)
  projectionTimer.unref?.()

  return () => {
    disposed = true
    if (tickTimer !== null) clearInterval(tickTimer)
    if (projectionTimer !== null) clearInterval(projectionTimer)
    if (saveTimer !== null) clearTimeout(saveTimer)
    for (const res of streamClients) {
      try { res.end() } catch { /* closed */ }
    }
    streamClients.clear()
    try { unsubscribe?.() } catch { /* already disposed */ }
    void store.write(state).catch(() => {})
  }
}

export const configSchema = {
  workspaceId: { type: 'string', description: 'Optional default workspace id for manual dispatches.' },
  baseUrl: { type: 'string', description: 'Origin of the Task Board HTTP API (defaults to the DSH web origin).' },
  githubRepository: { type: 'string', description: 'Optional owner/name for the read-only GitHub adapter.' },
}

/** Exposed for tests and for future services: the status vocabulary is contract. */
export const AGENT_BOARD_STATUSES = STATUS

