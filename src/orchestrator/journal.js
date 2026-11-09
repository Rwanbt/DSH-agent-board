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

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let writeCounter = 0

export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.dir absolute directory owned by this plugin
   * @param {() => number} [options.now]
   */
  constructor({ dir, now = Date.now }) {
    if (typeof dir !== 'string' || dir === '') throw new Error('agent-board: StateStore needs a directory')
    this.dir = dir
    this.statePath = join(dir, 'state.json')
    this.journalPath = join(dir, 'audit.jsonl')
    this.now = now
    this.queue = Promise.resolve()
    this.ready = null
    this.lastFailure = null
  }

  /** Create the directory and read the current state (or the defaults). */
  async init(defaults) {
    await mkdir(this.dir, { recursive: true })
    let parsed = null
    try {
      const raw = await readFile(this.statePath, 'utf8')
      parsed = JSON.parse(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Never destroy evidence: move the unreadable file aside and start clean.
        this.lastFailure = `state.json unreadable (${error?.code ?? error?.message}); quarantined`
        try {
          await rename(this.statePath, `${this.statePath}.corrupt-${this.now()}`)
        } catch {
          /* the rename is best-effort, the failure stays reported */
        }
      }
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
      const initial = { ...defaults, schemaVersion: 1 }
      await this.write(initial)
      return initial
    }
    return { ...defaults, ...parsed }
  }

  /** Serialized atomic write. Resolves once the rename is done. */
  write(state) {
    const payload = { ...state, schemaVersion: 1, savedAt: this.now() }
    this.queue = this.queue.then(async () => {
      const tmp = `${this.statePath}.tmp-${process.pid}-${writeCounter++}`
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(tmp, this.statePath)
      return payload
    })
    return this.queue
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
  if (turnKeys.length > maxTurnEnds) {
    turnKeys
      .sort((a, b) => (Number(turnEnd[b]?.at) || 0) - (Number(turnEnd[a]?.at) || 0))
      .slice(maxTurnEnds)
      .forEach(key => { delete turnEnd[key] })
  }
  if (Array.isArray(state.audit) && state.audit.length > maxAudit) {
    state.audit = state.audit.slice(-maxAudit)
  }
  return state
}
