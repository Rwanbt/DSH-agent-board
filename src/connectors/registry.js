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

const SKELETONS = [
  { id: 'gitlab', kind: 'forge', title: 'GitLab', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'forgejo', kind: 'forge', title: 'Forgejo', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'gitea', kind: 'forge', title: 'Gitea', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'bitbucket', kind: 'forge', title: 'Bitbucket', reason: 'Contract defined; no live API call or E2E validated in this build.' },
  { id: 'jira', kind: 'work-source', title: 'Jira', reason: 'Contract defined; no live credentials, API call or E2E validated in this build.' },
  { id: 'linear', kind: 'work-source', title: 'Linear', reason: 'Contract defined; no live credentials, API call or E2E validated in this build.' },
]

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} [options.githubRepository]
 */
export function createConnectors({ baseUrl, githubRepository }) {
  const registry = createAdapterRegistry()
  registry.register(createTaskboardAdapter({ baseUrl }))
  registry.register(createGithubAdapter({ repository: githubRepository }))
  for (const skeleton of SKELETONS) {
    registry.register(createSkeletonAdapter({ ...skeleton, validatedLive: false }))
  }

  const executors = [
    {
      id: 'dsh',
      kind: 'executor',
      title: 'DeepSeek Harness',
      status: 'available',
      validatedLive: true,
      notes: 'Native ctx.agents.create + agent.inject/followup. The host orchestrator is the executor binding.',
      capabilities: { create: true, observe: true, cancel: true },
    },
    {
      id: 'claude-code',
      kind: 'executor',
      title: 'Claude Code',
      status: 'unavailable',
      validatedLive: false,
      notes: 'Adapter contract only; not wired in this build.',
      capabilities: { create: false, observe: false, cancel: false },
    },
    {
      id: 'codex',
      kind: 'executor',
      title: 'Codex',
      status: 'unavailable',
      validatedLive: false,
      notes: 'Adapter contract only; not wired in this build.',
      capabilities: { create: false, observe: false, cancel: false },
    },
    {
      id: 'opencode',
      kind: 'executor',
      title: 'OpenCode',
      status: 'unavailable',
      validatedLive: false,
      notes: 'Adapter contract only; not wired in this build.',
      capabilities: { create: false, observe: false, cancel: false },
    },
  ]

  return {
    get: id => registry.get(id),
    has: id => registry.has(id),
    list: () => registry.list(),
    describe() {
      return { adapters: registry.describe(), executors, baseUrl }
    },
  }
}
