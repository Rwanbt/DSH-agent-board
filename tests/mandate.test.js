import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIONS, ACTION_MIN_LEVEL, AUTONOMY_LEVELS, CRITICAL_ACTIONS, READ_ONLY_ACTIONS,
  applyMandatePatch, describeMandate, effectivePolicyOf, emptyMandate, levelsForAction,
  migrateLegacyPolicy, normalizeMandate,
} from '../src/contracts/mandate.js'

const NOW = 1_795_000_000_000

function mutating(extra = {}) {
  return { ...Object.fromEntries(ACTIONS.filter(action => !READ_ONLY_ACTIONS.includes(action)).map(action => [action, true])), ...extra }
}

/** A mandate that WOULD authorize everything if the gates were bypassed. */
function authorizedMandate(overrides = {}) {
  return normalizeMandate({
    scopeMode: 'selected',
    selectedWorkspaces: ['ws-a'],
    level: 'L4',
    actions: mutating(),
    projects: { 'ws-a': { enabled: true, level: 'L4', budget: { maxTasksPerHour: 6 } } },
    requiresConfiguration: false,
    revision: 3,
    updatedAt: NOW,
    ...overrides,
  })
}

test('default mandate authorizes nothing and says so', () => {
  const mandate = emptyMandate(NOW)
  assert.equal(mandate.scopeMode, 'none')
  assert.equal(mandate.level, 'L0')
  assert.equal(mandate.requiresConfiguration, true)
  for (const action of ACTIONS.filter(entry => !READ_ONLY_ACTIONS.includes(entry))) {
    assert.equal(mandate.actions[action], false, `${action} must be disabled by default`)
  }
  assert.deepEqual(mandate.selectedWorkspaces, [])
  assert.equal(mandate.allConsent, null)
})

test('an empty workspace list never means "all"', () => {
  const none = normalizeMandate({ scopeMode: 'selected', selectedWorkspaces: [], level: 'L4' })
  assert.equal(none.scopeMode, 'none')
  const legacy = normalizeMandate({ selectedWorkspaces: [] })
  assert.equal(legacy.scopeMode, 'none')
  const unknown = normalizeMandate({ scopeMode: 'everything', level: 'L4' })
  assert.equal(unknown.scopeMode, 'none')
})

test('"all" requires a recorded ALL_PROJECTS consent, otherwise it is none', () => {
  const without = normalizeMandate({ scopeMode: 'all', level: 'L4', actions: mutating() })
  assert.equal(without.scopeMode, 'none')
  assert.equal(without.allConsent, null)

  const forged = normalizeMandate({ scopeMode: 'all', level: 'L4', allConsent: { at: NOW, by: 'operator', text: 'yes please' } })
  assert.equal(forged.scopeMode, 'none')

  const valid = normalizeMandate({ scopeMode: 'all', level: 'L4', allConsent: { at: NOW, by: 'operator', text: 'ALL_PROJECTS' } })
  assert.equal(valid.scopeMode, 'all')
  assert.equal(valid.allConsent.at, NOW)
})

test('normalization refuses unknown actions, levels and prototype pollution', () => {
  const mandate = normalizeMandate({
    level: 'L9',
    scopeMode: 'selected',
    selectedWorkspaces: ['ws-a', 'ws-a', '../etc', '__proto__', 'constructor', 42],
    actions: { launch: true, 'drop_database': true, __proto__: { launch: true } },
    projects: JSON.parse('{"__proto__":{"enabled":true},"ws-a":{"enabled":true,"level":"L7"}}'),
  })
  assert.equal(mandate.level, 'L0')
  assert.deepEqual(mandate.selectedWorkspaces, ['ws-a'])
  assert.equal(mandate.actions.launch, true)
  assert.equal(mandate.actions.drop_database, undefined)
  assert.equal(Object.hasOwn(mandate.projects, '__proto__'), false)
  assert.equal(mandate.projects['ws-a'].level, null)
  assert.equal(mandate.projects['ws-a'].enabled, true)
  // A persisted mandate must round-trip.
  assert.deepEqual(normalizeMandate(mandate), mandate)
})

test('levels and action table are internally consistent', () => {
  for (const action of ACTIONS) {
    assert.ok(ACTION_MIN_LEVEL[action], `${action} must declare a minimum level`)
    assert.ok(AUTONOMY_LEVELS.includes(ACTION_MIN_LEVEL[action]))
    assert.ok(levelsForAction(action).length >= 1)
  }
  for (const action of CRITICAL_ACTIONS) {
    assert.equal(ACTION_MIN_LEVEL[action], 'L4')
  }
})

