import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGENT_ROLES,
  AGENT_ROLE_IDS,
  AGENT_FAMILIES,
  AGENT_ROLE_ALIASES,
  AGENT_TONES,
  AGENT_STATUS_TONE,
  AGENT_TASK_STATE_TONE,
  TASK_STATE_TONES,
  normalizeAgentRoleKey,
  dabResolveAgentRole,
  dabResolveRoleForNode,
  inferAgentRoleFromText,
  AGENT_ROLE_INFERENCE_DEFAULT,
  dabAvatarVariantForSize,
  dabAgentAvatarModel,
} from '../src/contracts/agent-roles.js'
import { STATUS } from '../src/contracts/model.js'
import { AGENT_BOT_ASSETS } from '../src/client/ui/agent-bots-assets.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rolesJson = JSON.parse(await readFile(join(ROOT, 'src', 'assets', 'agent-bots', 'roles.json'), 'utf8'))
const HEX = /^#[0-9A-Fa-f]{6}$/

const EXISTING_STATUSES = [
  'running', 'waiting_user', 'recovering', 'interrupted', 'provider_unavailable',
  'finished_unread', 'finished_read', 'failed', 'idle', 'unknown', 'unavailable',
]

const EXACT_STATUS_TONE = {
  running: 'active',
  waiting_user: 'waiting',
  recovering: 'planning',
  interrupted: 'interrupted',
  provider_unavailable: 'blocked',
  failed: 'blocked',
  finished_unread: 'unread',
  finished_read: 'done',
  idle: 'idle',
  unknown: 'gone',
  unavailable: 'gone',
}

test('AGENT_ROLES is exactly the kit roles.json (no palette drift)', () => {
  assert.equal(AGENT_ROLE_IDS.length, 15)
  assert.deepEqual([...AGENT_ROLE_IDS].sort(), rolesJson.roles.map(role => role.id).sort())
  assert.deepEqual(Object.keys(AGENT_ROLES), AGENT_ROLE_IDS)
  for (const kitRole of rolesJson.roles) {
    const role = AGENT_ROLES[kitRole.id]
    assert.ok(role, `${kitRole.id} is registered`)
    assert.equal(role.id, kitRole.id)
    assert.equal(role.label, kitRole.label)
    assert.equal(role.family, kitRole.category, `${kitRole.id}: family === kit category`)
    assert.equal(role.shape, kitRole.shape)
    assert.equal(role.color, kitRole.color, `${kitRole.id}: role colour drift`)
    assert.deepEqual(role.gradient, kitRole.gradient, `${kitRole.id}: gradient drift`)
    assert.equal(role.description, kitRole.description)
    assert.equal(role.scope, kitRole.id === 'super_orchestrator' ? 'workspace' : 'project')
    assert.match(role.color, HEX)
    assert.equal(role.gradient.length, 3)
    assert.ok(role.gradient.every(color => HEX.test(color)), `${kitRole.id}: gradient hex`)
  }
  assert.deepEqual(AGENT_FAMILIES, rolesJson.families)
})

test('the six kit tones keep the kit hex values and the four extensions are documented', () => {
  const kitTones = { active: '#1DC766', planning: '#258FF5', waiting: '#F3BE13', reviewing: '#F48C1A', blocked: '#F04453', idle: '#7E8B9C' }
  for (const [tone, color] of Object.entries(kitTones)) {
    assert.equal(AGENT_TONES[tone].color, color, `${tone}: kit colour unchanged`)
  }
  for (const extension of ['unread', 'done', 'gone', 'interrupted']) {
    assert.ok(AGENT_TONES[extension], `${extension} tone exists`)
    assert.match(AGENT_TONES[extension].color, HEX)
  }
  assert.deepEqual(Object.keys(AGENT_TONES).sort(), [...Object.keys(kitTones), 'unread', 'done', 'gone', 'interrupted'].sort())
  for (const [tone, entry] of Object.entries(AGENT_TONES)) {
    assert.ok(typeof entry.labelKey === 'string' && entry.labelKey.length > 0, `${tone}: labelKey`)
    assert.match(entry.color, HEX)
  }
})

