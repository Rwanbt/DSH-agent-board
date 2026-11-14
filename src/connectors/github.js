/**
 * GitHub forge adapter.
 *
 * READ path (always available when a repository is configured): issues and pull
 * requests with bounded pagination and rate-limit classification.
 *
 * WRITE path (opt-in, `allowWrites:true`): create issue, comment an issue, open a
 * pull request. Each write is idempotent through an embedded marker (the forge
 * has no idempotency key), audited by the host, and gated by the operator
 * mandate BEFORE it reaches this module. This adapter deliberately exposes NO
 * merge, no protected-branch push and no issue deletion: those are separate,
 * critical actions that this build does not implement.
 *
 * The token never appears in an error message, a returned value or a log line.
 *
 * @module dsh-agent-board/connectors/github
 */

import { AdapterError, defineAdapter } from '../contracts/adapters.js'

const API = 'https://api.github.com'
const MAX_PAGES = 3
const PER_PAGE = 50
const MAX_DEDUPE_ITEMS = 100
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,120}$/
const SAFE_REPO = /^[^/\s]+\/[^/\s]+$/
// Idempotency keys are namespaced by the host (`<projectId>:<callerKey>`), so the
// allowed set is deliberately narrow: no whitespace, no `<>`, no quotes.
const SAFE_KEY = /^[A-Za-z0-9._:/-]{1,200}$/

/** `Link: <...>; rel="next"` -> the next URL, or null. */
export function nextLinkOf(headerValue) {
  if (typeof headerValue !== 'string' || headerValue === '') return null
  for (const part of headerValue.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match !== null) return match[1]
  }
  return null
}

/**
 * The idempotency marker embedded in an issue/PR body or a comment. The key is
 * validated, so a hostile value cannot close the HTML comment and forge a second
 * marker (`k --> <b>` is refused, not escaped into an ambiguous document).
 */
export function markerOf(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !SAFE_KEY.test(idempotencyKey)) {
    throw new AdapterError('github: invalid idempotencyKey', { code: 'invalid_input', adapterId: 'github' })
  }
  return `<!-- agent-board:id:${idempotencyKey} -->`
}

/**
 * @param {object} options
 * @param {string} [options.repository]  "owner/name"
 * @param {string} [options.token]       defaults to process.env.GITHUB_TOKEN
 * @param {Function} [options.fetchImpl]
 * @param {boolean} [options.allowWrites] explicit opt-in; default false
 */
