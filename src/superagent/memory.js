/**
 * Bounded Super Agent memory and the checkpoint handed to a new session.
 *
 * Memory is intentionally small and deterministic: a FIFO of facts and of
 * recorded decisions (120 each), plus a text digest. Ids are derived from
 * content and the entry counter, so replaying the same input yields the same
 * state — no randomness, no clock reads.
 *
 * `checkpointOf` produces the compact, JSON-safe context that survives a
 * session recycle. It never carries a transcript, a credential or an unbounded
 * list, and it states explicitly which sections were truncated.
 *
 * @module dsh-agent-board/superagent/memory
 */

import { publicIdentityOf } from './identity.js'
import { resolveDirectives } from './directives.js'
import { inboxSummary } from './decisions.js'

/** Frozen retention limits. */
export const MEMORY_LIMITS = Object.freeze({
  facts: 120,
  decisions: 120,
  factText: 400,
  decisionSummary: 400,
  refs: 20,
  refText: 200,
  digestText: 4000,
  digestFacts: 20,
  digestDecisions: 20,
  checkpointFacts: 10,
  checkpointDecisions: 5,
  checkpointBlocks: 8,
  checkpointConflicts: 4,
  checkpointObjectives: 5,
  checkpointNextActions: 8,
  checkpointDigestText: 600,
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, max = 400) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function finiteInt(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return fallback
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  }
  return fallback
}

