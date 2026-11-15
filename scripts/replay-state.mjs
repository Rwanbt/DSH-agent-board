#!/usr/bin/env node
/**
 * Replay the operator's REAL board document through the pure contracts.
 *
 * Read-only, offline, no write and no network: it answers the two questions a
 * release cannot answer from a fixture —
 *
 *   1. does the document this install actually wrote still load, and is the
 *      migration that ran on it idempotent?
 *   2. what does the load model compute on THIS machine, right now?
 *
 * Usage: node scripts/replay-state.mjs [path/to/state.json]
 */

import { readFileSync } from 'node:fs'
import { homedir, availableParallelism, freemem } from 'node:os'
import { join } from 'node:path'

import { LOAD_MODEL_VERSION, migratePolicyToLoadModel, normalizePolicy } from '../src/contracts/model.js'
import { effectiveLoadCeiling, hardwareCeilingOf, tokenCeilingOf, tokensPerTurnOf } from '../src/contracts/load-budget.js'

const path = process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agent-board', 'state.json')

let document
try {
  document = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  console.error(`cannot read ${path}: ${String(error?.message ?? error)}`)
  process.exit(2)
}

const policy = normalizePolicy(document.policy ?? {})
const migration = migratePolicyToLoadModel(policy)
const assignments = Array.isArray(document.assignments) ? document.assignments : []
const running = assignments.filter(entry => ['starting', 'running', 'recovering'].includes(entry?.status)).length
const price = tokensPerTurnOf({
  declared: policy.load.tokensPerTurn ?? null,
  tokens: document.loadPrice?.tokens,
  turns: document.loadPrice?.turns,
})
const hardware = hardwareCeilingOf({ parallelism: availableParallelism(), freeBytes: freemem() })
const tokens = tokenCeilingOf({ budget: policy.load.tokenBudget, consumed: document.loadWave?.spentTokens, tokensPerTurn: price.perTurn })
const load = effectiveLoadCeiling({ hardware, tokens, running })

console.log(JSON.stringify({
  document: {
    path,
    keys: Object.keys(document).length,
    schemaVersion: document.schemaVersion ?? null,
    assignments: assignments.length,
    running,
    loadModelVersion: document.loadModelVersion ?? null,
  },
  migration: {
    expectedVersion: LOAD_MODEL_VERSION,
    wouldChangeAnything: migration.migrated,
    from: migration.from,
    ...(migration.migrated ? { note: 'the next host start lifts these two ceilings' } : {}),
  },
  policy: {
    supervision: policy.supervision,
    load: policy.load,
  },
  price: { ...price, effective: price.perTurn ?? 'documented fallback' },
  machine: { parallelism: availableParallelism(), freeBytes: freemem() },
  load: {
    ceiling: load.ceiling,
    binding: load.binding,
    blocked: load.blocked,
    reasons: load.reasons,
  },
}, null, 2))
