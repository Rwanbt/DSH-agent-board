import test from 'node:test'
import assert from 'node:assert/strict'

import { buildOverview, OVERVIEW_BUCKETS, OVERVIEW_SECTIONS } from '../src/board/overview.js'
import { buildBoardView } from '../src/board/view.js'
import { STATUS } from '../src/contracts/model.js'
import { NOW } from './fixtures/sessions.js'

const HOUR = 3_600_000

/**
 * Minimal projection node. Tests build the projection by hand so each cockpit
 * rule (section policy, bucket precedence, search field, focus) is exercised
 * without depending on the session classification rules of the host.
 */
function node(id, overrides = {}) {
  return {
    id,
    parentId: null,
    projectId: 'w-alpha',
    projectTitle: 'Alpha',
    title: `Agent ${id}`,
    role: null,
    status: STATUS.IDLE,
    seen: true,
    archived: false,
    blank: false,
    updatedAt: NOW - 60_000,
    children: [],
    model: null,
    taskId: null,
    goal: null,
    ...overrides,
  }
}

function projectionOf(nodes) {
  const byId = new Map(nodes.map(entry => [entry.id, entry]))
  const roots = nodes.filter(entry => (
    entry.parentId === null || entry.parentId === undefined
    || !byId.has(entry.parentId) || entry.orphan === true || entry.parentCycle === true
  ))
  return { nodes, byId, roots, projects: [] }
}

const ids = overview => overview.entries.map(entry => entry.node.id)

test('sections keep the fixed order and sort each section with sortAttention', () => {
  const nodes = [
    node('waiting', { status: STATUS.WAITING_USER, title: 'Needs a decision', updatedAt: NOW - 40 * HOUR }),
    node('interrupted', { status: STATUS.INTERRUPTED, seen: false }),
    node('failed', { status: STATUS.FAILED, seen: false, title: 'Broken run' }),
    node('running', { status: STATUS.RUNNING, updatedAt: NOW - 1000 }),
    node('recovering', { status: STATUS.RECOVERING }),
    node('unread', { status: STATUS.FINISHED_UNREAD }),
    node('idle', { status: STATUS.IDLE }),
    node('read', { status: STATUS.FINISHED_READ }),
  ]
  // "all" keeps every section populated so the fixed order is observable.
  const overview = buildOverview(projectionOf(nodes), { now: NOW, filter: 'all' })

  assert.deepEqual(overview.sections.map(section => section.id), [...OVERVIEW_SECTIONS])
  assert.equal(overview.sections.length, 3)
  // attention tier: waiting_user (0), interrupted (2.2), failed unseen (3).
  assert.deepEqual(overview.sections[0].entries.map(entry => entry.node.id), ['waiting', 'interrupted', 'failed'])
  // running + recovering keep their real status; nothing is promoted.
  assert.deepEqual(overview.sections[1].entries.map(entry => entry.node.id), ['running', 'recovering'])
  // finished_unread / idle / finished_read are the "other" section.
  assert.deepEqual(overview.sections[2].entries.map(entry => entry.node.id), ['unread', 'idle', 'read'])
  assert.deepEqual(ids(overview), [...ids({ entries: overview.sections.flatMap(section => section.entries) })])
  assert.deepEqual(overview.counts, {
    total: 8,
    agents: 8,
    active: 2,
    attention: 3,
    review: 0,
    other: 3,
    shown: 8,
    reviewAvailable: false,
  })
  // Default (attention) keeps the interventions, live work and the unread
  // result; calm history (idle/read) stays reachable through "all".
  const home = buildOverview(projectionOf(nodes), { now: NOW })
  assert.deepEqual(ids(home), ['waiting', 'interrupted', 'failed', 'running', 'recovering', 'unread'])
  // A 40-hour-old waiting session is still attention: age never sets a status.
  assert.ok(ids(home).includes('waiting'))

  const waiting = overview.entries.find(entry => entry.node.id === 'waiting')
  assert.equal(waiting.projectTitle, 'Alpha')
  assert.equal(waiting.parentTitle, null)
  assert.equal(waiting.taskState, null)
  assert.equal(waiting.taskTitle, null)
  assert.equal(waiting.depth, 0)
  assert.equal(waiting.descendants, 0)
  assert.equal(typeof waiting.tier, 'number')
})

