# GOAL 6 — Super Agent IA multi-projets : rapport de livraison

- Date : 2026-11-12 (Europe/Paris)
- Branche : `feat/agent-board-superagent` (depuis `feat/agent-board-responsive-cockpit`, HEAD initial `afd7a66`)
- Branche poussée : `origin/feat/agent-board-superagent`
- **PR #3** (empilée, non fusionnée) : https://github.com/Rwanbt/DSH-agent-board/pull/3 → base `feat/agent-board-responsive-cockpit`
- Dépôt Agent Board : `Rwanbt/DSH-agent-board`
- Dépôt Task Board : `Rwanbt/dsh-taskboard`, branche `feat/universal-sync`, HEAD `e6aaece`, version **0.12.0**
- Suite Agent Board : **563 / 563 tests passent**, 0 échec (`node --test tests/`)
- Bundle client reconstruit : `src/client.js` (603 799 octets, 23 modules)
- E2E hôte réel : **scénarios 0, a, b, c verts** (`node scripts/e2e/run-e2e.mjs`)

Ce document remplace toute affirmation de « production-ready » non prouvée. La section 10
liste ce qui **n'est pas** validé et pourquoi.

---

## 1. Verdict honnête

| Périmètre | Statut |
|---|---|
| Mandat explicite `none/selected/all`, L0–L4, gate unique, migration restrictive, dry-run | **Livré, testé unitaire + hôte réel** |
| Super Agent IA réel (session DSH, modèle, directives, mémoire, décisions) | **Livré, testé hôte réel** (LLM simulé au bord, DSH réel) |
| Planification multi-projets équitable + reprise après crash | **Livré, testé** (hôte réel : A puis B, C jamais touché) |
| Task Board propriétaire (lecture) + adaptateur public-v1 + sonde | **Livré, testé** ; **écriture live non activée** (API publique 503, aucun token) |
| GitHub bout en bout (issue → tâche → worker → PR/checks) | **NON validé** : aucune écriture n'est implémentée ni annoncée ; **la lecture réelle est validée en live** (3 PR ouvertes listées le 12/11 via l'adaptateur). L'écriture exige un dépôt de test et une décision produit non données. |
| Cockpit 4 onglets + bandeau Super Agent, desktop/mobile | **Livré, testé** ; captures ci-dessous |
| Installation / migration / rollback documentés | **Livré** (§9) |
| Revue indépendante adversariale | **1 P0 + 3 P1 + 2 P2 trouvés, tous corrigés** ; revérification : **0 P0 / 0 P1 connus**, suite verte |

Conclusion : le système est **utilisable quotidiennement en usage personnel** dans les
limites de la section 10. Il **ne doit pas** être annoncé « GitHub validé en live » ni
« écritures Task Board publiques validées en live ».

---

## 2. Commits (atomiques, non fusionnés)

| SHA | Contenu |
|---|---|
| `23a8c5b` | `feat(mandate)` : scope explicite, L0–L4, migration restrictive, scheduler équitable, état v2 (store) |
| `dfffda8` | `feat(superagent)` : 5 modules purs (identité, directives, mémoire, décisions, assessment) + 30 tests |
| `0ed7289` | `feat(host)` : gate unique sur tous les chemins, runtime Super Agent, `/mandate*`, `/dry-run`, `/superagent/*`, payload v2 |
| `3d39445` | `feat(taskboard)` : client public-v1 réel + sonde hôte honnête + audit live |
| `cf07f79` | `feat(cockpit)` : bandeau Super Agent, inspecteur 4 onglets, portée projets, boîte de décisions, bundle |
| `32cc6ed` | `test(e2e)` : scénarios hôte réel (gate mandat, 3 projets) + preuves régénérées |
| `120748c` | `fix(superagent)` : cycles concurrents coalescés, backoff exponentiel après échec, réveils publiés |
| `1ec2ddb` | `test(e2e)` : preuves régénérées après les correctifs de robustesse |
| `e527789` | `fix(goal6)` : correctifs de la revue indépendante (P0 handoff, approbation single-use, capacités, schéma inconnu, équité, cadence, UI, modèle/budget projet) |
| `f9caab5` | `docs(goal6)` : rapport, limites, installation/rollback, captures |
| `f5a7193` | `docs(goal6)` : branche poussée, PR #3, preuve de lecture GitHub réelle |

Aucune fusion sur `dev`/`main`, aucun commit dans un dépôt de projet réel, aucun commit
dans `D:\App\dsh-taskboard` (aucun défaut bloquant trouvé côté Task Board).

