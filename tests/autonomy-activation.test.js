import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIONS, READ_ONLY_ACTIONS, CRITICAL_ACTIONS, HUMAN_ONLY_ACTIONS, actionModesForLevel,
  applyMandatePatch, normalizeMandate, actionModeOf, effectivePolicyOf } from '../src/contracts/mandate.js'

const scoped = () => normalizeMandate({ level: 'L0', scopeMode: 'selected', selectedWorkspaces: ['ws:a'],
  projects: { 'ws:a': { enabled: true, level: null } }, requiresConfiguration: false })

for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
  test(`${level} selection applies its complete permission profile atomically`, () => {
    const before = scoped()
    const result = applyMandatePatch(before, { level })
    assert.equal(result.ok, true)
    assert.deepEqual(result.mandate.actionModes, actionModesForLevel(level))
    for (const field of ['scopeMode', 'selectedWorkspaces', 'projects']) {
      assert.deepEqual(result.mandate[field], before[field], field)
    }
    for (const action of ACTIONS.filter(action => !READ_ONLY_ACTIONS.includes(action))) {
      const mode = actionModeOf(result.mandate, action)
      if (level === 'L0' || level === 'L1') assert.equal(mode, 'deny')
      else if (HUMAN_ONLY_ACTIONS.includes(action)) assert.equal(mode, 'deny')
      else if (CRITICAL_ACTIONS.includes(action)) assert.equal(mode, level === 'L4' ? 'ask' : 'deny')
      else if (level === 'L2') assert.equal(mode, 'ask')
      else if (level === 'L4') assert.equal(mode, 'auto')
      const gate = effectivePolicyOf({ mandate: result.mandate, projectId: 'ws:a', action })
      if (mode === 'ask') assert.equal(gate.reason, 'approval_required', action)
      if (mode === 'auto') assert.equal(gate.allowed, true, action)
    }
  })
}

test('customization persists across unrelated patches, normalization and restart; reselecting a level resets defaults', () => {
  const selected = applyMandatePatch(scoped(), { level: 'L4' }).mandate
  const custom = applyMandatePatch(selected, { actionModes: { launch: 'deny', comment: 'ask' } }).mandate
  const unrelated = applyMandatePatch(custom, { paused: true }).mandate
  assert.equal(actionModeOf(unrelated, 'launch'), 'deny')
  assert.equal(actionModeOf(unrelated, 'comment'), 'ask')
  const reloaded = normalizeMandate(JSON.parse(JSON.stringify(unrelated)))
  assert.deepEqual(reloaded.actionModes, unrelated.actionModes)
  const reset = applyMandatePatch(reloaded, { level: 'L4' }).mandate
  assert.equal(actionModeOf(reset, 'launch'), 'auto')
  assert.equal(actionModeOf(reset, 'comment'), 'auto')
  assert.equal(reset.paused, true, 'a permission profile cannot resume execution')
})

test('same-patch explicit customization wins over the selected level profile', () => {
  const result = applyMandatePatch(scoped(), { level: 'L4',
    actions: { launch: false }, actionModes: { comment: 'ask' } })
  assert.equal(actionModeOf(result.mandate, 'launch'), 'deny')
  assert.equal(actionModeOf(result.mandate, 'comment'), 'ask')
  assert.equal(actionModeOf(result.mandate, 'create_task'), 'auto')
  assert.equal(applyMandatePatch(scoped(), { level: 'L5' }).reason, 'invalid_level')
})

test('loading old L4 deny-all state does not silently migrate grants', () => {
  const legacy = normalizeMandate({ ...scoped(), level: 'L4' })
  assert.equal(actionModeOf(legacy, 'launch'), 'deny')
  assert.equal(actionModeOf(applyMandatePatch(legacy, { level: 'L4' }).mandate, 'launch'), 'auto')
})