test('AGENT_STATUS_TONE covers exactly the 11 existing plugin statuses', () => {
  assert.deepEqual(Object.values(STATUS).sort(), EXISTING_STATUSES.sort())
  assert.deepEqual(Object.keys(AGENT_STATUS_TONE).sort(), [...EXISTING_STATUSES].sort())
  assert.deepEqual({ ...AGENT_STATUS_TONE }, EXACT_STATUS_TONE)
  for (const tone of Object.values(AGENT_STATUS_TONE)) assert.ok(AGENT_TONES[tone], `mapped tone ${tone} exists`)
  assert.equal(STATUS.REVIEWING, undefined, 'reviewing is a task tone, not an agent status')
})

test('Task Board states are a separate vocabulary', () => {
  assert.deepEqual({ ...AGENT_TASK_STATE_TONE }, {
    todo: 'idle',
    in_progress: 'active',
    in_review: 'reviewing',
    blocked: 'blocked',
    done: 'done',
  })
  assert.deepEqual([...TASK_STATE_TONES].sort(), ['blocked', 'done', 'in_progress', 'in_review', 'todo'])
  for (const state of Object.keys(AGENT_TASK_STATE_TONE)) {
    assert.equal(AGENT_STATUS_TONE[state], undefined, `${state} is not an agent status`)
  }
  assert.equal(AGENT_STATUS_TONE.in_review, undefined)
})

test('exact role ids resolve as explicit, in every case form', () => {
  for (const id of AGENT_ROLE_IDS) {
    const resolved = dabResolveAgentRole(id)
    assert.equal(resolved.roleId, id)
    assert.equal(resolved.source, 'explicit')
    assert.equal(resolved.raw, id)
    assert.equal(resolved.role, AGENT_ROLES[id])
    const upper = dabResolveAgentRole(id.toUpperCase())
    assert.equal(upper.roleId, id, `${id.toUpperCase()} is the same declared id`)
    assert.equal(upper.source, 'explicit')
    const spaced = dabResolveAgentRole(`  ${id}  `)
    assert.equal(spaced.roleId, id)
    assert.equal(spaced.source, 'explicit')
  }
})

test('kebab and display forms resolve through the declared alias table', () => {
  for (const id of AGENT_ROLE_IDS) {
    const kebab = id.replace(/_/g, '-')
    const resolved = dabResolveAgentRole(kebab)
    assert.equal(resolved.roleId, id, `${kebab} -> ${id}`)
    assert.equal(resolved.raw, kebab)
    // A kebab form that is literally the role id (`orchestrator`) is explicit;
    // the underscore ids only match through the alias table.
    assert.equal(resolved.source, kebab === id ? 'explicit' : 'alias', `${kebab}: resolution source`)
  }
  assert.equal(dabResolveAgentRole('Knowledge Manager').roleId, 'knowledge_manager')
  assert.equal(dabResolveAgentRole('Knowledge Manager').source, 'alias')
  assert.equal(dabResolveAgentRole('Super Orchestrator').roleId, 'super_orchestrator')
  assert.equal(dabResolveAgentRole('Super  Orchestrator').roleId, 'super_orchestrator')
})

