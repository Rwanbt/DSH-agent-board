/**
 * Connector registry: one validated Task Board source, one minimal GitHub forge
 * (explicitly not validated live), and honest skeletons for the forges and
 * executors this build does not integrate.
 *
 * The registry is the "open door" the specification asks for: adding GitLab,
 * Forgejo, Jira or Linear means registering an adapter that implements the
 * capability contract — not changing the orchestrator.
 *
 * @module dsh-agent-board/connectors/registry
 */

import { createAdapterRegistry, createSkeletonAdapter } from '../contracts/adapters.js'
import { createTaskboardAdapter } from './taskboard.js'
import { createGithubAdapter } from './github.js'
import { createExecutors } from '../executors/index.js'

const SKELETONS = [
  { id: 'gitlab', kind: 'forge', title: 'GitLab', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'forgejo', kind: 'forge', title: 'Forgejo', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'gitea', kind: 'forge', title: 'Gitea', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'bitbucket', kind: 'forge', title: 'Bitbucket', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'jira', kind: 'work-source', title: 'Jira', reason: 'Contract defined; no live credentials, API call or E2E validated in this build.' },
  { id: 'linear', kind: 'work-source', title: 'Linear', reason: 'Contract defined; no live credentials, API call or E2E validated in this build.' },
]

/**
 * Static executor matrix, used when no host context is supplied (unit tests,
 * documentation). It states capabilities only, never live validation.
 */
const STATIC_EXECUTORS = Object.freeze([
  {
    id: 'dsh',
    kind: 'executor',
    title: 'DeepSeek Harness',
    status: 'available',
    validatedLive: false,
    notes: 'Native ctx.agents.create + agent.inject/followup. The host orchestrator is the executor binding; the adapter registry describes what is implemented.',
    capabilities: { create: true, observe: true, cancel: true },
  },
  {
    id: 'claude-code', kind: 'executor', title: 'Claude Code', status: 'unavailable', validatedLive: false,
    notes: 'Adapter contract only; no live supervision or launch validated in this build.', capabilities: { create: false, observe: false, cancel: false },
  },
  {
    id: 'codex', kind: 'executor', title: 'Codex', status: 'unavailable', validatedLive: false,
    notes: 'Adapter contract only; no live supervision or launch validated in this build.', capabilities: { create: false, observe: false, cancel: false },
  },
  {
    id: 'opencode', kind: 'executor', title: 'OpenCode', status: 'unavailable', validatedLive: false,
    notes: 'Adapter contract only; no live supervision or launch validated in this build.', capabilities: { create: false, observe: false, cancel: false },
  },
])

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} [options.githubRepository]
 * @param {object} [options.ctx]  cordis host context, enables the real executor matrix
 */
export function createConnectors({ baseUrl, githubRepository, githubToken, allowGithubWrites, ctx } = {}) {
  const registry = createAdapterRegistry()
  registry.register(createTaskboardAdapter({ baseUrl }))
  registry.register(createGithubAdapter({
    repository: githubRepository,
    ...(typeof githubToken === 'string' ? { token: githubToken } : {}),
    allowWrites: allowGithubWrites === true,
  }))
  for (const skeleton of SKELETONS) {
    registry.register(createSkeletonAdapter({ ...skeleton, validatedLive: false }))
  }

  // The executor matrix is derived from the live ctx when the host provides one:
  // a capability is declared only when the matching service method exists. The
  // static matrix keeps unit tests and docs deterministic.
  const executors = (() => {
    if (ctx === undefined || ctx === null) return [...STATIC_EXECUTORS]
    try {
      return createExecutors({ ctx }).describe().executors
    } catch {
      return [...STATIC_EXECUTORS]
    }
  })()

  return {
    get: id => registry.get(id),
    has: id => registry.has(id),
    list: () => registry.list(),
    describe() {
      return { adapters: registry.describe(), executors, baseUrl }
    },
  }
}