test('within-section order uses the node facts, not the projection order', () => {
  // Deliberately shuffled: the shipped bug compared Entry wrappers (no status,
  // no updatedAt) so every comparison returned 0 and the input order survived.
  const nodes = [
    node('a-running-old', { status: STATUS.RUNNING, updatedAt: NOW - 9000 }),
    node('d-failed-old', { status: STATUS.FAILED, seen: false, updatedAt: NOW - 8000, title: 'Zeta' }),
    node('b-recovering', { status: STATUS.RECOVERING, updatedAt: NOW - 5000 }),
    node('e-waiting-new', { status: STATUS.WAITING_USER, updatedAt: NOW - 50 }),
    node('c-running-new', { status: STATUS.RUNNING, updatedAt: NOW - 100 }),
    node('f-failed-new', { status: STATUS.FAILED, seen: false, updatedAt: NOW - 10, title: 'Alpha' }),
  ]
  const overview = buildOverview(projectionOf(nodes), { now: NOW, filter: 'all' })
  // attention tier 0 (waiting) before tier 3 (failed unseen), then most recent.
  assert.deepEqual(overview.sections[0].entries.map(entry => entry.node.id), ['e-waiting-new', 'f-failed-new', 'd-failed-old'])
  // tier 1 (running) before tier 2.5 (recovering), then most recent within a tier.
  assert.deepEqual(overview.sections[1].entries.map(entry => entry.node.id), ['c-running-new', 'a-running-old', 'b-recovering'])
})

test('150 nodes: every node counted exactly once (attention > active > review > other)', () => {
  const nodes = []
  const taskStates = new Map()
  const add = (prefix, count, overrides) => {
    for (let index = 0; index < count; index += 1) {
      const extra = typeof overrides === 'function' ? overrides(index) : overrides
      nodes.push(node(`${prefix}-${index}`, extra))
    }
  }
  add('waiting', 30, { status: STATUS.WAITING_USER })
  add('running', 20, { status: STATUS.RUNNING })
  add('recovering', 15, { status: STATUS.RECOVERING })
  add('failed', 20, { status: STATUS.FAILED, seen: false })
  add('unread', 20, { status: STATUS.FINISHED_UNREAD })
  add('read', 15, index => {
    const taskId = `t-read-${index}`
    taskStates.set(taskId, 'in_review')
    return { status: STATUS.FINISHED_READ, taskId }
  })
  // Precedence guards: a running or waiting agent linked to an in_review task
  // stays active/attention, it is never moved into the review bucket.
  add('active-review', 10, index => {
    const taskId = `t-active-${index}`
    taskStates.set(taskId, 'in_review')
    return { status: STATUS.RUNNING, taskId }
  })
  add('attention-review', 10, index => {
    const taskId = `t-attention-${index}`
    taskStates.set(taskId, 'in_review')
    return { status: STATUS.WAITING_USER, taskId }
  })
  add('idle', 10, { status: STATUS.IDLE })
  assert.equal(nodes.length, 150)
  const projection = projectionOf(nodes)

  const complete = buildOverview(projection, { now: NOW, taskStates, filter: 'all' })
  assert.equal(complete.entries.length, 150, 'all shows every non-blank node')
  assert.equal(new Set(ids(complete)).size, 150, 'no node appears twice')
  assert.deepEqual(complete.sections.map(section => section.entries.length), [60, 45, 45])
  assert.deepEqual(complete.counts, {
    total: 150,
    agents: 150,
    active: 45,
    attention: 60,
    review: 15,
    other: 30,
    shown: 150,
    reviewAvailable: true,
  })
  const counts = complete.counts
  assert.equal(counts.attention + counts.active + counts.review + counts.other, counts.agents)
  assert.deepEqual([...OVERVIEW_BUCKETS], ['attention', 'active', 'review', 'other'])

  // The default filter still shows every intervention (and running/unread work),
  // but hides the calm history: 25 read/idle cards are not shown.
  const home = buildOverview(projection, { now: NOW, taskStates })
  assert.equal(home.counts.shown, 125)
  assert.equal(home.counts.attention + home.counts.active, 105)
  assert.ok(ids(home).filter(id => id.startsWith('waiting-')).length === 30)
  assert.ok(ids(home).filter(id => id.startsWith('failed-')).length === 20)
  assert.ok(ids(home).filter(id => id.startsWith('unread-')).length === 20)
  assert.equal(ids(home).filter(id => id.startsWith('read-')).length, 0)
})

