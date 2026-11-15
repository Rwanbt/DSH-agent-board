/**
 * The release version has ONE meaning, and three places to get it wrong.
 *
 * `package.json` is what a package manager downloads; `BUILD_VERSION` is what the
 * running host reports in `/state`; the newest `CHANGELOG.md` heading is what the
 * release notes claim. They drifted to 0.1.0 / 0.2.0 / 0.3.0 at once, so an
 * operator installing the plugin got a version the notes never described.
 *
 * This test pins the three together. It fails on a bump that forgets a place,
 * which is exactly the mistake it exists to catch.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BUILD_VERSION } from '../src/host/index.js'

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')

test('package.json, the published build and the changelog agree on the version', async () => {
  const manifest = JSON.parse(await read('package.json'))
  const changelog = await read('CHANGELOG.md')
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(match => match[1])
  assert.ok(versions.length >= 2, 'the changelog lists the released versions')
  const newest = versions[0]
  assert.equal(manifest.version, newest, `package.json says ${manifest.version}, the newest changelog entry is ${newest}`)
  assert.equal(BUILD_VERSION, newest, `the host publishes ${BUILD_VERSION}, the newest changelog entry is ${newest}`)
  // A plausible release, not a placeholder.
  assert.match(newest, /^\d+\.\d+\.\d+$/)
  // The changelog is newest-first: a descending list catches a mis-inserted entry.
  const ranks = versions.map(version => version.split('.').map(Number))
  const descending = ranks.every((rank, index) => index === 0 || rank[0] < ranks[index - 1][0]
    || (rank[0] === ranks[index - 1][0] && (rank[1] < ranks[index - 1][1]
      || (rank[1] === ranks[index - 1][1] && rank[2] < ranks[index - 1][2]))))
  assert.ok(descending, `changelog versions are not newest-first: ${versions.join(' > ')}`)
})

test('the host reports the build version it exports, not a literal', async () => {
  const source = await read('src/host/index.js')
  // The published object must USE the constant: a second literal would drift again.
  assert.match(source, /const HOST_BUILD = Object\.freeze\(\{\n\s*version: BUILD_VERSION,/)
  assert.doesNotMatch(source, /const HOST_BUILD = Object\.freeze\(\{\n\s*version: '/)
})
