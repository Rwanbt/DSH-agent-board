# Corrections de l’audit permissions et autonomie

Date : 13 novembre 2026 (Europe/Paris). Référence : `9cd8d33` + ce lot, puis suite 2 (modèle worker, autotest, liste blanche des écritures). Suite complète : **637/637**.

Ce document décrit ce qui a été corrigé, et surtout ce qui **reste** non prouvé sur l’installation live. Les affirmations sont limitées aux tests locaux et aux contrats DSH inspectés.

## Constats de l’audit et état

| Constat | État | Preuve / limite |
|---|---|---|
| A01 — cocher une permission échoue avec `selected_scope_requires_workspaces` | **Corrigé** | Le client envoie un patch minimal `{actions:{…}}` ; le serveur fusionne. Régressions store/route sous `none`, `selected`, `all`. |
| A02 — une priorité remplace l’héritage par L0 | **Corrigé** | La route distingue champ absent / `null` explicite ; régression `route patches preserve priority and allow explicit level/model inheritance resets`. |
| A03 — pas de recours humain fiable | **Corrigé côté parcours** | Trois modes `deny`/`ask`/`auto`. Un refus `approval_required` crée une demande déterministe liée à l’opération exacte. L1 ne demande pas d’exécution. |
| A04 — permissions sans exécuteur | **Corrigé en honnêteté** | Matrice de capacités = exécuteurs réels du Super Agent ; `implemented:false` + `no_adapter_for_action`. Les actions restent visibles mais non exécutables. |
| A05 — tâche étrangère déclarée dans le projet autorisé | **Corrigé** | Le projet canonique de la tâche est vérifié pour launch/update/comment ; test A05. |
| A06 — cerveau sans confinement explicite | **Corrigé** | Session d’évaluation sans outil : restriction `allow:[]`, garde monotone, exécuteur qui rejette et vérifie un jeu résolu vide ; échec visible si un outil à portée propre apparaît. |
| A07 — permissions worker appliquées en optionnel | **Corrigé** | Permission explicite (défaut `read-only`), appliquée et vérifiée avant publication ; échec → aucun message de travail, session annulée, bail libéré. |
| A08 — approbations réutilisables / mal liées | **Corrigé** | Intention immuable (action, projet, tâche, version, hash du payload, révision du mandat), usage unique brûlé avant l’effet, lookup legacy exclut les intentions liées, déduplication indépendante de l’expiration. |
| A09 — 21e projet non configurable | **Corrigé** | Recherche + pagination conservant les contrôles individuels ; test sur le 21e projet. |
| A10 — reset niveau/modèle impossible | **Corrigé** (suite 2 pour le modèle) | `null` explicite réinitialise l’héritage ; le modèle worker se choisit par projet dans le catalogue réel, et un override hors catalogue reste affiché comme tel. |
| A11 — dry-run différent du vrai lancement | **Corrigé partiellement** | Le dry-run partage `preflightLaunch` (mandat, doublon, délégation) + backend. La réservation/écriture reste exclusive au lancement réel ; l’autotest profond prouve en plus la création et le confinement d’une session. |

## Sémantique retenue

- `deny` : jamais exécuté ; aucune demande.
- `ask` : exécution uniquement après accord humain lié à l’opération exacte.
- `auto` : exécuté automatiquement dans le mandat ; les actions critiques gardent L4 + accord.
- Le niveau plafonne l’automatisation : L2 peut demander une action non critique sous son seuil automatique ; L1 ne peut pas exécuter ; L0 observe.
- Les booléens historiques restent lus comme `deny`/`auto` (compatibilité). Les modes explicites sont conservés.

## Preuves exécutées

- `node --test tests/` : **637 tests, 637 passés** (dont 10 ajoutés par la suite 2).
- `node scripts/build-client.mjs` : bundle 24 modules cohérent avec ses modules.
- `node --check src/host/index.js`, `node --check src/client.js`.
- `node scripts/smoke-host.mjs` : OK.
- Nouveaux tests ciblés : `tests/approval-intents.test.js`, `tests/host-security.test.js`, `tests/mandate-tristate.test.js`, `tests/board-writes.test.js`, régressions A05–A08 et héritage dans `tests/goal6-superagent-host.test.js`, autotest et tri-état/pagination dans `tests/cockpit-superagent.test.js` et `tests/goal6-host-gate.test.js`.

