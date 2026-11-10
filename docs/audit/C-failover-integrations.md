# C — Failover modèle/provider, reprise au niveau tâche, intégrations Task Board + forges

Audit read-only du dépôt `D:\App\DSH-agent-board` (plugin « Agent Board »), périmètre :
`src/routing/*`, `src/recovery/checkpoint.js`, `src/connectors/*`, `src/contracts/*`,
`tests/router.test.js`, `tests/connectors.test.js`, `docs/CONTRACTS.md`, `docs/LIMITATIONS.md`,
`README.md`, plus la vérité externe du fork Task Board
(`C:\Users\barat\Documents\deepseek-harness\default-workspace\dsh-taskboard`) et du profil DSH desktop.

Aucun fichier `src/`, `tests/` ou état git n'a été modifié **par moi**. Seul ce fichier a été créé.
**Ancrage** : toutes les preuves `path:line` ci-dessous ont été lues puis re-vérifiées sur
**HEAD `75b40d8`** (`git show HEAD:<path>`). Pendant l'audit (après mes lectures), d'autres
agents ont modifié 13 fichiers de l'arbre de travail (`src/host/index.js`,
`src/contracts/model.js`, `src/connectors/taskboard.js`, `src/orchestrator/*`, des tests, plus
`src/orchestrator/lock.js` et `tests/lock.test.js` nouveaux). Ces corrections sont **hors de
mon périmètre** et **non auditées** ici : ce rapport décrit le HEAD demandé, pas l'arbre courant.

---

## 0. Base de vérité (mesurée, pas déclarée)

| Fait | Valeur | Preuve |
|---|---|---|
| Branche | `fix/agent-board-runtime-e2e` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `75b40d8` — feat(ui): agent family trees… | `git rev-parse --short HEAD` |
| Arbre git | propre **au début** de l'audit (hors `docs/audit/` des audits A/B/D) ; modifié ensuite par d'autres agents (13 fichiers) | `git status --porcelain` ; `git diff --stat` |
| Version plugin | `dsh-agent-board` **0.1.0** | `package.json:3` |
| Compatibilité DSH déclarée | **0.2.2-rc.1** | `package.json:37-38` |
| Version Task Board locale | `dsh-taskboard` **0.10.2** | externe `…\dsh-taskboard\package.json:4` |
| Compatibilité Task Board | 0.2.0-rc.2 | externe `…\dsh-taskboard\package.json:24-25` |
| `dsh-llm-fallbacks` | **absent** du profil desktop et du runtime décompressé | voir §0.3 |
| Release DSH | 0.2.2-rc.1 (indirecte : dépendance de profil `@deepseek-ai/dsh-subagent-claude-code` 0.2.2-rc.1 + bloc `dsh.compatibility`) — version du binaire `app.asar` non lue | `package.json:37-38`, `C:\Users\barat\.dsh\profiles\desktop\package.json` |
| Node | v26.13.0 | `node -v` |
| Tests | **69 pass / 0 fail** (500 ms) | `node --test tests/` |
| Lignée réelle du ledger Task Board | `schemaVersion=1`, `revision=179`, 20 tâches, tâches avec `version` (pas `revision`) | `C:\Users\barat\.dsh\dsh-taskboard.json` |
| État réel Agent Board | 1 assignment `done`, `routeEvents=0`, `health={}`, `sync.ledgerRevision=null`, clé d'idempotence `taskboard:t-mw9q6fpe-qfjnvy@0#0`, `revision=null`, `checkpoint=null` | `C:\Users\barat\.dsh\agent-board\state.json` |
| Journal réel | 32 lignes, **aucun** `route_decision` / `handoff` / `switch` | `C:\Users\barat\.dsh\agent-board\audit.jsonl` |
| Politique réelle persistée | `routeChain` = **une seule** route (`opencode-go/deepseek-v4.1-flash`, `locality=remote`), `maxSwitches=1`, `allowCloudFallback=false` | `state.json` (profil desktop) |

Conséquence immédiate : **aucun failover réel n'a jamais eu lieu** sur cette installation
(`routeEvents=0`, `health={}`, journal sans décision de route), et la chaîne configurée ne
contient **aucune route alternative** : même un déclencheur correct aboutirait à `chain_exhausted`.

### 0.3 `dsh-llm-fallbacks` : absence confirmée, conséquence

Vérifications : `C:\Users\barat\.dsh\profiles\desktop\package.json` (dépendances) ne le liste pas ;
`…\profiles\desktop\node_modules` ne le contient pas ; recherche récursive de tout répertoire
`*fallback*` sous `C:\Users\barat\.dsh` et sous `…\DeepSeek Harness\resources` : **aucun résultat** ;
aucune occurrence dans les lockfiles du profil. Le binaire `app.asar` (213 Mo) n'est pas
décompressé intégralement → je ne peux pas prouver qu'aucun bundle interne ne le référence.

Conséquence honnête : le routeur du Board est un **routeur au niveau tâche** (il crée une
nouvelle session sur une autre route), **pas** le plugin de fallback en cours de requête.
Le contrat public de `dsh-llm-fallbacks` (chaîne virtuelle, reprise intra-requête) **n'a jamais
été évalué**, et le plugin ne l'appelle nulle part (`grep 'fallbacks'` sur `src/` : 0 occurrence
hors commentaires `allowCloudFallback`). Toute promesse de « fallback dans la requête » est donc
hors de ce que ce code peut tenir.

### 0.4 Task Board 0.10.2 : contrat confirmé / réfuté

- **Route et enveloppe : confirmées.** `GET /dsh-taskboard/state`
  (`ROUTE_PREFIX = '/dsh-taskboard'`, externe `src/shared/api.ts:18`), handler
  `src/host/routes.ts:482`, réponse `{ ok: true, value: { ...ledger, tasks, doneCount,
  capabilities, queue } }` (`routes.ts:508-517`). L'hypothèse de `taskboard.js:15,76-82` est
  exacte.
- **Statuts : confirmés.** `backlog | todo | in_progress | in_review | done | canceled |
  archived` (`protocol.ts:26-33`), transitions légales `protocol.ts:54-62`. L'adaptateur les
  laisse passer sans les valider (aucun statut inventé).
- **`dependsOn` : sémantique confirmée.** Prérequis du même workspace ; un prérequis n'est
  satisfait que s'il existe, n'est pas trashté et est **`done` approuvé par un humain**
  (`protocol.ts:907`, `dependencies.ts:72-75`) ; la garde est appliquée au passage
  `in_progress` (`tools.ts:1055-1057`). Le Board applique la même règle
  (`dag.js:29-51`) — mais ignore `blocked`/`waitingForHuman` (D12).
- **Garde `done` : confirmée.** Un agent ne peut jamais déplacer vers `done` :
  `if (to === 'done') throw forbidden` (`tools.ts:1049-1051`) ; la transition
  `in_review → done` n'est légale que dans la table (`protocol.ts:58`). Le Board ne le fait pas
  non plus (`docs/CONTRACTS.md:75-81`).
- **Surface d'outils `taskboard_*` : confirmée.**
  `taskboard_list` (:581), `taskboard_get` (:632), `taskboard_create` (:685),
  `taskboard_update` (:845), `taskboard_move` (:989), `taskboard_comment_add` (:1084),
  `taskboard_comments` (:1138), `taskboard_delete` (:1167), `taskboard_checklist` (:1269),
  `taskboard_execution_report` (:1365) — externe `src/host/tools.ts`.
