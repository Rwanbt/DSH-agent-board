/**
 * Project work sources: the Agent Board must be able to pilot a project WITHOUT
 * the Task Board plugin.
 *
 * A project already states its intent in files a human wrote: the accepted ADRs
 * (`docs/adr/*.md`), the roadmap/TODO checklists, and the open forge issues. This
 * module turns those documents into deterministic WORK ITEMS the Super Agent may
 * dispatch. A Task Board card remains the richest source when the plugin is
 * installed, but it is never a prerequisite.
 *
 * Trust model: a document is DATA. An unchecked checklist line is a candidate
 * for work, never an authorization: the host gate still decides, and this module
 * flags the items that obviously need a human decision (a proposed ADR, an issue
 * labelled `needs-decision`, an explicit `[decision]` marker).
 *
 * Concurrency: at most ONE synthetic work item runs per project at a time, because
 * such a dispatch forces `isolation:'none'` in the project's shared working tree.
 *
 * Pure: no clock, no I/O, no randomness. Inputs are never mutated.
 *
 * @module dsh-agent-board/orchestrator/project-work
 */

/** Closed vocabulary of work sources, in dispatch-priority order. */
export const WORK_SOURCES = Object.freeze(['adr', 'issue', 'roadmap', 'todo'])

/** Deterministic tie-break between sources. */
export const WORK_SOURCE_PRIORITY = Object.freeze({ adr: 0, issue: 1, roadmap: 2, todo: 3 })

/** Project documents always inspected (relative to the project root). */
export const DOC_SOURCE_FILES = Object.freeze([
  Object.freeze({ path: 'TODO.md', source: 'todo' }),
  Object.freeze({ path: 'BACKLOG.md', source: 'todo' }),
  Object.freeze({ path: 'ROADMAP.md', source: 'roadmap' }),
  Object.freeze({ path: 'docs/TODO.md', source: 'todo' }),
  Object.freeze({ path: 'docs/BACKLOG.md', source: 'todo' }),
  Object.freeze({ path: 'docs/ROADMAP.md', source: 'roadmap' }),
  Object.freeze({ path: 'docs/roadmap.md', source: 'roadmap' }),
  Object.freeze({ path: 'docs/next-steps.md', source: 'roadmap' }),
  Object.freeze({ path: 'docs/plan.md', source: 'roadmap' }),
])

/** Directories whose Markdown files are read as ADRs (relative to the root). */
export const ADR_DIRECTORIES = Object.freeze(['docs/adr', 'docs/decisions', 'adr', 'decisions'])

/** How many work items one project may contribute to a cycle. */
export const WORK_ITEM_LIMIT = 30
/** Attempts allowed for one work item before it is reported as stuck. */
export const WORK_ATTEMPT_LIMIT = 3
/** Delay before a failed/interrupted work item is dispatched again. */
export const WORK_RETRY_DELAY_MS = 60 * 60 * 1000
/** Issue labels that make an issue a human decision, not routine work. */
export const ISSUE_DECISION_LABELS = Object.freeze([
  'blocked', 'needs-decision', 'needs decision', 'needs-design', 'needs-triage', 'decision', 'question', 'help wanted',
])
/** Explicit markers in a checklist line that say "a human must decide". */
export const DECISION_MARKERS = Object.freeze([
  '[decision]', 'decision required', 'requires decision', 'needs decision',
  'besoin de décision', 'décision requise', 'arbitrage requis', 'validation humaine',
  '@human', 'human decision',
])

/** Stable reason codes for work-item readiness. */
export const WORK_READINESS_REASONS = Object.freeze({
  invalid: 'invalid_work_item',
  needsHumanDecision: 'needs_human_decision',
  inProgress: 'work_item_in_progress',
  completed: 'work_item_completed',
  projectBusy: 'project_work_in_progress',
  attemptsExhausted: 'work_item_attempts_exhausted',
  retryWait: 'work_item_retry_wait',
  ready: 'ready',
})

const ACTIVE_ASSIGNMENT_STATUSES = Object.freeze(['starting', 'running', 'recovering'])
const FAILED_ASSIGNMENT_STATUSES = Object.freeze(['failed', 'interrupted', 'stopped', 'superseded'])

