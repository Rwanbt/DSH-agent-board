import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGENT_BOT_ASSETS } from '../src/client/ui/agent-bots-assets.js'
import { buildAgentBotAssets, renderAgentBotAssetsModule } from '../scripts/build-assets.mjs'
import { AGENT_ROLE_IDS } from '../src/contracts/agent-roles.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'src', 'assets', 'agent-bots')
const GENERATED = join(ROOT, 'src', 'client', 'ui', 'agent-bots-assets.js')
const VARIANTS = ['full', 'compact']

const rolesJson = JSON.parse(await readFile(join(ASSETS, 'roles.json'), 'utf8'))
const rolesById = new Map(rolesJson.roles.map(role => [role.id, role]))
const identities = [...AGENT_ROLE_IDS, 'super_orchestrator_bolt'].sort()

async function svgNames(variant) {
  const entries = await readdir(join(ASSETS, variant), { withFileTypes: true })
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.svg')).map(entry => entry.name.slice(0, -4)).sort()
}

const svgFiles = new Map()
for (const variant of VARIANTS) {
  for (const identity of await svgNames(variant)) {
    const bytes = await readFile(join(ASSETS, variant, `${identity}.svg`))
    svgFiles.set(`${variant}/${identity}`, { bytes, text: bytes.toString('utf8') })
  }
}

/** Minimal strict tag-balance check: no DOM parser is available in node:test. */
function assertBalancedXml(text, label) {
  const stack = []
  let count = 0
  for (const match of text.matchAll(/<[^>]*>/g)) {
    const token = match[0]
    count += 1
    if (token.startsWith('<?') || token.startsWith('<!')) continue
    const closing = token.match(/^<\/([A-Za-z][\w.-]*)\s*>$/)
    if (closing !== null) {
      assert.equal(stack.pop(), closing[1], `${label}: mismatched closing tag ${token}`)
      continue
    }
    const opening = token.match(/^<([A-Za-z][\w.-]*)(?:\s[^>]*)?>$/)
    assert.ok(opening !== null, `${label}: malformed tag ${token}`)
    if (!token.endsWith('/>')) stack.push(opening[1])
  }
  assert.ok(count > 0, `${label}: no tags found`)
  assert.deepEqual(stack, [], `${label}: unclosed tags ${stack.join(', ')}`)
}

/** The middle stop of the body gradient is the role's declared colour. */
function declaredRoleColor(text, label) {
  const gradient = text.match(/<linearGradient id="gradient-[^"]*"[^>]*>([\s\S]*?)<\/linearGradient>/)
  assert.ok(gradient !== null, `${label}: no body gradient`)
  const stops = [...gradient[1].matchAll(/stop-color="([^"]+)"/g)].map(match => match[1])
  assert.equal(stops.length, 3, `${label}: the body gradient must have exactly 3 stops`)
  return stops[1]
}

test('the approved kit is copied whole: 15 roles + the bolt emblem, both variants', async () => {
  for (const variant of VARIANTS) {
    const names = await svgNames(variant)
    assert.equal(names.length, 16, `${variant}: 16 SVG identities expected`)
    assert.deepEqual(names, identities, `${variant}: exact identity set`)
  }
  assert.deepEqual([...AGENT_ROLE_IDS].sort(), rolesJson.roles.map(role => role.id).sort())
  assert.equal(AGENT_ROLE_IDS.length, 15)
  assert.ok(svgFiles.has('full/super_orchestrator_bolt'))
  assert.ok(svgFiles.has('compact/super_orchestrator_bolt'))
  assert.ok(!AGENT_ROLE_IDS.includes('super_orchestrator_bolt'), 'the bolt is a graphic variant, not a 16th role')
})

