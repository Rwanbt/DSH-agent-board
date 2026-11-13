/**
 * GOAL 6 — Super Agent cockpit tests.
 *
 * Same harness as tests/cockpit-render.test.js: the authored modules are
 * concatenated (imports/exports stripped) and evaluated with a minimal React
 * stub. These tests pin the NEW payload contract:
 *
 *   - an old host payload (no `superagent`) renders honest "non disponible"
 *     fallbacks and never crashes;
 *   - `session.active === false` is NEVER rendered as an active agent;
 *   - a capability the payload refuses is never painted available, and its
 *     reason is displayed;
 *   - the decision counter only appears when a real decision is pending;
 *   - the store posts to the contract routes with plain JSON (no CSRF header);
 *   - a dry-run is a GET and never mutates the shared state;
 *   - lists are bounded with an explicit "+N";
 *   - Stop stays reachable in the mobile band;
 *   - icon-only controls and tabs carry real accessible names.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBoardStore, pendingDecisionCountOf, superagentOf } from '../src/client/core.js'

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
  dabT, DAB_STRINGS, DAB_CSS,
  setLang: value => { DAB_LANG = value },
  DabSuperOrchestratorBar, DabSupervisionBody,
  DabSuperagentInspector, DabSuperagentOverview, DabSuperagentProjects,
  DabSuperagentDirectives, DabSuperagentSettings, DabSuperagentDecisions, DabAllProjectsConfirm,
  dabSuperagentFacts, dabProjectPolicyRows, dabEffectiveCapabilities, dabCapabilityEntry,
  dabActionRefusalReason, dabSuperagentPortfolio, dabDecisionGroups, dabAllProjectsConfirmValid,
  dabSaBound, dabReasonText, dabLevelLabel, dabLevelHint, dabLevelOptions, DabSuperagentModelEditor, DabSelect, DabSelfTest,
}`

const cockpit = new Function('React', CODE)(React)

// ---------------------------------------------------------------- harness
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

/** Pick an option of a themed DabSelect (the list is in the DOM, hidden). */
function pickOption(select, value) {
  const option = collect(select, node => node.props?.role === 'option' && node.props['data-value'] === value)[0]
  assert.ok(option !== undefined, `option ${value} exists`)
  option.props.onClick()
}
const optionValues = select => collect(select, node => node.props?.role === 'option').map(node => node.props['data-value'])

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

// ---------------------------------------------------------------- fixtures
const WORKSPACE = {
  status: 'idle', available: true, emblem: 'crown', reason: null,
  recommendations: [], blocks: [], crossProjectDependencies: [],
  taskboard: { available: true }, capabilities: {}, capabilityReasons: {},
  delegation: null, agent: null,
}
const TOTALS = { projects: 1, agents: 1, dependencies: 0 }

function makeDecision(overrides = {}) {
  return {
    id: 'dec-1', kind: 'high_impact', projectId: 'ws:a', title: 'Autoriser le lancement ?',
    context: 'La tâche t-1 est prête', action: 'launch', taskIds: ['t-1'],
    options: [{ id: 'approve', label: 'Approuver', effect: 'lance la tâche' }, { id: 'reject', label: 'Refuser', effect: 'aucune action' }],
    recommendation: 'approve', urgency: 'urgent', expiresAt: 1800000000000, status: 'pending',
    createdAt: 1700000000000, answeredAt: null, answer: null, ...overrides,
  }
}

function makeInactiveSuperagent(overrides = {}) {
  return {
    identity: {
      agentId: 'super-agent-1', name: 'Super Agent', createdAt: 1700000000000,
      model: { provider: 'deepseek', model: 'v4', fallback: [{ provider: 'other', model: 'm2' }] },
      level: 'L2', status: 'idle', generation: 1,
    },
    session: { sessionId: null, active: false, createdAt: null, endedAt: null, recycledCount: 0, recycleReason: null, lastTurnAt: null, lastError: null },
    memory: { facts: [], decisions: [], digest: null },
    directives: [],
    decisions: [],
    plan: { revision: 1, updatedAt: 1700000000000, objectives: [], nextActions: [], idleReason: 'aucun travail prêt' },
    activity: [],
    budget: {
      cyclesPerHour: 6, cyclesThisHour: 1, concurrentAgents: 0, maxConcurrentAgents: 2,
      modelCallsPerHour: 12, modelCallsThisHour: 0, tokenBudget: null,
      metricAvailability: { tokens: false, cost: false, calls: true, cycles: true },
    },
    lastCycle: null, nextWakeAt: null,
    runtime: { available: true, reason: null, modelDiscovery: 'live' },
    ...overrides,
  }
}

function makeActiveSuperagent(status = 'thinking') {
  return makeInactiveSuperagent({
    identity: { ...makeInactiveSuperagent().identity, status },
    session: { sessionId: 'sess-1', active: true, createdAt: 1700000000000, endedAt: null, recycledCount: 0, recycleReason: null, lastTurnAt: 1700000100000, lastError: null },
  })
}

function makeMandate(overrides = {}) {
  return {
    version: 2, scopeMode: 'selected', selectedWorkspaces: ['ws:a'],
    allConsent: null, level: 'L1', paused: false, requiresConfiguration: false,
    actions: {
      comment: false, create_task: false, update_task: false, launch: false, delegate: false,
      schedule: false, push_branch: false, open_pr: false, merge: false,
      protected_branch_write: false, delete_task: false, secrets: false, policy_change: false,
    },
    projects: {
      'ws:a': { enabled: true, level: 'L1', priority: 2, model: null, budget: { maxTasksPerHour: 3 }, note: '' },
      'ws:b': { enabled: false, level: 'L0', priority: 5, model: null, budget: { maxTasksPerHour: 1 }, note: '' },
    },
    revision: 4, updatedAt: 1700000000000, updatedBy: 'operator', migratedFrom: null,
    ...overrides,
  }
}

function makeHost(overrides = {}) {
  return {
    projects: [
      { id: 'ws:a', title: 'Projet A', source: 'dsh-workspace' },
      { id: 'ws:b', title: 'Projet B', source: 'dsh-workspace' },
    ],
    models: { discovered: true, providers: [{ id: 'deepseek', models: [{ id: 'v4' }] }], reason: null },
    reconcileNotes: [{ message: 'reconciled: 0 orphan' }],
    taskboardPublic: { configured: true, reachable: true, reason: null },
    ...overrides,
  }
}

function bandProps(overrides = {}) {
  return {
    workspace: WORKSPACE, totals: TOTALS, projects: [], orchestrators: [], mode: 'supervised',
    open: false, onToggle: () => {}, onSelect: () => {}, compact: false,
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), capabilities: {},
    stopped: false, busy: false,
    onStart: () => {}, onPause: () => {}, onStop: () => {}, onResume: () => {},
    onOpenSuperagent: () => {},
    ...overrides,
  }
}

function band(overrides = {}) {
  return render(cockpit.DabSuperOrchestratorBar(bandProps(overrides)))
}