const ADR_STATUS_ALIASES = Object.freeze({
  accepted: 'accepted', approve: 'accepted', approved: 'accepted', adopted: 'accepted', accepté: 'accepted', acceptee: 'accepted',
  proposed: 'proposed', proposal: 'proposed', draft: 'proposed', proposé: 'proposed', proposee: 'proposed', brouillon: 'proposed',
  superseded: 'inactive', replaced: 'inactive', remplacé: 'inactive', deprecated: 'inactive',
  rejected: 'inactive', rejeté: 'inactive', obsolete: 'inactive', obsolète: 'inactive',
})

/** Sections of an ADR that define follow-up work. */
const ADR_WORK_SECTIONS = /(follow|consequence|next|action|todo|travaux|implément|implement|mise en oeuvre|mise en œuvre|suite|reste|remaining|plan)/i

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

/** Strip the Markdown noise a checklist line inherits. */
function cleanInline(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Bounded, comparable form of an item title (also used for fingerprints). */
export function normalizeWorkTitle(value) {
  const text = cleanInline(value).replace(/[.!?;:,]+$/, '').trim()
  return text.length > 200 ? text.slice(0, 200).trim() : text
}

function normalizeForCompare(value) {
  return normalizeWorkTitle(value).toLowerCase()
}

/** Journal version written by this module (see `migrateWorkJournalV1toV2`). */
export const WORK_JOURNAL_SCHEMA_VERSION = 2

/** Prefix of the content fingerprint. `wf-` is the legacy title-only hash. */
const CONTENT_FINGERPRINT_PREFIX = 'wf2-'
const LEGACY_FINGERPRINT_PREFIX = 'wf-'
const MAX_BLOCK_TEXT = 4000

/** Canonical locator: forward slashes, trimmed, lower case. */
export function normalizeWorkLocator(ref) {
  const text = typeof ref === 'string' ? ref.trim().replace(/\\/g, '/') : ''
  return text.toLowerCase()
}

/**
 * IDENTITY of one work item — WHERE it is declared, never what it says.
 *
 * The v1 id hashed the title, so renaming a line created a brand-new item (and
 * re-dispatched finished work), while two different documents declaring the same
 * sentence collapsed into one item. Identity is now the locator: the document
 * path plus its anchor/line, or an external reference (`#42`).
 *
 * @param {{projectId?: string, source?: string, ref?: string}} input
 * @returns {string}
 */
export function workItemIdentityOf({ projectId, source, ref } = {}) {
  const text = `${String(projectId ?? '')}\u0000${String(source ?? '')}\u0000${normalizeWorkLocator(ref)}`
  return `work-${hashText(text)}`
}

/**
 * Legacy v1 id (project + source + title). Kept because the journal written by
 * 0.1.0 is keyed by it: a migration reads these values, and a caller that only
 * has a title can still derive the id the OLD journal used.
 *
 * @param {{projectId?: string, source?: string, title?: string}|{projectId?: string, source?: string, ref?: string}} input
 * @returns {string}
 */
export function workItemIdOf(input = {}) {
  if (typeof input.ref === 'string' && input.ref !== '') return workItemIdentityOf(input)
  const text = `${String(input.projectId ?? '')}\u0000${String(input.source ?? '')}\u0000${normalizeForCompare(input.title)}`
  return `work-${hashText(text)}`
}

/** Bounded, comparable form of the referenced block (whitespace-collapsed). */
function normalizeBlockText(text) {
  const value = typeof text === 'string' ? text : ''
  return value.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_BLOCK_TEXT)
}

/**
 * CONTENT fingerprint of one work item — what the line asks for.
 *
 * Title + objective + acceptance criteria + the referenced block, normalised.
 * A document edit that changes the intent produces a new fingerprint at the SAME
 * identity, which is what makes the item eligible again (a new revision).
 *
 * @param {{title?: string, objective?: string, criteria?: string[], block?: string}} input
 * @returns {string}
 */
export function workItemContentFingerprintOf({ title, objective = '', criteria = [], block = '' } = {}) {
  const parts = [
    normalizeForCompare(title),
    normalizeForCompare(objective),
    ...(Array.isArray(criteria) ? criteria.map(entry => normalizeForCompare(entry)).filter(Boolean).sort() : []),
    normalizeBlockText(block),
  ]
  return `${CONTENT_FINGERPRINT_PREFIX}${hashText(parts.join('\u0000'))}`
}

/**
 * Content fingerprint in the legacy signature (`{projectId, source, title}`).
 * Kept for callers that only know the old triple.
 *
 * @param {{projectId?: string, source?: string, title?: string}} [input]
 * @returns {string}
 */