---

## 3. Ce qui a changé, par exigence

| Exigence (mandat) | Changement | Test / preuve | Statut |
|---|---|---|---|
| P0-A : décalage hôte/client visible (F0) | `host.build {version, schemaVersion, features[], startedAt, pid, source}` publié ; le client compare et dit « hôte plus ancien » | `tests/goal6-host-gate.test.js` (build/schema/features), E2E 0.7 | Livré |
| P0-B : `[]` ≠ « tous » (F1) | `scopeMode: 'none'\|'selected'\|'all'`, défaut `none`, `all` exige `allConsent{text:'ALL_PROJECTS',at}` | `tests/mandate.test.js` (20 cas), `goal6-host-gate` (migration + restart + L4), E2E 0a/0f | Livré |
| P0-B : migration dangereuse | `migrateLegacyPolicy` : ancien autonome + liste vide → `none`, L1, actions `false`, `requiresConfiguration:true`, audit unique | `goal6-host-gate` « v1 migration… » ; E2E 0a | Livré |
| P0-B : gate central | `effectivePolicyOf` appelé par tick, `/dispatch`, approbation, reprise, failover/handoff, retry, Super Agent | `tests/mandate.test.js`, `goal6-superagent-host`, `goal6-host-gate` (handoff après retrait du projet), 563 tests | Livré |
| P0-C F2 : capacités véridiques | `capabilities.<action> = {state,reason,source}` dérivé de l'état réel ; jamais `available` si refus | `goal6-host-gate` « capabilities are truthful in OFF and after a Stop » | Livré |
| P0-C F3 : Stop lisible + Reprendre | `stoppedAt` explicite, `POST /resume`, bandeau « Arrêté (observation) » + Reprendre | hôte : test Stop/Resume ; UI : `cockpit-superagent` | Livré |
| P0-C F4 : recommandations en Arrêt | une seule ligne explicite en OFF/Stop, compteurs conservés | `tests/cockpit-superagent.test.js` | Livré |
| P0-C F5 : définition unique de l'orchestrateur | `source` déclaré/déduit exposé ; l'inférence ne donne aucune autorité | `hierarchy.js` + tests cockpit | Livré |
| P0-C F6 : plafond effectif | `dryRun.limits.effectiveConcurrent = min(maxConcurrent, maxConcurrentDelegations)` | `goal6-host-gate` (dry-run), tests cockpit | Livré |
| P0-C : dry-run | `GET /dry-run` : projets, candidats, refus, limites, `writes: 0`, aucune session | `goal6-host-gate` (dry-run), E2E 0d/0e | Livré |
| P0-C F8 : mandat/budget/permissions en UI | onglet Paramètres + Projets + Directives | `cockpit-superagent` (15 tests) | Livré |
| P0-C F9 : troncatures « +N » | listes bornées avec compteur explicite | tests cockpit | Livré |
| P0-C F10 : doc versions | ce document + `TASKBOARD-PUBLIC-V1-AUDIT.md` + `LIMITATIONS.md` | revue | Livré |
| P1 : identité IA durable | `state.superagent.identity` (`agentId`, modèle, niveau, génération) + session recyclable | `goal6-superagent-host` : identité conservée après redémarrage, session recyclée | Livré |
| P1 : modèle réel | découverte `ctx.llm.listProviders()/listModels()` + `agentDefaultModel` ; `/superagent/model` refuse un modèle non enregistré | `goal6-host-gate` « model discovery is honest », probe | Livré |
| P1 : directives persistantes | `POST/GET /superagent/directives`, révocation auditée, injectées dans le prompt | `goal6-superagent-host` : la directive apparaît dans le prompt | Livré |
| P1 : décisions rares | DecisionInbox dédupliquée, expiration, une réponse débloque **une** occurrence (marqueur `usedAt` persisté) | tests `superagent-decisions` + `goal6-host-gate` (une approbation → un seul lancement, puis `approval_required`) | Livré |
| P1 : L0–L4 | table §4, `actions.<action>` + niveau + plafond projet + plafond intégration | `tests/mandate.test.js` | Livré |
| P2 : planification multi-projets | `plan/portfolio.js` + `plan/scheduler.js` (priorité → anti-famine → moins servi → id) branchés sur le tick, avec **interleave round-robin** entre projets | `goal6-portfolio` (10 tests, dont « un projet ne prend pas les 2 slots ») ; E2E c1/c2 | Livré |
| P2 : reprise / idempotence | journal v2, lease/fencing existants, réconciliation au démarrage, décision consommée une fois | suite existante + `goal6-superagent-host` (restart) | Livré |
| P3 : Task Board canonique | lecture via connecteur existant ; adaptateur public-v1 complet ; sonde réelle | `taskboard-public` (11 tests), `goal6-taskboard-probe` (3), audit live | Partiel (voir §10) |
| P3 : `in_review`, jamais `done` | conservé et testé (E2E a5, b6) | E2E | Livré |
| P4 : cockpit | 4 onglets, bandeau, décisions, a11y, mobile | `cockpit-superagent` + captures §8 | Livré |
| P5 : sécurité | deny-by-default, secrets jamais publiés, injection balisée, audit | `security.test.js` + `goal6-*` | Livré |
| P6 : E2E réel | 4 scénarios sur un vrai process DSH | E2E | Livré |

