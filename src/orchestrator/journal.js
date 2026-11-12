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

import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let writeCounter = 0

/** Rename errors worth retrying on Windows: AV scanners, indexers, open handles. */
export const RENAME_RETRY_CODES = Object.freeze(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/**
 * State documents this build can read. v1 is the pre-mandate shape (migrated by
 * the host with a restrictive mandate); v2 adds the explicit mandate. A document
 * from an UNKNOWN future version is not guessed at: it is treated as unreadable
 * so the evidence is preserved instead of silently overwritten with defaults.
 */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(new Set([1, 2]))

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
   * @param {number} [options.maxJournalBytes] rotate the JSONL audit past this size
   */
  constructor({
    dir,
    now = Date.now,
    renameRetryDelaysMs = DEFAULT_RENAME_RETRY_DELAYS_MS,
    sleep = defaultSleep,
    renameFile = rename,
    maxJournalBytes = 8 * 1024 * 1024,
  }) {
    if (typeof dir !== 'string' || dir === '') throw new Error('agent-board: StateStore needs a directory')
    this.dir = dir
    this.statePath = join(dir, 'state.json')
    this.journalPath = join(dir, 'audit.jsonl')
    this.now = now
    this.renameRetryDelaysMs = renameRetryDelaysMs
    this.sleep = sleep
    this.renameFile = renameFile
    // The JSONL journal is a bounded cache, like state.audit: past ~8 MiB the
    // current file becomes `audit.jsonl.1` (one generation kept) and the new file
    // starts with an `audit_rotated` record. Export before rotating if the older
    // evidence matters: rotation TRUNCATES history and says so in the journal.
    this.maxJournalBytes = Number.isFinite(maxJournalBytes) && maxJournalBytes > 0 ? maxJournalBytes : 8 * 1024 * 1024
    this.lastRotation = null
    this.lastRotationCheckAt = 0
    this.queue = Promise.resolve()
    // Shutdown flag: writeSync() sets it so a queued async write cannot rename
    // its older snapshot over the final document.
    this.closed = false
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
    if (parsed === null || typeof parsed !== 'object') {
      // A fresh document always carries a schema version: the caller's when it
      // declares one (v2 for the mandate), otherwise the legacy 1 — never a
      // silently version-less document that a later build would treat as foreign.
      const declared = Number(defaults?.schemaVersion)
      const initial = { ...defaults, schemaVersion: Number.isFinite(declared) && declared > 0 ? declared : 1 }
      if (write) await this.write(initial)
      return initial
    }
    if (!SUPPORTED_SCHEMA_VERSIONS.has(Number(parsed.schemaVersion))) {
      // A document from an UNKNOWN version is someone else's data (a newer
      // build). Never overwrite it with defaults: set it aside as evidence so
      // the operator can roll back/upgrade deliberately.
      this.lastFailure = `state.json schemaVersion ${String(parsed.schemaVersion)} unsupported; preserved`
      if (write) {
        try {
          await rename(this.statePath, `${this.statePath}.unsupported-${this.now()}`)
        } catch {
          /* the rename is best-effort; the file is still not overwritten below */
          throw new Error(`state.json schemaVersion ${String(parsed.schemaVersion)} is unsupported (refusing to overwrite)`)
        }
      }
      const declared = Number(defaults?.schemaVersion)
      const initial = { ...defaults, schemaVersion: Number.isFinite(declared) && declared > 0 ? declared : 1 }
      if (write) await this.write(initial)
      return initial
    }
    return { ...defaults, ...parsed }
  }

  /** One atomic write. On failure the tmp is removed, the caller sees the error. */
  async #persist(payload) {
    if (this.closed) throw new Error('agent-board: state store is closed')
    const tmp = `${this.statePath}.tmp-${process.pid}-${writeCounter++}`
    this.tmpInFlight.add(tmp)
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      // Shutdown may have happened while this write was queued: never let it
      // rename an older snapshot over the final synchronous document.
      if (this.closed) {
        try { await unlink(tmp) } catch { /* best effort */ }
        throw new Error('agent-board: state store closed during write')
      }
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
    // The document keeps the version the caller declared (v2 for the mandate);
    // forcing 1 here made every save look pre-mandate to the next read.
    const declared = Number(state?.schemaVersion)
    const payload = { ...state, schemaVersion: Number.isFinite(declared) && declared > 0 ? declared : 1, savedAt: this.now() }
    const start = () => this.#persist(payload)
    const current = this.queue.then(start, start)
    this.queue = current.then(() => undefined, () => undefined)
    return current
  }

  /**
   * Synchronous last-resort save used at shutdown, BEFORE the instance lock is
   * released: a new primary must never read the pre-shutdown document and then
   * be overwritten by this process' late asynchronous write.
   *
   * @returns {boolean} true when the rename landed
   */
  writeSync(state) {
    // Close the store first: a queued async write must not rename its older
    // snapshot over this final document (it checks `closed` before renaming).
    this.closed = true
    const declared = Number(state?.schemaVersion)
    const payload = { ...state, schemaVersion: Number.isFinite(declared) && declared > 0 ? declared : 1, savedAt: this.now() }
    const tmp = `${this.statePath}.tmp-${process.pid}-exit`
    try {
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.statePath)
      return true
    } catch (error) {
      this.lastFailure = `shutdown save failed: ${error?.code ?? 'UNKNOWN'} ${error?.message ?? String(error)}`
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
      return false
    }
  }

  /** Append one audit event; a failed append must not break the caller. */
  async append(event) {
    const row = { at: this.now(), ...event }
    try {
      await this.rotateJournalIfNeeded()
      await appendFile(this.journalPath, `${JSON.stringify(row)}\n`, 'utf8')
      return true
    } catch (error) {
      this.lastFailure = `audit append failed: ${String(error)}`
      return false
    }
  }

  /**
   * Rotate `audit.jsonl` past `maxJournalBytes`. One generation is kept
   * (`audit.jsonl.1`); the new file starts with an `audit_rotated` record that
   * states the truncation, so the loss of older history is never silent.
   * Checked at most once per minute to keep appends cheap.
   */
  async rotateJournalIfNeeded() {
    const now = Date.now()
    if (now - this.lastRotationCheckAt < 60_000) return false
    this.lastRotationCheckAt = now
    let size = 0
    try {
      size = (await stat(this.journalPath)).size
    } catch {
      return false
    }
    if (size < this.maxJournalBytes) return false
    const target = `${this.journalPath}.1`
    try {
      await unlink(target).catch(() => {})
      await renameWithRetry(this.journalPath, target, { renameFile: this.renameFile, sleep: this.sleep, delaysMs: this.renameRetryDelaysMs })
    } catch (error) {
      this.lastFailure = `audit rotation failed: ${String(error)}`
      return false
    }
    this.lastRotation = { at: now, bytes: size, target }
    await appendFile(this.journalPath, `${JSON.stringify({ at: this.now(), type: 'audit_rotated', bytes: size, previous: 'audit.jsonl.1' })}\n`, 'utf8')
    return true
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
export function compactState(state, { maxPreviews = 200, maxAudit = 200, maxTurnEnds = 400, maxProposals = 200, maxAssignments = 200, maxAcks = 1000 } = {}) {
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
  // Resolved proposals and ended assignments are history, not state: keep the
  // pending/active ones unconditionally and bound the rest (D16).
  if (Array.isArray(state.proposals) && state.proposals.length > maxProposals) {
    const pending = state.proposals.filter(proposal => proposal?.status === 'pending')
    const resolved = state.proposals.filter(proposal => proposal?.status !== 'pending')
    // `slice(-0)` would keep EVERYTHING, so the bound must be applied explicitly
    // when the active count already fills the ceiling.
    const keepResolved = Math.max(0, maxProposals - pending.length)
    state.proposals = [...(keepResolved === 0 ? [] : resolved.slice(-keepResolved)), ...pending]
  }
  if (Array.isArray(state.assignments) && state.assignments.length > maxAssignments) {
    const active = state.assignments.filter(assignment => ['starting', 'running', 'recovering'].includes(assignment?.status))
    const ended = state.assignments.filter(assignment => !['starting', 'running', 'recovering'].includes(assignment?.status))
    const keepEnded = Math.max(0, maxAssignments - active.length)
    state.assignments = [...(keepEnded === 0 ? [] : ended.slice(-keepEnded)), ...active]
  }
  if (state.acks !== null && typeof state.acks === 'object' && !Array.isArray(state.acks)) {
    const ackKeys = Object.keys(state.acks)
    if (ackKeys.length > maxAcks) {
      ackKeys
        .sort((a, b) => (Number(state.acks[b]?.seenAt) || 0) - (Number(state.acks[a]?.seenAt) || 0))
        .slice(maxAcks)
        .forEach(key => { delete state.acks[key] })
    }
  }
  return state
}