test('every documented alias resolves to its declared role, raw preserved', () => {
  for (const [alias, roleId] of Object.entries(AGENT_ROLE_ALIASES)) {
    assert.ok(AGENT_ROLES[roleId], `${alias} -> unknown role ${roleId}`)
    assert.equal(normalizeAgentRoleKey(alias), alias, `${alias} is stored normalized`)
    const resolved = dabResolveAgentRole(alias)
    assert.equal(resolved.roleId, roleId, `${alias} -> ${roleId}`)
    assert.equal(resolved.raw, alias)
    assert.equal(resolved.source, AGENT_ROLE_IDS.includes(alias) ? 'explicit' : 'alias')
  }
  // Minimum documented synonyms from the contract.
  const expected = {
    lead: 'orchestrator', coordinator: 'orchestrator', qa: 'verifier', tester: 'verifier',
    dev: 'worker', developer: 'worker', scout: 'researcher', explorer: 'researcher',
    security: 'guardian', perf: 'optimizer', review: 'reviewer', monitor: 'observer',
    planning: 'planner', integration: 'integrator', audit: 'auditor',
    knowledge: 'knowledge_manager', memory: 'knowledge_manager', architecture: 'architect', arch: 'architect',
  }
  for (const [alias, roleId] of Object.entries(expected)) assert.equal(AGENT_ROLE_ALIASES[alias], roleId)
})

test('alias lookup is case- and accent-insensitive', () => {
  assert.equal(dabResolveAgentRole('KNOWLEDGE-MANAGER').roleId, 'knowledge_manager')
  assert.equal(dabResolveAgentRole('Knowledge  ManaGer').roleId, 'knowledge_manager')
  assert.equal(dabResolveAgentRole('VÉRIFICATEUR').roleId, 'verifier')
  assert.equal(dabResolveAgentRole('Vérificateur').roleId, 'verifier')
  assert.equal(dabResolveAgentRole('PLANIFICATEUR').roleId, 'planner')
  assert.equal(normalizeAgentRoleKey('VÉRIFICATEUR'), 'verificateur')
})

test('unknown roles stay generic: no guessed colour, mascot or role', () => {
  for (const value of ['nope', 'worker!', 'gpt-4.1', '', '   ', null, undefined, 42, {}, []]) {
    const resolved = dabResolveAgentRole(value)
    assert.equal(resolved.roleId, null, `${String(value)} is not a role`)
    assert.equal(resolved.source, 'generic')
    assert.equal(resolved.role, null)
  }
  const resolved = dabResolveAgentRole('Mystery Role')
  assert.equal(resolved.raw, 'Mystery Role', 'the original string is preserved')
  const model = dabAgentAvatarModel({ role: 'Mystery Role', name: 'Agent X', sources: AGENT_BOT_ASSETS })
  assert.equal(model.roleId, null)
  assert.equal(model.src, null)
  assert.equal(model.color, null)
  assert.equal(model.roleLabel, null)
  assert.equal(model.rawRole, 'Mystery Role')
  assert.equal(model.resolution, 'generic')
})

test('a model string is never used to infer a role', () => {
  for (const modelString of ['gpt-4.1', 'claude-sonnet-4-5', 'deepseek-v4', 'o3-mini', 'llama-3.3-70b']) {
    assert.equal(dabResolveAgentRole(modelString).roleId, null)
  }
  assert.equal(dabResolveAgentRole({ model: 'worker' }).roleId, null)
  assert.equal(dabResolveAgentRole({ provider: 'reviewer' }).roleId, null)
  const a = dabAgentAvatarModel({ role: 'worker', name: 'A', model: 'reviewer', sources: AGENT_BOT_ASSETS })
  const b = dabAgentAvatarModel({ role: 'reviewer', name: 'B', model: 'reviewer', sources: AGENT_BOT_ASSETS })
  assert.equal(a.roleId, 'worker')
  assert.equal(b.roleId, 'reviewer')
  assert.notEqual(a.src, b.src, 'same model, different declared roles -> different mascots')
})