---

## 4. Contrat d'autonomie (résumé opérationnel)

### 4.1 Portée

- `scopeMode: 'none'` (défaut) : aucune action mutante, même en L4, après migration, redémarrage ou fallback.
- `'selected'` : seuls les `selectedWorkspaces` sont dans le périmètre ; chaque projet a son interrupteur `enabled` (défaut `false` après migration).
- `'all'` : exige un consentement persistant `{at, by, text:'ALL_PROJECTS', version:1}` via `POST /mandate/scope { scopeMode:'all', confirm:'ALL_PROJECTS' }`.
- Un tableau vide n'autorise jamais tout ; `selected` sans workspace retombe sur `none`.

### 4.2 Niveaux

| Niveau | Autorisé dans le mandat |
|---|---|
| L0 | lire, agréger, rapporter |
| L1 | + analyser, proposer (aucun effet) |
| L2 | + exécuter une action préparée **après décision humaine valide** |
| L3 | + créer/mettre à jour des tâches, commenter, lancer des workers, planifier, pousser une branche non protégée |
| L4 | + déléguer, ouvrir des PR, et les actions critiques **seulement si accordées explicitement** |

Critiques (`merge`, `protected_branch_write`, `delete_task`, `secrets`,
`policy_change`) : `actions.<action>` **et** décision humaine par occurrence ; L4 ne les
accorde jamais seul.

### 4.3 Refus (vocabulaire stable, affiché tel quel)

`mode_off`, `stopped_by_operator`, `paused_by_operator`, `scope_none`,
`project_not_selected`, `project_disabled`, `requires_configuration`, `level_too_low`,
`action_disabled`, `critical_action_not_granted`, `approval_required`,
`concurrency_limit`, `project_budget_exhausted`, `integration_unavailable`,
`runtime_unavailable`, `no_ready_work`.

### 4.4 Stop / pause / reprise

- `POST /stop` : annule les sessions, `stoppedAt` persiste, tous les lancements refusés.
- `POST /resume` : lève le Stop (jamais automatique au redémarrage sauf
  `autoResumeOnRestart:true`).
- `state.mandate.paused` : pause douce (aucun tick, aucune action), distincte du Stop.
- `POST /superagent/pause|resume|stop` : cycle de vie de l'agent lui-même.
- Une réponse de décision ne vaut **jamais** approbation par silence ; une décision
  consommée ne peut pas autoriser deux lancements.

---

## 5. Architecture réelle livrée

```
state.json v2 (atomique, lock primaire, journal JSONL)
├─ mandate                 (contrats/mandate.js — pur)
├─ policy                  (routes/models/permissions existants)
├─ superagent
│  ├─ identity             (superagent/identity.js — session recyclable)
│  ├─ directives[]         (superagent/directives.js)
│  ├─ decisions[]          (superagent/decisions.js — DecisionInbox)
│  ├─ memory               (superagent/memory.js — faits/décisions/digest)
│  └─ plan/activity/budget/lastCycle
├─ assignments/proposals   (lease/fencing/journal existants)
└─ taskboardPublic         (dernière sonde réelle, jamais le token)

host/index.js
├─ effectiveFor(action)    ← LE gate (tick, dispatch, approval, resume, failover, superagent)
├─ runSuperAgentCycle()    ← faits → prompt → assessment validé → gate → launch autorisé
├─ /mandate*, /dry-run, /diagnostics, /superagent/*, /integrations/taskboard/probe
└─ publicStateOf v2        ← host.build, models, mandate, capabilities, portfolio, superagent, dryRun

plan/portfolio.js + plan/scheduler.js  ← équité inter-projets (pure)
connectors/taskboard-public.js         ← contrat public-v1 réel
```

