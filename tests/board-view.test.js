import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { buildProjection, resolveProject, indexWorkspaces, lastUsefulLine, normalizePath } from '../src/supervisor/projection.js'
import { buildBoardView, boardCounts, historyPage, aggregateSubtrees, sortAttention, isAttention, projectOptions, ancestorChain, includedByFilter, isActionRequired, VIEW_FILTERS } from '../src/board/view.js'
import { STATUS } from '../src/contracts/model.js'
import { NOW, photoScenario, largeScenario, row } from './fixtures/sessions.js'

const project = input => buildProjection({ ...input, now: NOW })

function flatten(view) {
  const out = []
  const walk = entry => { out.push(entry); entry.children.forEach(walk) }
  for (const p of view.projects) p.trees.forEach(walk)
  return out
}

test('photo scenario: default view hides the 39 old sessions and keeps attention items', () => {
  const projection = project(photoScenario())
  const view = buildBoardView(projection, { now: NOW })
  const shown = flatten(view).map(entry => entry.node.id)
  assert.equal(shown.filter(id => id.startsWith('old-')).length, 0, 'no old session on the home view')
  for (let index = 0; index < 9; index += 1) assert.ok(shown.includes(`unread-${index}`), `unread-${index} visible`)
  assert.ok(shown.includes('dw-live'))
  assert.ok(shown.includes('ravum-goal'))
  assert.ok(shown.includes('asking'), 'an old waiting session never disappears')
  assert.ok(shown.includes('failed-new'))
  assert.ok(view.visibleCount < 40, `home view stays short (${view.visibleCount})`)
  // Old sessions remain reachable through search and history.
  const searched = buildBoardView(projection, { now: NOW, query: 'CRON-F' })
  assert.ok(flatten(searched).some(entry => entry.node.id === 'old-0'))
  const history = historyPage(projection, { limit: 30 })
  assert.ok(history.total >= 39)
  assert.equal(history.items.length, 30)
  assert.equal(history.hasMore, true)
})

test('global counters are distinct from visible cards (no fake "39 active")', () => {
  const projection = project(photoScenario())
  const counts = boardCounts(projection)
  assert.equal(counts.unread, 9)
  assert.equal(counts.waiting, 1)
  assert.ok(counts.history >= 39)
  assert.equal(counts.total, projection.nodes.length)
})

test('project grouping uses workspace membership, then normalized cwd, never the title', () => {
  const projection = project(photoScenario())
  assert.equal(projection.byId.get('ravum-goal').projectId, 'ws:w-ravum')
  // Not a member of the workspace list, resolved by its cwd:
  assert.equal(projection.byId.get('ravum-parent-done').projectId, 'ws:w-ravum')
  // Title contains "RAVUM" but lives in default-workspace → default-workspace.
  const scenario = photoScenario()
  scenario.list.byId['old-2'].displayTitle = 'GOAL — RAVUM (copy)'
  assert.equal(project(scenario).byId.get('old-2').projectId, 'ws:w-dw')
  // Unknown path → unassigned (not default-workspace).
  assert.equal(projection.byId.get('long').projectId, 'unassigned')
  const index = indexWorkspaces({ items: [{ workspaceId: 'x', path: 'D:\\App\\Ravum\\', sessionIds: [] }] })
  assert.equal(resolveProject({ id: 'q', cwd: 'd:/app/ravum/sub/dir' }, index).id, 'ws:x')
  assert.equal(resolveProject({ id: 'q', cwd: 'D:\\App\\Ravum-flow' }, index).id, 'unassigned', 'prefix must stop at a path separator')
  assert.equal(normalizePath('D:\\App\\X\\'), 'd:/app/x')
})

test('filiation depth ≥ 3, sub-agents only under their parent, deduplicated', () => {
  const projection = project(photoScenario())
  assert.equal(projection.nodes.filter(node => node.id === 'child-a').length, 1, 'duplicate ids collapse to one node')
  assert.deepEqual(ancestorChain(projection, 'great-grandchild'), ['ravum-goal', 'child-a', 'grandchild'])
  const view = buildBoardView(projection, { now: NOW })
  const ravum = view.projects.find(p => p.id === 'ws:w-ravum')
  const rootIds = ravum.trees.map(tree => tree.node.id)
  assert.ok(!rootIds.includes('child-a') && !rootIds.includes('grandchild'), 'descendants never appear as roots')
  const goal = ravum.trees.find(tree => tree.node.id === 'ravum-goal')
  const childA = goal.children.find(entry => entry.node.id === 'child-a')
  assert.ok(childA, 'running child shown under its parent')
  assert.equal(childA.children[0].node.id, 'grandchild')
  // Child titles come from the sub-agent label, roles from the team roster.
  assert.equal(childA.node.title, 'Author conformance cases')
  assert.equal(childA.node.role, 'feat-syn')
  // Calm children are hidden and counted on the parent.
  assert.equal(goal.totalChildren, 7)
  assert.equal(goal.hiddenChildren, 6)
  const revealed = buildBoardView(projection, { now: NOW, expanded: new Set(['ravum-goal']) })
  const goal2 = revealed.projects.find(p => p.id === 'ws:w-ravum').trees.find(tree => tree.node.id === 'ravum-goal')
  assert.equal(goal2.children.length, 7)
  const folded = buildBoardView(projection, { now: NOW, collapsed: new Set(['ravum-goal']) })
  const goal3 = folded.projects.find(p => p.id === 'ws:w-ravum').trees.find(tree => tree.node.id === 'ravum-goal')
  assert.equal(goal3.children.length, 0)
  assert.equal(goal3.collapsed, true)
})

