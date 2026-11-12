#!/usr/bin/env node
/**
 * GOAL 6 payload benchmark: how much does the new `/state` content add?
 *
 * The projection benchmark measures the agent graph; this one measures the
 * ADDITIVE sections introduced by the Super Agent work (portfolio, mandate,
 * capabilities, superagent) for a large but plausible personal install:
 *   100 projects, 5 tasks each, 40 directives, 20 decisions, 30 activity rows.
 *
 * Output: a JSON summary on stdout. It is a SIZE measurement, not a latency one.
 *
 * @module dsh-agent-board/scripts/bench/payload-bench
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeMandate } from '../../src/contracts/mandate.js'
import { buildPortfolio, publicPortfolioOf } from '../../src/plan/portfolio.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', '..', 'docs', 'bench')
const OUT_NAME = process.argv.find(argument => argument.startsWith('--out='))?.split('=')[1] ?? 'payload-bench.json'
const NOW = 1_800_000_000_000
const argOf = name => {
  const hit = process.argv.find(argument => argument.startsWith(`--${name}=`))
  return hit === undefined ? null : Number(hit.split('=')[1])
}
const PROJECTS = Number.isFinite(argOf('projects')) ? argOf('projects') : 100
const TASKS_PER_PROJECT = Number.isFinite(argOf('tasks')) ? argOf('tasks') : 5

const workspaces = Array.from({ length: PROJECTS }, (_, index) => ({
  id: `ws-${String(index + 1).padStart(3, '0')}`,
  title: `Projet ${index + 1}`,
  path: `D:/projects/project-${index + 1}`,
}))

const tasks = []
for (const workspace of workspaces) {
  for (let index = 0; index < TASKS_PER_PROJECT; index += 1) {
    tasks.push({
      id: `${workspace.id}-t${index + 1}`,
      workspaceId: workspace.id,
      status: ['todo', 'in_progress', 'in_review', 'done', 'todo'][index],
      title: `Tâche ${index + 1} du ${workspace.title}`,
      urgency: ['urgent', 'normal', 'relaxed'][index % 3],
      dependsOn: index === 4 ? [`${workspace.id}-t1`] : [],
      version: 3,
    })
  }
}

const mandate = normalizeMandate({
  scopeMode: 'all',
  allConsent: { at: NOW, by: 'operator', text: 'ALL_PROJECTS' },
  level: 'L3',
  actions: { launch: true, comment: true, create_task: true, update_task: true, schedule: true, push_branch: true },
  projects: Object.fromEntries(workspaces.map(workspace => [workspace.id, {
    enabled: true,
    level: 'L3',
    priority: 5,
    model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
    budget: { maxTasksPerHour: 6 },
    note: '',
  }])),
  requiresConfiguration: false,
})

const portfolio = buildPortfolio({ workspaces, mandate, tasks, now: NOW })

// Representative capability matrix (same shape the host publishes).
const capabilities = Object.fromEntries([
  'delegate', 'launch', 'create_task', 'update_task', 'comment', 'open_pr', 'merge',
  'push_branch', 'delete_task', 'schedule',
].map(action => [action, { state: 'unavailable', reason: 'no_adapter_for_action', source: 'host' }]))
capabilities.observe = { state: 'available', reason: 'allowed', source: 'host' }
capabilities.analyse = { state: 'available', reason: 'allowed', source: 'host' }

const directives = Array.from({ length: 40 }, (_, index) => ({
  id: `dir-${index + 1}`,
  scope: index % 4 === 0 ? 'project' : 'global',
  projectId: index % 4 === 0 ? workspaces[index % PROJECTS].id : null,
  text: `Directive opérateur numéro ${index + 1} : rester dans le périmètre autorisé et documenter les preuves.`,
  author: 'operator',
  createdAt: NOW - index * 60_000,
  updatedAt: NOW - index * 60_000,
  version: 1,
  status: 'active',
  source: 'ui',
}))

const pending = Array.from({ length: 20 }, (_, index) => ({
  id: `dec-${index + 1}`,
  kind: index % 2 === 0 ? 'approval' : 'arbitration',
  projectId: workspaces[index % PROJECTS].id,
  title: `Décision structurée ${index + 1} avec un titre réaliste`,
  context: 'Contexte borné expliquant la proposition, la portée et le risque associé à la décision.',
  action: 'launch',
  taskIds: [tasks[index].id],
  options: [
    { id: 'approve', label: 'Approuver', effect: 'approve' },
    { id: 'reject', label: 'Refuser', effect: 'reject' },
  ],
  recommendation: 'Approuver',
  urgency: index % 5 === 0 ? 'urgent' : 'normal',
  status: 'pending',
  createdAt: NOW - index * 30_000,
  expiresAt: NOW + 3_600_000,
  provenance: 'superagent',
  fingerprint: `fp-${index}`,
  dedupeKey: `fp-${index}`,
  askedCount: 1,
}))

const activity = Array.from({ length: 30 }, (_, index) => ({
  at: NOW - index * 60_000,
  kind: 'cycle',
  summary: 'Cycle d’évaluation : aucune action autorisée, aucune proposition appliquée.',
  refs: [],
}))

const superagent = {
  identity: { agentId: 'super-agent-payload-bench', name: 'Super Agent', createdAt: NOW - 86_400_000, model: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, level: 'L3', status: 'idle', generation: 12 },
  session: { sessionId: 'session-superagent-bench', active: false, createdAt: NOW - 3_600_000, endedAt: NOW - 60_000, recycledCount: 3, recycleReason: 'host_restart', lastTurnAt: NOW - 120_000, lastError: null },
  portfolio: publicPortfolioOf(portfolio).projects,
  memory: { digest: { text: 'Memory digest — 120 facts, 120 decisions', updatedAt: NOW, facts: 120, decisions: 120 }, facts: 120, decisions: 120 },
  directives,
  decisionsRevoked: [],
  decisions: { pending, recent: [], summary: { pending: 20, urgent: 4, answered: 0, oldestAt: NOW - 20 * 30_000 } },
  plan: {
    revision: 12,
    updatedAt: NOW,
    objectives: [],
    nextActions: Array.from({ length: 8 }, (_, index) => ({ id: `p-${index}`, action: 'launch', projectId: workspaces[index % workspaces.length].id, taskId: tasks[index % tasks.length].id, rationale: 'raison bornée' })),
    idleReason: null,
  },
  activity,
  budget: { cyclesPerHour: 6, cyclesThisHour: 2, concurrentAgents: 0, maxConcurrentAgents: 2, modelCallsPerHour: 12, modelCallsThisHour: 4, tokenBudget: null, metricAvailability: { tokens: false, cost: false, calls: true, cycles: true }, windowStartedAt: NOW },
  runtime: { available: true, reason: null, modelDiscovery: 'live' },
  lastCycle: { at: NOW, trigger: 'scheduled', outcome: 'noop', reason: 'no_ready_work', proposals: 0, authorized: 0, applied: 0, refused: 0, decisions: 0, durationMs: 42 },
  nextWakeAt: NOW + 600_000,
  minIntervalMs: 600_000,
  dirty: false,
  failureCount: 0,
}

const sections = {
  mandate: mandate,
  portfolio: publicPortfolioOf(portfolio),
  capabilities,
  superagent,
  host: {
    build: { version: '0.2.0', schemaVersion: 2, features: ['mandate', 'scopeMode', 'levels', 'supervision', 'superagent', 'dryRun', 'taskboard-public', 'decisions', 'directives'], startedAt: NOW, pid: 12345, source: 'link' },
    primary: true,
    lockHolder: null,
    taskboardPublic: { configured: false, baseUrl: 'http://127.0.0.1:56117/dsh-taskboard/public/v1', reason: 'token_not_configured' },
    models: { discovered: false, at: NOW, reason: 'llm_service_unavailable', providers: [] },
  },
}

const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const total = bytes(sections)
const summary = {
  generatedAt: new Date().toISOString(),
  fixture: { projects: PROJECTS, tasks: tasks.length, directives: directives.length, decisions: pending.length, activity: activity.length },
  bytes: {
    total,
    mandate: bytes(sections.mandate),
    portfolio: bytes(sections.portfolio),
    capabilities: bytes(sections.capabilities),
    superagent: bytes(sections.superagent),
    host: bytes(sections.host),
  },
  kb: Object.fromEntries(Object.entries({ total, ...Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, bytes(value)])) }).map(([key, value]) => [key, Math.round((value / 1024) * 10) / 10])),
  note: 'Size only. SSE sends the whole /state; this is the additive cost of the GOAL 6 sections for a large personal install.',
}

await mkdir(OUT_DIR, { recursive: true })
await writeFile(join(OUT_DIR, OUT_NAME), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(summary, null, 2))