// ---------------------------------------------------------------- old payload
test('old payload without superagent: no crash, honest fallbacks everywhere', () => {
  const facts = cockpit.dabSuperagentFacts(null, null, {})
  assert.equal(facts.available, false)
  assert.equal(facts.stateKey, 'unavailable')
  assert.equal(facts.pendingCount, 0)
  assert.equal(facts.sessionActive, false)

  const tree = band({ superagent: null, mandate: null, capabilities: null })
  const session = byClass(tree, 'dab-super-ai')[0]
  assert.ok(session !== undefined)
  assert.equal(session.props['data-session-active'], 'false')
  assert.equal(session.props['data-session-state'], 'unavailable')
  assert.match(textOf(tree), /Super Agent · session not published/)
  assert.equal(byClass(tree, 'dab-super-decisions').length, 0, 'no invented decision counter')

  const projects = render(cockpit.DabSuperagentProjects({ superagent: null, mandate: null, host: {}, context: { mode: 'off' } }))
  assert.ok(byClass(projects, 'dab-sa-unavailable').length >= 1)
  assert.match(textOf(projects), /Super Agent not published by the host/)
  assert.ok(collect(projects, node => node.props?.title === 'superagent_not_published').length >= 1, 'raw code kept as a tooltip')

  const directives = render(cockpit.DabSuperagentDirectives({ superagent: null, portfolio: [] }))
  assert.match(textOf(directives), /No directive recorded/)
  assert.equal(byClass(directives, 'dab-sa-examples')[0] !== undefined, true)

  const settings = render(cockpit.DabSuperagentSettings({ superagent: null, mandate: null, host: {}, context: { mode: 'off' }, ui: {}, taskboard: null }))
  assert.match(textOf(settings), /models not discovered yet/)
  assert.match(textOf(settings), /not available/)

  // The store accepts the same old frame: normalized fields are null, no crash.
  assert.equal(superagentOf({ mode: 'off' }), null)
  assert.equal(pendingDecisionCountOf(null), 0)
})

// ---------------------------------------------------------------- inactivity
test('inactive session is never rendered as active; active state is distinct', () => {
  const inactive = cockpit.dabSuperagentFacts(makeInactiveSuperagent(), makeMandate(), {})
  assert.equal(inactive.sessionActive, false)
  assert.equal(inactive.stateKey, 'notStarted')
  assert.equal(inactive.stateLabelKey, 'superStateNotStarted')

  const inactiveTree = band()
  assert.equal(byClass(inactiveTree, 'dab-super-ai')[0].props['data-session-active'], 'false')
  assert.match(textOf(byClass(inactiveTree, 'dab-super-ai-state')[0]), /session not started/)
  // Nothing runs: Start is the single primary action, Pause and Resume are
  // not offered, and the band shows no Stop (the toolbar keeps the global one).
  const controls = collect(inactiveTree, node => node.props?.['data-action'] !== undefined)
  assert.equal(controls.find(node => node.props['data-action'] === 'pause'), undefined)
  assert.equal(controls.find(node => node.props['data-action'] === 'resume'), undefined)
  assert.equal(controls.find(node => node.props['data-action'] === 'start').props.disabled, false)
  assert.equal(controls.find(node => node.props['data-action'] === 'start').props['data-primary'], 'true')
  assert.equal(controls.filter(node => node.props['data-primary'] === 'true').length, 1)
  assert.equal(controls.find(node => node.props['data-action'] === 'stop'), undefined)
  // Running: the same slot becomes Pause, and Stop appears in the same neutral style.
  const runningControls = collect(band({ superagent: makeActiveSuperagent('active') }), node => node.props?.['data-action'] !== undefined)
  assert.equal(runningControls.find(node => node.props['data-action'] === 'pause').props['data-primary'], 'true')
  assert.equal(runningControls.find(node => node.props['data-action'] === 'start'), undefined)
  assert.equal(runningControls.find(node => node.props['data-action'] === 'stop').props.disabled, false)
  assert.equal(runningControls.find(node => node.props['data-action'] === 'stop').props['data-danger'], undefined)

  const thinking = cockpit.dabSuperagentFacts(makeActiveSuperagent('thinking'), makeMandate(), {})
  assert.equal(thinking.sessionActive, true)
  assert.equal(thinking.stateKey, 'thinking')
  const thinkingTree = band({ superagent: makeActiveSuperagent('thinking') })
  assert.equal(byClass(thinkingTree, 'dab-super-ai')[0].props['data-session-active'], 'true')
  assert.match(textOf(byClass(thinkingTree, 'dab-super-ai-state')[0]), /thinking/)
  assert.equal(collect(thinkingTree, node => node.props?.['data-action'] === 'pause')[0].props.disabled, false)

  const waiting = cockpit.dabSuperagentFacts(makeActiveSuperagent('waiting_human'), makeMandate(), {})
  assert.equal(waiting.stateKey, 'waiting')
  assert.equal(waiting.stateLabelKey, 'superStateWaiting')

  const stopped = cockpit.dabSuperagentFacts(makeInactiveSuperagent(), makeMandate(), { stopped: true })
  assert.equal(stopped.stateKey, 'stopped')
  // No in-flight work + Stop => "Stopped (observing)", not "Blocked".
  assert.equal(byClass(band({ stopped: true, open: true }), 'dab-super-state-text')[0].children[0], 'Stopped (observing)')
})

// ---------------------------------------------------------------- capabilities
test('capability matrix is derived from the real payload: a refusal is never green', () => {
  const caps = {
    observe: { state: 'available', reason: null },
    delegate: { state: 'gated', reason: null },
    kanbanWrite: { state: 'unavailable', reason: 'taskboard_write_api_unavailable' },
  }
  const off = cockpit.dabEffectiveCapabilities(caps, { mode: 'off' })
  const delegateOff = off.find(row => row.key === 'delegate')
  assert.equal(delegateOff.available, false, 'OFF refuses delegation even when the payload says gated')
  assert.equal(delegateOff.reason, 'mode_off')
  assert.equal(off.find(row => row.key === 'observe').available, true)
  assert.equal(off.find(row => row.key === 'kanbanWrite').reason, 'taskboard_write_api_unavailable')

  assert.equal(cockpit.dabEffectiveCapabilities(caps, { stopped: true }).find(row => row.key === 'delegate').reason, 'stopped_by_operator')
  assert.equal(cockpit.dabEffectiveCapabilities(caps, { scopeMode: 'none' }).find(row => row.key === 'delegate').reason, 'scope_none')
  assert.equal(cockpit.dabEffectiveCapabilities(caps, { paused: true }).find(row => row.key === 'delegate').reason, 'paused_by_operator')
  assert.equal(cockpit.dabEffectiveCapabilities(caps, { requiresConfiguration: true }).find(row => row.key === 'delegate').reason, 'requires_configuration')
  // A legacy string matrix is still read, and an absent matrix is unavailable.
  assert.equal(cockpit.dabCapabilityEntry('delegate', { delegate: 'gated' }, null, null).available, true)
  assert.equal(cockpit.dabCapabilityEntry('delegate', null, null, null).available, false)
  // A `gated` entry carrying a refusal code is refused, not "sous conditions".
  const gatedRefusal = cockpit.dabCapabilityEntry('delegate', { delegate: { state: 'gated', reason: 'mode_off' } }, null, null)
  assert.equal(gatedRefusal.available, false)
  assert.equal(gatedRefusal.reason, 'mode_off')

  const body = render(cockpit.DabSupervisionBody({
    workspace: { ...WORKSPACE, capabilities: caps, capabilityReasons: {}, recommendations: new Array(50).fill({ id: 'r', kind: 'delegate', projectId: 'ws:a' }) },
    totals: TOTALS, projects: [], hidden: false, context: { mode: 'off' },
  }))
  const delegateRow = byClass(body, 'dab-cap-row').find(row => row.props['data-capability'] === 'delegate')
  assert.equal(delegateRow.props['data-available'], 'false')
  assert.equal(delegateRow.props['data-refused'], 'true')
  // The mode line states the refusal once; the cell does not repeat it.
  assert.doesNotMatch(textOf(delegateRow), /mode_off|Observe mode/)
  // A reason that is NOT the mode itself is still shown, as a sentence, code in the tooltip.
  const tbBody = render(cockpit.DabSupervisionBody({
    workspace: { ...WORKSPACE, capabilities: { ...caps, kanbanWrite: { state: 'unavailable', reason: 'taskboard_write_api_unavailable' } }, capabilityReasons: {} },
    totals: TOTALS, projects: [], hidden: false, context: { mode: 'off' },
  }))
  const kanbanRow = byClass(tbBody, 'dab-cap-row').find(row => row.props['data-capability'] === 'kanbanWrite')
  assert.match(textOf(kanbanRow), /Task Board is read-only for now/)
  assert.equal(collect(kanbanRow, node => node.props?.title === 'taskboard_write_api_unavailable').length, 1)
  // F4/F9: the real count stays visible, the 50 inapplicable rows do not.
  assert.match(textOf(body), /Recommendations \(50\)/)
  assert.match(textOf(body), /Stop mode — no action possible/)
  assert.equal(collect(body, node => node.props?.className === 'dab-band-list').length <= 2, true)
})