test('role colour is identity and stays independent of status and task state', () => {
  for (const id of AGENT_ROLE_IDS) {
    const model = dabAgentAvatarModel({ role: id, status: 'failed', taskState: 'blocked', sources: AGENT_BOT_ASSETS })
    assert.equal(model.color, AGENT_ROLES[id].color, `${id}: mascot colour never becomes a status colour`)
    assert.equal(model.tone, 'blocked')
    assert.notEqual(model.color, model.toneColor, `${id}: status dot colour is separate`)
  }
  const worker = dabAgentAvatarModel({ role: 'worker', status: 'failed', sources: AGENT_BOT_ASSETS })
  assert.equal(worker.color, '#36CB5E', 'a failed/blocked Worker stays green')
  assert.equal(worker.toneColor, '#F04453')
  const unknownStatus = dabAgentAvatarModel({ role: 'worker', status: 'not_a_status', sources: AGENT_BOT_ASSETS })
  assert.equal(unknownStatus.tone, 'idle')
  assert.equal(unknownStatus.color, '#36CB5E')
})

test('an in-review TASK maps to reviewing; a Reviewer AGENT does not', () => {
  const task = dabAgentAvatarModel({ role: 'worker', status: 'running', taskState: 'in_review', sources: AGENT_BOT_ASSETS })
  assert.equal(task.taskTone, 'reviewing')
  assert.equal(task.taskToneColor, AGENT_TONES.reviewing.color)
  assert.equal(task.taskToneLabelKey, AGENT_TONES.reviewing.labelKey)
  assert.equal(task.tone, 'active', 'the agent status tone is unaffected by its task')
  const reviewer = dabAgentAvatarModel({ role: 'reviewer', status: 'running', sources: AGENT_BOT_ASSETS })
  assert.equal(reviewer.roleId, 'reviewer')
  assert.equal(reviewer.tone, 'active')
  assert.equal(reviewer.taskTone, null)
  const idleReviewer = dabAgentAvatarModel({ role: 'reviewer', sources: AGENT_BOT_ASSETS })
  assert.notEqual(idleReviewer.tone, 'reviewing', 'the Reviewer role never becomes "reviewing" by itself')
  const unknownTask = dabAgentAvatarModel({ role: 'worker', taskState: 'backlog', sources: AGENT_BOT_ASSETS })
  assert.equal(unknownTask.taskTone, null)
  assert.equal(unknownTask.taskToneLabelKey, null)
})

test('variant selection switches at 48px', () => {
  assert.equal(dabAvatarVariantForSize(47), 'compact')
  assert.equal(dabAvatarVariantForSize(48), 'full')
  assert.equal(dabAvatarVariantForSize(40), 'compact')
  assert.equal(dabAvatarVariantForSize(0), 'compact')
  assert.equal(dabAvatarVariantForSize(256), 'full')
  assert.equal(dabAvatarVariantForSize(NaN), 'full')
  assert.equal(dabAvatarVariantForSize('48'), 'full')
  assert.equal(dabAgentAvatarModel({ role: 'worker', size: 47, sources: AGENT_BOT_ASSETS }).variant, 'compact')
  assert.equal(dabAgentAvatarModel({ role: 'worker', size: 48, sources: AGENT_BOT_ASSETS }).variant, 'full')
  assert.equal(dabAgentAvatarModel({ role: 'worker', size: 64, variant: 'compact', sources: AGENT_BOT_ASSETS }).variant, 'compact')
})

test('size is clamped and the default is 40', () => {
  assert.equal(dabAgentAvatarModel({}).size, 40)
  assert.equal(dabAgentAvatarModel({ size: 0 }).size, 8)
  assert.equal(dabAgentAvatarModel({ size: -12 }).size, 8)
  assert.equal(dabAgentAvatarModel({ size: 1000 }).size, 256)
  assert.equal(dabAgentAvatarModel({ size: 12.9 }).size, 12)
  assert.equal(dabAgentAvatarModel({ size: '47' }).size, 47)
  assert.equal(dabAgentAvatarModel({ size: 'not-a-size' }).size, 40)
  const model = dabAgentAvatarModel({ role: 'worker', size: 64, sources: AGENT_BOT_ASSETS })
  assert.equal(model.size, 64)
  assert.equal(model.src, AGENT_BOT_ASSETS.worker.full, '64px uses the full mascot')
})

