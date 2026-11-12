/**
 * Render-level tests of the responsive cockpit, evaluated the same way the
 * browser artifact is built: the authored modules are concatenated (imports and
 * `export` keywords stripped) and executed with a minimal React stub that
 * hydrates function components. No DOM, no JSX, no bundler.
 *
 * These tests pin the CONTRACT of the cockpit components: section order, real
 * counts, role/status independence, explicit session opening, drawer semantics
 * and the responsive CSS decisions.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildProjection } from '../src/supervisor/projection.js'
import { buildBoardView, boardCounts } from '../src/board/view.js'
import { buildHierarchyView } from '../src/board/hierarchy.js'
import { buildOverview } from '../src/board/overview.js'
import { AGENT_ROLE_IDS, AGENT_ROLES, dabResolveAgentRole } from '../src/contracts/agent-roles.js'
import { NOW, photoScenario, largeScenario } from './fixtures/sessions.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const MODULES = [
  'src/contracts/model.js',
  'src/contracts/agent-roles.js',
  'src/supervisor/projection.js',
  'src/supervisor/super-orchestrator.js',
  'src/board/view.js',
  'src/board/hierarchy.js',
  'src/board/overview.js',
  'src/board/interaction.js',
  'src/client/ui/strings.js',
  'src/client/ui/styles.js', 'src/client/ui/select.js',
  'src/client/ui/agent-bots-assets.js',
  'src/client/ui/avatar.js',
  'src/client/ui/card.js',
  'src/client/ui/hierarchy.js',
  'src/client/ui/overview.js',
  'src/client/ui/superbar.js',
  'src/client/ui/tree.js',
  'src/client/ui/preview.js',
  'src/client/ui/inspector.js',
  'src/client/ui/history.js',
  'src/client/ui/toolbar.js',
  'src/client/app.js',
]

const IMPORT_STATEMENT = /^[ \t]*import\s+(?:[^'"]*?\s+from\s+)?['"][^'"]+['"][ \t]*;?[ \t]*\r?\n?/gm
const EXPORT_PREFIX = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm

const sources = new Map()
for (const relative of MODULES) {
  const raw = await readFile(join(ROOT, relative), 'utf8')
  const stripped = raw.replace(IMPORT_STATEMENT, '').replace(EXPORT_PREFIX, '')
  assert.doesNotMatch(stripped, /^[ \t]*import\b/m, `${relative}: every import is stripped by the build transform`)
  sources.set(relative, stripped)
}

const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    return { type, props: { ...(props ?? {}), children: kids.length === 1 ? kids[0] : kids }, children: kids }
  },
  memo: component => component,
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useRef: value => ({ current: value }),
  useMemo: factory => factory(),
  useCallback: callback => callback,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useSyncExternalStore: (subscribe, get) => get(),
}

const CODE = `${[...sources.values()].join('\n\n')}
return {
  dabT, DAB_STRINGS, DAB_CSS, DAB_UI_KEY,
  dabReadUi, dabWriteUi,
  setLang: value => { DAB_LANG = value },
  DabToolbar, DabOverviewStats, DabGlobalOverview, DabGlobalCard, DabSuperOrchestratorBar,
  DabInspector, DabAgentPreview,
  // GOAL 6 Super Agent surfaces (same bundle scope, no second module).
  DabSuperagentInspector, DabSuperagentOverview, DabSuperagentProjects,
  DabSuperagentDirectives, DabSuperagentSettings, DabSuperagentDecisions, DabAllProjectsConfirm,
  dabSuperagentFacts, dabProjectPolicyRows, dabEffectiveCapabilities, dabCapabilityEntry,
  dabActionRefusalReason, dabSuperagentPortfolio, dabDecisionGroups, dabAllProjectsConfirmValid,
  dabSaBound,
}`

const cockpit = new Function('React', CODE)(React)

// ---------------------------------------------------------------- helpers
/**
 * Hydrate function components recursively (the real React would do this at
 * render time). Host elements keep their props and hydrated children, so the
 * assertions only ever see what is really rendered.
 */
function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(renderNode).filter(child => child !== null)
  if (typeof node.type === 'function') {
    const props = { ...node.props, children: node.props?.children ?? node.children }
    return renderNode(node.type(props))
  }
  const children = (node.children ?? []).map(renderNode).filter(child => child !== null)
  return { type: node.type, props: node.props ?? {}, children }
}

