/**
 * Independent review checks for the generated browser artifact and for the
 * strength of two existing assertions (bundle integrity, CSS animation rule,
 * deep-chain "linear" performance test).
 *
 * Everything is read-only: the bundle is rebuilt IN MEMORY with the exact
 * transformation of scripts/build-client.mjs and compared with the committed
 * src/client.js. Nothing under src/** is written or regenerated.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ROOT = new URL('../', import.meta.url)
const PARTS = [
  'src/contracts/model.js',
  'src/contracts/agent-roles.js',
  'src/supervisor/projection.js',
  'src/supervisor/super-orchestrator.js',
  'src/board/view.js',
  'src/board/hierarchy.js',
  'src/board/overview.js',
  'src/board/interaction.js',
  'src/client/core.js',
  'src/client/ui/strings.js',
  'src/client/ui/styles.js',
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

// Same transformation as scripts/build-client.mjs: multi-line tolerant, so a
// formatted `import {\n … } from '…'` can never leak into the artifact.
const IMPORT_STATEMENT = /^[ \t]*import\s+(?:[^'"]*?\s+from\s+)?['"][^'"]+['"][ \t]*;?[ \t]*\r?\n?/gm
const EXPORT_PREFIX = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm

function transform(source) {
  return source.replace(IMPORT_STATEMENT, '').replace(EXPORT_PREFIX, '')
}

async function rebuiltBundle() {
  const transformed = []
  for (const relative of PARTS) {
    transformed.push(`// ---- ${relative} ----\n${transform(await readFile(new URL(relative, ROOT), 'utf8'))}`)
  }
  return `/* GENERATED FILE — edit the modules under src/ and run scripts/build-client.mjs. */
window.__ModuleLoader__.load({
  id: 'dsh-agent-board',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo, useSyncExternalStore, useCallback, useRef } = React
${transformed.join('\n\n')}

    return { name: 'dsh-agent-board/client', inject: ['slots'], apply }
  },
})
`
}

test('artifact integrity: src/client.js is byte-identical to the concatenated current modules', async () => {
  const expected = await rebuiltBundle()
  const actual = await readFile(new URL('src/client.js', ROOT), 'utf8')
  assert.equal(actual, expected, 'src/client.js is stale: rebuild scripts/build-client.mjs (do not commit a hand-edited bundle)')
  assert.doesNotMatch(actual, /^export /m, 'no ESM export survives the transform')
})

test('artifact integrity: no innerHTML/eval/new Function/document.write in the client code', async () => {
  const bundle = await readFile(new URL('src/client.js', ROOT), 'utf8')
  for (const pattern of ['innerHTML', 'dangerouslySetInnerHTML', 'eval(', 'new Function', 'document.write']) {
    assert.equal(bundle.includes(pattern), false, `src/client.js must not use ${pattern}`)
  }
  for (const relative of PARTS) {
    const source = await readFile(new URL(relative, ROOT), 'utf8')
    for (const pattern of ['innerHTML', 'dangerouslySetInnerHTML', 'eval(', 'new Function', 'document.write']) {
      assert.equal(source.includes(pattern), false, `${relative} must not use ${pattern}`)
    }
  }
})

test('artifact integrity: the client module list is exactly the one scripts/build-client.mjs documents', async () => {
  const script = await readFile(new URL('scripts/build-client.mjs', ROOT), 'utf8')
  for (const relative of PARTS) assert.ok(script.includes(`'${relative}'`), `${relative} is in the reviewed build list`)
  assert.equal((script.match(/^ {2}'src\//gm) ?? []).length, PARTS.length, 'the reviewed list and the build list have the same size')
})

test('review: the "only the running mark animates" CSS assertion is bypassed by animation-name', async () => {
  const css = await readFile(new URL('src/client/ui/styles.js', ROOT), 'utf8')
  // Current state: exactly one shorthand animation, on the running ring.
  const animated = css.split('\n').filter(line => /animation:\s*dab-/.test(line))
  assert.equal(animated.length, 1)
  assert.match(animated[0], /data-status="running"/)
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-status="running"\]::before \{ animation: none/)

  // Mutation that the existing assertion cannot see: a second animation
  // declared with the longhand property keeps the shorthand count at one.
  const mutated = css.replace(
    '.dab-mark[data-status="unknown"]::before {',
    '.dab-mark[data-status="unknown"]::before { animation-name: dab-pulse;',
  )
  assert.notEqual(mutated, css, 'the mutation applies to the current stylesheet')
  const mutatedAnimated = mutated.split('\n').filter(line => /animation:\s*dab-/.test(line))
  assert.equal(mutatedAnimated.length, 1, 'the existing assertion still counts one shorthand animation')
  assert.match(mutated, /prefers-reduced-motion: reduce[\s\S]*data-status="running"\]::before \{ animation: none/)
  assert.ok(mutated.includes('animation-name: dab-pulse'), 'a second animated element would ship with the suite green')
})

test('review: the 1500 ms deep-chain threshold does not distinguish O(n^2) from O(n)', () => {
  const count = 2000
  const byId = new Map()
  for (let index = 0; index < count; index += 1) {
    const id = `n${String(index).padStart(4, '0')}`
    byId.set(id, { id, parentId: index === 0 ? null : `n${String(index - 1).padStart(4, '0')}` })
  }
  // The old per-node upward walk (quadratic) on the exact fixture used by
  // tests/supervision-identity.test.js, which only asserts elapsed < 1500 ms.
  let visits = 0
  const started = performance.now()
  for (const node of byId.values()) {
    let cursor = node
    while (cursor.parentId !== null) { cursor = byId.get(cursor.parentId); visits += 1 }
  }
  const quadraticMs = performance.now() - started
  assert.equal(visits, (count * (count - 1)) / 2, 'the walk is the quadratic one')
  assert.ok(quadraticMs < 1500, `a quadratic implementation stays under the existing threshold (${quadraticMs.toFixed(1)} ms)`)
})