test('the generic avatar model has no src even when sources are present', () => {
  const generic = dabAgentAvatarModel({ role: null, name: 'X', status: 'running', sources: AGENT_BOT_ASSETS })
  assert.equal(generic.src, null)
  assert.equal(generic.roleId, null)
  assert.equal(generic.color, null)
})

test('the super orchestrator crown and bolt resolve their own source keys', () => {
  const crown = dabAgentAvatarModel({ role: 'super_orchestrator', size: 64, sources: AGENT_BOT_ASSETS })
  assert.equal(crown.emblem, 'crown')
  assert.equal(crown.src, AGENT_BOT_ASSETS.super_orchestrator.full)
  const bolt = dabAgentAvatarModel({ role: 'super_orchestrator', emblem: 'bolt', size: 64, sources: AGENT_BOT_ASSETS })
  assert.equal(bolt.emblem, 'bolt')
  assert.equal(bolt.src, AGENT_BOT_ASSETS.super_orchestrator_bolt.full)
  const compactBolt = dabAgentAvatarModel({ role: 'super_orchestrator', emblem: 'bolt', size: 32, sources: AGENT_BOT_ASSETS })
  assert.equal(compactBolt.src, AGENT_BOT_ASSETS.super_orchestrator_bolt.compact)
  const other = dabAgentAvatarModel({ role: 'orchestrator', emblem: 'bolt', size: 64, sources: AGENT_BOT_ASSETS })
  assert.equal(other.emblem, null)
  assert.equal(other.src, AGENT_BOT_ASSETS.orchestrator.full)
})

test('the avatar model exposes the documented fields and altParts', () => {
  const model = dabAgentAvatarModel({ role: 'worker', name: 'Ada', status: 'running', taskState: 'in_review', size: 64, sources: AGENT_BOT_ASSETS })
  for (const key of ['roleId', 'roleLabel', 'family', 'shape', 'color', 'gradient', 'resolution', 'rawRole', 'variant', 'size', 'src', 'emblem', 'status', 'tone', 'toneColor', 'toneLabelKey', 'taskState', 'taskTone', 'taskToneLabelKey', 'altParts']) {
    assert.ok(Object.prototype.hasOwnProperty.call(model, key), `model.${key}`)
  }
  assert.deepEqual(model.altParts, [
    { text: 'Ada' },
    { text: 'Worker' },
    { labelKey: 'statusRunning' },
    { labelKey: 'taskInReview' },
  ])
  assert.equal(model.family, 'execution')
  assert.equal(model.shape, 'cloud')
  assert.equal(model.toneLabelKey, 'statusRunning')
  assert.equal(model.taskToneLabelKey, 'taskInReview')
  assert.equal(model.variant, 'full')
  assert.equal(model.src, AGENT_BOT_ASSETS.worker.full)
  const noName = dabAgentAvatarModel({ role: 'worker', status: 'finished_read', sources: AGENT_BOT_ASSETS })
  assert.deepEqual(noName.altParts, [{ text: 'Worker' }, { labelKey: 'statusRead' }])
  const generic = dabAgentAvatarModel({ role: 'nope', name: 'Ghost', status: 'failed', sources: AGENT_BOT_ASSETS })
  assert.deepEqual(generic.altParts, [{ text: 'Ghost' }, { labelKey: 'statusFailed' }])
  assert.equal(generic.resolution, 'generic')
  assert.equal(generic.rawRole, 'nope')
})