const render = node => renderNode(node)

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function collect(tree, match) {
  const found = []
  walk(tree, node => { if (match(node)) found.push(node) })
  return found
}

function byClass(tree, className) {
  return collect(tree, node => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className))
}

function byTag(tree, tag) {
  return collect(tree, node => node.type === tag)
}

function walkHas(root, target) {
  let found = false
  walk(root, node => { if (node === target) found = true })
  return found
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

function roleEntry(roleId) {
  const resolved = dabResolveAgentRole(roleId)
  return {
    roleId,
    roleLabel: resolved.role.label,
    family: resolved.role.family,
    source: 'explicit',
    inference: null,
    raw: roleId,
  }
}

function projectionFixture() {
  return buildProjection({ ...photoScenario(), now: NOW })
}

function cockpitModel(projection, extra = {}) {
  const view = buildBoardView(projection, { now: NOW })
  const hierarchy = buildHierarchyView(projection, view, null, { mode: 'off' })
  const counts = boardCounts(projection)
  const overview = buildOverview(projection, {
    filter: 'attention', query: '', project: null, dismissed: new Set(),
    roles: hierarchy.roles, taskStates: null, taskTitles: null,
    filters: { role: null, status: null, taskState: null }, focus: null, now: NOW,
  })
  return { view, hierarchy, counts, overview, ...extra }
}

const noopArbiter = { click: () => {}, doubleClick: () => {}, open: () => {}, select: () => {} }

function cardTree(entry, overrides = {}) {
  return render(cockpit.DabGlobalCard({
    entry,
    ctx: { arbiter: noopArbiter, selectedId: null, nowBucket: 0 },
    compact: false,
    selected: false,
    ...overrides,
  }))
}

function toolbarProps(overrides = {}) {
  const projection = projectionFixture()
  const { counts } = cockpitModel(projection)
  return {
    counts,
    agentTotal: 7,
    visibleCount: 3,
    mode: 'off',
    busy: false,
    hostDown: false,
    canStop: false,
    stopped: false,
    secondary: false,
    ui: { filter: 'attention', query: '', project: null, compact: false, viewMode: 'global', roleFilter: null, statusFilter: null, taskStateFilter: null },
    setUi: () => {},
    projects: [{ id: 'ws:w-ravum', title: 'Ravum', agents: 3 }],
    narrow: false,
    taskStateAvailable: false,
    taskStateUnavailableReason: 'no taskboard',
    onMode: () => {}, onStop: () => {}, onResume: () => {}, onRefresh: () => {},
    onHistory: () => {}, onToggleCompact: () => {},
    ...overrides,
  }
}

// ---------------------------------------------------------------- sources
test('the cockpit modules keep the plain-script, no-sink contract', () => {
  for (const relative of ['src/client/ui/overview.js', 'src/client/ui/superbar.js', 'src/client/ui/inspector.js', 'src/client/ui/toolbar.js', 'src/client/app.js']) {
    const source = sources.get(relative) ?? ''
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, `${relative}: no HTML sink`)
    assert.doesNotMatch(source, /\binnerHTML\s*=/, `${relative}: no innerHTML assignment`)
    assert.doesNotMatch(source, /<[a-z][\w-]*\s+[^>]*>/i, `${relative}: no JSX`)
    assert.match(source, /React\.createElement/, `${relative}: plain createElement`)
  }
})

// ---------------------------------------------------------------- toolbar
test('desktop toolbar: one compact header, one filter row, existing controls preserved', () => {
  const tree = render(cockpit.DabToolbar(toolbarProps()))
  assert.equal(tree.type, 'header')
  assert.equal(byClass(tree, 'dab-head').length, 1)
  assert.equal(byClass(tree, 'dab-filters').length, 1)
  // Title + cockpit subtitle with the REAL agent count.
  assert.equal(textOf(byClass(tree, 'dab-title')[0]), 'Agent Board')
  assert.match(textOf(byClass(tree, 'dab-subtitle')[0]), /Cockpit/)
  // The header counts AGENTS (non-blank), not every session row.
  assert.match(textOf(byClass(tree, 'dab-subtitle')[0]), /7 agents/)
  // Search works on agent, project, task.
  const input = byTag(tree, 'input')[0]
  assert.equal(input.props.type, 'search')
  assert.match(input.props.placeholder, /agent/i)
  // The three view filters + the history entry.
  const chips = byClass(tree, 'dab-chip-btn')
  assert.deepEqual(chips.map(chip => textOf(chip)), ['Live', 'All', 'Needs action', 'History'])
  assert.equal(chips[0].props['aria-pressed'], 'true')
  // The view switch keeps global as the default and exposes the 3 real views.
  const views = byClass(tree, 'dab-viewswitch')[0]
  const viewButtons = byTag(views, 'button')
  assert.deepEqual(viewButtons.map(button => textOf(button)), ['Overview', 'Projects', 'Hierarchy'])
  assert.equal(viewButtons[0].props['aria-pressed'], 'true')
  // No global Observe/Supervised/Autonomous switch: autonomy is per project.
  assert.equal(byClass(tree, 'dab-mode').length, 0)
  // Stop is never hidden, only disabled when nothing runs.
  const stop = byClass(tree, 'dab-stop')[0]
  assert.ok(stop !== undefined)
  assert.equal(stop.props.disabled, true)
  assert.equal(byClass(tree, 'dab-live').length, 1)
})