Le Super Agent **ne contourne jamais** le gate : le LLM produit un `Assessment` validé
(actions/projets inconnus rejetés), puis chaque proposition est autorisée ou refusée par
le même moteur déterministe que le reste du board. Une proposition refusée ne crée
aucune session (prouvé par test).

---

## 6. Preuves exécutées (commandes exactes)

```powershell
node --test tests/                       # 563/563, 0 fail
node --check src/host/index.js           # OK
node scripts/build-client.mjs            # built 603 799 bytes, 23 modules
node scripts/e2e/run-e2e.mjs             # 0/a/b/c verts sur un vrai process DSH
node --test tests/taskboard-public.test.js   # 11/11
```

E2E hôte réel (DSH isolé, profil `e2e`, Task Board et fournisseurs simulés aux bords) :

| Assertion | Résultat |
|---|---|
| 0a mandat non confirmé ⇒ aucun lancement même en autonome | `requires_configuration`, 0 action |
| 0b aucune session créée par le tick refusé | 0 → 0 |
| 0c capacité publiée = refus réel | `unavailable / scope_none` |
| 0d/0e dry-run sans écriture ni assignment | `writes:0`, 0 assignment |
| 0f `all` sans `ALL_PROJECTS` | HTTP 409 |
| 0g/0h après mandat explicite | `available`, audit `mandate_confirmed` |
| a1–a7 (régression) | lease→session→settle→`in_review`, SSE v2 |
| b1–b7 (régression) | 429 → switch → 2ᵉ exécution canonique → `in_review` |
| c1/c2 3 projets | A (L4, prio 1) servi d'abord, puis B (L3) |
| c3 projet C hors périmètre | 0 assignment, 0 appel, 0 écriture |
| c4/c5 portfolio publié | C `selected:false`, A `level:L4` |

Preuve Task Board réelle (lecture) :

```
GET http://127.0.0.1:62124/dsh-taskboard/public/v1/meta    → 503 public_api_disabled
GET .../projects                                          → 503 public_api_disabled
GET .../tasks?limit=5                                     → 503 public_api_disabled
```

Le build installé 0.12.0 a été validé en process isolé (ledger temporaire) : lectures
200, `claim` 201, `attach` 200, `attempts` fence 2, `handoff` fence 3,
`complete` sans fence → 409 `stale_execution`, complétion → carte `in_review`,
`dependency_blocked` 409, mauvais token 401, aucune fuite de token. Voir
`docs/TASKBOARD-PUBLIC-V1-AUDIT.md`.

GitHub (lecture réelle, sans token, adaptateur du produit) :

```
createGithubAdapter({ repository: 'Rwanbt/DSH-agent-board', token: '' }).list()
→ live:true, status:available, 3 éléments (pull_request), pages:1, truncated:false
```

