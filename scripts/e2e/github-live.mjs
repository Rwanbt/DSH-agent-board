#!/usr/bin/env node
/**
 * GOAL 6 — LIVE GitHub validation of the Agent Board forge adapter.
 *
 * This script exercises the PRODUCT adapter (`src/connectors/github.js`) against
 * a real repository with a real token. It creates:
 *   1. an issue (then repeats the call with the same idempotency key),
 *   2. a comment on that issue (then repeats it),
 *   3. a branch + one commit (setup through the GitHub git/contents API),
 *   4. a pull request through the adapter (then repeats it),
 *   5. a checks read for the branch head.
 *
 * The token is read from GITHUB_TOKEN and NEVER printed, echoed or written to the
 * evidence file. The repository, scope and cleanup are the operator's business:
 * this script does not delete anything.
 *
 * Usage:
 *   $env:GITHUB_TOKEN = (gh auth token)   # or any token with repo scope
 *   $env:GITHUB_REPOSITORY = 'owner/name'
 *   node scripts/e2e/github-live.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGithubAdapter } from '../../src/connectors/github.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const EVIDENCE = join(REPO_ROOT, 'docs', 'e2e', 'GITHUB-LIVE-E2E.json')

const token = process.env.GITHUB_TOKEN ?? ''
const repository = process.env.GITHUB_REPOSITORY ?? ''
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const branch = `e2e/agent-board-${stamp}`
const issueKey = `live-issue-${stamp}`
const commentKey = `live-comment-${stamp}`
const prKey = `live-pr-${stamp}`

function fail(message) {
  console.error(`[github-live] ${message}`)
  process.exit(2)
}

if (token === '') fail('GITHUB_TOKEN is required (never printed)')
if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) fail('GITHUB_REPOSITORY must be owner/name')

const API = 'https://api.github.com'
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dsh-agent-board-live-e2e',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    // The body may contain URLs; report only the status and the GitHub code.
    const payload = await response.json().catch(() => null)
    throw new Error(`github API ${method} ${path} -> HTTP ${response.status} ${payload?.message ?? ''}`.trim())
  }
  return response.json()
}

const evidence = {
  startedAt: new Date().toISOString(),
  repository,
  adapterValidatedLive: false,
  assertions: [],
  observed: {},
}

function check(name, ok, detail = '') {
  evidence.assertions.push({ name, ok: ok === true, detail })
  console.log(`[github-live] ${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  return ok === true
}

const adapter = createGithubAdapter({ repository, token, allowWrites: true })

try {
  // 0. adapter honesty
  const described = adapter.describe()
  check('0. adapter reports a real repository with writes enabled', described.status === 'available' && described.writeEnabled === true, JSON.stringify({ status: described.status, writeEnabled: described.writeEnabled }))
  check('0b. adapter never claims merge/push-protected', described.capabilities.merge === false && described.capabilities.push_protected === false)

  // 1. issue + idempotency
  const created = await adapter.createIssue(
    { title: `[E2E] Agent Board live issue ${stamp}`, body: `Created by the Agent Board GOAL 6 live validation.\n\nRepository: ${repository}\nBranch: ${branch}` },
    { idempotencyKey: issueKey },
  )
  evidence.observed.issue = { number: created.issue.id, url: created.issue.url, created: created.created }
  check('1. a real issue was created', created.created === true && created.issue.url !== null, `#${created.issue.id}`)
  const duplicate = await adapter.createIssue(
    { title: `[E2E] Agent Board live issue ${stamp}`, body: 'retry' },
    { idempotencyKey: issueKey },
  )
  evidence.observed.issueDuplicate = { number: duplicate.issue.id, created: duplicate.created, idempotent: duplicate.idempotent }
  check('2. re-creating with the same idempotency key returns the SAME issue', duplicate.created === false && duplicate.issue.id === created.issue.id)

  // 2. comment + idempotency
  const comment = await adapter.commentIssue(created.issue.id, 'Commentaire de validation live (Agent Board).', { idempotencyKey: commentKey })
  evidence.observed.comment = { id: comment.comment.id, created: comment.created }
  check('3. a real comment was created on that issue', comment.created === true && comment.comment.id !== '')
  const duplicateComment = await adapter.commentIssue(created.issue.id, 'retry', { idempotencyKey: commentKey })
  check('4. the same comment key does not duplicate the comment', duplicateComment.created === false && duplicateComment.comment.id === comment.comment.id)

  // 3. branch + commit (setup through the native API, not the adapter)
  const repoInfo = await api(`/repos/${repository}`)
  const base = repoInfo.default_branch
  const baseRef = await api(`/repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`)
  await api(`/repos/${repository}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: baseRef.object.sha } })
  const content = Buffer.from(`# Agent Board live E2E\n\nGenerated ${stamp} against ${repository}.\n`).toString('base64')
  await api(`/repos/${repository}/contents/e2e-${stamp}.md`, {
    method: 'PUT',
    body: { message: `test(e2e): agent board live validation ${stamp}`, content, branch },
  })
  // Verify the branch and the file really exist (no hardcoded assertion).
  const branchRef = await api(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`)
  const fileInfo = await api(`/repos/${repository}/contents/e2e-${stamp}.md?ref=${encodeURIComponent(branch)}`)
  evidence.observed.branch = { name: branch, base, headSha: branchRef.object?.sha ?? null, fileSha: fileInfo.sha ?? null }
  check('5. a disposable branch and its commit exist', typeof branchRef.object?.sha === 'string' && typeof fileInfo.sha === 'string', branch)

  // 4. pull request + idempotency
  const pr = await adapter.openPullRequest(
    { title: `[E2E] Agent Board live PR ${stamp}`, body: 'Opened by the Agent Board adapter. Never merged by the board.', head: branch, base },
    { idempotencyKey: prKey },
  )
  evidence.observed.pullRequest = { number: pr.pull.id, url: pr.pull.url, created: pr.created, head: pr.pull.head, base: pr.pull.base }
  check('6. a real pull request was opened', pr.created === true && pr.pull.url !== null, `#${pr.pull.id}`)
  const duplicatePr = await adapter.openPullRequest(
    { title: 'retry', body: 'retry', head: branch, base },
    { idempotencyKey: prKey },
  )
  check('7. the same head branch does not open a second PR', duplicatePr.created === false && duplicatePr.pull.id === pr.pull.id)

  // 5. checks read
  const checks = await adapter.checks(branch)
  evidence.observed.checks = { total: checks.total, ciConfigured: checks.total > 0, runs: checks.runs.slice(0, 5) }
  check('8. CI checks are readable for the branch head', typeof checks.total === 'number' && Array.isArray(checks.runs) && checks.total >= 0, `total=${checks.total} (ciConfigured=${checks.total > 0})`)

  // 6. no merge capability at all
  check('9. the adapter exposes no merge method', typeof adapter.merge === 'undefined')

  evidence.cleanup = {
    note: 'This script never deletes anything. Close the objects and delete the disposable repository manually.',
    commands: [
      `gh pr close <pr-number> -R ${repository} --delete-branch`,
      `gh issue close <issue-number> -R ${repository}`,
      `gh repo delete ${repository} --yes   # requires: gh auth refresh -h github.com -s delete_repo`,
    ],
  }

  evidence.finishedAt = new Date().toISOString()
  evidence.ok = evidence.assertions.every(entry => entry.ok === true)
  evidence.adapterValidatedLive = evidence.ok
  await mkdir(dirname(EVIDENCE), { recursive: true })
  await writeFile(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  console.log(`[github-live] evidence: ${EVIDENCE}`)
  console.log(`[github-live] ${evidence.ok ? 'ALL GREEN' : 'FAILED'}`)
  process.exit(evidence.ok ? 0 : 1)
} catch (error) {
  evidence.finishedAt = new Date().toISOString()
  evidence.ok = false
  evidence.error = String(error?.message ?? error).replaceAll(token, '[redacted]')
  await mkdir(dirname(EVIDENCE), { recursive: true }).catch(() => {})
  await writeFile(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch(() => {})
  console.error(`[github-live] ERROR ${evidence.error}`)
  process.exit(1)
}
