import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LOCK_FILENAME,
  acquireInstanceLock,
  heartbeat,
  isPidAlive,
  release,
} from '../src/orchestrator/lock.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dab-lock-'))
}

async function readLock(dir) {
  return JSON.parse(await readFile(join(dir, LOCK_FILENAME), 'utf8'))
}

test('acquireInstanceLock creates the JSON lock when none exists', async () => {
  const dir = await tempDir()
  try {
    const result = await acquireInstanceLock({
      dir,
      pid: 1234,
      now: () => 5000,
      ttlMs: 1000,
      ownerId: 'owner-a',
      isAlive: () => true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.stale, false)
    assert.equal(result.lock.path, join(dir, LOCK_FILENAME))
    const raw = await readLock(dir)
    assert.deepEqual(raw, { ownerId: 'owner-a', pid: 1234, acquiredAt: 5000, expiresAt: 6000 })
    assert.deepEqual(Object.keys(raw).sort(), ['acquiredAt', 'expiresAt', 'ownerId', 'pid'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('acquireInstanceLock refuses a live, unexpired holder', async () => {
  const dir = await tempDir()
  try {
    const first = await acquireInstanceLock({ dir, pid: 1234, now: () => 1000, ttlMs: 5000, ownerId: 'owner-a', isAlive: () => true })
    assert.equal(first.ok, true)
    const second = await acquireInstanceLock({ dir, pid: 4321, now: () => 2000, ttlMs: 5000, ownerId: 'owner-b', isAlive: () => true })
    assert.equal(second.ok, false)
    assert.equal(second.lock, undefined)
    assert.equal(second.holder.ownerId, 'owner-a')
    assert.equal(second.holder.pid, 1234)
    const raw = await readLock(dir)
    assert.equal(raw.ownerId, 'owner-a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('acquireInstanceLock takes over an expired lock', async () => {
  const dir = await tempDir()
  try {
    await writeFile(
      join(dir, LOCK_FILENAME),
      JSON.stringify({ ownerId: 'expired-owner', pid: 1234, acquiredAt: 1000, expiresAt: 1500 }),
      'utf8',
    )
    const result = await acquireInstanceLock({ dir, pid: 4321, now: () => 2000, ttlMs: 1000, ownerId: 'owner-b', isAlive: () => true })
    assert.equal(result.ok, true)
    assert.equal(result.stale, true)
    const raw = await readLock(dir)
    assert.equal(raw.ownerId, 'owner-b')
    assert.equal(raw.expiresAt, 3000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('acquireInstanceLock takes over a lock whose pid is not alive', async () => {
  const dir = await tempDir()
  try {
    await writeFile(
      join(dir, LOCK_FILENAME),
      JSON.stringify({ ownerId: 'dead-owner', pid: 4321, acquiredAt: 1000, expiresAt: 999999 }),
      'utf8',
    )
    const result = await acquireInstanceLock({
      dir,
      pid: 1234,
      now: () => 2000,
      ttlMs: 1000,
      ownerId: 'owner-b',
      isAlive: pid => pid !== 4321,
    })
    assert.equal(result.ok, true)
    assert.equal(result.stale, true)
    assert.equal((await readLock(dir)).ownerId, 'owner-b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('acquireInstanceLock takes over a corrupt lock file instead of throwing', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, LOCK_FILENAME), '{not json', 'utf8')
    const result = await acquireInstanceLock({ dir, pid: 1234, now: () => 1000, ttlMs: 1000, ownerId: 'owner-c' })
    assert.equal(result.ok, true)
    assert.equal(result.stale, true)
    const raw = await readLock(dir)
    assert.equal(raw.ownerId, 'owner-c')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('acquireInstanceLock falls back to the file mtime when the lock has no expiry', async () => {
  const dir = await tempDir()
  try {
    const path = join(dir, LOCK_FILENAME)
    await writeFile(path, JSON.stringify({ ownerId: 'legacy', pid: 1234, acquiredAt: 1 }), 'utf8')
    await utimes(path, new Date(0), new Date(0))
    const result = await acquireInstanceLock({
      dir,
      pid: 4321,
      now: () => Date.now(),
      ttlMs: 50,
      ownerId: 'owner-d',
      isAlive: () => true,
    })
    assert.equal(result.ok, true)
    assert.equal(result.stale, true)
    assert.equal((await readLock(dir)).ownerId, 'owner-d')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('heartbeat extends expiresAt atomically for the same owner', async () => {
  const dir = await tempDir()
  try {
    const acquired = await acquireInstanceLock({ dir, pid: 1234, now: () => 1000, ttlMs: 1000, ownerId: 'owner-a', isAlive: () => true })
    assert.equal(acquired.ok, true)
    await heartbeat(acquired.lock, { now: () => 1500 })
    assert.equal(acquired.lock.expiresAt, 2500)
    const raw = await readLock(dir)
    assert.deepEqual(raw, { ownerId: 'owner-a', pid: 1234, acquiredAt: 1000, expiresAt: 2500 })
    const files = await readdir(dir)
    assert.equal(files.filter(name => name.startsWith('instance.lock.tmp-')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('heartbeat refuses once another process took the lock', async () => {
  const dir = await tempDir()
  try {
    const acquired = await acquireInstanceLock({ dir, pid: 1234, now: () => 1000, ttlMs: 1000, ownerId: 'owner-a', isAlive: () => true })
    assert.equal(acquired.ok, true)
    await writeFile(
      join(dir, LOCK_FILENAME),
      JSON.stringify({ ownerId: 'owner-b', pid: 4321, acquiredAt: 2000, expiresAt: 999999 }),
      'utf8',
    )
    await assert.rejects(heartbeat(acquired.lock, { now: () => 3000 }), error => error.code === 'ELOCKLOST')
    assert.equal((await readLock(dir)).ownerId, 'owner-b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('release removes only its own lock', async () => {
  const dir = await tempDir()
  try {
    const acquired = await acquireInstanceLock({ dir, pid: 1234, now: () => 1000, ttlMs: 1000, ownerId: 'owner-a', isAlive: () => true })
    assert.equal(await release(acquired.lock), true)
    assert.equal((await readdir(dir)).includes(LOCK_FILENAME), false)
    assert.equal(await release(acquired.lock), false)

    const second = await acquireInstanceLock({ dir, pid: 4321, now: () => 2000, ttlMs: 5000, ownerId: 'owner-b', isAlive: () => true })
    assert.equal(second.ok, true)
    // The stale handle from the previous owner must not delete the new lock.
    assert.equal(await release(acquired.lock), false)
    assert.equal((await readLock(dir)).ownerId, 'owner-b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('isPidAlive recognises the current process and rejects invalid pids', () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(-1), false)
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive('not-a-pid'), false)
})

test('concurrent stale takeover: exactly one host wins (rename CAS)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dab-lock-cas-'))
  const stale = {
    ownerId: 'dead-owner',
    pid: 999999,
    acquiredAt: Date.now() - 120_000,
    expiresAt: Date.now() - 60_000,
  }
  await writeFile(join(dir, 'instance.lock'), JSON.stringify(stale), 'utf8')
  const results = await Promise.all([
    acquireInstanceLock({ dir, pid: 111, ownerId: 'agent-board:111:host-a', isAlive: pid => Number(pid) !== 999999 }),
    acquireInstanceLock({ dir, pid: 222, ownerId: 'agent-board:222:host-b', isAlive: pid => Number(pid) !== 999999 }),
  ])
  const winners = results.filter(result => result.ok === true)
  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`)
  const lock = JSON.parse(await readFile(join(dir, 'instance.lock'), 'utf8'))
  assert.equal(lock.ownerId, winners[0].lock.ownerId)
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('a heartbeat after release refuses instead of recreating the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dab-lock-rel-'))
  const acquired = await acquireInstanceLock({ dir, pid: 1, ownerId: 'host-x' })
  assert.equal(acquired.ok, true)
  await release(acquired.lock)
  await assert.rejects(() => heartbeat(acquired.lock), error => error.code === 'ELOCKLOST')
  assert.equal(existsSync(join(dir, 'instance.lock')), false, 'a released lock must stay released')
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('a fresh takeover gate blocks the takeover; a stale gate is broken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dab-lock-gate-'))
  const stale = { ownerId: 'dead', pid: 999999, acquiredAt: 1, expiresAt: Date.now() - 60_000 }
  await writeFile(join(dir, 'instance.lock'), JSON.stringify(stale), 'utf8')
  await writeFile(join(dir, 'instance.lock.takeover'), '1', 'utf8')
  const blocked = await acquireInstanceLock({ dir, pid: 1, ownerId: 'agent-board:1:a', ttlMs: 30_000 })
  assert.equal(blocked.ok, false, 'another racer holds the takeover gate')
  // Age the gate past its TTL: the next racer may break it.
  const old = new Date(Date.now() - 60_000)
  await utimes(join(dir, 'instance.lock.takeover'), old, old)
  const taken = await acquireInstanceLock({ dir, pid: 1, ownerId: 'agent-board:1:a', ttlMs: 30_000 })
  assert.equal(taken.ok, true)
  assert.equal(existsSync(join(dir, 'instance.lock.takeover')), false, 'the gate is removed after use')
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
