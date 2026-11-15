#!/usr/bin/env node
/**
 * GOAL 6 — one-command, READ-ONLY verifier for the two live integrations.
 *
 * It answers "what is configured, what did the real API say, and what is still
 * missing?" without ever printing a token and without writing anything.
 *
 *   $env:DSH_TASKBOARD_PUBLIC_TOKEN = '<token>'   # optional
 *   $env:DSH_TASKBOARD_PUBLIC_URL   = 'http://127.0.0.1:<port>/dsh-taskboard/public/v1'
 *   $env:GITHUB_TOKEN               = '<token>'   # optional
 *   $env:GITHUB_REPOSITORY          = 'owner/name'
 *   node scripts/verify-live.mjs
 *
 * Exit code: 0 when every CONFIGURED integration answered, 2 when one answered
 * with an error. Unconfigured integrations are reported honestly, not failed.
 *
 * @module dsh-agent-board/scripts/verify-live
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGithubAdapter } from '../src/connectors/github.js'
import { capabilitiesOf, createPublicTaskBoardClient, describePublicTaskBoard } from '../src/connectors/taskboard-public.js'

const token = (() => {
  if (process.env.DSH_TASKBOARD_PUBLIC_TOKEN) return process.env.DSH_TASKBOARD_PUBLIC_TOKEN
  try {
    const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
    return readFileSync(join(dshHome, 'taskboard', 'public-api.token'), 'utf8').trim()
  } catch { return '' }
})()
const baseUrl = process.env.DSH_TASKBOARD_PUBLIC_URL ?? ''
const githubToken = process.env.GITHUB_TOKEN ?? ''
const repository = process.env.GITHUB_REPOSITORY ?? ''
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

function stateSummaryOf(document) {
  if (document === null || typeof document !== 'object') return null
  const mandate = document.mandate
  return {
    schemaVersion: document.schemaVersion ?? null,
    mode: document.mode ?? null,
    scopeMode: mandate?.scopeMode ?? null,
    level: mandate?.level ?? null,
    requiresConfiguration: mandate?.requiresConfiguration ?? null,
    selectedProjects: Array.isArray(mandate?.selectedWorkspaces) ? mandate.selectedWorkspaces.length : 0,
    projectsConfigured: mandate?.projects !== null && typeof mandate?.projects === 'object' ? Object.keys(mandate.projects).length : 0,
    superagent: document.superagent === null || document.superagent === undefined ? null : { status: document.superagent.status ?? null, sessionActive: document.superagent.session?.active === true },
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  note: 'Read-only. Tokens are never read into the output; write paths are not exercised.',
  taskboardPublic: { configured: false },
  github: { configured: false },
  state: null,
  verdict: 'incomplete',
  next: [],
}

// ---------------------------------------------------------------- Task Board
const taskboardConfig = describePublicTaskBoard({ baseUrl, token })
report.taskboardPublic = { configured: taskboardConfig.configured, baseUrl: taskboardConfig.baseUrl ?? null, tokenPresent: taskboardConfig.tokenPresent }
if (taskboardConfig.configured) {
  const client = createPublicTaskBoardClient({ baseUrl, token })
  const meta = await client.meta()
  if (meta.ok !== true) {
    report.taskboardPublic.error = { code: meta.code ?? null, status: meta.status ?? null, message: meta.message ?? null }
    report.next.push('Task Board: the public API answered with an error. Check the token, the base URL, and that DSH was restarted after setting the variable.')
  } else {
    const capabilities = capabilitiesOf(meta)
    const tasks = await client.listTasks({ limit: 5 })
    report.taskboardPublic.apiVersion = meta.value?.apiVersion ?? null
    report.taskboardPublic.capabilities = Object.fromEntries(Object.entries(capabilities).map(([name, entry]) => [name, entry.state]))
    report.taskboardPublic.readWorks = tasks.ok === true
    report.taskboardPublic.sampleTasks = tasks.ok === true && Array.isArray(tasks.value?.tasks) ? tasks.value.tasks.length : null
    report.taskboardPublic.writeReady = capabilities.claim?.state === 'available'
  }
} else {
  report.next.push('Task Board public API: restart DSH with Task Board >= feat/local-public-token (it creates the local token itself), then re-run this script. Until then the installed instance answers 503 public_api_disabled and live writes stay unvalidated.')
}

// -------------------------------------------------------------------- GitHub
const github = createGithubAdapter({ repository, token: githubToken, allowWrites: false })
const described = github.describe()
report.github = { configured: described.status === 'available', repository: described.repository ?? null, writeEnabled: described.writeEnabled === true, capabilities: described.capabilities ?? null }
if (described.status === 'available') {
  const listed = await github.list()
  report.github.items = listed.items.length
  report.github.truncated = listed.meta.truncated
  report.github.validatedLive = true
  report.github.readOnlySession = true
} else {
  report.next.push('GitHub: set GITHUB_REPOSITORY=owner/name (and GITHUB_TOKEN for private repos) to check reads here. Writes are opt-in (`allowGithubWrites:true`) and are NOT exercised by this script.')
}

// --------------------------------------------------------------------- state
try {
  const raw = JSON.parse(await readFile(join(home, 'agent-board', 'state.json'), 'utf8'))
  report.state = { path: join(home, 'agent-board', 'state.json'), ...stateSummaryOf(raw) }
} catch {
  report.state = { path: join(home, 'agent-board', 'state.json'), missing: true }
}

// ------------------------------------------------------------------- verdict
const configured = []
if (report.taskboardPublic.configured) configured.push(report.taskboardPublic.error === undefined ? 'taskboard:ok' : 'taskboard:error')
if (report.github.configured) configured.push('github:ok')
const anyError = report.taskboardPublic.error !== undefined
report.verdict = anyError ? 'error' : configured.length === 0 ? 'incomplete' : configured.length === 2 ? 'complete' : 'partial'
if (report.state !== null && report.state.schemaVersion === 2) report.next.push('Board state is schemaVersion 2; configure the mandate in the cockpit (Projects tab) or POST /mandate before enabling any mode.')
if (report.github.writeEnabled !== true) report.next.push('GitHub writes remain disabled by design; enabling them requires allowGithubWrites:true plus the matching mandate action.')

// ------------------------------------------------- release checklist (Lot 9)
// The steps below need THIS operator's DSH instance, a real provider, or the real
// Task Board. The script PREPARES them (exact request, expected result) and
// reports them as `unverified`; it never runs them, so it can never claim a live
// green it did not observe.
const boardUrl = process.env.DSH_AGENT_BOARD_URL ?? 'http://127.0.0.1:<port>'
const releaseSteps = [
  { id: 'selftest', kind: 'read', method: 'GET', path: '/dsh-agent-board/api/v2/selftest', expect: 'value.checks all ok:true' },
  { id: 'selftest-deep', kind: 'write-disposable', method: 'POST', path: '/dsh-agent-board/api/v2/selftest', body: { deep: true, confirm: 'EPHEMERAL_SESSION' }, expect: 'one ephemeral session created then disposed' },
  { id: 'dry-run', kind: 'read', method: 'GET', path: '/dsh-agent-board/api/v2/dry-run', expect: 'writes: 0 and limits.effectiveConcurrent present' },
  { id: 'decisions-visible', kind: 'read', method: 'GET', path: '/dsh-agent-board/api/v2/state', expect: 'superagent.decisions.pending[] is non-empty after one cycle' },
  { id: 'decision-single-use', kind: 'write', method: 'POST', path: '/dsh-agent-board/api/v2/superagent/decisions/<id>/answer', body: { optionId: 'approve' }, expect: 'pending -1, exactly one effect, replay refused' },
  { id: 'max-tokens-continuation', kind: 'write', method: 'POST', path: '/dsh-agent-board/api/v2/tick', expect: 'assignment stays running with continuations +1, then failed after 3' },
  { id: 'card-review-once', kind: 'write', method: 'POST', path: '/dsh-agent-board/api/v2/dispatch', body: { taskId: '<card>' }, expect: 'card moves to in_review once, never done' },
  { id: 'stop-restart', kind: 'lifecycle', method: 'n/a', path: 'restart the host', expect: 'no assignment left running, inbox preserved' },
]
report.release = {
  baseUrl: boardUrl,
  status: 'unverified',
  note: 'Prepared by the script; executing them needs the operator instance and is never claimed here. See docs/RELEASE-CHECKLIST.md.',
  steps: releaseSteps.map(step => ({ ...step, executed: false })),
}

console.log(JSON.stringify(report, null, 2))
process.exit(anyError ? 2 : 0)