// ---------------------------------------------------------------- decisions
test('decision counter appears only when a real decision is pending', () => {
  const none = band({ superagent: makeInactiveSuperagent({ decisions: [] }) })
  assert.equal(byClass(none, 'dab-super-decisions').length, 0)

  const answered = makeDecision({ id: 'dec-a', status: 'answered', answeredAt: 1700000200000 })
  const onePending = makeDecision({ id: 'dec-p' })
  const withPending = band({ superagent: makeInactiveSuperagent({ decisions: [answered, onePending] }) })
  const counter = byClass(withPending, 'dab-super-decisions')[0]
  assert.ok(counter !== undefined)
  assert.equal(counter.props['data-count'], '1')
  assert.match(textOf(counter), /1 pending decisions/)

  const emptyInbox = render(cockpit.DabSuperagentDecisions({ superagent: makeInactiveSuperagent({ decisions: [answered] }) }))
  assert.equal(byClass(emptyInbox, 'dab-sa-decisions-count').length, 0, 'answered decisions are not pending')
  const inbox = render(cockpit.DabSuperagentDecisions({ superagent: makeInactiveSuperagent({ decisions: [onePending] }) }))
  assert.equal(byClass(inbox, 'dab-sa-decisions-count')[0].children[0], '1')
  assert.equal(byClass(inbox, 'dab-sa-decision').length, 1)
  // Proposal/scope/risk/impact/recommendation/options/expiry are all visible.
  const text = textOf(inbox)
  for (const label of ['Proposal', 'Scope', 'Risk', 'Impact', 'Recommendation', 'Approuver', 'Refuser']) assert.match(text, new RegExp(label))
  assert.match(text, /No implicit answer/)
})

test('decision answers post to the contract route with the chosen option', async () => {
  const fetchImpl = fakeFetch({})
  const store = createBoardStore({ get: () => undefined }, { fetchImpl, notifyWindowMs: 0 })
  const result = await store.answerDecision('dec/1', 'approve', 'ok')
  assert.equal(result.ok, true)
  const call = fetchImpl.calls.find(entry => entry.init?.method === 'POST')
  assert.ok(call !== undefined)
  assert.match(call.url, /\/superagent\/decisions\/dec%2F1\/answer$/)
  assert.deepEqual(JSON.parse(call.init.body), { optionId: 'approve', note: 'ok' })
})

// ---------------------------------------------------------------- directives
test('directives are a persisted list with add form, revoke and examples', () => {
  const empty = render(cockpit.DabSuperagentDirectives({ superagent: makeInactiveSuperagent(), portfolio: [{ id: 'ws:a', title: 'Projet A' }] }))
  assert.equal(byClass(empty, 'dab-sa-directives-empty').length, 1)
  assert.match(textOf(empty), /persistent instruction/)
  assert.equal(byClass(empty, 'dab-sa-examples')[0].children[1].children.length, 3, 'three real examples')
  assert.equal(byClass(empty, 'dab-sa-directive-input').length, 1)
  assert.equal(byClass(empty, 'dab-sa-directive-add')[0].props.disabled, true, 'an empty directive is not submitted')

  const directives = [
    { id: 'd1', scope: 'global', projectId: null, text: 'Ne jamais merger sans accord', status: 'active', createdAt: 1700000000000, author: 'operator' },
    { id: 'd2', scope: 'project', projectId: 'ws:a', text: 'Prioriser les revues', status: 'active', createdAt: 1700000000000, author: 'operator' },
    { id: 'd3', scope: 'global', projectId: null, text: 'Ancienne consigne', status: 'revoked', createdAt: 1700000000000, author: 'operator' },
  ]
  const calls = []
  const tree = render(cockpit.DabSuperagentDirectives({
    superagent: makeInactiveSuperagent({ directives }), portfolio: [{ id: 'ws:a', title: 'Projet A' }],
    onRevoke: id => calls.push(id), onAdd: () => {},
  }))
  assert.equal(byClass(tree, 'dab-sa-directive').length, 3)
  const revokes = byClass(tree, 'dab-sa-revoke')
  assert.equal(revokes.length, 2, 'only active directives can be revoked')
  assert.match(revokes[0].props['aria-label'], /Revoke : d1/)
  revokes[0].props.onClick()
  assert.deepEqual(calls, ['d1'])
  assert.match(textOf(tree), /revoked/)

  // Truncation: 25 directives => 20 + "+5".
  const many = Array.from({ length: 25 }, (_, index) => ({ id: `d${index}`, scope: 'global', text: `Directive ${index}`, status: 'active', createdAt: 1700000000000 }))
  const bounded = render(cockpit.DabSuperagentDirectives({ superagent: makeInactiveSuperagent({ directives: many }) }))
  assert.equal(byClass(bounded, 'dab-sa-directive').length, 20)
  assert.match(textOf(bounded), /\+5/)
})

test('directive mutations post to the persisted directive routes', async () => {
  const fetchImpl = fakeFetch({})
  const store = createBoardStore({ get: () => undefined }, { fetchImpl, notifyWindowMs: 0 })
  await store.addDirective({ text: 'Ne pas merger', scope: 'project', projectId: 'ws:a' })
  const add = fetchImpl.calls.find(entry => entry.init?.method === 'POST' && entry.url.endsWith('/superagent/directives'))
  assert.ok(add !== undefined)
  assert.deepEqual(JSON.parse(add.init.body), { text: 'Ne pas merger', scope: 'project', projectId: 'ws:a' })
  await store.revokeDirective('d 1')
  const revoke = fetchImpl.calls.find(entry => entry.url.includes('/revoke'))
  assert.match(revoke.url, /\/superagent\/directives\/d%201\/revoke$/)
  assert.equal(revoke.init.headers['content-type'], 'application/json')
  assert.equal(revoke.init.headers['x-csrf-token'], undefined)
  assert.equal(revoke.init.headers['authorization'], undefined)
})