test('several roots per project; finished parent with an active child is a group, not a running card', () => {
  const projection = project(photoScenario())
  const view = buildBoardView(projection, { now: NOW })
  const ravum = view.projects.find(p => p.id === 'ws:w-ravum')
  assert.ok(ravum.trees.length >= 3, 'multiple root trees coexist in one project')
  const done = ravum.trees.find(tree => tree.node.id === 'ravum-parent-done')
  assert.ok(done, 'parent kept visible because its child runs')
  assert.notEqual(done.node.status, STATUS.RUNNING, 'parent own turn is not shown as running')
  assert.equal(done.groupActive, true)
  assert.equal(done.children[0].node.status, STATUS.RUNNING)
})

test('orphan and cycle become flagged roots; long title and missing workspace are tolerated', () => {
  const projection = project(photoScenario())
  const orphan = projection.byId.get('orphan')
  assert.equal(orphan.orphan, true)
  assert.ok(projection.roots.includes(orphan))
  const a = projection.byId.get('cyc-a')
  const b = projection.byId.get('cyc-b')
  assert.ok(a.parentCycle === true || b.parentCycle === true, 'cycle broken')
  assert.equal(projection.roots.filter(node => node.id === 'cyc-a' || node.id === 'cyc-b').length, 1)
  const view = buildBoardView(projection, { now: NOW })
  assert.ok(flatten(view).some(entry => entry.node.id === 'long'))
  assert.equal(projection.byId.get('long').title.length, 400)
  assert.ok(projectOptions(projection).every(option => option.id !== 'ws:w-gone'), 'empty workspace does not create a group')
})

test('statuses: running/waiting/unread/failed/read are distinct and not inferred from age', () => {
  const projection = project(photoScenario())
  assert.equal(projection.byId.get('dw-live').status, STATUS.RUNNING)
  assert.equal(projection.byId.get('asking').status, STATUS.WAITING_USER)
  assert.equal(projection.byId.get('asking').expectedAction, 'question')
  assert.equal(projection.byId.get('asking').waitingDetail, 'Which branch should I merge into?')
  assert.equal(projection.byId.get('unread-0').status, STATUS.FINISHED_UNREAD)
  assert.equal(projection.byId.get('failed-new').status, STATUS.FAILED)
  assert.equal(projection.byId.get('failed-new').seen, false)
  // Old completed turn (native lastTurnEnd only) is history, not "new".
  assert.equal(projection.byId.get('old-5').status, STATUS.FINISHED_READ)
  assert.equal(isAttention(projection.byId.get('old-5')), false)
  // An ack turns unread into read and hides it.
  const scenario = photoScenario()
  scenario.hostState.acks = { 'unread-0': { seenAt: NOW + 1 }, 'failed-new': { seenAt: NOW + 1 } }
  const acked = project(scenario)
  assert.equal(acked.byId.get('unread-0').status, STATUS.FINISHED_READ)
  assert.equal(acked.byId.get('failed-new').status, STATUS.FAILED)
  assert.equal(acked.byId.get('failed-new').seen, true)
  assert.equal(isAttention(acked.byId.get('failed-new')), false)
})

test('sortAttention: waiting, running, unread, then recency; deterministic', () => {
  const projection = project(photoScenario())
  const sorted = [...projection.nodes].sort(sortAttention).map(node => node.status)
  const firstRunning = sorted.indexOf(STATUS.RUNNING)
  const firstUnread = sorted.indexOf(STATUS.FINISHED_UNREAD)
  assert.equal(sorted[0], STATUS.WAITING_USER)
  assert.ok(firstRunning < firstUnread)
  const again = [...projection.nodes].reverse().sort(sortAttention).map(node => node.id)
  assert.deepEqual([...projection.nodes].sort(sortAttention).map(node => node.id), again)
  const view = buildBoardView(projection, { now: NOW })
  assert.equal(view.projects.at(-1).id, 'unassigned', 'unassigned group last')
})

