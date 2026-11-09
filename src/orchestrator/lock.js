/**
 * Single-writer instance lock for the board state directory.
 *
 * Several DSH host processes can load the same profile and therefore share
 * `$DSH_HOME/agent-board`; without a lock they clobber `state.json` (lost acks,
 * reverted mode). This module is the smallest thing that prevents that: one
 * JSON file, an expiry, and a pid-liveness check.
 *
 * It owns NO timer: the caller decides how often to call `heartbeat()`, so the
 * module stays deterministic and testable. `isPidAlive` and `now` are
 * injectable for the same reason.
 *
 * @module dsh-agent-board/orchestrator/lock
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LOCK_FILENAME = 'instance.lock'
export const DEFAULT_LOCK_TTL_MS = 30_000

let writeCounter = 0

/**
 * `process.kill(pid, 0)` is the portable existence probe: ESRCH means gone,
 * EPERM means "there but not ours", which still means alive.
 */
export function isPidAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  if (numeric === process.pid) return true
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Read the lock file without ever throwing on a corrupt document. An unreadable
 * regular file is treated as corrupt too: taking it over is the only progress.
 */
async function readLockFile(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, corrupt: false, record: null }
    return { present: true, corrupt: true, record: null }
  }
  try {
    const record = JSON.parse(raw)
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return { present: true, corrupt: true, record: null }
    }
    return { present: true, corrupt: false, record }
  } catch {
    return { present: true, corrupt: true, record: null }
  }
}

/** A lock is stale when corrupt, expired, or owned by a dead pid. */
async function lockIsStale(path, entry, now, ttlMs, isAlive) {
  if (entry.corrupt || entry.record === null) return true
  const record = entry.record
  if (!isAlive(record.pid)) return true
  const expiresAt = Number(record.expiresAt)
  if (Number.isFinite(expiresAt)) return expiresAt <= now
  // No usable expiry: fall back to the file mtime vs the TTL.
  let modifiedAt = NaN
  try {
    modifiedAt = (await stat(path)).mtimeMs
  } catch {
    return true
  }
  return !Number.isFinite(modifiedAt) || modifiedAt + ttlMs <= now
}

function publicRecord(lock) {
  return {
    ownerId: lock.ownerId,
    pid: lock.pid,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
  }
}

/** Atomic overwrite used by heartbeat (tmp + rename). */
async function writeLockAtomically(lock) {
  const tmp = `${lock.path}.tmp-${process.pid}-${writeCounter++}`
  try {
    await writeFile(tmp, `${JSON.stringify(publicRecord(lock))}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, lock.path)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      /* best effort: the tmp may already be gone */
    }
    throw error
  }
}

/**
 * Take the instance lock when the file is absent or stale.
 *
 * @returns {Promise<{ok: true, lock: object, stale: boolean} | {ok: false, holder: object | null}>}
 *   `stale: true` means an expired/dead/corrupt lock was taken over.
 */
export async function acquireInstanceLock({
  dir,
  pid = process.pid,
  now = Date.now,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  ownerId,
  isAlive = isPidAlive,
} = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('agent-board: acquireInstanceLock needs a directory')
  }
  await mkdir(dir, { recursive: true })
  const path = join(dir, LOCK_FILENAME)
  const owner = typeof ownerId === 'string' && ownerId !== '' ? ownerId : `${pid}-${randomUUID()}`
  let stale = false
  // Bounded creation loop: `wx` makes creation atomic, so two processes racing
  // for an absent lock cannot both win; the loser re-reads the winner.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readLockFile(path)
    if (current.present) {
      if (!(await lockIsStale(path, current, Number(now()), ttlMs, isAlive))) {
        return { ok: false, holder: current.corrupt ? null : current.record }
      }
      stale = true
      try {
        await unlink(path)
      } catch (error) {
        // Someone else may be replacing it right now; the `wx` below decides.
        if (error?.code !== 'ENOENT') continue
      }
    }
    const acquiredAt = Number(now())
    const lock = {
      path,
      ownerId: owner,
      pid,
      acquiredAt,
      expiresAt: acquiredAt + Number(ttlMs),
      ttlMs: Number(ttlMs),
    }
    try {
      await writeFile(path, `${JSON.stringify(publicRecord(lock))}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      return { ok: true, lock, stale }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // Lost the creation race: loop re-reads the winner.
    }
  }
  const finalEntry = await readLockFile(path)
  return {
    ok: false,
    holder: finalEntry.present && !finalEntry.corrupt ? finalEntry.record : null,
  }
}

/**
 * Extend the lock. Refuses (`ELOCKLOST`) once another owner holds the file, so
 * a process that lost the lock cannot keep writing. Missing file = reassert.
 */
export async function heartbeat(lock, { now = Date.now } = {}) {
  if (lock === null || typeof lock !== 'object' || typeof lock.path !== 'string') {
    throw new Error('agent-board: heartbeat needs a lock returned by acquireInstanceLock')
  }
  const current = await readLockFile(lock.path)
  if (current.present) {
    if (current.corrupt) {
      const corrupt = new Error('agent-board: instance lock file is corrupt')
      corrupt.code = 'ELOCKLOST'
      throw corrupt
    }
    if (String(current.record.ownerId) !== String(lock.ownerId)) {
      const lost = new Error(`agent-board: instance lock lost to ${String(current.record.ownerId)}`)
      lost.code = 'ELOCKLOST'
      throw lost
    }
  }
  const ttlMs = Number(lock.ttlMs ?? DEFAULT_LOCK_TTL_MS)
  const updated = { ...lock, expiresAt: Number(now()) + ttlMs, ttlMs }
  await writeLockAtomically(updated)
  lock.expiresAt = updated.expiresAt
  return lock
}

/** Delete the lock file only when it is still ours. Never throws on ENOENT. */
export async function release(lock) {
  if (lock === null || typeof lock !== 'object' || typeof lock.path !== 'string') return false
  const current = await readLockFile(lock.path)
  if (!current.present || current.corrupt) return false
  if (String(current.record.ownerId) !== String(lock.ownerId)) return false
  try {
    await unlink(lock.path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