test('desktop toolbar: stop becomes actionable while an execution runs', () => {
  const tree = render(cockpit.DabToolbar(toolbarProps({ canStop: true })))
  assert.equal(byClass(tree, 'dab-stop')[0].props.disabled, false)
})

test('narrow toolbar: one-line header, stop reachable, no five-row stack', () => {
  const tree = render(cockpit.DabToolbar(toolbarProps({ narrow: true, canStop: true })))
  // No global mode switch on mobile either.
  assert.equal(byClass(tree, 'dab-mode').length, 0)
  // The critical stop control stays in the header.
  assert.equal(byClass(tree, 'dab-stop').length, 1)
  assert.equal(byClass(tree, 'dab-stop')[0].props.disabled, false)
  // Search + view switch + chips, not five stacked rows.
  assert.equal(byTag(tree, 'input').length, 1)
  assert.equal(byClass(tree, 'dab-viewswitch').length, 1)
  assert.equal(byClass(tree, 'dab-chips').length, 1)
  // Three popovers replace the secondary controls: settings, filters, more.
  assert.equal(byClass(tree, 'dab-menu').length, 3)
})

test('narrow toolbar: the filters trigger sits on the chip row, right of History', () => {
  const tree = render(cockpit.DabToolbar(toolbarProps({ narrow: true })))
  const chipRow = byClass(tree, 'dab-chiprow')[0]
  assert.ok(chipRow !== undefined, 'the chip row exists')
  assert.deepEqual(byClass(chipRow, 'dab-chip-btn').map(chip => textOf(chip)), ['Live', 'All', 'Needs action', 'History'])
  // One single filters popover, inside the chip row and AFTER the history chip.
  const inRow = byClass(chipRow, 'dab-menu')
  assert.equal(inRow.length, 1)
  assert.match(inRow[0].props.className, /dab-menu-chips/)
  assert.equal(chipRow.children[chipRow.children.length - 1], inRow[0], 'filters come after History')
  assert.equal(byTag(inRow[0], 'button')[0].props['aria-label'], 'Filters')
  // The header keeps the settings and the orchestrator menu only: the filter
  // bar ends on the view switch, the popover lives in the chip row.
  const bar = byClass(tree, 'dab-filters')[0]
  const last = bar.children[bar.children.length - 1]
  assert.equal(byClass(last, 'dab-viewswitch').length, 1, 'no second filters trigger at the end of the bar')
})

test('icon-only view switch: three square targets, no hidden label, explicit names', () => {
  const narrow = render(cockpit.DabToolbar(toolbarProps({ narrow: true, iconOnly: true })))
  const views = byClass(narrow, 'dab-viewswitch')[0]
  assert.equal(views.props['data-icons'], 'true')
  // The label leaves the DOM entirely: nothing can shift the pictogram.
  assert.equal(byClass(views, 'dab-seg-text').length, 0)
  const buttons = byTag(views, 'button')
  assert.deepEqual(buttons.map(button => button.props['aria-label']), ['Overview', 'Projects', 'Hierarchy'])
  assert.equal(buttons[0].props['aria-pressed'], 'true')
  // A wide toolbar keeps the visible labels.
  const wide = render(cockpit.DabToolbar(toolbarProps()))
  assert.equal(byClass(byClass(wide, 'dab-viewswitch')[0], 'dab-seg-text').length, 3)
  assert.equal(byClass(wide, 'dab-viewswitch')[0].props['data-icons'], 'false')
})