test('the default filter never hides an intervention; action lists interventions only', () => {
  const nodes = [
    node('waiting', { status: STATUS.WAITING_USER, updatedAt: NOW - 40 * HOUR }),
    node('provider', { status: STATUS.PROVIDER_UNAVAILABLE }),
    node('failed', { status: STATUS.FAILED, seen: false }),
    node('interrupted', { status: STATUS.INTERRUPTED, seen: false }),
    node('seen-failed', { status: STATUS.FAILED, seen: true }),
    node('seen-interrupted', { status: STATUS.INTERRUPTED, seen: true }),
    node('running', { status: STATUS.RUNNING }),
    node('unread', { status: STATUS.FINISHED_UNREAD }),
    node('read', { status: STATUS.FINISHED_READ }),
  ]
  const projection = projectionOf(nodes)

  const home = buildOverview(projection, { now: NOW })
  for (const id of ['waiting', 'provider', 'failed', 'interrupted']) {
    assert.ok(ids(home).includes(id), `${id} must never be hidden by the default filter`)
  }

  const action = buildOverview(projection, { now: NOW, filter: 'action' })
  assert.deepEqual(ids(action).sort(), ['failed', 'interrupted', 'provider', 'waiting'])
  // sortAttention inside the attention section: waiting first.
  assert.equal(ids(action)[0], 'waiting')
  for (const id of ['seen-failed', 'seen-interrupted', 'running', 'unread', 'read']) {
    assert.ok(!ids(action).includes(id), `${id} is not an intervention`)
  }
})

test('search matches task title, task id, model, provider, session id, role, project and goal', () => {
  const taskStates = new Map([['t-alpha-42', 'in_review']])
  const taskTitles = new Map([['t-alpha-42', 'Fix the flux capacitor']])
  const nodes = [
    // Finished and read, hence hidden by the default filter: search still finds it.
    node('task-node', { status: STATUS.FINISHED_READ, role: 'reviewer', taskId: 't-alpha-42', goal: 'stabilise the warp drive' }),
    node('session-node', { status: STATUS.RUNNING, title: 'Deploy session sess-abcdef' }),
    node('model-node', { status: STATUS.RUNNING, model: { provider: 'acme', model: 'hyperspace-9' } }),
    node('role-node', { status: STATUS.RUNNING, role: 'guardian' }),
    node('project-node', { status: STATUS.RUNNING, projectId: 'w-beta', projectTitle: 'Beta' }),
    node('calm', { status: STATUS.IDLE, title: 'Quiet agent' }),
  ]
  const projection = projectionOf(nodes)
  const search = query => ids(buildOverview(projection, { now: NOW, query, taskTitles, taskStates }))

  assert.deepEqual(search('flux capacitor'), ['task-node'])
  assert.deepEqual(search('t-alpha-42'), ['task-node'])
  assert.deepEqual(search('fl\u00fcx') , [], 'no accent folding, no fabricated match')
  assert.deepEqual(search('hyperspace'), ['model-node'])
  assert.deepEqual(search('acme'), ['model-node'])
  assert.deepEqual(search('sess-abcdef'), ['session-node'])
  assert.deepEqual(search('guardian'), ['role-node'])
  assert.deepEqual(search('Beta'), ['project-node'])
  assert.deepEqual(search('warp drive'), ['task-node'])

  // The entry carries the ledger facts and the resolved role, never a status
  // invented from the task state.
  const taskEntry = buildOverview(projection, { now: NOW, query: 'flux', taskTitles, taskStates }).entries[0]
  assert.equal(taskEntry.taskState, 'in_review')
  assert.equal(taskEntry.taskTitle, 'Fix the flux capacitor')
  assert.equal(taskEntry.role.roleId, 'reviewer')
  assert.equal(taskEntry.node.status, STATUS.FINISHED_READ)
  const roleEntry = buildOverview(projection, { now: NOW, query: 'guardian' }).entries[0]
  assert.equal(roleEntry.role.roleId, 'guardian')
  assert.equal(roleEntry.node.status, STATUS.RUNNING)
})

