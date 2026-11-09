# GOAL 2 — Matrice d'audit fonctionnel et écarts priorisés

Base de vérité : dépôt `D:\App\DSH-agent-board`, branche `fix/agent-board-runtime-e2e`,
base `75b40d8d50c867a2b179c9e1a95f59e276f69789` (commit UX validé du GOAL 1).
Audits détaillés et sourcés : [`docs/audit/A-status-sessions.md`](audit/A-status-sessions.md),
[`B-orchestration.md`](audit/B-orchestration.md), [`C-failover-integrations.md`](audit/C-failover-integrations.md),
[`D-tests-coverage.md`](audit/D-tests-coverage.md). Toutes les preuves `fichier:ligne` y sont.

## Versions et environnement vérifiés

| Élément | Valeur | Preuve |
|---|---|---|
| DSH | `0.2.2-rc.1` | `runtime/cli/bin/dsh.cmd --version` ; `package.json` `dsh.compatibility` |
| `dsh-agent-board` | `0.1.0`, `link:D:/App/DSH-agent-board` | `~/.dsh/profiles/desktop/package.json`, `node_modules/dsh-agent-board` |
| `dsh-taskboard` | **`0.10.2`**, `link:.../default-workspace/dsh-taskboard` | `package.json` du fork + lien profil |
| `dsh-llm-fallbacks` | **NON INSTALLÉ** | absent de `plugin_manager list_plugins` et de `profiles/desktop/node_modules` |
| Node | `v26.13.0` (plugin exige `>=22`) | `node --version` |
| Tests de départ | **69/69**, puis **148/148** après corrections | `node --test tests/` |
| Worktree de départ | propre, aucun changement non commité | `git status --porcelain` vide |

## Matrice : implémenté / partiel / absent / non testable

