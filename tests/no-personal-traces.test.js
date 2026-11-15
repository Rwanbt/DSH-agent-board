// Privacy guard for a repository that is meant to be published.
//
// WHY THIS FILE EXISTS
// This repository ships its evidence: `docs/` carries audit reports, delivery
// notes and end-to-end transcripts that were transcribed from a real operator
// machine. A personal home directory in that evidence (a Windows profile path
// or a POSIX home path) leaks the account name of whoever ran the audit and the
// private layout of their machine. That is a privacy leak in a public repo, and
// it is invisible in review because the path is buried in prose or in a JSON
// transcript.
//
// WHAT IS CHECKED
// Every tracked text file is read exactly as git stores it, and every line is
// matched against two classes of personal home path:
//   - a Windows profile path (drive letter, `Users`, a person's folder), or
//   - a POSIX home path under the default home root.
// The only accepted form is the explicit `<user>` placeholder, so the evidence
// keeps all of its technical value (`C:\...\AppData\Local\Temp\...` still shows
// the whole chain) while the account name disappears.
//
// WHY THE PATTERNS LOOK ODD
// The scan is literal on purpose: it looks at the bytes as committed, so the
// same path must be caught whatever escaping the surrounding file uses.
// Markdown keeps single backslashes, JSON doubles them, and a JSON string that
// itself contains JSON quadruples them. The separators are therefore matched as
// a run of backslashes, and the negative lookahead accepts only a `<user>`
// placeholder right after the profile folder.
//
// The patterns are assembled from parts so that this file contains no literal
// home path of its own: the guard scans its own source like any other file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This test lives in `tests/`, so the repository root is one level up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Text formats that can carry a path to a reader. Binary assets (png, ico,
// woff, …) are excluded by this allow-list: an image cannot be reviewed as text
// and decoding it as UTF-8 would only produce noise.
const SCANNED_EXTENSIONS = new Set([
  '.md', '.js', '.mjs', '.json', '.yml', '.yaml', '.txt', '.svg', '.css', '.html',
])

// If discovery silently returns nothing (renamed root, empty checkout, git
// missing), the guard would be a no-op that "passes" forever. A real repository
// has far more text files than this, so refuse to pass on a thin scan.
const MINIMUM_FILES_SCANNED = 20

// Two characters: the regex source for one literal backslash. Built with
// `String.fromCharCode` so this file itself never contains a backslash run.
const ESCAPED_SEPARATOR = String.fromCharCode(92, 92)

// Windows profile path: drive letter, the `Users` folder, backslashes, and NO
// `<user>` placeholder after it. `(?![\\<])` rejects a partial backslash run so
// the escaped placeholder form (`...\\Users\\<user>`) never matches by mistake.
const WINDOWS_PROFILE = new RegExp(
  `C:${ESCAPED_SEPARATOR}+Users${ESCAPED_SEPARATOR}+(?![${ESCAPED_SEPARATOR}<])`,
)

// The same leak written with forward slashes, as produced by CLI arguments
// (e.g. `link:C:/Users/<name>/project`). Also only accepts the placeholder.
const WINDOWS_PROFILE_FORWARD = new RegExp('C:/+Users/+(?![\\/<])')

// POSIX home path: the default home root followed by a lowercase account name.
// A `<user>` placeholder starts with `<`, so it never matches.
const POSIX_HOME = /\/home\/[a-z]/

const PERSONAL_PATH_PATTERNS = [
  WINDOWS_PROFILE,
  WINDOWS_PROFILE_FORWARD,
  POSIX_HOME,
]

// `git ls-files` is the single source of truth for "tracked": an untracked
// scratch file may legitimately hold a real path, a committed one may not.
function trackedFiles() {
  let output
  try {
    output = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    assert.fail(`could not list tracked files with \`git ls-files\` in ${REPO_ROOT}: ${error.message}`)
  }
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function isScanned(file) {
  return SCANNED_EXTENSIONS.has(extname(file).toLowerCase())
}

function scanTrackedFiles() {
  const files = trackedFiles().filter(isScanned)
  const violations = []

  for (const file of files) {
    const absolute = join(REPO_ROOT, file)
    const content = readFileSync(absolute, 'utf8')
    const lines = content.split(/\r?\n/)

    for (const [index, line] of lines.entries()) {
      if (PERSONAL_PATH_PATTERNS.some(pattern => pattern.test(line))) {
        const excerpt = line.trim().slice(0, 160)
        violations.push({ file, line: index + 1, excerpt })
      }
    }
  }

  return { files, scannedFiles: files.length, violations }
}

// Scan once for the whole file: reading ~260 files three times would be wasteful
// and the two assertions below must describe the same snapshot.
let cachedScan = null
function scan() {
  if (cachedScan === null) cachedScan = scanTrackedFiles()
  return cachedScan
}

test('the scan really covers the tracked tree (a broken discovery cannot pass)', () => {
  const { scannedFiles } = scan()
  assert.ok(
    scannedFiles >= MINIMUM_FILES_SCANNED,
    `only ${scannedFiles} tracked text file(s) were scanned, expected at least ${MINIMUM_FILES_SCANNED}: ` +
      '`git ls-files` discovery is broken, so this guard proves nothing',
  )
})

test('no tracked text file leaks a personal home path', () => {
  const { violations } = scan()
  const details = violations
    .map(violation => `  ${violation.file}:${violation.line}  ${violation.excerpt}`)
    .join('\n')
  assert.equal(
    violations.length,
    0,
    `personal home path(s) found in ${violations.length} tracked line(s); ` +
      'replace the account name with the `<user>` placeholder:\n' +
      details,
  )
})

test('the guard is not vacuous: it flags a leak and accepts the placeholder', () => {
  const sep = String.fromCharCode(92)
  const prefix = 'C:' + sep

  // Built from parts, so this file itself never contains the literal leak.
  assert.ok(
    PERSONAL_PATH_PATTERNS.some(pattern => pattern.test(prefix + 'Users' + sep + 'someone')),
    'a real Windows profile path must be flagged',
  )
  assert.ok(
    !PERSONAL_PATH_PATTERNS.some(pattern => pattern.test(prefix + 'Users' + sep + '<user>' + sep + 'project')),
    'the placeholder form must never be flagged',
  )
})
