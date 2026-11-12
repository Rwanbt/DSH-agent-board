/**
 * Persistent operator directives: global and per-project instructions that sit
 * below the mandate in precedence (host permissions > mandate > global
 * directive > project directive > plan/task).
 *
 * A directive is a constraint, never a grant. Resolution is most-restrictive
 * first: every applicable active directive is concatenated in a stable order,
 * and two applicable directives whose normalized texts express opposite
 * polarity on the same subject are reported as an unmergeable conflict so the
 * caller (prompt builder / policy path) keeps the restrictive one.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Revoked directives
 * are never returned as active. Inputs are never mutated.
 *
 * @module dsh-agent-board/superagent/directives
 */

/** Hard cap on retained directives (bounded memory). */
export const DIRECTIVE_LIMIT = 200
/** Bound for a directive text. */
export const DIRECTIVE_TEXT_LIMIT = 400

const SCOPES = Object.freeze(['global', 'project'])
const STATUSES = Object.freeze(['active', 'revoked'])
const SOURCES = Object.freeze(['ui', 'api', 'migration'])

/**
 * Deterministic conflict rule (documented contract, applied by
 * `resolveDirectives`):
 *
 *   1. Both texts are normalized case/whitespace-insensitively (lowercase,
 *      collapsed whitespace, leading bullets and trailing punctuation removed).
 *   2. A leading polarity marker is recognized from the closed lists below
 *      (longest marker first, so "must not" wins over "must").
 *   3. A conflict exists exactly when the two texts have OPPOSITE polarity and
 *      the SAME remaining subject.
 *
 * Texts without an explicit marker never conflict: ambiguity is not treated as
 * a conflict, it is simply concatenated. That keeps the rule deterministic and
 * prevents false positives on ordinary prose.
 */
const NEGATIVE_MARKERS = Object.freeze(['must never', 'must not', 'do not', "don't", 'never', 'forbid', 'forbidden', 'avoid', 'no'])
const POSITIVE_MARKERS = Object.freeze(['must always', 'must only', 'always', 'require', 'required', 'ensure', 'allow', 'permit', 'prefer', 'must'])

const POLARITY_MARKERS = Object.freeze(
  [
    ...NEGATIVE_MARKERS.map(text => ({ text, polarity: -1 })),
    ...POSITIVE_MARKERS.map(text => ({ text, polarity: 1 })),
  ].sort((left, right) => right.text.length - left.text.length),
)

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, max = DIRECTIVE_TEXT_LIMIT) {
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
  return SCOPES.includes(text) ? text : 'global'
}

function normalizeSource(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SOURCES.includes(text) ? text : 'ui'
}

function normalizeDirectiveStatus(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return STATUSES.includes(text) ? text : 'active'
}

/**
 * Case/whitespace-insensitive form used for deduplication and conflict
 * detection. Bullets and trailing punctuation are noise, so they are stripped.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeForCompare(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-*•]+/, '')
    .replace(/[.!?;:,]+$/, '')
    .trim()
}

function detectPolarity(text) {
  const normalized = normalizeForCompare(text)
  if (normalized === '') return null
  for (const marker of POLARITY_MARKERS) {
    if (normalized === marker.text) return { polarity: marker.polarity, subject: '' }
    if (normalized.startsWith(`${marker.text} `)) {
      const subject = normalized
        .slice(marker.text.length + 1)
        .replace(/^[\s:\-–—]+/, '')
        .replace(/[.!?;:,]+$/, '')
        .trim()
      return { polarity: marker.polarity, subject }
    }
  }
  return null
}

/**
 * Normalize one directive. Never throws; unknown keys are dropped and an
 * unscoped project directive stays inert (project scope with `projectId:null`)
 * instead of silently widening to global.
 *
 * @param {unknown} raw
 * @param {{now?: number}} [options]
 * @returns {object}
 */
export function normalizeDirective(raw, { now } = {}) {
  const source = isRecord(raw) ? raw : {}
  const fallbackNow = finiteInt(now, 0) ?? 0
  const scope = normalizeScope(source.scope)
  const projectIdText = boundedText(source.projectId, 200)
  const text = boundedText(source.text, DIRECTIVE_TEXT_LIMIT)
  const createdAt = finiteInt(source.createdAt, fallbackNow) ?? 0
  const updatedAt = finiteInt(source.updatedAt, createdAt) ?? createdAt
  const idText = boundedText(source.id, 200)
  const id = idText !== ''
    ? idText
    : `dir-${hashText(`directive:${scope}:${projectIdText}:${text}:${createdAt}`)}`
  return {
    id,
    scope,
    projectId: scope === 'project' && projectIdText !== '' ? projectIdText : null,
    text,
    // The contract fixes the author: only the operator writes directives.
    author: 'operator',
    createdAt,
    updatedAt,
    version: clampInt(source.version, 1, 1000000, 1),
    status: normalizeDirectiveStatus(source.status),
    source: normalizeSource(source.source),
  }
}

function normalizeDirectiveList(list) {
  if (!Array.isArray(list)) return []
  return list.map(entry => normalizeDirective(entry, { now: 0 }))
}