test('focus narrows to one indicator bucket and focus:null clears it', () => {
  const taskStates = new Map([['t-review', 'in_review']])
  const nodes = [
    node('waiting', { status: STATUS.WAITING_USER }),
    node('running', { status: STATUS.RUNNING }),
    node('review', { status: STATUS.FINISHED_READ, taskId: 't-review' }),
    node('plain-read', { status: STATUS.FINISHED_READ }),
  ]
  const projection = projectionOf(nodes)
  const defaults = { now: NOW, taskStates }

  const home = buildOverview(projection, defaults)
  assert.deepEqual(ids(home), ['waiting', 'running'])
  assert.equal(home.focus, null)

  const attention = buildOverview(projection, { ...defaults, focus: 'attention' })
  assert.deepEqual(ids(attention), ['waiting'])
  assert.equal(attention.focus, 'attention')

  const active = buildOverview(projection, { ...defaults, focus: 'active' })
  assert.deepEqual(ids(active), ['running'])

  // The review bucket is reachable through focus even when the default filter
  // hides calm finished_read cards: the indicator is never a dead control.
  const review = buildOverview(projection, { ...defaults, focus: 'review' })
  assert.deepEqual(ids(review), ['review'])
  assert.equal(review.entries[0].taskState, 'in_review')

  const other = buildOverview(projection, { ...defaults, focus: 'other' })
  assert.deepEqual(ids(other), ['plain-read'])

  const cleared = buildOverview(projection, { ...defaults, focus: null })
  assert.deepEqual(ids(cleared), ids(home))
  const invalid = buildOverview(projection, { ...defaults, focus: 'planning' })
  assert.equal(invalid.focus, null)
  assert.deepEqual(ids(invalid), ids(home))

  for (const overview of [home, attention, active, review, other, cleared]) {
    assert.deepEqual(overview.counts, {
      total: 4,
      agents: 4,
      active: 1,
      attention: 1,
      review: 1,
      other: 1,
      shown: overview.entries.length,
      reviewAvailable: true,
    }, 'focus never changes the indicator counts')
  }
})

test('project and agent filters narrow the cards but not the indicator counts', () => {
  const taskStates = new Map([['t-review', 'in_review']])
  const nodes = [
    node('alpha-worker', { status: STATUS.RUNNING, role: 'worker' }),
    node('beta-reviewer', { status: STATUS.RUNNING, role: 'reviewer', projectId: 'w-beta', projectTitle: 'Beta' }),
    node('alpha-generic', { title: '' }),
    node('alpha-review-task', { status: STATUS.FINISHED_READ, taskId: 't-review' }),
  ]
  const projection = projectionOf(nodes)
  const base = { now: NOW, taskStates, filter: 'all' }

  const byProject = buildOverview(projection, { ...base, project: 'w-alpha' })
  assert.deepEqual(ids(byProject).sort(), ['alpha-generic', 'alpha-review-task', 'alpha-worker'])
  assert.equal(byProject.counts.agents, 4, 'indicator counts describe the whole projection')

  const byRole = buildOverview(projection, { ...base, filters: { role: 'worker' } })
  assert.deepEqual(ids(byRole), ['alpha-worker'])

  const byStatus = buildOverview(projection, { ...base, filters: { status: STATUS.RUNNING } })
  assert.deepEqual(ids(byStatus).sort(), ['alpha-worker', 'beta-reviewer'])

  const byTaskState = buildOverview(projection, { ...base, filters: { taskState: 'in_review' } })
  assert.deepEqual(ids(byTaskState), ['alpha-review-task'])

  // Unreadable Task Board ledger: the task state filter is ignored, never
  // guessed, and reviewAvailable reports the real reason.
  const unavailable = buildOverview(projection, { ...base, taskStates: undefined, filters: { taskState: 'in_review' } })
  assert.equal(unavailable.counts.reviewAvailable, false)
  assert.equal(unavailable.counts.review, 0)
  assert.deepEqual(ids(unavailable).sort(), ['alpha-generic', 'alpha-review-task', 'alpha-worker', 'beta-reviewer'])
  assert.equal(unavailable.entries.every(entry => entry.taskState === null), true)
})

