import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activeDirectives,
  addDirective,
  directivesFingerprint,
  normalizeDirective,
  resolveDirectives,
  revokeDirective,
} from '../src/superagent/directives.js'

test('normalizeDirective is total, bounded and drops unknown keys', () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":true},"id":"d1","scope":"PROJECT","projectId":"ws1",'
    + '"text":"  ' + 'x'.repeat(5000) + '  ","author":"mallory","version":"3",'
    + '"status":"REVOKED","source":"migration","token":"tok_live_1"}',
  )
  const normalized = normalizeDirective(hostile, { now: 42 })
  assert.equal(normalized.id, 'd1')
  assert.equal(normalized.scope, 'project')
  assert.equal(normalized.projectId, 'ws1')
  assert.equal(normalized.text.length, 400)
  assert.equal(normalized.author, 'operator')
  assert.equal(normalized.version, 3)
  assert.equal(normalized.status, 'revoked')
  assert.equal(normalized.source, 'migration')
  assert.equal(normalized.token, undefined)
  assert.equal({}.polluted, undefined)

  for (const garbage of [null, undefined, [], 'nope', 7]) {
    const result = normalizeDirective(garbage, { now: 9 })
    assert.equal(result.status, 'active')
    assert.equal(result.scope, 'global')
    assert.equal(result.projectId, null)
    assert.equal(result.createdAt, 9)
  }

  const inert = normalizeDirective({ scope: 'project', text: 'stay tidy' }, { now: 1 })
  assert.equal(inert.scope, 'project')
  assert.equal(inert.projectId, null, 'an unscoped project directive must stay inert, never become global')
})

test('addDirective is deterministic and refuses invalid project scopes', () => {
  const first = addDirective([], { text: 'Never deploy on Friday', scope: 'global', source: 'api' }, { now: 100 })
  const second = addDirective([], { text: 'Never deploy on Friday', scope: 'global', source: 'api' }, { now: 100 })
  assert.deepEqual(first, second)
  assert.equal(first.directives.length, 1)
  assert.equal(first.directive.id, second.directive.id)
  assert.equal(first.directive.author, 'operator')
  assert.equal(first.directive.source, 'api')
  assert.equal(first.directive.createdAt, 100)

  const refusedText = addDirective(first.directives, { text: '   ', scope: 'global' }, { now: 101 })
  assert.equal(refusedText.directive, null)
  assert.deepEqual(refusedText.directives, first.directives)

  const refusedProject = addDirective(first.directives, { text: 'Only touch ws1', scope: 'project' }, { now: 101 })
  assert.equal(refusedProject.directive, null)
  assert.deepEqual(refusedProject.directives, first.directives)

  const project = addDirective(first.directives, { text: 'Only touch ws1', scope: 'project', projectId: 'ws1' }, { now: 102 })
  assert.equal(project.directive.scope, 'project')
  assert.equal(project.directive.projectId, 'ws1')
  assert.equal(project.directives.length, 2)
})

test('a revoked directive is never active and revocation is not silently repeated', () => {
  const added = addDirective([], { text: 'Never force-push', scope: 'global' }, { now: 10 })
  const revoked = revokeDirective(added.directives, added.directive.id, { now: 20 })
  assert.equal(revoked.ok, true)
  assert.equal(revoked.directive.status, 'revoked')
  assert.equal(revoked.directive.version, 2)
  assert.equal(revoked.directive.updatedAt, 20)
  assert.deepEqual(activeDirectives(revoked.directives), [])
  assert.equal(resolveDirectives(revoked.directives).blocks.length, 0)

  const again = revokeDirective(revoked.directives, added.directive.id, { now: 30 })
  assert.equal(again.ok, false)
  assert.deepEqual(again.directives, revoked.directives)
  assert.equal(again.directive.updatedAt, 20, 'an already revoked directive is untouched')

  const unknown = revokeDirective(revoked.directives, 'does-not-exist', { now: 40 })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.directive, null)
  assert.deepEqual(unknown.directives, revoked.directives)
})

