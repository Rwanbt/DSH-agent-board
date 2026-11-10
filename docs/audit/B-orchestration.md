# Audit B — Orchestration, gouvernance, durabilité

## base de vérité

| Élément | Valeur |
|---|---|
| Dépôt | `D:\App\DSH-agent-board` |
| Branche | `fix/agent-board-runtime-e2e` |
| HEAD | `75b40d8d50c867a2b179c9e1a95f59e276f69789` (`75b40d8`) |
| Baseline tests (exécutée pour cet audit) | `node --test tests/` → **69 tests, 69 pass, 0 fail**, ~553 ms |
| Documentation de référence | `docs/ARCHITECTURE.md` (109 l.), `docs/LIMITATIONS.md` (42 l.), `README.md`, `docs/CONTRACTS.md`, `docs/TEST-REPORT.md` |
| Périmètre | `src/host/index.js`, `src/orchestrator/{dag,journal,lease}.js`, `src/contracts/model.js`, tests `dag/journal/lease/host-integration` |
| Modification apportée | **aucune** hors ce fichier (`docs/audit/B-orchestration.md`) |

Note de baseline : le `README.md:122` et `docs/TEST-REPORT.md:11` annoncent « 53 tests ». La
suite réelle en compte **69** ; c'est un écart documentaire (D24), pas une régression.

Toutes les preuves ci-dessous sont des références `chemin:ligne` + symbole, vérifiées dans
le code au HEAD indiqué. Tout ce qui dépend du runtime DSH natif (et non du dépôt) est
explicitement marqué **NON TESTABLE**.

---

## Tableau — comportement / verdict / preuves

