/**
 * Dev utility: write a self-contained HTML gallery of the approved mascots.
 *
 * It reads the versioned assets under `src/assets/agent-bots/` (full/, compact/,
 * roles.json), inlines every SVG as a data URI and writes one HTML file so a
 * human or Playwright can inspect all 32 drawings (16 identities x 2 variants)
 * without a server, a dependency or the browser bundle.
 *
 * Read-only for the repository: it only writes the output file.
 *
 * Usage:
 *   node scripts/mascot-gallery.mjs [output.html]
 *   # default: $TEMP/agent-board-mascot-gallery.html
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_ROOT = join(root, 'src', 'assets', 'agent-bots')
const output = resolve(process.argv[2] ?? join(process.env.TEMP ?? '/tmp', 'agent-board-mascot-gallery.html'))

const dataUri = async path => `data:image/svg+xml;base64,${(await readFile(path)).toString('base64')}`

const roles = JSON.parse(await readFile(join(ASSET_ROOT, 'roles.json'), 'utf8')).roles
const variants = ['full', 'compact']
const files = new Set()
for (const variant of variants) {
  for (const name of await readdir(join(ASSET_ROOT, variant))) {
    if (name.endsWith('.svg')) files.add(`${variant}/${name}`)
  }
}

// Every roles.json entry, plus the bolt emblem (the same role, a graphic
// variant: it is NOT a 16th role and must not be counted as one).
const identities = roles.map(role => ({
  id: role.id,
  label: role.label,
  meta: `${role.category} · ${role.shape}`,
  color: role.color,
  note: role.emblem === 'crown' ? 'emblème couronne (défaut)' : null,
}))
identities.push({
  id: 'super_orchestrator_bolt',
  label: 'Super Orchestrator (éclair)',
  meta: 'governance · triangle',
  color: '#7043DB',
  note: 'variante graphique du même rôle, pas un 16e rôle',
})

const sources = Object.fromEntries(await Promise.all(identities.map(async identity => {
  const entry = {}
  for (const variant of variants) {
    const relative = `${variant}/${identity.id}.svg`
    if (!files.has(relative)) throw new Error(`missing asset: ${relative}`)
    entry[variant] = await dataUri(join(ASSET_ROOT, variant, `${identity.id}.svg`))
    files.delete(relative)
  }
  return [identity.id, entry]
})))

if (files.size > 0) throw new Error(`orphan SVG not described by the gallery: ${[...files].join(', ')}`)

const rows = identities.map(identity => `<tr>
  <td class="meta">
    <b>${identity.label}</b><br><code>${identity.id}</code><br>${identity.meta}<br>
    <span class="swatch" style="background:${identity.color}"></span> <code>${identity.color}</code>
    ${identity.note !== null ? `<br><em>${identity.note}</em>` : ''}
  </td>
  <td><img src="${sources[identity.id].full}" width="120" height="120" alt="${identity.label} — full"></td>
  <td><img src="${sources[identity.id].compact}" width="40" height="40" alt="${identity.label} — compact"></td>
</tr>`).join('\n')

const html = `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<title>Agent Board — 15 rôles + emblème éclair</title>
<style>
  body { font: 13px/1.4 system-ui, sans-serif; margin: 24px; color: #1b1f24; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #5b6470; margin: 0 0 18px; max-width: 70ch; }
  table { border-collapse: collapse; }
  td { border-bottom: 1px solid #e6e9ee; padding: 8px 16px 8px 0; vertical-align: middle; }
  .meta { width: 280px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  code { color: #5b6470; }
  em { color: #5b6470; }
  img { background: #f6f7f9; border-radius: 8px; }
</style>
<h1>Agent Board — 15 rôles + emblème éclair</h1>
<p>Rendu direct des SVG versionnés sous <code>src/assets/agent-bots/</code> : 16 identités × full/compact = 32 fichiers.
La couleur exprime le rôle ; l'état runtime est rendu séparément par le composant AgentAvatar.</p>
<table>${rows}</table>
</html>
`

await writeFile(output, html, 'utf8')
console.log(`wrote ${output} (${identities.length} identities, ${variants.length} variants, ${html.length} bytes)`)