| Domaine | Verdict | Preuves (HEAD 75b40d8) | Écart principal |
|---|---|---|---|
| Session monitoring (snapshot natif) | implémenté | `src/client/core.js:93-116` (`sessions.list` store réel : `ids/byId/phase/projectionsBySession`, vérifié dans `dsh-api-session-controller/lib/client.js`) | aucun abonnement `workspaces.list` (P2) |
| Statut d'attente (jaune) | implémenté | `uiSession.sessionStatus.pendingInteraction` (`dsh-client-ui-session/lib/client.js:783`), `src/supervisor/projection.js:127-137` | priorité jaune coupée par `treeLimit` (corrigé) |
| Statut d'exécution (vert/neutre) | partiel | `projection.js:93-112`, ack `src/host/index.js` `/ack` | flux SSE nommé jamais reçu (corrigé), `completionUnread` non acquittable (corrigé) |
| Persistance des consultations | partiel | `journal.js:66-75`, `state.json` vivant | `acks` non persistés sur l'instance live (écrivains concurrents) + éviction des `turnEnd` (corrigés) |
| Navigation carte → session réelle | implémenté | `src/client/app.js:141-147` (`uiWorkspace.openSession(id)`) | non exercé en E2E isolé (NON TESTÉ) |
| Parenté / sous-agents / orphelins | implémenté | `projection.js:296-318, 385-411` ; tests `board-view.test.js:65-102` | conflit de deux catalogues tranché silencieusement (P2) |
| Dernier message au clic | partiel | `projection.js:184-206` | segment intermédiaire/échoué promu « final » (corrigé) |
| Orchestrateur OFF / Supervisé / Autonome | partiel | `src/host/index.js` `authorizeLaunch`, `src/orchestrator/dag.js:111-185` | OFF n'arrêtait ni l'approbation, ni `/dispatch`, ni le failover (corrigé) |
| Arrêter les exécutions | partiel | `src/host/index.js` `stopExecutions` | course lancement/stop, échec de cancel confondu (corrigés) |
| Approbation supervisée | implémenté | `POST /proposals/:id/decide` | TTL/révision/mode non vérifiés à la décision (corrigés) |
| Mandat (workspaces, providers, permissions) | partiel | `dag.js:85-93`, `router.js:30-38` | non appliqué au lancement initial ni à la permission (corrigé) |
| Concurrence / budget | partiel | `dag.js:76-78,133-136` | ticks réentrants, slots fantômes, budget ambigu (corrigés partiellement) |
| Leases + fencing | **décoratif** | `lease.js:38-61` jamais appelés | jeton toujours 1, aucune expiration (watchdog ajouté ; fencing reste non bloquant) |
| Scheduler mono-écrivain | **absent** | `setInterval` sans verrou | mutex de tick + verrou d'instance ajoutés |
| Durabilité de la file / audit | partiel | `journal.js:66-87` | file empoisonnée après un échec, tmp orphelins (corrigés) |
| Task Board : source de vérité | respectée (lecture seule) | `connectors/taskboard.js` (`list/get/run`) | contrat réel mal lu (`revision` vs `version`, `claim` vs `claimedBy`, `executions`) → corrigé |
| Déduplication task ↔ exécution | implémenté | `dag.js` (executions/claim/scheduler), `taskboard.js` `activeExecution` | plus de double exécution possible |
| Isolation worktree | partiel (opt-in) | `policy.executionBackend='taskboard'` → `POST /tasks/:id/run` | en backend `board` la carte worktree est refusée ; en backend `taskboard` le Task Board crée le worktree |
| Liens durables task ↔ session ↔ exécution | partiel | `assignment.executionId` + `backend`, `POST /tasks/:id/run` | disponible en backend `taskboard` uniquement ; le backend `board` n'a toujours pas d'exécution Task Board (nécessaire au failover de modèle) |
| Scheduling (cron Task Board) | absent côté board | `task.execution.mode='scheduled'` | délégué au Task Board : refus explicite `owned_by_taskboard_scheduler` |
| Failover : classifieur | partiel | `routing/classify.js` | 429 sans chiffre, transport en message, 404 modèle, 403 auth (corrigés) |
| Failover : chaîne/cooldown/allow-list | partiel | `routing/router.js:50-137` | non appliqué au lancement initial (corrigé) ; `maxSwitches` non cumulé (corrigé) |
| Failover : reprise de tâche | partiel | `recovery/checkpoint.js`, `host/index.js` handoff | `recovering` absent de l'UI (ajouté), checkpoint sans carte/effets (complété) |
| Effets externes non idempotents | **absent** | `actions: []` en dur | capture des tool calls mutateurs → `effect:unknown`, vérification imposée |
| Retour au provider principal | absent | `router.js:154-159` jamais appelé | P1 ouvert |
| Providers / `dsh-llm-fallbacks` | non évaluable | plugin absent | API publique non inventoriée ; ne pas recopier ses internals |
| Forges (GitHub) | contrat testé sur fausse API | `connectors/github.js` lecture seule + pagination bornée + rate limit | aucun appel live ni token exercé ; `validatedLive:false` honnête |
| GitLab/Forgejo/Gitea/Bitbucket/Jira/Linear | squelettes | `connectors/registry.js` | `list/get` annoncés `true` dans la matrice de capacités (corrigé : capacités déclarées seulement) |
| Webhooks / signature | absent | aucune route | hors périmètre de cette livraison |
| CI / Git / worktrees | absent côté board | `gatherGit` lecture seule | aucun push/PR, aucune création de worktree |
| Secrets | non exposés | aucune lecture de credential dans `src/` | `GITHUB_TOKEN` lu par l'adaptateur GitHub (variable d'env, non journalisée) |
| Tests unitaires / intégration | solides | 69 → **112** | voir matrice A–E dans `docs/audit/D-tests-coverage.md` |
| E2E instance isolée | partiel | `docs/e2e/isolated-instance-evidence.md` | activation plugin, contrat Task Board réel, lancement réel, garde de reprise, verrou, SSE et relance bornée **vérifiés live** ; aucun tour de modèle réussi (pas de credentials dans un `DSH_HOME` neuf) |
| Charge 30 agents / 200 sessions | non testable ici | test de perf synthétique `projection` < 30 ms | pas d'instance réelle chargée |
| Windows 11 | vérifié | tests + runtime local | Linux : NON TESTÉ |
| Désinstallation | non testée | `plugin_manager remove_bundle` non exécuté | pas de profil isolé créé |