| Comportement | Verdict | Preuves (path:line, fonction) | Écart | Sévérité |
|---|---|---|---|---|
| `GET /state` | implémenté | `src/host/index.js:669-672` (`handler`) ; sérialisation `publicStateOf` `:68-88` | attend `readyPromise` ; aucun effet de bord | — |
| `GET /events` (SSE) | **partiel (protocole cassé)** | émission `event: state` `src/host/index.js:130` (`broadcast`) et `:676` ; client `src/client/core.js:159-178` (`connectStream`, `stream.onmessage`) ; bundle `src/client.js:1230` | événement **nommé** `state` jamais reçu par `onmessage` (qui ne reçoit que les événements sans nom) ; pas de heartbeat, pas d'`id:`, pas de reprise `Last-Event-ID` ; `broadcast` n'envoie pas `reconcileNotes` alors que la trame initiale l'envoie (`:130` vs `:676`) | **P1** (D4) |
| `GET /adapters` | implémenté | `src/host/index.js:684-687` | lecture seule | — |
| `POST /mode` | implémenté | validation `isMode` `:694-695` ; effet `:696-701` ; persistance = écriture du document complet (`journal.js:66-75`) puis rechargement `:155-159` ; timer `:588` | ne tue pas le travail en cours (conforme au doc) ; `stoppedAt` non effacé par `POST /policy` (`:716-725`) | **P1** (D12, D13) |
| mode `off` | **partiel** | court-circuit `tick` `:529-532` ; timer `:588` ; `dag.js:122` et `dag.js:91` | **n'empêche pas** `POST /proposals/:id/decide` (`:745`) ni `POST /dispatch` (`:757`) de lancer ; n'arrête pas le failover (`onTurnEnd`) | **P0** (D1, D3) |
| mode `supervised` | **partiel** | `dag.js:169-175` (`kind:'proposal'`) ; création `src/host/index.js:551-565` ; approbation réelle `:745` | pas de borne de concurrence sur les propositions (`dag.js:172-174`) ; approbation possible hors mode (D1) ; TTL non vérifié à la décision (D10) | P1 |
| mode `autonomous` | implémenté | `src/host/index.js:566-569` → `launchTask` `:315-358` → `createSession` `:270-313` → `ctx.agents.create` `:282`, `inject` `:310`, `followup` `:311` | contournable par `/dispatch` (D8) ; `allowedProviders` non filtré (D7) | P1 |
| `POST /stop` (annulation) | **partiel** | `stopExecutions` `:594-620` ; cible `stopPlan` `dag.js:188-192` ; annulation native `agent.cancel({kind:'user'})` `:601-604` | pas de barrière contre un lancement en vol (D2) ; `stopped`/`interrupted` définitifs (D5) ; cas d'échec confondus (D20) | **P0** (D2) |
| `POST /ack` | implémenté — **état seulement, par conception** | `:708-715` ; consommation projection `src/supervisor/projection.js:93,340,360` | aucune action agent : c'est un curseur de lecture, pas une commande d'exécution | — |
| `POST /policy` | implémenté | `:716-725` ; `normalizePolicy` `src/contracts/model.js:148-166` | ne réarme pas `stoppedAt` ; `maxRetries` absent du schéma (`model.js:135-166`) malgré « every one is configurable » (`model.js:134`) | P2 (D18) |
| `POST /tick` | implémenté | `:726-729` → `tick` `:527-583` | aucun verrou de réentrance (D14) ; non exposé dans l'UI | P1 (D14) |
| `POST /proposals/:id/decide` — refus | implémenté | `:734-739` | `{}` (body vide) **rejette** silencieusement car `approve !== true` | P2 |
| `POST /proposals/:id/decide` — approbation | **partiel** | `:740-746` : `readinessOf` puis `launchTask` | ne revérifie **ni le mode**, **ni `stoppedAt`**, **ni le mandat**, **ni `maxConcurrent`**, **ni la révision** de la proposition | **P0** (D1) ; P1 (D8, D9, D10) |
| `POST /dispatch` | **partiel** | `:748-759` : `readinessOf` + `launchTask` | ignore mode, mandat, concurrence ; seule la clé d'idempotence protège | P1 (D8) |
| Validation HTTP | partiel | `requestRejection` `:659-664` (chaînage optionnel) ; corps 512 Kio `:636-640` ; JSON invalide `:692` ; `isMode` `:695` ; `sessionId` `:709-710` ; `taskId` `:750-751` | pas de contrôle `Content-Type`/CSRF explicite ; si le service `connection` manquait, l'auth serait silencieusement désactivée (`?:`) | P2 |
| Persistance du mode au redémarrage | implémenté | `mode`/`stoppedAt` font partie du document (`:49-66`), écrit par `store.write` (`journal.js:66-75`), rechargé `:155-159`, re-synchronisé `:158` ; test `tests/host-integration.test.js:244-278` | **reprend automatiquement** en autonome sans ré-approbation humaine (`startTimer` `:585-592`) — D12 | P1 |
| Observabilité UI du mode / de l'arrêt | **partiel** | `src/client/ui/toolbar.js:16,26-33` ; `stoppedAt` émis `:72` mais **jamais lu** côté client (0 usage hors `src/client/core.js:24`) ; `lastTick.skipped` (`:571`) jamais affiché (`toolbar.js:83-105` n'affiche que `sync`, adapters, `reconcileNotes`) | mode affiché « autonome » alors que le planificateur est bloqué ; aucune explication de « pourquoi rien ne part » | P1 (D13) |
| Leases expirables (`leaseTtlMs`) | **partiel** | `lease.js:23-36` (`createLease`, `leaseValid`) ; affectation `src/host/index.js:322,346` | `expiresAt` jamais vérifié, jamais renouvelé (`renewLease` `lease.js:38-40` **jamais appelé**), jamais libéré ; aucun chien de garde d'assignation | P1 (D6) |
| Fencing token | **absent en pratique** | `lease.js:51-55,59-61` ; seul appel `acquireLease(undefined, …)` `src/host/index.js:322` → jeton toujours `1` ; `fenceAccepts` **jamais appelé** | la protection revendiquée (`README.md:34-37`, `ARCHITECTURE.md:61-63`) est du code mort | P1 (D6) |
| `reconcileAfterRestart` | implémenté | `src/host/index.js:162-177` ; `lease.js:102-114` ; test `tests/host-integration.test.js:244-278` | « visible, resumable » (`lease.js:98-100`) : aucune reprise n'existe (D5) | P1 (D5) |
| Idempotence (`idempotencyKey`, `revision`) | **partiel** | `lease.js:63-95` ; `src/host/index.js:316-321,486-500` ; révision de secours = `ledgerRevision` global `src/connectors/taskboard.js:31` | `ensureAssignment` retourne un enregistrement **FAILED** puis `push` le duplique (D15) ; la forme réelle du payload Task Board est **NON TESTABLE** | P1 (D15) |
| Planificateur mono-écrivain | **absent** | `src/host/index.js:585-592` (`setInterval` → `void tick('timer')`) ; `:527-583` sans verrou | ticks réentrants ; `POST /tick` concurrent du timer (D14) | P1 (D14) |
| Journal / durabilité | partiel | `journal.js:66-87` (`write`, `append`) ; `src/host/index.js:140-144` (`audit`), `:572` | file d'écriture définitivement empoisonnée après un échec (D17) ; ticks sans action non journalisés ; `append` non attendu (`void store.append`) ; aucun verrou inter-processus | P2 (D16, D17) |
| Frontière Task Board (aucune écriture ledger, jamais `done` par le board) | implémenté (côté board) | `src/connectors/taskboard.js:15` (`GET /dsh-taskboard/state` seulement), `:88-91` (`capabilities: ['list','get']`), `:118-120` (`update/transition:false`) ; seuls accès `src/host/index.js:534,740,752` ; interdiction dans le prompt `:47` | **écriture indirecte** : le board ordonne à la session de claim/`in_review` (`:47`, `:264`) ; contenu de carte non fiable interpolé (`:257-262`) ; permission héritée du ledger (D11) ; « done jamais posé par l'agent » **NON TESTABLE** côté natif | P2 (D23) |
| Dépendances `dependsOn` | implémenté | `dag.js:29-51` (`dependencyReport`, `readinessOf`) ; revérifié `:743` et `:755` | `in_review` ne satisfait jamais (`dag.js:38`) ✓ ; aucun contrôle inter-projets sur les dépendances | — |
| Mandat `allowedWorkspaces` | **partiel** | `dag.js:85-93`, appliqué `dag.js:158-162` | absent de `/dispatch` (`:748-759`) et de l'approbation (`:740-746`) | P1 (D8, D9) |
| `allowedProviders` / `allowCloudFallback` | **partiel — failover seulement** | `src/routing/router.js:30-38,56` ; route initiale `src/host/index.js:237-253` | jamais consulté au lancement ; une carte pinnée hors allow-list est lancée (D7) ; `routeChain` en forme chaîne n'a pas de `locality` (`model.js:171-176`) | P1 (D7) |
| `maxConcurrent` | **partiel** | `dag.js:76-78,117-118,176-179` | ignoré par `/dispatch` et l'approbation ; double comptage possible (D15) ; slots fantômes sans watchdog (D6) ; ticks réentrants (D14) | P1 |
| Budget horaire | partiel | `dag.js:96-98,133-136` | `0` = illimité (ambigu) ; compte aussi les handoffs ; bloque aussi les propositions ; **aucun budget journalier ni coût** (`docs/LIMITATIONS.md:18`) | P2 (D19) |
| Priorités / ordonnancement | implémenté | `dag.js:66-74` (`orderCandidates`), `:54-64` (`dagDepth`) | urgence puis profondeur puis id | — |
| Limites RAM / CPU / processus | **absent** | aucune occurrence dans `src/` (seuls compteurs : `maxConcurrent` borné 0–8 `model.js:150`, budget 0–100 `model.js:163`, `MAX_PROPOSALS=8` `:42`, `MAX_ASSIGNMENTS_KEPT=60` `:44`, `MAX_AUDIT=200` `:45`) | **aucune limite mémoire/CPU/processus** : uniquement des comptes de tâches | P2 (explicite) |