## Risques et limites restants

1. **Aucune recette live authentifiée dans cette session.** L’API GUI sans jeton répond 401 et les modules hôte ne changent qu’au redémarrage du host DSH. Une procédure d’acceptation live est fournie ci-dessous ; elle n’a pas encore été exécutée contre l’instance réelle.
2. **Contrats DSH 0.2.2-rc.2.** Ils sont désormais **observables à l’exécution** via `/selftest` (présence réelle de `agents.create`, `tools.restrict/guard/setExecutor`, `permissionPresets.resolve/set/current`, résolution des trois presets). Sur une autre version, l’autotest le dit et le confinement reste fail-closed.
3. **Modèle worker : corrigé.** L’inspecteur permet de choisir, par projet, une route du catalogue réel (`/mandate/project` refuse un modèle absent ou une découverte indisponible).
4. **Actions sans exécuteur : clarifiées.** `merge`, `push_branch`, `protected_branch_write`, `secrets`, `policy_change`, `delete_task`, `schedule` sont **réservées à l’opérateur par conception** (`human_only_action`). `open_pr` et `delegate` restent sans exécuteur (`no_adapter_for_action`) : une case cochée ne les rend pas fonctionnelles.
5. **Le dry-run** partage le préflight ; l’autotest profond prouve la création et le confinement d’une session, pas un lancement Task Board complet ni ses écritures.
6. **Idempotence du vault : corrigée le 13 novembre.** La projection `projects/ravum-flow/BOARD.md` était en retard sur la carte `FLOW-INIT-20261109found` (une ligne de carte). Régénérée par l’outil du contrat (`vault.py board --project ravum-flow`), `vault.py check` est désormais vert sur lint/liens/idempotence/migrate/root-cleanup, et la note de session a été commitée puis poussée (vault `2f79e4d`).

## Suite 2 — limites restantes traitées (13 novembre 2026)

### 1. Champs propriétaires refusés sur toute écriture du cerveau

Un payload de modèle est déjà normalisé à l’ingestion, mais l’opération **stockée** est rejouée plus tard par un autre chemin. `src/contracts/board-writes.js` définit l’unique liste blanche (`title`, `description`, `urgency`, `prompt`, `blocked`, `waitingForHuman`, `waitingReason`, `body`) et la même barrière s’applique aux deux chemins :

- chemin automatique : un champ hors liste fait **refuser** la proposition (`payload_field_forbidden`, champs nommés) au lieu d’être silencieusement jeté ;
- chemin approuvé : les octets stockés sont re-validés avant l’effet, et un refus **ne consomme pas** l’accord humain.

Ainsi `permission`, `model`, `execution`, `isolation`, `status`, `ifVersion`, etc. ne peuvent pas voyager dans un `create_task`/`update_task`/`comment` : autoriser `update_task` n’autorise ni `danger-full-access`, ni un autre modèle, ni `done`.

### 2. Capacités : « pas encore » vs « jamais par le cerveau »

`HUMAN_ONLY_ACTIONS` distingue les décisions humaines par conception des adaptateurs simplement absents. L’interface affiche « réservée à vous : le Super Agent ne l’exécute jamais » au lieu de laisser croire à une fonctionnalité à venir, et la sélection reste désactivée.

### 3. Modèle worker par projet, depuis le catalogue réel

Le sélecteur de l’onglet Projets propose uniquement les routes découvertes par l’hôte ; un override devenu absent du catalogue reste **visible comme tel** au lieu d’afficher « hérité ». La route `/mandate/project` refuse `invalid_model`, `model_not_registered` et `model_discovery_unavailable`, tout en conservant la sémantique « champ absent = inchangé, `null` explicite = hérité ».

### 4. Autotest d’installation, visible dans l’interface

- `GET /selftest` : inventaire lecture seule des contrats réellement présents et de la résolution des presets ; ajouté aussi à `/diagnostics`.
- `POST /selftest` avec `{ deep: true, confirm: 'EPHEMERAL_SESSION' }` : crée **une** session worker réelle, sans invite ni appel modèle, applique `read-only` par le chemin de confinement de production, vérifie le preset appliqué, puis la **supprime** (`dispose()`), et refuse de déclarer un succès si la suppression n’a pas eu lieu.
- L’autotest est un diagnostic d’opérateur : il reste disponible en mode Observe et après Stop, ne crée aucun travail et n’entre pas dans le tableau des affectations.
- Réglages → **Vérifier l’installation** : bouton, case « session de test éphémère », résultat contrôle par contrôle avec la raison lisible en cas d’échec.

