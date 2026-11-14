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
