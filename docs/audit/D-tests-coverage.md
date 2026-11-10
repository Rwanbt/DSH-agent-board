# Audit D — Couverture des tests, déterminisme, faisabilité E2E

Audit en lecture seule du dépôt `D:\App\DSH-agent-board`, plugin **Agent Board**
(branche `fix/agent-board-runtime-e2e`). Aucun fichier de `src/`, `tests/`,
`package.json`, ni l'état git n'a été modifié. Le seul écrit de cet audit est ce
document.

## 0. Base de vérité

| Fait | Valeur mesurée |
|---|---|
| Dépôt | `D:\App\DSH-agent-board` |
| Branche | `fix/agent-board-runtime-e2e` |
| HEAD (SHA complet) | `75b40d8d50c867a2b179c9e1a95f59e276f69789` (`75b40d8`) |
| État git au début de l'audit | propre (`git status --porcelain` vide) |
| OS | Windows 11, PowerShell 7 (`pwsh`) |
| Node | `v26.13.0` |
| npm | `11.20.0` |
| Commande de référence | `node --test tests/` |
| **Résultat exact** | **tests 69 / pass 69 / fail 0 / cancelled 0 / skipped 0 / todo 0 — `duration_ms 498.7109`** |
| `npm run check` | exit **0** — `node --check` OK sur `src/host/index.js` et `src/client.js`, puis **tests 69 / pass 69 / fail 0 — `duration_ms 529.4004`** |

Sortie brute de la fin de `node --test tests/` :

```text
ℹ tests 69
ℹ suites 0
ℹ pass 69
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 498.7109
```

Sortie brute de la fin de `npm run check` :

```text
ℹ tests 69
ℹ suites 0
ℹ pass 69
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 529.4004
EXIT=0
```

**Écart documentaire constaté** : `docs/TEST-REPORT.md` (§1 ligne 11 et §8
ligne 140) annonce **53 pass / 0 fail** et « 53/53 ». La réalité mesurée est
**69/69**. Le rapport est donc périmé sur son propre compteur (les 16 tests
ajoutés depuis — `interaction`, `board-view`, `client-core`, etc. — n'y sont pas
reflétés). C'est une non-conformité de reporting, pas un échec de test.

Inventaire : 10 fichiers de test, 69 `test(...)` au total —
`board-view` 12, `projection` 11, `dag` 9, `router` 9, `connectors` 6,
`journal` 5, `lease` 5, `interaction` 4, `host-integration` 4, `client-core` 4.
Aucun outil de couverture (c8/istanbul) n'est configuré : il n'existe **aucun
pourcentage de couverture** dans ce dépôt, seulement des tests comportementaux.

## 1. Matrice de couverture obligatoire (A–E)