test('legacy migration is restrictive: empty list + autonomous becomes inert', () => {
  const { mandate, audit } = migrateLegacyPolicy({
    mode: 'autonomous',
    policy: { allowedWorkspaces: [], autonomyBudget: { maxTasksPerHour: 6 }, maxConcurrent: 1 },
    now: NOW,
  })
  assert.equal(mandate.scopeMode, 'none')
  assert.equal(mandate.level, 'L1')
  assert.equal(mandate.requiresConfiguration, true)
  assert.equal(mandate.actions.launch, false)
  assert.deepEqual(mandate.projects, {})
  assert.equal(mandate.migratedFrom.mode, 'autonomous')
  assert.equal(audit.type, 'mandate_migrated')
  assert.equal(audit.reason, 'goal6_scope_mode_v2')

  const decision = effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-unifia', mode: 'autonomous' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'scope_none')
})

test('legacy migration keeps a selected scope but grants no project', () => {
  const { mandate } = migrateLegacyPolicy({
    mode: 'supervised',
    policy: { allowedWorkspaces: ['ws-a', 'ws-b'] },
    now: NOW,
  })
  assert.equal(mandate.scopeMode, 'selected')
  assert.deepEqual(mandate.selectedWorkspaces, ['ws-a', 'ws-b'])
  assert.equal(mandate.projects['ws-a'].enabled, false)
  assert.equal(mandate.projects['ws-b'].level, 'L0')
  assert.equal(mandate.requiresConfiguration, true)
  const decision = effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a', mode: 'supervised' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'requires_configuration')
})

test('migrated mandate survives a reload without gaining power', () => {
  const { mandate } = migrateLegacyPolicy({ mode: 'autonomous', policy: { allowedWorkspaces: [] }, now: NOW })
  for (let index = 0; index < 3; index += 1) {
    const reloaded = normalizeMandate(JSON.parse(JSON.stringify(mandate)))
    assert.equal(reloaded.scopeMode, 'none')
    assert.equal(reloaded.level, 'L1')
    assert.equal(reloaded.requiresConfiguration, true)
    assert.equal(effectivePolicyOf({ mandate: reloaded, action: 'create_task', projectId: 'ws-a', mode: 'autonomous' }).allowed, false)
  }
})