export function workItemFingerprintOf({ projectId, source, title } = {}) {
  return `wf-${hashText(`${String(projectId ?? '')}\u0000${String(source ?? '')}\u0000${normalizeForCompare(title)}`)}`
}

/**
 * Migrate the dispatch journal from the v1 (title-keyed) work source to v2
 * (identity + content fingerprint).
 *
 * It never invents a v2 fingerprint for a v1 record: a title was not the content,
 * and claiming otherwise would silently mark NEW intent as already done. The old
 * value is preserved as `legacyFingerprint` for audit, and the record is marked
 * `schemaVersion:2` so the migration is idempotent.
 *
 * @param {object[]|{assignments?: object[]}} journal
 * @param {{at?: number}} [options]
 * @returns {{assignments: object[], migrated: number, legacy: number}}
 */
export function migrateWorkJournalV1toV2(journal, { at = null } = {}) {
  const list = Array.isArray(journal) ? journal : (Array.isArray(journal?.assignments) ? journal.assignments : [])
  let migrated = 0
  let legacy = 0
  const assignments = list.map(entry => {
    const source = entry !== null && typeof entry === 'object' && isRecord(entry.workSource) ? entry.workSource : null
    if (source === null) return entry
    if (Number(source.schemaVersion) >= WORK_JOURNAL_SCHEMA_VERSION) return entry
    migrated += 1
    const previous = typeof source.fingerprint === 'string' ? source.fingerprint : null
    const isLegacy = previous !== null && previous.startsWith(LEGACY_FINGERPRINT_PREFIX)
    if (isLegacy) legacy += 1
    return {
      ...entry,
      workSource: {
        ...source,
        schemaVersion: WORK_JOURNAL_SCHEMA_VERSION,
        // A v1 title hash is NOT a content fingerprint: null means "no content
        // proof", so the item stays eligible instead of looking done.
        fingerprint: null,
        ...(isLegacy ? { legacyFingerprint: previous } : {}),
      },
      ...(Number.isFinite(Number(at)) ? { workJournalMigratedAt: Number(at) } : {}),
    }
  })
  return { assignments, migrated, legacy }
}

/** Does this checklist line explicitly ask for a human decision? */
export function hasDecisionMarker(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === '') return false
  return DECISION_MARKERS.some(marker => text.includes(marker))
}

/**
 * Unchecked Markdown checklist lines (`- [ ] …`), with their nearest heading.
 *
 * @param {string} markdown
 * @returns {{title: string, line: number, heading: string}[]}
 */
export function parseChecklistItems(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return []
  const lines = markdown.split(/\r?\n/)
  const items = []
  let heading = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (headingMatch !== null) {
      heading = normalizeWorkTitle(headingMatch[2])
      continue
    }
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+)$/.exec(line)
    if (match === null || match[1] !== ' ') continue
    const raw = normalizeWorkTitle(match[2])
    if (raw.length < 3) continue
    // A leading marker (`[decision]`, `[blocked]`) is metadata, not a title: it is
    // kept for the decision detection but never shown as the task name.
    const title = normalizeWorkTitle(raw.replace(/^\[[^\]]{1,40}\]\s*/, '')) || raw
    items.push({ title, raw, line: index + 1, heading })
  }
  return items
}

/**
 * Parse one ADR document: its title, its real status, and the follow-up work it
 * declares as unchecked checklist lines.
 *
 * A `proposed`/`draft` ADR is a decision NOT taken: its follow-ups are reported
 * as `needsHumanDecision` instead of work. A `superseded`/`rejected` ADR yields
 * no work at all.
 *
 * @param {string} markdown
 * @param {{path?: string}} [options]
 * @returns {{path: string, title: string, status: string, items: object[]}}
 */
export function parseAdrFile(markdown, { path = '' } = {}) {
  const text = typeof markdown === 'string' ? markdown : ''
  const titleMatch = /^\s{0,3}#\s+(.+?)\s*$/m.exec(text)
  const fallback = String(path).split('/').pop()?.replace(/\.md$/i, '') ?? ''
  const title = normalizeWorkTitle(titleMatch?.[1] ?? fallback)
  const statusMatch = /^[\s>*-]*status[\s*]*:[\s*]*([A-Za-zÀ-ÿ_-]+)/im.exec(text)
  const rawStatus = statusMatch?.[1]?.toLowerCase() ?? ''
  const status = ADR_STATUS_ALIASES[rawStatus] ?? 'unknown'
  if (status === 'inactive') return { path, title, status, items: [] }
  const items = []
  for (const item of parseChecklistItems(text)) {
    const sectionApplies = item.heading === '' || ADR_WORK_SECTIONS.test(item.heading)
    if (!sectionApplies) continue
    items.push(item)
  }
  return { path, title, status, items }
}