test('dismissed nodes leave the attention/action views but stay in all and search', () => {
  const nodes = [
    node('dismissed-waiting', { status: STATUS.WAITING_USER }),
    node('running', { status: STATUS.RUNNING }),
  ]
  const projection = projectionOf(nodes)
  const dismissed = new Set(['dismissed-waiting'])

  const home = buildOverview(projection, { now: NOW, dismissed })
  assert.deepEqual(ids(home), ['running'])
  // Dismiss is a display preference: the projection fact is still counted.
  assert.equal(home.counts.attention, 1)
  assert.equal(home.counts.shown, 1)

  const action = buildOverview(projection, { now: NOW, dismissed, filter: 'action' })
  assert.deepEqual(ids(action), [])

  const all = buildOverview(projection, { now: NOW, dismissed, filter: 'all' })
  assert.deepEqual(ids(all).sort(), ['dismissed-waiting', 'running'])

  const search = buildOverview(projection, { now: NOW, dismissed, query: 'dismissed' })
  assert.deepEqual(ids(search), ['dismissed-waiting'])

  const focus = buildOverview(projection, { now: NOW, dismissed, focus: 'attention' })
  assert.deepEqual(ids(focus), [], 'focus does not resurrect a dismissed session')
})

test('review bucket and reviewAvailable tell the truth about the Task Board ledger', () => {
  const nodes = [
    node('linked-review', { status: STATUS.FINISHED_READ, taskId: 't-1' }),
    node('linked-todo', { status: STATUS.FINISHED_READ, taskId: 't-2' }),
    node('unlinked', { status: STATUS.FINISHED_READ }),
  ]
  const projection = projectionOf(nodes)

  const readable = buildOverview(projection, { now: NOW, taskStates: new Map([['t-1', 'in_review'], ['t-2', 'todo']]) })
  assert.equal(readable.counts.reviewAvailable, true)
  assert.equal(readable.counts.review, 1)
  assert.equal(readable.entries.every(entry => entry.taskState === null || typeof entry.taskState === 'string'), true)
  const reviewEntry = buildOverview(projection, { now: NOW, taskStates: new Map([['t-1', 'in_review']]), filter: 'all' })
    .entries.find(entry => entry.node.id === 'linked-review')
  assert.equal(reviewEntry.taskState, 'in_review')

  const emptyLedger = buildOverview(projection, { now: NOW, taskStates: new Map() })
  assert.equal(emptyLedger.counts.reviewAvailable, true, 'an empty ledger is readable, not missing')
  assert.equal(emptyLedger.counts.review, 0)

  for (const taskStates of [null, undefined]) {
    const unreadable = buildOverview(projection, { now: NOW, taskStates })
    assert.equal(unreadable.counts.reviewAvailable, false)
    assert.equal(unreadable.counts.review, 0)
    assert.equal(unreadable.entries.every(entry => entry.taskState === null), true)
  }
})

test('empty or partial projection returns the stable empty cockpit shape', () => {
  const expectedCounts = { total: 0, agents: 0, active: 0, attention: 0, review: 0, other: 0, shown: 0, reviewAvailable: false }
  for (const input of [undefined, null, {}, { nodes: [] }]) {
    const overview = buildOverview(input)
    assert.deepEqual(overview.sections, [
      { id: 'attention', entries: [] },
      { id: 'running', entries: [] },
      { id: 'other', entries: [] },
    ])
    assert.deepEqual(overview.entries, [])
    assert.deepEqual(overview.counts, expectedCounts)
    assert.equal(overview.filter, 'attention')
    assert.equal(overview.query, '')
    assert.equal(overview.focus, null)
  }

  const fallback = buildOverview(projectionOf([node('calm')]), { filter: 'not-a-filter', query: '  CALM  ' })
  assert.equal(fallback.filter, 'attention')
  assert.equal(fallback.query, 'calm')
})

