# Permissions par niveau — correction du 14 novembre 2026

## Exigence utilisateur (fait autorité)

« Les permissions doivent être autorisé en fonction du niveau ! Puis personnalisable ensuite ! Et il y a encore des actions non prise en charge il faut corriger ça ! »

Cette demande remplace le comportement précédent « le niveau ne change jamais les permissions ». Elle ne supprime ni le périmètre, ni les plafonds des projets, ni les budgets, ni les permissions d’exécution des workers, ni la confirmation humaine de `done`.

## Cause vérifiée

La configuration persistée contenait `mandate.level=L4`, `policy.mode=autonomous`, les 13 booléens d’action à `false` et `actionModes={}`. Ce n’était donc pas une question de redémarrage : la sélection du niveau conservait intégralement ces refus.

## Profil appliqué lors d’une sélection explicite

| Niveau | Actions non critiques | Actions critiques |
|---|---|---|
| L0 | Interdit | Interdit |
| L1 | Interdit (analyse/propositions seules) | Interdit |
| L2 | Demander avant chaque exécution | Interdit |
| L3 | Automatique jusqu’au seuil L3 ; demander au-dessus | Interdit |
| L4 | Automatique | Demander avant chaque exécution |

Les actions critiques sont `merge`, `protected_branch_write`, `delete_task`, `secrets`, `policy_change`. À L3, `delegate` et `open_pr` sont proposés avec approbation. Le moteur déterministe reste l’autorité pour les seuils effectifs et les plafonds de projet.

`applyMandatePatch` applique le profil lorsque le patch porte explicitement `level`, y compris une réapplication du même niveau. Les personnalisations présentes dans le même patch sont appliquées ensuite. Une modification ultérieure d’une permission ne touche aucune autre action ; les personnalisations survivent aux lectures, aux redémarrages et aux modifications sans niveau.

Aucune migration silencieuse n’est faite au chargement : pour une ancienne configuration L4 refusant tout, le bouton « Réappliquer les permissions de ce niveau » applique explicitement les nouveaux défauts sans changer le périmètre ni redémarrer du travail en pause.

## Vérification du premier lot

- 647/647 tests passent, dont 8 tests de profil, un parcours de route hôte et un test du bouton de réapplication.
- Bundle client reconstruit ; syntaxe et smoke host OK.
- Pas de navigateur pilotable : vérification visuelle non effectuée. Revue UX effectuée directement (sélection, remise aux défauts, personnalisation, désactivation pendant une requête, avertissement sur la réinitialisation).

## En cours : actions manquantes

Le premier lot ne prétend PAS rendre exécutables les 9 actions précédemment non implémentées. Les anciennes qualifications « jamais par conception » ne constituent pas une réponse à cette nouvelle demande utilisateur.

### Lot 2 — délégation et PR raccordées

- `delegate` utilise la tâche canonique du Task Board, le même lancement sécurisé et le même journal de délégation que les workers existants. Les permissions `delegate` ET `launch` sont requises ; périmètre, état prêt, doublons, quotas et confinement restent applicables. Une révocation pendant la création supprime la session sans lui envoyer de travail. Il s’agit de déléguer une carte à un worker, pas de fabriquer une arborescence native de sous-agents distincte.
- `open_pr` atteint réellement `openPullRequest` de l’adaptateur GitHub, en automatique ou depuis une approbation exacte. Le dépôt configuré doit correspondre au `remote origin` Git du projet autorisé ; l’appel est refusé si cette correspondance n’est pas vérifiable. Le dépôt est inclus dans le payload haché de l’intention et affiché dans la demande humaine : une configuration modifiée après redémarrage ne redirige pas un accord vers un autre dépôt.
- La recherche de PR existante et les marqueurs d’idempotence évitent les doubles créations. Le contrôle est répété immédiatement avant le POST après la lecture GitHub : Stop/révocation pendant cette lecture interdit l’écriture.
- Les payloads ont une liste blanche partagée pour l’exécution automatique et les octets stockés. Aucune commande, permission worker ou sélection de jeton ne peut être transmise par le modèle.
- Une répétition de demande d’approbation retourne désormais le même type `{ok:true,decision}` qu’une création (ancien défaut : retour direct de la décision, produisant une raison de refus indéfinie).
- Preuves : suite complète 653/653 après raccordement ; après ajout du contrôle pré-POST et du test Stop pendant lecture GitHub, 37/37 tests ciblés passent. Bundle reconstruit ; syntaxe, smoke et diff-check verts. Aucune création réelle de PR ni lancement live n’est revendiqué (transports et contexte de test contrôlés).

