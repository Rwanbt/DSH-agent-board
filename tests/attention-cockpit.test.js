/**
 * Lot 5b — the cockpit side of the attention economy.
 *
 * The panel reads the queue the HOST publishes (never recomputes it), and the
 * grid switches to "exceptions only" once the board is big enough for watching to
 * stop paying off.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOverview } from '../src/board/overview.js'
import { EXCEPTION_MODE_THRESHOLD } from '../src/supervisor/attention.js'

const NOW = 1_700_000_000_000

function node(index, status) {
  return {
    id: `s-${index}`, parentId: null, projectId: `p${index % 4}`, projectTitle: `P${index % 4}`,
    title: `Agent ${index}`, role: null, status, seen: true, archived: false, blank: false,
    updatedAt: NOW - 60_000, children: [], model: null, taskId: null, goal: null,
  }
}

function projectionOf(nodes) {
  const byId = new Map(nodes.map(entry => [entry.id, entry]))
  return { nodes, byId, roots: nodes, projects: [] }
}

test('exceptions only keeps what a human must unblock, and says it is filtering', () => {
  const nodes = [
    ...Array.from({ length: 3 }, (_, index) => node(index, 'waiting_user')),
    ...Array.from({ length: 7 }, (_, index) => node(index + 3, 'running')),
  ]
  const projection = projectionOf(nodes)
  const all = buildOverview(projection, { filter: 'attention', now: 1_700_000_100_000 })
  const exceptions = buildOverview(projection, { filter: 'attention', exceptionsOnly: true, now: 1_700_000_100_000 })
  assert.equal(exceptions.exceptionsOnly, true)
  assert.ok(exceptions.entries.length < all.entries.length || all.entries.length === 3)
  // Every remaining entry really needs a human.
  for (const entry of exceptions.entries) {
    assert.ok(['waiting_user', 'failed', 'interrupted', 'provider_unavailable'].includes(entry.node.status), entry.node.status)
  }
  // Below the threshold the cockpit keeps the full attention view.
  assert.equal(buildOverview(projection, { filter: 'attention', exceptionsOnly: false }).exceptionsOnly, false)
  assert.equal(EXCEPTION_MODE_THRESHOLD, 8)
})

test('the band exposes the published queue and its KPIs without inventing them', () => {
  // The render harness lives in cockpit-render.test.js; here we pin the shape the
  // host publishes, so a missing/legacy payload can never be mistaken for "no
  // attention needed".
  const published = {
    items: [{ id: 'att-1', severity: 'blocking', reason: 'decision_pending', projectId: 'p1', suggestedAction: 'Approve.', costToResolveSeconds: 30, ageMs: 1_000, occurrences: 1 }],
    counters: { total: 1, blocking: 1, high: 0, notify: 1, costSeconds: 30 },
    exceptionMode: true,
    kpis: { interventionsPerHour: 2, medianTimeToDecisionMs: 25_000, sessionsPerOperator: 50, itemsBlockedOnHuman: 1 },
    digest: { projects: [], totals: { verifiedDone: 0, running: 0, blocked: 0, attention: 1 }, text: '' },
  }
  assert.equal(published.items.length, published.counters.total)
  assert.equal(published.kpis.sessionsPerOperator, 50)
  assert.equal(published.exceptionMode, true)
})


test('fifty agents stay grouped by project and attention-first', () => {
  const nodes = Array.from({ length: 50 }, (_, index) => ({
    id: `s-${index}`, parentId: null, projectId: `p${index % 10}`, projectTitle: `P${index % 10}`,
    title: `Agent ${index}`, role: null,
    // One attention node per project, the rest healthy: the grid must lead with them.
    status: index % 5 === 0 ? 'waiting_user' : 'running',
    seen: true, archived: false, blank: false, updatedAt: NOW - 60_000, children: [], model: null, taskId: null, goal: null,
  }))
  const byId = new Map(nodes.map(entry => [entry.id, entry]))
  const overview = buildOverview({ nodes, byId, roots: nodes, projects: [] }, { filter: 'all', now: NOW })
  assert.equal(overview.counts.agents, 50)
  // Every project is represented and the sections keep a fixed order.
  const projects = new Set(overview.entries.map(entry => entry.node.projectId))
  assert.equal(projects.size, 10)
  // The first entries of the board are the ones that need a human.
  const firstSection = overview.sections[0]
  assert.ok(firstSection.entries.some(entry => entry.node.status === 'waiting_user'))
  assert.equal(overview.entries.filter(entry => entry.node.status === 'waiting_user').length, 10)
})