test('cycle-safe: malformed parentage never hides or duplicates a node', () => {
  const root = node('root', { title: 'Root' })
  const child = node('child', { parentId: 'root', title: 'Child' })
  const grandchild = node('grandchild', { parentId: 'child', title: 'Grandchild' })
  root.children = ['child']
  child.children = ['grandchild']
  // A broken cycle, flagged exactly like buildProjection() flags it.
  const cycleA = node('cycle-a', { parentId: 'cycle-b' })
  const cycleB = node('cycle-b', { parentId: 'cycle-a', parentCycle: true })
  cycleB.children = ['cycle-a']
  const orphan = node('orphan', { parentId: 'ghost-parent', orphan: true })

  const secondRoot = node('second-root')
  const secondChild = node('second-child', { parentId: 'second-root' })
  secondRoot.children = ['second-child']
  const nodes = [root, child, grandchild, cycleA, cycleB, orphan, secondRoot, secondChild]
  // A hand-built unflagged cycle must still terminate.
  const looseA = node('loose-a', { parentId: 'loose-b' })
  const looseB = node('loose-b', { parentId: 'loose-a' })
  looseA.children = ['loose-b']
  looseB.children = ['loose-a']
  nodes.push(looseA, looseB)

  const overview = buildOverview(projectionOf(nodes), { now: NOW, filter: 'all' })
  assert.equal(overview.entries.length, nodes.length)
  assert.equal(new Set(ids(overview)).size, nodes.length, 'each node is present exactly once')
  const depths = Object.fromEntries(overview.entries.map(entry => [entry.node.id, entry.depth]))
  assert.deepEqual(depths, {
    root: 0,
    child: 1,
    grandchild: 2,
    'cycle-a': 1,
    'cycle-b': 0,
    orphan: 0,
    'second-root': 0,
    'second-child': 1,
    'loose-a': 1,
    'loose-b': 0,
  })
  const byId = Object.fromEntries(overview.entries.map(entry => [entry.node.id, entry]))
  assert.equal(byId.child.parentTitle, 'Root')
  assert.equal(byId['cycle-a'].parentTitle, 'Agent cycle-b')
  assert.equal(byId.orphan.parentTitle, null, 'a missing parent is not invented')
  assert.equal(byId.root.descendants, 2)
  assert.equal(byId.child.descendants, 1)
  assert.equal(byId.orphan.descendants, 0)
})

test('performance: 15/50/150 nodes buildOverview + buildBoardView under a generous bound', () => {
  // Generous by design: this is a regression guard, not a benchmark. A pair of
  // calls is expected in the low milliseconds; the 250 ms bound tolerates slow
  // CI machines and cold JIT without ever hiding an accidental quadratic blowup
  // (150 nodes * 20 rounds would be visible immediately).
  const BOUND_MS = 250
  const makeProjection = size => {
    const nodes = []
    for (let index = 0; index < size; index += 1) {
      const statuses = [STATUS.RUNNING, STATUS.WAITING_USER, STATUS.FINISHED_UNREAD, STATUS.FINISHED_READ, STATUS.IDLE]
      const status = statuses[index % statuses.length]
      const parent = index % 3 === 0 ? null : `perf-${index - 1}`
      nodes.push(node(`perf-${index}`, {
        status,
        parentId: parent,
        taskId: index % 4 === 0 ? `t-${index}` : null,
        children: index + 1 < size && (index + 1) % 3 !== 0 ? [`perf-${index + 1}`] : [],
      }))
    }
    return projectionOf(nodes)
  }
  const taskStates = new Map()
  for (let index = 0; index < 150; index += 4) taskStates.set(`t-${index}`, 'in_review')

  for (const size of [15, 50, 150]) {
    const projection = makeProjection(size)
    const rounds = 20
    const started = performance.now()
    for (let round = 0; round < rounds; round += 1) {
      buildOverview(projection, { now: NOW, taskStates })
      buildBoardView(projection, { now: NOW })
    }
    const perRound = (performance.now() - started) / rounds
    assert.ok(perRound < BOUND_MS, `${size} nodes: one buildOverview + buildBoardView pair took ${perRound.toFixed(2)} ms`)
  }
})
