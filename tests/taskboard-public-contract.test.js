// The public-v1 contract adapter against the REAL Task Board build (its
// compiled PublicApiService + TaskStore served over HTTP on a temp ledger).
// Skipped with an explicit reason when the sibling build is not present.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPublicTaskBoardClient } from '../src/connectors/taskboard-public.js'
import { createPublicContractAdapter } from '../src/connectors/taskboard-public-contract.js'

const LIB = resolve(process.env.TASKBOARD_LIB ?? join(process.cwd(), '..', 'dsh-taskboard', 'lib'))
const available = existsSync(join(LIB, 'host', 'public-api.js'))
const TOKEN = 'b'.repeat(64)

function taskRecord(id) {
  return {
    id, title: `Task ${id}`, description: '', prompt: '', workspaceId: 'ws', urgency: 'normal',
    status: 'todo', blocked: false, execution: { mode: 'claim' }, version: 1, createdAt: 1, updatedAt: 1,
    createdBy: { kind: 'user' }, updatedBy: { kind: 'user' }, comments: [], executions: [],
  }
}

async function realTaskBoard() {
  const { PublicApiService } = await import(pathToFileURL(join(LIB, 'host', 'public-api.js')).href)
  const { TaskStore } = await import(pathToFileURL(join(LIB, 'host', 'store.js')).href)
  const { PUBLIC_API_PREFIX } = await import(pathToFileURL(join(LIB, 'shared', 'public-api.js')).href)
  const dir = await mkdtemp(join(tmpdir(), 'dab-tb-public-'))
  const file = join(dir, 'tasks.json')
  await writeFile(file, JSON.stringify({ version: 1, revision: 1, tasks: [taskRecord('t-ok'), taskRecord('t-stop')] }), 'utf8')
  const store = new TaskStore({ file })
  const service = new PublicApiService({
    store,
    workspaces: { list: () => [{ id: 'ws', title: 'WS', path: dir }], get: id => (id === 'ws' ? { id: 'ws', title: 'WS', path: dir } : undefined) },
    now: () => Date.now(),
    token: () => TOKEN,
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(PUBLIC_API_PREFIX)) { res.writeHead(404); res.end(); return }
    if (!service.preflight(req, res)) return
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    await service.handle(req, res, url, text === '' ? null : JSON.parse(text))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const baseUrl = `http://127.0.0.1:${server.address().port}${PUBLIC_API_PREFIX}`
  return {
    baseUrl,
    store,
    async taskOf(id) { await store.load?.(); return (await store.read?.() ?? store.snapshot?.())?.tasks?.find(task => task.id === id) },
    async close() { service.dispose(); await new Promise(done => server.close(done)); await rm(dir, { recursive: true, force: true }) },
  }
}

test('public-v1 adapter drives the REAL Task Board: claim -> session -> complete => in_review; interrupt => todo', { skip: available ? false : `Task Board build not found at ${LIB}` }, async () => {
  const board = await realTaskBoard()
  try {
    const client = createPublicTaskBoardClient({ baseUrl: board.baseUrl, token: TOKEN })
    const adapter = createPublicContractAdapter(client)

    const negotiated = await adapter.contract()
    assert.equal(negotiated.ok, true, JSON.stringify(negotiated))
    assert.equal(negotiated.writes, true)

    const lease = await adapter.leaseExecution('t-ok', { idempotencyKey: 'agent-board:t-ok:1' })
    assert.equal(lease.ok, true, JSON.stringify(lease))
    const replay = await adapter.leaseExecution('t-ok', { idempotencyKey: 'agent-board:t-ok:1' })
    assert.equal(replay.value?.executionId, lease.value.executionId, 'an idempotent replay returns the SAME execution')

    const attached = await adapter.attachSession(lease.value.leaseId, { sessionId: 'session-agentboard-1' })
    assert.equal(attached.ok, true, JSON.stringify(attached))

    const settled = await adapter.settleExecution(lease.value.leaseId, {
      outcome: 'succeeded',
      report: { summary: 'Agent Board observed a completed session.', changedFiles: [], checks: ['observed: outcome succeeded'], artifacts: [], risk: '' },
    })
    assert.equal(settled.ok, true, JSON.stringify(settled))
    const done = await client.task('t-ok')
    assert.equal(done.value?.status ?? done.value?.task?.status, 'in_review', JSON.stringify(done.value))

    const stop = await adapter.leaseExecution('t-stop', { idempotencyKey: 'agent-board:t-stop:1' })
    assert.equal(stop.ok, true, JSON.stringify(stop))
    const released = await adapter.releaseLease(stop.value.leaseId, { reason: 'stopped_by_operator' })
    assert.equal(released.ok, true, JSON.stringify(released))
    const back = await client.task('t-stop')
    assert.equal(back.value?.status ?? back.value?.task?.status, 'todo', JSON.stringify(back.value))

    const refusedDone = await client.complete(lease.value.leaseId, { actor: 'dsh-agent-board', outcome: 'done' })
    assert.equal(refusedDone.ok, false, '`done` stays human-only')
  } finally {
    await board.close()
  }
})
