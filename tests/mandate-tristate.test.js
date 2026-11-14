import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIONS, CRITICAL_ACTIONS, READ_ONLY_ACTIONS, actionModeOf, applyMandatePatch, effectivePolicyOf, normalizeActionModes, normalizeMandate } from '../src/contracts/mandate.js'

function mandate(level = 'L4', extra = {}) {
  return normalizeMandate({ scopeMode: 'selected', selectedWorkspaces: ['p'], level,
    projects: { p: { enabled: true } }, requiresConfiguration: false, ...extra })
}
const decide = (m, action, approved = false, extra = {}) => effectivePolicyOf({ mandate: m, projectId: 'p', action, approved, ...extra })

test('sparse modes preserve legacy booleans and survive persistence', () => {
  const m = mandate('L2', { actions: { comment: true, launch: false } })
  assert.deepEqual(m.actionModes, {})
  assert.equal(actionModeOf(m, 'comment'), 'auto')
  assert.equal(actionModeOf(m, 'launch'), 'deny')
  assert.equal(decide(m, 'comment', true).reason, 'level_too_low')
  assert.deepEqual(normalizeMandate(JSON.parse(JSON.stringify(m))), m)
  assert.deepEqual(normalizeActionModes({ comment: 'ask', bogus: 'auto', read: 'deny', launch: 'invalid' }), { comment: 'ask' })
})

test('explicit ask always requires approval and never executes below L2', () => {
  for (const action of ACTIONS.filter(a => !READ_ONLY_ACTIONS.includes(a) && !CRITICAL_ACTIONS.includes(a))) {
    for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
      const m = mandate(level, { actionModes: { [action]: 'ask' } })
      const eligible = Number(level.slice(1)) >= 2
      assert.equal(m.actions[action], true)
      assert.equal(decide(m, action).reason, eligible ? 'approval_required' : 'level_too_low', `${action}/${level}`)
      assert.equal(decide(m, action, true).allowed, eligible, `${action}/${level}/approved`)
    }
  }
})

test('explicit auto offers approval below automation minimum, unlike legacy booleans', () => {
  for (const action of ['comment', 'create_task', 'update_task', 'delegate', 'open_pr']) {
    const explicit = mandate('L2', { actionModes: { [action]: 'auto' } })
    assert.equal(decide(explicit, action).reason, 'approval_required')
    assert.equal(decide(explicit, action, true).allowed, true)
    const legacy = mandate('L2', { actions: { [action]: true } })
    assert.equal(decide(legacy, action, true).reason, 'level_too_low')
  }
  assert.equal(decide(mandate('L3', { actionModes: { comment: 'auto' } }), 'comment').allowed, true)
  assert.equal(decide(mandate('L1', { actionModes: { launch: 'auto' } }), 'launch', true).allowed, false)
})

test('critical actions retain L4 and human decision even with explicit modes', () => {
  for (const action of CRITICAL_ACTIONS) {
    for (const mode of ['ask', 'auto']) {
      assert.equal(decide(mandate('L3', { actionModes: { [action]: mode } }), action, true).reason, 'level_too_low')
      const m = mandate('L4', { actionModes: { [action]: mode } })
      assert.equal(decide(m, action).reason, 'approval_required')
      assert.equal(decide(m, action, true).allowed, true)
    }
  }
})

test('deny cannot be overridden and approval cannot bypass other gates', () => {
  const denied = mandate('L4', { actions: { comment: true }, actionModes: { comment: 'deny' } })
  assert.equal(denied.actions.comment, false)
  assert.equal(decide(denied, 'comment', true).reason, 'action_disabled')
  const m = mandate('L2', { actionModes: { comment: 'ask', launch: 'ask' } })
  assert.equal(decide(m, 'comment', true, { projectId: 'foreign' }).reason, 'project_not_selected')
  assert.equal(decide(m, 'comment', true, { stopped: true }).reason, 'stopped_by_operator')
  assert.equal(decide(m, 'launch', true, { running: 1, maxConcurrent: 1 }).reason, 'concurrency_limit')
  const projectLow = mandate('L4', { projects: { p: { enabled: true, level: 'L1' } }, actionModes: { comment: 'ask' } })
  assert.equal(decide(projectLow, 'comment', true).reason, 'level_too_low')
})

test('patches merge per key; explicit booleans replace prior mode; modes win same-patch conflict', () => {
  let m = mandate('L3', { actionModes: { comment: 'ask', launch: 'ask' } })
  m = applyMandatePatch(m, { actionModes: { comment: 'auto' } }).mandate
  assert.deepEqual(m.actionModes, { comment: 'auto', launch: 'ask' })
  assert.equal(decide(m, 'comment').allowed, true)
  m = applyMandatePatch(m, { actions: { comment: false } }).mandate
  assert.deepEqual(m.actionModes, { launch: 'ask' })
  assert.equal(m.actions.comment, false)
  m = applyMandatePatch(m, { actions: { launch: true } }).mandate
  assert.deepEqual(m.actionModes, {})
  assert.equal(decide(m, 'launch').allowed, true)
  m = applyMandatePatch(m, { actions: { comment: false }, actionModes: { comment: 'ask' } }).mandate
  assert.equal(m.actions.comment, true)
  assert.equal(m.actionModes.comment, 'ask')
  m = applyMandatePatch(m, { actionModes: { comment: 'typo' } }).mandate
  assert.equal(m.actions.comment, false)
  assert.equal(m.actionModes.comment, 'deny')
  const unchanged = applyMandatePatch(m, { paused: true }).mandate
  assert.deepEqual(unchanged.actionModes, m.actionModes)
  assert.deepEqual(unchanged.actions, m.actions)
  const supervised = applyMandatePatch(m, { level: 'L2' }).mandate
  assert.equal(supervised.actionModes.comment, 'ask', 'level selection resets the defaults')
  assert.equal(supervised.actionModes.launch, 'ask')
  assert.equal(supervised.actionModes.merge, 'deny')
})
