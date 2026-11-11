# Compte rendu — le « Super Orchestrator » est-il utilisable ?

- Date : 2026-11-11 22:30 (Europe/Paris)
- Branche : `feat/agent-board-responsive-cockpit`, HEAD `5e69e24`, arbre propre
- Plugin installé : profil `desktop`, `dsh-agent-board` → `link:D:/App/DSH-agent-board`
- Hôte réel : GUI `http://127.0.0.1:56117`, état durable `%USERPROFILE%\.dsh\agent-board\state.json`
- Task Board réel : `dsh-taskboard` **0.12.0**, révision **1041**, 381 tâches (360 non supprimées)
- Suite de tests : **451 / 451 passent**, 0 échec (`node --test tests/`, ~2,9 s)

## 1. Verdict

**Votre impression est juste, mais elle ne porte pas sur ce qui est livré.**

Il y a trois choses différentes derrière le nom « Super Orchestrator » :

| Ce que l'on croit | Ce qui existe réellement | Utilisable aujourd'hui ? |
|---|---|---|
| Un agent IA qui orchestre plusieurs projets | Une **couche de supervision synthétique** (moteur de politique du host), `synthetic:true`, sans modèle ni session | **Oui pour observer**, non pour agir |
| Un orchestrateur qui décide et applique | Un **moteur de décision** (OFF / Supervisé / Autonome) qui propose et, en autonome, lance des tâches du Task Board | **Techniquement oui**, mais dangereux par défaut (voir F1) |
| Un rôle d'agent « super orchestrateur » | Un **rôle cosmétique** : `workspace.agent` reste `null` sauf si un agent est explicitement nommé `super-orchestrator` | **Non** (et ce n'est pas prévu) |

Conclusion courte :

- la **couche de supervision** est solide, testée, honnête, branchée sur le vrai ledger : elle n'est pas « cassée » ;
- l'**orchestrateur autonome** n'est pas utilisable sereinement par un opérateur aujourd'hui : périmètre global non réglable depuis l'UI, capacité « Déléguer » annoncée disponible alors qu'elle est refusée, Stop persistant qui fige la couche en « Bloqué », et 50 recommandations inapplicables en mode Arrêt ;
- l'**agent super-orchestrateur** n'existe pas : c'est un choix documenté, pas un bug.

Les trois causes de votre impression, par ordre d'impact :

1. **F1 (P1)** — le mandat par défaut est *tout le ledger* : en passant en Autonome, l'Agent Board a lancé, en 1 seconde, une tâche du projet **Unifia** (`t-mw9yu23v-r5q3vd`, « Qualifier #1113 »), alors que le panneau était ouvert sur `D:\App\DSH-agent-board` (qui n'a aucune tâche dans le ledger). Vous avez arrêté 17 s plus tard.
2. **F2 (P1)** — la matrice de capacités affiche « Déléguer : Sous conditions » en **vert** même en mode Arrêt / après Stop, alors que tout lancement est refusé (`mode_off`, `stopped_by_operator`).
3. **F3 (P2)** — le Stop est persistant : la couche reste « Bloqué · stopped_by_operator » indéfiniment, et le bouton « Reprendre » n'est pas dans la bande.

## 2. Chronologie de l'essai réel (état durable, UTC)

| Heure (UTC) | Événement | Preuve |
|---|---|---|
| 18:53:30 | mode `off` → `supervised` | `state.audit` `mode_changed` |
| 18:53:33 | tick : **8 propositions** créées, toutes dans le projet `b61ebc1b` (Unifia) | `state.audit` + `state.proposals` |
| 18:53:41 | mode `supervised` → `autonomous` | `state.audit` |
| 18:53:42 | **lancement réel** de `t-mw9yu23v-r5q3vd` → session `session-agentboard-19e3edcc-…`, modèle `opencode-go/deepseek-v4.1-flash`, permission `workspace-write` | `state.audit` `launch` + `assignments[1]` |
| 18:53:57 | tick suivant : `already_running`, puis 31 tâches `concurrency_limit` (40 tâches écartées au total) | `state.lastTick` |
| 18:53:59 | **Stop all** : session annulée, assignment `stopped`, erreur `stopped_by_operator`, `stopEpoch:1` | `state.audit` `stop_all` |
| 18:54:13 | mode → `off` ; les 8 propositions passent `pending` → `dormant` | `state.audit` + code `host/index.js:2364-2372` |
| depuis | `stoppedAt` toujours renseigné → la couche est **`blocked / stopped_by_operator`** | `state.json`, `super-orchestrator.js:402-415` |