test('recent filter adds last-24h calm sessions; all shows history; archived not in recent', () => {
  const projection = project(photoScenario())
  const recent = flatten(buildBoardView(projection, { now: NOW, filter: 'recent' })).map(entry => entry.node.id)
  assert.ok(recent.includes('old-0'), 'old-0 updated 8h ago is recent')
  assert.ok(!recent.includes('old-1'), 'archived excluded from recent')
  assert.ok(!recent.includes('old-30'), '38h ago is not recent')
  const all = flatten(buildBoardView(projection, { now: NOW, filter: 'all' }))
  assert.ok(all.some(entry => entry.node.id === 'old-30'), 'all filter shows history roots')
})

test('final answer: last useful line, markdown stripped', () => {
  assert.equal(lastUsefulLine('# Report\n\nDone.\n- **All tests pass**\n\n'), 'All tests pass')
  assert.equal(lastUsefulLine(''), '')
  const projection = project(photoScenario())
  const node = projection.byId.get('old-3')
  assert.equal(node.preview.final, true)
  assert.equal(lastUsefulLine(node.preview.text), 'All tests pass.')
  // The open turn of a running session is never taken as the final answer.
  const scenario = photoScenario()
  scenario.list.byId['dw-live'].projectionValues.turnOutline = [{ turn: 1, response: 'Old final.' }, { turn: 2, response: 'partial…' }]
  assert.equal(project(scenario).byId.get('dw-live').preview.text, 'Old final.')
})

test('performance: 200 history + 30 active roots, projection + view stay fast', () => {
  const scenario = largeScenario({ history: 200, active: 30 })
  const started = performance.now()
  let view
  for (let round = 0; round < 20; round += 1) {
    const projection = buildProjection({ ...scenario, now: NOW })
    view = buildBoardView(projection, { now: NOW, aggregates: aggregateSubtrees(projection) })
  }
  const perRound = (performance.now() - started) / 20
  assert.ok(perRound < 25, `one rebuild took ${perRound.toFixed(2)} ms`)
  const shown = flatten(view)
  assert.ok(shown.every(entry => !entry.node.id.startsWith('h-')), 'history stays out of the home view')
  assert.equal(shown.filter(entry => entry.depth === 0).length, 30)
})

test('CSS: only the running mark animates and reduced motion disables it', async () => {
  const css = await readFile(new URL('../src/client/ui/styles.js', import.meta.url), 'utf8')
  const animated = css.split('\n').filter(line => /animation:\s*dab-/.test(line))
  assert.equal(animated.length, 1)
  assert.match(animated[0], /data-status="running"/)
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-status="running"\]::before \{ animation: none/)
})