function isAdrPath(path) {
  return ADR_DIRECTORIES.some(directory => path === directory || path.startsWith(`${directory}/`))
}

function describeAdrStatus(status) {
  if (status === 'accepted') return 'accepté'
  if (status === 'proposed') return 'proposé (décision non prise)'
  return 'statut inconnu'
}

/**
 * Discover the work a project declares in its own documents.
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {{path: string, content: string}[]} input.files  already-read documents
 * @param {number} [input.limit]
 * @returns {object[]} normalized work items
 */
export function discoverDocWork({ projectId, files, limit = WORK_ITEM_LIMIT } = {}) {
  const project = typeof projectId === 'string' ? projectId : ''
  if (project === '') return []
  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : WORK_ITEM_LIMIT
  const candidates = []
  for (const file of Array.isArray(files) ? files : []) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') continue
    const path = file.path.replace(/\\/g, '/')
    const declared = DOC_SOURCE_FILES.find(entry => entry.path === path)
    const adrPath = isAdrPath(path)
    if (!adrPath && declared === undefined) continue
    if (adrPath) {
      const parsed = parseAdrFile(file.content, { path })
      if (parsed.status === 'inactive') continue
      for (const item of parsed.items) {
        const needsHumanDecision = parsed.status !== 'accepted'
        const entry = buildItem({
          projectId: project, source: 'adr', path, line: item.line, heading: item.heading,
          title: item.title, needsHumanDecision,
          decisionReason: needsHumanDecision ? `adr_not_accepted:${parsed.status}` : null,
          context: `ADR « ${parsed.title} » — statut ${describeAdrStatus(parsed.status)}`,
          block: item.raw ?? item.title,
        })
        if (entry !== null) candidates.push(entry)
      }
      continue
    }
    for (const item of parseChecklistItems(file.content)) {
      const needsHumanDecision = hasDecisionMarker(item.raw ?? item.title)
      const entry = buildItem({
        projectId: project, source: declared.source, path, line: item.line, heading: item.heading,
        title: item.title, needsHumanDecision,
        decisionReason: needsHumanDecision ? 'decision_marker' : null,
        context: item.heading === '' ? '' : `section « ${item.heading} »`,
        block: item.raw ?? item.title,
      })
      if (entry !== null) candidates.push(entry)
    }
  }
  // The SAME declaration copied in two documents (a roadmap line and a TODO line)
  // is ONE piece of work. The winner is chosen by SOURCE PRIORITY (never by file
  // order), so the result is identical whatever order the files were read in.
  const bestByTitle = new Map()
  for (const entry of candidates) {
    const key = normalizeForCompare(entry.title)
    if (key === '') continue
    const current = bestByTitle.get(key)
    if (current === undefined || compareCandidates(entry, current) < 0) bestByTitle.set(key, entry)
  }
  const items = [...bestByTitle.values()]
  items.sort(compareCandidates)
  return items.slice(0, cap)
}