test('activeDirectives filters by status/project and keeps a stable order', () => {
  const global = addDirective([], { text: 'Be careful', scope: 'global' }, { now: 10 })
  const ws1 = addDirective(global.directives, { text: 'Only ws1', scope: 'project', projectId: 'ws1' }, { now: 20 })
  const ws2 = addDirective(ws1.directives, { text: 'Only ws2', scope: 'project', projectId: 'ws2' }, { now: 30 })
  const revoked = revokeDirective(ws2.directives, ws2.directive.id, { now: 40 })

  assert.deepEqual(activeDirectives(revoked.directives, { projectId: 'ws1' }).map(entry => entry.text), ['Be careful', 'Only ws1'])
  assert.deepEqual(activeDirectives(revoked.directives, { projectId: 'ws2' }).map(entry => entry.text), ['Be careful'])
  assert.deepEqual(activeDirectives(revoked.directives).map(entry => entry.text), ['Be careful'])
  assert.deepEqual(activeDirectives(revoked.directives, { projectId: 'ws1' }), activeDirectives(revoked.directives, { projectId: 'ws1' }))
  assert.equal(activeDirectives(revoked.directives, { projectId: 'ws1' }).length, 2)
})

test('resolveDirectives reports only genuinely unmergeable opposite-polarity conflicts', () => {
  const global = addDirective([], { text: 'Never  run   tests.', scope: 'global' }, { now: 10 })
  const project = addDirective(global.directives, { text: 'Always run tests', scope: 'project', projectId: 'ws1' }, { now: 20 })
  const resolved = resolveDirectives(project.directives, { projectId: 'ws1' })
  assert.deepEqual(resolved.blocks, ['Never  run   tests.', 'Always run tests'])
  assert.equal(resolved.conflicts.length, 1)
  assert.equal(resolved.conflicts[0].reason, 'opposite_polarity')
  assert.equal(resolved.conflicts[0].aId, project.directives[0].id)
  assert.equal(resolved.conflicts[0].bId, project.directives[1].id)
  assert.equal(resolved.restricted, true)
  assert.deepEqual(resolveDirectives(project.directives, { projectId: 'other' }).conflicts, [])

  const nonConflicting = resolveDirectives([
    { text: 'Always run tests', scope: 'global', id: 'a', createdAt: 1 },
    { text: 'Never deploy on Friday', scope: 'global', id: 'b', createdAt: 2 },
    { text: 'Prefer small PRs', scope: 'global', id: 'c', createdAt: 3 },
    { text: 'Rollback quickly', scope: 'global', id: 'd', createdAt: 4 },
  ])
  assert.deepEqual(nonConflicting.conflicts, [])
  assert.equal(nonConflicting.blocks.length, 4)
  assert.equal(resolveDirectives([]).restricted, false)
})

test('directivesFingerprint is deterministic and sensitive to status/text but not key order', () => {
  const list = [
    { id: 'b', text: 'second', scope: 'global', status: 'active', createdAt: 2, updatedAt: 2, version: 1 },
    { id: 'a', text: 'first', scope: 'global', status: 'active', createdAt: 1, updatedAt: 1, version: 1 },
  ]
  const reordered = [list[1], list[0]]
  assert.equal(directivesFingerprint(list), directivesFingerprint(reordered))
  assert.match(directivesFingerprint(list), /^dirfp1-[0-9a-f]{16}$/)

  const revoked = [{ ...list[1], status: 'revoked' }, list[0]]
  assert.notEqual(directivesFingerprint(list), directivesFingerprint(revoked))
  const edited = [{ ...list[1], text: 'changed' }, list[0]]
  assert.notEqual(directivesFingerprint(list), directivesFingerprint(edited))

  for (const garbage of [null, undefined, 'x', {}, [null, 42, []]]) {
    assert.equal(typeof directivesFingerprint(garbage), 'string')
  }
})
