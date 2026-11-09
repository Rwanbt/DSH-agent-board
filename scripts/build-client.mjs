/**
 * Build the browser artifact (`src/client.js`) with zero dependencies.
 *
 * The DSH client module table serves one file per plugin, loaded through
 * `window.__ModuleLoader__.load`. There is no bundler in this plugin (and adding
 * one would be a build dependency the plugin does not need), so this script
 * concatenates the authored modules in dependency order and strips the ESM
 * import/export syntax:
 *
 *   contracts/model.js -> supervisor/projection.js -> client/core.js -> client/app.js
 *
 * The load-bearing rule is the ORDER: every file only uses names defined by
 * itself or by an earlier file. The wrapper supplies React and the hooks.
 *
 * Run: node scripts/build-client.mjs
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PARTS = [
  'src/contracts/model.js',
  'src/supervisor/projection.js',
  'src/client/core.js',
  'src/client/app.js',
]

const IMPORT_LINE = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"][^'"]+['"]\s*;?\s*$/
const EXPORT_PREFIX = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/

function transform(source) {
  return source
    .split('\n')
    .filter(line => !IMPORT_LINE.test(line))
    .map(line => line.replace(EXPORT_PREFIX, ''))
    .join('\n')
}

const transformed = []
for (const relative of PARTS) {
  const source = await readFile(join(root, relative), 'utf8')
  transformed.push(`// ---- ${relative} ----\n${transform(source)}`)
}

const bundle = `/* GENERATED FILE — edit the modules under src/ and run scripts/build-client.mjs. */
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

const destination = join(root, 'src/client.js')
await writeFile(destination, bundle, 'utf8')
console.log(`built ${destination} (${bundle.length} bytes, ${PARTS.length} modules)`)