// ---------------------------------------------------------------- projects
test('project rows expose toggle, level, priority, model, budget, source and reason', () => {
  const rows = cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), makeMandate())
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'ws:a')
  assert.equal(rows[0].enabled, true)
  assert.equal(rows[0].selected, true)
  assert.equal(rows[0].reason, null)
  assert.equal(rows[0].level, 'L1')
  assert.equal(rows[0].priority, 2)
  assert.equal(rows[0].budget.maxTasksPerHour, 3)
  assert.equal(rows[0].source, 'dsh-workspace')
  assert.equal(rows[0].model.provider, 'deepseek', 'inherits the Super Agent model')
  assert.equal(rows[1].reason, 'project_not_selected')
  // Deny-by-default scope.
  assert.equal(cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), makeMandate({ scopeMode: 'none' }))[0].reason, 'scope_none')
  assert.equal(cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), makeMandate({ projects: { 'ws:a': { enabled: false, level: 'L0' } } }))[0].reason, 'project_disabled')

  const calls = []
  const tree = render(cockpit.DabSuperagentProjects({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: makeHost(), context: { mode: 'supervised' },
    dryRun: null, onToggleProject: (id, enabled) => calls.push(['toggle', id, enabled]),
    onSetProjectLevel: (id, level) => calls.push(['level', id, level]),
    onSetProjectPriority: (id, priority) => calls.push(['priority', id, priority]),
    onDryRun: () => calls.push(['dry']),
  }))
  const project = byClass(tree, 'dab-sa-project')[0]
  assert.equal(project.props['data-project-id'], 'ws:a')
  byClass(tree, 'dab-sa-toggle')[0].props.onClick()
  pickOption(byClass(tree, 'dab-sa-level')[0], 'L3')
  byClass(tree, 'dab-sa-priority')[0].props.onChange({ target: { value: '7' } })
  byClass(tree, 'dab-sa-dryrun-btn')[0].props.onClick()
  assert.deepEqual(calls, [['toggle', 'ws:a', false], ['level', 'ws:a', 'L3'], ['priority', 'ws:a', 7], ['dry']])

  // "Tous les projets" needs an explicit ALL_PROJECTS confirmation.
  assert.equal(cockpit.dabAllProjectsConfirmValid(''), false)
  assert.equal(cockpit.dabAllProjectsConfirmValid('ALL_PROJECTS'), true)
  const confirmed = []
  const confirm = render(cockpit.DabAllProjectsConfirm({ confirmText: 'ALL_PROJECTS', onConfirm: text => confirmed.push(text) }))
  const confirmButton = collect(confirm, node => node.props?.['data-testid'] === 'dab-all-projects-confirm')[0]
  assert.equal(confirmButton.props.disabled, false)
  confirmButton.props.onClick()
  assert.deepEqual(confirmed, ['ALL_PROJECTS'])
  const invalid = render(cockpit.DabAllProjectsConfirm({ confirmText: 'all projects' }))
  assert.equal(collect(invalid, node => node.props?.['data-testid'] === 'dab-all-projects-confirm')[0].props.disabled, true)
})

test('project and scope mutations post to the mandate routes with plain JSON', async () => {
  const fetchImpl = fakeFetch({})
  const store = createBoardStore({ get: () => undefined }, { fetchImpl, notifyWindowMs: 0 })
  await store.setProject('ws:a', { enabled: true, level: 'L2', priority: 3 })
  const project = fetchImpl.calls.find(entry => entry.url.endsWith('/mandate/project'))
  assert.ok(project !== undefined)
  assert.equal(project.init.method, 'POST')
  assert.deepEqual(JSON.parse(project.init.body), { projectId: 'ws:a', enabled: true, level: 'L2', priority: 3 })
  assert.equal(project.init.headers['content-type'], 'application/json')
  // CSRF-free: no token header, no credentials on the init object.
  assert.deepEqual(Object.keys(project.init.headers).sort(), ['accept', 'content-type'])
  assert.equal(project.init.credentials, undefined)
  assert.equal(JSON.parse(project.init.body).csrf, undefined)

  await store.setScope('all', undefined, 'ALL_PROJECTS')
  const scope = fetchImpl.calls.find(entry => entry.url.endsWith('/mandate/scope'))
  assert.deepEqual(JSON.parse(scope.init.body), { scopeMode: 'all', confirm: 'ALL_PROJECTS' })

  await store.setLevel('L3')
  const level = fetchImpl.calls.find(entry => entry.url.endsWith('/mandate/level'))
  assert.deepEqual(JSON.parse(level.init.body), { level: 'L3' })

  await store.setPause(true)
  const pause = fetchImpl.calls.find(entry => entry.url.endsWith('/mandate/pause'))
  assert.deepEqual(JSON.parse(pause.init.body), { paused: true })

  // POST /mandate merges: an action toggle must not replay unrelated policy.
  const withMandate = fakeFetch({ state: { mode: 'supervised', acks: {}, assignments: [], mandate: makeMandate() } })
  const fullStore = createBoardStore({ get: () => undefined }, { fetchImpl: withMandate, notifyWindowMs: 0 })
  fullStore.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  await fullStore.setAction('launch', true)
  const replace = withMandate.calls.find(entry => entry.init?.method === 'POST' && entry.url.endsWith('/mandate'))
  const body = JSON.parse(replace.init.body)
  assert.deepEqual(body, { actions: { launch: true } })
  await fullStore.setActionMode('launch', 'ask')
  const modePost = withMandate.calls.filter(entry => entry.init?.method === 'POST' && entry.url.endsWith('/mandate')).at(-1)
  assert.deepEqual(JSON.parse(modePost.init.body), { actionModes: { launch: 'ask' }, actions: { launch: true } })
  fullStore.destroy()
})

test('the dry-run is a GET with no side effect and its result is rendered read-only', async () => {
  const fetchImpl = fakeFetch({ dryRun: { at: 1700000000000, scope: 'selected', projects: [{ id: 'ws:a', title: 'Projet A' }], candidates: [{ taskId: 't-1', projectId: 'ws:a', reason: 'task_ready_and_unassigned' }], actions: [], blocks: [] } })
  const store = createBoardStore({ get: () => undefined }, { fetchImpl, notifyWindowMs: 0 })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const before = store.getHost()
  const stateCallsBefore = fetchImpl.calls.filter(call => call.url.endsWith('/state')).length
  fetchImpl.calls.length = 0
  const result = await store.dryRun()
  assert.equal(result.ok, true)
  assert.equal(result.payload.value.candidates.length, 1)
  assert.equal(fetchImpl.calls.length, 1, 'one GET, no refresh')
  assert.equal(fetchImpl.calls[0].init.method, 'GET')
  assert.match(fetchImpl.calls[0].url, /\/dry-run$/)
  assert.equal(fetchImpl.calls.filter(call => call.init.method === 'POST').length, 0)
  assert.equal(store.getHost(), before, 'the host state is not replaced by a simulation')
  assert.equal(fetchImpl.calls.filter(call => call.url.endsWith('/state')).length, 0)
  assert.equal(stateCallsBefore >= 1, true)
  store.destroy()

  // Rendering a dry-run never writes: lists are bounded with "+N".
  const projects = Array.from({ length: 25 }, (_, index) => ({ id: `ws:${index}`, title: `Projet ${index}` }))
  const candidates = Array.from({ length: 30 }, (_, index) => ({ taskId: `t-${index}`, projectId: `ws:${index}`, reason: 'task_ready_and_unassigned' }))
  const tree = render(cockpit.DabSuperagentProjects({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: makeHost(), context: { mode: 'supervised' },
    dryRun: { projects, candidates, actions: [], blocks: [] }, onDryRun: () => {},
  }))
  assert.equal(byClass(tree, 'dab-sa-dryrun')[0].props['data-readonly'], 'true')
  assert.match(textOf(tree), /Read-only simulation/)
  assert.match(textOf(tree), /Projects : 25/)
  assert.match(textOf(tree), /Candidates : 30/)
  const candidateSection = byClass(tree, 'dab-sa-dryrun-section').find(node => node.props['data-list'] === 'candidates')
  assert.equal(byClass(candidateSection, 'dab-sa-list').length, 1)
  assert.equal(byTag(candidateSection, 'li').length, 10)
  assert.match(textOf(candidateSection), /\+20/)

  const unavailable = render(cockpit.DabSuperagentProjects({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: makeHost(), context: { mode: 'supervised' },
    dryRun: { unavailable: 'dry_run_failed' }, onDryRun: () => {},
  }))
  assert.match(textOf(unavailable), /dry run failed/)
})

