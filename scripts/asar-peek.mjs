/**
 * Minimal read-only ASAR reader (dev utility, no dependency).
 *
 * The DSH desktop build ships its sources inside `resources/app.asar`, which
 * shell tools (rg, cat) cannot open. This script parses the archive header, then
 * lists, searches or extracts files for inspection. Read-only: it never writes
 * into the archive.
 *
 * Usage:
 *   node scripts/asar-peek.mjs list <asar> [prefix]
 *   node scripts/asar-peek.mjs grep <asar> <regex> [pathPrefix]
 *   node scripts/asar-peek.mjs cat  <asar> <path>
 */

import { readFile } from 'node:fs/promises'

const [action, archivePath, arg, extra] = process.argv.slice(2)
if (!archivePath) {
  console.error('usage: asar-peek.mjs <list|grep|cat> <app.asar> [arg] [extra]')
  process.exit(2)
}

const buffer = await readFile(archivePath)
const headerSize = buffer.readUInt32LE(8)
const jsonLength = buffer.readUInt32LE(12)
const header = JSON.parse(buffer.slice(16, 16 + jsonLength).toString('utf8'))
const dataStart = 8 + headerSize

const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, full)
    else files.push({ path: full, size: Number(entry.size), offset: Number(entry.offset), unpacked: entry.unpacked === true })
  }
}
walk(header, '')

const readEntry = entry => {
  if (entry.unpacked) throw new Error(`unpacked entry, read it from app.asar.unpacked: ${entry.path}`)
  return buffer.slice(dataStart + entry.offset, dataStart + entry.offset + entry.size)
}

if (action === 'list') {
  const prefix = arg ?? ''
  for (const file of files) {
    if (file.path.startsWith(prefix)) console.log(`${file.size}\t${file.path}`)
  }
} else if (action === 'grep') {
  const regex = new RegExp(arg, 'i')
  const prefix = extra ?? ''
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue
    if (file.size > 4_000_000) continue
    let text
    try {
      text = readEntry(file).toString('utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index])) console.log(`${file.path}:${index + 1}: ${lines[index].trim().slice(0, 240)}`)
    }
  }
} else if (action === 'cat') {
  const entry = files.find(file => file.path === arg)
  if (entry === undefined) {
    console.error(`not found: ${arg}`)
    process.exit(1)
  }
  process.stdout.write(readEntry(entry))
} else {
  console.error(`unknown action ${action}`)
  process.exit(2)
}
