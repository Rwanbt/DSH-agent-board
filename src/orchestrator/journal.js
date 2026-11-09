/**
 * Durable state + append-only audit journal.
 *
 * The board keeps ONE small JSON state document (mode, proposals, assignments,
 * read cursors, previews, turn-end facts) plus an append-only JSONL audit log.
 * Writes are atomic (tmp + rename) and serialized, so a crash never leaves a
 * half-written state file; a corrupt file is quarantined, never silently
 * overwritten.
 *
 * The journal is NOT the Task Board ledger: it records what the board decided
 * and observed, and it never becomes a second source of truth for tasks.
 *
 * @module dsh-agent-board/orchestrator/journal
 */

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let writeCounter = 0

/** Rename errors worth retrying on Windows: AV scanners, indexers, open handles. */
export const RENAME_RETRY_CODES = Object.freeze(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

const RETRYABLE_RENAME = new Set(RENAME_RETRY_CODES)

/** Short, bounded backoff: long enough for an AV scan, short enough for a save. */
export const DEFAULT_RENAME_RETRY_DELAYS_MS = Object.freeze([20, 60, 150])

/** The default delay is a real timer; tests inject a no-op instead. */
function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Atomic tmp -> final rename with bounded retries.
 *
 * `renameFile` and `sleep` are injectable so the retry path is testable without
 * touching the filesystem error conditions or waiting for real time.
 *
 * @returns {Promise<{attempts: number}>} how many attempts it took
 */
export async function renameWithRetry(from, to, options = {}) {
  const {
    renameFile = rename,
    sleep = defaultSleep,
    delaysMs = DEFAULT_RENAME_RETRY_DELAYS_MS,
  } = options
  const delays = Array.isArray(delaysMs) ? delaysMs.slice() : []
  let lastError = null
  let attempts = 0
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    attempts = attempt + 1
    try {
      await renameFile(from, to)
      return { attempts }
    } catch (error) {
      lastError = error
      if (!RETRYABLE_RENAME.has(error?.code) || attempt === delays.length) break
      await sleep(delays[attempt])
    }
  }
  const code = lastError?.code ?? 'UNKNOWN'
  const wrapped = new Error(
    `agent-board: atomic rename failed after ${attempts} attempt(s) (${code}): ${lastError?.message ?? String(lastError)}`,
    { cause: lastError },
  )
  wrapped.code = code
  wrapped.attempts = attempts
  throw wrapped
}

export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.dir absolute directory owned by this plugin
   * @param {() => number} [options.now]
   * @param {number[]} [options.renameRetryDelaysMs] injected retry backoff
   * @param {(ms: number) => Promise<void>} [options.sleep] injected delay
   * @param {typeof rename} [options.renameFile] injected rename (test seam)
   */
  constructor({
    dir,
    now = Date.now,
    renameRetryDelaysMs = DEFAULT_RENAME_RETRY_DELAYS_MS,
    sleep = defaultSleep,
    renameFile = rename,
  }) {
    if (typeof dir !== 'string' || dir === '') throw new Error('agent-board: StateStore needs a directory')
    this.dir = dir
    this.statePath = join(dir, 'state.json')
    this.journalPath = join(dir, 'audit.jsonl')
    this.now = now
    this.renameRetryDelaysMs = renameRetryDelaysMs
    this.sleep = sleep
    this.renameFile = renameFile
    this.queue = Promise.resolve()
    this.ready = null
    this.lastFailure = null
    /** Temps this process is currently writing: init() must never delete them. */
    this.tmpInFlight = new Set()
  }

  /**
   * Delete tmp files left behind by a crashed/older writer. This is what stops
   * a Windows EPERM on rename from leaking `state.json.tmp-*` forever.
   * Best-effort: a cleanup failure never fails init().
   */
  async cleanupStaleTemps() {
    let entries
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('state.json.tmp-')) continue
      const path = join(this.dir, entry.name)
      if (this.tmpInFlight.has(path)) continue
      try {
        await unlink(path)
        removed += 1
      } catch {
        /* the temp may vanish or stay locked; neither is an init failure */
      }
    }
    return removed
  }

  /**
   * Create the directory and read the current state (or the defaults).
   *
   * @param {object} defaults
   * @param {{write?: boolean}} [options] `write:false` is the follower mode: it
   *   must never create/quarantine/clean anything (the lock owner's temp files
   *   and journal are not ours to touch).
   */
  async init(defaults, { write = true } = {}) {
    await mkdir(this.dir, { recursive: true })
    if (write) await this.cleanupStaleTemps()
    let parsed = null
    try {
      const raw = await readFile(this.statePath, 'utf8')
      parsed = JSON.parse(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Never destroy evidence: move the unreadable file aside and start clean.
        this.lastFailure = `state.json unreadable (${error?.code ?? error?.message}); quarantined`
        if (write) {
          try {
            await rename(this.statePath, `${this.statePath}.corrupt-${this.now()}`)
          } catch {
            /* the rename is best-effort, the failure stays reported */
          }
        }
      }
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
      const initial = { ...defaults, schemaVersion: 1 }
      if (write) await this.write(initial)
      return initial
    }
    return { ...defaults, ...parsed }
  }

  /** One atomic write. On failure the tmp is removed, the caller sees the error. */
  async #persist(payload) {
    const tmp = `${this.statePath}.tmp-${process.pid}-${writeCounter++}`
    this.tmpInFlight.add(tmp)
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await renameWithRetry(tmp, this.statePath, {
        renameFile: this.renameFile,
        sleep: this.sleep,
        delaysMs: this.renameRetryDelaysMs,
      })
      return payload
    } catch (error) {
      // The caller keeps the rejection; `lastFailure` keeps it observable even
      // when a fire-and-forget caller (saveSoon) drops it.
      this.lastFailure = `state write failed: ${error?.code ?? 'UNKNOWN'} ${error?.message ?? String(error)}`
      try {
        await unlink(tmp)
      } catch {
        /* already renamed away, or still locked by the AV scanner */
      }
      throw error
    } finally {
      this.tmpInFlight.delete(tmp)
    }
  }

  /**
   * Serialized atomic write. Resolves once the rename is done.
   *
   * The serialization chain is kept RESOLVED on every outcome: a transient
   * failure must not poison every later save (D17). The failing write's own
   * promise still rejects for its caller, and `lastFailure` records it.
   */
  write(state) {
    const payload = { ...state, schemaVersion: 1, savedAt: this.now() }
    const start = () => this.#persist(payload)
    const current = this.queue.then(start, start)
    this.queue = current.then(() => undefined, () => undefined)
    return current
  }

  /** Append one audit event; a failed append must not break the caller. */
  async append(event) {
    const row = { at: this.now(), ...event }
    try {
      await appendFile(this.journalPath, `${JSON.stringify(row)}\n`, 'utf8')
      return true
    } catch (error) {
      this.lastFailure = `audit append failed: ${String(error)}`
      return false
    }
  }
}

