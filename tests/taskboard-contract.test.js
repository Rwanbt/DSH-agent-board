/**
 * Task Board execution-contract extension — contract tests.
 *
 * Everything here runs against `tests/fixtures/fake-taskboard-server.mjs`, a
 * SIMULATED HTTP server that banners itself with
 * `x-simulated-contract: true`. No real Task Board is contacted, no ledger is
 * read or written, and the real plugin (`D:\App\dsh-taskboard`) is untouched.
 *
 * The tests pin five properties:
 *  1. negotiation is honest: absent / partial / newer versions never look usable;
 *  2. a missing extension NEVER silently emulates an execution;
 *  3. the happy path (lease → attach → report → settle) records ONE execution
 *     and reaches `in_review`, never `done`;
 *  4. conflicts (double lease, stale version, foreign claim) are stable codes;
 *  5. the §6.3 ten-step flow happens in order, and the steps owned by other
 *     layers stay theirs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskboardAdapter } from '../src/connectors/taskboard.js'
import {
  createTaskBoardContractClient,
  executionIdempotencyKey,
  negotiateContract,
  TASKBOARD_CONTRACT_FEATURES,
  TASKBOARD_CONTRACT_VERSION,
} from '../src/connectors/taskboard-contract.js'
import {
  SIMULATED_CONTRACT_HEADER,
  simulatedTask,
  startSimulatedTaskBoard,
} from './fixtures/fake-taskboard-server.mjs'

const REPORT = {
  summary: 'Implemented the contract bridge and its simulated server.',
  changedFiles: ['src/connectors/taskboard-contract.js'],
  checks: ['node --test tests/'],
  artifacts: [],
  risk: '',
}

const TASK_ID = 't-contract-1'

async function withBoard(t, options = {}) {
  const server = await startSimulatedTaskBoard(options)
  t.after(async () => {
    await server.close()
  })
  const client = createTaskBoardContractClient({
    baseUrl: server.url,
    stateMeta: { ledgerRevision: 100, tasksTotal: 2 },
  })
  const adapter = createTaskboardAdapter({ baseUrl: server.url })
  return { server, client, adapter }
}

test('negotiation matrix: absent, unreachable, present, partial and newer versions', () => {
  const absent = negotiateContract({ probeError: { code: 'http_404', status: 404 } })
  assert.equal(absent.ok, false)
  assert.equal(absent.absent, true)
  assert.equal(absent.version, null)
  assert.equal(absent.features.size, 0)
  assert.equal(absent.writes, false)
  assert.deepEqual([...absent.missing].sort(), [...TASKBOARD_CONTRACT_FEATURES].sort())
  assert.equal(absent.reason, 'contract_endpoint_absent')

  const unreachable = negotiateContract({ probeError: { code: 'unreachable', status: 0 } })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.absent, false, 'a transport failure is not "absent"')
  assert.equal(unreachable.degraded, true)
  assert.equal(unreachable.writes, false)
  assert.equal(unreachable.reason, 'contract_probe_failed')

  const present = negotiateContract({ contract: { version: TASKBOARD_CONTRACT_VERSION, features: [...TASKBOARD_CONTRACT_FEATURES] } })
  assert.equal(present.ok, true)
  assert.equal(present.version, TASKBOARD_CONTRACT_VERSION)
  assert.equal(present.writes, true)
  assert.equal(present.degraded, false)
  assert.equal(present.reason, 'contract_ok')
  assert.equal(present.simulated, false)
  assert.equal(present.features.has('execution.settle'), true)

  // The envelope form is accepted too, so callers can pass the raw HTTP body.
  const enveloped = negotiateContract({
    contract: { ok: true, value: { contract: { version: 1, features: [...TASKBOARD_CONTRACT_FEATURES], simulated: true } } },
  })
  assert.equal(enveloped.ok, true)
  assert.equal(enveloped.simulated, true)

  const partial = negotiateContract({ contract: { version: 1, features: ['execution.lease', 'execution.attach'] } })
  assert.equal(partial.ok, true, 'the version is compatible ...')
  assert.equal(partial.degraded, true, '... but the extension is incomplete')
  assert.equal(partial.writes, false, 'a partial extension must not be used for writes')
  assert.equal(partial.reason, 'partial_features')
  assert.ok(partial.missing.includes('execution.settle'))
  assert.ok(partial.missingWrite.includes('execution.report'))

  const newer = negotiateContract({ contract: { version: TASKBOARD_CONTRACT_VERSION + 1, features: [...TASKBOARD_CONTRACT_FEATURES] } })
  assert.equal(newer.ok, false)
  assert.equal(newer.version, TASKBOARD_CONTRACT_VERSION + 1)
  assert.equal(newer.writes, false)
  assert.equal(newer.reason, 'unsupported_version')

  const malformed = negotiateContract({ contract: { features: [] } })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.reason, 'contract_malformed')
})

test('absent extension: no write is emulated, no POST reaches the Task Board, reads still work', async t => {
  const { server, client, adapter } = await withBoard(t, { contractMode: 'absent' })

  const negotiation = await client.contract()
  assert.equal(negotiation.ok, false)
  assert.equal(negotiation.absent, true)
  assert.equal(negotiation.writes, false)
  assert.equal(negotiation.features.size, 0)
  assert.match(negotiation.reason, /absent|route_missing/)

  // Even a well-formed request is refused locally: nothing is "tried anyway".
  const refused = await client.leaseExecution(TASK_ID, { attempt: 1, expectedVersion: 3, route: { provider: 'p', model: 'm' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'not_negotiated')
  assert.equal(refused.status, 0, 'a local refusal carries no HTTP status')
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 0, 'no execution write may be attempted')

  // The read path is untouched by the missing extension.
  const listed = await adapter.list()
  assert.equal(listed.items.length, 2)
  assert.equal(listed.items[0].id, TASK_ID)

  // The adapter's probe never throws on the 404 and reports the honest state.
  const probed = await adapter.contract()
  assert.equal(probed.ok, false)
  assert.equal(probed.absent, true)
  assert.equal(adapter.contractStatus().absent, true)
  assert.equal(adapter.describe().contract.absent, true)
  assert.equal(adapter.describe().capabilities.create, false)
})

test('full extension: version 1 negotiates every proposed feature over HTTP', async t => {
  const { client } = await withBoard(t)
  const negotiation = await client.contract()
  assert.equal(negotiation.ok, true)
  assert.equal(negotiation.version, TASKBOARD_CONTRACT_VERSION)
  assert.deepEqual([...negotiation.features].sort(), [...TASKBOARD_CONTRACT_FEATURES].sort())
  assert.deepEqual(negotiation.missing, [])
  assert.deepEqual(negotiation.missingWrite, [])
  assert.equal(negotiation.writes, true)
  assert.equal(negotiation.degraded, false)
  assert.equal(negotiation.reason, 'contract_ok')
  assert.equal(negotiation.simulated, true, 'the simulated server says so in its own payload')
  for (const feature of TASKBOARD_CONTRACT_FEATURES) assert.equal(client.supports(feature), true, feature)
})

test('partial extension: negotiation degrades and every write is refused before HTTP', async t => {
  const { server, client } = await withBoard(t, {
    contractMode: 'partial',
    features: ['execution.lease', 'execution.attach'],
  })
  const negotiation = await client.contract()
  assert.equal(negotiation.ok, true)
  assert.equal(negotiation.degraded, true)
  assert.equal(negotiation.writes, false)
  assert.equal(negotiation.reason, 'partial_features')
  assert.ok(negotiation.missing.includes('execution.report'))
  assert.ok(negotiation.missingWrite.includes('execution.settle'))

  const refused = await client.leaseExecution(TASK_ID, { attempt: 1, expectedVersion: 3 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'not_negotiated')
  assert.match(refused.message, /partial/)
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 0)

  // A read-only front door (contract probe) is allowed; a half-write is not.
  const readOnly = await client.submitReport('lease-1', REPORT)
  assert.equal(readOnly.code, 'not_negotiated')
})

test('happy path: lease → attach → report → settle records one execution and reaches in_review', async t => {
  const { server, client, adapter } = await withBoard(t)
  await client.contract()

  const lease = await client.leaseExecution(TASK_ID, {
    route: { provider: 'primary', model: 'big' },
    attempt: 1,
    expectedVersion: 3,
  })
  assert.equal(lease.ok, true, JSON.stringify(lease))
  assert.equal(lease.status, 202)
  assert.match(lease.value.leaseId, /^lease-/)
  assert.match(lease.value.executionId, /^exec-/)
  assert.equal(lease.value.state, 'leased')
  assert.equal(lease.value.attempt, 1)
  assert.ok(lease.value.fence > 0)
  assert.ok(lease.value.expiresAt > Date.now(), 'the lease carries a TTL')
  const leaseId = lease.value.leaseId

  const attach = await client.attachSession(leaseId, { sessionId: 'session-board-1', route: { provider: 'primary', model: 'big' } })
  assert.equal(attach.ok, true)
  assert.equal(attach.status, 200)
  assert.equal(attach.value.sessionId, 'session-board-1')
  assert.equal(attach.value.leaseId, leaseId)

  const report = await client.submitReport(leaseId, REPORT)
  assert.equal(report.ok, true)
  assert.equal(report.value.reportRevision, 1)

  const settled = await client.settleExecution(leaseId, {
    outcome: 'succeeded',
    report: { ...REPORT, summary: 'Settled with the final report.' },
    requestReview: true,
  })
  assert.equal(settled.ok, true, JSON.stringify(settled))
  assert.equal(settled.value.outcome, 'succeeded')
  assert.equal(settled.value.status, 'in_review')
  assert.equal(settled.value.taskId, TASK_ID)
  assert.ok(settled.value.taskVersion > lease.value.taskVersion)

  const { items } = await adapter.list()
  const task = items.find(item => item.id === TASK_ID)
  assert.equal(task.status, 'in_review')
  assert.equal(task.activeExecution, false)
  assert.equal(task.claimedBy, null)
  assert.equal(task.executionsTotal, 1)
  assert.equal(task.lastExecutionOutcome, 'succeeded')
  assert.equal(task.version, settled.value.taskVersion)

  const raw = server.task(TASK_ID)
  assert.equal(raw.executions.length, 1)
  assert.equal(raw.executions[0].outcome, 'succeeded')
  assert.equal(raw.executions[0].sessionId, 'session-board-1')
  assert.equal(raw.executions[0].leaseId, leaseId)
  assert.equal(raw.executions[0].route.provider, 'primary')
  assert.equal(raw.executions[0].report.summary, 'Settled with the final report.')
  assert.notEqual(raw.status, 'done', 'the board never settles a task to done')
})

test('idempotent attach: same lease + same session is one record; another session is refused', async t => {
  const { server, client } = await withBoard(t)
  await client.contract()
  const lease = await client.leaseExecution(TASK_ID, { attempt: 1, expectedVersion: 3 })
  const leaseId = lease.value.leaseId

  const first = await client.attachSession(leaseId, { sessionId: 'session-a' })
  assert.equal(first.ok, true)
  const versionAfterFirst = server.task(TASK_ID).version

  const replay = await client.attachSession(leaseId, { sessionId: 'session-a' })
  assert.equal(replay.ok, true)
  assert.deepEqual(replay.value, first.value, 'a replayed attach returns the SAME record')
  assert.equal(server.task(TASK_ID).version, versionAfterFirst, 'a replayed attach does not bump the version')
  assert.equal(server.task(TASK_ID).executions.length, 1)

  const foreign = await client.attachSession(leaseId, { sessionId: 'session-b' })
  assert.equal(foreign.ok, false)
  assert.equal(foreign.code, 'claim_conflict')
  assert.equal(foreign.status, 409)
  assert.equal(server.task(TASK_ID).claimedBy, 'session-a')

  const unknown = await client.attachSession('lease-does-not-exist', { sessionId: 'session-a' })
  assert.equal(unknown.code, 'not_found')
  assert.equal(unknown.status, 404)
})

test('double lease: the same idempotency key replays, a different key conflicts', async t => {
  const { server, client } = await withBoard(t)
  await client.contract()
  const first = await client.leaseExecution(TASK_ID, { idempotencyKey: 'attempt-1-key', attempt: 1, expectedVersion: 3 })
  assert.equal(first.ok, true)

  const replay = await client.leaseExecution(TASK_ID, { idempotencyKey: 'attempt-1-key', attempt: 1 })
  assert.equal(replay.ok, true)
  assert.equal(replay.value.leaseId, first.value.leaseId, 'one idempotency key = one execution attempt')
  assert.equal(server.task(TASK_ID).executions.length, 1)

  const second = await client.leaseExecution(TASK_ID, { idempotencyKey: 'attempt-2-key', attempt: 2, expectedVersion: 4 })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'lease_conflict')
  assert.equal(second.status, 409)
  assert.equal(server.task(TASK_ID).executions.length, 1, 'a refused lease records nothing')
})

test('stale version: a lease on an old task version is refused with version_conflict', async t => {
  const { client } = await withBoard(t)
  await client.contract()
  const stale = await client.leaseExecution('t-contract-2', { attempt: 1, expectedVersion: 999 })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'version_conflict')
  assert.equal(stale.status, 409)
  assert.match(stale.message, /stale task version/)
})

test('foreign claim: a task another session holds is refused with claim_conflict', async t => {
  const { client } = await withBoard(t, {
    tasks: [
      simulatedTask({
        id: 't-claimed',
        title: 'Held by another session',
        status: 'in_progress',
        version: 5,
        claimedBy: 'session-foreign',
        claimedAt: 1,
        executions: [{ id: 'exec-foreign', outcome: 'running', trigger: 'manual', sessionId: 'session-foreign' }],
      }),
    ],
  })
  await client.contract()
  const refused = await client.leaseExecution('t-claimed', { attempt: 1, expectedVersion: 5 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'claim_conflict')
  assert.equal(refused.status, 409)
  assert.match(refused.message, /session-foreign/)
})

test('settle: `done` is refused locally AND by the server; the task never becomes done', async t => {
  const { server, client } = await withBoard(t)
  await client.contract()
  const lease = await client.leaseExecution(TASK_ID, { attempt: 1, expectedVersion: 3 })
  const leaseId = lease.value.leaseId
  await client.attachSession(leaseId, { sessionId: 'session-done-guard' })

  // Local guard: no request is even sent.
  const local = await client.settleExecution(leaseId, { outcome: 'done', requestReview: true })
  assert.equal(local.ok, false)
  assert.equal(local.code, 'invalid_input')
  assert.equal(local.status, 0)
  assert.equal(server.calls.filter(call => call.path.endsWith('/settle')).length, 0)

  // Server guard: a caller that bypasses the client is still refused.
  const response = await fetch(`${server.url}/dsh-taskboard/executions/${leaseId}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'done', requestReview: true }),
  })
  assert.equal(response.status, 422)
  const body = await response.json()
  assert.equal(body.error.code, 'invalid_input')
  assert.match(body.error.message, /human-only/)
  assert.equal(server.task(TASK_ID).status, 'in_progress')
  assert.notEqual(server.task(TASK_ID).status, 'done')
})

test('release + reroute: an abandoned attempt is recorded, a new attempt gets a new lease', async t => {
  const { server, client } = await withBoard(t)
  await client.contract()

  const attempt1 = await client.leaseExecution(TASK_ID, { route: { provider: 'primary', model: 'big' }, attempt: 1, expectedVersion: 3 })
  const leaseId1 = attempt1.value.leaseId
  await client.attachSession(leaseId1, { sessionId: 'session-1' })
  const released = await client.releaseLease(leaseId1, { reason: 'provider 429: rerouting to the backup route' })
  assert.equal(released.ok, true)
  assert.equal(released.value.state, 'released')
  assert.match(released.value.reason, /429/)

  const replay = await client.releaseLease(leaseId1, { reason: 'again' })
  assert.equal(replay.ok, true)
  assert.equal(replay.value.releasedAt, released.value.releasedAt, 'release is idempotent')

  const afterRelease = server.task(TASK_ID)
  assert.equal(afterRelease.status, 'todo')
  assert.equal(afterRelease.claimedBy, undefined)
  assert.equal(afterRelease.executions.length, 1)
  assert.equal(afterRelease.executions[0].outcome, 'cancelled')

  // A failover attempt is a NEW attempt on the same task, recorded too.
  const attempt2 = await client.leaseExecution(TASK_ID, {
    route: { provider: 'backup', model: 'medium' },
    attempt: 2,
    previousExecutionId: attempt1.value.executionId,
    expectedVersion: released.value.taskVersion,
  })
  assert.equal(attempt2.ok, true, JSON.stringify(attempt2))
  assert.equal(attempt2.value.attempt, 2)
  assert.ok(attempt2.value.fence > attempt1.value.fence)
  await client.attachSession(attempt2.value.leaseId, { sessionId: 'session-2' })
  const settled = await client.settleExecution(attempt2.value.leaseId, {
    outcome: 'succeeded',
    report: { ...REPORT, summary: 'Succeeded on the backup route.' },
    requestReview: true,
  })
  assert.equal(settled.ok, true)

  const final = server.task(TASK_ID)
  assert.equal(final.executions.length, 2, 'both attempts stay in the execution history')
  assert.deepEqual(final.executions.map(execution => execution.outcome), ['cancelled', 'succeeded'])
  assert.equal(final.executions[1].route.provider, 'backup')
  assert.equal(final.status, 'in_review')
})

test('§6.3 ten-step flow: this layer performs steps 1–4 and 6–8 in order; 9 is conditional and 10 is human', async t => {
  const { server, client, adapter } = await withBoard(t)

  // 1. the board reads the canonical task (version, claim, executions)
  const before = await adapter.list()
  assert.equal(before.items[0].revision, 3)
  // 2. capability negotiation
  const negotiation = await client.contract()
  assert.equal(negotiation.writes, true)
  // 3. lease the attempt (fenced, idempotent, route-bound)
  const lease = await client.leaseExecution(TASK_ID, {
    route: { provider: 'primary', model: 'big' },
    attempt: 1,
    expectedVersion: before.items[0].revision,
  })
  assert.equal(lease.ok, true)
  // 4. attach the real session the board owns
  const attach = await client.attachSession(lease.value.leaseId, { sessionId: 'session-ten-steps' })
  assert.equal(attach.ok, true)
  // 5. the board executes the turn itself (out of scope for this layer)
  // 6. submit the SAME structured report the Task Board stores
  const report = await client.submitReport(lease.value.leaseId, REPORT)
  assert.equal(report.ok, true)
  // 7. settle the attempt (never done; requestReview maps to in_review)
  const settled = await client.settleExecution(lease.value.leaseId, {
    outcome: 'succeeded', report: { ...REPORT, summary: 'Ten-step flow.' }, requestReview: true,
  })
  assert.equal(settled.ok, true)
  // 8. verify the recorded execution and the review state
  const after = await adapter.list()
  const task = after.items[0]
  assert.equal(task.status, 'in_review')
  assert.equal(task.executionsTotal, 1)
  assert.equal(task.lastExecutionOutcome, 'succeeded')
  assert.equal(task.activeExecution, false)
  assert.equal(task.claimedBy, null)

  assert.deepEqual(
    server.calls.map(call => {
      if (call.path === '/dsh-taskboard/state') return 'state'
      if (call.path === '/dsh-taskboard/contract') return 'contract'
      const match = call.path.match(/^\/dsh-taskboard\/(tasks\/[^/]+\/executions\/lease|executions\/[^/]+\/(attach|report|release|settle))$/)
      if (match === null) return 'other'
      return match[1].startsWith('tasks/') ? 'lease' : match[2]
    }).slice(0, 7),
    ['state', 'contract', 'lease', 'attach', 'report', 'settle', 'state'],
  )

  // 9. release is only for an ABANDONED attempt; a settled one was never released.
  assert.equal(server.calls.some(call => call.path.endsWith('/release')), false)
  // 10. `done` stays human: no request mentions it and no task carries it.
  assert.equal(server.calls.some(call => /done/.test(call.path)), false)
  assert.equal(JSON.stringify(server.state()).includes('"status":"done"'), false)
})

test('every simulated response is banner-labelled so no capture looks live', async t => {
  const { server } = await withBoard(t)
  for (const path of ['/dsh-taskboard/state', '/dsh-taskboard/contract', '/dsh-taskboard/does-not-exist']) {
    const response = await fetch(`${server.url}${path}`)
    assert.equal(response.headers.get(SIMULATED_CONTRACT_HEADER), 'true', path)
    assert.match(response.headers.get('x-simulated-note') ?? '', /SIMULATION/, path)
  }
  const state = await (await fetch(`${server.url}/dsh-taskboard/state`)).json()
  assert.equal(state.value.meta.simulated, true)
  assert.equal(state.value.meta.tasksTotal, 2)
  assert.ok(Number.isInteger(state.value.meta.ledgerRevision))
})

test('the contract client derives stable attempt keys and refuses malformed writes locally', async t => {
  const { server, client } = await withBoard(t)
  await client.contract()

  assert.equal(executionIdempotencyKey({ taskId: 't1', attempt: 2 }), 'dsh-agent-board:lease:t1:2')
  assert.equal(executionIdempotencyKey({ taskId: 't1', attempt: 2 }), executionIdempotencyKey({ taskId: 't1', attempt: 2 }))

  const badTask = await client.leaseExecution('', { attempt: 1 })
  assert.equal(badTask.code, 'invalid_input')
  const badAttempt = await client.leaseExecution(TASK_ID, { attempt: 0 })
  assert.equal(badAttempt.code, 'invalid_input')
  const badRoute = await client.leaseExecution(TASK_ID, { route: { provider: 'p' } })
  assert.equal(badRoute.code, 'invalid_input')
  const badReport = await client.submitReport('lease-x', { summary: '' })
  assert.equal(badReport.code, 'invalid_input')
  const badOutcome = await client.settleExecution('lease-x', { outcome: 'done' })
  assert.equal(badOutcome.code, 'invalid_input')
  assert.equal(server.calls.filter(call => call.method === 'POST').length, 0, 'local refusals never reach the wire')
})