- **Lecture seule : confirmée.** L'adaptateur n'émet qu'un GET, sans méthode d'écriture
  (`taskboard.js:51-82,84-125`).
- **Réfuté.** La normalisation de tâche lit `rev`, `revision`, `claim` qui **n'existent pas**
  dans `TaskRecord` (`protocol.ts:978,981,1088-1094`) → D1.

---

## 1. Matrice de déclenchement

**Prémisse structurante (cause racine des écarts ci-dessous)** : le seul appel réel au
classifieur est `onTurnEnd` → `classifyFailure({ message, phase: 'stream', afterFirstChunk })`
(`src/host/index.js:407-413`). L'hôte ne transmet **ni `status`, ni `code`, ni `retryAfterMs`**,
et `phase` n'est **pas lu** par le classifieur (JSDoc `src/routing/classify.js:52`, aucune
utilisation dans le corps). Toute la classification repose donc sur des chiffres/mots présents
dans le texte du message, tronqué à 300 caractères (`src/host/index.js:206`), et
`afterFirstChunk` sur un horodatage de preview (`src/host/index.js:412`).

| Déclencheur | `classifyFailure()` retourne | Ce que fait le routeur / l'hôte | Preuve | Verdict |
|---|---|---|---|---|
| **429 / rate-limit** | `RATE_LIMIT` ; `retryable=true`, `switchable=true`, `requiresHandoff=afterFirstChunk`, `retryAfterMs` seulement si fourni | Si `afterFirstChunk` → **handoff** ; sinon **retry** dans la même session, **immédiat** (le `delayMs` calculé n'est jamais appliqué), borné à 2 ; puis **switch** si chaîne, sinon **blocked**. Un « Too many requests » sans le chiffre 429 tombe en `UNKNOWN` → retry seulement, jamais de switch | `src/routing/classify.js:86-89` ; `src/routing/router.js:106-123` ; `src/host/index.js:407-413`, `448-469` | **partiel** |
| **Quota / usage** | `QUOTA` ; `retryable=false`, `switchable=true`, `requiresHandoff=afterFirstChunk` | **switch** (ou handoff si sortie partielle). Aucun retry | `src/routing/classify.js:40,80-81` ; `router.js:126-131` | **implémenté** |
| **5xx** | `SERVER_ERROR` (ou `OVERLOADED` pour 529/« overloaded ») ; `retryable=true`, `switchable=true`, `requiresHandoff=afterFirstChunk` | retry borné puis switch | `classify.js:43,93-94` ; `router.js:113-131` | **implémenté** |
| **Timeout transport** | `TIMEOUT` si statut 408/504, code `ETIMEDOUT`… ou `/timeout|timed out/` dans le message ; `retryable=true`, `switchable=true` | retry puis switch. En pratique `code` est toujours `''` (hôte) : seul le texte « timeout » déclenche | `classify.js:35,90-91` ; `host/index.js:407-413` | **partiel** |
| **Timeout avant le premier token** | Même seau `TIMEOUT` si le message contient « timeout » ; sinon `UNKNOWN` (`retryable=true`, `switchable=false`) | retry 2× puis **blocked**, **jamais de switch** pour un message générique | `classify.js:90-103` ; `router.js:114,133-136` | **partiel** |
| **401 (auth)** | `AUTH` ; `retryable=false`, `switchable=true` | **switch** (ou handoff si sortie partielle) | `classify.js:42,83-84` ; `router.js:126-131` | **implémenté** |
| **403 (auth indisponible)** | `POLICY_REFUSAL` (`SAFETY_PATTERN` **ou** `status===403`) ; `switchable=false`, `retryable=false` | **stop**, aucune switch → une panne d'auth exprimée en 403 est traitée comme un refus de politique | `classify.js:38,74-75` ; `router.js:97-99` | **partiel / faux négatif** |
| **Modèle supprimé / inaccessible** | **aucune branche** : 404, « model not found », « model deleted » ne matchent aucun motif → `UNKNOWN` (`retryable=true`, `switchable=false`) | retry 2× puis **blocked** ; **aucun switch**. (Exception accidentelle : si `afterFirstChunk`, devient `PARTIAL_STREAM` → handoff) | `classify.js:99-103` ; `router.js:114,136` | **absent** |
| **Contexte trop grand** | `CONTEXT_OVERFLOW` ; `retryable=false`, `switchable=true`, `requiresHandoff=afterFirstChunk` | switch (ou handoff) | `classify.js:41,77-78` | **implémenté** (mais voir D9 : un `turn/end kind='max-tokens'` est marqué `done` avant d'arriver ici, `host/index.js:392-398`) |
| **Erreur de flux partiel** | `PARTIAL_STREAM` seulement si aucun motif/statut/code antérieur ne matche ; `switchable=true`, `requiresHandoff=true` | **handoff** vers la route suivante, ou **blocked** `partial_output_and_no_alt_route` | `classify.js:99-101` ; `router.js:104-111` | **implémenté** |
| **Refus politique / safety** | `POLICY_REFUSAL` ; `switchable=false`, `retryable=false` | **stop** ; `nextRoute()` n'est même pas appelé (retour avant `router.js:101`) | `classify.js:38,74-75` ; `router.js:94-99` ; test `tests/router.test.js:22-25` | **implémenté** (limite lexicale, voir D8) |
| **Échec CI / test / code** | `NOT_MODEL` (`notModel=true`) ; `switchable=false`, `retryable=false` | **stop** ; pas de switch | `classify.js:39,70-71` ; `router.js:94-96` ; test `tests/router.test.js:26-32` | **implémenté** (limite lexicale, voir D8) |

### 1.1 Preuve des deux non-déclencheurs exigés

- **Refus politique** : `classifyFailure` retourne `switchable:false` (`classify.js:74-75`) ;
  `planRoute` retourne `action:'stop'` **avant** le calcul de `nextRoute` (`router.js:97-99`,
  calcul du candidat seulement ligne 101). L'hôte traite `stop` en marquant l'assignment
  `failed` et en retournant, sans créer de session (`host/index.js:441-447`).
- **Échec CI/code** : `NOT_MODEL_PATTERN` (`classify.js:39`) → `notModel:true` (`:70-71`) ;
  première garde de `planRoute` → `stop` (`router.js:94-96`). Test dédié :
  `tests/router.test.js:26-32`.
- **Réserve honnête** : la garde est **lexicale**, pas structurelle. L'hôte passe
  `phase:'stream'` mais le classifieur ignore `phase` (`classify.js:52`), et le `kind` du
  `turn/end` n'est pas transmis. Un message d'échec de code **sans** mot-clé et survenu
  **après le premier chunk** tombe dans `PARTIAL_STREAM` (`classify.js:99-101`) →
  `requiresHandoff` → **handoff vers une autre route/provider** (`router.js:106-110`).
  Idem pour un refus politique dont la formulation ne matche pas `SAFETY_PATTERN`
  (« I cannot assist… ») : il peut être **routé autour** via un handoff. Ce n'est pas un
  `switch` silencieux de la même requête, mais c'est bien un changement de provider.
  → D8.

---

## 2. Politique et paramètres

### 2.1 Chaîne de routes persistante, explicite, avec overrides

- Chaîne **persistante** : `state.policy.routeChain`, normalisée par `normalizeRouteChain`
  (`src/contracts/model.js:148-187`), patchable via `POST /policy` (`host/index.js:716-724`),
  exposée dans `/state` (`host/index.js:73`). Défaut = **chaîne vide**
  (`model.js:135-146`, `routeChain: []`).
- **Globale uniquement.** Aucun override par projet, par tâche (chaîne) ni par rôle d'agent :
  `routeForTask` ne fait que choisir la route **initiale** depuis `task.model`, sinon
  `defaultRoute()` (`host/index.js:237-253`). `allowedWorkspaces` n'est qu'un filtre de
  lancement (`orchestrator/dag.js:85-93`), pas une politique de routes.
- La chaîne réelle du profil ne contient **qu'une route** (identique à la route courante) :
  tout échec switchable aboutit à `chain_exhausted` (voir §0).

### 2.2 Application réelle des paramètres

| Paramètre | Statut | Preuve / écart |
|---|---|---|
| Allow-list providers | **partiel** | Appliquée aux **candidats** de fallback (`router.js:30-38,56`) ; la route initiale (pin de tâche ou `defaultRoute`) n'est **jamais** vérifiée (`host/index.js:247-253`). |
| Local-only / pas de cloud pour données locales | **partiel** | Bloque seulement `local → remote` si `fromRoute.locality==='local'` **et** `allowCloudFallback===false` (`router.js:33-36`). `defaultRoute()` renvoie `{provider,model}` **sans `locality`** (`host/index.js:237-244`) → `fromLocal=false` : la garde ne s'applique pas. `normalizeRouteChain` force `locality:'remote'` par défaut (`model.js:181`). `remote → remote` n'est jamais bloqué par `allowCloudFallback`. |
| Cooldown provider | **partiel** | `nextRoute` saute un provider en cooldown (`router.js:40-44,58`) ; `recordHealth` n'est appelé qu'en cas d'échec (`host/index.js:428`) et **sans reset sur succès** ; tout échec (y compris `not_model`/`policy_refusal`) incrémente le compteur (`host/index.js:428`, `router.js:140-151`). Le cooldown expire 60 s après le **dernier** échec, mais le compteur reste ≥ seuil : le prochain échec re-endort le provider immédiatement. |
| `maxSwitches` | **absent en production** | Le routeur sait le respecter (`router.js:126,133-134`) mais l'hôte passe `assignment.switches` (`host/index.js:420`) — champ **jamais écrit** (seule occurrence dans tout `src/`) — et chaque handoff crée un **nouvel** assignment (`host/index.js:485-500`), donc le budget repart à 0. |
| `maxRetries` | **partiel** | Défaut codé en dur 2 (`router.js:91-92`) ; absent de `DEFAULT_POLICY` et de `normalizePolicy` (`model.js:135-166`) → non configurable via l'API, contrairement au commentaire « Every one is configurable » (`model.js:134`). |
| `Retry-After` | **absent en production** | `parseRetryAfter` existe (`classify.js:107-114`) mais n'est appelé que par les tests ; l'hôte ne passe jamais `retryAfterMs` (`host/index.js:407-413`) ; `planRoute.delayMs`/`cooldownUntil` ne sont **jamais consommés** (`host/index.js:448-469`) → retry immédiat. |
| Budget / quota | **partiel** | Seul `autonomyBudget.maxTasksPerHour` existe (`dag.js:96-98,133-136`, `model.js:162-164`) ; pas de budget tokens/coût (`docs/LIMITATIONS.md:18`) ; un échec `QUOTA` ne consulte aucun budget (`classify.js:80-81`). Les handoffs créent de nouveaux assignments → consomment le budget horaire. |
| Timeout d'essai | **absent** | Aucun timeout par tour/retry (l'hôte n'attend pas : `host/index.js:448-469`). Le seul timeout est HTTP Task Board 4 s (`taskboard.js:48,53-64`) ; GitHub n'en a aucun (`github.js:32`). |

### 2.3 Observabilité, boucles, escalade

- **Observable** : chaque décision est journalisée dans `state.routeEvents`
  (`host/index.js:429-439` : `from`, `to`, `action`, `reason`, `kind`) et dans le journal
  `audit.jsonl` (`route_decision`, `host/index.js:440`), exposée par `/state` (40 derniers,
  `host/index.js:80`) et le SSE. `health` est aussi exposé (`host/index.js:81`).
- **Pas visible dans l'UI** : aucun composant client ne lit `routeEvents`, `health`,
  `checkpoint`, `previousSessionId` ou `routeHistory` (`grep` sur `src/client/ui/*` et
  `src/client/app.js` : 0 occurrence). Le panneau « Orchestrator state » n'affiche que
  `sync`, `reconcileNotes` et la matrice d'adapters (`toolbar.js:83-105`).
- **Boucle infinie ?** Non : `triedRoutes` = `routeHistory.map(e => e.to)`
  (`host/index.js:416`) et `nextRoute` exclut route courante + déjà essayées
  (`router.js:50-62`). Mais la route **initiale** n'est jamais enregistrée dans
  `routeHistory` → elle peut être re-visitée une fois (A→B→A) ; et sans `maxSwitches`,
  le nombre de changements est borné par la longueur de chaîne, pas par la politique.
- **Escalade silencieuse vers un provider externe ?** Oui au sens UI : seules les entrées
  `routeChain` sont utilisées (pas de provider arbitraire), mais `remote → remote` est permis
  quel que soit `allowCloudFallback` et aucun écran n'affiche le changement (le prompt de
  handoff le dit à la session, pas à l'opérateur). Voir D7/D11.

---

## 3. Flux partiel et checkpoint

### 3.1 Erreur après le premier chunk

`afterFirstChunk` = `previews[sessionId].at >= assignment.startedAt` (`host/index.js:412`) ;
les kinds « retryables » positionnent aussi `requiresHandoff: afterFirstChunk`
(`classify.js:88,91,94,97`) ; `planRoute` traite `requiresHandoff` **avant** le retry
(`router.js:104-111`). L'hôte construit un checkpoint puis **crée une nouvelle session** sur la
route suivante (`host/index.js:471-514`) ; l'ancien assignment passe `superseded` (handoff) ou
`failed` (switch) (`host/index.js:482`). Le prompt s'intitule « CONTROLLED HANDOFF »
(`checkpoint.js:103`), cite la session précédente, le changement de route et interdit de
rejouer les effets inconnus (`checkpoint.js:104-129`). **La revendication est honnête : aucun
« resumed in the same request »** — c'est bien un handoff de tâche.

### 3.2 Contenu réel du checkpoint

`buildCheckpoint` sait capturer : `id`, `at`, `assignmentId`, `taskId`, `sessionId`,
`lastText` (800 car.), `git {head, branch, status 1200, commits ≤20, changedFiles ≤200}`,
`tests ≤30`, `actions ≤30` avec `idempotent`/`effect`, `stepsDone ≤50`, `stepsRemaining ≤50`,
`schemaVersion` (`src/recovery/checkpoint.js:30-68`).

**Mais l'hôte ne fournit que** `assignment`, `sessionId`, `lastText` (preview tronquée 600,
`host/index.js:198`), `git` (best-effort) et **`actions: []`** (`host/index.js:473-480`).
Donc en production : `tests=[]`, `stepsDone=[]`, `stepsRemaining=[]`, `actions=[]`.

| Élément requis pour bien reprendre | Capturé ? | Preuve / écart |
|---|---|---|
| Mandat / politique | **non** | absent du schéma (`checkpoint.js:41-67`) |
| Prompt d'origine / description de tâche | **non** | `handoffPrompt` n'a que `task.id` + titre (`checkpoint.js:104`) ; l'hôte ne passe qu'un task minimal `{id,title,workspaceId}` (`host/index.js:472`) |
| Décisions / historique de messages | **non** | seul `lastText` (dernier segment assistant, 600-800 car.) |
| Artefacts | **non** | aucun champ |
| Branche / worktree | **partiel** | `git.branch/head/status` si `workingDirectory` résolu (`host/index.js:385-391,473-480`) ; `git=null` sinon |
| Diff | **partiel** | seulement `git diff --name-only HEAD` (noms, pas le contenu) (`host/index.js:378`), tronqué 200 |
| Commits | **partiel** | `git log --oneline -5` (`host/index.js:377`) |
| Rapports de tests | **non** | `tests` jamais fourni (`host/index.js:473-480`) |
| Derniers effets externes | **non** | `actions: []` codé en dur (`host/index.js:478`) |
| Prochaine action | **non** | `stepsRemaining` jamais fourni |

De plus, la session reprise reçoit **uniquement** `handoffPrompt` : ni `OFFICIAL_PROMPT`
(`host/index.js:47`), ni la description/prompt de la tâche, ni les consignes `taskboard_*`
(claim, report, `in_review`). Le checkpoint ne compense pas : voir D10.

`reconcileCheckpoint` et `describeHandoff` existent (`checkpoint.js:74-91,134-142`) mais ne
sont **jamais appelés** hors tests (`grep` : seuls `tests/connectors.test.js:6,116`).

---

## 4. Effets non idempotents (commit, commentaire, push, PR/MR, delete, commande locale)

Le schéma **prévoit** la protection : `actions[{kind,target,idempotent,effect:'confirmed'|'unknown'}]`
(`checkpoint.js:56-63`), la règle « Never replay an external action whose effect is unknown »
(`checkpoint.js:126`), et `reconcileCheckpoint` liste les actions `effect='unknown' &&
idempotent=false` dans `verify` (`checkpoint.js:87-90`).

**Mais aucun de ces mécanismes n'est alimenté en production** :

- l'hôte passe **`actions: []`** en dur (`src/host/index.js:478`) : aucun outil n'est observé,
  aucune action n'est enregistrée, `effect`/`idempotent` n'ont aucune valeur réelle ;
- `reconcileCheckpoint` n'est jamais appelé (`grep` : tests uniquement) ;
- aucune réconciliation externe : pas de vérification du remote git, pas de relecture des
  commentaires Task Board, pas de vérification de PR/MR (`grep` sur `src/` : aucun appel) ;
- aucune approbation humaine avant reprise : le seul garde-fou est une **phrase dans le prompt**
  (`checkpoint.js:126`) et un rappel dans le message de retry (`host/index.js:455`).

Cas concret : une session exécute `git push` (effet commité côté remote) puis le provider tombe
avant l'ack. Le checkpoint est créé avec `actions=[]` ; la nouvelle session reçoit un prompt qui
lui dit « vérifie », mais **rien** ne lui permet de savoir qu'un push a eu lieu → replay aveugle
possible. → **D2 (P0)**. Il n'y a ni réconciliation externe ni gate d'approbation : **absent**.

---

## 5. Continuité de tâche

- **ID de tâche conservé** : `assignment.taskId` est réutilisé pour le nouvel assignment
  (`host/index.js:486-494`) et le prompt de handoff l'affiche (`checkpoint.js:104`). La carte
  native de la nouvelle session affiche aussi `taskId` (`client/ui/card.js:44`,
  `client/ui/preview.js:24`).
- **Chaîne de sessions conservée côté hôte** : le nouvel assignment porte
  `previousSessionId` (`host/index.js:496`) et `routeHistory` cumulée (`host/index.js:497`,
  `lease.js:83-85`) ; l'ancien assignment reste dans `state.assignments` et les 60 derniers
  sont exposés (`host/index.js:79`). Le schéma `Assignment` documente bien
  `previousSessionId`/`routeHistory` (`docs/CONTRACTS.md:14`).
- **Mais pas affichée** : `projection.js:378-379` expose `previousSessionId` et `routeHistory`
  sur le nœud, et **aucun** composant UI ne les lit (`card.js` signature `:13`, rendu `:41-59` ;
  `preview.js:17-37` ; `toolbar.js`) → seule la carte de la **dernière** session/provider est
  porteuse de la route courante ; le lien vers la session précédente n'est visible nulle part.
- **Pas d'état `recovering`** : ni `STATUS` (`model.js:16-24`) ni `LEASE_STATUS`
  (`lease.js:13-21`) ne le définissent. L'UI n'a qu'un libellé `resumed` pour
  `assignment.status==='interrupted'` (redémarrage), pas pour le failover
  (`strings.js:87,178` ; `toolbar.js:60-61,76-79`).
- **Message d'épuisement** : `planRoute` renvoie `blocked` avec une raison
  (`router.js:130,134,136`) ; l'hôte l'enregistre dans `routeEvents` et écrit
  `assignment.error = "no recovery: <raison>"` (`host/index.js:516-519`). Ce texte **n'est pas
  rendu** : l'UI n'affiche que l'erreur du `turn/end` de la session native
  (`client/ui/card.js:57-59`, `preview.js:50`). Aucun écran ne dit « tous les fallbacks ont
  échoué, route X → Y, raison Z ».
- **Point Task Board ignoré** : `readinessOf` ne regarde que `status==='todo'` et `dependsOn`
  vers `done` (`dag.js:43-51`) ; il **ignore `blocked` et `waitingForHuman`** du Task Board
  (`dsh-taskboard protocol.ts:905-931`). L'agent lancé, lui, peut se retrouver bloqué.

→ La tâche survit, les assignments survivent côté hôte, mais la **chaîne de reprise n'est pas
une histoire visible** et il n'y a **pas d'état `recovering`** ni de message d'épuisement
visible. **partiel**, D11.

---

## 6. Contrat de capacités des connecteurs

| Adaptateur | Déclaré | Réellement implémenté | `validatedLive` | Preuve |
|---|---|---|---|---|
| `dsh-taskboard` | `['list','get']` (`taskboard.js:88`) | `list` + `get` (via `list`) (`:92-109`) ; **aucune** méthode d'écriture ; un seul GET `/dsh-taskboard/state` (`:15,51-82`) | **`false`** dans le code (`:90`), **`true` (read)** dans `docs/CONTRACTS.md:51` | écart doc/code |
| `github` | `['list','get']` (`github.js:48`) | `list` + `get` (`:54-87`) | `false` (`:50`) | honnête |
| `gitlab`, `forgejo`, `gitea`, `bitbucket` | `[]` (squelettes, `registry.js:17-21`) | `list`/`get` = `throw not_implemented` (`adapters.js:93-97`) | `false` (`registry.js:36`) | honnête, mais voir ci-dessous |
| `jira`, `linear` | `[]` (`registry.js:22-23`) | idem squelette | `false` | honnête |
| exécuteur `dsh` | `create/observe/cancel = true`, `status=available`, `validatedLive=true` (`registry.js:39-47`) | pas d'objet adapter : c'est le binding hôte `ctx.agents` (`host/index.js:270-313`) | `true` | déclaratif, non testé live |
| exécuteurs `claude-code`, `codex`, `opencode` | tout `false`, `unavailable` (`registry.js:49-75`) | aucun | `false` | honnête |

**Faille d'honnêteté de la matrice** : `registry.describe()` calcule
`capabilities: capabilitiesOf(adapter)` (`adapters.js:126-128`), or `createSkeletonAdapter`
attache des fonctions `list`/`get` qui lèvent `not_implemented` (`adapters.js:93-97`). Donc
`/adapters` renvoie `capabilities.list=true` et `capabilities.get=true` pour GitLab/Forgejo/
Gitea/Bitbucket/Jira/Linear, alors que le contrat déclaré est `[]` et que l'UI les marque
`unavailable` (`toolbar.js:99-104`). C'est un « read-only adapter qui prétend implémenter »
une lecture. → D15.

### 6.1 Le connecteur GitHub fait-il un appel réseau ? Lit-il un credential ?

- **Aucun appel réseau au runtime de ce build** : la seule utilisation des connecteurs par
  l'hôte est `connectors.get('dsh-taskboard').list()` (`host/index.js:534,740,752`) ; `github`
  n'est jamais appelé (`grep` `get('github')` : 0). Le code d'appel existe (`github.js:26-42`).
- **Un credential est lu** : `token = process.env.GITHUB_TOKEN` est évalué **à la construction**
  (`github.js:23`), même si le connecteur est `disabled` faute de dépôt. Il n'est envoyé que
  si `list()`/`get()` est appelé et que le token est non vide (`github.js:31`).
- **Pas de timeout** (`github.js:32`), **pas de pagination** (un seul `per_page=50`, pas de
  `Link`, `:55`), **pas de gestion de rate-limit** : un 403 de rate-limit GitHub devient
  `credentials_rejected` (`:33-37`), donc un faux « credentials rejetés » et aucun
  `Retry-After`. L'en-tête du module promet « combined CI status » (`:1-8`) mais aucun appel
  CI n'existe ; `describe()` le reconnaît (`:97`). → D16.

### 6.2 Liens durables, dédupe, webhooks, pagination, conflits, second écrivain

- **Lien durable tâche ↔ session ↔ branche ↔ PR** : `Assignment` porte `taskId` + `sessionId`
  + `previousSessionId` (`lease.js:75-94`) ; la branche n'existe que dans un **snapshot**
  `checkpoint.git.branch` (`checkpoint.js:48-53`) ; **aucun champ PR/MR**, aucun lien vers un
  objet forge (`grep` : aucun). Le Task Board ne reçoit **aucune** trace de l'exécution : le
  Board lance une session `ctx.agents` nue (`host/index.js:282-311`), donc
  `taskboard_execution_report` refuse faute d'exécution liée
  (externe `host/tools.ts:1448-1449`) ; c'est le P0 déjà documenté
  (`docs/LIMITATIONS.md:10`). → D3.
- **Dédupe des tâches importées** : aucun import de tâches (GitHub/Jira/Linear jamais listés
  par l'hôte) ; la dédupe de lancement est purement en mémoire et par
  `idempotencyKey` (`host/index.js:317-320`), dont la `revision` est **toujours nulle**
  (`dag.js:167`, `taskboard.js:31`) → clé `taskboard:<id>@0#0` (constatée dans l'état réel).
  Deux hôtes concurrents ne se voient pas : chacun peut lancer une session pour la même tâche
  avant que le claim Task Board ne tranche. → D1/D13.
- **Webhooks / auth** : aucun webhook ; le GET Task Board est **non authentifié** sur la
  surface locale (externe `host/routes.ts:451-482`, commentaire `:205`) ; GitHub utilise un
  Bearer. Aucune vérification de signature. → absent.
- **Pagination / rate-limit** : Task Board renvoie tout le ledger d'un coup (pas de pagination
  nécessaire, `routes.ts:482-517`) ; GitHub : voir §6.1. → partiel/absent.
- **Détection de conflit** : le Board n'écrit jamais le ledger (`taskboard.js:84-125`) ; il ne
  compare pas `version`/`revision` avant lancement et ne fait pas de CAS : entre le `readiness`
  (`host/index.js:740-745,752-757`) et `createSession`, la tâche peut être claim/done ailleurs.
  Pas d'`ifVersion` côté Board. → absent (TOCTOU).
- **Un second registry concurrent écrit-il la vérité Task Board ?** **Non** : le registry est
  une `Map` locale (`adapters.js:100-133`) et l'adaptateur Task Board est strictement
  read-only. En revanche un second **hôte Agent Board** a son propre `state.json`
  (`host/index.js:91-92`) sans verrou inter-processus : il peut dupliquer des lancements.
  Il n'écrit pas le ledger, mais il peut créer des sessions concurrentes.

---

## 7. Tableau de synthèse (format demandé)

| Comportement | Verdict (implémenté / partiel / absent / non testable) | Preuves (path:line) | Écart | Sévérité P0/P1/P2 |
|---|---|---|---|---|
| Chaîne de routes ordonnée persistante | **partiel** | `host/index.js:73,716-724` ; `model.js:148-187` | globale seulement ; défaut vide (`model.js:144`) ; pas d'override projet/tâche/rôle ; chaîne réelle à 1 route | P2 |
| Allow-list providers | **partiel** | `router.js:30-38,56` ; `host/index.js:247-253` | route initiale jamais vérifiée | P2 |
| Local-only (pas de cloud pour données locales) | **partiel** | `router.js:33-36` ; `host/index.js:237-244` ; `model.js:181` | dépend de `locality` explicite ; `defaultRoute` n'en pose pas ; `remote→remote` toujours permis | P1 |
| Cooldown provider | **partiel** | `router.js:40-44,58,140-151` ; `host/index.js:428` | jamais reset sur succès ; pollué par échecs non-modèle | P2 |
| `maxSwitches` | **absent en production** | `router.js:126,133` ; `host/index.js:420,485-500` | compteur jamais incrémenté, remis à 0 à chaque handoff | P1 |
| `maxRetries` | **partiel** | `router.js:91-92` ; `model.js:135-166` | codé en dur, absent de la politique normalisée/API | P2 |
| `Retry-After` / backoff appliqué | **absent en production** | `classify.js:107-114` ; `host/index.js:407-413,448-469` | jamais transmis, `delayMs` jamais attendu → retry immédiat | P1 |
| Budget/quota | **partiel** | `dag.js:96-98,133-136` ; `LIMITATIONS.md:18` | tâches/heure seulement ; pas de coût ; `QUOTA` ne consulte pas le budget | P2 |
| Timeout d'essai | **absent** | `host/index.js:448-469` ; `github.js:32` ; `taskboard.js:48` | aucun timeout par tour/retry ; seul le GET Task Board a 4 s | P2 |
| Décision observable (`routeEvents` + audit) | **implémenté** (API) / **non visible UI** | `host/index.js:429-440,80` ; `toolbar.js:83-105` | aucun rendu client de `routeEvents`/`health`/`checkpoint` | P1 |
| Partial stream = handoff, pas reprise | **implémenté** | `classify.js:99-101` ; `router.js:104-111` ; `host/index.js:482` ; `checkpoint.js:103` | honnête ; dépend du texte et du timestamp de preview (non testable live) | P1 |
| Checkpoint : git/branche/commits | **partiel** | `checkpoint.js:48-54` ; `host/index.js:361-380,473-480` | `git=null` si `workingDirectory` absent ; diff en noms seulement ; 5 commits | P2 |
| Checkpoint : tests, étapes, actions, artefacts, prompt | **absent** | `checkpoint.js:41-67` ; `host/index.js:473-480` | `tests=[]`, `steps=[]`, `actions=[]` ; ni prompt/description, ni artefacts, ni décisions | P1 |
| Non-idempotence : journal d'effets + réconciliation | **absent** | `host/index.js:478` ; `checkpoint.js:87-90,126` | `actions: []` en dur ; `reconcileCheckpoint` jamais appelé ; prompt seulement | **P0** |
| Continuité de l'ID de tâche | **implémenté** | `host/index.js:486-494` ; `checkpoint.js:104` ; `card.js:44` | OK | — |
| Historique des sessions/providers visible | **partiel** | `host/index.js:79,496-497` ; `projection.js:378-379` | données exposées mais jamais rendues (`card.js`, `preview.js`, `toolbar.js`) | P1 |
| État `recovering` + raison + source/cible | **absent** | `model.js:16-24` ; `lease.js:13-21` ; `strings.js:87,178` | aucun statut ; aucun affichage du switch | P1 |
| Message d'épuisement visible | **absent** | `router.js:130-136` ; `host/index.js:516-519` | écrit dans `assignment.error`, non rendu | P1 |
| Contrat HTTP Task Board (route + enveloppe) | **implémenté / exact** | `taskboard.js:15,76-82` ; externe `routes.ts:482,508-517` | `/dsh-taskboard/state` + `{ok:true,value}` confirmés | — |
| Forme de tâche Task Board (`revision`, `claim`) | **absent / faux** | `taskboard.js:31,34,94` ; externe `protocol.ts:978,981,1093` | `rev`/`revision`/`claim` n'existent pas ; vrais champs `revision` (ledger), `version`, `claimedBy` | **P0** |
| Statuts Task Board | **compatible** | externe `protocol.ts:26-33` | pass-through, pas de validation ; statuts réels gérés par le lanceur (`todo` seul) | P2 |
| Lecture seule du ledger | **implémenté** | `taskboard.js:84-125` ; `docs/CONTRACTS.md:62-67` | aucune écriture | — |
| `validatedLive` honnête | **partiel** | `taskboard.js:90` ; `docs/CONTRACTS.md:51` | doc dit « ✅ (read) », code dit `false` | P2 |
| Matrice de capacités des squelettes | **faux** | `adapters.js:93-97,126-128` ; `registry.js:17-24` | `/adapters` annonce `list/get=true` pour des méthodes qui lèvent | P2 |
| GitHub : réseau/credential/timeout/pagination | **partiel** | `github.js:23,32,55` ; `host/index.js:534,740,752` | aucun appel runtime ; token lu même désactivé ; pas de timeout/pagination ; 403 rate-limit mal classé | P2 |
| Lien durable tâche↔session↔branche↔PR | **partiel/absent** | `lease.js:75-94` ; `checkpoint.js:48-53` ; externe `tools.ts:1448-1449` | branche en snapshot, aucun PR ; pas d'exécution Task Board → `execution_report` refusé | **P0** |
| Dédupe des tâches importées | **absent** | `host/index.js:317-320` ; `dag.js:167` | pas d'import ; clé locale `@0#0` ; deux hôtes peuvent dupliquer | P1 |
| Webhooks / auth | **absent** | `taskboard.js:51-57` ; externe `routes.ts:451-482` ; `github.js:30-31` | GET local non authentifié, Bearer GitHub, aucun webhook | P2 |
| Détection de conflit | **absent** | `host/index.js:740-757` ; `dag.js:43-51` | pas d'`ifVersion`, TOCTOU ; `blocked`/`waitingForHuman` ignorés | P1 |
| Second registry concurrent | **pas d'écriture Task Board** | `adapters.js:100-133` ; `host/index.js:91-92` | registry local ; mais état par processus → lancements concurrents possibles | P2 |
| Déclencheur « modèle supprimé » | **absent** | `classify.js:99-103` | 404 / model not found → `UNKNOWN` retry-only, jamais de switch | P1 |
| Déclencheur « 403 auth » | **faux négatif** | `classify.js:74-75` | 403 → `POLICY_REFUSAL` stop | P1 |
| Déclencheur « max-tokens / contexte » | **absent** | `host/index.js:392-398` | `kind==='max-tokens'` → `done`, jamais classifié | P1 |
| Non-déclencheurs refus/CI | **implémenté, lexical** | `classify.js:39,70-75` ; `router.js:94-99` ; tests `router.test.js:22-32` | garantie dépend du texte ; résidu `PARTIAL_STREAM` → handoff | P1 |

---

## 8. Défauts numérotés (entrée → effet erroné)

### D1 — P0 — Contrat Task Board faux : `rev`/`revision`/`claim` n'existent pas
- **Entrée** : `GET /dsh-taskboard/state` réel (`value.revision = 179`, tâche
  `version = 5`, `claimedBy` présent).
- **Effet erroné** : `ledgerRevision = state.rev` → `null` ; `task.revision` absent → `null` ;
  `task.claim` absent → `null`. La clé d'idempotence devient `taskboard:<id>@0#0` et ne
  distingue plus les révisions ; `sync.ledgerRevision` affiche `?` ; une tâche ré-ouverte ou
  re-créée n'est pas re-dispatchée (collision avec un ancien assignment non `failed`) ou est
  dédupliquée à tort ; aucune conscience du `version` Task Board. Cas re-dispatch après échec :
  `ensureAssignment` renvoie l'enregistrement existant (`host/index.js:335`) qui est ensuite
  **poussé une seconde fois** dans `state.assignments` (`host/index.js:336`) — doublon d'état,
  lease/fencing/attempt périmés réutilisés.
- **Preuve** : `src/connectors/taskboard.js:31,34,94` ; `src/orchestrator/dag.js:167` ;
  `src/host/index.js:317-320` ; contrat réel externe `protocol.ts:978,981,1088-1094` ;
  état réel `state.json` (`ledgerRevision:null`, `revision:null`, clé `@0#0`) ; fixture de
  test qui invente `rev`/`revision` : `tests/connectors.test.js:8-19,40`,
  `tests/host-integration.test.js:84`.

### D2 — P0 — Aucun journal d'effets externes : replay aveugle possible
- **Entrée** : erreur après un `push`/`comment`/`commit` dont l'ack est perdu.
- **Effet erroné** : `buildCheckpoint({ actions: [] })` (`host/index.js:478`) → le checkpoint
  ne contient aucun effet ; `reconcileCheckpoint` jamais appelé ; la session reprise ne peut
  pas savoir ce qui a été fait → rejeu possible d'un effet non idempotent. Aucune
  réconciliation externe, aucune approbation humaine.
- **Preuve** : `host/index.js:473-480` ; `checkpoint.js:87-90,126` ; `grep` de
  `reconcileCheckpoint` (tests seulement) ; `src/host/index.js:455` (rappel textuel seulement).

### D3 — P0 — Aucune exécution Task Board liée → `taskboard_execution_report` refuse
- **Entrée** : session lancée par le Board sur une tâche ; l'agent appelle
  `taskboard_execution_report`.
- **Effet erroné** : refus `forbidden` « no running execution and no settled execution of
  yours » : le Board a créé une session `ctx.agents` nue, pas une exécution Task Board.
  Le lien tâche↔session n'existe que dans `state.json` du Board, pas dans le ledger.
- **Preuve** : `src/host/index.js:282-311` (create sans exécution) ; externe
  `dsh-taskboard\src\host\tools.ts:1448-1449` ; `docs/LIMITATIONS.md:10` (déjà classé P0) ;
  `docs/CONTRACTS.md:69-71`.

### D4 — P1 — `Retry-After`/backoff calculés puis jetés
- **Entrée** : 429 avec `Retry-After: 120`.
- **Effet erroné** : `planRoute` calcule `delayMs` et `cooldownUntil` (`router.js:114-122`),
  l'hôte ne les utilise pas : il injecte immédiatement un followup (`host/index.js:452-462`),
  deux fois, puis switch. Aggrave le rate-limit ; la politique « attends Retry-After » est
  inexistante en production.
- **Preuve** : `host/index.js:407-413` (pas de `retryAfterMs`), `:448-469` (pas de délai) ;
  `classify.js:107-114` (jamais appelé hors test).

### D5 — P1 — Le classifieur ne reçoit ni statut, ni code, ni Retry-After
- **Entrée** : « 429 Too Many Requests » (sans chiffre), « read ECONNRESET » (code perdu),
  « model not found », « Forbidden ».
- **Effet erroné** : `UNKNOWN` (`retryable=true`, `switchable=false`) → retry 2× puis
  `blocked`, **jamais de switch** ; un modèle supprimé n'est jamais contourné ; un 403 auth
  est un refus de politique. Seuls les messages contenant les motifs exacts fonctionnent.
- **Preuve** : `host/index.js:407-413` (message seul) ; `classify.js:54-104` (motifs
  lexicaux) ; `classify.js:35-36` (codes jamais reçus) ; `classify.js:99-103` (UNKNOWN).

### D6 — P1 — `maxSwitches` non appliqué
- **Entrée** : politique `maxSwitches=1` (état réel), chaîne à 3 routes.
- **Effet erroné** : `assignment.switches` n'est jamais écrit (`host/index.js:420` seule
  occurrence) et chaque handoff crée un assignment neuf (`host/index.js:485-500`) → le
  routeur repart à `switches=0` ; il peut effectuer plus de switches que la politique, et
  re-visiter la route initiale (absente de `routeHistory`, `host/index.js:416,497`).
- **Preuve** : `router.js:126,133-134` (garde correcte en isolation) ; `host/index.js:420` ;
  `lease.js:75-94` (pas de champ `switches`).

### D7 — P1 — Local-only contournable
- **Entrée** : route initiale locale obtenue via `agentDefaultModel`, politique
  `allowCloudFallback=false`.
- **Effet erroné** : `defaultRoute()` renvoie `{provider, model}` sans `locality`
  (`host/index.js:237-244`) ; `isRouteAllowed` ne bloque que si `fromRoute.locality==='local'`
  (`router.js:33-36`) → `fromLocal=false` → fallback cloud autorisé pour des données locales.
  De plus `remote→remote` n'est jamais soumis à `allowCloudFallback`.
- **Preuve** : `router.js:30-38` ; `host/index.js:237-253` ; `model.js:181`.

### D8 — P1 — Refus/échec de code lexicalement raté → handoff vers une autre route
- **Entrée** : refus « I cannot assist with that » ou erreur de code sans mot-clé, survenu
  après le premier chunk.
- **Effet erroné** : `NOT_MODEL`/`POLICY_REFUSAL` non détectés → `PARTIAL_STREAM`
  (`classify.js:99-101`) → `requiresHandoff` → **handoff vers la route suivante**
  (`router.js:106-110`), c'est-à-dire un changement de provider pour un refus ou un échec
  non-modèle. La garantie « never routed around » n'est donc pas structurelle.
- **Preuve** : `classify.js:52` (`phase` non lu), `:99-103` ; `host/index.js:407-413`
  (`kind` du `turn/end` non transmis) ; test qui ne couvre que les messages contenant les
  mots-clés (`tests/router.test.js:22-32`).

### D9 — P1 — `max-tokens` marqué `done`, contexte jamais classifié
- **Entrée** : `turn/end` `reason.kind === 'max-tokens'` (contexte épuisé).
- **Effet erroné** : l'hôte marque l'assignment `done` (`host/index.js:392-398`) avant
  `classifyFailure` ; `CONTEXT_OVERFLOW` n'est jamais atteint par ce chemin, aucun switch ni
  handoff. Une tâche tronquée pour contexte est présentée comme terminée.
- **Preuve** : `host/index.js:392-398` ; `classify.js:41,77-78`.

### D10 — P1 — La session reprise perd le prompt/description et les consignes
- **Entrée** : handoff après échec.
- **Effet erroné** : `handoffPrompt` ne reçoit qu'un task `{id,title,workspaceId}`
  (`host/index.js:472`) ; le message de reprise ne contient ni `OFFICIAL_PROMPT`
  (`host/index.js:47`), ni description/prompt, ni rappel claim/report/`in_review`. Le
  checkpoint ne les contient pas non plus (`checkpoint.js:41-67`). La nouvelle session doit
  tout redécouvrir, avec un risque de sortir du protocole Task Board.
- **Preuve** : `host/index.js:472,502-503` ; `checkpoint.js:99-131`.

### D11 — P1 — Aucun état `recovering` ni histoire de switch visible
- **Entrée** : switch/handoff réussi.
- **Effet erroné** : `previousSessionId`/`routeHistory` sont dans l'API (`projection.js:378-379`)
  mais aucun composant ne les rend ; aucun statut `recovering` ; aucun affichage de la raison,
  de la route source/cible ni de l'épuisement (`assignment.error` `no recovery:` non rendu).
  L'opérateur ne voit qu'une carte `failed` et une nouvelle carte.
- **Preuve** : `model.js:16-24` ; `lease.js:13-21` ; `card.js:10-17,41-59` ;
  `preview.js:17-37` ; `toolbar.js:56-80` ; `host/index.js:516-519`.

### D12 — P1 — `readinessOf` ignore `blocked`/`waitingForHuman` et ne revalide pas au lancement
- **Entrée** : tâche `todo` mais `blocked:true` ou `waitingForHuman:true` ; ou tâche claimée
  entre le tick et `createSession`.
- **Effet erroné** : lancement d'une tâche que le Task Board interdit ; TOCTOU sans
  `ifVersion`/CAS. Le Task Board applique ces gardes dans ses tools, pas le Board.
- **Preuve** : `dag.js:43-51` (seulement `status` + `dependsOn→done`) ; externe
  `protocol.ts:905-931` ; `host/index.js:740-757` (readiness puis lancement) ;
  externe `tools.ts:1055-1061` (garde de dépendance/claim côté Task Board).

### D13 — P1 — Retry silencieusement no-op si `ctx.agents.get()` n'expose pas `followup`
- **Entrée** : 5xx sans sortie partielle.
- **Effet erroné** : `agent?.followup?.(...)` (`host/index.js:457`) : si le handle n'a pas
  `followup`, rien n'est envoyé, `assignment.retries` est incrémenté et le statut reste
  `running` → assignment bloqué « en cours » sans agent actif. Le faux `ctx.agents.get` des
  tests ne fournit que `cancel` (`tests/host-integration.test.js:60-66`), donc ce chemin n'est
  pas testé.
- **Preuve** : `host/index.js:448-468` ; `tests/host-integration.test.js:60-66`.

### D14 — P2 — `validatedLive` et la matrice de capacités ne sont pas honnêtes
- **Entrée** : `GET /adapters`.
- **Effet erroné** : `dsh-taskboard` renvoie `validatedLive:false` alors que
  `docs/CONTRACTS.md:51` affirme « ✅ (read) » ; les squelettes renvoient
  `capabilities.list/get=true` via `capabilitiesOf` (`adapters.js:126-128`) parce que
  `createSkeletonAdapter` attache des `fail` fonctions (`adapters.js:93-97`).
- **Preuve** : `taskboard.js:90` ; `docs/CONTRACTS.md:51` ; `adapters.js:28-34,93-97,126-128`.

### D15 — P2 — GitHub : honnêteté partielle, réseau jamais exercé
- **Entrée** : activation du connecteur GitHub.
- **Effet erroné** : token lu à la construction même désactivé (`github.js:23`) ; pas de
  timeout (`:32`) ; pas de pagination (`:55`) ; un 403 de rate-limit devient
  `credentials_rejected` (`:33-37`) ; l'en-tête promet le statut CI (`:1-8`) absent du code.
  Aucun appel n'est fait par l'hôte (aucun call site).
- **Preuve** : `github.js:23,26-42,55,97` ; `host/index.js:534,740,752` (seul Task Board).

### D16 — P2 — Budget et comptabilité
- **Entrée** : handoffs successifs; échec `QUOTA`.
- **Effet erroné** : chaque handoff crée un assignment `startedWithinHour` → consomme
  `maxTasksPerHour` (`dag.js:96-98,133-136`) ; pas de budget coût ; un `QUOTA` switch vers un
  provider potentiellement plus cher sans comptabilité (`classify.js:80-81`).
- **Preuve** : `dag.js:96-98,133-136` ; `host/index.js:485-500` ; `LIMITATIONS.md:18`.

### D17 — P2 — Le failover est inerte dans l'installation réelle
- **Entrée** : politique réelle (une seule route, identique à la route du modèle).
- **Effet erroné** : sur échec switchable, `nextRoute` ne trouve aucun candidat →
  `chain_exhausted` → `blocked` après retries. Aucun switch possible. La chaîne par défaut est
  vide (`model.js:144`), donc hors configuration manuelle le failover n'existe pas.
- **Preuve** : `state.json` réel (`routeChain` 1 entrée) ; `router.js:50-62,126-136` ;
  `model.js:135-146`.

### D18 — P2 — Tests : fixtures hors contrat et couverture failover surestimée
- **Entrée** : `node --test tests/` (69/69).
- **Effet erroné** : les fixtures inventent `rev`/`revision` (`tests/connectors.test.js:8-19`,
  `tests/host-integration.test.js:84`) et ne testent pas la forme 0.10.2 ; aucun test hôte pour
  `retry`, `switch` (seul le handoff après chunk est couvert,
  `tests/host-integration.test.js:210-230`), `maxSwitches`, `Retry-After`, cooldown ou
  reprise après refus. Le vert ne prouve pas le contrat.
- **Preuve** : `tests/connectors.test.js:13,40` ; `tests/host-integration.test.js:84,182-242` ;
  `README.md:122` (« 53 tests » alors que 69).

---

## 9. Ce que je n'ai pas pu vérifier

1. **Forme réelle d'un `turn/end` en erreur DSH** : statut HTTP, code transport, en-tête
   `Retry-After` sont-ils dans `reason.error.message` ? Aucune panne réelle provoquée ;
   `routeEvents=0` et `health={}` dans l'état réel. Toute la matrice de déclenchement reste
   **non testable live**.
2. **`assistant/message` est-il émis pour un flux partiel interrompu ?** L'heuristique
   `afterFirstChunk` dépend d'un événement de message complet (`host/index.js:194-200,412`) ;
   je n'ai pas pu vérifier qu'un flux cassé en milieu de chunk laisse une preview.
3. **`ctx.agents.get(sessionId)` expose-t-il `followup` ?** Non vérifié ; le fake de test ne
   l'expose pas (`tests/host-integration.test.js:60-66`), donc D13 est plausible mais
   non prouvé contre le vrai service.
4. **Absence exhaustive de `dsh-llm-fallbacks`** : absence confirmée dans le profil, ses
   `node_modules`, les lockfiles et les répertoires du runtime ; `app.asar` (213 Mo) n'a pas
   été décompressé, donc un bundle interne non décompressé reste théoriquement possible.
5. **Version exacte du binaire DSH** : seule la compatibilité déclarée (0.2.2-rc.1) et la
   dépendance de profil sont prouvées ; le `package.json` du runtime n'est pas lisible
   (asar).
6. **Comportement réel de la reprise** : aucune session de handoff réelle n'a été observée ;
   aucune preuve que la session reprise claim correctement la tâche, ni que
   `taskboard_execution_report` échoue réellement (le code Task Board le dit, le chemin réel
   n'a pas été exercé).
7. **Concurrence multi-hôte** : deux processus Agent Board simultanés n'ont pas été lancés ;
   la duplication de lancement est déduite du code (état local, pas de verrou).
8. **Isolation/worktree et lien branche** : non appliquée par le Board
   (`LIMITATIONS.md:14`), donc aucun lien tâche↔worktree↔branche réel n'a pu être observé.
9. **Capacité de l'exécuteur `dsh`** (`validatedLive:true`, `registry.js:45`) : non testée
   dans cet audit ; seul un lancement réel ancien est mentionné dans le README.
10. **Le P0 « exécution Task Board »** est confirmé par le code des deux côtés, mais je n'ai
    pas rejoué le scénario de bout en bout (pas d'appel `taskboard_execution_report` réel).

---

## 10. Note de méthode

- Lectures complètes : `src/routing/classify.js`, `src/routing/router.js`,
  `src/recovery/checkpoint.js`, `src/connectors/registry.js`, `src/connectors/taskboard.js`,
  `src/connectors/github.js`, `src/contracts/adapters.js`, `src/contracts/model.js`,
  `tests/router.test.js`, `tests/connectors.test.js`, `tests/host-integration.test.js`,
  `docs/CONTRACTS.md`, `docs/LIMITATIONS.md`, `README.md`, ainsi que les points d'appel hôte
  (`src/host/index.js`), la projection et l'UI.
- Vérité externe : `dsh-taskboard/package.json`, `src/shared/protocol.ts`,
  `src/host/routes.ts`, `src/host/tools.ts`, `src/shared/dependencies.ts`, le ledger réel
  `C:\Users\barat\.dsh\dsh-taskboard.json`, l'état réel `C:\Users\barat\.dsh\agent-board\state.json`
  et `audit.jsonl`.
- Aucune exécution de scénario de panne ; aucun test modifié ; aucun fichier source modifié.
