# GOAL 6 — Contrat d'implémentation (Super Agent, mandat, adaptateurs, UI)

Statut : **contrat de travail** (source de vérité pour les modules et le payload).
Version du schéma d'état : **2**. Toute évolution doit garder la lecture d'un
`schemaVersion: 1` et être couverte par un test de migration.

Ce document est normatif pour ce chantier. Les noms de champs sont exacts : hôte,
client, tests et documentation codent contre eux.

---

## 0. Règles non négociables

1. **Task Board reste le propriétaire canonique** des tâches, statuts,
   dépendances, claims et enveloppes d'exécution. Agent Board ne tient pas de
   Kanban bis et ne déclare jamais `done` à la place d'un humain.
2. **Défaut = aucun projet autorisé** (`scopeMode: 'none'`). Un tableau vide
   n'autorise jamais « tout ». `scopeMode: 'all'` exige un consentement explicite
   horodaté (`allConsent`), une case « Tous les projets » et une confirmation
   textuelle `ALL_PROJECTS`.
3. **Une seule barrière** : `PolicyEngine.authorize()` (déterministe, pur) est
   appelée par **tous** les chemins mutants : tick, `/dispatch`, approbation de
   proposition, reprise, failover, création/modification Task Board, forge,
   sous-agent, planification. Aucune action mutante ne contourne ce point.
4. Un score LLM (Super Agent) ne produit jamais un effet direct : il produit des
   **propositions structurées** (`Assessment`) que le PolicyEngine autorise,
   réduit ou refuse. Un prompt n'est pas une barrière de sécurité.