/** FIFO-ish bound: revoked history is dropped before active directives. */
function boundDirectives(list) {
  if (list.length <= DIRECTIVE_LIMIT) return list
  const keep = [...list]
  while (keep.length > DIRECTIVE_LIMIT) {
    const revokedIndex = keep.findIndex(directive => directive.status === 'revoked')
    if (revokedIndex >= 0) {
      keep.splice(revokedIndex, 1)
      continue
    }
    keep.shift()
  }
  return keep
}

/**
 * Add a directive. Invalid input is refused by returning `directive:null` with
 * the list untouched (a project directive without a project id must never
 * become a global one).
 *
 * @param {unknown} list
 * @param {object} input
 * @param {{now?: number}} [options]
 * @returns {{directives: object[], directive: object|null}}
 */
export function addDirective(list, input, { now } = {}) {
  const directives = normalizeDirectiveList(list)
  const draft = isRecord(input) ? input : {}
  const text = boundedText(draft.text, DIRECTIVE_TEXT_LIMIT)
  const scope = normalizeScope(draft.scope)
  const projectIdText = boundedText(draft.projectId, 200)
  if (text === '') return { directives, directive: null }
  if (scope === 'project' && projectIdText === '') return { directives, directive: null }
  const at = finiteInt(now, 0) ?? 0
  const suggestedId = `dir-${hashText(`add:${scope}:${projectIdText}:${text}:${at}:${directives.length}`)}`
  const directive = normalizeDirective(
    {
      id: suggestedId,
      scope,
      projectId: scope === 'project' ? projectIdText : null,
      text,
      author: 'operator',
      createdAt: at,
      updatedAt: at,
      version: 1,
      status: 'active',
      source: normalizeSource(draft.source),
    },
    { now: at },
  )
  return { directives: boundDirectives([...directives, directive]), directive }
}

/**
 * Revoke one directive by id. Idempotent at the call level: revoking an
 * already revoked or unknown id returns `ok:false` and never mutates it.
 *
 * @param {unknown} list
 * @param {string} id
 * @param {{now?: number}} [options]
 * @returns {{directives: object[], directive: object|null, ok: boolean}}
 */
export function revokeDirective(list, id, { now } = {}) {
  const directives = normalizeDirectiveList(list)
  const targetId = boundedText(id, 200)
  const index = directives.findIndex(directive => directive.id === targetId)
  if (index < 0) return { directives, directive: null, ok: false }
  const current = directives[index]
  if (current.status === 'revoked') return { directives, directive: current, ok: false }
  const at = finiteInt(now, 0) ?? 0
  const revoked = { ...current, status: 'revoked', updatedAt: at, version: current.version + 1 }
  const next = directives.slice()
  next[index] = revoked
  return { directives: next, directive: revoked, ok: true }
}

/**
 * Active, applicable directives. Revoked and empty directives are excluded.
 * Order is stable: globals (createdAt asc, id asc) then project directives.
 *
 * @param {unknown} list
 * @param {{projectId?: string}} [options]
 * @returns {object[]}
 */
export function activeDirectives(list, { projectId } = {}) {
  const target = boundedText(projectId, 200)
  const globals = []
  const projects = []
  for (const directive of normalizeDirectiveList(list)) {
    if (directive.status !== 'active' || directive.text === '') continue
    if (directive.scope === 'global') globals.push(directive)
    else if (target !== '' && directive.projectId === target) projects.push(directive)
  }
  const byAge = (left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  return [...globals.sort(byAge), ...projects.sort(byAge)]
}

/**
 * Most-restrictive resolution for one project: applicable directives are
 * concatenated (global then project, stable), exact duplicate texts are
 * collapsed, and unmergeable opposite-polarity pairs are reported.
 *
 * @param {unknown} list
 * @param {{projectId?: string}} [options]
 * @returns {{blocks: string[], conflicts: object[], restricted: boolean}}
 */
export function resolveDirectives(list, { projectId } = {}) {
  const applicable = activeDirectives(list, { projectId })
  const blocks = []
  const seen = new Set()
  for (const directive of applicable) {
    const key = normalizeForCompare(directive.text)
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push(directive.text)
  }
  const conflicts = []
  for (let leftIndex = 0; leftIndex < applicable.length; leftIndex += 1) {
    const left = detectPolarity(applicable[leftIndex].text)
    if (left === null || left.subject === '') continue
    for (let rightIndex = leftIndex + 1; rightIndex < applicable.length; rightIndex += 1) {
      const right = detectPolarity(applicable[rightIndex].text)
      if (right === null || right.subject === '') continue
      if (left.polarity === right.polarity) continue
      if (left.subject !== right.subject) continue
      conflicts.push({
        aId: applicable[leftIndex].id,
        bId: applicable[rightIndex].id,
        aText: applicable[leftIndex].text,
        bText: applicable[rightIndex].text,
        reason: 'opposite_polarity',
      })
    }
  }
  return { blocks, conflicts, restricted: blocks.length > 0 || conflicts.length > 0 }
}

/**
 * Stable fingerprint of the whole directive history (active and revoked), used
 * to detect changes without hashing arbitrary object key order.
 *
 * @param {unknown} list
 * @returns {string}
 */
export function directivesFingerprint(list) {
  const directives = normalizeDirectiveList(list)
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const canonical = directives.map(directive => [
    directive.id,
    directive.scope,
    directive.projectId ?? '',
    directive.text,
    directive.status,
    directive.version,
    directive.updatedAt,
  ])
  return `dirfp1-${hashText(JSON.stringify(canonical))}`
}
