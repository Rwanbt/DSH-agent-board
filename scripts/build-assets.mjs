/**
 * Inline the approved mascot kit into the browser bundle.
 *
 * The plugin has no bundler: `src/client/ui/agent-bots-assets.js` is a plain ES
 * module whose `AGENT_BOT_ASSETS` map is concatenated into `src/client.js` by
 * `scripts/build-client.mjs`. Base64 keeps every SVG byte exact and needs no
 * runtime encoding.
 *
 * The two builders are pure and exported so a test can regenerate the map and
 * the module text in memory and fail on drift:
 *
 *   buildAgentBotAssets(rootDir)          -> { [identity]: { full, compact } }
 *   renderAgentBotAssetsModule(assets)    -> the exact generated module text
 *
 * The identity order is the sorted SVG basename, never the filesystem order, so
 * the output is deterministic. `super_orchestrator_bolt` is a visual emblem
 * variant of `super_orchestrator`, not a 16th role; it is inlined like the rest.
 *
 * Run: node scripts/build-assets.mjs
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = 'src/assets/agent-bots'
const GENERATED_DIR = 'src/client/ui'
const GENERATED_FILE = 'agent-bots-assets.js'
const HEADER = '/* GENERATED FILE — run node scripts/build-assets.mjs */'
const VARIANTS = Object.freeze(['full', 'compact'])

/** Read the SVG basenames of one approved variant, sorted for determinism. */
async function listIdentities(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read the ${directory} mascot directory: ${error.message}`)
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.svg'))
    .map(entry => entry.name.slice(0, -4))
    .sort()
}

/** Encode exact file bytes; never re-serialize or normalize the SVG. */
async function dataUriOf(file) {
  const bytes = await readFile(file)
  if (bytes.length === 0) throw new Error(`empty mascot asset: ${file}`)
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

/**
 * Pure async builder: reads `<rootDir>/src/assets/agent-bots/{full,compact}` and
 * returns the data-URI map. Throws when a variant is missing on one side.
 *
 * @param {string} [rootDir]
 * @returns {Promise<{ [identity: string]: { full: string, compact: string } }>}
 */
export async function buildAgentBotAssets(rootDir = ROOT) {
  const base = join(rootDir, ASSETS_DIR)
  const identitiesByVariant = {}
  for (const variant of VARIANTS) {
    identitiesByVariant[variant] = await listIdentities(join(base, variant))
  }
  const full = identitiesByVariant.full
  const compact = identitiesByVariant.compact
  if (full.length === 0) throw new Error(`no SVG found in ${join(base, 'full')}`)
  const missingCompact = full.filter(id => !compact.includes(id))
  const missingFull = compact.filter(id => !full.includes(id))
  if (missingCompact.length > 0 || missingFull.length > 0) {
    const parts = []
    if (missingCompact.length > 0) parts.push(`missing compact: ${missingCompact.join(', ')}`)
    if (missingFull.length > 0) parts.push(`missing full: ${missingFull.join(', ')}`)
    throw new Error(`mascot variants disagree (${parts.join('; ')})`)
  }
  const assets = {}
  for (const identity of full) {
    const [fullUri, compactUri] = await Promise.all(VARIANTS.map(variant => dataUriOf(join(base, variant, `${identity}.svg`))))
    assets[identity] = { full: fullUri, compact: compactUri }
  }
  return assets
}

/** Serialize the map exactly as it is committed. Deterministic and frozen. */
export function renderAgentBotAssetsModule(assets) {
  const lines = [HEADER, 'export const AGENT_BOT_ASSETS = Object.freeze({']
  const identities = Object.keys(assets).sort()
  for (const identity of identities) {
    const entry = assets[identity]
    lines.push(`  ${identity}: Object.freeze({ full: '${entry.full}', compact: '${entry.compact}' }),`)
  }
  lines.push('})', '')
  return lines.join('\n')
}

async function main() {
  const assets = await buildAgentBotAssets(ROOT)
  const source = renderAgentBotAssetsModule(assets)
  const destination = join(ROOT, GENERATED_DIR, GENERATED_FILE)
  await writeFile(destination, source, 'utf8')
  const identities = Object.keys(assets)
  console.log(`wrote ${destination} (${identities.length} identities, ${source.length} bytes)`)
  console.log(`identities: ${identities.join(', ')}`)
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  await main()
}