// ---------------------------------------------------------------- truncation
test('every bounded list shows an explicit "+N" (portfolio, steps, journal)', () => {
  const projects = Array.from({ length: 25 }, (_, index) => ({ id: `ws:${index}`, title: `Projet ${index}` }))
  const tree = render(cockpit.DabSuperagentProjects({
    superagent: makeInactiveSuperagent(), mandate: makeMandate({ projects: {} }), host: { ...makeHost(), projects }, context: { mode: 'supervised' },
    dryRun: null, onDryRun: () => {},
  }))
  assert.equal(byClass(tree, 'dab-sa-project').length, 20)
  assert.match(textOf(tree), /Page 1\/2 — 25 projects/)
  assert.ok(byTag(tree, 'button').some(node => textOf(node) === 'Next projects' && node.props.disabled === false))

  const activity = Array.from({ length: 30 }, (_, index) => ({ at: 1700000000000 + index, kind: 'step', summary: `Étape ${index}` }))
  const overview = render(cockpit.DabSuperagentOverview({
    superagent: makeInactiveSuperagent({ activity }), mandate: makeMandate(), capabilities: {}, host: makeHost(), context: {},
  }))
  assert.equal(byClass(overview, 'dab-sa-steps')[0].children.length, 6)
  assert.ok(byClass(overview, 'dab-sa-more').some(node => textOf(node) === '+24'))
  assert.equal(byClass(overview, 'dab-sa-journal')[0].children.length, 4)
})

// ---------------------------------------------------------------- mobile / a11y
test('mobile band keeps Stop/Pause reachable and labelled', () => {
  const tree = band({ compact: true, superagent: makeActiveSuperagent('thinking') })
  const body = byClass(tree, 'dab-band-body')[0]
  assert.equal(body.props.hidden, true)
  const stop = collect(tree, node => node.props?.['data-action'] === 'stop')[0]
  const pause = collect(tree, node => node.props?.['data-action'] === 'pause')[0]
  assert.ok(stop !== undefined && pause !== undefined)
  assert.equal(walkHas(body, stop), false, 'Stop is not hidden inside the collapsed body')
  assert.equal(stop.props['aria-label'], 'Stop the Super Agent')
  assert.equal(pause.props['aria-label'], 'Pause the Super Agent')
  // The narrow container rule keeps the controls on their own full row.
  assert.match(cockpit.DAB_CSS, /@container dab \(max-width: 720px\) \{[\s\S]*?\.dab-super-controls \{ order: 3; flex: 1 1 100%; \}/)
})

test('inspector tabs, icon-only buttons and form controls carry accessible names', () => {
  cockpit.setLang('fr')
  try {
    const tree = render(cockpit.DabSuperagentInspector({
      superagent: makeInactiveSuperagent(), mandate: makeMandate(), capabilities: {}, portfolio: [], host: makeHost(),
      context: { mode: 'supervised' }, dryRun: null, ui: {}, narrow: true,
      onClose: () => {},
    }))
    const tabs = byClass(tree, 'dab-sa-tabs')[0]
    assert.equal(tabs.props.role, 'tablist')
    assert.deepEqual(byTag(tabs, 'button').map(button => textOf(button)), ['Vue d’ensemble', 'Projets', 'Directives', 'Paramètres'])
    assert.equal(byTag(tabs, 'button').every(button => button.props.role === 'tab'), true)
    assert.equal(byTag(tabs, 'button')[0].props['aria-selected'], 'true')
    const panel = byClass(tree, 'dab-sa-panel')[0]
    assert.equal(panel.props.role, 'dialog')
    assert.equal(panel.props['aria-modal'], 'true')
    assert.match(panel.props['aria-label'], /Super Agent/)
    assert.equal(byClass(tree, 'dab-sa-panel-body')[0].props['aria-labelledby'], 'dab-sa-tab-overview')
    const close = byTag(byClass(tree, 'dab-sa-head')[0], 'button')[0]
    assert.equal(close.props['aria-label'], 'Fermer')
  } finally {
    cockpit.setLang('en')
  }
})

// ---------------------------------------------------------------- settings
test('settings show model discovery, refusal reasons per action, connector and lifecycle', () => {
  const tree = render(cockpit.DabSuperagentSettings({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: makeHost(), context: { mode: 'supervised', stopped: true, level: 'L0' }, ui: {}, taskboard: makeHost().taskboardPublic,
  }))
  const text = textOf(tree)
  assert.match(text, /deepseek\/v4/)
  // The model is EDITABLE from the real catalog: provider and model selects
  // list only discovered entries, and saving posts provider/model/effort/fallback.
  assert.match(text, /Current model/)
  const providerSelect = byClass(tree, 'dab-sa-model-provider')[0]
  assert.deepEqual(optionValues(providerSelect), ['', 'deepseek'])
  const modelSelect = byClass(tree, 'dab-sa-model-name')[0]
  assert.deepEqual(optionValues(modelSelect), ['', 'v4'])
  assert.equal(byClass(tree, 'dab-sa-model-fallback').length, 2)
  const saved = []
  const editor = render(cockpit.DabSuperagentModelEditor({
    facts: cockpit.dabSuperagentFacts(makeInactiveSuperagent(), makeMandate(), {}),
    models: makeHost().models, busy: false, onSetModel: model => { saved.push(model); return { ok: true } },
  }))
  byTag(editor, 'form')[0].props.onSubmit({ preventDefault() {} })
  // The existing fallback is preserved when only the primary is saved.
  assert.deepEqual(saved, [{ provider: 'deepseek', model: 'v4', fallback: [{ provider: 'other', model: 'm2' }] }])
  // Without discovery the editor says why and offers nothing invented.
  const undiscovered = render(cockpit.DabSuperagentModelEditor({
    facts: cockpit.dabSuperagentFacts(makeInactiveSuperagent(), makeMandate(), {}),
    models: { discovered: false, reason: 'llm_service_unavailable', providers: [] },
  }))
  assert.equal(byClass(undiscovered, 'dab-sa-model-provider').length, 0)
  assert.match(textOf(undiscovered), /DSH model service unavailable/)
  assert.match(text, /Token budget/)
  assert.match(text, /metric unavailable/)
  // Stop refuses every action, with the real reason, on every row.
  const permission = byClass(tree, 'dab-sa-permission').find(node => node.props['data-action'] === 'merge')
  assert.equal(permission.props['data-granted'], 'false')
  // The Stop refusal applies to all 13 actions: stated ONCE above the list,
  // with the raw code as a tooltip, not repeated on every row.
  const global = byClass(tree, 'dab-sa-permissions-global')
  assert.equal(global.length, 1)
  assert.match(textOf(global[0]), /stopped by you: use Resume/)
  assert.equal(global[0].props.title, 'stopped_by_operator')
  assert.equal(byClass(permission, 'dab-sa-permission-reason').length, 0)
  assert.equal(byClass(tree, 'dab-sa-permission').length, 13)
  assert.equal(byClass(tree, 'dab-sa-stop').length, 1)
  assert.equal(byClass(tree, 'dab-sa-resume').length, 1)
  assert.match(text, /Configured and reachable/)

  // Undiscovered models say so instead of inventing a list.
  const hidden = render(cockpit.DabSuperagentSettings({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: { models: { discovered: false, reason: 'model_discovery_unavailable' } }, context: {}, ui: {},
  }))
  assert.match(textOf(hidden), /model list unavailable/)
  assert.equal(byClass(hidden, 'dab-sa-models-discovered').length, 0)

  // Per-action reasons follow the effective mandate, not a static map.
  assert.equal(cockpit.dabActionRefusalReason({ action: 'comment', mandate: makeMandate(), context: { mode: 'supervised', level: 'L1' } }), 'action_disabled')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'merge', mandate: makeMandate(), context: { mode: 'supervised', level: 'L4' } }), 'critical_action_not_granted')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'launch', mandate: makeMandate({ actions: { launch: true } }), context: { mode: 'supervised', level: 'L2' } }), 'approval_required')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'launch', mandate: makeMandate({ actions: { launch: true } }), context: { mode: 'supervised', level: 'L3' } }), null)
  // The scope is part of the refusal: a granted action outside the scope is not authorised.
  assert.equal(cockpit.dabActionRefusalReason({ action: 'launch', mandate: makeMandate({ actions: { launch: true }, scopeMode: 'none' }), context: { mode: 'supervised', level: 'L3' } }), 'scope_none')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'launch', mandate: makeMandate({ actions: { launch: true } }), context: { mode: 'supervised', level: 'L3', projectId: 'ws:other' } }), 'project_not_selected')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'launch', mandate: makeMandate({ actions: { launch: true } }), context: { mode: 'supervised', level: 'L3', projectId: 'ws:a', projectEnabled: false } }), 'project_disabled')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'launch', mandate: makeMandate(), context: { mode: 'off' } }), 'mode_off')

  // Task Board connector: unconfigured is explicit, with the host reason.
  const connector = render(cockpit.DabSuperagentSettings({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: { taskboardPublic: { configured: false, reachable: false, reason: 'public_api_disabled' } }, context: {}, ui: {},
  }))
  assert.match(textOf(connector), /Not configured/)
  assert.match(textOf(connector), /Task Board API disabled: restart DSH/)
})

