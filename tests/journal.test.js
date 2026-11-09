import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StateStore, compactState } from '../src/orchestrator/journal.js'

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

test('compactState bounds previews, turn ends and the audit tail', () => {
  const state = {
    previews: { a: { at: 1 }, b: { at: 2 }, c: { at: 3 } },
    turnEnd: { a: { at: 1 }, b: { at: 2 } },
    audit: [1, 2, 3, 4, 5],
  }
  compactState(state, { maxPreviews: 2, maxTurnEnds: 1, maxAudit: 2 })
  assert.deepEqual(Object.keys(state.previews).sort(), ['b', 'c'])
  assert.deepEqual(Object.keys(state.turnEnd), ['b'])
  assert.deepEqual(state.audit, [4, 5])
})
