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

/**
 * Stable id of one work item: derived from the project, the source and the
 * normalized title. A document edit that keeps the title therefore keeps the
 * identity (and the dispatch journal keeps applying); a real change of intent
 * creates a new item.
 *
 * @param {{projectId?: string, source?: string, title?: string}} input
 * @returns {string}
 */
export function workItemIdOf({ projectId, source, title } = {}) {
  const text = `${String(projectId ?? '')}\u0000${String(source ?? '')}\u0000${normalizeForCompare(title)}`
  return `work-${hashText(text)}`
}

/** Content fingerprint of an item, used to detect a real intent change. */
export function workItemFingerprintOf({ projectId, source, title } = {}) {
  return `wf-${hashText(`${String(projectId ?? '')}\u0000${String(source ?? '')}\u0000${normalizeForCompare(title)}`)}`
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

function buildItem({ projectId, source, path, line, heading, title, needsHumanDecision, decisionReason, context }) {
  const normalized = normalizeWorkTitle(title)
  if (normalized === '') return null
  const id = workItemIdOf({ projectId, source, title: normalized })
  const where = `${path}:${line}`
  const parts = [`Source : ${where}`]
  if (typeof context === 'string' && context !== '') parts.push(context)
  if (typeof heading === 'string' && heading !== '') parts.push(`Section : ${heading}`)
  return {
    id,
    projectId,
    source,
    ref: where,
    title: normalized,
    description: parts.join('\n'),
    fingerprint: workItemFingerprintOf({ projectId, source, title: normalized }),
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
  const id = workItemIdOf({ projectId: project, source: 'issue', title })
  return {
    id,
    projectId: project,
    source: 'issue',
    ref: `#${issue.number}`,
    title,
    description: [
      `Issue #${issue.number}: ${title}`,
      ...(typeof issue.body === 'string' && issue.body.trim() !== '' ? [issue.body.trim().slice(0, 600)] : []),
    ].join('\n'),
    fingerprint: workItemFingerprintOf({ projectId: project, source: 'issue', title }),
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
  const mine = (Array.isArray(assignments) ? assignments : [])
    .filter(assignment => isRecord(assignment) && String(assignment.taskId ?? '') === item.id)
  if (mine.some(assignment => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status))) {
    return { ready: false, reason: WORK_READINESS_REASONS.inProgress, attempts: mine.length }
  }
  const ended = mine
    .filter(assignment => Number.isFinite(Number(assignment.endedAt ?? assignment.startedAt)))
    .sort((left, right) => (Number(right.endedAt ?? right.startedAt) || 0) - (Number(left.endedAt ?? left.startedAt) || 0))
  const latest = ended[0] ?? null
  if (latest !== null) {
    const at = Number(latest.endedAt ?? latest.startedAt) || 0
    const fingerprint = typeof latest.workSource?.fingerprint === 'string' ? latest.workSource.fingerprint : null
    if (latest.status === 'done' && fingerprint === item.fingerprint) {
      return { ready: false, reason: WORK_READINESS_REASONS.completed, attempts: mine.length }
    }
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