C'est exactement le scénario « je l'active, il part tout seul ailleurs, je l'arrête ». Le moteur a fait ce qu'on lui a demandé ; c'est le **périmètre par défaut** et le **manque de prévisualisation** qui rendent l'expérience inutilisable.

## 3. Ce qui est réellement livré (et qui marche)

| Capacité | État | Preuve |
|---|---|---|
| Observer agents, projets, blocages, dépendances inter-projets | **livré** | projection pure + tests ; 3 orchestrateurs déduits visibles dans la bande |
| Lire le Task Board réel (lecture seule) | **livré** | `GET /dsh-taskboard/state` → **200** en anonyme ; 360 tâches / 702 arêtes normalisées |
| Proposer des délégations / déblocages | **livré** | `recommendations[]`, `status:'proposed'`, `applies:false` |
| Déléguer (lancement) | **livré et vérifié en réel** | lancement du 11/11 18:53:42, une vraie session créée, Stop propre |
| Gate de délégation (profondeur, concurrence, budget horaire, cycle, cross-projet) | **livré** | `delegation.js` + tests ; refus avant tout lease/session |
| Événements de supervision bornés/dédupliqués | **livré** | `supervisionEvents`, plafond 50, ids stables |
| Réaffecter / prioriser / écrire le Kanban | **non disponible** | `taskboard_write_api_unavailable`, `taskboard_priorities_unavailable` |
| Rapports d'orchestrateur entrants | **non disponible** | `no_inbound_orchestrator_report_channel` |
| Backend d'exécution `contract` | **non disponible** | `GET /dsh-taskboard/contract` → **404** sur la 0.12.0 installée |
| Agent super-orchestrateur | **n'existe pas** | `workspace.agent = null` sauf rôle déclaré `super_orchestrator` |

La bande est réelle et rend des faits réels. Capture de référence du dépôt
(`docs/e2e/screenshots/cockpit-1366-superbar-open.png`) : « Super Orchestrator · Inactif
(observation) · 5 projets · 3 orchestrateurs · Mode : Observation », délégation
« 0 en cours · profondeur 1 · 2 simultanées · 6/h », une recommandation
« proposition — non appliquée », 0 blocage, et la matrice de capacités avec ses
raisons réelles.

## 4. Constats détaillés

### F1 — P1 — Le périmètre de l'autonomie est global et non réglable depuis l'UI

- **Preuve** : `mandateCheck` (`src/orchestrator/dag.js:85-92`) ne restreint que si
  `allowedWorkspaces` est non vide ; la politique réelle a `allowedWorkspaces: []`
  ⇒ *tous* les workspaces. Aucun contrôle de politique dans le client
  (`grep allowedWorkspaces|projectPolicies|autonomyBudget` → rien dans `src/client/`).
  Le ledger contient 5 workspaces (205 tâches Unifia, 96, 60, 19, 1).
- **Impact** : en Autonome, l'Agent Board peut lancer n'importe quelle tâche prête de
  n'importe quel projet. C'est ce qui s'est produit (Unifia #1113, `workspace-write`,
  modèle distant) alors que le panneau était sur un autre projet.
- **Correctif** : périmètre explicite et *deny by default* : soit `allowedWorkspaces`
  = projets visibles, soit une case « Tous les projets » à cocher ; afficher
  « Périmètre : N projets » dans la bande ; refuser Autonome si le périmètre est vide.

### F2 — P1 — La matrice de capacités surpromet en Arrêt / après Stop

- **Preuve** : `supervisionCapabilities` (`src/supervisor/super-orchestrator.js:791-818`)
  ne lit que `config.enabled` ; `delegate` vaut `'gated'` en permanence. Or
  `authorizeLaunch` refuse dès `isStopped()` (`src/host/index.js:979-990`) et
  `evaluateDelegation` refuse `mode_off` (`delegation.js:151`).
- **Impact** : la bande affiche « Déléguer — Sous conditions » (vert) dans un état où
  aucun lancement n'est possible. C'est la contradiction la plus visible avec
  l'expérience vécue.