---

## Défauts

### D1 — P0 — Une proposition peut être approuvée en mode `off` (et après Stop) et lance une vraie session

- Comportement erroné : `POST /proposals/:id/decide` ne consulte **ni `state.mode` ni
  `state.stoppedAt`**. Le handler se contente d'un `readinessOf` puis appelle `launchTask`.
- Entrée → effet : mode `off` (ou Stop préalable) + une proposition `pending` héritée du mode
  supervisé + clic **Approuver** (bouton rendu quel que soit le mode) → `ctx.agents.create`
  (`src/host/index.js:282`), `inject` (`:310`), `followup` (`:311`) : une session réelle démarre
  alors que l'opérateur a explicitement demandé l'observation seule.
- Preuves : `src/host/index.js:730-746` (aucun test de `mode`/`stoppedAt`) ; `:699` (OFF ne purge
  pas les propositions) ; `:77` (`publicStateOf` sert toujours les propositions `pending`) ;
  UI `src/client/app.js:237` + `src/client/ui/toolbar.js:66-71` (Approuver/Refuser affichés
  sans condition de mode) ; `src/host/index.js:47` (« OFF = observation seule » revendiqué
  dans `README.md:31-33`, `ARCHITECTURE.md:52`).
- Sévérité : **P0** — un contrôle d'autorisation affiché (le mode) est contourné par un autre
  bouton affiché, avec un effet hôte réel.

### D2 — P0 — Stop ne barre pas un lancement en vol : l'assignation repasse de `stopped` à `running`

