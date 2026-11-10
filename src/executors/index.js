/**
 * Executor registry: the real DSH executor plus honest skeletons for the
 * engines this build does not integrate.
 *
 * This module is deliberately separate from `src/connectors/registry.js`: the
 * connector registry keeps the board's work-source/forge matrix, while the
 * executor matrix is owned here so an engine can be promoted (or demoted) by
 * changing one adapter, not the orchestrator.
 *
 * @module dsh-agent-board/executors
 */

import { createAdapterRegistry } from '../contracts/adapters.js'
import { createDshExecutor } from './dsh.js'
import { createExecutorSkeletons } from './skeletons.js'

export { createDshExecutor } from './dsh.js'
export { EXECUTOR_SKELETONS, createExecutorSkeletons } from './skeletons.js'

/**
 * Register the DSH executor and every executor skeleton.
 *
 * @param {object} options
 * @param {object} options.ctx cordis host context for the DSH executor.
 * @returns {object} a registry facade (`get`, `has`, `list`, `describe`).
 */
export function createExecutors({ ctx } = {}) {
  const registry = createAdapterRegistry()
  registry.register(createDshExecutor(ctx))
  for (const skeleton of createExecutorSkeletons()) registry.register(skeleton)
  return {
    get: id => registry.get(id),
    has: id => registry.has(id),
    list: () => registry.list(),
    describe: () => ({ executors: registry.describe() }),
  }
}