test('a legacy preference cannot pin the pre-cockpit projects default', () => {
  const store = new Map()
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  try {
    // Payload written before the cockpit shipped: the projects tree was the
    // default. It must not survive the upgrade; explicit filters must.
    store.set(cockpit.DAB_UI_KEY, JSON.stringify({ viewMode: 'projects', filter: 'all', roleFilter: 'generic' }))
    const migrated = cockpit.dabReadUi()
    assert.equal(migrated.viewMode, 'global')
    assert.equal(migrated.filter, 'all')
    assert.equal(migrated.roleFilter, 'generic')
    // The next write stamps the schema, so an EXPLICIT choice made after the
    // upgrade is honoured again.
    cockpit.dabWriteUi(migrated)
    const written = JSON.parse(store.get(cockpit.DAB_UI_KEY))
    assert.equal(written.schema, 2)
    store.set(cockpit.DAB_UI_KEY, JSON.stringify({ ...written, viewMode: 'projects' }))
    assert.equal(cockpit.dabReadUi().viewMode, 'projects')
    // No stored value at all: the cockpit.
    store.clear()
    assert.equal(cockpit.dabReadUi().viewMode, 'global')
  } finally {
    delete globalThis.localStorage
  }
})

// ---------------------------------------------------------------- indicators
test('the four indicators come from the model and are mutually exclusive', () => {
  const { overview } = cockpitModel(projectionFixture())
  const tree = render(cockpit.DabOverviewStats({ counts: overview.counts, focus: null, onFocus: () => {}, reviewAvailable: false, reviewReason: 'ledger unreadable' }))
  const stats = byClass(tree, 'dab-stat')
  assert.equal(stats.length, 4)
  assert.deepEqual(stats.map(stat => stat.props['data-bucket']), ['active', 'attention', 'review', 'other'])
  // A Task Board that cannot be read shows an explicit dash, never a fake 0.
  assert.equal(textOf(byTag(stats[2], 'strong')[0]), '—')
  assert.equal(stats[2].props['data-disabled'], 'true')
  assert.equal(stats[2].props.disabled, true, 'an unavailable indicator is a disabled control, not a div')
  assert.equal(stats[2].props['aria-disabled'], 'true')
  assert.match(stats[2].props['aria-label'], /ledger unreadable/, 'the real reason is in the accessible name')
  assert.equal(stats[2].props.title, 'ledger unreadable')
  const total = overview.counts.active + overview.counts.attention + overview.counts.review + overview.counts.other
  assert.equal(total, overview.counts.agents, 'every agent counted exactly once')
})

test('clicking an indicator narrows the grid, clicking it again clears it', () => {
  const calls = []
  const counts = { active: 2, attention: 1, review: 0, other: 3, shown: 6, agents: 6 }
  const tree = render(cockpit.DabOverviewStats({ counts, focus: 'attention', onFocus: value => calls.push(value), reviewAvailable: true }))
  const stats = byClass(tree, 'dab-stat')
  assert.equal(stats.find(stat => stat.props['data-bucket'] === 'attention').props['aria-pressed'], 'true')
  stats.find(stat => stat.props['data-bucket'] === 'attention').props.onClick()
  stats.find(stat => stat.props['data-bucket'] === 'active').props.onClick()
  assert.deepEqual(calls, [null, 'active'])
})

// ---------------------------------------------------------------- cards
test('global card: role mascot, separate status, project, task and descendant badge', () => {
  const projection = projectionFixture()
  const { overview } = cockpitModel(projection)
  const entry = overview.entries[0]
  const node = entry.node
  const calls = []
  const tree = cardTree(
    { ...entry, role: roleEntry('worker'), taskTitle: 'Compilation incrémentale' },
    { ctx: { arbiter: { ...noopArbiter, open: id => calls.push(id) }, selectedId: null, nowBucket: 0 } },
  )
  const card = byClass(tree, 'dab-gcard')[0]
  assert.ok(card !== undefined, 'the card is the button-like element')
  assert.equal(card.props.role, 'button')
  assert.equal(card.props['aria-haspopup'], 'dialog', 'the card opens the inspector dialog, it is not a toggle')
  assert.equal(card.props['aria-pressed'], undefined, 'aria-pressed was the wrong semantics')
  assert.equal(card.props['data-role'], 'worker')
  assert.equal(card.props['data-status'], node.status)
  assert.equal(byClass(tree, 'dab-avatar').length, 1)
  assert.equal(byClass(tree, 'dab-avatar-dot').length, 1, 'the status stays a separate dot')
  const images = byTag(tree, 'img')
  assert.equal(images.length, 1)
  assert.match(images[0].props.src, /^data:image\/svg\+xml;base64,/)
  assert.equal(textOf(byClass(tree, 'dab-gcard-name')[0]), node.title)
  assert.match(textOf(byClass(tree, 'dab-gcard-task')[0]), /Compilation incrémentale/)
  const open = byClass(tree, 'dab-gcard-open')[0]
  assert.equal(open.props['aria-label'], `Open session : ${node.title}`)
  assert.equal(walkHas(card, open), false, 'the open button is a SIBLING, not a nested button')
  open.props.onClick({ stopPropagation: () => {} })
  assert.deepEqual(calls, [node.id])
})

