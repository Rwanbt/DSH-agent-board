/** Native forge merge owner. No alternate token store or GitHub admin bypass.
 * Before consent, capture the real repository/head/base/method; at execution,
 * re-read and compare every bound target before invoking DSH's merge service.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i

export function nativeMergeReady(ctx) {
  const forge = ctx?.get?.('forge')
  return ['repositoryFromRemote', 'fetchChecks', 'merge'].every(key => typeof forge?.[key] === 'function')
}

async function mergeTarget(ctx, { workspace, payload, beforeExecute }) {
  if (!nativeMergeReady(ctx)) return { ok: false, reason: 'native_forge_unavailable' }
  if (!workspace?.path || !Number.isInteger(payload?.number) || payload.number < 1) return { ok: false, reason: 'payload_invalid' }
  beforeExecute()
  let remote
  try {
    const result = await execFileAsync('git', ['-C', workspace.path, 'remote', 'get-url', 'origin'], { timeout: 3000, maxBuffer: 8192, windowsHide: true })
    remote = result.stdout.trim()
  } catch { return { ok: false, reason: 'forge_project_unverifiable' } }
  beforeExecute()
  const forge = ctx.get('forge')
  const repository = forge.repositoryFromRemote(remote)
  if (!repository) return { ok: false, reason: 'forge_repository_unsupported' }
  if (!['forge', 'host', 'owner', 'name'].every(key =>
    typeof repository[key] === 'string' && repository[key].length > 0 && repository[key].length <= 120
    && /^[A-Za-z0-9._:/-]+$/.test(repository[key]))) return { ok: false, reason: 'forge_project_unverifiable' }
  const repositoryKey = `${repository.forge}:${repository.host}/${repository.owner}/${repository.name}`
  if (payload.repository !== undefined && payload.repository !== repositoryKey) return { ok: false, reason: 'forge_project_mismatch' }
  const ref = { repository, number: payload.number }
  const snapshot = await forge.fetchChecks(ref, AbortSignal.timeout(10_000))
  beforeExecute()
  if (snapshot?.code) return { ok: false, reason: snapshot.code === 'unauthenticated' ? 'forge_unauthenticated'
    : snapshot.code === 'stale' ? 'forge_stale_change_request' : 'native_forge_unavailable' }
  if (!snapshot || !SHA.test(snapshot.headSha ?? '') || !SHA.test(snapshot.baseSha ?? '')
    || typeof snapshot.baseBranch !== 'string' || snapshot.baseBranch === '') return { ok: false, reason: 'forge_snapshot_incomplete' }
  // A response for a different PR/repository can never authorize this target.
  if (snapshot.ref?.number !== ref.number || ['forge', 'host', 'owner', 'name'].some(key =>
    snapshot.ref?.repository?.[key] !== repository[key])) return { ok: false, reason: 'forge_project_mismatch' }
  if (snapshot.state !== 'open' || snapshot.draft !== false || snapshot.mergeReady !== true
    || snapshot.mergeability !== 'mergeable' || !['none', 'success'].includes(snapshot.checksRollup)
    || snapshot.checksTruncated !== false || snapshot.threadsTruncated !== false
    || snapshot.reviewersTruncated !== false || snapshot.unresolvedThreads !== 0
    || snapshot.reviewDecision === 'changes-requested') return { ok: false, reason: 'forge_merge_not_ready' }
  const method = payload.method ?? 'squash'
  if (!snapshot.mergeMethods?.includes(method)) return { ok: false, reason: 'forge_merge_method_unavailable' }
  const bound = { number: ref.number, method, repository: repositoryKey,
    headSha: snapshot.headSha.toLowerCase(), base: snapshot.baseBranch, baseSha: snapshot.baseSha.toLowerCase() }
  for (const key of ['headSha', 'base', 'baseSha']) {
    if (payload[key] !== undefined && payload[key] !== bound[key]) return { ok: false, reason: 'forge_stale_change_request' }
  }
  return { ok: true, forge, ref, payload: bound }
}

export async function prepareNativeMerge(ctx, input) {
  try {
    const target = await mergeTarget(ctx, input)
    return target.ok ? { ok: true, payload: target.payload } : target
  } catch (error) { return { ok: false, reason: error?.code ?? 'native_forge_error' } }
}

export async function executeNativeMerge(ctx, input) {
  if (!input.payload?.repository || !input.payload?.headSha || !input.payload?.base || !input.payload?.baseSha) {
    return { ok: false, reason: 'payload_invalid' }
  }
  try {
    const target = await mergeTarget(ctx, input)
    if (!target.ok) return target
    input.beforeExecute()
    const failure = await target.forge.merge(target.ref, {
      method: target.payload.method, headSha: target.payload.headSha,
    }, AbortSignal.timeout(10_000))
    return failure === undefined
      ? { ok: true, value: { merged: true, ...target.payload } }
      : { ok: false, reason: `forge_merge_${['unauthenticated', 'stale', 'failed', 'unknown'].includes(failure?.code) ? failure.code : 'failed'}` }
  } catch (error) { return { ok: false, reason: error?.code ?? 'native_forge_error' } }
}