- Comportement erroné : `launchTask` pousse l'assignation en `starting` **avant** `await
  createSession` (`:343`), puis affecte inconditionnellement `status = running` (`:345`) au
  retour. `stopExecutions` prend un instantané `stopPlan(state.assignments)` (`:595`) et
  n'oppose aucun verrou.
- Entrée → effet : un tick lance une tâche (création de session lente) ; l'opérateur clique
  **Arrêter** → l'assignation est marquée `stopped` (`:610`) puis, au retour de `createSession`,
  repasse `running` (`:345`) ; la session n'a **jamais été annulée** (`ctx.agents.get` n'avait pas
  encore de session à annuler, `:601`) et le prompt a déjà été injecté.
- Effet secondaire : la boucle `for (const action of plan.actions)` (`:550-570`) continue de
  lancer les actions restantes du plan courant ; aucune réévaluation de `stoppedAt`.
- Preuves : `:343-346` vs `:594-620` ; `dag.js:188-192` (instantané, pas de verrou) ;
  `:550-570` (pas de réévaluation).
- Sévérité : **P0** — « Stop » n'arrête pas ce qui est en train de démarrer et l'état devient
  mensonger (`stopped` écrasé).

### D3 — P0 — OFF et Stop n'arrêtent pas le moteur de failover : de nouvelles sessions sont créées

- Comportement erroné : `onTurnEnd` ne teste **jamais** `state.mode` ni `state.stoppedAt`.
- Entrée → effet : mode `off` (ou après Stop) + un `turn/end` `reason.kind='error'` sur une
  assignation active → soit un `followup` de retry (`:457`), soit une **nouvelle** session de
  handoff (`:503` → `createSession` → `ctx.agents.create`). La délégation continue donc après
  passage en OFF.
- Preuves : `:382-520` (aucune référence à `mode`/`stoppedAt` dans `onTurnEnd`) ; `:448-470`
  (retry) ; `:471-514` (switch/handoff) ; comparaison avec la garde du timer `:588`.
- Sévérité : **P0** — l'arrêt de la délégation est revendiqué (`README.md:31-33`,
  `docs/CONTRACTS.md:79`) mais seul le *démarrage piloté par tick* est coupé.

### D4 — P1 — Le flux SSE temps réel ne délivre rien au navigateur

- Comportement erroné : le serveur écrit des trames **nommées** `event: state`
  (`:130`, `:676`) ; le client écoute `stream.onmessage` (`src/client/core.js:164`,
  bundle `src/client.js:1230`). En HTML/SSE, `onmessage` ne reçoit que les événements **sans
  nom** ; un événement `state` exige `addEventListener('state', …)`.
- Entrée → effet : un tick autonome crée une proposition ou lance une assignation →
  `touch()` → `broadcast()` (`:128-138`) → trame ignorée → le panneau ne voit **jamais** les
  changements d'état hôte non sollicités (propositions, assignations, arrêts, ack d'un autre
  onglet). Seuls `refreshHost()` après un POST (`src/client/core.js:189`) ou le bouton
  Rafraîchir mettent l'UI à jour.
- Preuves : `src/host/index.js:130,676` ; `src/client/core.js:159-178` ; bundle
  `src/client.js:1230`. Le test `tests/client-core.test.js:98-113` appelle `created.onmessage(…)`
  à la main et **masque** donc le défaut de protocole.
- Sévérité : **P1** — la « liveness » affichée n'est pas réelle ; le cockpit d'orchestration est
  aveugle entre deux actions manuelles.

### D5 — P1 — Stop (et `interrupted`) rendent une tâche définitivement non déléguable, avec spam d'audit

- Comportement erroné : `launchTask` refuse toute clé d'idempotence existante dont le statut
  n'est **pas** `failed` (`:318`) ; or `ensureAssignment` ne filtre pas non plus par statut
  (`lease.js:73`). Aucune API de reprise n'existe.
- Entrée → effet : tâche lancée → **Stop** ⇒ assignation `stopped` ⇒ ré-armement du mode ⇒
  chaque tick (`TICK_MS=4000`, `:41`) produit une action `launch` qui échoue en
  `duplicate_assignment` (`:320`), journalisée à chaque fois (`:572`), sans jamais relancer la
  tâche. Idem après un redémarrage : `interrupted` (`lease.js:107`) bloque la clé pour toujours.
- Preuves : `src/host/index.js:316-321`, `:486-500` (seul le handoff incrémente `attempt`) ;
  `lease.js:71-95` ; `:41`, `:572`, `:587-589`.
- Sévérité : **P1** — Stop est destructif et irréversible au niveau de la tâche (il faut éditer
  la carte pour changer de `revision`) ; `lease.js:98-100` parle pourtant de reprise
  (« visible, resumable »).

### D6 — P1 — Leases et fencing tokens décoratifs ; aucun chien de garde ⇒ slots fantômes

- Comportement erroné : `acquireLease` est toujours appelé avec `existing = undefined`
  (`:322`) : il ne peut jamais refuser, et `fencingToken` vaut toujours `1` (`lease.js:54`).
  `renewLease` et `fenceAccepts` ne sont appelés **nulle part** dans `src/` (vérifié par
  recherche). Aucune assignation n'est expirée ou interrompue sur dépassement de `leaseTtlMs`.
- Entrée → effet : un agent tué sans `turn/end` (crash de session, kill) laisse une assignation
  `running` pour toujours ; `countRunning` (`dag.js:76-78`) la compte encore → `slots` reste à 0
  → plus aucun lancement possible jusqu'au prochain redémarrage (seul `reconcileAfterRestart`
  nettoie, et seulement au boot).
- Preuves : `lease.js:38-40,46-61` (helpers) ; `src/host/index.js:322,346` (seul usage) ;
  `dag.js:76-78` ; `:523-525` ; `README.md:34-37` et `ARCHITECTURE.md:61-63` (revendication).
- Sévérité : **P1** — la protection de durabilité annoncée n'existe pas à l'exécution ; les
  tests `tests/lease.test.js:6-21` valident du code jamais utilisé en production.

### D7 — P1 — `allowedProviders` / `allowCloudFallback` ne filtrent pas le lancement initial

- Comportement erroné : la route initiale est calculée par `routeForTask`/`defaultRoute`
  (`:237-253`) sans consulter la policy ; `isRouteAllowed` n'est appelé que par `nextRoute`
  (`src/routing/router.js:56`), c'est-à-dire **après** un échec.
- Entrée → effet : mandat `allowedProviders: ['local-only']` + carte `task.model = {provider:
  'cloud-x', model: 'y'}` → `createSession` reçoit `agentOptions.provider='cloud-x'` (`:277-286`)
  et la session démarre sur un fournisseur hors mandat. De même, `allowCloudFallback:false`
  n'a aucun effet sur une carte pinnée `locality:'remote'` (`:250`).
- Preuves : `src/host/index.js:237-253`, `:277-286` ; `router.js:30-38,56` ;
  `src/contracts/model.js:171-176` (une entrée `routeChain` sous forme chaîne n'obtient pas de
  `locality`, donc `fromLocal` est toujours faux et `allowCloudFallback:false` ne s'applique pas
  non plus au failover).
- Sévérité : **P1** — le mandat « allowedProviders » est affiché comme limite (`CONTRACTS.md:15`)
  mais n'est pas une barrière d'exécution.

### D8 — P1 — `/dispatch` et l'approbation ignorent mode, mandat et `maxConcurrent`

- Comportement erroné : ni `POST /dispatch` (`:748-759`) ni l'approbation (`:740-746`) ne
  passent par `selectDispatchable`/`mandateCheck`/`countRunning` ; ils appellent `launchTask`
  directement.
- Entrée → effet : `maxConcurrent=1`, une assignation déjà `running`, puis
  `POST /dispatch {taskId}` (ou approbation d'une proposition antérieure) → deuxième
  `ctx.agents.create` simultanée ; en mode `off`, `POST /dispatch` lance quand même.
- Preuves : `:748-759`, `:740-746`, `:315-358` (`launchTask` ne teste que la clé, `:318`).
- Sévérité : **P1** — trois limites revendiquées (mode, mandat, concurrence) contournées par
  une route API exposée (dispatch) et par un bouton UI (Approuver).

### D9 — P1 — L'approbation n'est liée ni à la révision de la tâche ni au mandat courant

- Comportement erroné : la proposition capture `revision` (`:558`) mais `decide` ne compare
  jamais `proposal.revision` à la révision relue (`:740-745`) ; `readinessOf` ne teste que le
  statut et les dépendances (`dag.js:43-51`) ; aucun `mandateCheck`.
- Entrée → effet : proposition créée pour la révision 1 → la carte est réécrite (révision 2,
  contenu différent) ou `allowedWorkspaces` est réduit via `POST /policy` → approbation →
  la session exécute le **nouveau** contenu dans un workspace désormais hors mandat.
- Preuves : `:553-563` (révision stockée) ; `:732-746` (révision/mandat jamais relus) ;
  `dag.js:43-51` ; `:716-725`.
- Sévérité : **P1** — l'approbation humaine porte sur un objet qui peut avoir changé.

### D10 — P1 — Le TTL des propositions n'est pas vérifié au moment de la décision

- Comportement erroné : l'expiration n'existe que dans `tick` (`:537-539`), après le
  court-circuit du mode OFF (`:529-532`) et jamais si `stoppedAt !== null` (le timer ne tick
  plus, `:588`). `decide` ne teste que `proposal.status === 'pending'` (`:732-733`).
- Entrée → effet : proposition de plus de `proposalTtlMs` (30 min par défaut, `model.js:139`),
  mode OFF ou après Stop (donc pas de sweep) → clic **Approuver** → lancement accepté.
- Preuves : `:732-733`, `:537-539`, `:529-532`, `:588` ; `publicStateOf` ne filtre que le statut
  (`:77`), pas l'âge.
- Sévérité : **P1** — une autorisation périmée reste exécutable.

### D11 — P1 — Permission et isolation héritées du ledger : élévation de privilèges non bornée

- Comportement erroné : `createSession` applique `permissionPresets.set(session, task.permission)`
  avec `task.permission` lu tel quel dans la carte (`src/connectors/taskboard.js:35`) ; aucune
  allow-list de permissions dans la policy ; `task.isolation` est ignoré
  (`docs/LIMITATIONS.md:14`).
- Entrée → effet : une carte portant `permission: 'danger-full-access'` (ou tout niveau supérieur
  au mandat de l'opérateur) → la session est créée puis reçoit ce niveau (`:299-302`) ; deux
  tâches du même workspace tournent dans le même `cwd` (`meta.cwd = workspace.path`, `:284`).
- Preuves : `:299-302`, `:284` ; `taskboard.js:35,38` ; `docs/LIMITATIONS.md:14-15`.
- Sévérité : **P1** — le seul niveau d'autorisation effectif vient d'une donnée du ledger, pas
  du mandat de l'opérateur.

### D12 — P1 — Le mode autonome persiste et reprend sans ré-approbation ; `stoppedAt` est un verrou invisible et persistant

- Comportement erroné : `state.mode` fait partie du document persisté (`:49-66`, écrit
  `journal.js:66-75`, rechargé `:155-159`), `startTimer` est
  armé dès `apply` (`:585-592`) et `stoppedAt` est lui aussi persisté (`:53`, `:72`) : après un
  Stop puis un redémarrage, le planificateur reste bloqué **sans indicateur UI**, et après un
  redémarrage en autonome il relance dans les 4 s sans nouvelle autorisation.
- Entrée → effet : Stop → redémarrage → `mode` toujours affiché `autonomous` (`toolbar.js:28-31`)
  mais aucun tick (timer bloqué par `:588`) ; inversement, redémarrage avec `mode=autonomous` et
  `stoppedAt=null` → tick immédiat → lancements autonomes sans ré-approbation.
- Preuves : `:49-66,72,155-159`, `:585-592`, `:588`, `:699` ; `toolbar.js:16,26-33`.
  `stoppedAt` n'est pas accessible via une commande dédiée ; il n'est effacé que par un
  `POST /mode` non-OFF (`:699`) — pas par `POST /policy` (`:716-725`).
- Sévérité : **P1** — reprise d'un mandat autonome sans consentement frais ; état d'arrêt
  inexpliqué.

### D13 — P1 — L'état d'arrêt et les raisons de non-lancement sont invisibles dans l'UI

- Comportement erroné : `stoppedAt`, `lastTick.skipped` et `lastTick.reason` sont produits
  (`:72`, `:530`, `:571`) mais aucun composant ne les lit ; le panneau « état orchestrateur »
  n'affiche que `sync`, les adaptateurs et `reconcileNotes` (`toolbar.js:83-105`).
- Entrée → effet : Stop → l'utilisateur voit le mode `autonomous` encore sélectionné, aucune
  exécution, aucun message : impossible de distinguer « stop armé », « budget épuisé »,
  « mandat » ou « erreur de synchronisation ».
- Preuves : `src/host/index.js:72,530,571` ; `src/client/core.js:24` (seule occurrence de
  `stoppedAt` côté client = valeur par défaut) ; `src/client/ui/toolbar.js:83-105`.
- Sévérité : **P1** — l'opérateur ne peut pas expliquer l'état du planificateur depuis l'UI.

### D14 — P1 — Ticks réentrants : pas de planificateur mono-écrivain

- Comportement erroné : `setInterval` appelle `void tick('timer')` sans verrou (`:587-589`) ;
  `tick` est asynchrone et attend `connectors.list()` (timeout 4 s, `taskboard.js:48`) puis
  `createSession`. `POST /tick` peut s'ajouter au tick du timer (`:726-729`).
- Entrée → effet : deux ticks se chevauchent, calculent chacun `slots = maxConcurrent -
  countRunning` (`dag.js:117-118`) sur le même état, avec des tâches différentes dans leurs
  plans ; chacun lance → `maxConcurrent=1` peut produire 2 sessions. Les `state.lastTick` et
  `state.sync` s'écrasent aussi (`:548`, `:571`).
- Preuves : `:527-583` (aucun booléen « tick en cours »), `:585-592`, `:41` (`TICK_MS=4000`),
  `taskboard.js:48` (`timeoutMs = 4000`).
- Sévérité : **P1** — la concurrence n'est pas garantie sous latence ; « single-writer logical
  scheduler » revendiqué dans `ARCHITECTURE.md:50-58` n'est pas implémenté.

### D15 — P1 — `ensureAssignment` + `push` duplique une assignation `failed` et fausse le comptage

- Comportement erroné : `launchTask` exclut les `failed` de son pré-contrôle (`:318`) mais
  `ensureAssignment` recherche la clé **sans filtre de statut** (`lease.js:73`) et retourne
  l'ancien objet ; `state.assignments.push(assignment)` (`:336`) ajoute alors une **seconde
  référence au même objet**.
- Entrée → effet : premier lancement échoue (`launch_failed`, `:350-357`) → workspace corrigé →
  nouveau tick/dispatch avec la même clé → un seul `createSession` mais **deux entrées** dans
  `state.assignments` (même `id`) → `countRunning` (`dag.js:76-78`) compte **2** slots,
  `publicStateOf` (`:79`) affiche un doublon, et l'ancien `sessionId` d'un `failed` après
  échec de route (`:441-446`) est écrasé sans trace.
- Preuves : `:316-321`, `:335-336` ; `lease.js:71-74` ; `dag.js:76-78` ; `:79`.
- Sévérité : **P1** — la limite de concurrence est faussée par un simple retry après échec.

### D16 — P2 — Croissance non bornée de l'état durable

- Comportement erroné : `state.proposals.push` (`:563`) et `state.assignments.push` (`:336`,
  `:500`) ne sont jamais purgés ; `compactState` ne borne que `previews`, `turnEnd`, `audit`
  (`journal.js:91-112`) ; `publicStateOf` ne coupe qu'à la sérialisation (`:77-79`) alors que
  `store.write(state)` écrit **tout** l'objet (`journal.js:66-75`).
- Entrée → effet : après des semaines, `state.json` contient toutes les propositions expirées
  et toutes les assignations ; la lecture au boot (`init`) et chaque écriture ralentissent.
- Preuves : `:563`, `:336`, `:500`, `:77-79` ; `journal.js:91-112`.
- Sévérité : **P2**.

### D17 — P2 — Un échec d'écriture empoisonne définitivement la file de persistance

- Comportement erroné : `this.queue = this.queue.then(async () => { … })` sans `catch`
  (`journal.js:66-74`) : une rejection laisse `queue` rejetée, et **toutes** les écritures
  suivantes s'enchaînent sur une promesse rejetée (le `then` est sauté).
- Entrée → effet : une erreur transitoire (fichier verrouillé, disque plein) → plus aucune
  sauvegarde pour la vie du processus ; `saveSoon` avale l'erreur (`:119-126`).
- Preuves : `journal.js:66-75` ; `src/host/index.js:119-126`.
- Sévérité : **P2** (durabilité silencieusement perdue).

### D18 — P2 — `maxSwitches` n'est pas cumulé entre tentatives ; `maxRetries` n'est pas configurable

- Comportement erroné : chaque `switch`/`handoff` crée une **nouvelle** assignation
  (`:485-500`) sans reporter `switches`/`retries` ; `planRoute` repart de 0 (`:420-421`).
  `maxRetries` est lu dans la policy (`router.js:91`) mais absent de `normalizePolicy`
  (`model.js:148-166`), donc non réglable via `POST /policy`.
- Entrée → effet : chaîne de 5 routes + `maxSwitches: 2` → jusqu'à 4 switchs (borne réelle =
  taille de chaîne, pas le budget) ; `maxSwitches` ne protège que dans une même assignation.
- Preuves : `src/host/index.js:420-421`, `:452` (retries mêmes-assignation), `:485-500` ;
  `lease.js:75-95` (pas de champ `switches`) ; `router.js:91-92` ; `model.js:148-166`.
- Sévérité : **P2**.

### D19 — P2 — Budget horaire ambigu et appliqué aussi aux propositions

- Comportement erroné : `budget > 0` (`dag.js:134`) alors que `0` est une valeur légale
  (`model.js:163`) : `0` signifie « illimité » et non « aucun ». Le test de budget précède la
  boucle et s'applique donc aussi au mode supervisé (propositions), et compte les handoffs
  (chaque nouvelle assignation a un `startedAt` neuf).
- Entrée → effet : `maxTasksPerHour: 0` → aucun plafond ; en supervisé, 6 handoffs dans l'heure
  suffisent à bloquer toute nouvelle proposition (`skipped: autonomy_budget_exhausted`).
- Preuves : `dag.js:96-98`, `:133-136` ; `model.js:162-164`.
- Sévérité : **P2** (aucun budget journalier ni coût : `docs/LIMITATIONS.md:18`).

### D20 — P2 — Annulation : « agent absent » et « cancel a levé » sont confondus, et l'état peut mentir

- Comportement erroné : `cancelled` n'est mis à `true` que si `cancel` s'exécute (`:602-605`) ;
  une exception est seulement `warn` (`:606-608`). Dans les deux cas l'assignation est écrite
  `stopped` avec le même `error: 'stop_requested_agent_unavailable'` (`:609-613`).
- Entrée → effet : `cancel` lève (ou l'agent est déjà parti) → l'assignation affiche
  `stopped`, alors que l'agent peut continuer à travailler ; impossible de distinguer les deux
  causes dans l'état.
- Preuves : `:594-620` ; `stopPlan` `dag.js:188-192` (renvoie `sessionId` possiblement `null`
  pour une assignation `starting`).
- Sévérité : **P2** (l'audit `stop_all` conserve `cancelled:false`, `:614,617`).

### D21 — P2 — États d'assignation incohérents

- Comportement erroné : `turn/end` `kind='aborted'` (abort natif, pas forcément opérateur) →
  `done` (`:392-399`) ; `plan.action='switch'` → ancienne assignation `failed` tandis que
  `handoff` → `superseded` (`:482`) ; un retry vers un agent disparu fait
  `agent?.followup?.()` (`:454-462`) sans `else` → l'assignation reste `running` (`:453`).
- Entrée → effet : session tuée par le runtime → `turn/end` `aborted` → carte d'assignation
  `done` (et non `stopped`/`interrupted`) ; agent absent → slot consommé à vie.
- Preuves : `:392-399`, `:453-467`, `:482`.
- Sévérité : **P2**.

### D22 — P2 — Course possible entre `sessionId` et un `turn/end` très précoce

- Comportement erroné : `inject`/`followup` partent dans `createSession` (`:310-311`) mais
  `assignment.sessionId` n'est affecté qu'au retour, `:344` ; `onTurnEnd` cherche par
  `entry.sessionId === sessionId` (`:383`).
- Entrée → effet **conditionnel** : un `turn/end` émis avant l'affectation (`sessionId` encore
  `null`) n'est associé à aucune assignation → l'assignation reste `running` pour toujours
  (slot fantôme). La fenêtre temporelle n'est pas prouvée : **à confirmer**, classé P2.
- Preuves : `:270-313`, `:344`, `:383`.

### D23 — P2 — Frontière Task Board : aucune écriture par le board, mais écriture indirecte promptée et contenu non fiable

- Constat prouvé (frontière respectée **côté board**) : le seul accès est
  `GET /dsh-taskboard/state` (`taskboard.js:15`) ; capacités déclarées `list`/`get` seulement
  (`:88-91`, `:118-120`) ; aucun `fetch` d'écriture dans `src/` ; seuls appels `:534`, `:740`,
  `:752` ; le board ne pose jamais `done` (interdiction dans `OFFICIAL_PROMPT` `:47`). Le statut
  `LEASE_STATUS.DONE` (`lease.js:16`) est un statut d'**assignation**, pas une écriture de
  ledger.
- Écarts : (a) le board **fait écrire** la session via le prompt (`:47`) : claim puis `in_review`
  — c'est une écriture déléguée, non vérifiée ; (b) `task.title`, `task.description`,
  `task.workspaceId`, `task.dependsOn` sont interpolés sans délimiteur (`:257-262`) : une carte
  malveillante peut contenir des instructions qui détournent la session (aucun grant d'outil
  spécifique n'est passé à `ctx.agents.create` : seuls `provider`/`model`/`reasoningEffort`,
  `:277-286`) ; (c) le prompt demande `taskboard_execution_report` alors que le board ne crée
  pas d'exécution Task Board : l'instruction échouera par construction
  (`docs/LIMITATIONS.md:10`, `docs/TEST-REPORT.md:48-52`) ; (d) l'interdiction « l'agent ne pose
  jamais `done` » est **NON TESTABLE** depuis ce dépôt (règle du plugin natif, pas du code
  audité).
- Sévérité : **P2** (le board lui-même reste correct ; le risque est dans la délégation).

### D24 — P2 — La documentation surestime plusieurs comportements

- `README.md:34-37` et `ARCHITECTURE.md:61-63` : « leases, fencing tokens » → décoratifs (D6).
- `README.md:31-33,78-79` / `CONTRACTS.md:79` : « OFF = observation seule / OFF crée nothing; Stop
  cancels » → OFF ne bloque ni l'approbation ni le dispatch ni le failover (D1, D3).
- `ARCHITECTURE.md:65-69` : « the framing asks the session to claim … report … » → le message
  injecté n'est qu'un titre (`:310`), les instructions sont dans le `followup` (`:264`, `:311`).
- `lease.js:98-100` : « interrupted … visible, resumable » → aucune reprise (D5) ;
  `docs/TEST-REPORT.md:99-102` ne démontre que l'absence de double lancement.
- `README.md:122` / `docs/TEST-REPORT.md:11` : « 53 tests » → 69 (mesuré).
- `docs/LIMITATIONS.md` est, lui, honnête sur l'isolation, l'absence d'exécution Task Board et
  l'absence de budget de coût.

---

## Ce que je n'ai pas pu vérifier (NON TESTABLE)

1. **Sémantique native de `ctx.agents.cancel({kind:'user'})`** : le type d'arrêt, l'effet réel
   sur le tour en cours et l'émission (ou non) d'un `turn/end` `aborted` ne sont pas définis
   dans ce dépôt ; les tests remplacent l'agent par un faux (`tests/host-integration.test.js:49-66`).
2. **Forme réelle de `GET /dsh-taskboard/state`** : le dépôt ne contient pas le contrat du
   plugin Task Board. En particulier l'existence d'un champ `revision`/`rev` par tâche, de
   `permission` et de `isolation` est supposée par `normalizeTask`
   (`src/connectors/taskboard.js:31,35,38`) ; sinon la révision retombe sur le `rev` **global**
   du ledger, ce qui change la clé d'idempotence à chaque écriture d'une autre carte. Les tests
   stubbent `{rev:1, tasks:[…]}` (`tests/host-integration.test.js:80-89`).
3. **Comportement d'un vrai redémarrage du processus DSH** : non exécuté (et non exécutable
   sans interrompre cette session) ; seul le niveau plugin/état est testé
   (`docs/LIMITATIONS.md:13`).
4. **`permissionPresets.set`** : acceptation réelle d'un niveau de permission et portée exacte
   (`docs/LIMITATIONS.md:15`) — best-effort, non vérifié.
5. **Garde `ctx.connection.requestRejection`** : le dépôt ne prouve pas qu'elle couvre CSRF /
   origine ; le chaînage optionnel `?:` (`src/host/index.js:659`) désactiverait l'auth si le
   service manquait. Non testable ici.
6. **`inject()` avec `source.kind: 'dsh-agent-board'`** : l'acceptation d'un producteur
   personnalisé par le runtime n'est pas vérifiable depuis ce dépôt (`:304-311`).
7. **Défaut SSE en navigateur réel** : la preuve est normative (événement nommé vs
   `onmessage`), pas une observation live ; je n'ai pas lancé le GUI pour cet audit.
8. **Course D22** : la fenêtre temporelle exacte n'est pas prouvée (elle dépend de
   l'ordonnancement du runtime entre `followup` et le retour de `createSession`).
9. **Garantie « l'agent ne pose jamais `done` »** : dépend du plugin Task Board natif, absent du
   dépôt ; le board, lui, ne l'écrit pas (prouvé).
10. **Dépassement de `maxConcurrent` par ticks réentrants (D14)** : prouvé par construction
    (absence de verrou) mais non reproduit en test ; les 69 tests ne couvrent aucun tick
    concurrent.