Cela prouve la lecture réelle (API GitHub, pagination, normalisation) ; **aucune
écriture GitHub n'a été exécutée** et l'adaptateur n'en annonce aucune. Cette preuve est
un contrôle opérateur ponctuel : l'adaptateur continue de déclarer
`validatedLive:false` (il ne s'auto-déclare pas validé pour un autre dépôt).

---

## 7. Sécurité (propriétés couvertes par tests)

- Aucun secret publié : le token Task Board n'apparaît ni dans `/state`, ni dans
  `/diagnostics`, ni dans une erreur (`goal6-host-gate`, `goal6-taskboard-probe`,
  `security.test.js`).
- Toute écriture exige un acteur, un mandat, une révision et une clé d'idempotence
  (client public-v1) ; `done` reste interdit au board.
- Contenu externe balisé comme donnée non fiable dans le prompt du Super Agent ;
  il ne peut pas élargir le mandat.
- Une décision humaine est liée à l'action/au projet/à la tâche et consommée une fois
  (`usedAt` survit à la normalisation : une approbation ne peut pas autoriser deux
  lancements, prouvé par un test hôte).
- Les réveils du Super Agent sont coalescés (timer + opérateur + événement ne peuvent pas
  lancer deux cycles concurrents) et un assessment inutilisable déclenche un backoff
  exponentiel au lieu d'une boucle de réessai ; la cadence `nextWakeAt` est réellement
  consommée par le timer, et les budgets cycles/appels sont contrôlés, y compris en échec.
- Un `state.json` d'une version inconnue est mis de côté (`.unsupported-<ts>`), jamais
  écrasé par les valeurs par défaut.
- Migration : un état v1 n'autorise rien, un état v2 n'est jamais écrasé (le store
  accepte v1 et v2 ; une version inconnue préserve le fichier au lieu de le remplacer).

---

## 8. Interface (captures)

Captures générées sur l'hôte E2E réel (profil isolé, GUI 127.0.0.1:50735), console
navigateur 0 erreur, `POST /superagent/directives → 200` :

| Capture | Contenu |
|---|---|
| `docs/e2e/screenshots/goal6-1366-cockpit.png` | bandeau : couche de supervision et session IA distinctes, contrôles Démarrer/Pause/Arrêter/Reprendre |
| `docs/e2e/screenshots/goal6-1366-overview.png` | vue d'ensemble, objectif factuel, matrice de capacités avec raisons, décisions |
| `docs/e2e/screenshots/goal6-1366-projects.png` | portée 2/3 projets, A L4, B L3, C hors portée (`project_not_selected`), bouton Simuler |
| `docs/e2e/screenshots/goal6-1366-directives.png` | état vide + formulaire |
| `docs/e2e/screenshots/goal6-1366-directive-saved.png` | directive persistée + session Super Agent réelle créée |
| `docs/e2e/screenshots/goal6-1366-settings.png` | modèle/fallbacks, autonomie L3, budgets, permissions avec refus effectif |
| `docs/e2e/screenshots/goal6-1366-dark.png` | thème sombre |
| `docs/e2e/screenshots/goal6-390-band.png` | mobile 390 px, Stop atteignable |
| `docs/e2e/screenshots/goal6-390-settings.png` | mobile, inspecteur bottom sheet |

Détail et limites : `docs/e2e/GOAL6-UI-EVIDENCE.md`.

---

## 9. Installation, migration, désactivation, rollback

### Installation (profil DSH)

```powershell
# profil desktop : le plugin est déjà lié
# node_modules\dsh-agent-board -> D:\App\DSH-agent-board
# Redémarrage COMPLET de DSH requis (le gestionnaire de plugins ne recharge pas le host)
```

### Activer l'intégration Task Board publique (optionnelle)

```powershell
[Environment]::SetEnvironmentVariable('DSH_TASKBOARD_PUBLIC_TOKEN', '<token>', 'User')
# redémarrer DSH, puis :
# POST /dsh-agent-board/api/v2/integrations/taskboard/probe
```

Sans token : l'API reste désactivée côté Task Board (503) et l'Agent Board l'affiche
comme telle. Aucun secret n'est demandé par l'UI.

### Migration v1 → v2

1. Sauvegarder `%USERPROFILE%\.dsh\agent-board\state.json` + `journal.jsonl`.
2. Démarrer : l'état est migré une fois (`mandate_migrated` dans l'audit), tous les
   lancements restent refusés (`requiresConfiguration:true`).
3. Configurer le mandat (UI ou `POST /mandate`), puis `POST /resume` si nécessaire.

### Désactivation / rollback

```powershell
git checkout feat/agent-board-responsive-cockpit   # ou le commit précédent
# redémarrer DSH
# restaurer state.json + journal.jsonl depuis la sauvegarde si nécessaire
```

Un `state.json` v2 n'est **pas** relu par l'ancienne version (elle exige v1) : restaurer
la sauvegarde v1 avant de revenir en arrière. Aucune perte silencieuse : le store met de
côté un document illisible au lieu de l'écraser.

---

## 10. Limites honnêtes et risques résiduels

### Bloquants externes (non résolus, non simulés en « live »)

1. **GitHub bout en bout non validé** : la **lecture** réelle est prouvée (voir §6) et
   `gh` est authentifié sur la machine, mais l'adaptateur est en **lecture seule** :
   aucune création d'issue, commentaire ou PR n'est implémentée ni annoncée. Le scénario
   issue → tâche → worker → PR/checks n'est donc **pas** prouvé. C'est le principal écart
   à la barre de sortie P3, et il exige une décision produit (dépôt de test autorisé +
   écriture GitHub) qui n'a pas été donnée.
2. **Écritures Task Board publiques non activées en live** : `DSH_TASKBOARD_PUBLIC_TOKEN`
   absent du host audité (503 `public_api_disabled`). L'adaptateur et le contrat sont
   implémentés et testés (serveur local + build réel isolé), mais aucune écriture n'a
   été observée contre l'instance en cours.