- **Correctif** : dériver `delegate` de `(mode, stoppedAt, mandat)` et publier la
  raison réelle (`mode_off`, `stopped_by_operator`, `empty_mandate`).

### F3 — P2 — Le Stop persistant fige la couche en « Bloqué », sans reprise dans la bande

- **Preuve** : `stoppedAt` survit au redémarrage (`autoResumeOnRestart:false`) et
  n'est levé que par `POST /resume` ; `supervisionStatusOf` renvoie `blocked` dès que
  `stoppedAt` est non nul, même en mode Arrêt. `state.json` : `mode:"off"`,
  `stoppedAt:1794423239972`.
- **Impact** : des jours après l'essai, la bande affiche « Bloqué » en rouge ; chaque
  délégation est refusée ; le seul « Reprendre » est dans la barre d'outils, pas dans
  la bande. On croit l'outil cassé.
- **Correctif** : offrir « Reprendre » dans la bande ; ou afficher
  « Arrêté (observation) » quand aucun lancement n'est en cours et que le mode est
  Arrêt, plutôt que « Bloqué ».

### F4 — P2 — 50 recommandations inapplicables en mode Arrêt

- **Preuve** : `supervisionBuildRecommendations` ne consulte ni `mode` ni `stoppedAt`
  (`super-orchestrator.js:673-788`). Reconstruit avec le ledger réel et l'état réel :
  **50 recommandations `delegate`** (`task_ready_and_unassigned`) alors que
  `workspace.status = blocked / stopped_by_operator` et `mode = off`.
- **Impact** : la bande annonce « Recommandations (50) » et « Recommander :
  Disponible » dans un état où rien ne peut être appliqué. Bruit + fausse action.
- **Correctif** : zéro recommandation en Arrêt/arrêté, ou une seule ligne explicite
  « Mode Arrêt : aucune action possible sans passer en Supervisé/Autonome ».

### F5 — P2 — Deux définitions de « orchestrateur de projet »

- **Preuve** : côté hôte, un orchestrateur de projet doit avoir un **rôle déclaré**
  (`super-orchestrator.js:468-486`, `roleOf` ne lit que `node.role`, alimenté par les
  noms de coéquipiers, `projection.js:814`). Côté panneau, `findProjectOrchestrator`
  accepte aussi un rôle **déduit du texte** (`src/board/hierarchy.js`, via
  `resolveNodeRoles` + `dabResolveRoleForNode`), marqué « déduit » dans l'infobulle.
- **Impact** : la bande peut afficher « 3 orchestrateurs » (déduits) alors que
  `supervision.projects[].orchestrator` vaut `null` pour tous les projets ; un
  consommateur de l'API et l'opérateur ne voient pas la même chose. La doc dit
  « declared only » (`MASCOTS-SUPER-ORCHESTRATOR.md:166-167`).
- **Correctif** : une seule règle (probablement « déclaré ou déduit, avec
  `source` exposé »), et l'exposer aussi dans la charge utile de l'hôte.

### F6 — P2 — Deux plafonds de concurrence affichés

- **Preuve** : la bande affiche les limites de **supervision**
  (`maxConcurrentDelegations: 2`, `model.js:104`) alors que le dispatch réel est borné
  par `policy.maxConcurrent` (**1** dans l'état réel, `model.js:116`), ce que confirme
  `lastTick` (`concurrency_limit` sur 31 tâches, 40 tâches écartées au total).
- **Impact** : « 2 simultanées » affiché, 1 seule réellement lancée.
- **Correctif** : afficher le plafond effectif (le plus contraignant) ou nommer les
  deux.

### F7 — P2 — Le Task Board 0.12.0 ne fournit ni contrat d'exécution ni endpoints de coordination

- **Preuve** : `GET /dsh-taskboard/contract` → **404** ; les endpoints de
  réaffectation/priorité/Kanban listés dans
  `src/connectors/taskboard-coordination.js:60-96` sont `proposed` et jamais appelés.
- **Impact** : « Réaffecter » et « Prioriser » resteront des propositions tant que le
  Task Board ne les expose pas ; le backend `contract` reste refusé. Ce n'est pas un
  défaut de l'Agent Board, mais c'est la limite dure du « super orchestrateur ».
- **Correctif** : côté `dsh-taskboard` (contrat + endpoints idempotents/fencés), puis
  re-négociation. En attendant, l'afficher comme dépendance, pas comme option.

### F8 — P2 — Aucun réglage UI du mandat, du budget ni des permissions du layer

- **Preuve** : le client n'a que mode / stop / resume / approval ; la politique
  s'écrit par `POST /policy` (pas d'UI) et vit dans `state.json`.