### Lot 3 — suppression native et politique de projet raccordées

- `delete_task` requiert toujours une approbation exacte L4 (action, projet, tâche, version, raison, révision du mandat). L’exécution passe par `ctx.tools.execute` et le véritable outil `taskboard_delete`, avec une session technique éphémère en lecture seule, dans le répertoire canonique du projet, sans invite ni appel modèle. Une garde ne permet que l’appel précis et ses arguments approuvés ; tout autre outil ou retargeting est refusé. La session est supprimée après règlement de l’appel ; un échec de nettoyage est signalé avec l’effet déjà survenu, jamais caché par un succès.
- Aucun appel à une route GUI avec identité `user`, aucune écriture directe du ledger, aucun appel direct à `ToolDefinition.execute` contournant le pipeline natif. Les vérifications de version, de claim, d’exécution active, de hiérarchie et de dépendances restent sous la responsabilité du Task Board natif. Si une suppression affaiblit une dépendance, la réponse reste `pendingApproval` : l’interface indique que la tâche **n’est pas supprimée** et qu’une validation dans Task Board est encore nécessaire.
- La présence de l’outil natif et du pipeline est vérifiée ; un preset/plugin qui ne l’expose pas donne `native_tool_unavailable` au lieu d’un faux succès.
- `policy_change` modifie réellement la priorité (0–9) et/ou le budget de lancements par heure (0–100) **du projet autorisé**, après accord humain exact. L’interface le nomme « Modifier la politique du projet ». Le périmètre, les niveaux, les droits d’action, la configuration globale, les permissions et modèles workers et les autres projets restent inchangés. Un accord sur ce projet n’autorise pas une auto-extension de mandat ni une modification globale.
- Contrat DSH observé : `tools.execute(ToolBatchInput)` avec un Agent réel, résultat `results[].{callId,result}`, `tools.guard`, `tools.executable`, permission preset avant publication. Contrat du propriétaire Task Board lu dans ses sources installées : l’API publique v1 ne propose pas de suppression ni d’édition de configuration d’exécution ; l’outil natif est donc utilisé plutôt qu’une route inventée.
- Preuves : **664/664 tests**, bundle 24 modules reconstruit, syntaxe/smoke/diff-check verts. 6 tests de la passerelle native couvrent actor/preset, absence de l’outil, retargeting hostile, révocation, dépendance différée et échec de nettoyage ; les tests hôte couvrent approbation exacte à usage unique et isolation de la politique de projet. Aucun effet live de suppression n’a été effectué.
- Revue UX effectuée directement faute de sous-agent/navigateur pilotable : raison d’indisponibilité explicite, validation des dépendances distinguée d’une suppression réussie, portée du réglage de politique nommée. Vérification visuelle live non effectuée.

### Lot 4 — fusion native de PR raccordée

- `merge` est exécuté par le service forge natif de DSH (`ctx.forge.merge`), jamais par un jeton GitHub stocké à part. Aucune fusion « admin » ni contournement de protection de branche.
- La cible réelle est lue AVANT l’accord humain : dépôt résolu depuis le `remote origin` du projet, numéro de PR, `headSha`, branche de base et `baseSha`, méthode de fusion. Ces valeurs entrent dans le payload haché de l’intention, donc un changement de head, de base ou de dépôt après l’accord donne `forge_stale_change_request` / `forge_project_mismatch` et rien n’est fusionné.
- Une fusion n’est jamais consentie par le seul niveau : même avec `merge=auto` à L4, une approbation humaine exacte reste requise. La demande affiche le dépôt et la PR.
- Les préconditions sont vérifiées contre l’instantané natif : PR ouverte et non brouillon, `mergeReady`, mergeability `mergeable`, checks non en échec et non tronqués, revues non tronquées, zéro fil de discussion non résolu et pas de « changes requested ». Un état incomplet refuse par `forge_merge_not_ready` / `forge_snapshot_incomplete`.
- Un échec de fusion inconnu reste explicite (`forge_merge_unknown`) ; le message amont n’est jamais relayé. `merge` ne déplace aucune carte Task Board vers `done`.
- Preuves : 6 tests de la passerelle native forge (cible/approbation, head/base/dépôt modifiés, états non fusionnables, révocation après lecture, absence du service) et 2 tests hôte (consentement exact obligatoire en `auto`, head modifié refusé). Suite ciblée 62/62 verte, syntaxe OK. Aucune fusion live n’est revendiquée : service et instantané contrôlés par les tests.