function compareCandidates(left, right) {
  const delta = (WORK_SOURCE_PRIORITY[left.source] ?? 9) - (WORK_SOURCE_PRIORITY[right.source] ?? 9)
  if (delta !== 0) return delta
  if (left.ref !== right.ref) return left.ref < right.ref ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function buildItem({ projectId, source, path, line, heading, title, needsHumanDecision, decisionReason, context, block }) {
  const normalized = normalizeWorkTitle(title)
  if (normalized === '') return null
  const where = `${path}:${line}`
  // Identity is the locator (document + line); content is what the line says.
  const id = workItemIdentityOf({ projectId, source, ref: where })
  const parts = [`Source : ${where}`]
  if (typeof context === 'string' && context !== '') parts.push(context)
  if (typeof heading === 'string' && heading !== '') parts.push(`Section : ${heading}`)
  // The fingerprint must NOT contain the locator: a line that only moved asks for
  // exactly the same work, and re-dispatching finished work is the failure mode
  // this lot exists to remove.
  const objective = [
    ...(typeof context === 'string' && context !== '' ? [context] : []),
    ...(typeof heading === 'string' && heading !== '' ? [`Section : ${heading}`] : []),
  ].join('\n')
  return {
    id,
    projectId,
    source,
    ref: where,
    title: normalized,
    description: parts.join('\n'),
    fingerprint: workItemContentFingerprintOf({
      title: normalized,
      objective,
      block: typeof block === 'string' ? block : '',
    }),
    needsHumanDecision: needsHumanDecision === true,
    decisionReason: decisionReason ?? null,
    origin: 'document',
  }
}

/**
 * Normalize one forge issue into a work item. Pull requests are not issues here;
 * an issue someone already owns, or one carrying a decision label, is not
 * routine work.
 *
 * @param {object} issue
 * @param {{projectId?: string}} [options]
 * @returns {object|null}
 */
export function workItemFromIssue(issue, { projectId } = {}) {
  if (!isRecord(issue) || typeof issue.number !== 'number' || issue.number <= 0) return null
  if (isRecord(issue.pull_request) || issue.pullRequest === true) return null
  const project = typeof projectId === 'string' ? projectId : ''
  if (project === '') return null
  const title = normalizeWorkTitle(String(issue.title ?? ''))
  if (title === '') return null
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map(label => (typeof label === 'string' ? label : String(label?.name ?? ''))).filter(Boolean)
    : []
  const lower = labels.map(label => label.toLowerCase())
  const assigned = Array.isArray(issue.assignees) && issue.assignees.length > 0
  const decisionLabel = lower.find(label => ISSUE_DECISION_LABELS.includes(label)) ?? null
  const needsHumanDecision = assigned || decisionLabel !== null
  const decisionReason = assigned ? 'issue_assigned' : (decisionLabel !== null ? `issue_label:${decisionLabel}` : null)
  // An issue is identified by its NUMBER, never by its title: retitling an issue
  // is the same piece of work, and two documents may carry the same sentence.
  const where = `#${issue.number}`
  const id = workItemIdentityOf({ projectId: project, source: 'issue', ref: where })
  const body = typeof issue.body === 'string' ? issue.body.trim().slice(0, 600) : ''
  return {
    id,
    projectId: project,
    source: 'issue',
    ref: where,
    title,
    description: [
      `Issue #${issue.number}: ${title}`,
      ...(body !== '' ? [body] : []),
    ].join('\n'),
    fingerprint: workItemContentFingerprintOf({ title, objective: body, block: title }),
    needsHumanDecision,
    decisionReason,
    origin: 'forge',
    issueNumber: issue.number,
  }
}

/**
 * Is this work item dispatchable right now?
 *
 * Derived only from durable facts (the assignment journal), never from a timer:
 * a completed item whose document changed is dispatchable again, a failed one is
 * retried with a delay and a hard attempt cap.
 *
 * @param {object} item
 * @param {{assignments?: object[], now?: number}} [options]
 * @returns {{ready: boolean, reason: string, attempts: number}}
 */
export function workItemReadinessOf(item, { assignments = [], now = Date.now() } = {}) {
  if (!isRecord(item) || typeof item.id !== 'string' || item.id === '') {
    return { ready: false, reason: WORK_READINESS_REASONS.invalid, attempts: 0 }
  }
  if (item.needsHumanDecision === true) {
    return { ready: false, reason: `${WORK_READINESS_REASONS.needsHumanDecision}:${item.decisionReason ?? 'flagged'}`, attempts: 0 }
  }
  const all = Array.isArray(assignments) ? assignments.filter(entry => isRecord(entry)) : []
  // An attempt belongs to the item either by IDENTITY (its locator) or by CONTENT:
  // a checklist line that only moved down its document keeps its proven state,
  // because the content it asks for did not change.
  const mine = all.filter(assignment => String(assignment.taskId ?? '') === item.id
    || (typeof item.fingerprint === 'string' && item.fingerprint !== ''
      && typeof assignment.workSource?.fingerprint === 'string'
      && assignment.workSource.fingerprint === item.fingerprint))
  if (mine.some(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status))) {
    return { ready: false, reason: WORK_READINESS_REASONS.inProgress, attempts: mine.length }
  }
  const ended = mine
    .filter(assignment => Number.isFinite(Number(assignment.endedAt ?? assignment.startedAt)))
    .sort((left, right) => (Number(right.endedAt ?? right.startedAt) || 0) - (Number(left.endedAt ?? left.startedAt) || 0))
  const latest = ended[0] ?? null
  const at = latest === null ? 0 : Number(latest.endedAt ?? latest.startedAt) || 0
  if (latest !== null) {
    const fingerprint = typeof latest.workSource?.fingerprint === 'string' ? latest.workSource.fingerprint : null
    // `done` is the TURN verdict, not a proof: only an assignment the host
    // verified (and that no operator reopened) may mark the item completed.
    // A journal written before this field existed stays trusted (`!== false`) so
    // an upgrade never re-dispatches every historical item.
    const verified = latest.workVerified !== false
    const reopened = typeof latest.reopenedAt === 'number' && Number.isFinite(latest.reopenedAt)
    if (latest.status === 'done' && verified && !reopened && fingerprint !== null && fingerprint === item.fingerprint) {
      return { ready: false, reason: WORK_READINESS_REASONS.completed, attempts: mine.length }
    }
  }
  // ONE work item per project at a time: a synthetic dispatch forces
  // `isolation:'none'` in the project's shared working tree, so two of them would
  // race on the same files (and on `.git/index.lock`). A Task Board card owns its
  // isolation contract, so an assignment without `workSource` never blocks here.
  // The check sits after the completed verdict and before the retry rules: a
  // completed item keeps `work_item_completed`, and a retry is reported again
  // once the contending item of the project has ended.
  const contender = (Array.isArray(assignments) ? assignments : []).find(assignment => isRecord(assignment)
    && String(assignment.taskId ?? '') !== item.id
    && String(assignment.workspaceId) === String(item.projectId)
    && ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)
    && assignment.workSource !== null && assignment.workSource !== undefined)
  if (contender !== undefined) {
    return { ready: false, reason: WORK_READINESS_REASONS.projectBusy, attempts: mine.length }
  }
  if (latest !== null) {
    if (FAILED_ASSIGNMENT_STATUSES.includes(latest.status)) {
      if (mine.length >= WORK_ATTEMPT_LIMIT) return { ready: false, reason: WORK_READINESS_REASONS.attemptsExhausted, attempts: mine.length }
      if (now - at < WORK_RETRY_DELAY_MS) return { ready: false, reason: WORK_READINESS_REASONS.retryWait, attempts: mine.length }
    }
  }
  return { ready: true, reason: WORK_READINESS_REASONS.ready, attempts: mine.length }
}