- **Impact** : impossible de préparer un périmètre, une concurrence, un budget ou une
  permission avant de passer en Autonome. C'est précisément ce qui manque pour rendre
  F1 acceptable.
- **Correctif** : un panneau « Politique » minimal (workspaces autorisés, concurrence,
  tâches/heure, permission max) avec validation et affichage du périmètre effectif.

### F9 — P3 — La bande repliée cache l'essentiel ; les listes sont plafonnées sans « +N »

- **Preuve** : `supervisionOpen: false` par défaut (`src/client/app.js:46`) ; la bande
  repliée ne montre que statut, mode, compteurs. Le corps tronque à 20 lignes
  (`src/client/ui/hierarchy.js:100,110,118`) alors que le titre affiche le total
  (50), et `taskboard.truncated` (200/360 tâches) n'est jamais rendu.
- **Impact** : première impression « bandeau vide / bloqué », et compteurs qui
  surpromettent la liste réellement visible.
- **Correctif** : afficher « N propositions · N blocages » dans la bande repliée et un
  « +N autres » quand la liste est tronquée ; signaler la troncature du ledger.

### F10 — P3 — Documentation légèrement périmée

- `docs/TEST-REPORT.md` : 448 tests annoncés, **451** réels.
- `docs/LIMITATIONS.md` et `docs/MASCOTS-SUPER-ORCHESTRATOR.md` : Task Board « 0.11.0 »,
  installé **0.12.0** (le contrat reste absent, donc la substance est juste).
- La doc dit « orchestrateurs de projet déclarés uniquement » alors que le panneau
  déduit (F5).

### Ce qui n'est pas un défaut

