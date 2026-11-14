import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { executeNativeMerge, nativeMergeReady, prepareNativeMerge } from '../src/host/native-forge.js'

const repository = { forge: 'github', host: 'github.com', owner: 'owner', name: 'project' }
const headSha = 'a'.repeat(40)
const baseSha = 'b'.repeat(40)
function readySnapshot(ref = { repository, number: 42 }) {
  return { ref, state: 'open', draft: false, mergeReady: true, mergeability: 'mergeable',
    headSha, baseSha, baseBranch: 'main', mergeMethods: ['squash', 'merge', 'rebase'],
    checksRollup: 'success', checksTruncated: false, threadsTruncated: false,
    reviewersTruncated: false, unresolvedThreads: 0, reviewDecision: 'approved' }
}

async function withForge(run) {
  const path = await mkdtemp(join(tmpdir(), 'dab-native-merge-'))
  execFileSync('git', ['init', path], { stdio: 'ignore' })
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', 'https://github.com/owner/project.git'], { stdio: 'ignore' })
  const state = { snapshot: readySnapshot(), calls: [], checks: 0, revoked: false }
  const forge = {
    repositoryFromRemote: remote => remote === 'https://github.com/owner/project.git' ? repository : { ...repository, owner: 'other' },
    fetchChecks: async (_ref, signal) => { assert.ok(signal instanceof AbortSignal); state.checks++; return structuredClone(state.snapshot) },
    merge: async (ref, request, signal) => { assert.ok(signal instanceof AbortSignal); state.calls.push({ ref, request }); return state.failure },
  }
  const ctx = { get: name => name === 'forge' ? forge : undefined }
  const input = { workspace: { path }, payload: { number: 42, method: 'squash' }, beforeExecute() {
    if (state.revoked) throw Object.assign(new Error('mandate_changed'), { code: 'mandate_changed' })
  } }
  try { await run({ ctx, forge, state, input }) }
  finally { await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('native merge captures the real target, then executes exactly that head/method through DSH', async () => {
  await withForge(async ({ ctx, state, input }) => {
    assert.equal(nativeMergeReady(ctx), true)
    const prepared = await prepareNativeMerge(ctx, input)
    assert.equal(prepared.ok, true)
    assert.deepEqual(prepared.payload, { number: 42, method: 'squash', repository: 'github:github.com/owner/project', headSha, base: 'main', baseSha })
    assert.equal(state.calls.length, 0, 'preparation cannot merge')
    const result = await executeNativeMerge(ctx, { ...input, payload: prepared.payload })
    assert.equal(result.ok, true)
    assert.equal(result.value.merged, true)
    assert.deepEqual(state.calls, [{ ref: { repository, number: 42 }, request: { method: 'squash', headSha } }])
  })
})

test('changed head, base or repository invalidate the captured merge operation', async () => {
  await withForge(async ({ ctx, state, input }) => {
    const prepared = await prepareNativeMerge(ctx, input)
    for (const change of [{ headSha: 'c'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { baseBranch: 'release' }]) {
      state.snapshot = { ...readySnapshot(), ...change }
      const result = await executeNativeMerge(ctx, { ...input, payload: prepared.payload })
      assert.equal(result.reason, 'forge_stale_change_request')
    }
    state.snapshot = readySnapshot()
    const wrongRepo = await executeNativeMerge(ctx, { ...input, payload: { ...prepared.payload, repository: 'github:github.com/other/project' } })
    assert.equal(wrongRepo.reason, 'forge_project_mismatch')
    assert.equal(state.calls.length, 0)
  })
})

test('a draft, failing checks, incomplete reviews or unresolved threads never become merge consent', async () => {
  await withForge(async ({ ctx, state, input }) => {
    for (const change of [{ draft: true }, { mergeReady: false }, { checksRollup: 'failure' }, { checksTruncated: true },
      { reviewersTruncated: true }, { threadsTruncated: true }, { unresolvedThreads: 1 }, { reviewDecision: 'changes-requested' }, { state: 'merged' }]) {
      state.snapshot = { ...readySnapshot(), ...change }
      assert.equal((await prepareNativeMerge(ctx, input)).reason, 'forge_merge_not_ready', JSON.stringify(change))
    }
    state.snapshot = { ...readySnapshot(), baseSha: undefined }
    assert.equal((await prepareNativeMerge(ctx, input)).reason, 'forge_snapshot_incomplete')
    state.snapshot = { ...readySnapshot(), mergeMethods: ['merge'] }
    assert.equal((await prepareNativeMerge(ctx, input)).reason, 'forge_merge_method_unavailable')
    assert.equal(state.calls.length, 0)
  })
})

test('revocation after the forge read prevents merge; unknown write outcomes remain explicit', async () => {
  await withForge(async ({ ctx, forge, state, input }) => {
    const prepared = await prepareNativeMerge(ctx, input)
    const original = forge.fetchChecks
    forge.fetchChecks = async (...args) => { const value = await original(...args); state.revoked = true; return value }
    assert.equal((await executeNativeMerge(ctx, { ...input, payload: prepared.payload })).reason, 'mandate_changed')
    assert.equal(state.calls.length, 0)
    state.revoked = false
    forge.fetchChecks = original
    state.failure = { code: 'unknown', message: 'secret-do-not-relay' }
    const result = await executeNativeMerge(ctx, { ...input, payload: prepared.payload })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'forge_merge_unknown')
    assert.doesNotMatch(JSON.stringify(result), /secret-do-not-relay/)
  })
})

test('missing native forge or unbound payload is refused, never emulated', async () => {
  assert.equal(nativeMergeReady({ get: () => undefined }), false)
  assert.equal((await prepareNativeMerge({ get: () => undefined }, {})).reason, 'native_forge_unavailable')
  assert.equal((await executeNativeMerge({}, { payload: { number: 42 } })).reason, 'payload_invalid')
})