// ---------------------------------------------------------------- store payload
test('store normalizes v2 fields and keeps an old host payload nullable', async () => {
  const v2 = { mode: 'supervised', acks: {}, superagent: makeInactiveSuperagent(), mandate: makeMandate(), capabilities: { delegate: { state: 'gated' } } }
  const fetchImpl = fakeFetch({ state: v2 })
  const store = createBoardStore({ get: () => undefined }, { fetchImpl, notifyWindowMs: 0 })
  store.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const snapshot = store.getSnapshot()
  assert.ok(snapshot.superagent !== null)
  assert.equal(snapshot.superagent.session.active, false)
  assert.equal(snapshot.mandate.scopeMode, 'selected')
  assert.equal(snapshot.capabilities.delegate.state, 'gated')
  assert.equal(pendingDecisionCountOf(snapshot.superagent), snapshot.superagent.decisions.filter(decision => decision.status === 'pending').length)
  store.destroy()

  const legacy = fakeFetch({ state: { mode: 'off', acks: {}, assignments: [] } })
  const legacyStore = createBoardStore({ get: () => undefined }, { fetchImpl: legacy, notifyWindowMs: 0 })
  legacyStore.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  const legacySnapshot = legacyStore.getSnapshot()
  assert.equal(legacySnapshot.superagent, null)
  assert.equal(legacySnapshot.mandate, null)
  assert.equal(legacySnapshot.capabilities, null)
  assert.equal(legacySnapshot.projection.nodes.length, 0)
  legacyStore.destroy()
})

// ---------------------------------------------------------------- helpers
function fakeFetch({ state = { mode: 'supervised', acks: {}, assignments: [], proposals: [] }, dryRun = null } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    if (String(url).endsWith('/state')) return json({ ok: true, value: state })
    if (String(url).endsWith('/dry-run')) return json({ ok: true, value: dryRun ?? { projects: [], candidates: [], actions: [], blocks: [] } })
    return json({ ok: true, value: {} })
  }
  impl.calls = calls
  return impl
}

function json(value) {
  return { ok: true, status: 200, json: async () => value }
}

// ---------------------------------------------------------------- UX polish
test('the project picker lives in the card: one switch and a named level per project', () => {
  const toggled = []
  const leveled = []
  const mandate = makeMandate({ scopeMode: 'none', selectedWorkspaces: [], projects: {} })
  const projectRows = cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), mandate)
  // Collapsed card: no project list (it belongs to the opened card).
  assert.equal(byClass(band({ mandate, projectRows }), 'dab-super-projects').length, 0)
  const tree = band({
    mandate, projectRows, open: true, totals: { ...TOTALS, projects: 2 },
    onToggleProject: (id, enabled) => toggled.push([id, enabled]),
    onSetProjectLevel: (id, level) => leveled.push([id, level]),
  })
  const strip = byClass(tree, 'dab-super-projects')
  assert.equal(strip.length, 1)
  assert.match(textOf(strip[0]), /Enable a project so the Super Agent can act on it/)
  const switches = collect(strip[0], node => node.props?.role === 'switch')
  assert.equal(switches.length, 2)
  switches[0].props.onClick()
  assert.deepEqual(toggled, [['ws:a', true]])
  // No project enabled: Start cannot be pressed yet.
  const start = collect(tree, node => node.props?.['data-action'] === 'start')[0]
  assert.equal(start.props.disabled, true)
  // The enabled count falls back to the real project count instead of "unavailable".
  assert.match(textOf(byClass(tree, 'dab-super-enabled')[0]), /0\/2/)
  assert.equal(byClass(tree, 'dab-super-cta').length, 0, 'no separate dashed call-to-action button')

  // An enabled project shows its level by NAME, and changing it calls the host.
  const enabledRows = cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), makeMandate())
  const enabledTree = band({ open: true, projectRows: enabledRows, onToggleProject: () => {}, onSetProjectLevel: (id, level) => leveled.push([id, level]) })
  const select = byClass(enabledTree, 'dab-super-project-level')
  assert.equal(select.length, 1, 'only enabled projects get a level picker')
  assert.match(textOf(select[0]), /Bounded autonomy/)
  assert.equal(collect(select[0], node => node.props?.className === 'dab-level-dot' && node.props['data-level'] === 'L3').length >= 1, true, 'coloured dot per level')
  assert.doesNotMatch(textOf(select[0]), /\bL[0-4]\b/, 'no internal level code on screen')
  pickOption(select[0], 'L3')
  assert.deepEqual(leveled, [['ws:a', 'L3']])
})

test('levels are named for humans everywhere', () => {
  assert.equal(cockpit.dabLevelLabel('L0'), 'Observe')
  assert.equal(cockpit.dabLevelLabel('L4'), 'Maximum autonomy')
  // Dropdown options carry the level for a real CSS dot, the name and the description.
  const option = cockpit.dabLevelOptions().find(entry => entry[0] === 'L2')
  assert.deepEqual([option[1], option[2].level, option[2].describe], ['Supervised', 'L2', true])
  assert.match(cockpit.dabLevelHint('L2'), /waits for your approval/)
  cockpit.setLang('fr')
  try {
    assert.equal(cockpit.dabLevelLabel('L1'), 'Conseiller')
    assert.equal(cockpit.dabLevelLabel('L3'), 'Autonome encadré')
  } finally {
    cockpit.setLang('en')
  }
})