### Lot 5 — planification native et profils honnêtes

- `schedule` crée réellement une carte planifiée dans le projet autorisé, via l’outil natif `taskboard_create` (`execution: { mode: 'scheduled', cron | runAt }`). Le payload exige un titre, un `urgency` normalisé, et **exactement** un déclencheur : une expression cron à 5 champs, ou un `runAt` futur (ISO ou epoch ; une date passée est refusée, jamais recalée). Un champ de propriétaire (`execution`, `permission`, `model`, `status`…) est refusé et nommé.
- Les outils natifs sont désormais appelés par un exécuteur commun : session technique éphémère en lecture seule dans le répertoire canonique, aucune invite ni appel modèle, garde épinglant agent + `callId` + nom d’outil + arguments canoniques, disposition vérifiée. `taskboard_create` et `taskboard_delete` partagent ce chemin ; un échec de nettoyage est signalé avec l’effet déjà appliqué.
- Les profils de niveau ne annoncent plus une automatisation impossible : `push_branch`, `protected_branch_write` et `secrets` sont déclarées `HUMAN_ONLY_ACTIONS` dans le contrat de mandat et reçoivent `deny` à tous les niveaux, avec la raison « réservée à vous ». Avant, le profil L4 les affichait `auto`/`ask` alors que le cerveau ne peut pas les exécuter — une contradiction visible. `merge` reste critique mais exécutable (accord exact), `delete_task`/`policy_change` restent critiques et exécutables.
- Preuves : suite complète **675/675** verte après reconstruction du bundle, `node --check`, smoke host et `git diff --check` propres. Tests ajoutés : payloads `schedule` (déclencheur unique, cron, date passée, champs propriétaires), création native exacte, exécution automatique L4 et approbation exacte à usage unique côté hôte, et cohérence des profils (actions humaines en `deny`).

Restent `push_branch`, `protected_branch_write`, `secrets` : elles sont désormais explicitement réservées à l’opérateur, et le niveau ne les promet plus. Aucune n’est revendiquée comme validée live.

### Lot 6 — GitHub : jeton découvert et dépôt par projet

Symptôme rapporté : « Ouvrir une PR — Interdit — GitHub non configuré » alors que GitHub est utilisé sur la machine (gh/git authentifiés).

- **Le dépôt n’est plus une configuration globale obligatoire.** Chaque projet utilise son propre `remote origin` Git, résolu au moment de l’action ; `githubRepository` devient une épingle optionnelle (si elle est définie, un remote différent est refusé par `forge_project_mismatch`). Le dépôt résolu entre dans le payload haché de l’accord : un changement de remote après l’accord ne redirige pas l’écriture.
- **Le jeton est découvert, pas exigé en variable d’environnement.** Ordre : `githubToken` explicite (config) → `GITHUB_TOKEN` → `gh auth token` (CLI locale déjà authentifiée). Politique réglable par `githubTokenDiscovery` : `auto` (défaut), `env` (variable seulement), `off` (config explicite seulement). Le jeton n’est jamais publié, journalisé ni renvoyé ; il n’est envoyé qu’à `api.github.com`.
- La capacité `open_pr` ne dépend donc plus du dépôt configuré : elle est disponible dès qu’un jeton utilisable existe, et le refus, s’il persiste, devient actionnable : `github_token_missing` — « jeton GitHub introuvable : connectez gh (gh auth login) ou définissez GITHUB_TOKEN ».
- Un adaptateur forge est mis en cache par dépôt (borné) pour conserver l’idempotence en mémoire entre deux tentatives rapprochées, l’API de liste GitHub étant éventuellement cohérente.
- Preuves : suite complète **676/676** verte après reconstruction du bundle ; nouveau test : `open_pr` fonctionne avec le seul remote du projet, sans `githubRepository` configuré ; les attentes de capacité sans jeton passent à `github_token_missing`. Syntaxe, smoke host et `git diff --check` propres. Aucune création réelle de PR n’est revendiquée.