- L'absence d'agent « super orchestrateur » est **assumée et documentée**
  (`LIMITATIONS.md` #21) : c'est une couche, sans modèle ni session.
- L'absence d'écriture Task Board est un **choix de séparation** (`done` humain,
  ledger propriétaire), pas un oubli.
- Le Stop persistant est **voulu** (il survit au redémarrage) ; c'est son **rendu**
  qui pose problème (F3).

## 5. Ce qui marche bien (à ne pas jeter)

- **451/451 tests**, aucune exclusion ; modules purs, bornés, sans dépendance ajoutée.
- **Lecture réelle du ledger** : 381 tâches, 360 non supprimées, 702 arêtes, en
  lecture seule, sans écriture.
- **Lancement réel prouvé** : une session DSH créée en 1 s, Stop propre, audit
  `stop_all` avec `cancelled:true`.
- **Honnêteté des refus** : chaque capacité indisponible porte une raison réelle
  (`taskboard_write_api_unavailable`, `no_inbound_orchestrator_report_channel`, …).
- **Aucune invention** : pas de pourcentage, pas de statut fabriqué, pas d'agent
  fabriqué, pas de rôle déduit présenté comme déclaré (marqué « déduit »).
- **Bande rendue correctement** : mascotte couronne, statut réel, compteurs, matrice
  de capacités avec raisons en français.

## 6. Pour le rendre utilisable — plan proposé

### P0 — ce qui change l'expérience

1. **Périmètre explicite** (F1) : `allowedWorkspaces` = projets choisis, vide = refus ;
   sélecteur dans la bande ou la politique ; ligne « Périmètre : N projets ».
2. **Prévisualisation avant Autonome** (F1/F8) : un bouton « Simuler » qui affiche les
   N tâches éligibles, leur projet, l'ordre de choix et la permission, sans lancer.
   Réutilise `selectDispatchable` en lecture.
3. **Vérité des capacités** (F2) : `delegate` dérivé de l'état réel, avec la raison
   `mode_off` / `stopped_by_operator` / `empty_mandate` affichée dans la matrice.
4. **Stop lisible** (F3) : « Reprendre » dans la bande, et un statut
   « Arrêté (observation) » quand rien n'est en vol.

### P1 — cohérence

5. Recommandations uniquement hors Arrêt/Stop, ou marquées « non applicables » (F4).
6. Une seule définition de l'orchestrateur de projet, `source` exposé (F5).
7. Un seul plafond de concurrence affiché, ou les deux nommés (F6).
8. Panneau Politique minimal (F8).

### P2 — dépendances et finitions

9. Côté `dsh-taskboard` : contrat d'exécution + endpoints de coordination (F7).
10. Rafraîchir la doc (F10) et ajouter les compteurs « +N » (F9).

## 7. Décisions produit à trancher

1. La couche est-elle **globale** (tous projets, comme aujourd'hui) ou **par projet
   sélectionné** ? Le nom « super orchestrateur » suggère global ; l'usage réel
   suggère « les projets que je regarde ».
2. Un « super orchestrateur » doit-il être un **agent** un jour, ou rester une couche ?
   Si un agent est attendu, il faut un moyen de déclarer un rôle (aujourd'hui : nommer
   un coéquipier `super-orchestrator`, ce qui n'est pas une fonctionnalité).
3. Accepte-t-on qu'en Autonome le board lance dans un projet **sans tâche dans le
   panneau courant** ? Si non, le périmètre par défaut doit changer.

## 8. Méthode, commandes et limites

Commandes exécutées :

```powershell
node --test tests/                                  # 451/451, 0 fail
Invoke-WebRequest http://127.0.0.1:56117/dsh-taskboard/state   # 200, 381 tâches
node -e "…"                                          # reconstruction buildSupervision
git status --short ; git log --oneline -1            # arbre propre, HEAD 5e69e24
```

Reconstruction de la charge utile (projection vide, faits Task Board et état réels) :

```text
workspace.status = blocked, reason = stopped_by_operator, mode = off
capabilities.delegate = "gated"            ← alors que tout lancement est refusé
recommendations = 50 × delegate            ← en mode Arrêt
blocks = 0, crossProjectDependencies = 0
taskboard.available = true, 360 tâches, tronqué à 200 dans la charge utile
```

Limites de cette revue :

- **Pas de vérification visuelle live** : la GUI répond 401 et le jeton de lancement
  n'a pas pu être récupéré dans cette session. Le rendu de la bande est vérifié sur la
  capture E2E du dépôt (`docs/e2e/screenshots/cockpit-1366-superbar-open.png`) et par
  lecture du code.
- La charge utile reconstruite utilise une projection vide : les compteurs d'agents y
  sont à 0 ; les faits Task Board, l'état du host et les capacités sont, eux, réels.
- Pas de test de charge, pas de test multi-hôte, pas de test avec un vrai fournisseur
  en panne.
- Aucun code modifié par cette revue.

## 9. Carte des preuves

| Sujet | Fichier:ligne |
|---|---|
| Statut de la couche (bloqué si Stop) | `src/supervisor/super-orchestrator.js:402-415` |
| Matrice de capacités | `src/supervisor/super-orchestrator.js:791-818` |
| Recommandations (ignorent mode/stop) | `src/supervisor/super-orchestrator.js:673-788` |
| Orchestrateur de projet (déclaré) | `src/supervisor/super-orchestrator.js:468-486` |
| Rôle déclaré = nom de coéquipier | `src/supervisor/projection.js:814` |
| Mandat vide = tous les workspaces | `src/orchestrator/dag.js:85-92` |
| Ordre de choix des tâches | `src/orchestrator/dag.js:66-74` |
| Refus si Stop / mode Arrêt | `src/host/index.js:979-990`, `delegation.js:151` |
| Propositions dormantes en Arrêt | `src/host/index.js:2364-2372` |
| Défaut bande repliée | `src/client/app.js:46` |
| Corps de bande, coupes à 20 | `src/client/ui/hierarchy.js:100,110,118,152-188` |
| Bande compacte (mode « Observation ») | `src/client/ui/superbar.js:35,43-101` |
| Deux plafonds de concurrence | `src/contracts/model.js:104,116` |
| Lecture Task Board | `src/connectors/taskboard.js:228-243` |
| Endpoints de coordination proposés | `src/connectors/taskboard-coordination.js:60-96` |