test('global card: a deduced role is named as deduced, never as declared', () => {
  const projection = projectionFixture()
  const { overview } = cockpitModel(projection)
  const entry = overview.entries[0]
  const inferred = { roleId: 'verifier', roleLabel: 'Verifier', family: 'validation', source: 'inferred', inference: { rule: 'word:verifi', defaulted: false }, raw: null }
  const tree = cardTree({ ...entry, role: inferred, taskTitle: null })
  const card = byClass(tree, 'dab-gcard')[0]
  assert.equal(card.props['data-role'], 'verifier')
  assert.equal(card.props['data-role-resolution'], 'inferred')
  assert.match(card.props['aria-label'], /deduced/i)
  assert.equal(byClass(tree, 'dab-avatar')[0].props['data-resolution'], 'inferred')
})

test('global card: every approved role keeps its own official mascot', () => {
  const projection = projectionFixture()
  const { overview } = cockpitModel(projection)
  const entry = overview.entries[0]
  const seen = new Set()
  for (const roleId of AGENT_ROLE_IDS) {
    const tree = cardTree({ ...entry, role: roleEntry(roleId) })
    seen.add(byTag(tree, 'img')[0].props.src)
    assert.equal(byClass(tree, 'dab-gcard')[0].props['data-role'], roleId)
    assert.equal(byClass(tree, 'dab-avatar')[0].props['data-role'], roleId)
    assert.ok(AGENT_ROLES[roleId] !== undefined)
  }
  assert.equal(seen.size, AGENT_ROLE_IDS.length, '15 distinct mascots, no substitution')
})

test('global card: the status is also written, not only coloured', () => {
  const projection = projectionFixture()
  const { overview } = cockpitModel(projection)
  const waiting = overview.entries.find(entry => entry.node.status === 'waiting_user')
  assert.ok(waiting !== undefined, 'the photo scenario has a waiting agent')
  const tree = cardTree(waiting)
  assert.equal(textOf(byClass(tree, 'dab-gcard-state')[0]), 'Needs your action')
})

// ---------------------------------------------------------------- sections
test('the inspected card stays pinned while the inspector is open', () => {
  const projection = projectionFixture()
  const calm = projection.nodes.find(node => node.status === 'finished_read' || node.status === 'idle')
  assert.ok(calm !== undefined, 'the photo scenario has a calm session')
  const base = { filter: 'attention', query: '', project: null, dismissed: new Set(), roles: null, taskStates: null, taskTitles: null, filters: { role: null, status: null, taskState: null }, focus: null, now: NOW }
  const without = buildOverview(projection, base)
  assert.equal(without.entries.some(entry => entry.node.id === calm.id), false, 'a calm session is not in the current-work view')
  const pinned = buildOverview(projection, { ...base, selectedId: calm.id })
  assert.equal(pinned.entries.some(entry => entry.node.id === calm.id), true, 'the inspected node stays visible')
  // The pin still respects the project filter: another project never leaks in.
  const other = buildOverview(projection, { ...base, selectedId: calm.id, project: 'ws:w-dw' })
  assert.equal(other.entries.some(entry => entry.node.id === calm.id), calm.projectId === 'ws:w-dw')
})