## Écarts P0 — état dans cette livraison

| # | Écart | État |
|---|---|---|
| P0-1 | Flux SSE nommé (`event: state`) jamais reçu par `onmessage` → statut live mort | **corrigé** + test protocole |
| P0-2 | Échec connu du natif marqué « vu » → carte retirée de l'accueil, raison invisible | **corrigé** |
| P0-3 | Aperçu d'un tour échoué/intermédiaire certifié « réponse finale » | **corrigé** |
| P0-4 | Pilule verte non garantie (éviction des `turnEnd`, ack sans effet sur `completionUnread`) | **corrigé** |
| P0-5 | Approbation et `/dispatch` lançaient hors mode OFF / après Stop | **corrigé** |
| P0-6 | Stop ne barrait pas un lancement en vol ; échec de cancel présenté comme arrêt propre | **corrigé** |
| P0-7 | OFF/Stop n'arrêtaient pas le moteur de failover (nouvelles sessions) | **corrigé** |
| P0-8 | Contrat Task Board mal lu (`revision`, `claim`) → clé d'idempotence figée, exécutions invisibles | **corrigé** + tests contrat |
| P0-9 | Aucun mono-écrivain : plusieurs hôtes clobber `state.json` (acks/mode perdus, ticks dupliqués) | **corrigé** (verrou d'instance + ticks coalescés) |
| P0-10 | Aucun lien d'exécution Task Board (`taskboard_execution_report` échoue) | **corrigé en opt-in** : `executionBackend:'taskboard'` délègue au `POST /tasks/:id/run` (exécution/worktree/claim réels) ; le backend `board` reste requis pour le failover de modèle |
| P0-11 | Effets externes non idempotents rejouables après handoff | **partiellement corrigé** (tool calls capturés, effet `unknown`, vérification imposée ; pas de réconciliation externe) |

## Écarts P1 — ouverts après cette livraison

- **Tour de modèle réussi** dans l'instance isolée : impossible sans credentials
  (aucune copie de secret faite) ; le parcours complet tâche → session → rapport
  → `in_review` reste prouvé uniquement par l'E2E live du GOAL 1 (build
  précédent). Les gardes, le lancement réel, la reprise et l'arrêt le sont en live.
- Retour au provider principal au checkpoint sûr (`shouldReturnToPrimary` non branché).
- `fencingToken` non vérifié à l'écriture (le watchdog de bail et le verrou d'instance couvrent le cas multi-hôte, pas la reprise concurrente intra-hôte).
- Backend `taskboard` non exercé contre un exécuteur Task Board live (test contrat sur fausse API).
- Forge réelle (GitHub/GitLab) : contrat + pagination + rate-limit testés sur **fausse API**, aucun appel live.
- Webhooks signés, conflits de mise à jour externe, suppression/édition de dépendances côté forge.
- Test de charge 30 agents / 200 sessions, Linux, désinstallation réversible.
- `taskboard` : `presetId`, `branch`, `checklist` non exploités par le board.

## Écarts P2 — assumés

- `workspaces.list` non abonné (renommage/déplacement d'espace non rafraîchi).
- `acks`/`previews` non bornés côté taille du document.
- Deux catalogues revendiquant le même enfant : le second perd silencieusement la filiation.
- `acks.lastTurnEnd` écrit mais jamais lu.
- Budget horaire : `0` = illimité, pas de budget quotidien/coût.