function clampInt(value, min, max, fallback) {
  const parsed = finiteInt(value, null)
  if (parsed === null) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function hashText(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

function normalizeScope(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === 'project' ? 'project' : 'global'
}

/**
 * Normalize a fact. `index` is the entry counter used in the derived id, which
 * is why ids are deterministic yet unique within one memory.
 */
function normalizeFact(raw, { now, index }) {
  if (!isRecord(raw)) return null
  const text = boundedText(raw.text, MEMORY_LIMITS.factText)
  if (text === '') return null
  const scope = normalizeScope(raw.scope)
  const projectIdText = boundedText(raw.projectId, 200)
  const projectId = scope === 'project' && projectIdText !== '' ? projectIdText : null
  const kind = boundedText(raw.kind, 40) || 'note'
  const at = finiteInt(now, null) ?? finiteInt(raw.at, 0) ?? 0
  const idText = boundedText(raw.id, 200)
  const id = idText !== '' ? idText : `mem-f-${hashText(`fact:${at}:${scope}:${projectId ?? ''}:${kind}:${text}:${index}`)}`
  return { id, at, scope, projectId, kind, text }
}

function normalizeDecisionEntry(raw, { now, index }) {
  if (!isRecord(raw)) return null
  const summary = boundedText(raw.summary, MEMORY_LIMITS.decisionSummary)
  if (summary === '') return null
  const projectIdText = boundedText(raw.projectId, 200)
  const projectId = projectIdText === '' ? null : projectIdText
  const kind = boundedText(raw.kind, 40) || 'note'
  const at = finiteInt(now, null) ?? finiteInt(raw.at, 0) ?? 0
  const refs = []
  if (Array.isArray(raw.refs)) {
    for (const entry of raw.refs) {
      if (refs.length >= MEMORY_LIMITS.refs) break
      const ref = boundedText(entry, MEMORY_LIMITS.refText)
      if (ref !== '') refs.push(ref)
    }
  }
  const idText = boundedText(raw.id, 200)
  const id = idText !== '' ? idText : `mem-d-${hashText(`decision:${at}:${projectId ?? ''}:${kind}:${summary}:${refs.join('|')}:${index}`)}`
  return { id, at, kind, projectId, summary, refs }
}

function normalizeFacts(list, { now } = {}) {
  if (!Array.isArray(list)) return []
  const facts = []
  for (const entry of list) {
    const fact = normalizeFact(entry, { now, index: facts.length })
    if (fact !== null) facts.push(fact)
  }
  // FIFO: hostile/oversized persisted state keeps the newest entries.
  return facts.slice(-MEMORY_LIMITS.facts)
}

function normalizeDecisionEntries(list, { now } = {}) {
  if (!Array.isArray(list)) return []
  const decisions = []
  for (const entry of list) {
    const decision = normalizeDecisionEntry(entry, { now, index: decisions.length })
    if (decision !== null) decisions.push(decision)
  }
  return decisions.slice(-MEMORY_LIMITS.decisions)
}

/**
 * Empty memory. A function (not a constant) so callers never share arrays.
 *
 * @returns {{facts: object[], decisions: object[], digest: object|null}}
 */
export function emptyMemory() {
  return { facts: [], decisions: [], digest: null }
}

/**
 * Append a fact with FIFO retention. Refuses empty facts by returning the
 * normalized memory unchanged. The previous digest is invalidated (`null`)
 * because it no longer describes the memory.
 *
 * @param {unknown} memory
 * @param {object} fact
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function recordFact(memory, fact, { now } = {}) {
  const source = isRecord(memory) ? memory : {}
  const facts = normalizeFacts(source.facts)
  const decisions = normalizeDecisionEntries(source.decisions)
  const normalized = normalizeFact(fact, { now, index: facts.length })
  if (normalized === null) return { facts, decisions, digest: source.digest ?? null }
  return {
    facts: [...facts, normalized].slice(-MEMORY_LIMITS.facts),
    decisions,
    digest: null,
  }
}

/**
 * Append a remembered decision with FIFO retention.
 *
 * @param {unknown} memory
 * @param {object} decision
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function recordDecision(memory, decision, { now } = {}) {
  const source = isRecord(memory) ? memory : {}
  const facts = normalizeFacts(source.facts)
  const decisions = normalizeDecisionEntries(source.decisions)
  const normalized = normalizeDecisionEntry(decision, { now, index: decisions.length })
  if (normalized === null) return { facts, decisions, digest: source.digest ?? null }
  return {
    facts,
    decisions: [...decisions, normalized].slice(-MEMORY_LIMITS.decisions),
    digest: null,
  }
}

/**
 * Trim to the retention bounds and rebuild the digest.
 *
 * @param {unknown} memory
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function compactMemory(memory, { now } = {}) {
  const source = isRecord(memory) ? memory : {}
  const facts = normalizeFacts(source.facts)
  const decisions = normalizeDecisionEntries(source.decisions)
  return { facts, decisions, digest: buildDigest({ facts, decisions }, { now }) }
}

/**
 * Deterministic text digest. It deliberately contains no relative-time
 * phrasing (no "3 minutes ago"): the same memory always produces the same text,
 * so a digest can be compared and cached.
 *
 * @param {unknown} memory
 * @param {{now?: number}} [options]
 * @returns {{text: string, updatedAt: number, facts: number, decisions: number}}
 */
export function buildDigest(memory, { now } = {}) {
  const source = isRecord(memory) ? memory : {}
  const facts = normalizeFacts(source.facts)
  const decisions = normalizeDecisionEntries(source.decisions)
  const header = `Memory digest — ${facts.length} facts, ${decisions.length} decisions`
  const factLines = facts
    .slice(-MEMORY_LIMITS.digestFacts)
    .map(fact => `- [${fact.kind}]${fact.projectId === null ? '' : ` (${fact.projectId})`} ${fact.text}`)
  const decisionLines = decisions
    .slice(-MEMORY_LIMITS.digestDecisions)
    .map(decision => `- [${decision.kind}]${decision.projectId === null ? '' : ` (${decision.projectId})`} ${decision.summary}`)
  const lines = [header]
  if (factLines.length > 0) lines.push('Facts:', ...factLines)
  if (decisionLines.length > 0) lines.push('Decisions:', ...decisionLines)
  let text = lines.join('\n')
  const limit = MEMORY_LIMITS.digestText
  if (text.length > limit) text = `${text.slice(0, limit - 12)}\n[truncated]`
  return {
    text,
    updatedAt: finiteInt(now, 0) ?? 0,
    facts: facts.length,
    decisions: decisions.length,
  }
}

function normalizePlan(raw) {
  const source = isRecord(raw) ? raw : {}
  const objectives = []
  if (Array.isArray(source.objectives)) {
    for (const entry of source.objectives.slice(0, 100)) {
      if (!isRecord(entry)) continue
      const title = boundedText(entry.title, 200)
      if (title === '') continue
      const projectIdText = boundedText(entry.projectId, 200)
      objectives.push({
        id: boundedText(entry.id, 120) || `obj-${hashText(`objective:${title}:${objectives.length}`)}`,
        projectId: projectIdText === '' ? null : projectIdText,
        title,
        status: boundedText(entry.status, 40) || 'unknown',
        source: boundedText(entry.source, 40) || 'unknown',
      })
    }
  }
  const nextActions = []
  if (Array.isArray(source.nextActions)) {
    for (const entry of source.nextActions.slice(0, 100)) {
      if (!isRecord(entry)) continue
      const action = boundedText(entry.action, 80)
      if (action === '') continue
      const projectIdText = boundedText(entry.projectId, 200)
      const taskIdText = boundedText(entry.taskId, 120)
      nextActions.push({
        id: boundedText(entry.id, 120) || `act-${hashText(`action:${action}:${nextActions.length}`)}`,
        action,
        projectId: projectIdText === '' ? null : projectIdText,
        taskId: taskIdText === '' ? null : taskIdText,
        rationale: boundedText(entry.rationale, 200),
      })
    }
  }
  return {
    revision: clampInt(source.revision, 0, 1000000000, 0),
    updatedAt: finiteInt(source.updatedAt, 0) ?? 0,
    objectives,
    nextActions,
    idleReason: boundedText(source.idleReason, 400) || null,
  }
}

/**
 * Compact, JSON-safe context for a fresh session. Accepts the whole
 * `state.superagent` slice: identity, directives, plan, memory, decisions.
 * Every bounded list carries an explicit `truncated` flag.
 *
 * @param {unknown} state
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function checkpointOf(state, { now } = {}) {
  // Accept both the Super Agent slice and a whole board state carrying it.
  const source = isRecord(state)
    ? (isRecord(state.superagent) ? state.superagent : state)
    : {}
  const at = finiteInt(now, 0) ?? 0
  const identity = publicIdentityOf(source)

  const sessionSource = isRecord(source.session) ? source.session : {}
  const session = {
    active: sessionSource.active === true,
    recycledCount: clampInt(sessionSource.recycledCount, 0, 100000, 0),
    lastTurnAt: finiteInt(sessionSource.lastTurnAt, null),
  }

  const directiveList = Array.isArray(source.directives) ? source.directives : []
  const projectIdText = boundedText(source.projectId, 200)
  const resolved = resolveDirectives(directiveList, projectIdText === '' ? {} : { projectId: projectIdText })
  const activeCount = directiveList.filter(entry => isRecord(entry) && entry.status === 'active').length
  const resolvedBlocks = resolved.blocks
  const blocks = resolvedBlocks.slice(0, MEMORY_LIMITS.checkpointBlocks)
  const conflicts = resolved.conflicts.slice(0, MEMORY_LIMITS.checkpointConflicts).map(conflict => ({
    aId: conflict.aId,
    bId: conflict.bId,
    reason: conflict.reason,
  }))

  const plan = normalizePlan(source.plan)
  const objectives = plan.objectives.slice(0, MEMORY_LIMITS.checkpointObjectives)
  const nextActions = plan.nextActions.slice(0, MEMORY_LIMITS.checkpointNextActions)

  const memorySource = isRecord(source.memory) ? source.memory : {}
  const facts = normalizeFacts(memorySource.facts)
  const checkpointFacts = facts.slice(-MEMORY_LIMITS.checkpointFacts).map(fact => ({
    kind: fact.kind,
    projectId: fact.projectId,
    text: fact.text,
  }))
  const digestText = boundedText(
    isRecord(memorySource.digest) ? memorySource.digest.text : '',
    MEMORY_LIMITS.checkpointDigestText,
  )
  const digestSourceText = boundedText(
    isRecord(memorySource.digest) ? memorySource.digest.text : '',
    Number.MAX_SAFE_INTEGER,
  )

  const decisionInbox = Array.isArray(source.decisions) ? source.decisions : []
  const decisionSummary = inboxSummary(decisionInbox)
  const pendingItems = []
  for (const decision of decisionInbox) {
    if (!isRecord(decision) || decision.status !== 'pending') continue
    const title = boundedText(decision.title, 120)
    if (title === '') continue
    const projectIdValue = boundedText(decision.projectId, 200)
    pendingItems.push({
      id: boundedText(decision.id, 120) || `decision-${hashText(title)}`,
      kind: boundedText(decision.kind, 40) || 'approval',
      title,
      urgency: boundedText(decision.urgency, 20) === 'urgent' ? 'urgent' : 'normal',
      action: boundedText(decision.action, 80),
      projectId: projectIdValue === '' ? null : projectIdValue,
    })
  }
  pendingItems.sort((left, right) => {
    if (left.urgency !== right.urgency) return left.urgency === 'urgent' ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const decisionItems = pendingItems.slice(0, MEMORY_LIMITS.checkpointDecisions)

  return {
    at,
    identity,
    session,
    directives: {
      total: directiveList.length,
      active: activeCount,
      restricted: resolved.restricted,
      blocks,
      conflicts,
    },
    plan: {
      revision: plan.revision,
      updatedAt: plan.updatedAt,
      idleReason: plan.idleReason,
      objectives,
      nextActions,
    },
    decisions: {
      pending: decisionSummary.pending,
      urgent: decisionSummary.urgent,
      answered: decisionSummary.answered,
      oldestAt: decisionSummary.oldestAt,
      items: decisionItems,
    },
    facts: checkpointFacts,
    digest: digestText === '' ? null : digestText,
    truncated: {
      facts: facts.length > checkpointFacts.length,
      decisions: decisionSummary.pending > decisionItems.length,
      directives: resolvedBlocks.length > blocks.length || resolved.conflicts.length > conflicts.length,
      objectives: plan.objectives.length > objectives.length,
      nextActions: plan.nextActions.length > nextActions.length,
      digest: digestSourceText.length > digestText.length,
    },
  }
}