test('global overview: attention first, then running, then other, no empty section', () => {
  const projection = projectionFixture()
  const { overview } = cockpitModel(projection)
  const tree = render(cockpit.DabGlobalOverview({ overview, ctx: { arbiter: noopArbiter, selectedId: null, nowBucket: 0 }, compact: false, empty: null }))
  const sections = byClass(tree, 'dab-section')
  const ids = sections.map(section => section.props['data-section'])
  const rank = id => ['attention', 'running', 'other'].indexOf(id)
  assert.deepEqual(ids, ids.slice().sort((a, b) => rank(a) - rank(b)))
  for (const section of sections) {
    const grid = byClass(section, 'dab-agent-grid')
    assert.equal(grid.length, 1)
    assert.equal(byClass(section, 'dab-gcard').length, collect(section, node => node.props?.role === 'listitem').length)
  }
  // Every flat entry of the model is rendered exactly once.
  assert.equal(byClass(tree, 'dab-gcard').length, overview.entries.length)
})

test('global overview: the empty state is the caller-provided node', () => {
  const empty = { type: 'div', props: { className: 'dab-empty' }, children: ['nothing'] }
  const tree = render(cockpit.DabGlobalOverview({ overview: { sections: [] }, ctx: {}, compact: false, empty }))
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dab-empty')
})

test('the cockpit model keeps a 150-agent projection bounded and complete', () => {
  const projection = buildProjection({ ...largeScenario({ history: 120, active: 30 }), now: NOW })
  const { overview } = cockpitModel(projection)
  assert.equal(overview.counts.agents, projection.nodes.filter(node => node.blank !== true).length)
  assert.equal(overview.counts.active + overview.counts.attention + overview.counts.review + overview.counts.other, overview.counts.agents)
  assert.ok(overview.entries.length >= 1)
})

test('rendering 150 cockpit cards stays bounded (component cost, not browser paint)', () => {
  const projection = buildProjection({ ...largeScenario({ history: 120, active: 30 }), now: NOW })
  const view = buildBoardView(projection, { now: NOW, filter: 'all' })
  const hierarchy = buildHierarchyView(projection, view, null, { mode: 'off' })
  const overview = buildOverview(projection, {
    filter: 'all', query: '', project: null, dismissed: new Set(), roles: hierarchy.roles,
    taskStates: null, taskTitles: null, filters: { role: null, status: null, taskState: null }, focus: null, now: NOW,
  })
  assert.ok(overview.entries.length >= 100, `the fixture renders a large board (${overview.entries.length} entries)`)
  const started = performance.now()
  const tree = render(cockpit.DabGlobalOverview({ overview, ctx: { arbiter: noopArbiter, selectedId: null, nowBucket: 0 }, compact: false, empty: null }))
  const elapsed = performance.now() - started
  assert.equal(byClass(tree, 'dab-gcard').length, overview.entries.length, 'every entry is rendered once')
  // Deliberately generous: this is a regression guard for accidental O(n^2)
  // work in the render tree (the browser paint is measured separately).
  assert.ok(elapsed < 1000, `rendering ${overview.entries.length} cards took ${elapsed.toFixed(1)} ms`)
})

// ---------------------------------------------------------------- super bar
test('super bar: real layer, real orchestrators, no invented agent', () => {
  const projection = projectionFixture()
  const { hierarchy, counts } = cockpitModel(projection)
  const tree = render(cockpit.DabSuperOrchestratorBar({
    workspace: hierarchy.workspace, totals: hierarchy.totals, projects: hierarchy.projects, orchestrators: hierarchy.orchestrators, mode: 'off',
    open: false, onToggle: () => {}, onSelect: () => {}, compact: false,
  }))
  assert.equal(byClass(tree, 'dab-super').length, 1)
  assert.match(textOf(tree), /Super Orchestrator/)
  assert.equal(byClass(tree, 'dab-super-mascot').length, 1)
  // Collapsed: the layer marker is not repeated next to the agent state; it
  // appears with the supervision details once the card is open.
  assert.equal(byClass(tree, 'dab-super-layer').length, 0)
  const opened = render(cockpit.DabSuperOrchestratorBar({
    workspace: hierarchy.workspace, totals: hierarchy.totals, projects: hierarchy.projects, orchestrators: hierarchy.orchestrators, mode: 'off',
    open: true, onToggle: () => {}, onSelect: () => {}, compact: false,
  }))
  assert.equal(byClass(opened, 'dab-super-layer').length, 1)
  assert.match(textOf(opened), /Supervision/, 'the opened band says it is the supervision layer, not an agent')
  // The body is always in the DOM for aria-controls, hidden while collapsed.
  const body = byClass(tree, 'dab-band-body')[0]
  assert.equal(body.props.hidden, true)
  assert.equal(body.props.id, 'dab-super-body')
  // Real declared orchestrators only; no fabricated avatar.
  const minis = byClass(tree, 'dab-super-orch')
  const declared = hierarchy.orchestrators.length
  assert.equal(minis.length, Math.min(6, declared))
  // Collapsed: no empty-state sentence; the opened card says it.
  if (declared === 0) assert.match(textOf(opened), /No project orchestrator declared/)
  assert.equal(counts.total, counts.running + counts.waiting + counts.unread + counts.failed + counts.interrupted + counts.provider_unavailable + counts.history)
})