export function createGithubAdapter({ repository, token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch, allowWrites = false } = {}) {
  const enabled = typeof repository === 'string' && SAFE_REPO.test(repository)
  const writesEnabled = enabled && allowWrites === true
  const owner = enabled ? String(repository).split('/')[0] : null
  // The forge list endpoints are eventually consistent: an immediate retry can
  // miss a just-created marker. The in-process cache makes same-run retries
  // exact, and `inFlight` makes CONCURRENT retries share one request. The
  // embedded marker still protects a retry after a restart.
  const idempotency = { issues: new Map(), comments: new Map(), pulls: new Map(), inFlight: new Map() }

  /**
   * Run `factory` exactly once per key, even if several callers await it
   * concurrently. A rejection is shared too (the retry policy is the caller's).
   */
  async function once(key, factory) {
    const running = idempotency.inFlight.get(key)
    if (running !== undefined) {
      // A concurrent caller shares the leader's request but reports the retry
      // semantics ("not created by me").
      const shared = await running
      return { ...shared, created: false, idempotent: true }
    }
    const promise = Promise.resolve().then(factory).finally(() => {
      idempotency.inFlight.delete(key)
    })
    idempotency.inFlight.set(key, promise)
    return promise
  }

  function headerOf(response, name) {
    try {
      return response?.headers?.get?.(name) ?? null
    } catch {
      return null
    }
  }

  async function request(url, { method = 'GET', body = undefined } = {}) {
    if (!enabled) {
      throw new AdapterError('github: no repository configured', { code: 'not_configured', adapterId: 'github' })
    }
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-agent-board' }
    if (method !== 'GET') headers['content-type'] = 'application/json'
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
    let response
    try {
      response = await fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (error) {
      throw new AdapterError('github: network error', { code: 'transport', retryable: true, adapterId: 'github', cause: error })
    }
    const remainingRaw = headerOf(response, 'x-ratelimit-remaining')
    const remaining = remainingRaw === null || remainingRaw === '' ? null : Number(remainingRaw)
    const resetSeconds = Number(headerOf(response, 'x-ratelimit-reset'))
    if (response.status === 429 || (response.status === 403 && remaining === 0)) {
      const retryAfterMs = Number.isFinite(resetSeconds) && resetSeconds > 0 ? Math.max(0, resetSeconds * 1000 - Date.now()) : null
      throw new AdapterError('github: rate limit exhausted', {
        code: 'rate_limited', retryable: true, adapterId: 'github', retryAfterMs,
      })
    }
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError(`github: credentials rejected (HTTP ${response.status})`, {
        code: 'credentials_rejected', adapterId: 'github',
      })
    }
    if (!response.ok) {
      // The forge's own message is NOT relayed: it can contain URLs or hints.
      throw new AdapterError(`github: HTTP ${response.status}`, { code: `http_${response.status}`, retryable: response.status >= 500, adapterId: 'github' })
    }
    const parsed = await response.json().catch(() => null)
    return { body: parsed, next: nextLinkOf(headerOf(response, 'link')) }
  }

  function requireWrites(operation) {
    if (!writesEnabled) {
      throw new AdapterError(`github: ${operation} is disabled`, { code: 'writes_disabled', adapterId: 'github' })
    }
  }

  function normalizeIssue(issue) {
    return {
      id: String(issue.number),
      system: 'github',
      externalId: String(issue.number),
      canonicalId: `github:${issue.number}`,
      title: String(issue.title ?? ''),
      kind: issue.pull_request === undefined ? 'issue' : 'pull_request',
      state: String(issue.state ?? 'open'),
      url: issue.html_url ?? null,
      labels: Array.isArray(issue.labels) ? issue.labels.map(label => String(label.name ?? '')) : [],
      revision: issue.updated_at ?? null,
      raw: undefined,
    }
  }

  function normalizePull(pull) {
    return {
      id: String(pull.number),
      system: 'github',
      externalId: String(pull.number),
      canonicalId: `github:${pull.number}`,
      kind: 'pull_request',
      state: String(pull.state ?? 'open'),
      url: pull.html_url ?? null,
      head: pull.head?.ref ?? null,
      base: pull.base?.ref ?? null,
      title: String(pull.title ?? ''),
      revision: pull.updated_at ?? null,
      raw: undefined,
    }
  }

  /** Bounded search for an existing object carrying the marker (idempotence). */
  async function findIssueByMarker(marker) {
    const { body } = await request(`${API}/repos/${repository}/issues?state=all&per_page=${MAX_DEDUPE_ITEMS}`)
    const list = Array.isArray(body) ? body : []
    const found = list.find(entry => typeof entry?.body === 'string' && entry.body.includes(marker))
    if (found !== undefined) return found
    // The list is bounded to one page and eventually consistent. After a restart
    // (empty in-process cache) the marker may be older than that page, so one
    // bounded search request is the fallback. A failure here returns null (the
    // caller may then create; the marker is still the durable protection).
    try {
      const query = encodeURIComponent(`repo:${repository} in:body "${marker}"`)
      const { body: searched } = await request(`${API}/search/issues?q=${query}&per_page=10`)
      const items = Array.isArray(searched?.items) ? searched.items : []
      return items.find(entry => typeof entry?.body === 'string' && entry.body.includes(marker)) ?? null
    } catch {
      return null
    }
  }

  async function findCommentByMarker(number, marker) {
    const { body } = await request(`${API}/repos/${repository}/issues/${encodeURIComponent(String(number))}/comments?per_page=${MAX_DEDUPE_ITEMS}`)
    const list = Array.isArray(body) ? body : []
    return list.find(entry => typeof entry?.body === 'string' && entry.body.includes(marker)) ?? null
  }

  async function findOpenPull(head) {
    const { body } = await request(`${API}/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`)
    const list = Array.isArray(body) ? body : []
    return list[0] ?? null
  }

  // ---------------------------------------------------------------- writes
  // Each write is executed at most once per idempotency key, even under
  // concurrent calls, and its result is cached for the process lifetime.

  async function createIssueOnce({ title, body = '', labels = [] }, idempotencyKey) {
    const marker = markerOf(idempotencyKey)
    const cached = idempotency.issues.get(idempotencyKey)
    if (cached !== undefined) return { issue: cached, created: false, idempotent: true }
    const existing = await findIssueByMarker(marker)
    if (existing !== null) {
      const issue = normalizeIssue(existing)
      idempotency.issues.set(idempotencyKey, issue)
      return { issue, created: false, idempotent: true }
    }
    const payload = { title: String(title).slice(0, 240), body: `${String(body).slice(0, 60_000)}\n\n${marker}`.trim() }
    if (Array.isArray(labels) && labels.length > 0) payload.labels = labels.filter(label => typeof label === 'string').slice(0, 10)
    const { body: created } = await request(`${API}/repos/${repository}/issues`, { method: 'POST', body: payload })
    const issue = normalizeIssue(created)
    idempotency.issues.set(idempotencyKey, issue)
    return { issue, created: true, idempotent: false }
  }

  async function commentIssueOnce(number, body, idempotencyKey) {
    const marker = markerOf(idempotencyKey)
    const cacheKey = `${number}:${idempotencyKey}`
    const cached = idempotency.comments.get(cacheKey)
    if (cached !== undefined) return { comment: cached, created: false, idempotent: true }
    const existing = await findCommentByMarker(number, marker)
    if (existing !== null) {
      const comment = { id: String(existing.id), url: existing.html_url ?? null }
      idempotency.comments.set(cacheKey, comment)
      return { comment, created: false, idempotent: true }
    }
    const { body: created } = await request(`${API}/repos/${repository}/issues/${encodeURIComponent(String(number))}/comments`, {
      method: 'POST',
      body: { body: `${String(body).slice(0, 60_000)}\n\n${marker}`.trim() },
    })
    const comment = { id: String(created?.id ?? ''), url: created?.html_url ?? null }
    idempotency.comments.set(cacheKey, comment)
    return { comment, created: true, idempotent: false }
  }

  async function openPullOnce({ title, body = '', head, base }, idempotencyKey, beforeWrite) {
    const marker = markerOf(idempotencyKey)
    const cached = idempotency.pulls.get(head)
    if (cached !== undefined) return { pull: cached, created: false, idempotent: true }
    const existing = await findOpenPull(head)
    if (existing !== null) {
      const pull = normalizePull(existing)
      idempotency.pulls.set(head, pull)
      return { pull, created: false, idempotent: true }
    }
    // Lookup awaited external I/O: Stop/revocation must still win immediately
    // before the first effect. The host supplies a synchronous deterministic gate.
    beforeWrite?.()
    const { body: created } = await request(`${API}/repos/${repository}/pulls`, {
      method: 'POST',
      body: { title: String(title ?? '').slice(0, 240), head, base, body: `${String(body).slice(0, 60_000)}\n\n${marker}`.trim() },
    })
    const pull = normalizePull(created)
    idempotency.pulls.set(head, pull)
    return { pull, created: true, idempotent: false }
  }

  return defineAdapter({
    id: 'github',
    kind: 'forge',
    title: 'GitHub',
    capabilities: ['list', 'get', 'checks', ...(writesEnabled ? ['create', 'comment', 'open_pr'] : [])],
    status: enabled ? 'available' : 'disabled',
    validatedLive: false,
    notes: enabled
      ? (writesEnabled
        ? 'Issues/PRs read, checks read, and opt-in writes (create issue, comment, open PR) with embedded idempotency markers. No merge, no protected-branch push, no deletion.'
        : 'Read-only issues/PRs/checks. Writes are disabled until explicitly enabled and mandated.')
      : 'Disabled until a repository is configured.',
    async list() {
      const items = []
      let url = `${API}/repos/${repository}/issues?state=open&per_page=${PER_PAGE}`
      let pages = 0
      while (url !== null && pages < MAX_PAGES) {
        const { body, next } = await request(url)
        pages += 1
        for (const issue of Array.isArray(body) ? body : []) items.push(normalizeIssue(issue))
        url = next
      }
      return { items, meta: { repository, validatedLive: false, pages, truncated: url !== null } }
    },
    async get(id) {
      const { body } = await request(`${API}/repos/${repository}/issues/${encodeURIComponent(String(id))}`)
      return normalizeIssue(body)
    },
    /** CI/checks for a ref (branch, tag or SHA). Read-only. */
    async checks(ref) {
      const safeRef = typeof ref === 'string' && SAFE_BRANCH.test(ref) ? ref : null
      if (safeRef === null) throw new AdapterError('github: invalid ref', { code: 'invalid_input', adapterId: 'github' })
      const { body } = await request(`${API}/repos/${repository}/commits/${encodeURIComponent(safeRef)}/check-runs`)
      const runs = Array.isArray(body?.check_runs) ? body.check_runs : []
      return {
        ref: safeRef,
        total: runs.length,
        runs: runs.slice(0, 50).map(run => ({
          name: String(run.name ?? ''),
          status: String(run.status ?? 'unknown'),
          conclusion: run.conclusion === undefined ? null : run.conclusion,
          url: run.html_url ?? null,
        })),
      }
    },
    /**
     * Open issues of the configured repository (bounded, read-only). This is the
     * "issues" work source of the Super Agent: it feeds project work items when
     * the Task Board is not installed. A failure is returned, never thrown, so a
     * discovery error cannot break an autonomy cycle.
     */
    async listIssues({ limit = 20 } = {}) {
      if (!enabled) return { ok: false, reason: 'not_configured', issues: [] }
      const perPage = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)))
      try {
        const { body } = await request(`${API}/repos/${repository}/issues?state=open&sort=updated&direction=desc&per_page=${perPage}`)
        const list = Array.isArray(body) ? body : []
        return {
          ok: true,
          issues: list
            .filter(entry => entry !== null && typeof entry === 'object' && entry.pull_request === undefined)
            .slice(0, perPage)
            .map(entry => ({
              number: Number(entry.number),
              title: String(entry.title ?? ''),
              body: typeof entry.body === 'string' ? entry.body.slice(0, 1200) : '',
              labels: Array.isArray(entry.labels) ? entry.labels.map(label => String(label?.name ?? '')).filter(Boolean) : [],
              assignees: Array.isArray(entry.assignees) ? entry.assignees.map(assignee => String(assignee?.login ?? '')).filter(Boolean) : [],
              updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
            })),
        }
      } catch (error) {
        return { ok: false, reason: typeof error?.code === 'string' ? error.code : 'transport', issues: [] }
      }
    },
    /**
     * Create an issue. `idempotencyKey` is required and embedded as a marker: a
     * retry returns the SAME issue instead of opening a duplicate.
     */
    async createIssue(payload = {}, { idempotencyKey } = {}) {
      requireWrites('createIssue')
      if (typeof payload?.title !== 'string' || payload.title.trim() === '') throw new AdapterError('github: title is required', { code: 'invalid_input', adapterId: 'github' })
      if (typeof idempotencyKey !== 'string' || idempotencyKey === '') throw new AdapterError('github: idempotencyKey is required', { code: 'invalid_input', adapterId: 'github' })
      markerOf(idempotencyKey) // validates the key before any request
      return once(`issue:${idempotencyKey}`, () => createIssueOnce(payload, idempotencyKey))
    },
    /** Comment an issue/PR. Idempotent through the same marker mechanism. */
    async commentIssue(number, body = '', { idempotencyKey } = {}) {
      requireWrites('commentIssue')
      if (typeof idempotencyKey !== 'string' || idempotencyKey === '') throw new AdapterError('github: idempotencyKey is required', { code: 'invalid_input', adapterId: 'github' })
      markerOf(idempotencyKey)
      return once(`comment:${number}:${idempotencyKey}`, () => commentIssueOnce(number, body, idempotencyKey))
    },
    /**
     * Open a pull request. Never merges. A retry for the same head branch
     * returns the already-open pull request instead of creating a second one.
     */
    async openPullRequest(payload = {}, { idempotencyKey, beforeWrite } = {}) {
      requireWrites('openPullRequest')
      if (typeof idempotencyKey !== 'string' || idempotencyKey === '') throw new AdapterError('github: idempotencyKey is required', { code: 'invalid_input', adapterId: 'github' })
      const head = payload?.head
      const base = payload?.base
      if (typeof head !== 'string' || !SAFE_BRANCH.test(head)) throw new AdapterError('github: invalid head branch', { code: 'invalid_input', adapterId: 'github' })
      if (typeof base !== 'string' || !SAFE_BRANCH.test(base)) throw new AdapterError('github: invalid base branch', { code: 'invalid_input', adapterId: 'github' })
      markerOf(idempotencyKey)
      // One open PR per head branch: the in-flight key is the branch, so two
      // concurrent callers cannot both pass the open-PR lookup.
      return once(`pull:${head}`, () => openPullOnce(payload, idempotencyKey, beforeWrite))
    },
    // Contract-named aliases: `defineAdapter` validates a declared capability
    // against a method of the same name. They delegate to the explicit methods.
    async create(payload, options) { return this.createIssue(payload, options) },
    async comment(number, body, options) { return this.commentIssue(number, body, options) },
    async open_pr(payload, options) { return this.openPullRequest(payload, options) },
    describe() {
      return {
        id: 'github',
        kind: 'forge',
        title: 'GitHub',
        status: enabled ? 'available' : 'disabled',
        validatedLive: false,
        repository: enabled ? repository : null,
        writeEnabled: writesEnabled,
        capabilities: {
          list: enabled, get: enabled, checks: enabled, subscribe: false,
          listIssues: enabled,
          create: writesEnabled, update: false, comment: writesEnabled, open_pr: writesEnabled,
          // Never implemented on purpose: a merge is a critical human decision.
          merge: false, push_protected: false, delete: false,
        },
        notes: enabled
          ? (writesEnabled
            ? 'Read + opt-in writes (create issue, comment, open PR) with embedded idempotency. No merge/push-protected/delete.'
            : 'Read-only. Writes disabled (allowWrites:false).')
          : 'Disabled until a repository is configured.',
      }
    },
  })
}
