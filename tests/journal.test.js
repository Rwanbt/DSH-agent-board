import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StateStore, compactState, renameWithRetry } from '../src/orchestrator/journal.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dab-journal-'))
}

test('init writes defaults, read-back merges them', async () => {
  const dir = await tempDir()
  try {
    const store = new StateStore({ dir, now: () => 1000 })
    const initial = await store.init({ mode: 'off', assignments: [] })
    assert.equal(initial.mode, 'off')
    assert.equal(initial.schemaVersion, 1)
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(raw.savedAt, 1000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writes are atomic and serialized: the last one wins', async () => {
  const dir = await tempDir()
  try {
    const store = new StateStore({ dir })
    await store.init({ value: 0 })
    await Promise.all([store.write({ value: 1 }), store.write({ value: 2 }), store.write({ value: 3 })])
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(raw.value, 3)
    const files = await readdir(dir)
    assert.equal(files.filter(name => name.includes('.tmp-')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt state file is quarantined, never silently destroyed', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, 'state.json'), '{not json', 'utf8')
    const store = new StateStore({ dir, now: () => 777 })
    const loaded = await store.init({ mode: 'off' })
    assert.equal(loaded.mode, 'off')
    const files = await readdir(dir)
    assert.ok(files.some(name => name.startsWith('state.json.corrupt-')))
    assert.ok(store.lastFailure.includes('quarantined'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('audit events append as JSON lines', async () => {
  const dir = await tempDir()
  try {
    const store = new StateStore({ dir, now: () => 42 })
    await store.init({})
    assert.equal(await store.append({ type: 'launch', taskId: 't1' }), true)
    const lines = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.type, 'launch')
    assert.equal(parsed.at, 42)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed write does not poison the queue: the next write still lands', async () => {
  const dir = await tempDir()
  try {
    let failNext = false
    const store = new StateStore({
      dir,
      renameFile: async (from, to) => {
        if (failNext) {
          failNext = false
          const error = new Error('simulated disk full')
          error.code = 'ENOSPC' // not retryable: fail on the first attempt
          throw error
        }
        return rename(from, to)
      },
    })
    await store.init({ value: 0 })
    failNext = true
    await assert.rejects(store.write({ value: 1 }), error => error.code === 'ENOSPC')
    assert.match(store.lastFailure, /state write failed: ENOSPC/)
    // The rejected write must not disable the following ones (D17).
    await store.write({ value: 2 })
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(raw.value, 2)
    // A failed write removes its own tmp file (best effort).
    const files = await readdir(dir)
    assert.equal(files.filter(name => name.includes('.tmp-')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rename retried on EPERM eventually succeeds', async () => {
  const dir = await tempDir()
  try {
    let attempts = 0
    const sleeps = []
    const store = new StateStore({
      dir,
      renameRetryDelaysMs: [0, 0, 0],
      sleep: async ms => { sleeps.push(ms) },
      renameFile: async (from, to) => {
        attempts += 1
        if (attempts <= 2) {
          const error = new Error('locked by a scanner')
          error.code = 'EPERM'
          throw error
        }
        return rename(from, to)
      },
    })
    await store.init({ value: 'retry' })
    assert.equal(attempts, 3)
    assert.deepEqual(sleeps, [0, 0])
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(raw.value, 'retry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renameWithRetry gives up after its bounded attempts with a clear error', async () => {
  let calls = 0
  const sleeps = []
  await assert.rejects(
    renameWithRetry('tmp', 'final', {
      delaysMs: [0, 0],
      sleep: async ms => { sleeps.push(ms) },
      renameFile: async () => {
        calls += 1
        const error = new Error('still locked')
        error.code = 'EPERM'
        throw error
      },
    }),
    error => {
      assert.equal(error.code, 'EPERM')
      assert.equal(error.attempts, 3)
      assert.match(error.message, /3 attempt\(s\)/)
      return true
    },
  )
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [0, 0])
})

test('renameWithRetry does not retry an error that is not a lock', async () => {
  let calls = 0
  await assert.rejects(
    renameWithRetry('tmp', 'final', {
      delaysMs: [0, 0],
      sleep: async () => { throw new Error('sleep must not be called') },
      renameFile: async () => {
        calls += 1
        const error = new Error('disk full')
        error.code = 'ENOSPC'
        throw error
      },
    }),
    error => error.code === 'ENOSPC',
  )
  assert.equal(calls, 1)
})

test('init removes stale tmp files and keeps state, quarantine copies and live temps', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 1, value: 7 }), 'utf8')
    const stale = ['state.json.tmp-2096-1', 'state.json.tmp-2096-2', 'state.json.tmp-2096-3']
    for (const name of stale) await writeFile(join(dir, name), 'partial', 'utf8')
    const live = 'state.json.tmp-4242-9'
    await writeFile(join(dir, live), 'in flight', 'utf8')
    await writeFile(join(dir, 'state.json.corrupt-123'), 'evidence', 'utf8')
    await writeFile(join(dir, 'audit.jsonl'), '', 'utf8')
    const store = new StateStore({ dir })
    store.tmpInFlight.add(join(dir, live))
    const loaded = await store.init({ value: 0 })
    assert.equal(loaded.value, 7)
    const files = await readdir(dir)
    for (const name of stale) assert.equal(files.includes(name), false, `${name} should be removed`)
    assert.equal(files.includes(live), true, 'the current process in-flight temp must survive')
    assert.equal(files.includes('state.json'), true)
    assert.equal(files.includes('state.json.corrupt-123'), true)
    assert.equal(files.includes('audit.jsonl'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compactState bounds previews, turn ends and the audit tail', () => {
  const state = {
    previews: { a: { at: 1 }, b: { at: 2 }, c: { at: 3 } },
    turnEnd: { a: { at: 1 }, b: { at: 2 } },
    acks: { a: { seenAt: 10 }, b: { seenAt: 10 } },
    audit: [1, 2, 3, 4, 5],
  }
  compactState(state, { maxPreviews: 2, maxTurnEnds: 1, maxAudit: 2 })
  assert.deepEqual(Object.keys(state.previews).sort(), ['b', 'c'])
  assert.deepEqual(Object.keys(state.turnEnd), ['b'])
  assert.deepEqual(state.audit, [4, 5])
})

test('compactState keeps unacked turn ends beyond the cap and drops acked ones', () => {
  const state = {
    turnEnd: {
      acked_newest: { at: 100 },
      unacked: { at: 90 },
      stale_ack: { at: 80 },
      acked_old: { at: 70 },
    },
    acks: {
      acked_newest: { seenAt: 100 },
      stale_ack: { seenAt: 10 }, // acknowledged before the turn ended = still unread
      acked_old: { seenAt: 70 },
    },
  }
  compactState(state, { maxTurnEnds: 1 })
  assert.deepEqual(Object.keys(state.turnEnd).sort(), ['acked_newest', 'stale_ack', 'unacked'])
  assert.equal(state.turnEnd.acked_old, undefined)
})

test('compactState bounds a flood of unacked turn ends at the hard ceiling', () => {
  const turnEnd = {}
  for (let index = 0; index < 6; index += 1) turnEnd[`s${index}`] = { at: 100 - index }
  const state = { turnEnd, acks: {} }
  compactState(state, { maxTurnEnds: 1 })
  // All protected: the soft cap is exceeded, but never past 4x the cap.
  assert.equal(Object.keys(state.turnEnd).length, 4)
  assert.deepEqual(Object.keys(state.turnEnd).sort(), ['s0', 's1', 's2', 's3'])
})

test('compactState bounds proposals, assignments and acks without dropping live state', () => {
  const proposals = []
  for (let index = 0; index < 10; index += 1) proposals.push({ id: `p${index}`, status: 'expired', createdAt: index })
  proposals.push({ id: 'pending-old', status: 'pending', createdAt: 0 })
  proposals.push({ id: 'pending-new', status: 'pending', createdAt: 1 })
  const assignments = []
  for (let index = 0; index < 10; index += 1) assignments.push({ id: `a${index}`, status: 'done', endedAt: index })
  assignments.push({ id: 'active', status: 'running', attempt: 0 })
  const acks = {}
  for (let index = 0; index < 10; index += 1) acks[`s${index}`] = { seenAt: index }
  const state = {
    previews: {}, turnEnd: {}, audit: [],
    proposals, assignments, acks,
  }
  compactState(state, { maxProposals: 4, maxAssignments: 4, maxAcks: 5, maxAudit: 10 })
  assert.equal(state.proposals.length, 4)
  assert.deepEqual(state.proposals.filter(proposal => proposal.status === 'pending').map(proposal => proposal.id).sort(), ['pending-new', 'pending-old'])
  assert.equal(state.assignments.length, 4)
  assert.ok(state.assignments.some(assignment => assignment.id === 'active'), 'a running assignment is never evicted')
  assert.deepEqual(state.assignments.filter(assignment => assignment.status === 'done').map(assignment => assignment.id).sort(), ['a7', 'a8', 'a9'])
  assert.equal(Object.keys(state.acks).length, 5)
  assert.deepEqual(Object.keys(state.acks).sort(), ['s5', 's6', 's7', 's8', 's9'])
})

test('writeSync closes the store so a queued async write cannot overwrite the final document', async () => {
  const dir = await tempDir()
  const store = new StateStore({ dir })
  const defaults = { mode: 'off', previews: {}, turnEnd: {}, audit: [] }
  await store.init(defaults)
  const queued = store.write({ ...defaults, mode: 'autonomous' })
  const wrote = store.writeSync({ ...defaults, mode: 'off' })
  assert.equal(wrote, true)
  await assert.rejects(() => queued, /closed/, 'the queued write must abort once the store is closed')
  const final = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(final.mode, 'off', 'the shutdown document must win')
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
test('audit journal rotates at the cap, keeps one generation and states the truncation', async () => {
  const dir = await tempDir()
  try {
    const store = new StateStore({ dir, now: () => 1000, maxJournalBytes: 400 })
    await store.init({ mode: 'off' })
    for (let index = 0; index < 15; index += 1) {
      // Force the once-a-minute size check for this deterministic test.
      store.lastRotationCheckAt = 0
      assert.equal(await store.append({ type: 'tick', index }), true)
    }
    const previous = await readFile(join(dir, 'audit.jsonl.1'), 'utf8')
    const current = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    assert.ok(previous.length > 0, 'the previous generation is kept')
    assert.match(current, /"type":"audit_rotated"/, 'the new journal says history was truncated')
    assert.match(current, /"previous":"audit\.jsonl\.1"/)
    assert.ok(store.lastRotation !== null && store.lastRotation.bytes >= 400)
    const all = `${previous}\n${current}`
    for (let index = 0; index < 15; index += 1) {
      assert.match(all, new RegExp(`"index":${index}`), 'no event is lost at the rotation boundary')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('pre-migration backup preserves the v1 document once and never overwrites it', async () => {
  const dir = await tempDir()
  try {
    const seed = { schemaVersion: 1, mode: 'supervised', savedAt: 1, assignments: [{ id: 'asg-1', taskId: 't1' }] }
    await writeFile(join(dir, 'state.json'), JSON.stringify(seed), 'utf8')
    const store = new StateStore({ dir, now: () => 2 })
    assert.equal(await store.backupBeforeMigration(), true)
    const backup = JSON.parse(await readFile(join(dir, 'state.json.v1-backup'), 'utf8'))
    assert.equal(backup.schemaVersion, 1)
    assert.equal(backup.mode, 'supervised')
    assert.equal(backup.assignments[0].id, 'asg-1')
    // The live file becomes v2; a second call must NOT replace the backup.
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 2 }), 'utf8')
    assert.equal(await store.backupBeforeMigration(), false)
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json.v1-backup'), 'utf8')).schemaVersion, 1)
    // Fresh directory: nothing to back up.
    const empty = await tempDir()
    try {
      assert.equal(await new StateStore({ dir: empty }).backupBeforeMigration(), false)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})