3. **Backend d'exécution public-v1 non branché** : le chemin unifié actuel reste le
   backend `contract` négocié. Le client public-v1 est prêt mais ne remplace pas encore
   `lease→attach→settle` ; le faire sans validation live ajouterait un risque de double
   écriture.

### Revue indépendante (adversariale)

Un relecteur indépendant a été lancé sur la branche. Constats et suites :

| Constat | Sévérité | Suite |
|---|---|---|
| Handoff/retry contournaient le nouveau mandat (legacy `mandateCheck`) | **P0** | Corrigé : `continuationGate` sur les deux chemins, test « retrait du projet ⇒ handoff_suppressed », audit |
| `usedAt` effacé par la normalisation → approbation réutilisable | **P1** | Corrigé : `usedAt` persisté, test hôte « une approbation = un lancement » + test de normalisation |
| `state.json` d'une version inconnue écrasé par les défauts | **P1** | Corrigé : mise de côté `.unsupported-<ts>`, test dédié |
| Matrice de capacités fictive (actions sans adaptateur) | **P1** | Corrigé : `no_adapter_for_action`, `launch` reflète le backend (`contract_unavailable`) |
| Équité : un projet pouvait prendre tous les slots | P2 | Corrigé : interleave round-robin + test |
| Cadence Super Agent décorative, budgets non contrôlés | P2 | Corrigé : `nextWakeAt` consommé, budgets cycles/appels appliqués, timeout recycle |
| Retry supprimé laissait un assignment `running` | P2 | Corrigé : `interrupted` + `endedAt` + lease libéré |
| `/dry-run` et Settings divergeaient des capacités | P2/P3 | Corrigé : le dry-run inclut la disponibilité du backend, Settings lit le payload `capabilities` |

Verdict de revérification : **0 P0, 0 P1 connus** ; les P2 signalés ont été corrigés
(le relecteur les a confirmés par probe avant correction).

### Risques résiduels (ordonnés)

- **P1** : `validateAssessment` strict peut rejeter une sortie LLM sans
  `schemaVersion`/`directiveEcho` ; conséquence sûre (aucun effet) mais un cycle perdu.
  Prévoir une boucle de réparation de prompt.
- **P1** : l'heuristique de conflit de directives est lexicale (polarité explicite),
  pas sémantique : deux directives ambiguës ne sont pas détectées comme conflictuelles.
- **P2** : la consommation d'une décision est faite au moment de l'autorisation, pas à la
  création effective de la session ; un échec de création consomme l'approbation (comportement conservateur).
- **P2** : la découverte de modèles dépend de `ctx.llm` ; sans ce service, `/superagent/model`
  refuse explicitement (`model_discovery_unavailable`) et le runtime utilise le modèle
  par défaut de l'hôte.
- **P2** : `portfolio.taskCounts` est borné par la lecture du ledger (compteurs explicitement
  bornés, jamais présentés comme exhaustifs).

### Non testé

- Un vrai fournisseur LLM payant (seul un serveur OpenAI-compatible scripté a été utilisé).
- Un vrai dépôt GitHub (lecture ou écriture).
- Charge > 150 sessions visibles (les tests de projection existants restent la référence).
- Multi-utilisateur / multi-tenant (hors périmètre assumé).

---

## 11. Fichiers principaux

| Fichier | Rôle |
|---|---|
| `src/contracts/mandate.js` | scope, niveaux, gate `effectivePolicyOf`, migration |
| `src/superagent/{identity,directives,memory,decisions,brain}.js` | logique pure du Super Agent |
| `src/plan/{portfolio,scheduler}.js` | portefeuille + équité inter-projets |
| `src/connectors/taskboard-public.js` | client réel du contrat public-v1 |
| `src/host/index.js` | gate, runtime Super Agent, API, payload v2 |
| `src/client/ui/{superbar,inspector,hierarchy}.js` | cockpit Super Agent |
| `tests/goal6-*.test.js`, `tests/mandate.test.js`, `tests/superagent-*.test.js` | preuves |
| `docs/GOAL6-CONTRACT.md` | contrat d'implémentation |
| `docs/TASKBOARD-PUBLIC-V1-AUDIT.md` | audit live + procédure token |
| `scripts/e2e/run-e2e.mjs` | E2E hôte réel (scénarios 0/a/b/c) |
