import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeActionPayload } from '../src/contracts/action-payloads.js'

const pr = { title: 'Change', head: 'feat/test', base: 'main', body: 'Evidence' }
test('canonical action payloads reject owner fields, commands and malformed branches', () => {
  assert.deepEqual(sanitizeActionPayload('open_pr', pr), { ok: true, payload: pr })
  assert.deepEqual(sanitizeActionPayload('open_pr', { ...pr, repository: 'owner/repo' }).payload.repository, 'owner/repo')
  assert.equal(sanitizeActionPayload('open_pr', { ...pr, repository: 'https://attacker/repo' }).ok, false)
  for (const field of ['token', 'command', 'permission', 'status']) {
    assert.deepEqual(sanitizeActionPayload('open_pr', { ...pr, [field]: 'hostile' }),
      { ok: false, reason: 'payload_field_forbidden', fields: [field] })
  }
  for (const head of ['../main', '-unsafe', 'a//b', 'a.lock', 'main', 'a; rm -rf x']) {
    assert.equal(sanitizeActionPayload('open_pr', { ...pr, head }).ok, false, head)
  }
  assert.equal(sanitizeActionPayload('open_pr', { ...pr, title: '' }).ok, false)
  assert.equal(sanitizeActionPayload('open_pr', []).ok, false)
  assert.deepEqual(sanitizeActionPayload('delegate', null), { ok: true, payload: {} })
  assert.equal(sanitizeActionPayload('delegate', { permission: 'danger-full-access' }).reason, 'payload_field_forbidden')
  assert.equal(sanitizeActionPayload('launch', { prompt: 'override' }).ok, false)
  assert.deepEqual(sanitizeActionPayload('comment', { body: 'ok' }), { ok: true, payload: { body: 'ok' } })
})

test('delete and policy payloads cannot carry lifecycle, global rights or worker escalation', () => {
  assert.deepEqual(sanitizeActionPayload('delete_task', { reason: 'Duplicate' }), { ok: true, payload: { reason: 'Duplicate' } })
  assert.equal(sanitizeActionPayload('delete_task', {}).ok, false)
  assert.equal(sanitizeActionPayload('delete_task', { reason: 'x', force: true }).reason, 'payload_field_forbidden')
  assert.deepEqual(sanitizeActionPayload('policy_change', { priority: 0, maxTasksPerHour: 100 }),
    { ok: true, payload: { priority: 0, maxTasksPerHour: 100 } })
  for (const payload of [{}, { priority: 10 }, { priority: 1.5 }, { maxTasksPerHour: -1 }, { maxTasksPerHour: 101 }]) {
    assert.equal(sanitizeActionPayload('policy_change', payload).ok, false)
  }
  for (const key of ['scopeMode', 'level', 'actions', 'allowedPermissions', 'permission', 'model', 'maxConcurrent']) {
    assert.equal(sanitizeActionPayload('policy_change', { [key]: 'hostile' }).reason, 'payload_field_forbidden', key)
  }
})

test('merge payloads identify a PR, default the method, and bind full immutable SHAs', () => {
  assert.deepEqual(sanitizeActionPayload('merge', { number: 42 }), { ok: true, payload: { number: 42, method: 'squash' } })
  assert.equal(sanitizeActionPayload('merge', { number: 42, headSha: 'A'.repeat(40) }).payload.headSha, 'a'.repeat(40))
  for (const payload of [{}, { number: -1 }, { number: 1.2 }, { number: '42' }, { number: 42, headSha: 'main' },
    { number: 42, method: 'admin' }, { number: 42, baseSha: 'abc' }, { number: 42, token: 'secret' }, { number: 42, force: true }]) {
    assert.equal(sanitizeActionPayload('merge', payload).ok, false, JSON.stringify(payload))
  }
})