test('no pinned model reads as the DSH default model, never "unresolved"', () => {
  const superagent = makeInactiveSuperagent()
  superagent.identity.model = null
  const tree = band({ superagent })
  assert.match(textOf(byClass(tree, 'dab-super-model')[0]), /DSH default model/)
})

test('stopped: Resume is the single primary action and Start is not offered beside it', () => {
  const tree = band({ stopped: true })
  const controls = collect(tree, node => node.props?.['data-action'] !== undefined)
  assert.equal(controls.find(node => node.props['data-action'] === 'start'), undefined)
  assert.equal(controls.find(node => node.props['data-action'] === 'resume').props['data-primary'], 'true')
  assert.equal(controls.filter(node => node.props['data-primary'] === 'true').length, 1)
  assert.equal(controls.find(node => node.props['data-action'] === 'stop'), undefined, 'nothing runs while stopped')
})

test('reason codes render as sentences with the raw code kept as a tooltip', () => {
  assert.equal(cockpit.dabReasonText('scope_none'), 'no project allowed: enable one in the Projects tab')
  assert.equal(cockpit.dabReasonText('some_new_code'), 'some new code', 'unknown codes are spaced, never invented')
  assert.equal(cockpit.dabReasonText('Already a sentence.'), 'Already a sentence.')
  assert.equal(cockpit.dabReasonText(''), '')
})

test('enabling a project from the card selects it first, then switches it on; disabling only switches it off', async () => {
  const fetchImpl = fakeFetch({})
  const store = createBoardStore({ get: () => undefined }, { fetchImpl, notifyWindowMs: 0 })
  await store.enableProject('ws:a', true)
  const posts = fetchImpl.calls.filter(entry => entry.init?.method === 'POST')
  // The host refuses to enable an out-of-scope project (409 project_not_in_scope),
  // so the explicit selection must come first.
  assert.match(posts[0].url, /\/mandate\/scope$/)
  assert.deepEqual(JSON.parse(posts[0].init.body), { scopeMode: 'selected', selectedWorkspaces: ['ws:a'] })
  assert.match(posts[1].url, /\/mandate\/project$/)
  assert.deepEqual(JSON.parse(posts[1].init.body), { projectId: 'ws:a', enabled: true })

  const before = fetchImpl.calls.length
  await store.enableProject('ws:a', false)
  const off = fetchImpl.calls.slice(before).filter(entry => entry.init?.method === 'POST')
  assert.equal(off.length, 1, 'disabling never widens or narrows the scope')
  assert.match(off[0].url, /\/mandate\/project$/)
  assert.deepEqual(JSON.parse(off[0].init.body), { projectId: 'ws:a', enabled: false })
})

test('the card warns when the global level silently caps an enabled project', () => {
  let opened = null
  const mandate = makeMandate({ level: 'L0', projects: { 'ws:a': { enabled: true, level: 'L2', priority: 1, model: null, budget: null, note: '' } } })
  const projectRows = cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), mandate)
  const tree = band({ mandate, projectRows, open: true, onOpenSettings: () => { opened = 'settings' } })
  const warning = byClass(tree, 'dab-super-projects-capped')
  assert.equal(warning.length, 1)
  assert.match(textOf(warning[0]), /global level “Observe” caps every project/)
  warning[0].props.onClick()
  assert.equal(opened, 'settings')
  const fine = band({ mandate: makeMandate({ level: 'L4' }), projectRows: cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), makeMandate({ level: 'L4' })), open: true })
  assert.equal(byClass(fine, 'dab-super-projects-capped').length, 0)
})

test('settings read the model catalog where /state and SSE publish it (host.host.models)', () => {
  const nested = { ...makeHost(), models: undefined, host: { models: makeHost().models } }
  const tree = render(cockpit.DabSuperagentSettings({
    superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: nested, context: { mode: 'supervised' }, ui: {}, taskboard: null,
  }))
  assert.equal(byClass(tree, 'dab-sa-model-provider').length, 1, 'the editor is offered from the nested catalog')
})

test('the card says when enabled projects cannot launch anything (permission off)', () => {
  const mandate = makeMandate({ level: 'L4' })
  const projectRows = cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), mandate)
  const warned = band({ mandate, projectRows, open: true })
  assert.equal(collect(warned, node => node.props?.['data-warning'] === 'launch').length, 1)
  const granted = makeMandate({ level: 'L4', actions: { ...makeMandate().actions, launch: true } })
  const fine = band({ mandate: granted, projectRows: cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), granted), open: true })
  assert.equal(collect(fine, node => node.props?.['data-warning'] === 'launch').length, 0)
})

test('settings: reconcile notes are readable and the connector is read where /state publishes it', () => {
  const nested = { ...makeHost(), taskboardPublic: undefined, reconcileNotes: [{ type: 'stale_lock_taken_over' }, { type: 'lock_lost', error: 'EPERM' }], host: { taskboardPublic: { configured: true, reachable: true, reason: null } } }
  const tree = render(cockpit.DabSuperagentSettings({ superagent: makeInactiveSuperagent(), mandate: makeMandate(), host: nested, context: {}, ui: {}, taskboard: null }))
  const text = textOf(tree)
  assert.doesNotMatch(text, /\[object Object\]/)
  assert.match(text, /stale lock taken over/)
  assert.match(text, /lock lost — EPERM/)
  assert.match(text, /Configured and reachable/)
})

test('project 21 is individually reachable by pagination and search without widening scope', () => {
  const values = []
  const original = React.useState
  let cursor = 0
  const props = {
    superagent: makeInactiveSuperagent(), mandate: makeMandate({ projects: {} }),
    host: { ...makeHost(), projects: Array.from({ length: 25 }, (_, i) => ({ id: `ws:${i}`, title: `Project ${i}` })) },
    onToggleProject: (id, enabled) => values.push([id, enabled]),
  }
  const state = []
  const draw = () => {
    cursor = 0
    React.useState = initial => {
      const slot = cursor++
      if (!(slot in state)) state[slot] = initial
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
    }
    let node
    try { node = cockpit.DabSuperagentProjects(props) } finally { React.useState = original }
    return render(node)
  }
  let tree = draw()
  byTag(tree, 'button').find(node => textOf(node) === 'Next projects').props.onClick()
  tree = draw()
  const project21 = byClass(tree, 'dab-sa-project').find(node => node.props['data-project-id'] === 'ws:20')
  assert.ok(project21)
  byTag(project21, 'button').find(node => node.props.role === 'switch').props.onClick()
  assert.deepEqual(values, [['ws:20', true]])
  byTag(tree, 'input').find(node => node.props.type === 'search').props.onChange({ target: { value: 'ws:20' } })
  tree = draw()
  assert.equal(byClass(tree, 'dab-sa-project').length, 1)
  assert.equal(byClass(tree, 'dab-sa-project')[0].props['data-project-id'], 'ws:20')
  assert.match(textOf(tree), /Page 1\/1 — 1 projects/)
})

