import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeMandate } from '../src/contracts/mandate.js'
import { buildPortfolio, publicPortfolioOf } from '../src/plan/portfolio.js'
import { fairOrder, nextPlanActions } from '../src/plan/scheduler.js'

const NOW = 1_795_000_000_000

function mandate(overrides = {}) {
  return normalizeMandate({
    scopeMode: 'selected',
    selectedWorkspaces: ['p1', 'p2', 'p3'],
    level: 'L3',
    actions: { launch: true, create_task: true },
    projects: {
      p1: { enabled: true, priority: 1 },
      p2: { enabled: true, priority: 1 },
      p3: { enabled: true, priority: 1 },
    },
    requiresConfiguration: false,
    ...overrides,
  })
}

const WORKSPACES = [
  { id: 'p1', title: 'Alpha', path: 'D:/alpha' },
  { id: 'p2', title: 'Beta', path: 'D:/beta' },
  { id: 'p3', title: 'Gamma', path: 'D:/gamma' },
  { id: 'p4', title: 'Unselected', path: 'D:/delta' },
]

const TASKS = [
  { id: 'a1', workspaceId: 'p1', status: 'todo', title: 'A1' },
  { id: 'a2', workspaceId: 'p1', status: 'todo', title: 'A2', dependsOn: ['a1'] },
  { id: 'b1', workspaceId: 'p2', status: 'in_review', title: 'B1' },
  { id: 'c1', workspaceId: 'p3', status: 'todo', title: 'C1' },
  { id: 'd1', workspaceId: 'p4', status: 'todo', title: 'D1' },
]

test('portfolio reports real projects, scope and bounded counts', () => {
  const portfolio = buildPortfolio({ workspaces: WORKSPACES, mandate: mandate(), tasks: TASKS, now: NOW })
  assert.equal(portfolio.projects.length, 4)
  assert.equal(portfolio.summary.total, 4)
  assert.equal(portfolio.summary.selected, 3)
  assert.equal(portfolio.summary.enabled, 3)
  assert.equal(portfolio.summary.actionable, 2)

  const unselected = portfolio.projects.find(project => project.projectId === 'p4')
  assert.equal(unselected.selected, false)
  assert.equal(unselected.enabled, false)
  assert.equal(unselected.taskCounts.total, 1)

  const alpha = portfolio.projects.find(project => project.projectId === 'p1')
  assert.equal(alpha.taskCounts.todo, 2)
  assert.equal(alpha.taskCounts.blocked, 1)
  const beta = portfolio.projects.find(project => project.projectId === 'p2')
  assert.equal(beta.taskCounts.inReview, 1)
  // in_review is NOT done and NOT readable as reviewable work.
  assert.equal(beta.taskCounts.done, 0)

  assert.equal(publicPortfolioOf(portfolio).projects.length, 4)
})

test('portfolio never enables a project the mandate disabled', () => {
  const portfolio = buildPortfolio({
    workspaces: WORKSPACES,
    mandate: mandate({ projects: { p1: { enabled: false }, p2: { enabled: true }, p3: { enabled: true } } }),
    tasks: TASKS,
    now: NOW,
  })
  const alpha = portfolio.projects.find(project => project.projectId === 'p1')
  assert.equal(alpha.selected, true)
  assert.equal(alpha.enabled, false)
  assert.equal(portfolio.summary.enabled, 2)
})

test('scope none yields no selected project at all', () => {
  const portfolio = buildPortfolio({
    workspaces: WORKSPACES,
    mandate: normalizeMandate({ scopeMode: 'none', level: 'L4' }),
    tasks: TASKS,
    now: NOW,
  })
  assert.equal(portfolio.summary.selected, 0)
  assert.equal(portfolio.summary.actionable, 0)
  assert.equal(portfolio.projects.every(project => project.selected === false), true)
})

test('fair order: priority, then longest wait, then fewest served, then id', () => {
  const projects = [
    { projectId: 'b', priority: 1, lastServedAt: NOW - 1000, servedThisHour: 3 },
    { projectId: 'a', priority: 1, lastServedAt: NOW - 5000, servedThisHour: 3 },
    { projectId: 'c', priority: 1, lastServedAt: NOW - 5000, servedThisHour: 1 },
    { projectId: 'd', priority: 0, lastServedAt: NOW - 10, servedThisHour: 9 },
  ]
  assert.deepEqual(fairOrder(projects, NOW).map(project => project.projectId), ['d', 'c', 'a', 'b'])
})

test('a never-served project wins the anti-starvation tie', () => {
  const projects = [
    { projectId: 'served', lastServedAt: NOW - 50, servedThisHour: 0 },
    { projectId: 'never', servedThisHour: 0 },
  ]
  assert.deepEqual(fairOrder(projects, NOW).map(project => project.projectId), ['never', 'served'])
})

test('plan is round-robin: no project can take both slots while another waits', () => {
  const portfolio = buildPortfolio({ workspaces: WORKSPACES, mandate: mandate(), tasks: TASKS, now: NOW })
  const plan = nextPlanActions({ portfolio, assignments: [], maxActions: 2, maxConcurrent: 2, now: NOW })
  assert.equal(plan.actions.length, 2)
  assert.notEqual(plan.actions[0].projectId, plan.actions[1].projectId)
  assert.deepEqual(plan.actions.map(action => action.projectId).sort(), ['p1', 'p3'])
})

test('a running project yields the next slot to an idle one', () => {
  const portfolio = buildPortfolio({ workspaces: WORKSPACES, mandate: mandate(), tasks: TASKS, now: NOW })
  const plan = nextPlanActions({
    portfolio,
    assignments: [{ status: 'running', workspaceId: 'p1' }],
    maxActions: 1,
    maxConcurrent: 2,
    now: NOW,
  })
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.actions[0].projectId, 'p3')
})

test('idle reasons are explicit and never a fabricated task', () => {
  const empty = buildPortfolio({ workspaces: [], mandate: mandate(), tasks: [], now: NOW })
  assert.equal(nextPlanActions({ portfolio: empty, now: NOW }).idleReason, 'no_selected_projects')

  const noWork = buildPortfolio({ workspaces: WORKSPACES, mandate: mandate(), tasks: [{ id: 'x', workspaceId: 'p1', status: 'done' }], now: NOW })
  assert.equal(nextPlanActions({ portfolio: noWork, now: NOW }).idleReason, 'no_ready_work')

  const full = buildPortfolio({ workspaces: WORKSPACES, mandate: mandate(), tasks: TASKS, now: NOW })
  assert.equal(nextPlanActions({ portfolio: full, assignments: [{ status: 'running' }], maxConcurrent: 1, now: NOW }).idleReason, 'concurrency_full')
})

test('deterministic: same inputs produce the same plan', () => {
  const portfolio = buildPortfolio({ workspaces: WORKSPACES, mandate: mandate(), tasks: TASKS, now: NOW })
  const first = nextPlanActions({ portfolio, maxActions: 3, maxConcurrent: 3, now: NOW })
  const second = nextPlanActions({ portfolio: structuredClone(portfolio), maxActions: 3, maxConcurrent: 3, now: NOW })
  assert.deepEqual(first, second)
})