test('super bar: expanding shows the shared supervision body and mini avatars select', () => {
  const projection = projectionFixture()
  const { hierarchy } = cockpitModel(projection)
  const selected = []
  const tree = render(cockpit.DabSuperOrchestratorBar({
    workspace: hierarchy.workspace, totals: hierarchy.totals, projects: hierarchy.projects, orchestrators: hierarchy.orchestrators, mode: 'supervised',
    open: true, onToggle: () => {}, onSelect: id => selected.push(id), compact: false,
  }))
  assert.equal(byClass(tree, 'dab-band-body')[0].props.hidden, false)
  assert.ok(textOf(tree).includes('Capabilities'))
  const minis = byClass(tree, 'dab-super-orch')
  if (minis.length > 0) {
    minis[0].props.onClick()
    assert.equal(selected.length, 1)
    assert.equal(typeof selected[0], 'string')
  }
})

test('super bar: the AI session is a state distinct from the supervision layer', () => {
  const projection = projectionFixture()
  const { hierarchy } = cockpitModel(projection)
  const superagent = {
    identity: { level: 'L2', status: 'idle', model: { provider: 'deepseek', model: 'v4' } },
    session: { active: false, sessionId: null },
    decisions: [],
    directives: [],
    activity: [],
    budget: {},
  }
  const mandate = {
    scopeMode: 'selected', selectedWorkspaces: ['ws:w-ravum'], level: 'L2', paused: false,
    projects: { 'ws:w-ravum': { enabled: true, level: 'L1' }, 'ws:w-dw': { enabled: false, level: 'L0' } },
  }
  const tree = render(cockpit.DabSuperOrchestratorBar({
    workspace: hierarchy.workspace, totals: hierarchy.totals, projects: hierarchy.projects, orchestrators: hierarchy.orchestrators,
    mode: 'supervised', open: false, onToggle: () => {}, onSelect: () => {}, compact: false,
    superagent, mandate, capabilities: null, stopped: false, busy: false,
    onStart: () => {}, onPause: () => {}, onStop: () => {}, onResume: () => {},
  }))
  // Collapsed: no layer marker beside the agent chip (it lives in the opened card).
  assert.equal(byClass(tree, 'dab-super-layer').length, 0)
  const session = byClass(tree, 'dab-super-ai')
  assert.equal(session.length, 1)
  assert.equal(session[0].props['data-session-active'], 'false')
  assert.equal(session[0].props['data-session-state'], 'notStarted')
  assert.match(textOf(byClass(tree, 'dab-super-ai-state')[0]), /session not started/)
  // Real AI facts: model, level, enabled/total projects.
  assert.match(textOf(byClass(tree, 'dab-super-model')[0]), /deepseek\/v4/)
  // Label and value only once: never 'Level Level L2'.
  // A coloured dot + the level NAME; the internal code never shows.
  assert.equal(textOf(byClass(tree, 'dab-super-level')[0]), 'LevelSupervised')
  assert.equal(byClass(tree, 'dab-level')[0].props['data-level'], 'L2')
  assert.match(textOf(byClass(tree, 'dab-super-enabled')[0]), /1\/2 projects enabled/)
  // No decision counter without a real pending decision.
  assert.equal(byClass(tree, 'dab-super-decisions').length, 0)
  // The primary control is a reachable sibling of the collapsible body.
  const primary = collect(tree, node => node.props?.['data-primary'] === 'true')
  assert.equal(primary.length, 1)
  assert.equal(walkHas(byClass(tree, 'dab-band-body')[0], primary[0]), false, 'controls live in the band, not in the collapsed body')
})