test('inherited project level displays global level and explicit overrides can reset with null', () => {
  const changes = []
  const mandate = makeMandate({ level: 'L3', projects: { 'ws:a': { enabled: true, level: null }, 'ws:b': { enabled: true, level: 'L2', model: { provider: 'p', model: 'm' } } } })
  const rows = cockpit.dabProjectPolicyRows(makeHost(), makeInactiveSuperagent(), mandate)
  assert.equal(rows.find(row => row.id === 'ws:a').level, null)
  assert.equal(rows.find(row => row.id === 'ws:a').effectiveLevel, 'L3')
  const node = cockpit.DabSuperagentProjects({ host: makeHost(), mandate, superagent: makeInactiveSuperagent(),
    onSetProjectLevel: (id, value) => changes.push({ id, level: value }),
    onSetProjectModel: (id, value) => changes.push({ id, model: value }),
  })
  const tree = render(node)
  assert.match(textOf(tree), /Inherited — L3/)
  const override = byClass(tree, 'dab-sa-project').find(row => row.props['data-project-id'] === 'ws:b')
  collect(override, row => row.props?.role === 'option' && row.props['data-value'] === '')[0].props.onClick()
  byTag(override, 'button').find(row => row.props['aria-label']?.startsWith('Reset worker model')).props.onClick()
  assert.deepEqual(changes, [{ id: 'ws:b', level: null }, { id: 'ws:b', model: null }])

  // The worker model is an operator choice, offered from the REAL catalog only.
  const picker = render(cockpit.DabSuperagentProjects({ host: makeHost(), mandate, superagent: makeInactiveSuperagent(),
    onSetProjectModel: (id, value) => changes.push({ id, model: value }),
  }))
  const inheritedRow = byClass(picker, 'dab-sa-project').find(row => row.props['data-project-id'] === 'ws:a')
  const modelSelect = byClass(inheritedRow, 'dab-sa-project-model')[0]
  assert.ok(modelSelect, 'a discovered catalog yields a model picker')
  assert.deepEqual(collect(modelSelect, node => node.props?.role === 'option').map(node => node.props['data-value']), ['', 'deepseek/v4'])
  collect(modelSelect, node => node.props?.role === 'option' && node.props['data-value'] === 'deepseek/v4')[0].props.onClick()
  assert.deepEqual(changes.at(-1), { id: 'ws:a', model: { provider: 'deepseek', model: 'v4' } })
  // An override missing from the current catalog stays visible as itself.
  const overrideRow = byClass(picker, 'dab-sa-project').find(row => row.props['data-project-id'] === 'ws:b')
  const overrideModel = byClass(overrideRow, 'dab-sa-project-model')[0]
  assert.equal(overrideModel.props['data-value'], 'p/m')
  assert.equal(collect(overrideModel, node => node.props?.role === 'option' && node.props['data-value'] === 'p/m').length, 1)
  // Without discovery nothing is invented: the display stays read-only.
  const noCatalog = render(cockpit.DabSuperagentProjects({ host: { ...makeHost(), models: { discovered: false, providers: [], reason: 'llm_service_unavailable' } },
    mandate, superagent: makeInactiveSuperagent(), onSetProjectModel: () => {} }))
  assert.equal(collect(noCatalog, node => node.props?.className === 'dab-sa-project-model').length, 0)
})

test('permission modes are tri-state and unsupported actions stay unavailable', () => {
  assert.equal(cockpit.dabActionRefusalReason({ action: 'comment', mandate: makeMandate({ level: 'L2', actionModes: { comment: 'ask' } }) }), 'approval_required')
  assert.equal(cockpit.dabActionRefusalReason({ action: 'comment', mandate: makeMandate({ level: 'L3', actionModes: { comment: 'deny' }, actions: { comment: true } }) }), 'action_disabled')
  const changes = []
  const tree = render(cockpit.DabSuperagentSettings({
    superagent: makeInactiveSuperagent(), mandate: makeMandate({ level: 'L3', actionModes: { launch: 'ask' } }), host: makeHost(),
    capabilities: { merge: { implemented: false, state: 'unavailable', reason: 'no_adapter_for_action' } },
    onSetActionMode: (action, mode) => changes.push([action, mode]),
  }))
  const launch = byClass(tree, 'dab-sa-permission').find(row => row.props['data-action'] === 'launch')
  const options = collect(launch, row => row.props?.role === 'option')
  assert.deepEqual(options.map(row => row.props['data-value']), ['deny', 'ask', 'auto'])
  options.find(row => row.props['data-value'] === 'deny').props.onClick()
  assert.deepEqual(changes, [['launch', 'deny']])
  const merge = byClass(tree, 'dab-sa-permission').find(row => row.props['data-action'] === 'merge')
  assert.equal(byTag(merge, 'button')[0].props.disabled, true)
})

test('the self-test panel asks the host on demand and renders every contract check', async () => {
  const calls = []
  const state = []
  let cursor = 0
  const original = React.useState
  const draw = () => {
    cursor = 0
    React.useState = initial => {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }]
    }
    try {
      return render(cockpit.DabSelfTest({
        busy: false,
        onSelfTest: deep => {
          calls.push(deep)
          return Promise.resolve({ ok: true, payload: { value: {
            at: 1,
            checks: [
              { id: 'agents.create', ok: true },
              { id: 'permission.read-only', ok: false, reason: 'preset_sandbox_mismatch' },
              { id: 'models.catalog', ok: true },
            ],
            deep: deep ? { ok: true, disposed: true, verifiedBy: 'preset' } : null,
          } } })
        },
      }))
    } finally { React.useState = original }
  }
  let tree = draw()
  assert.ok(byClass(tree, 'dab-sa-selftest-run')[0], 'the panel offers a run button')
  byClass(tree, 'dab-sa-selftest-run')[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 10))
  tree = draw()
  assert.deepEqual(calls, [false], 'a shallow run never asks for a session')
  assert.match(textOf(tree), /1 check\(s\) failed/)
  const failed = collect(tree, node => node.props?.['data-check'] === 'permission.read-only')[0]
  assert.equal(failed.props['data-ok'], 'false')
  assert.match(textOf(failed), /preset sandbox mismatch/)
  assert.equal(collect(tree, node => node.props?.['data-check'] === 'agents.create')[0].props['data-ok'], 'true')

  byClass(tree, 'dab-sa-selftest-deep')[0].props.onChange({ target: { checked: true } })
  tree = draw()
  byClass(tree, 'dab-sa-selftest-run')[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 10))
  tree = draw()
  assert.deepEqual(calls, [false, true])
  assert.match(textOf(tree), /Test session created, confined and disposed/)

  // A host refusal is a readable sentence, never a blank panel.
  const refusalState = []
  let refusalCursor = 0
  const drawRefusal = () => {
    refusalCursor = 0
    React.useState = initial => {
      const slot = refusalCursor++
      if (!(slot in refusalState)) refusalState[slot] = typeof initial === 'function' ? initial() : initial
      return [refusalState[slot], value => { refusalState[slot] = typeof value === 'function' ? value(refusalState[slot]) : value }]
    }
    try {
      return render(cockpit.DabSelfTest({
        busy: false,
        onSelfTest: () => Promise.resolve({ ok: false, payload: { ok: false, error: 'confirmation_required' } }),
      }))
    } finally { React.useState = original }
  }
  let refusalTree = drawRefusal()
  byClass(refusalTree, 'dab-sa-selftest-run')[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 10))
  refusalTree = drawRefusal()
  assert.match(textOf(refusalTree), /confirmation required/)
  assert.equal(collect(refusalTree, node => node.props?.['data-check'] !== undefined).length, 0)
})
