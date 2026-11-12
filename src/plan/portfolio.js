/**
 * Project portfolio — a pure, fact-only view of which projects exist, which the
 * operator selected, and what work each one holds.
 *
 * It is derived from the workspace registry, the explicit mandate and the Task
 * Board read model. It NEVER infers a project, never enables one, and never
 * claims a task is reviewable when the ledger says otherwise.
 *
 * @module dsh-agent-board/plan/portfolio
 */

import { LEVEL_RANK, normalizeMandate, READ_ONLY_ACTIONS } from '../contracts/mandate.js'

export const PORTFOLIO_LIMITS = Object.freeze({
  projects: 100,
  tasks: 5000,
})

function text(value, max = 160) {
  return typeof value === 'string' && value.length > max ? value.slice(0, max) : (typeof value === 'string' ? value : '')
}

/**
 * Build the portfolio.
 *
 * @param {object} input
 * @param {Array<{id:string,title?:string,path?:string}>} input.workspaces
 * @param {object} input.mandate           normalized mandate
 * @param {Array<object>} [input.tasks]    Task Board tasks (real ledger rows)
 * @param {number} [input.now]
 */
export function buildPortfolio({ workspaces = [], mandate, tasks = [], now = Date.now() } = {}) {
  const current = normalizeMandate(mandate)
  const counts = new Map()
  for (const task of tasks.slice(0, PORTFOLIO_LIMITS.tasks)) {
    if (task === null || typeof task !== 'object') continue
    const projectId = String(task.workspaceId ?? task.projectId ?? '')
    if (projectId === '') continue
    const row = counts.get(projectId) ?? { total: 0, todo: 0, inReview: 0, blocked: 0, running: 0, done: 0 }
    row.total += 1
    const status = typeof task.status === 'string' ? task.status : 'unknown'
    if (status === 'todo') row.todo += 1
    else if (status === 'in_review') row.inReview += 1
    else if (status === 'in_progress') row.running += 1
    else if (status === 'done') row.done += 1
    if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0 && status === 'todo') row.blocked += 1
    counts.set(projectId, row)
  }

  const projects = []
  for (const workspace of workspaces.slice(0, PORTFOLIO_LIMITS.projects)) {
    const projectId = String(workspace?.id ?? '')
    if (projectId === '') continue
    const policy = current.projects[projectId] ?? null
    const scopeAll = current.scopeMode === 'all'
    const selected = scopeAll || (current.scopeMode === 'selected' && current.selectedWorkspaces.includes(projectId))
    const enabled = selected && (policy !== null ? policy.enabled === true : scopeAll)
    const projectLevel = policy?.level ?? current.level
    const effectiveLevel = LEVEL_RANK[projectLevel] <= LEVEL_RANK[current.level] ? projectLevel : current.level
    const tally = counts.get(projectId) ?? { total: 0, todo: 0, inReview: 0, blocked: 0, running: 0, done: 0 }
    projects.push({
      projectId,
      title: text(workspace?.title) || projectId,
      path: text(workspace?.path, 400) || null,
      selected,
      enabled,
      level: policy?.level ?? null,
      effectiveLevel,
      priority: policy?.priority ?? 5,
      model: policy?.model ?? null,
      budget: policy?.budget ?? null,
      note: policy?.note ?? '',
      taskCounts: tally,
      canonicalSource: 'taskboard',
    })
  }

  const selectedProjects = projects.filter(project => project.selected)
  return {
    generatedAt: now,
    projects,
    summary: {
      total: projects.length,
      selected: selectedProjects.length,
      enabled: selectedProjects.filter(project => project.enabled).length,
      actionable: selectedProjects.filter(project => project.enabled && project.taskCounts.todo > 0).length,
      scopeMode: current.scopeMode,
      level: current.level,
      paused: current.paused,
      requiresConfiguration: current.requiresConfiguration,
      readOnlyActions: READ_ONLY_ACTIONS.length,
      tasksBounded: tasks.length > PORTFOLIO_LIMITS.tasks,
    },
  }
}

/** Serialize a portfolio into the compact payload published on `/state`. */
export function publicPortfolioOf(portfolio) {
  if (portfolio === null || typeof portfolio !== 'object') return null
  return {
    generatedAt: portfolio.generatedAt ?? null,
    summary: portfolio.summary ?? null,
    projects: Array.isArray(portfolio.projects) ? portfolio.projects : [],
  }
}