### Procédure d’acceptation live (à exécuter après redémarrage du host DSH)

1. Redémarrer le host DSH (les modules `src/host/**` ne sont chargés qu’au démarrage), puis recharger la page du tableau.
2. Inspecteur du Super Agent → Réglages → **Vérifier l’installation** : tous les contrôles doivent être verts, ou porter une raison explicite.
3. Cocher « session de test éphémère » et relancer : la ligne « Session de test créée, confinée puis supprimée » prouve le confinement contre l’instance réelle.
4. Simuler (dry-run) puis lancer une carte de test dans un projet sélectionné ; vérifier le passage en revue et l’absence de doublon.

Tant que ces quatre étapes n’ont pas été exécutées, aucune validation live ne doit être revendiquée.

### Outil d’inspection des contrats installés

`scripts/asar-read.mjs` lit l’`app.asar` de l’installation (sans le modifier) pour vérifier les contrats réels : `list <regex>`, `read <entrée>`, `grep <regex> [chemin]`. Il a servi à confirmer `CreateAgentOptions.setup` (commit optionnel après les awaits, publication ensuite) et `AgentHandle.dispose(): Promise<void>` — les deux fondations de l’autotest profond. Chemin surchargeable par `DSH_ASAR`.

## Suite 3 — hôte périmé et idempotence (13 novembre 2026)

### 1. Un host périmé est nommé, pas déguisé en erreur interne

Les modules hôte ne sont chargés qu’au démarrage de DSH : après une mise à jour du plugin, la page rechargée peut afficher la nouvelle interface alors que l’API répond encore avec l’ancien host. Un `GET /selftest` reçoit alors `404`, ce qui s’affichait comme « erreur interne » — un faux blocage. Le panneau affiche désormais « le host DSH en cours d’exécution précède cette fonction : redémarrez DSH, puis rechargez la page » (`host_outdated`, FR/EN), testé dans `tests/cockpit-superagent.test.js`.

### 2. Idempotence du vault réparée par l’outil du contrat

Le rouge `board-not-idempotent:projects/ravum-flow/BOARD.md` venait d’une projection générée en retard sur sa carte (le fichier carte de `FLOW-INIT-20261109found` avait été mis à jour sans régénérer). Le diff calculé sans écriture montrait une seule ligne de carte + l’horodatage. Régénération par `vault.py board --project ravum-flow` (2 fichiers, 6 insertions / 6 suppressions), puis `vault.py check` : lint, liens, idempotence, migrate, root-cleanup **tous verts**. Les fichiers sales d’autres chantiers ont été laissés hors commit.

### 3. État du host au moment du contrôle

PID 1264 (GUI) démarré le 13/11/2026 à 16:37:39 ; `src/host/index.js` modifié à 20:00:19 : le host en cours d’exécution n’a pas chargé la Suite 2. Le plugin du profil est un lien symbolique `C:\Users\barat\.dsh\profiles\desktop\node_modules\dsh-agent-board` → `D:\App\DSH-agent-board`, donc un redémarrage charge bien le nouveau code hôte, et le bundle client servi après rechargement est celui du dépôt (SHA-256 identiques). La recette live reste à exécuter par l’opérateur (redémarrage + 4 étapes ci-dessus).

## Fichiers principaux

- Contrat : `src/contracts/mandate.js` (modes tri-état, héritage), `src/contracts/board-writes.js` (liste blanche des écritures).
- Décisions : `src/superagent/decisions.js` (intentions, opérations, anti-rejeu).
- Hôte : `src/host/index.js` (patch routier, préflight, exécution approuvée, capacités, autotest).
- Confinement : `src/host/security.js`.
- Client : `src/client/core.js`, `src/client/app.js`, `src/client/ui/{inspector,styles,strings,hierarchy,superbar}.js`, bundle régénéré.
- Outil : `scripts/asar-read.mjs` (lecture seule des contrats de l’installation).