Légende : **Couvert** = assertion automatisée sur le comportement demandé ;
**Partiel** = une partie seulement est assertée (souvent l'état logique, pas le
rendu réel ou pas l'intégration réelle) ; **Non couvert** = aucun test ;
**Non testable** = la fonctionnalité n'existe pas dans ce dépôt (rien à tester
en l'état). La colonne « réel vs fake » dit ce que le test exerce réellement.

### A. Session / UI

| # | Cas obligatoire | Verdict | Preuve (fichier — test) | Réel vs fake / remarque |
|---|---|---|---|---|
| A1 | Session live | Partiel | `projection.test.js` — « a running parent stays running even after an older completed turn » ; `client-core.test.js` — « store merges native sessions with host state » | Fixtures synthétiques (`tests/fixtures/sessions.js`), aucun host DSH réel, aucune session réellement créée par le test |
| A2 | Sous-agent et petit-enfant | Couvert | `board-view.test.js` — « filiation depth ≥ 3, sub-agents only under their parent, deduplicated » | Profondeur 3 (`ravum-goal → child-a → grandchild → great-grandchild`) sur fixture ; arbre réel d'affichage non rendu |
| A3 | Parent fini + enfant actif | Couvert | `board-view.test.js` — « several roots per project; finished parent with an active child is a group, not a running card » | Logique `groupActive` assertée ; pas de rendu DOM |
| A4 | Permission demandée (jaune) | Partiel | `projection.test.js` — « pendingInteraction wins over running (waiting for the user) » (kind `approval`) ; `board-view.test.js` — « statuses… » (`asking`/`question`) | Statut et `expectedAction` assertés ; **aucune assertion de couleur/jaune** (le CSS n'est testé que pour l'animation `running`) |
| A5 | Réponse finie verte non lue | Partiel | `projection.test.js` — « finished turn is unread until the read cursor passes it, then read » ; `board-view.test.js` — « statuses… » (`FINISHED_UNREAD`) | Statut `unread` asserté ; couleur verte non assertée |
| A6 | Consulté → neutre | Partiel | `board-view.test.js` — « statuses… » (ack → `FINISHED_READ`, `seen: true`, `isAttention` false) | État logique couvert ; rendu « neutre » non asserté |
| A7 | Pas de réponse finale | Couvert | `projection.test.js` — « preview is the host-captured final answer only once the turn ended » ; `board-view.test.js` — « final answer: last useful line, markdown stripped » | Un segment mi-tour n'est jamais présenté comme final (`preview.final === false`, texte vidé) |
| A8 | Erreur | Couvert | `projection.test.js` — « an error turn is failed, never finished » ; `board-view.test.js` — `failed-new` | Turn `error` → `FAILED`, jamais `finished` |
| A9 | Session historique masquée par défaut | Couvert | `board-view.test.js` — « photo scenario: default view hides the 39 old sessions and keeps attention items » | 39 vieilles sessions absentes de la vue par défaut, accessibles via recherche/historique |
| A10 | Navigation sur une session réelle | Partiel | `interaction.test.js` — « double click opens exactly once… », « keyboard: Enter opens… » | Seul l'arbitre de clic est testé (callbacks factices) ; `uiWorkspace.openSession(...)` dans `src/client/app.js` **n'est jamais exercé** ; aucun test navigateur |

### B. Orchestration

| # | Cas obligatoire | Verdict | Preuve (fichier — test) | Réel vs fake / remarque |
|---|---|---|---|---|
| B1 | OFF ne crée aucune tâche | Couvert | `dag.test.js` — « OFF creates nothing at all » | Fonction pure, aucune side-effect possible |
| B2 | Supervisé exige une approbation | Couvert | `dag.test.js` — « supervised proposes, it does not launch » ; `host-integration.test.js` — « supervised mode proposes, approval launches… » | Vrai `apply()` du plugin avec un **faux** `ctx` DSH ; création de session factice |
| B3 | Autonome ne lance que la tâche autorisée | Couvert | `dag.test.js` — « autonomous launches only ready tasks and respects concurrency » + « workspace mandate excludes… » ; `host-integration.test.js` — « autonomous mode launches… » | `allowedWorkspaces` asserté ; lancement via faux registre d'agents |
| B4 | Limite de concurrence | Couvert | `dag.test.js` — « autonomous launches only ready tasks and respects concurrency » (`maxConcurrent: 1`), « a task already running is never launched twice » | Comptage `starting/running`, pas de concurrence réelle |
| B5 | Dépendances bloquantes | Couvert | `dag.test.js` — « dependencies must be human-confirmed done, never in_review » | `done` seulement, jamais `in_review` |
| B6 | Redémarrage en cours de job | Partiel | `lease.test.js` — « restart reconciliation never relaunches… » ; `host-integration.test.js` — « restart reconciliation exposes an interrupted assignment… » | Redémarrage **simulé** (état écrit sur disque + nouveau `apply()`), pas de reboot du process DSH |
| B7 | Webhook en double | Partiel | `host-integration.test.js` — duplicate `/dispatch` → 409 `duplicate_assignment` ; `lease.test.js` — « one assignment per idempotency key… » | Aucun webhook dans le code : seuls le dispatch HTTP et la clé d'idempotence sont couverts |
| B8 | Échec de commande stop | Non couvert | — | `stopExecutions()` gère `stop_requested_agent_unavailable` (`src/host/index.js:612`) mais aucun test ne simule un agent absent/`cancel` en échec ; seul le stop nominal est testé (B « stop cancels ») |
| B9 | Reprise après attente | Non couvert | — | Aucune fonctionnalité de « resume after wait » dans le code ; rien à tester |
| B10 | Agents concurrents sur la même branche | Non couvert | — | `LIMITATIONS.md` §5 : l'isolation worktree n'est **pas appliquée** ; aucun test de collision de branche |

### C. Task Board

| # | Cas obligatoire | Verdict | Preuve (fichier — test) | Réel vs fake / remarque |
|---|---|---|---|---|
| C1 | Création / claim d'une tâche | Non couvert | — | Par conception l'adaptateur est **read-only** (`capabilities: list/get` seulement) ; aucun test ne crée ni ne réclame une tâche. Le claim annoncé dans `TEST-REPORT.md` est un E2E manuel, hors suite |
| C2 | Tâche dépendante | Couvert | `dag.test.js` — « dependencies must be human-confirmed done… » | Blocage et raison `blocked_by:` assertés |
| C3 | Sous-tâche (`parentId`) | Non couvert | — | L'adaptateur normalise `dependsOn`, pas la hiérarchie parent/enfant ; aucun test |
| C4 | DoD / rapport d'exécution | Non couvert | — | Le prompt officiel demande `taskboard_execution_report` (`src/host/index.js:47`) mais aucun test ne vérifie checklist/rapport ; `LIMITATIONS.md` P0 documente que ça échoue même en E2E |
| C5 | `in_review` | Partiel | `host-integration.test.js` — « supervised mode proposes… » : `messageText.includes('in_review')` | Assertion sur le **texte du prompt**, pas sur une transition réelle du ledger |
| C6 | Refus code du `done` par l'agent | Partiel | `connectors.test.js` — « task board adapter… keeps only read capabilities » (`create/update/transition: false`) ; `host-integration.test.js` — message contient « NEVER move it to done » | Garantie structurelle : l'adaptateur ne peut pas écrire. Le refus *par l'agent* n'est testé que par le prompt, jamais par un appel réel refusé |
| C7 | Conflit inter-projets | Partiel | `dag.test.js` — « workspace mandate excludes tasks outside the allow-list » ; `mandateCheck` | Filtrage unitaire par `allowedWorkspaces` ; aucun test de refus de claim/écriture inter-projets (c'est le plugin Task Board qui le porte) |
| C8 | Retrait de dépendance = approbation | Non testable | — | Comportement du plugin Task Board (`pending_approval`), absent de ce dépôt ; rien à tester ici |
| C9 | Liens de session présents | Couvert | `host-integration.test.js` — « autonomous mode launches… » : `previousSessionId` du handoff, `checkpoint.sessionId` de la session précédente | Assignments réels en mémoire, sessions factices |
| C10 | Worktree sale préservé | Partiel | `connectors.test.js` — « checkpoint captures git reality… » ; « checkpoint reconciliation reports drift… » | Le checkpoint **photographie** `git status`/HEAD et détecte la dérive ; aucune préservation (stash/worktree) ni test de non-perte de modifications |

### D. Failover

| # | Cas obligatoire | Verdict | Preuve (fichier — test) | Réel vs fake / remarque |
|---|---|---|---|---|
| D1 | 429 | Couvert | `router.test.js` — « classify: common provider failures » + « stage 1: bounded retry honours Retry-After… » | Classification et planification pures, aucune requête HTTP réelle |
| D2 | Quota | Couvert | `router.test.js` — « classify: common provider failures » (`insufficient quota`) | Idem |
| D3 | 5xx | Couvert | `router.test.js` — « stage 2: switch walks the chain… » ; `host-integration.test.js` — 503 après sortie partielle → handoff | 503 **simulé** par événement `turn/end` factice |
| D4 | Timeout avant le premier token | Couvert | `router.test.js` — « classify: common provider failures » (`ETIMEDOUT`) ; « stage 1… » | `afterFirstChunk` faux → retry borné, pas de handoff |
| D5 | Erreur après émission partielle | Couvert | `router.test.js` — « classify: an error after the first chunk requires a handoff, not a silent replay » ; `host-integration.test.js` — « autonomous mode launches; a 503 after work started… » | Handoff + checkpoint, pas de rejeu silencieux ; second `ctx.agents.create` factice |
| D6 | Contexte trop grand | Couvert | `router.test.js` — « classify: common provider failures » (`maximum context length exceeded`) | Classifié `context_overflow`, switchable |
| D7 | 401 / 403 | Couvert | `router.test.js` — « classify: common provider failures » (401) + « classify never turns a policy refusal… » (403) | 401 → `auth` switchable ; 403 → `policy_refusal` non switchable, plan `stop` |
| D8 | Tous les fallbacks à terre | Couvert | `router.test.js` — « stage 2… » (`max_switches_reached`, `blocked`) + « no alternate route after a partial stream… » | États `blocked` explicites |
| D9 | Budget épuisé | Couvert | `router.test.js` — « stage 1… » (budget de retries) + « stage 2… » (budget de switches) ; `dag.test.js` — « autonomy budget stops new launches inside the hour » | Deux budgets distincts, tous deux couverts |
| D10 | Fournisseur local uniquement | Couvert | `router.test.js` — « provider allow-list and local-only policy are enforced » | `cloud_fallback_forbidden_for_local_model` |
| D11 | Modèle sans les outils requis | Non couvert | — | Aucune notion de capacité/outils dans `planRoute`/`createSession` ; rien n'est vérifié avant lancement |
| D12 | Retour au primaire à un point sûr | Non couvert | — | `shouldReturnToPrimary()` existe (`src/routing/router.js:154`) mais **n'est appelé nulle part** et n'est pas testé ; `LIMITATIONS.md` §10 le confirme |
| D13 | Redémarrage juste après un switch | Non couvert | — | Aucun test ne persiste un handoff puis ne redémarre ; `reconcileAfterRestart` marque `interrupted` sans distinguer un switch récent |
| D14 | Effet externe commité mais ack perdu, sans double action | Partiel | `connectors.test.js` — « checkpoint reconciliation… » (`verify: ['push:origin/main']`, distinction `idempotent`) ; prompt « Never replay an external action » | Détection d'effet inconnu/non idempotent assertée ; scénario « ack perdu » (action faite, réponse perdue, reprise) non simulé |

### E. Sécurité / intégrations

| # | Cas obligatoire | Verdict | Preuve (fichier — test) | Réel vs fake / remarque |
|---|---|---|---|---|
| E1 | Token non exposé | Non couvert | — | `github.js` met le Bearer dans les en-têtes, `describe()` n'expose que capacités/baseUrl ; **aucune assertion** ne vérifie l'absence du token dans `/state`, `describe()` ou les logs |
| E2 | Webhook non signé refusé si signature requise | Non testable | — | Aucun endpoint webhook ni vérification de signature dans ce dépôt ; il n'y a rien à refuser |
| E3 | Permissions read-only | Couvert | `connectors.test.js` — « task board adapter… keeps only read capabilities » (exactement `get,list`) ; « github adapter stays honest… read-only when configured » | Capacités assertées ; pas de tentative d'écriture réelle refusée |
| E4 | Conflit de mise à jour externe | Non couvert | — | Seul le fallback de révision (`revision ?? rev ?? ledgerRevision`) est testé ; aucun scénario de révision périmée/conflit 409 |
| E5 | Idempotence | Couvert | `lease.test.js` — « one assignment per idempotency key… » ; `host-integration.test.js` — duplicate dispatch 409 | Double événement/dispatch → une seule assignment |
| E6 | CI rouge reste rouge | Couvert | `router.test.js` — « classify never turns a policy refusal or a code failure into a provider outage » (`NOT_MODEL`, plan `stop`) | « test suite failed » ne déclenche ni retry ni switch |
| E7 | Pas de contournement par prompt malveillant | Non couvert | — | Aucun test d'injection de prompt ; le prompt officiel est une constante injectée, jamais éprouvée adversarialement |
| E8 | Non-régression du plugin DSH/Task Board d'origine | Partiel | `host-integration.test.js` (4 tests) — vrai `apply()` avec `ctx` factice | Le plugin est réellement monté, mais le host, les agents et le Task Board sont des doublures ; aucune exécution contre le vrai plugin Task Board |

### Synthèse par famille

| Famille | Couvert | Partiel | Non couvert | Non testable | Total |
|---|---:|---:|---:|---:|---:|
| A — Session / UI | 5 | 5 | 0 | 0 | 10 |
| B — Orchestration | 5 | 2 | 3 | 0 | 10 |
| C — Task Board | 2 | 4 | 3 | 1 | 10 |
| D — Failover | 10 | 1 | 3 | 0 | 14 |
| E — Sécurité / intégrations | 3 | 1 | 3 | 1 | 8 |
| **Total** | **25** | **13** | **12** | **2** | **52** |

## 2. Fakes vs réel

### Ce qui est réel dans la suite

- Le **code de production** est importé tel quel (pas de mock de module) :
  `apply()` du host, `selectDispatchable`, `planRoute`, `classifyFailure`,
  `StateStore` (écritures disque réelles), `buildProjection`, `buildBoardView`,
  `createClickArbiter`, `createBoardStore`, les adaptateurs.
- Le système de fichiers réel : `mkdtemp` + `state.json` + `audit.jsonl` +
  quarantaine d'un fichier corrompu (`journal.test.js`, `host-integration.test.js`).
- Les timers réels pour les tests asynchrones (`waitFor`, `setTimeout`).
- Le runner `node:test` et `assert/strict`.

### Ce qui est faux (doublures)

| Doublure | Où | Ce qu'elle remplace |
|---|---|---|
| `ctx` DSH complet fait main (`webServer`, `agents`, `workspaceRegistry`, `effect`, `on`, `get`, `connection`) | `host-integration.test.js:20-78` | Le vrai host DSH, le vrai registre d'agents, le vrai serveur web |
| `ctx.agents.create()` retournant `{agent:{inject,followup,cancel}}` | idem | Création réelle de session/provider |
| Enregistrement de route en mémoire (`routes` Map) | idem | `webServer.register` réel ; pas de socket HTTP |
| `globalThis.fetch` remplacé | `host-integration.test.js:80-89`, `connectors.test.js`, `client-core.test.js` | Le Task Board HTTP réel / GitHub réel |
| Enveloppe `{ok:true,value:{rev,tasks}}` fabriquée | `connectors.test.js:8-19` | Le ledger Task Board réel (55 Ko sur cette machine) |
| Snapshots de sessions synthétiques | `tests/fixtures/sessions.js` (commentaire « explicitly synthetic (NOT live data) ») | `sessions.list` / `uiSession.sessionStatus` / `workspaces.list` réels |
| `FakeEventSource` | `client-core.test.js` | SSE navigateur |
| Horloge/timers injectés | `interaction.test.js` (`now`, `setTimer`, `clearTimer`) | Horloge réelle pour le double-clic |
| `git` réel mais jamais atteint | `gatherGit` n'a pas de `cwd` dans le faux ctx → `null` | Le vrai dépôt de travail ; `connectors.test.js` fabrique un `git` à la main |
| Aucun provider LLM | partout | Aucun appel modèle réel, aucun 429/5xx réel |

**Conclusion fakes vs réel** : la suite teste bien la **logique** du plugin et sa
persistance disque, mais elle ne teste **aucune intégration réelle** : pas de
host DSH, pas de serveur HTTP, pas de Task Board, pas de provider, pas de
navigateur, pas de forge. Le nom « host-integration » est donc trompeur : c'est
une intégration du host *avec un faux host*.

## 3. Déterminisme

### Points positifs

- **Horloge injectable** partout où le temps compte : `StateStore({now})`
  (`journal.test.js` → `1000`, `42`), `acquireLease({now})`,
  `reconcileAfterRestart({now})`, `selectDispatchable({now})`, `planRoute({now})`,
  `parseRetryAfter(value, now)`, `buildProjection({now})`, et un **faux ordonnanceur**
  complet dans `interaction.test.js`. Il n'y a pas d'horloge globale simulée
  (sinon `date-fns`/`sinon`) : l'injection est explicite et locale.
- **Fixtures déterministes** : `NOW = 1_800_000_000_000` figé,
  scénarios reproductibles (`photoScenario`, `largeScenario`), aucun aléa.
- **Aucun réseau réel** : `fetch` toujours injecté/stubbé ; les `baseUrl`
  `http://127.0.0.1:1` et `127.0.0.1:62337` ne sont jamais contactés sans
  `fetchImpl` factice.
- **Aucun accès au `~/.dsh` réel** : `host-integration.test.js` positionne
  `process.env.DSH_HOME` vers un `mkdtemp` avant `apply()`, et le restaure. Les
  4 tests du fichier sont donc confinés.
- **Doublons/ordre** : double-clic dupliqué (`interaction`), dispatch dupliqué
  (409), événement d'idempotence répété (`lease`), id de session dupliqué
  dédupliqué (fixture `board-view`).

### Risques de flakiness (nommés)

1. `board-view.test.js` — « performance: 200 history + 30 active roots… » :
   assertion **mur-horloge** `perRound < 25 ms` via `performance.now()`.
   Mesuré ici 29,8 ms pour 20 tours, soit ≈ 1,5 ms/tour (marge ~16×), mais sur
   une machine chargée/CI lent le seuil reste dépendant de la charge.
2. `host-integration.test.js` — `waitFor()` : polling réel `setTimeout(15 ms)`
   avec budget de 4 s (`Date.now()`), et attente de 200 × 15 ms pour le
   reconcile. Correct en pratique, mais dépend du temps réel et de l'ordonnanceur.
3. `client-core.test.js` — 4 tests avec `await new Promise(r => setTimeout(r, 20|30))`
   au lieu d'attendre la fin réelle du `fetch`/SSE : sur un process très chargé,
   la snapshot peut ne pas être prête → flaky.
4. **Mutation d'environnement globale** : `process.env.DSH_HOME = previousHome`
   (`host-integration.test.js:177,239,275,299`). Si `DSH_HOME` était **non
   défini** au départ (`previousHome === undefined`), Node convertit
   l'affectation en la chaîne `"undefined"`. Ici `DSH_HOME` vaut
   `C:\Users\barat\.dsh` (donc la restauration est correcte), mais sur une autre
   machine le dernier test laisserait `DSH_HOME="undefined"`. Sans conséquence
   inter-fichiers (Node lance chaque fichier dans son propre process), mais
   c'est une hygiène fragile et un piège de portabilité.
5. `globalThis.fetch` est remplacé/restauré : sûr intra-fichier, fragile si un
   jour `--test-concurrency` exécute des tests du même fichier en parallèle.
6. Aucun test d'événements **hors ordre** (ex. `turn/end` avant
   `assistant/message`, ou double livraison SSE) ni de tick concurrent : la
   robustesse à l'ordre des événements n'est pas prouvée.

### Verdict déterminisme

Bonne discipline d'injection (temps, rng, fetch, ctx), **mais** 3 dépendances
au temps réel (perf, `waitFor`, sleeps) et une mutation globale d'environnement.
Sur cette machine : 69/69 stable, durée ~0,5 s. Risque de flakiness **faible à
moyen** sur CI chargée, concentré sur les points ci-dessus.

## 4. Faisabilité E2E (investigation read-only, aucun serveur démarré)

### Commandes réellement exécutées et sorties

| Commande | Sortie |
|---|---|
| `Get-Command dsh` | **rien** (introuvable) |
| `where.exe dsh` | « impossible de trouver des fichiers pour le(s) modèle(s) spécifié(s) » |
| `& "C:\Users\barat\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version` | `0.2.2-rc.1` |
| `dsh.cmd --help` | `--profile <name>`, `--from-default-profile`, `--patch`, `--dump-config` ; texte : « the profile under `$DSH_HOME/profiles` to boot » |
| `dsh.cmd web --help` | `--host`, `--no-open`, `--port <port>` (**0 = port libre**), `--public-url`, `--tls-*` |
| `dsh.cmd --profile web --dump-config` | 46 946 caractères ; chemins sous `C:\Users\barat\.dsh\profiles\web` ; webserver `port: ... ?? 3080` ; mobile `listenPort: 3443` |
| `dsh.cmd plugin --help` | « manage a profile's plugins by forwarding the remaining arguments to pnpm » ; profil « initialized on first use » |
| `Get-ChildItem C:\Users\barat\.dsh\profiles` | `desktop`, `web` — **aucun profil isolé/test existant** |
| Taille des profils | `desktop` : **237,6 Mo / 5 456 fichiers** ; `web` : **0,0 Mo / 12 fichiers** |
| `desktop/package.json` | bundles : base, web-app, agent-team, forge, plugin-market, inspector, cot-translation, claude-code, quota, mobile, anthropic, **dsh-taskboard**, **dsh-agent-board** |
| `web/package.json` | bundles : base, web-app, `dsh-mobile` uniquement — **ni Agent Board ni Task Board** |
| `$env:DSH_HOME` | `C:\Users\barat\.dsh` |
| `Get-NetTCPConnection -State Listen` (62337/3080/3443) | **127.0.0.1:62337, PID 2096** (l'instance desktop vivante) ; 3080 et 3443 libres |
| `Get-Command ollama` | présent (`...\Programs\Ollama\ollama.exe`) ; process **non lancé**, `http://127.0.0.1:11434` **refusé** |
| `dsh --profile web --dump-config-schema` | 958 550 caractères ; schéma provider avec **`baseURL` configurable** par provider et protocoles `openai-completions`/`openai-responses` |
| Chaînes `DSH_HOME` dans `app.asar` | `@deepseek-ai/dsh-home-paths` résout `$DSH_HOME`, sinon `~/.dsh` |
| `dsh plugin --help` + `desktop/node_modules` | `dsh-taskboard` et `dsh-agent-board` sont des **liens locaux** ; leurs `package.json` ont **zéro dépendance** (`{}`) → installation hors-ligne possible |

### Verdict : **POSSIBLE WITH WORK**

Ce qui existe et rend l'E2E réalisable sans toucher au profil réel :

1. **`DSH_HOME` est un vrai levier d'isolation** (documenté dans `--help` et
   implémenté par `dsh-home-paths`). Il sépare profils, sessions, storages,
   `dsh-taskboard.json` et `.credentials.yaml`.
2. **`--profile <nom>`** permet un profil dédié ; `--from-default-profile web`
   en crée un à partir du template embarqué, sans copier les 237 Mo du desktop.
3. **`--port 0`** évite le conflit avec le 62337 déjà occupé.
4. Les deux plugins sont des `link:` **sans aucune dépendance npm** : un
   `dsh plugin --profile <iso> add link:D:/App/DSH-agent-board link:.../dsh-taskboard`
   peut se faire hors-ligne. Il faut ensuite ajouter les deux noms dans
   `dsh.profile.bundles` du `package.json` du profil (comme le fait le desktop).
5. **Un provider factice est possible** : le schéma confirme un `baseURL` par
   provider et le protocole `openai-completions`. Un petit serveur OpenAI-compatible
   local (sans credentials) rend l'E2E déterministe — à condition qu'il sache
   émettre des `tool_calls` (`taskboard_*`) pour l'E2E complet.

### Blocage du chemin le plus simple (« copier le profil desktop »)

- `desktop` contient **les secrets de l'utilisateur en clair** dans
  `cordis.patch.yml` (une clé API littérale y figure notamment) : copier ce
  profil recopie des secrets — à proscrire, et c'est précisément ce que
  l'audit doit éviter.
- `desktop` est le profil **en cours d'exécution** (PID 2096). Démarrer une
  seconde instance sur le même `DSH_HOME`/profil partagerait sessions, storages
  et ledger Task Board, avec des risques de verrous/corruption : à ne pas faire.
- Un `DSH_HOME` isolé n'a **pas** `.credentials.yaml` : un E2E qui appelle un
  vrai modèle cloud est impossible sans copier des credentials (hors périmètre,
  sensible) ou sans le provider factice ci-dessus.

### Étapes concrètes proposées (non exécutées)

1. Créer `D:\App\dsh-e2e-home` (hors dépôt) et l'utiliser comme `DSH_HOME`.
2. Bootstrap du profil **sans le monter** : `dsh --profile e2e --from-default-profile web --dump-config` (crée le profil depuis le template embarqué puis sort), ou première utilisation de `dsh plugin --profile e2e …` qui initialise le profil.
3. `dsh plugin --profile e2e add link:D:/App/DSH-agent-board link:C:/Users/barat/Documents/deepseek-harness/default-workspace/dsh-taskboard`.
4. Ajouter `dsh-agent-board` et `dsh-taskboard` dans `dsh.profile.bundles` du
   `package.json` du profil `e2e`.
5. Configurer le provider sur `baseURL: http://127.0.0.1:<port-factice>` (serveur
   OpenAI-compatible local émettant des tool calls), modèle avec outils.
6. Démarrer `dsh --profile e2e --port 0 --no-open` avec `DSH_HOME` isolé,
   récupérer l'URL imprimée.
7. Créer une tâche dans le Task Board isolé (`$DSH_HOME/dsh-taskboard.json`),
   passer en `supervised`, approuver, observer assignment/session/`in_review`,
   vérifier l'absence de `done`.
8. Navigateur en **contexte isolé** (Playwright `isolatedContext`) pour le panneau,
   le double-clic, l'ack, le jaune/vert.
9. Arrêter le process et supprimer `D:\App\dsh-e2e-home`.

**Blocage résiduel exact** : aucun `dsh` dans le `PATH` (utiliser le lanceur
absolu), aucun profil isolé prêt à l'emploi, et surtout **pas de credentials
dans un `DSH_HOME` neuf** — d'où l'obligation soit d'un provider factice
`baseURL`, soit d'une copie de credentials (non recommandée). Le vrai E2E
« modèle + tools » reste donc **POSSIBLE WITH WORK**, pas immédiat.

## 5. Portabilité Windows / Linux

| Point | Constat |
|---|---|
| `node --test tests/` | Portable (Node ≥ 22, `engines` du `package.json`). Un fichier de test par process, chemins résolus par Node |
| `npm run check` | `node --check a && node --check b && node --test tests/` : `&&` est interprété par npm (cmd.exe sous Windows, sh sous Linux) → portable. Ne vérifie que 2 fichiers sur 25, mais tous les modules testés sont importés donc un syntax error échouerait |
| Chemins de fixtures | Fenêtrés (`D:\App\...`, `C:\Users\me\...`) mais traités comme **chaînes** ; `normalizePath()` gère `\` et `/`. Sur Linux les mêmes assertions passent, mais la sémantique testée (insensibilité à la casse, séparateurs) est celle de Windows |
| `scripts/smoke-host.mjs` | Shebang `#!/usr/bin/env node` (POSIX) mais toujours invoqué via `node scripts/smoke-host.mjs` (`npm run smoke`) → sans effet sous Windows ; aucun `chmod`, aucun `sh -c` |
| Divers | `tmpdir()`, `join`, `rm(...,{maxRetries})`, `new URL(..., import.meta.url)` : portables. Aucun `/tmp`, aucun `chmod`, aucune commande shell externe (sauf `git` via `execFile` dans le code, non exercé) |
| Node | `structuredClone` (17+), `performance.now` global, `Array.prototype.at` : OK ≥ 22 |

**Verdict portabilité** : pas d'hypothèse POSIX bloquante ; le seul biais est
cosmétique (fixtures aux chemins Windows) et ne casse pas une exécution Linux.
`npm run smoke` est un smoke **synthétique** (snapshot + une décision DAG), pas
un test du host réel.

## 6. Ce que je n'ai pas pu vérifier

- Aucun provider réel, donc **aucun 429/quota/5xx/timeout réel** : tout le
  failover D1–D10 est unitaire/simulé. `dsh-llm-fallbacks` n'est pas installé.
- Aucun host DSH réel démarré (interdit par le périmètre) : l'intégration
  `apply()` n'est prouvée qu'avec un faux `ctx` ; la forme réelle des
  événements `session/event` (`assistant/message`, `turn/end`) n'est pas validée.
- Aucun navigateur : rendu, couleurs (jaune/vert/neutre), navigation
  `uiWorkspace.openSession`, a11y, mobile — non vérifiés. `src/client/app.js`
  et `src/client/ui/{tree,preview,history,toolbar,card,strings}.js` ne sont
  importés par **aucun** test ; seul `styles.js` est lu par le test CSS.
- Aucun E2E Task Board réel : create/claim/subtask/DoD/rapport/retrait de
  dépendance non testés ; `in_review` n'est asserté que dans le prompt.
- Aucun reboot réel du process DSH ; la réconciliation n'est testée qu'au
  niveau état.
- Aucune vérification dynamique de fuite de token (seulement statique : le
  token n'apparaît pas dans `describe()`, mais rien ne l'asserte).
- Je n'ai pas lancé `dsh --profile <iso>` ni `dsh plugin add` : la faisabilité
  ci-dessus est déduite du `--help`, du `--dump-config`, des schémas et des
  `package.json`, pas d'un boot réel. Le comportement d'un profil neuf
  (onboarding, trust fence, login) n'est pas vérifié.
- Pas de couverture de code chiffrée (aucun outil de couverture installé).
- Je n'ai pas exécuté la suite sous Linux.
