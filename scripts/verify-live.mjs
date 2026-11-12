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
import { join } from 'node:path'
import { createGithubAdapter } from '../src/connectors/github.js'
import { capabilitiesOf, createPublicTaskBoardClient, describePublicTaskBoard } from '../src/connectors/taskboard-public.js'

const token = process.env.DSH_TASKBOARD_PUBLIC_TOKEN ?? ''
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
  report.next.push('Task Board public API: set DSH_TASKBOARD_PUBLIC_TOKEN (User variable), restart DSH, then re-run this script. Until then the installed instance answers 503 public_api_disabled and live writes stay unvalidated.')
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

console.log(JSON.stringify(report, null, 2))
process.exit(anyError ? 2 : 0)
