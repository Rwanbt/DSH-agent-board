/**
 * Minimal, explicitly-unvalidated GitHub forge adapter.
 *
 * Scope: READ issues (with pull requests distinguished) and the combined CI
 * status of a pull request head. It is disabled unless a repository is
 * configured, and it reports `validatedLive: false` until an operator runs it
 * against a real repository with a token. Nothing here creates, comments on,
 * labels or transitions a remote object.
 *
 * @module dsh-agent-board/connectors/github
 */

import { AdapterError, defineAdapter } from '../contracts/adapters.js'

const API = 'https://api.github.com'

/**
 * @param {object} options
 * @param {string} [options.repository]  "owner/name"
 * @param {string} [options.token]       defaults to process.env.GITHUB_TOKEN
 * @param {Function} [options.fetchImpl]
 */
export function createGithubAdapter({ repository, token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch }) {
  const enabled = typeof repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repository)

  async function api(path) {
    if (!enabled) {
      throw new AdapterError('github: no repository configured', { code: 'not_configured', adapterId: 'github' })
    }
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-agent-board' }
    if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(`${API}${path}`, { headers })
    if (response.status === 401 || response.status === 403) {
      throw new AdapterError(`github: credentials rejected (HTTP ${response.status})`, {
        code: 'credentials_rejected', adapterId: 'github',
      })
    }
    if (!response.ok) {
      throw new AdapterError(`github: HTTP ${response.status}`, { code: `http_${response.status}`, retryable: response.status >= 500, adapterId: 'github' })
    }
    return response.json()
  }

  return defineAdapter({
    id: 'github',
    kind: 'forge',
    title: 'GitHub',
    capabilities: ['list', 'get'],
    status: enabled ? 'available' : 'disabled',
    validatedLive: false,
    notes: enabled
      ? 'Read-only issues/PRs + combined CI status. Not validated against a live repository yet.'
      : 'Disabled until a repository is configured.',
    async list() {
      const issues = await api(`/repos/${repository}/issues?state=open&per_page=50`)
      return {
        items: (Array.isArray(issues) ? issues : []).map(issue => ({
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
        })),
        meta: { repository, validatedLive: false },
      }
    },
    async get(id) {
      const issue = await api(`/repos/${repository}/issues/${encodeURIComponent(String(id))}`)
      return {
        id: String(issue.number),
        system: 'github',
        externalId: String(issue.number),
        canonicalId: `github:${issue.number}`,
        title: String(issue.title ?? ''),
        kind: issue.pull_request === undefined ? 'issue' : 'pull_request',
        state: String(issue.state ?? 'open'),
        url: issue.html_url ?? null,
        revision: issue.updated_at ?? null,
        raw: undefined,
      }
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
          ? 'Read-only. CI status not wired in this build; integration not validated live.'
          : 'Disabled until a repository is configured.',
        repository: enabled ? repository : null,
      }
    },
  })
}