5. Tout contenu externe (issue, README, commentaire, sortie d'agent, fichier) est
   une **donnée non fiable** : il ne peut ni élargir le mandat, ni changer le
   modèle, ni changer une politique. Les prompts le balisent explicitement.
6. Aucune capacité fictive : une capacité est `available` seulement si le
   service/adaptateur réel est présent, configuré et testé. Sinon
   `unavailable`/`unsupported` **avec une raison** (`reason`).
7. Aucun secret (token, credential) dans l'état, un journal, un prompt, un
   événement SSE ou une réponse d'erreur.

---

## 1. Mandat, portée et niveaux

### 1.1 `state.mandate` (persisté)

```js
{
  version: 2,
  scopeMode: 'none' | 'selected' | 'all',
  selectedWorkspaces: string[],        // uniquement si scopeMode === 'selected'
  allConsent: null | {                 // uniquement si scopeMode === 'all'
    at: number, by: 'operator', text: 'ALL_PROJECTS', version: 1
  },
  level: 'L0'|'L1'|'L2'|'L3'|'L4',     // plafond global
  actions: {                           // autorisations par classe d'action
    comment: false, create_task: false, update_task: false, launch: false,
    delegate: false, schedule: false, push_branch: false, open_pr: false,
    merge: false, protected_branch_write: false, delete_task: false,
    secrets: false, policy_change: false
  },
  projects: {                          // politiques par projet (id = workspaceId)
    '<wsId>': {
      enabled: boolean,                // interrupteur indépendant (défaut false)
      level: 'L0'|...|'L4',            // plafond projet (défaut L0)
      priority: number,                // 0..9, plus petit = plus prioritaire
      model: null | { provider, model, reasoningEffort? },
      budget: { maxTasksPerHour: number },
      note: string
    }
  },
  paused: false,                       // pause globale (distincte de Stop)
  revision: number,                    // incrémenté à chaque mutation
  updatedAt: number, updatedBy: string,
  migratedFrom: null | { mode, allowedWorkspaces, at, reason },
  requiresConfiguration: boolean,      // true après migration : rien ne part
  consentVersion: 1
}
```

### 1.2 Niveaux L0–L4

| Niveau | Sens | Actions autonomes autorisées |
|---|---|---|
| L0 | Observation | `read`, `report` |
| L1 | Conseiller | + `analyse`, `propose` (écrit des propositions, jamais d'effet) |
| L2 | Supervisé | + exécution **après approbation humaine valide** (décision non périmée) |
| L3 | Autonome encadré | + `create_task`, `update_task`, `comment`, `launch`, `schedule`, `push_branch` (branche non protégée) |
| L4 | Autonomie maximale sous mandat | + `delegate`, `open_pr`, et les actions critiques **seulement si explicitement accordées** |

Actions critiques (`merge`, `protected_branch_write`, `delete_task`, `secrets`,
`policy_change`) : `critical: true`, jamais accordées par le niveau seul ; il faut
`actions.<action> === true` **et** une décision humaine approuvée pour
l'occurrence.

### 1.3 Politique effective (most-restrictive-wins)

```js
effectivePolicyOf({ mandate, projectId, action })
// => {
//   allowed: boolean,
//   reason: string,          // vocabulaire §1.4
//   level: 'L0'..'L4',       // min(global, projet, plafond d'action)
//   requiredLevel: 'L0'..'L4',
//   scope: 'none'|'selected'|'all',
//   requiresApproval: boolean,
//   requiresHumanDecision: boolean,
//   projectSelected: boolean
// }
```

Ordre : `requiredLevel = ACTION_MIN_LEVEL[action]` ; `level = min(mandate.level,
project.level ?? 'L0', INTEGRATION_CEILING[integration] ?? 'L4')` ; autorisé si
`rank(level) >= rank(requiredLevel)` **et** `actions[action] === true` (sauf
`read`/`analyse`/`propose`, toujours autorisés par le niveau) **et** portée
contient le projet **et** projet `enabled` **et** `!paused` **et** mode ≠ off.
L2 : `requiresApproval = true` (une décision approuvée et non périmée débloque
une exécution).

### 1.4 Vocabulaire des raisons (stable, affiché tel quel)

`allowed`, `mode_off`, `scope_none`, `project_not_selected`, `project_disabled`,
`paused_by_operator`, `stopped_by_operator`, `level_too_low`,
`action_disabled`, `approval_required`, `decision_missing`, `decision_expired`,
`critical_action_not_granted`, `budget_exhausted`, `project_budget_exhausted`,
`integration_unavailable`, `concurrency_limit`, `no_candidate_work`,
`requires_configuration`.

### 1.5 Migration depuis `schemaVersion: 1`

Au chargement d'un état sans `mandate` :
- `scopeMode` = `'selected'` si l'ancien `policy.allowedWorkspaces` est non vide,
  sinon `'none'` (jamais `'all'`) ;
- `level` = `off → L0`, `supervised → L1`, `autonomous → L1` (restrictif) ;
- `actions` = toutes `false` ;
- `projects` = chaque workspace sélectionné avec `{ enabled: false, level: 'L0' }` ;
- `requiresConfiguration: true` ;
- `migratedFrom = { mode, allowedWorkspaces, at, reason: 'goal6_scope_mode_v2' }` ;
- un événement d'audit `mandate_migrated` est écrit **une fois**.
- Aucun lancement n'est possible avant une confirmation explicite, même en
  autonome, même après redémarrage.

---

## 2. `state.superagent` (identité durable, session recyclable)

```js
{
  identity: {
    agentId: 'super-agent-<uuid>' | string,
    name: 'Super Agent',
    createdAt: number,
    model: { provider, model, reasoningEffort?, fallback: [{provider, model}] },
    level: 'L0'..'L4',                 // miroir du plafond effectif global
    status: 'idle'|'thinking'|'waiting_human'|'paused'|'stopped'|'error',
    generation: number                 // incrémenté à chaque cycle/session
  },
  session: {
    sessionId: string|null, active: boolean,
    createdAt: number|null, endedAt: number|null,
    recycledCount: number, recycleReason: string|null,
    lastTurnAt: number|null, lastError: string|null
  },
  memory: {
    facts: [{ id, at, scope, projectId, kind, text }],       // borné 120
    decisions: [{ id, at, kind, projectId, summary, refs }], // borné 120
    digest: { updatedAt, text, facts: number, decisions: number } | null
  },
  directives: Directive[],              // voir §2.1
  decisions: Decision[],                // voir §2.2
  plan: {
    revision: number, updatedAt: number,
    objectives: [{ id, projectId, title, status, source }],
    nextActions: [{ id, action, projectId, taskId, rationale }],
    idleReason: string|null
  },
  activity: [{ at, kind, summary, refs }],   // borné 60
  budget: {
    cyclesPerHour: number, cyclesThisHour: number,
    concurrentAgents: number, maxConcurrentAgents: number,
    modelCallsPerHour: number, modelCallsThisHour: number,
    tokenBudget: null,                 // null = métrique indisponible (honnête)
    metricAvailability: { tokens: false, cost: false, calls: true, cycles: true }
  },
  lastCycle: null | { at, trigger, outcome, reason, proposals, applied, durationMs },
  nextWakeAt: number|null,
  runtime: { available: boolean, reason: string|null, modelDiscovery: 'live'|'unavailable' }
}
```

### 2.1 Directive

```js
{ id, scope: 'global'|'project', projectId: string|null, text,
  author: 'operator', createdAt, updatedAt, version, status: 'active'|'revoked',
  source: 'ui'|'api'|'migration' }
```

Précédence : **permissions host > mandat > directive globale > directive projet >
plan/tâche**. Un conflit entre directives est résolu par la plus restrictive et
lève `conflict: true` (une décision n'est créée que si l'arbitrage est réel).

### 2.2 Decision (DecisionInbox)

```js
{ id, kind: 'approval'|'arbitration'|'missing_access'|'high_impact',
  projectId, title, context, action, taskIds: string[],
  options: [{ id, label, effect }], recommendation: string,
  urgency: 'urgent'|'normal', expiresAt: number|null,
  provenance, fingerprint, dedupeKey,
  status: 'pending'|'answered'|'expired'|'superseded',
  createdAt, answeredAt, answer: null | { optionId, by, at, note },
  resumeHint: string|null }
```

Règles : pas de doublon (`fingerprint`), pas de relance avant `expiresAt`,
`askedCount` borné, une décision `answered` débloque **une** action liée à son
`taskIds`/`action`, jamais une politique.

---

## 3. Modules purs (fichiers, API exactes)

### 3.1 `src/contracts/mandate.js` (Lead)

```js
export const SCOPE_MODES, AUTONOMY_LEVELS, ACTIONS, ACTION_MIN_LEVEL,
             CRITICAL_ACTIONS, INTEGRATION_CEILING, LEVEL_RANK
export function normalizeMandate(input, fallback?) -> Mandate
export function migrateLegacyPolicy({ policy, mode, now }) -> { mandate, audit }
export function emptyMandate(now) -> Mandate
export function effectivePolicyOf({ mandate, projectId, action, integration? }) -> EffectivePolicy
export function mandateAllows(mandate, probe) -> EffectivePolicy  // alias lisible
export function describeMandate(mandate) -> { scopeLabel, projectCount, level, capabilities }
```

### 3.2 `src/superagent/identity.js`

```js
export function createIdentity({ now, agentId?, model? }) -> Identity
export function normalizeIdentity(raw, { now }) -> Identity
export function publicIdentityOf(identity) -> object      // sans secret
export function markCycle(identity, { at, outcome }) -> Identity
export function requestRecycle(identity, reason) -> Identity
```

### 3.3 `src/superagent/directives.js`

```js
export function normalizeDirective(raw, { now }) -> Directive
export function addDirective(list, input, { now }) -> { directives, directive }
export function revokeDirective(list, id, { now }) -> { directives, directive, ok }
export function activeDirectives(list, { projectId }?) -> Directive[]
export function resolveDirectives(list, { projectId }?) -> { blocks: string[], conflicts: [], restricted: boolean }
export function directivesFingerprint(list) -> string
```

### 3.4 `src/superagent/memory.js`

```js
export const MEMORY_LIMITS
export function emptyMemory() -> Memory
export function recordFact(memory, fact, { now }) -> Memory
export function recordDecision(memory, decision, { now }) -> Memory
export function compactMemory(memory, { now }) -> Memory
export function buildDigest(memory, { now }) -> { text, updatedAt, facts, decisions }
export function checkpointOf(state, { now }) -> object   // contexte compact pour un nouveau session
```

### 3.5 `src/superagent/decisions.js`

```js
export const DECISION_LIMITS
export function emptyInbox() -> Decision[]
export function proposeDecision(inbox, input, { now }) -> { inbox, decision, duplicate }
export function answerDecision(inbox, id, { optionId, note, by, now }) -> { inbox, decision, ok, reason }
export function expireDecisions(inbox, { now }) -> { inbox, expired: number }
export function pendingDecisions(inbox) -> Decision[]
export function approvalFor(inbox, { action, taskIds, projectId, now }) -> Decision|null
export function inboxSummary(inbox) -> { pending, urgent, answered, oldestAt }
```

### 3.6 `src/superagent/brain.js`

```js
export const ASSESSMENT_SCHEMA_VERSION = 1
export function buildAssessmentPrompt(input) -> { system: string, user: string, untrusted: string[] }
export function parseAssessment(text) -> { ok, assessment?, reason? }
export function validateAssessment(value) -> { ok, assessment?, errors: string[] }
export function assessmentFingerprint(assessment) -> string
export function shouldRunCycle(input) -> { run: boolean, reason: string }
```

`Assessment` (sortie LLM validée) :

```js
{
  schemaVersion: 1,
  situation: string,                 // ≤ 800 chars
  findings: [{ id, projectId, kind: 'blocker'|'stale'|'risk'|'opportunity'|'info',
               summary, refs: string[] }],
  proposals: [{ id, action, projectId, taskId?, rationale, risk: 'low'|'medium'|'high',
                expectedEffect, requiresApproval }],
  decisions: [{ kind, projectId, title, context, options, recommendation, urgency }],
  directiveEcho: string[],
  noopReason: string|null,           // non null ⇒ le moteur ne fait rien
  directive?: { scope, projectId, text } | null   // l'agent peut proposer une directive
}
```
Validation stricte : toute `action` hors `ACTIONS` est rejetée ; tout `projectId`
inconnu du portefeuille est rejeté ; un texte > bornes est tronqué ; un JSON
invalide ⇒ `ok:false` et **aucun** effet.

### 3.7 `src/plan/portfolio.js` et `src/plan/scheduler.js` (Lead)

```js
export function buildPortfolio({ workspaces, mandate, tasksByProject, agentCounts, now }) -> Portfolio
export function planCandidateOrder({ portfolio, now }) -> string[]      // équitable, anti-famine
export function nextPlanActions({ portfolio, assignments, mandate, now }) -> { actions, idleReason }
```

---

## 4. Adaptateurs réels

### 4.1 `src/connectors/taskboard-public.js` (Task Board v1)

Client HTTP réel du contrat publié `Task Board → Agent Board v1`
(`D:\App\dsh-taskboard\docs\AGENT-BOARD-CONTRACT.md`).

```js
export function createPublicTaskBoardClient({ baseUrl, token, fetchImpl?, now?, timeoutMs? })
// => {
//   configured, baseUrl,
//   async meta(), projects(), listTasks({status,workspaceId,eligible,limit,cursor}),
//   task(id), dependencies(id), execution(id), events({since,limit}),
//   claim({taskId,actor,workspaceId,sessionId,idempotencyKey}),
//   attachSession(id,{actor,sessionId,ifFencingToken}),
//   attempt(id,{actor,reason,sessionId,ifFencingToken?}),
//   handoff(id,{actor,fromSessionId,toSessionId,reason,ifFencingToken}),
//   complete(id,{actor,outcome,ifFencingToken,comment?,report?}),
//   interrupt(id,{actor,ifFencingToken,reason})
// }
// Chaque méthode => { ok:true, value } | { ok:false, code, message, status? }
```

Règles : Bearer obligatoire, throw jamais (erreurs normalisées), timeout via
`AbortSignal`, token jamais journalisé, `idempotencyKey` obligatoire pour
`claim`, respect strict des codes `already_claimed`/`dependency_blocked`/
`version_conflict`/`stale_execution`/`public_api_disabled`/`unauthorized`.

`capabilitiesOf(meta)` renvoie une carte honnête :
`{ read: 'available', claim: ..., ... }` avec `reason` si non disponible.

### 4.2 `src/connectors/github.js` (existant, à durcir)

Lecture (issues/PR/checks) toujours possible si un dépôt est configuré ;
écriture (`issue.create`, `issue.comment`, `pr.open`) uniquement derrière
`mandate.actions.open_pr`/`comment` **et** `PolicyEngine`. `merge` reste refusé
par défaut (capacité `unsupported` si aucun mécanisme de protection vérifié).

### 4.3 Autres forges

`unsupported` explicite avec raison, sauf adaptateur réellement implémenté et
testé. Aucun faux adaptateur « production-ready ».

---

## 5. Payload `/dsh-agent-board/api/v2/state` (v2, additif)

```js
{
  schemaVersion: 2,
  host: {
    build: { version, schemaVersion, features: [...], startedAt, pid, source },
    primary: boolean, lockHolder,
    taskboardPublic: { configured, reachable, reason },   // jamais le token
    models: { discovered: boolean, providers: [{ id, models: [{ id, ... }] }], reason }
  },
  mode, stoppedAt, policy, acks, previews, turnEnd, proposals, recentProposals,
  assignments, routeEvents, health, lastTick, sync, adapters, audit, gone,
  contract, budget, primaryReturn,
  mandate,                     // description complète + effectivePolicy par projet
  capabilities,                // matrice dérivée de l'état réel (jamais « disponible » si refusé)
  supervision,                 // couche factuelle existante (jamais l'agent)
  superagent: {
    identity, session, memory, directives, decisions, plan, activity, budget,
    runtime, lastCycle
  },
  dryRun: null | { at, scope, projects, candidates, blocks, actions, model, limits }
}
```

`capabilities` doit porter, pour chaque entrée, `{ state: 'available'|'gated'|
'unavailable', reason, source }`. `supervision` et `superagent` restent **deux
états distincts** : le client n'affiche jamais l'un comme l'autre.

---

## 6. Routes HTTP (toutes sous `/dsh-agent-board/api/v2`)

Lecture : `GET /state`, `GET /events` (SSE, existant), `GET /diagnostics`,
`GET /dry-run` (aucune écriture), `GET /superagent/directives`,
`GET /superagent/decisions`.

Écriture (toutes : corps JSON + `ifRevision` optionnel ; `409` si périmé) :

| Route | Effet |
|---|---|
| `POST /mandate` | remplace le mandat validé (`scopeMode`, `level`, `actions`, `projects`, `paused`) |
| `POST /mandate/scope` | `{ scopeMode, selectedWorkspaces?, confirm? }` ; `all` exige `confirm:'ALL_PROJECTS'` |
| `POST /mandate/level` | `{ level }` |
| `POST /mandate/project` | `{ projectId, enabled?, level?, priority?, model?, budget? }` |
| `POST /mandate/pause` | `{ paused }` (pause globale, sans Stop) |
| `POST /superagent/start` | démarre la session runtime (si modèle résolu) |
| `POST /superagent/pause` / `/resume` / `/stop` | cycle de vie |
| `POST /superagent/model` | `{ provider, model, reasoningEffort?, fallback? }` (validé contre la découverte réelle) |
| `POST /superagent/cycle` | un cycle d'évaluation, `{ trigger }` |
| `POST /superagent/directives` | `{ text, scope, projectId? }` |
| `POST /superagent/directives/:id/revoke` | révocation auditée |
| `POST /superagent/decisions/:id/answer` | `{ optionId, note? }` |
| `POST /integrations/taskboard/probe` | négociation réelle (état, capacités) |

Toute réponse : `{ ok: true, value }` ou `{ ok: false, error, reason }`.

---

## 7. Cockpit (client)

Le cockpit validé (`feat/agent-board-responsive-cockpit`) est conservé : 15 SVG,
bandeau compact, cartes de supervision. Ajouts **dans** l'inspecteur existant :

1. **Vue d'ensemble** — objectif courant, étapes, résultat factuel, capacités,
   incidents, recommandations, journal compact.
2. **Projets** — liste réelle, toggle par projet, portée effective, L0–L4,
   priorité, modèle hérité/dédié, budget, source canonique ; sélection multiple +
   « Tous les projets » avec confirmation ; « Simuler » (dry-run).
3. **Directives** — canal persistant : historique, ajout global/projet,
   révocation, exemple, mémoire de décision.
4. **Paramètres** — modèle principal + fallbacks, autonomie globale, délégation,
   budget, réveils, notifications, permissions par action, réconciliation, Stop,
   diagnostic connecteurs.

Bandeau : mascotte couronne, **état de la session IA distinct** de la couche,
modèle, niveau, projets activés/total, activité, décisions en attente,
Pause/Stop/Reprendre. Aucun faux agent actif : sans runtime → « session non
démarrée » + action de démarrage.

Contraintes : tokens DeepSeek, clair/sombre, clavier/focus, `prefers-reduced-motion`,
libellés explicites, pas de sémantique portée par la couleur seule, mobile 360/390
avec Stop toujours accessible, listes tronquées avec « +N ».

---

## 8. Propriété des fichiers (aucune collision)

| Owner | Fichiers |
|---|---|
| Lead | `src/host/index.js`, `src/contracts/mandate.js`, `src/plan/*`, `src/superagent/runtime.js`, `docs/GOAL6-*.md`, `scripts/*`, `tests/goal6-*.test.js`, `tests/mandate*.test.js` |
| superagent-core | `src/superagent/{identity,directives,memory,decisions,brain}.js`, `tests/superagent-*.test.js` |
| taskboard-public | `src/connectors/taskboard-public.js`, `tests/taskboard-public.test.js`, `docs/TASKBOARD-PUBLIC-V1-AUDIT.md` ; `D:\App\dsh-taskboard` (branche dédiée) |
| ui-inspector | `src/client/**` (dont `app.js`, `ui/*.js`, `styles.js`, `strings.js`), `tests/cockpit-*.test.js` |

Le bundle `src/client.js` est reconstruit par **le Lead** (`node scripts/build-client.mjs`)
après intégration — les autres ne le modifient pas à la main.

Interdits : modifier `dev`/`main`, pousser sur un dépôt de projet réel, éditer
`src/host/index.js` hors Lead, stocker un secret, désactiver un test existant.

---

## 9. Commandes et critères de sortie

```powershell
node --test tests/                        # suite complète, 0 échec
node --check src/host/index.js
node scripts/build-client.mjs             # reconstruit src/client.js
git status --short                        # propre après commit
```

Critères : suite verte avec tests **ajoutés** (jamais retirés) ; `scopeMode:none`
⇒ aucune action même en L4 après migration/restart/fallback ; dry-run sans
écriture ; capacités = refus effectif ; `in_review` jamais `done` ; aucun secret
dans l'état/SSE/logs.