test('every SVG is a 256x256, script-free, external-reference-free vector', () => {
  for (const [key, { text }] of svgFiles) {
    assert.match(text, /<svg\b[^>]*\bviewBox="0 0 256 256"/, `${key}: common viewBox`)
    assert.doesNotMatch(text, /<script[\s>]/i, `${key}: no script`)
    assert.doesNotMatch(text, /<image[\s>]/i, `${key}: no raster image`)
    assert.doesNotMatch(text, /<foreignObject[\s>]/i, `${key}: no foreignObject`)
    assert.doesNotMatch(text, /xlink:href\s*=/i, `${key}: no xlink:href`)
    assert.doesNotMatch(text, /\s(?:href|src)\s*=\s*["'](?:https?:)?\/\//i, `${key}: no external href/src`)
    assert.doesNotMatch(text, /url\(\s*['"]?(?:https?:)?\/\//i, `${key}: no external CSS url()`)
    assert.doesNotMatch(text, /data:image\/(?!svg\+xml)/i, `${key}: no embedded raster`)
    assertBalancedXml(text, key)
  }
})

test('the SVG declared role colour equals roles.json (case-insensitive)', () => {
  for (const variant of VARIANTS) {
    for (const identity of AGENT_ROLE_IDS) {
      const { text } = svgFiles.get(`${variant}/${identity}`)
      const expected = rolesById.get(identity).color
      assert.equal(declaredRoleColor(text, `${variant}/${identity}`).toLowerCase(), expected.toLowerCase(),
        `${variant}/${identity}: role colour drift`)
    }
    for (const identity of ['super_orchestrator_bolt']) {
      const { text } = svgFiles.get(`${variant}/${identity}`)
      assert.equal(declaredRoleColor(text, `${variant}/${identity}`).toLowerCase(), rolesById.get('super_orchestrator').color.toLowerCase(),
        `${variant}/${identity}: the bolt is the same role colour`)
    }
  }
})

test('AGENT_BOT_ASSETS covers all 16 identities with both variants', () => {
  assert.deepEqual(Object.keys(AGENT_BOT_ASSETS).sort(), identities)
  for (const identity of identities) {
    for (const variant of VARIANTS) {
      assert.equal(typeof AGENT_BOT_ASSETS[identity][variant], 'string', `${identity}.${variant}`)
      assert.ok(AGENT_BOT_ASSETS[identity][variant].startsWith('data:image/svg+xml;base64,'), `${identity}.${variant}: data URI`)
    }
  }
})

test('every data URI decodes back to the exact file bytes', () => {
  for (const identity of identities) {
    for (const variant of VARIANTS) {
      const uri = AGENT_BOT_ASSETS[identity][variant]
      const encoded = uri.slice('data:image/svg+xml;base64,'.length)
      const decoded = Buffer.from(encoded, 'base64')
      const onDisk = svgFiles.get(`${variant}/${identity}`).bytes
      assert.equal(decoded.length, onDisk.length, `${identity}.${variant}: decoded length`)
      assert.ok(decoded.equals(onDisk), `${identity}.${variant}: decoded bytes differ from the file`)
    }
  }
})

test('the generated module is up to date with the assets (drift test)', async () => {
  const rebuilt = await buildAgentBotAssets(ROOT)
  assert.deepEqual(rebuilt, AGENT_BOT_ASSETS, 'regenerated map differs from the committed map')
  const expectedText = renderAgentBotAssetsModule(rebuilt)
  const onDisk = await readFile(GENERATED, 'utf8')
  assert.equal(onDisk, expectedText, 'src/client/ui/agent-bots-assets.js must be regenerated (node scripts/build-assets.mjs)')
  assert.ok(onDisk.startsWith('/* GENERATED FILE'), 'generated header')
})

test('the builder is deterministic', async () => {
  const first = await buildAgentBotAssets(ROOT)
  const second = await buildAgentBotAssets(ROOT)
  assert.deepEqual(first, second)
  assert.equal(renderAgentBotAssetsModule(first), renderAgentBotAssetsModule(second))
})