test('cockpit CSS: Super Agent surfaces keep a visible focus ring and mobile controls', () => {
  const css = cockpit.DAB_CSS
  assert.match(css, /\.dab-super-ctrl:focus-visible/)
  assert.match(css, /\.dab-sa-tab-btn:focus-visible/)
  assert.match(css, /\.dab-sa-panel \{ width: min\(560px/)
  assert.match(css, /\.dab-super-controls \{ order: 3; flex: 1 1 100%; \}/)
  assert.match(css, /\.dab-super-ctrl \{ min-height: 34px; flex: 1 1 auto; \}/)
  assert.match(css, /\.dab-sa-panel, \.dab-super-ctrl \{ transition: none; \}/)
})

// ---------------------------------------------------------------- inspector
test('inspector: modal dialog wrapping the existing preview', () => {
  const projection = projectionFixture()
  const node = projection.nodes.find(candidate => candidate.status === 'waiting_user')
  const tree = render(cockpit.DabInspector({
    node, parent: null, role: null, taskState: null,
    onOpen: () => {}, onSelect: () => {}, onClose: () => {}, openError: '', onDismiss: () => {}, dismissed: false, narrow: false,
  }))
  const panel = byClass(tree, 'dab-insp-panel')[0]
  assert.equal(panel.props.role, 'dialog')
  assert.equal(panel.props['aria-modal'], 'true')
  assert.match(panel.props['aria-label'], /Agent details/)
  assert.equal(byClass(tree, 'dab-insp-scrim').length, 1)
  // The content is the EXISTING preview: no second implementation of the facts.
  assert.equal(byClass(panel, 'dab-inspector').length, 1)
  const open = collect(panel, candidate => candidate.props?.['data-testid'] === 'dab-open')
  assert.equal(open.length, 1, 'opening the session stays an explicit button')
})

// ---------------------------------------------------------------- styles
test('cockpit CSS: panel-width responsive, theme tokens, adaptive grids', () => {
  const css = cockpit.DAB_CSS
  assert.match(css, /container-name: dab/)
  assert.match(css, /@container dab \(max-width: 720px\)/)
  assert.match(css, /\.dab-agent-grid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 248px\), 1fr\)\)/)
  assert.match(css, /\.dab-agent-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /\.dab-insp-panel \{ position: absolute; top: 8px; right: 8px; bottom: 8px;/)
  assert.match(css, /\.dab-insp-panel \{ top: auto; left: 0; right: 0; bottom: 0;/)
  assert.match(css, /env\(safe-area-inset-bottom/)
  // The preview must stay IN FLOW inside the sheet: an absolute preview collapses
  // the bottom sheet to its grip (regression caught on the integrated host).
  assert.match(css, /\.dab-insp-panel \.dab-inspector \{ position: static; inset: auto;/)
  // The narrow filter popover is clamped to the panel, never outside the screen.
  assert.match(css, /\.dab-menu\.dab-menu-chips \.dab-menu-pop \{ left: 10px; right: 10px;/)
  // Icon-only views are identical rectangles, and SQUARE on touch.
  assert.match(css, /\.dab-viewswitch\[data-icons="true"\] \.dab-seg-btn \{ width: 34px; height: 30px;/)
  assert.match(css, /\.dab-viewswitch\[data-icons="true"\] \.dab-seg-btn \{ width: 40px; height: 40px; \}/)
  // The status dot stays bottom-left, clear of the role pictogram.
  assert.match(css, /\.dab-avatar-dot \{ position: absolute; left: 0; right: auto; bottom: 0;/)
  // Motion is opt-out.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  // Theme tokens only: no hard-coded mockup palette.
  assert.doesNotMatch(css, /--dab-cockpit-bg|#0e1116|#0b0f14|#151a21/i)
  assert.match(css, /var\(--dsw-alias-/)
  // The attention accents are attribute-driven, never inline colours.
  assert.match(css, /\.dab-gcard\[data-status="waiting_user"\]/)
  assert.match(css, /\.dab-gcard\[data-status="failed"\]\[data-seen="false"\]/)
})

test('the responsive contract documents every width the mockup targets', async () => {
  const source = await readFile(join(ROOT, 'docs', 'UX-COCKPIT-CONTRACT.md'), 'utf8')
  for (const width of ['1920', '1366', '1024', '768', '720', '600', '430', '390', '360', '320']) assert.match(source, new RegExp(width))
  assert.match(source, /bottom-left/)
  assert.match(source, /in_review/)
})
