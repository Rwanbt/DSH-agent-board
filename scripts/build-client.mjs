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
  // Role identity (15 mascot roles, declared-name aliases, status tones). Pure
  // and shared with the host; every UI module below may use it.
  'src/contracts/agent-roles.js',
  'src/supervisor/projection.js',
  // The Super Orchestrator is a pure projection of real host facts: the panel
  // renders it from the same function the host publishes in `/state`.
  'src/supervisor/super-orchestrator.js',
  'src/board/view.js',
  'src/board/hierarchy.js',
  // Cockpit view model (GOAL 5): flat, attention-first sections and the four
  // indicator buckets. Pure, built on top of view.js/hierarchy.js.
  'src/board/overview.js',
  'src/board/interaction.js',
  'src/client/core.js',
  'src/client/ui/strings.js',
  'src/client/ui/styles.js',
  'src/client/ui/select.js',
  // Mascot data URIs must precede the avatar component that looks them up.
  'src/client/ui/agent-bots-assets.js',
  'src/client/ui/avatar.js',
  'src/client/ui/card.js',
  'src/client/ui/hierarchy.js',
  // Cockpit components: indicators/grid (overview), supervision band (superbar).
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

function transform(source) {
  // Strip ESM syntax. The import pattern is multi-line tolerant (`[^'"]` crosses
  // newlines), so a formatted `import {\n  a,\n  b,\n} from '…'` never leaks into
  // the browser artifact.
  return source.replace(IMPORT_STATEMENT, '').replace(EXPORT_PREFIX, '')
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
