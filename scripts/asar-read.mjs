#!/usr/bin/env node
/**
 * Read-only helper for the installed DSH app.asar (Electron archive).
 *
 * The running installation ships its built-in packages inside app.asar, so
 * contract questions ("does CreateAgentOptions.setup return a commit?") cannot
 * be answered from the profile node_modules. This script parses the archive
 * header only and extracts the requested entries on demand. It never writes
 * into the installation.
 *
 * Usage:
 *   node scripts/asar-read.mjs list <regex>
 *   node scripts/asar-read.mjs read <entry> [...]
 *   node scripts/asar-read.mjs grep <regex> <pathRegex>
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

// The desktop install keeps the built-in packages inside app.asar. Override
// with DSH_ASAR when the app lives somewhere else (or for a portable install).
const ARCHIVE = process.env.DSH_ASAR
  ?? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'),
    'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

function openArchive() {
  const fd = openSync(ARCHIVE, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  // The header is an 8-byte pickle prefix: [pickle payload size][JSON length],
  // then the JSON text. Data offsets are relative to 8 + the declared size.
  const jsonLength = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonLength))
  const dataStart = 8 + headerSize
  return { fd, header, dataStart }
}

function* walk(node, prefix = '') {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) yield* walk(entry, path)
    else yield { path, entry }
  }
}

function readEntry(archive, entry) {
  const buffer = Buffer.alloc(entry.size)
  readSync(archive.fd, buffer, 0, entry.size, archive.dataStart + Number(entry.offset))
  return buffer
}

const [command, ...rest] = process.argv.slice(2)
const archive = openArchive()
try {
  if (command === 'list') {
    const pattern = new RegExp(rest[0] ?? '.')
    for (const file of walk(archive.header)) if (pattern.test(file.path)) console.log(file.path)
  } else if (command === 'read') {
    for (const wanted of rest) {
      const file = [...walk(archive.header)].find(candidate => candidate.path === wanted)
      if (file === undefined) {
        console.error(`not found: ${wanted}`)
        process.exitCode = 1
        continue
      }
      process.stdout.write(readEntry(archive, file.entry))
      process.stdout.write('\n')
    }
  } else if (command === 'grep') {
    const pattern = new RegExp(rest[0] ?? '.')
    const pathPattern = new RegExp(rest[1] ?? '.(d\\.ts|js)$')
    let hits = 0
    for (const file of walk(archive.header)) {
      if (file.entry.size > 2_000_000) continue
      if (!pathPattern.test(file.path)) continue
      const text = readEntry(archive, file.entry).toString('utf8')
      if (!pattern.test(text)) continue
      hits += 1
      for (const line of text.split('\n')) if (pattern.test(line)) console.log(`${file.path}: ${line.trim().slice(0, 300)}`)
      if (hits > 60) break
    }
    if (hits === 0) console.error('no match')
  } else {
    console.error('usage: list <regex> | read <entry...> | grep <regex> [pathRegex]')
    process.exitCode = 2
  }
} finally {
  closeSync(archive.fd)
}