/**
 * A turn end is protected while its session has not acknowledged it: the green
 * "unread" pill must survive any cache compaction (audit defect A-4). A missing
 * ack, or a `seenAt` older than the turn end, means the fact is still unread.
 */
export function turnEndProtected(turnEnd, acks, id) {
  const ack = acks?.[id]
  if (ack === undefined || ack === null) return true
  const seenAt = Number(ack.seenAt)
  if (!Number.isFinite(seenAt)) return true
  const endedAt = Number(turnEnd?.[id]?.at)
  // Without a finite turn-end timestamp the entry can never drive the pill.
  if (!Number.isFinite(endedAt)) return false
  return seenAt < endedAt
}

/** Hard ceiling as a multiple of the soft cap, for unacked turn ends only. */
const TURN_END_CEILING_FACTOR = 4

/** Keep the in-memory document bounded (previews/audit are caches, not archives). */
export function compactState(state, { maxPreviews = 200, maxAudit = 200, maxTurnEnds = 400 } = {}) {
  const previews = state.previews ?? {}
  const previewKeys = Object.keys(previews)
  if (previewKeys.length > maxPreviews) {
    previewKeys
      .sort((a, b) => (Number(previews[b]?.at) || 0) - (Number(previews[a]?.at) || 0))
      .slice(maxPreviews)
      .forEach(key => { delete previews[key] })
  }
  const turnEnd = state.turnEnd ?? {}
  const turnKeys = Object.keys(turnEnd)
  const cap = Math.max(0, Math.floor(Number(maxTurnEnds) || 0))
  if (turnKeys.length > cap) {
    const acks = state.acks !== null && typeof state.acks === 'object' ? state.acks : {}
    const sorted = turnKeys
      .slice()
      .sort((a, b) => (Number(turnEnd[b]?.at) || 0) - (Number(turnEnd[a]?.at) || 0))
    const kept = []
    const evicted = []
    for (const key of sorted) {
      // The cap is best-effort: a protected entry older than the cap is kept.
      if (kept.length < cap || turnEndProtected(turnEnd, acks, key)) kept.push(key)
      else evicted.push(key)
    }
    // Last resort: a flood of unacked facts must still be bounded, or the file
    // grows without limit. Only past the 4x ceiling are the oldest protected
    // entries evicted (documented in docs/audit/A-status-sessions.md defect 4).
    const ceiling = cap * TURN_END_CEILING_FACTOR
    while (kept.length > ceiling) evicted.push(kept.pop())
    for (const key of evicted) delete turnEnd[key]
  }
  if (Array.isArray(state.audit) && state.audit.length > maxAudit) {
    state.audit = state.audit.slice(-maxAudit)
  }
  return state
}