### Lot 7 — autonomie maximale sans Task Board + tri du backlog

Deux blocages critiques restaient après le lot 6.

**A. Le Super Agent ne faisait rien sans Task Board.** Le cycle lisait exclusivement les cartes (`connectors.get('dsh-taskboard').list()`), donc un opérateur sans ce plugin voyait un agent `idle` avec `noop` et aucune action possible, alors que le projet déclarait déjà son intention dans ses documents.

- Nouvelle source de travail **propre au plugin**, déterministe et bornée : ADR acceptés (`docs/adr`, `docs/decisions`, `adr`, `decisions`), listes `TODO`/`BACKLOG`/`ROADMAP` (`TODO.md`, `BACKLOG.md`, `ROADMAP.md`, `docs/…`), et issues ouvertes du `remote origin` GitHub quand un jeton est disponible. Lecture bornée (40 fichiers, 200 ko), cache 60 s (documents) / 5 min (issues), toute erreur de lecture = source vide, jamais une panne de cycle.
- Un item devient une **vraie session de travail** via la nouvelle action `launch_work { workItemId }` : id re-résolu par l’hôte (jamais celui du modèle), readiness revérifiée, droit `launch_work` **et** `launch`, budget/concurrence communs, session créée dans le répertoire du projet avec les directives de l’opérateur et la source exacte de l’item. La tâche synthétique force le backend `board` (le Task Board ne peut pas exécuter une carte inexistante) et n’est jamais `done`.
- L’assignation journalise `workSource { source, ref, fingerprint, origin }` : un item terminé n’est **jamais** redispatché, un item en échec est retenté après 1 h avec un plafond de 3 tentatives, et un changement réel du document (nouvelle empreinte) redevient dispatchable.
- Garde-fou de décision humaine, déterministe : ADR **Proposed/Draft** (ou statut inconnu), ligne marquée `[decision]`/`@human`/`besoin de décision`, issue assignée ou étiquetée `blocked`/`needs-decision`/`question` → `needsHumanDecision` et refus `needs_human_decision:<raison>`. Le prompt du worker lui interdit explicitement de deviner une décision.
- Le panneau expose `superagent.work` (items détectés prêts / en attente de décision) et le dry-run liste la même chose sans écrire.

**B. Une carte `backlog` ne pouvait jamais sortir du backlog**, y compris quand elle était débloquée et sans décision humaine.

- Nouvelle action `promote_task { reason }`, **minimum L4** (en dessous : approbation humaine à usage unique) et **jamais critique** : elle déplace **une** carte `backlog → todo` via l’outil natif de l’opérateur `taskboard_move` (`ifVersion`), avec les mêmes règles de propriété/dépendance que son outil. `done` reste inatteignable.
- Préconditions déterministes (`src/orchestrator/triage.js`), chacune avec son code : `task_blocked`, `task_waiting_for_human`, `needs_human_decision`, `claimed_by_another_session`, `already_running_in_taskboard`, `dependencies_unsatisfied:<ids>`, `task_not_backlog:<statut>`, `task_trashed`, `invalid_task`.
- Bornes : 3 promotions par cycle, cooldown de 6 h par carte journalisé durablement (`superagent.promotions`, normalisé et borné), audit `backlog_promoted` et commentaire sur la carte quand l’API publique le permet — l’humain voit qui a déplacé quoi et pourquoi.
- Profils : `promote_task` = `deny` sous L4, `ask` à L2/L3, `auto` à L4 ; `launch_work` = `deny` sous L2, `ask` à L2, `auto` à L3+. Les deux figurent dans la matrice de capacités (`native-taskboard`, `worker`) et dans l’onglet permissions du cockpit.

**Preuves.** Suite complète **690/690** verte (14 tests ajoutés : tri du backlog, parsing ADR/checklists/issues, readiness/retry, et un hôte réel sans Task Board qui ouvre exactement deux sessions pour deux items prêts, refuse l’ADR proposé, ne le relance pas deux fois, puis promeut une carte L4 via l’outil natif et refuse bloqué/attente/dépendance/L3). Bundle client reconstruit (24 modules), `git diff --check` propre. **Aucune validation live dans la GUI** : les modules hôte ne se chargent qu’au démarrage de DSH et l’API locale exige un jeton ; le comportement est prouvé par les tests hôte, pas par une observation du panneau.
