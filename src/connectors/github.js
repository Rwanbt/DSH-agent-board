/**
 * Minimal, explicitly-unvalidated GitHub forge adapter.
 *
 * Scope: READ issues (with pull requests distinguished), bounded pagination and
 * rate-limit classification. It is disabled unless a repository is configured,
 * and it reports `validatedLive: false` until an operator runs it against a real
 * repository with a token. Nothing here creates, comments on, labels or
 * transitions a remote object, and the token never appears in an error message.
 *
 * @module dsh-agent-board/connectors/github
 */

import { AdapterError, defineAdapter } from '../contracts/adapters.js'

const API = 'https://api.github.com'
const MAX_PAGES = 3
const PER_PAGE = 50

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
 * @param {object} options
 * @param {string} [options.repository]  "owner/name"
 * @param {string} [options.token]       defaults to process.env.GITHUB_TOKEN
 * @param {Function} [options.fetchImpl]
 */
export function createGithubAdapter({ repository, token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch }) {
  const enabled = typeof repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repository)

  function headerOf(response, name) {
    try {
      return response?.headers?.get?.(name) ?? null
    } catch {
      return null
    }
  }

  async function request(url) {
    if (!enabled) {
      throw new AdapterError('github: no repository configured', { code: 'not_configured', adapterId: 'github' })
    }
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-agent-board' }
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
    let response
    try {
      response = await fetchImpl(url, { headers })
    } catch (error) {
      throw new AdapterError('github: network error', { code: 'transport', retryable: true, adapterId: 'github', cause: error })
    }
    const remainingRaw = headerOf(response, 'x-ratelimit-remaining')
    const remaining = remainingRaw === null || remainingRaw === '' ? null : Number(remainingRaw)
    const resetSeconds = Number(headerOf(response, 'x-ratelimit-reset'))
    if (response.status === 429 || (response.status === 403 && remaining === 0)) {
      // GitHub signals exhaustion with 403 + x-ratelimit-remaining: 0 (and 429
      // for secondary limits). A 403 WITHOUT that header (SSO, IP allow-list,
      // stripped proxy) is a credential/permission refusal, not a quota.
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
      throw new AdapterError(`github: HTTP ${response.status}`, { code: `http_${response.status}`, retryable: response.status >= 500, adapterId: 'github' })
    }
    return { body: await response.json(), next: nextLinkOf(headerOf(response, 'link')) }
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
      // The forge revision: usable as a conflict token for a future write path.
      revision: issue.updated_at ?? null,
      raw: undefined,
    }
  }

  return defineAdapter({
    id: 'github',
    kind: 'forge',
    title: 'GitHub',
    capabilities: ['list', 'get'],
    status: enabled ? 'available' : 'disabled',
    validatedLive: false,
    notes: enabled
      ? 'Read-only issues/PRs. Bounded pagination and rate-limit classification; not validated against a live repository.'
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
    describe() {
      return {
        id: 'github',
        kind: 'forge',
        title: 'GitHub',
        status: enabled ? 'available' : 'disabled',
        validatedLive: false,
        capabilities: { list: true, get: true, subscribe: false, create: false, update: false, comment: false, transition: false },
        notes: enabled
          ? 'Read-only. Bounded pagination + rate-limit retry hint. Integration not validated live.'
          : 'Disabled until a repository is configured.',
        repository: enabled ? repository : null,
      }
    },
  })
}