test('the new statuses use theme tokens for their mark and stay non-animated', async () => {
  const css = await readFile(new URL('../src/client/ui/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.dab-mark\[data-status="interrupted"\]::before \{[^}]*--dsw-alias-state-warn-primary/)
  assert.match(css, /\.dab-mark\[data-status="provider_unavailable"\]::before \{[^}]*--dsw-alias-state-error-primary/)
  // The model chip reuses the existing fill token and the unknown state is explicit.
  assert.match(css, /\.dab-chip \{[^}]*var\(--dab-chip-fill\)/)
  assert.match(css, /\.dab-chip\[data-source="unknown"\]/)
  assert.doesNotMatch(css, /dab-chip[^}]*animation/)
})

test('interrupted and provider_unavailable cards are attention and sort deterministically', () => {
  const NOW_MS = 1_800_000_000_000
  const row = (id, extra = {}) => ({ id, displayTitle: id, running: false, updatedAt: NOW_MS - 60_000, projectionValues: { modelSelection: { lastUsed: { provider: 'opencode-go', model: 'm' } } }, ...extra })
  const projection = buildProjection({
    list: {
      ids: ['stopped', 'outage', 'unread', 'calm'],
      byId: { stopped: row('stopped'), outage: row('outage'), unread: row('unread'), calm: row('calm') },
      projectionsBySession: {},
    },
    statusMap: new Map(),
    hostState: {
      assignments: [{ id: 'a', sessionId: 'stopped', status: 'interrupted', endedAt: NOW_MS - 1000 }],
      turnEnd: {
        outage: { at: NOW_MS - 2000, kind: 'error' },
        unread: { at: NOW_MS - 1000, kind: 'completed' },
        calm: { at: NOW_MS - 9000, kind: 'completed' },
      },
      acks: { calm: { seenAt: NOW_MS - 8000 } },
      health: { 'opencode-go': { cooldownUntil: NOW_MS + 60_000, lastFailureAt: NOW_MS - 2000 } },
    },
    now: NOW_MS,
  })
  for (const id of ['stopped', 'outage']) assert.equal(isAttention(projection.byId.get(id)), true)
  assert.equal(isAttention(projection.byId.get('calm')), false)
  const ranked = [...projection.nodes].sort(sortAttention).map(node => node.id)
  assert.equal(ranked[0], 'unread', 'an unread result is still the first non-running tier')
  assert.ok(ranked.indexOf('stopped') < ranked.indexOf('outage'), 'interrupted before provider outage')
  assert.ok(ranked.indexOf('outage') < ranked.indexOf('calm'))
  const view = buildBoardView(projection, { now: NOW_MS })
  const shown = view.projects.flatMap(entry => entry.trees).map(tree => tree.node.id)
  assert.ok(shown.includes('stopped'))
  assert.ok(shown.includes('outage'))
  assert.ok(!shown.includes('calm'), 'a read result stays history')
})

test('VIEW_FILTERS exposes the action filter; isActionRequired lists interventions only', () => {
  assert.ok(VIEW_FILTERS.includes('action'), 'the persisted UI validates against VIEW_FILTERS')
  assert.equal(isActionRequired({ status: STATUS.WAITING_USER }), true)
  assert.equal(isActionRequired({ status: STATUS.PROVIDER_UNAVAILABLE }), true)
  assert.equal(isActionRequired({ status: STATUS.FAILED, seen: false }), true)
  assert.equal(isActionRequired({ status: STATUS.INTERRUPTED, seen: false }), true)
  assert.equal(isActionRequired({ status: STATUS.FAILED, seen: true }), false)
  assert.equal(isActionRequired({ status: STATUS.INTERRUPTED, seen: true }), false)
  assert.equal(isActionRequired({ status: STATUS.RUNNING }), false)
  assert.equal(isActionRequired({ status: STATUS.FINISHED_UNREAD }), false)
  assert.equal(isActionRequired({ status: STATUS.WAITING_USER, archived: true }), false)
  assert.equal(isActionRequired(null), false)
  // includedByFilter keeps exactly the same policy for the view layer.
  assert.equal(includedByFilter({ status: STATUS.WAITING_USER, blank: false }, 'action', NOW), true)
  assert.equal(includedByFilter({ status: STATUS.RUNNING, blank: false }, 'action', NOW), false)
})

test('action view keeps only waiting/failed-unseen/interrupted-unseen roots', () => {
  const projection = project(photoScenario())
  const defaultIds = flatten(buildBoardView(projection, { now: NOW })).map(entry => entry.node.id)
  const actionIds = flatten(buildBoardView(projection, { now: NOW, filter: 'action' })).map(entry => entry.node.id)
  assert.ok(actionIds.includes('asking'), 'a waiting session is an intervention')
  assert.ok(actionIds.includes('failed-new'), 'an unseen failure is an intervention')
  assert.ok(!actionIds.includes('dw-live'), 'a running session is not an intervention')
  assert.ok(!actionIds.includes('unread-0'), 'an unread result is not an intervention')
  for (const id of actionIds) assert.ok(defaultIds.includes(id), 'action is a subset of the default view')
})

test('buildBoardView query matches the linked Task Board task title when taskTitles is supplied', () => {
  const session = row('task-session', { displayTitle: 'Deploy run', updatedAt: NOW - 1000 })
  const projection = buildProjection({
    list: { ids: ['task-session'], byId: { 'task-session': session }, projectionsBySession: {} },
    statusMap: new Map(),
    hostState: {
      assignments: [{ id: 'a-1', sessionId: 'task-session', taskId: 't-42', status: 'running', startedAt: NOW - 5000 }],
      turnEnd: { 'task-session': { at: NOW - 2000, kind: 'completed' } },
      acks: {},
      previews: {},
    },
    now: NOW,
  })
  assert.equal(projection.byId.get('task-session').taskId, 't-42')
  // Backward compatible: without the new option the query cannot match the title.
  const plain = buildBoardView(projection, { now: NOW, query: 'flux capacitor' })
  assert.equal(plain.visibleCount, 0)
  const titled = buildBoardView(projection, { now: NOW, query: 'flux capacitor', taskTitles: new Map([['t-42', 'Fix the flux capacitor']]) })
  assert.deepEqual(flatten(titled).map(entry => entry.node.id), ['task-session'])
  // The existing search fields keep working with the option present.
  const byTaskId = buildBoardView(projection, { now: NOW, query: 't-42', taskTitles: new Map([['t-42', 'Fix the flux capacitor']]) })
  assert.deepEqual(flatten(byTaskId).map(entry => entry.node.id), ['task-session'])
  // A title indexed for another task never matches this one.
  const unrelated = buildBoardView(projection, { now: NOW, query: 'flux', taskTitles: new Map([['other-task', 'flux capacitor']]) })
  assert.equal(unrelated.visibleCount, 0)
})