/**
 * The message a worker session receives for one work item. It carries the
 * project's own documents as context (never as instructions that widen rights)
 * and asks for a verifiable, bounded change.
 *
 * @param {object} item
 * @param {{directives?: string[], projectTitle?: string, projectId?: string}} [options]
 * @returns {string}
 */
export function workPromptOf(item, { directives = [], projectTitle = '', projectId = '', permission = null } = {}) {
  const blocks = [
    'The Agent Board dispatches this work item because NO Task Board card is available for it: the project itself declares it.',
    '',
    '<work-item>',
    `id: ${item.id}`,
    `project: ${projectId || item.projectId || ''}${projectTitle ? ` (${projectTitle})` : ''}`,
    `source: ${item.source}`,
    `reference: ${item.ref}`,
    `title: ${item.title}`,
    ...(typeof item.description === 'string' && item.description !== '' ? ['', item.description] : []),
    '</work-item>',
    '',
  ]
  if (directives.length > 0) {
    blocks.push('OPERATOR DIRECTIVES (constraints, most restrictive first):')
    for (const directive of directives) blocks.push(`- ${directive}`)
    blocks.push('')
  }
  if (permission === 'read-only') {
    blocks.push('APPLIED PERMISSION: read-only. You cannot modify files: produce an exact, verifiable change plan (files, edits, tests) and report it. Never claim the work is done.')
    blocks.push('')
  }
  blocks.push(
    'Rules:',
    "1. Read the project's own directives first: AGENTS.md/README, accepted ADRs (docs/adr), and the section referenced above.",
    '2. Do the smallest complete increment that satisfies the item. Never invent scope and never start unrelated work.',
    '3. Work only inside this project directory. Verification is part of the work: run the relevant checks.',
    '4. Commit your changes on the current branch (do not push, do not open a pull request).',
    '5. If the item is a checklist entry and you complete it, tick it (`- [ ]` -> `- [x]`) in the same document and commit that too.',
    '6. Then report, in this session: what changed, how you verified it, the commit id, and anything still blocking.',
    '7. If the item actually needs a human decision (ambiguous intent, a Proposed ADR, a product choice), STOP and say precisely which decision is needed. Do not guess.',
  )
  return blocks.join('\n')
}