test('undeclared roles are deduced from declared text (accent/case-safe, word-bounded)', () => {
  assert.equal(inferAgentRoleFromText({ title: 'Code review of the parser' }).roleId, 'reviewer')
  assert.equal(inferAgentRoleFromText({ title: 'Polish the UI' }).roleId, 'architect')
  assert.equal(inferAgentRoleFromText({ title: 'Audit de conformité' }).roleId, 'auditor')
  assert.equal(inferAgentRoleFromText({ goal: 'Validate the release' }).roleId, 'verifier')
  assert.equal(inferAgentRoleFromText({ title: 'Sécurité des permissions' }).roleId, 'guardian')
  assert.equal(inferAgentRoleFromText({ title: 'Optimise the render loop' }).roleId, 'optimizer')
  assert.equal(inferAgentRoleFromText({ title: 'Document the architecture' }).roleId, 'knowledge_manager')
  assert.equal(inferAgentRoleFromText({ title: 'Merge the feature branch' }).roleId, 'integrator')
  assert.equal(inferAgentRoleFromText({ title: 'Research OpenTelemetry exporters' }).roleId, 'researcher')
  assert.equal(inferAgentRoleFromText({ title: 'Plan the next sprint' }).roleId, 'planner')
  assert.equal(inferAgentRoleFromText({ title: 'Dispatch the work' }).roleId, 'dispatcher')
  assert.equal(inferAgentRoleFromText({ title: 'Monitor the queue' }).roleId, 'observer')
  assert.equal(inferAgentRoleFromText({ title: 'Lead the project' }).roleId, 'orchestrator')
  // Word boundaries: "Plain"/"preview" must not be read as plan/review.
  assert.equal(inferAgentRoleFromText({ title: 'Plain idle' }).roleId, AGENT_ROLE_INFERENCE_DEFAULT)
  assert.equal(inferAgentRoleFromText({ title: 'Preview the diff' }).roleId, AGENT_ROLE_INFERENCE_DEFAULT)
  // No keyword -> productive default, still INFERRED (not declared).
  const fallback = inferAgentRoleFromText({ title: 'Stopped launch' })
  assert.equal(fallback.roleId, AGENT_ROLE_INFERENCE_DEFAULT)
  assert.equal(fallback.defaulted, true)
  // No usable text at all -> generic identity preserved.
  assert.equal(inferAgentRoleFromText({}), null)
  assert.equal(inferAgentRoleFromText({ title: '   ' }), null)
})

test('a declared role always wins over inference; the model is never an input', () => {
  const declared = dabResolveRoleForNode({ role: 'dev', title: 'Code review' })
  assert.equal(declared.roleId, 'worker')
  assert.equal(declared.source, 'alias')
  assert.equal(declared.inference, null)
  const inferred = dabResolveRoleForNode({ title: 'Code review of the parser' })
  assert.equal(inferred.roleId, 'reviewer')
  assert.equal(inferred.source, 'inferred')
  assert.equal(inferred.inference.rule, 'reviewer')
  assert.equal(inferred.inference.token, 'code review')
  const modelNever = dabResolveRoleForNode({ model: 'reviewer', provider: 'worker', title: 'Build the card' })
  assert.equal(modelNever.roleId, 'worker')
  assert.equal(modelNever.source, 'inferred')
})

test('the avatar model exposes the inferred mascot and announces the deduction', () => {
  const model = dabAgentAvatarModel({ title: 'Polish the UI', size: 64, sources: AGENT_BOT_ASSETS })
  assert.equal(model.roleId, 'architect')
  assert.equal(model.resolution, 'inferred')
  assert.equal(model.src, AGENT_BOT_ASSETS.architect.full)
  assert.ok(model.altParts.some(part => part.labelKey === 'roleInferred'))
  // A pre-resolved inferred role stays inferred: provenance is never upgraded.
  const preset = dabAgentAvatarModel({
    resolvedRole: { roleId: 'architect', source: 'inferred', inference: { defaulted: false, token: 'ui' } },
    size: 64,
    sources: AGENT_BOT_ASSETS,
  })
  assert.equal(preset.resolution, 'inferred')
  assert.equal(preset.src, AGENT_BOT_ASSETS.architect.full)
  // No declared role and no text at all stays generic (grey identity, no mascot).
  const generic = dabAgentAvatarModel({ role: 'Mystery', sources: AGENT_BOT_ASSETS })
  assert.equal(generic.roleId, null)
  assert.equal(generic.src, null)
})