test('the single gate denies OFF, Stop and pause with their real reason', () => {
  const mandate = authorizedMandate()
  assert.equal(effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a', mode: 'off' }).reason, 'mode_off')
  assert.equal(effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a', mode: 'autonomous', stopped: true }).reason, 'stopped_by_operator')
  assert.equal(effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a', mode: 'autonomous', paused: true }).reason, 'paused_by_operator')
  // Read-only diagnostics stay possible while stopped: the operator can inspect.
  assert.equal(effectivePolicyOf({ mandate, action: 'read', projectId: 'ws-a', mode: 'off' }).allowed, true)
})

test('scope and project switches are independent refusals', () => {
  const mandate = authorizedMandate()
  assert.equal(effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-b' }).reason, 'project_not_selected')

  const disabled = authorizedMandate({ projects: { 'ws-a': { enabled: false, level: 'L4' } } })
  assert.equal(effectivePolicyOf({ mandate: disabled, action: 'launch', projectId: 'ws-a' }).reason, 'project_disabled')

  const unconfigured = authorizedMandate({ requiresConfiguration: true })
  assert.equal(effectivePolicyOf({ mandate: unconfigured, action: 'launch', projectId: 'ws-a' }).reason, 'requires_configuration')
})

test('level ladder is the most restrictive of global, project and action', () => {
  const globalLow = authorizedMandate({ level: 'L2' })
  assert.equal(effectivePolicyOf({ mandate: globalLow, action: 'create_task', projectId: 'ws-a' }).reason, 'level_too_low')

  const projectLow = authorizedMandate({ projects: { 'ws-a': { enabled: true, level: 'L1', budget: { maxTasksPerHour: 6 } } } })
  assert.equal(effectivePolicyOf({ mandate: projectLow, action: 'launch', projectId: 'ws-a' }).reason, 'level_too_low')

  const delegateAtL3 = authorizedMandate({ level: 'L3', projects: { 'ws-a': { enabled: true, level: 'L3', budget: { maxTasksPerHour: 6 } } } })
  assert.equal(effectivePolicyOf({ mandate: delegateAtL3, action: 'delegate', projectId: 'ws-a' }).reason, 'level_too_low')
  assert.equal(effectivePolicyOf({ mandate: delegateAtL3, action: 'launch', projectId: 'ws-a' }).allowed, true)
})

test('L2 executes only with a valid approval, L3+ needs none', () => {
  const l2 = authorizedMandate({ level: 'L2' })
  const without = effectivePolicyOf({ mandate: l2, action: 'launch', projectId: 'ws-a' })
  assert.equal(without.allowed, false)
  assert.equal(without.reason, 'approval_required')
  assert.equal(without.requiresApproval, true)
  const withApproval = effectivePolicyOf({ mandate: l2, action: 'launch', projectId: 'ws-a', approved: true })
  assert.equal(withApproval.allowed, true)

  const l3 = authorizedMandate({ level: 'L3', projects: { 'ws-a': { enabled: true, level: 'L3', budget: { maxTasksPerHour: 6 } } } })
  const direct = effectivePolicyOf({ mandate: l3, action: 'launch', projectId: 'ws-a' })
  assert.equal(direct.allowed, true)
  assert.equal(direct.requiresApproval, false)
})

test('critical actions need the grant AND a per-occurrence decision', () => {
  const grantless = authorizedMandate({ actions: mutating({ merge: false }) })
  assert.equal(effectivePolicyOf({ mandate: grantless, action: 'merge', projectId: 'ws-a' }).reason, 'critical_action_not_granted')

  const granted = authorizedMandate()
  const asked = effectivePolicyOf({ mandate: granted, action: 'merge', projectId: 'ws-a' })
  assert.equal(asked.allowed, false)
  assert.equal(asked.reason, 'approval_required')
  assert.equal(asked.requiresHumanDecision, true)
  assert.equal(effectivePolicyOf({ mandate: granted, action: 'merge', projectId: 'ws-a', approved: true }).allowed, true)

  for (const action of CRITICAL_ACTIONS) {
    const decision = effectivePolicyOf({ mandate: granted, action, projectId: 'ws-a' })
    assert.equal(decision.allowed, false, `${action} must not be allowed without a decision`)
  }
})

test('integration ceilings never widen the mandate', () => {
  const l3 = authorizedMandate({ level: 'L3', projects: { 'ws-a': { enabled: true, level: 'L3', budget: { maxTasksPerHour: 6 } } } })
  assert.equal(effectivePolicyOf({ mandate: l3, action: 'launch', projectId: 'ws-a', integration: 'taskboard' }).allowed, true)
  // GitHub write operations are capped at L3 and need their own grant.
  const noPr = authorizedMandate({ actions: mutating({ open_pr: false }) })
  assert.equal(effectivePolicyOf({ mandate: noPr, action: 'open_pr', projectId: 'ws-a', integration: 'github' }).reason, 'action_disabled')
  const pr = authorizedMandate()
  assert.equal(effectivePolicyOf({ mandate: pr, action: 'open_pr', projectId: 'ws-a', integration: 'github' }).allowed, true)
})

test('concurrency is a real refusal', () => {
  const mandate = authorizedMandate()
  const decision = effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a', running: 2, maxConcurrent: 2 })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'concurrency_limit')
})

test('scope "all" with consent authorizes a project that has no explicit row', () => {
  const mandate = normalizeMandate({
    scopeMode: 'all',
    allConsent: { at: NOW, by: 'operator', text: 'ALL_PROJECTS' },
    level: 'L4',
    actions: mutating(),
    requiresConfiguration: false,
  })
  const decision = effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-any', mode: 'autonomous' })
  assert.equal(decision.allowed, true)
  assert.equal(decision.scope, 'all')
})

test('a fully authorized mandate still cannot launch without an enabled project under selected', () => {
  const mandate = authorizedMandate({ projects: {} })
  assert.equal(effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a' }).reason, 'project_disabled')
})

test('budget zero on a project refuses launches only', () => {
  const mandate = authorizedMandate({ projects: { 'ws-a': { enabled: true, level: 'L4', budget: { maxTasksPerHour: 0 } } } })
  assert.equal(effectivePolicyOf({ mandate, action: 'launch', projectId: 'ws-a' }).reason, 'project_budget_exhausted')
  assert.equal(effectivePolicyOf({ mandate, action: 'comment', projectId: 'ws-a' }).allowed, true)
})

test('applyMandatePatch requires explicit confirmations and bumps the revision', () => {
  const none = emptyMandate(NOW)
  assert.equal(applyMandatePatch(none, { scopeMode: 'all' }, { now: NOW }).reason, 'all_scope_requires_confirmation')
  assert.equal(applyMandatePatch(none, { scopeMode: 'selected', selectedWorkspaces: [] }, { now: NOW }).reason, 'selected_scope_requires_workspaces')

  const selected = applyMandatePatch(none, { scopeMode: 'selected', selectedWorkspaces: ['ws-a'] }, { now: NOW })
  assert.equal(selected.ok, true)
  assert.equal(selected.mandate.revision, 1)
  assert.deepEqual(selected.mandate.selectedWorkspaces, ['ws-a'])
  assert.equal(selected.mandate.requiresConfiguration, true)

  const all = applyMandatePatch(none, { scopeMode: 'all', allConsent: { at: NOW, by: 'operator', text: 'ALL_PROJECTS' } }, { now: NOW })
  assert.equal(all.ok, true)
  assert.equal(all.mandate.scopeMode, 'all')
})

test('describeMandate never claims more than the mandate holds', () => {
  const description = describeMandate(authorizedMandate())
  assert.equal(description.level, 'L4')
  assert.equal(description.projectCount, 1)
  assert.equal(description.enabledProjects, 1)
  assert.match(description.scopeLabel, /1 projet/)
  assert.ok(description.actionsEnabled.includes('launch'))

  const empty = describeMandate(emptyMandate())
  assert.equal(empty.scopeLabel, 'Aucun projet')
  assert.deepEqual(empty.actionsEnabled, [])
})
