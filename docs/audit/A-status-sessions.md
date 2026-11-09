# Audit A — Sessions, vérité d'état, read-state, intégrité de l'arbre, dernier message

## Base de vérité

| Élément | Valeur | Statut |
|---|---|---|
| Dépôt | `D:\App\DSH-agent-board` | vérifié |
| Branche | `fix/agent-board-runtime-e2e` | vérifié (`git rev-parse --abbrev-ref HEAD`) |
| HEAD | `75b40d8` (GOAL 1 UX validée) | vérifié (`git rev-parse --short HEAD`) |
| Worktree | propre (aucune modification avant audit) | vérifié (`git status --porcelain` vide) |
| Baseline de tests | `node --test tests/` → **69 tests, 69 pass, 0 fail**, 533 ms, node v26.13.0 | **re-vérifiée pendant cet audit** (la baseline annoncée 69/0 est exacte) |
| Périmètre lu intégralement | `src/contracts/model.js`, `src/supervisor/projection.js`, `src/board/view.js`, `src/board/interaction.js`, `src/client/app.js`, `src/client/core.js`, `src/client/ui/{card,tree,preview,history,toolbar}.js`, `tests/{projection,board-view,interaction,client-core}.test.js`, `tests/fixtures/sessions.js` | vérifié |
| Contexte hôte complémentaire (lecture seule, pour tracer les abonnements et la persistance) | `src/host/index.js`, `src/orchestrator/journal.js`, `src/client/ui/strings.js`, `tests/journal.test.js` | vérifié |
| Hors audit | `src/client.js` (artefact généré par `scripts/build-client.mjs`), CSS | déclaré |

Convention : `fichier:ligne` + fonction. Les fixtures sont explicitement synthétiques (`tests/fixtures/sessions.js:1-9`) : toute conclusion qui dépend d'une forme d'événement réelle est marquée **NON TESTABLE / à vérifier sur instance**.

---

## Tableau principal

| Comportement | Verdict | Preuves (path:line, fonction) | Écart constaté | Sévérité |
|---|---|---|---|---|
| Source `sessions.list` (snapshot) | implémenté | `src/client/core.js:93-96` (`bind`, `sessions.list.subscribe`), `src/client/core.js:106-109` (`compute`, `getSnapshot`), `src/supervisor/projection.js:285-318` (`buildProjection`) | Aucun | — |
| Source `uiSession.sessionStatus` | partiel | `src/client/core.js:98-101` (abonnement), `src/supervisor/projection.js:46-54` (`statusEntryOf`), `:338` | Côté hôte cette source n'existe pas : `src/host/index.js:190` n'écoute que `session/event`, donc l'hôte ne connaît ni `pendingInteraction` ni `completionUnread` | P1 |
| Source `workspaces.list` / appartenance de session | partiel | lu `src/client/core.js:113-115`, indexé `src/supervisor/projection.js:227-243` (`indexWorkspaces`) | **Aucun abonnement** : `bind` (`src/client/core.js:89-103`) n'abonne que `sessions` et `uiSession` → un changement d'appartenance/dossier/renommage d'espace ne provoque aucun rebuild | P2 |
| Flux hôte SSE `/api/v2/events` | **absent (cassé)** | émission `src/host/index.js:130` (`broadcast`) et `:676` : `event: state` ; réception `src/client/core.js:163-165` : `stream.onmessage` | Un événement SSE nommé (`event: state`) ne déclenche jamais `onmessage` (qui ne reçoit que le type `message`). Le flux est mort : aucun fait hôte n'arrive en direct | **P0** |
| Source `ctx.on('session/event')` | implémenté (hôte uniquement) | `src/host/index.js:190-221` : `assistant/message` `:194-202`, `turn/end` `:203-211`, `turn/start` `:212-217` | Seul canal hôte ; le client n'y a aucun accès et dépend du SSE (cassé) ou d'un refetch manuel | P0 (via SSE) |
| Rafraîchissement de l'état hôte | partiel | `src/client/core.js:141-157` (`refreshHost`), appelé au démarrage `:227` et après chaque POST `:189` ; bouton `src/client/app.js:231` | Le store se décrit comme piloté par événements (« never polls », `src/client/core.js:10-13`) mais n'est en pratique rafraîchi qu'au démarrage, après un POST, ou à la main | P1 |
| Dérivation depuis `updatedAt` / temps écoulé | conforme | `updatedAt` seulement porté `src/supervisor/projection.js:375`, tri `src/board/view.js:49`, filtre « récents » `src/board/view.js:106-109`, âge affiché `src/client/ui/strings.js:238-247` | Aucun statut n'est dérivé du temps (exigence respectée, test `tests/projection.test.js:67-71`) ; en revanche l'âge départage le tri, donc la visibilité sous `treeLimit` | P2 |
| Vocabulaire des statuts | partiel | `src/contracts/model.js:16-24` (7 valeurs), libellés `src/client/ui/strings.js:217-229` | Manquent `recovering` et `unavailable` ; `unknown` est étiqueté « Inconnu / déconnecté » (`strings.js:39`, `:130`) alors qu'il n'est émis que si la ligne est absente | P1 |
| Ordre de priorité `classifyStatus()` | implémenté | `src/supervisor/projection.js:93-112` : unknown (94) → waiting_user (95) → running (96) → failed (98) → finished_read/unread (99-103) → completionUnread (104) → native failed (107) → native finished_read (109) → unknown (110) → idle (111) | `failed` est testé **après** `running` : une session dont `running` reste vrai (crash, déconnexion) masque un échec pourtant enregistré | P1 |
| Provenance `turnEnd.at/kind/error` | implémenté | écrit `src/host/index.js:203-211` ; lu `src/supervisor/projection.js:97-103`, `:360`, `:368` | — | — |
| Provenance `turnEnd.recoveredAt` | partiel | écrit `src/host/index.js:212-217` ; utilisé `src/supervisor/projection.js:98` | N'exprime aucun état : il ne fait que **supprimer** `failed`. Aucun statut « récupération en cours » | P2 |
| Provenance `ack.seenAt` | implémenté | écrit `src/host/index.js:711` ; lu `src/supervisor/projection.js:100-101`, `:360` | — | — |
| Provenance `ack.lastTurnEnd` | **mort** | écrit `src/host/index.js:711` ; **aucune lecture** dans `src/` (seule autre occurrence : `projectionValues.mobilePushLifecycle.lastTurnEnd`, `src/supervisor/projection.js:114`) | Le curseur de lecture est réduit à un horodatage ; la notion « ack = ce tour précis » est écrite mais jamais exploitée | P2 |
| Provenance `nativeTurnEnd` (`mobilePushLifecycle.lastTurnEnd`) | implémenté | `src/supervisor/projection.js:114-120` (`nativeTurnEndOf`), `:106-109` | Une erreur native (hôte absent) produit `failed` mais `seen = true` → invisible (défaut 2) | P0 |
| Transitions d'état | partiel | `src/supervisor/projection.js:93-112` + écritures `src/host/index.js:190-217`, `:708-715` | Aucune transition vers `unknown` une fois la ligne connue ; aucun état `recovering` / `unavailable` ; `failed` n'a pas d'axe lu/non-lu (seul un booléen `seen` rapporté) | P1 |
| Chemin d'acquittement UI → POST → hôte → disque | implémenté | `src/client/ui/card.js:97` → `src/board/interaction.js:47-56` → `src/client/app.js:154-158` + `:133-136` → `src/client/core.js:202` → `src/host/index.js:708-715` → `touch()` `:146-150` → `saveSoon()` `:119-126` → `src/orchestrator/journal.js:66-75` | Le POST est bien tracé jusqu'au fichier | — |
| Persistance de `acks` au refresh / redémarrage | implémenté (fragile) | `src/host/index.js:74` (`publicStateOf`), `src/orchestrator/journal.js:39-63` (`init`, fusion `{...defaults, ...parsed}`), écriture `journal.js:66-75` | Perte possible si le process meurt dans la fenêtre de debounce de 600 ms (`host:119-126`) ; `acks` n'est jamais borné (croissance illimitée) | P2 |
| Pilule verte garantie jusqu'à ack explicite | **absent** | `src/orchestrator/journal.js:91-107` (`compactState`, `maxTurnEnds = 400`, appelé à chaque `touch()` `host:147`) + `src/supervisor/projection.js:109` | L'éviction du `turnEnd` d'une session fait retomber son statut sur `finished_read` (via `nativeTurnEndOf`) **sans aucun ack** : la pilule disparaît seule | P1 |
| Ack sur la branche `completionUnread` | absent | `src/supervisor/projection.js:104` (testé après la comparaison d'ack `:99-103`) + `src/host/index.js:711` | Si le runtime fournit `completionUnread`, l'ack n'a **aucun effet** : la pilule est ineffaçable | P1 (atteignabilité à vérifier) |
| Ack par simple sélection (clic simple / Espace) | implémenté (sémantique contestée) | `src/client/app.js:154-158` (`selectNode` → `acknowledge`), `src/client/ui/card.js:62` (Espace), `src/board/interaction.js:51-56` | « Consulter la carte » (250 ms après un clic, sans ouvrir la session) vaut « lu » définitivement ; aucune route de désacquittement n'existe (`src/host/index.js:708` est la seule écriture de `acks`) | P1 |
| Consultation native hors board | absente | `src/host/index.js:190-221` n'observe que les événements de tour ; `src/host/index.js:708-715` est le seul écrivain de `acks` | Ouvrir/lire une session depuis l'UI DSH native ne la marque pas lue pour le board : la pilule verte ment dans l'autre sens | P1 |
| Nouveau tour après lecture → de nouveau non lu | implémenté si `turnEnd` observé | `src/supervisor/projection.js:99-103` (`seenAt >= end.at`) | Si l'hôte rate le `turn/end` (restart, `reason` chaîne → `kind:'unknown'`), le nouveau tour reste `finished_read` (`:109`) | P1 |
| Filtre d'accueil par défaut | implémenté | `src/client/app.js:25-27` (`filter: 'attention'`), `src/board/view.js:19`, `:128`, `:25-32` (`isAttention`), `:102-111` | — | — |
| Vieille session déjà consultée sur l'accueil | conforme | `src/board/view.js:30-31` (ni `finished_read` ni `idle` ne sont « attention »), test `tests/board-view.test.js:19-37` | Pollution uniquement via le filtre explicite « Récents 24 h » (`view.js:106-109`) | P2 |
| Priorité de l'agent en attente (jaune) quel que soit l'âge | partiel | rang 0 `src/board/view.js:37-41`, aucun filtre de date `:105-110`, remontée par `bestTier` `:197-202`, enfants urgents jamais coupés `:164-171` | Coupé par `DEFAULT_TREE_LIMIT = 8` arbres/projet (`src/client/ui/tree.js:95` + `src/client/app.js:247`), par un projet plié persistant (`app.js:243-246` + `:49-54`), par un ancêtre replié (`view.js:162`), par le mode étroit un-projet (`app.js:122-123`) | P1 |
| Tiroir historique / ce qui masque une carte | implémenté | `src/client/ui/history.js:11-51`, `src/board/view.js:267-279` ; masquage : filtre `view.js:102-111`, `blank` `:104`, pli `:162`, `treeLimit` `:95`, `childLimit` `:133` + `:164-171`, mode étroit `app.js:122-123` | Un sous-agent calme n'est pas listé dans le tiroir sauf recherche (`view.js:273`) ; pas de filtre « non lus » dans le tiroir | P2 |
| Doublon `sessions.list` + `subagentCatalog` | conforme | `src/supervisor/projection.js:296-305` (`ensureNode` par id), test `tests/board-view.test.js:66-67` | Dédoublonné par id ; un désaccord catalogue/`parentId` est tranché silencieusement en faveur de la ligne (`:343-345`) | P2 |
| Session renommée | partiel | `src/supervisor/projection.js:267-273` (`titleOf` : `subagent.label` prioritaire) | Un renommage natif (`src/host/index.js:296`, `title.rename`) reste invisible pour un sous-agent dont le label est figé | P2 |
| Orphelin (ligne parente absente) | conforme | `src/supervisor/projection.js:390` (`orphan`), `:404` (`isRoot`) | Promu racine et signalé, jamais perdu | — |
| Parent dont le tour est fini, enfant actif | conforme | `src/board/view.js:177` (`groupActive`), test `tests/board-view.test.js:92-102` | Le parent n'est pas affiché « running » ; pas de faux « terminé » pour l'enfant | — |
| Petit-enfant / profondeur ≥ 3 | conforme | `src/supervisor/projection.js:401-411`, `tests/board-view.test.js:65-90` | — | — |
| Deux catalogues revendiquent le même enfant | partiel | `src/supervisor/projection.js:316` (`if (!catalogParentOf.has(entry.id))`) | Le second parent perd l'enfant sans aucun signal (compteur `children` silencieusement faux) | P2 |
| Membre `agentTeam.members` sans ligne ni catalogue | absent | `src/supervisor/projection.js:327-333` (`roleOf` seulement) | Aucun nœud n'est créé : l'agent est invisible du board | P2 |
| Précédence `previewOf()` | implémenté | `src/supervisor/projection.js:184-206` : hôte `:187-190` → `turnOutline` `:191-200` → checkpoint `:201-204` → vide `:205` | — | — |
| Segment mi-tour (streaming) | partiel | `src/supervisor/projection.js:194-199` (`isOpenTurn` n'exclut le dernier tour que si `running`), écriture `src/host/index.js:194-200` (écrase `previews` à chaque `assistant/message`) | Si `running` est faux (pause `waiting_user`, ligne stale) le dernier segment partiel est certifié « final » | P1 |
| Tour terminé en erreur | absent | `src/supervisor/projection.js:188` ne consulte ni `end.kind` ni `ERROR_TURN_KINDS` (`src/contracts/model.js:49`) | Un segment partiel d'un tour échoué est présenté comme réponse finale (`final: true`) | P1 |
| Message vide / absence de final | conforme | `src/supervisor/projection.js:187`, `:196`, `:205` ; `src/client/ui/preview.js:15`, `:52-53` | Affiche « Pas encore de réponse finale. » | — |
| Fuite de données internes dans l'aperçu | partiel | `src/contracts/model.js:110-127` (`textOfContent` ramasse tout `.text`), `src/host/index.js:198` (600 car.), `:74-75` (`previews` servis sans filtre de workspace), `src/orchestrator/journal.js:66-75` (écrits sur disque) ; erreurs provider brutes `host:206` → `card.js:58`, `preview.js:50` | Texte assistant de toutes les sessions exposé et persisté ; messages d'erreur fournisseur affichés tels quels | P1/P2 |

---

## Défauts défendables depuis le code

### 1. P0 — Le flux SSE hôte n'est jamais reçu : l'état hôte ne vit pas en direct
`src/host/index.js:130` (`broadcast`) et `src/host/index.js:676` (`GET /events`) écrivent des trames **nommées** : `event: state\ndata: {...}`. Le client s'abonne avec `stream.onmessage = …` (`src/client/core.js:164`), or `onmessage` ne reçoit que le type SSE par défaut `message` ; un événement `state` exige `addEventListener('state', …)`. Conséquence : `host` n'est mis à jour que par `refreshHost()` (`core.js:141-157`), appelé au démarrage (`:227`) et après un POST réussi (`:189`).
**Reproduction** : panneau ouvert, aucune action utilisateur ; une session termine un tour → `sessions.list` notifie → `bump()` (`core.js:81-87`) → `compute()` (`:105-126`) avec l'ancien `host.turnEnd` → `classifyStatus` saute `:99` (pas de `turnEnd`), saute `:104`, lit `nativeTurnEndOf` et retourne `finished_read` (`projection.js:109`). La carte reste grise, le compteur « non lus » reste à 0 ; la pilule verte n'apparaît qu'après un clic sur « Rafraîchir ». Le commentaire `core.js:10-13` (« never polls… arrives through EventSource ») est donc faux en pratique.
**Preuve que le test ne couvre pas** : `tests/client-core.test.js:101-114` appelle `created.onmessage(...)` à la main, ce qui ne modélise pas un événement nommé.

### 2. P0 — Un échec connu seulement du natif est marqué « vu » et devient invisible
`src/supervisor/projection.js:360` :
`seen: status === STATUS.FAILED ? (Number(ack?.seenAt) >= Number(turnEnd?.at ?? Infinity) || turnEnd === null) : …`
Si le seul indice d'échec est `projectionValues.mobilePushLifecycle.lastTurnEnd.reason = 'error'` (hôte redémarré, événement manqué), `turnEnd` est `null` → `seen = true`. Alors `isAttention()` (`src/board/view.js:30`) est faux, `boardCounts().failed` ne l'incrémente pas (`view.js:239`), et `node.error` reste `null` (`projection.js:368` ne lit que `turnEnd.error`) : la carte est retirée de l'accueil **et** ne peut afficher aucune raison (`card.js:57-59`).
**Reproduction** : `{ row: { projectionValues: { mobilePushLifecycle: { lastTurnEnd: { turn: 1, reason: 'error' } } } }, turnEnd: null, ack: null }` → `status: failed`, `seen: true`, `error: null`, absent de la vue « À traiter ». La fixture `failed-new` (`tests/fixtures/sessions.js:73`) porte un `turnEnd` d'hôte, donc le cas n'est jamais testé.

### 3. P0 — `previewOf()` certifie « final » un texte qui n'a pas clos le tour
`src/supervisor/projection.js:187-190` n'exige que : texte non vide, `!running`, et `turnEnd.at >= preview.at`. Deux cas de fausse certitude :
- **a) segment intermédiaire promu final** : l'hôte écrase `previews[id]` à chaque `assistant/message` (`src/host/index.js:194-200`), y compris un segment « je vais appeler un outil… ». Si le tour se termine sans nouveau message assistant (abandon, erreur après outil, `turn/end` seul), `end.at (T2) >= preview.at (T1)` est vrai → ce segment intermédiaire est affiché comme « Dernière ligne de la réponse finale » (`preview.js:16`, `:53`), alors que `projection.js:176-181` promet le contraire.
- **b) tour en erreur** : `:188` ne teste jamais `end.kind` ; un tour `kind: 'error'` avec un segment partiel antérieur renvoie `final: true`, en contradiction avec le statut `failed` affiché juste au-dessus (`preview.js:44`).
**Reproduction (b)** : `{ running:false, previews:{ p:{ text:'partiel', at:42 } }, turnEnd:{ p:{ at:50, kind:'error', error:'boom' } } }` → `preview = { text:'partiel', final:true, source:'host' }`.

### 4. P1 — La pilule verte n'est pas garantie jusqu'à l'ack : `compactState` évince les `turnEnd`
`src/orchestrator/journal.js:100-107` supprime les `turnEnd` au-delà de 400 entrées (les plus anciens d'abord), et `src/host/index.js:147` appelle `compactState(state)` à **chaque** `touch()`. Une session non lue mais ancienne perd donc son `turnEnd` ; `classifyStatus` retombe sur `nativeTurnEndOf` et renvoie `finished_read` (`projection.js:109`), donc `unread: false` (`:370`) et disparition de l'accueil (`view.js:29`), **sans aucun ack**. `acks` n'est pas compacté (aucune borne dans `journal.js:91-107`) : le curseur survit mais l'événement qu'il devait couvrir a disparu. Le test `tests/journal.test.js:73-83` vérifie l'éviction sans `acks` ni statut, donc l'interaction n'est pas couverte.

### 5. P1 — L'ack est sans effet sur la branche `completionUnread`
`src/supervisor/projection.js:104` est évalué **après** la comparaison d'ack (`:99-103`), qui exige un `turnEnd.at` fini. Si le runtime signale `completionUnread: true` et que l'hôte n'a pas de `turnEnd` pour cette session, `POST /ack` écrit bien `acks[id].seenAt` (`src/host/index.js:711`) mais le statut reste `finished_unread` : la pilule ne s'éteint jamais, aucun chemin de code ne la réconcilie. Atteignabilité dépendante du runtime (**NON TESTABLE ici**), mais l'absence d'effet est prouvée par l'ordre des branches.

### 6. P1 — Un simple clic (ou Espace) acquitte définitivement
`src/client/app.js:154-158` : `selectNode` appelle `acknowledge` ; `src/board/interaction.js:51-56` déclenche `onSelect` 250 ms après un clic simple, et `src/client/ui/card.js:62` sur Espace. Un clic pour **inspecter** la carte écrit donc `acks[id]` (`host:711`) et fait passer la session en `finished_read` (`projection.js:100-101`) alors que la session n'a jamais été ouverte. Aucune route ne permet d'annuler (`host:708` est le seul écrivain). Conséquence : le seul signal « à traiter » est irréversible et dépend d'un geste qui n'est pas une consultation.

### 7. P1 — La lecture faite hors du board n'est jamais observée
L'hôte n'écoute que les événements de tour (`src/host/index.js:190-221`) ; `acks` n'est écrit que par `POST /ack` (`:708-715`). Ouvrir la session depuis l'UI DSH native, ou la lire dans un autre client, laisse la carte verte indéfiniment. Symétriquement, `completionUnread` du natif (seule source de « lu » côté runtime) n'est consommé qu'en repli (`projection.js:104`) : les deux modèles de lecture ne sont pas synchronisés.

### 8. P1 — La priorité « en attente » n'est pas garantie au-delà de 8 arbres par projet
`src/client/ui/tree.js:95` (`project.trees.slice(0, treeLimit)`) avec `treeLimit = ui.treeLimit[project.id] ?? DEFAULT_TREE_LIMIT` (`app.js:247`, `DEFAULT_TREE_LIMIT = 8` dans `view.js:22`). Les racines sont triées par `bestTier` puis `sortAttention` (`view.js:197-202`), dont le départage est `updatedAt` décroissant (`view.js:49`) : avec 8 racines en attente plus récentes, une 9e racine en attente **plus ancienne** est reléguée derrière « Afficher N arbre(s) de plus ». S'y ajoutent un projet plié persistant en `localStorage` (`app.js:243-246`, `:49-54`) et un ancêtre replié (`view.js:162`). Le compteur du projet (`tree.js:83`) signale la présence, mais la carte jaune n'est pas visible — contrairement à l'exigence « jamais masqué parce que vieux ».

### 9. P1 — Aucun état `unavailable` / `recovering` ; un `running` périmé est cru indéfiniment
`STATUS` (`src/contracts/model.js:16-24`) n'a ni `recovering` ni `unavailable`. `classifyStatus` teste `row?.running === true || live?.running === true` (`projection.js:96`) **avant** `failed` (`:98`) et sans aucun garde-fou temporel (interdit par ailleurs). Une session dont le runtime laisse `running: true` après un crash, ou une session déconnectée (`sessions.list.phase !== 'ready'`), reste « En cours » pour toujours. La phase est pourtant disponible dans le snapshot client (`src/client/core.js:123`) et **jamais lue** par l'UI (seule occurrence dans `src/client/`).

### 10. P1 — Un `turn/end` dont `reason` est une chaîne est classé « terminé », pas « échoué »
`src/host/index.js:204-206` : `const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'`. `src/supervisor/projection.js:117-119` accepte explicitement les deux formes (`end.reason` chaîne **ou** `end.reason.kind`). Si le runtime émet `reason: 'error'` (forme tolérée côté projection), l'hôte enregistre `kind: 'unknown'` : `ERROR_TURN_KINDS` (`model.js:49`) ne matche pas, le tour est traité comme terminé (`projection.js:99-101`) → `finished_unread` puis `finished_read`. L'asymétrie des deux parseurs est prouvée ; la forme réelle de l'événement est **NON TESTABLE** ici.

### 11. P2 — Deux sources d'échec se contredisent, l'hôte gagne silencieusement
`projection.js:98` (hôte) est évalué avant `:107` (natif) ; `:99-103` (hôte « terminé ») est évalué avant `:107` (natif « erreur »). Un `turnEnd` hôte `completed` masque un `lastTurnEnd.reason = 'error'` natif, et inversement un `recoveredAt` (`host:215`) supprime l'échec même si le nouveau tour n'a rien produit. Aucune règle de précédence n'est documentée ni testée.

### 12. P2 — `workspaces.list` n'est pas abonné
`src/client/core.js:89-103` n'abonne que `sessions.list` et `uiSession.sessionStatus` ; `workspaces.list` est seulement lu à chaque `compute()` (`:113-115`). Attacher une session à un espace, renommer un espace ou changer son dossier ne déclenche aucun rebuild tant qu'aucun événement de session ne survient : la carte reste dans « Non attribué » ou sous l'ancien titre.

### 13. P2 — `acks` non borné, état complet rediffusé et persisté
`src/host/index.js:74-75` inclut `acks` et `previews` entiers dans **chaque** réponse `/state` et chaque trame de `broadcast` (`:130`), et `journal.js:66-75` écrit tout le document sur disque. `acks` n'a aucune borne (`journal.js:91-107` ne compacte que `previews`, `turnEnd`, `audit`) : croissance monotone du document, et texte assistant (600 car./session) de **toutes** les sessions exposé sans filtre de workspace ni de projet.

### 14. P2 — Renommage de sous-agent invisible
`src/supervisor/projection.js:268-269` : `projectionValues.subagent.label` est prioritaire sur `displayTitle`. Un renommage natif (`src/host/index.js:296`, `title.rename(session, …)`) modifie `displayTitle` et reste masqué pour tout sous-agent porteur d'un label.

### 15. P2 — Perte silencieuse d'un enfant revendiqué par deux catalogues
`src/supervisor/projection.js:316` : `if (!catalogParentOf.has(entry.id)) catalogParentOf.set(entry.id, parentId)` — le premier catalogue parcouru gagne (ordre de `Object.keys(projectionsBySession)`, `:313`). Le second parent affiche un `totalChildren` (`:402`) inférieur à la réalité, sans avertissement ; `roleOf` (`:327-333`) peut même attribuer un rôle venant d'un troisième parent.

---

## Ce que je n'ai pas pu vérifier

1. **La forme réelle des événements natifs** (`turn/end.data.reason` objet vs chaîne, présence de `completionUnread`, `pendingInteraction`, `mobilePushLifecycle.lastTurnEnd`, `userQuestions.active`, `plan.pending`) : les fixtures sont déclarées synthétiques (`tests/fixtures/sessions.js:1-9`) et l'API live répond **401 unauthorized** (`GET /dsh-agent-board/api/v2/state`), sans session authentifiée disponible pour inspecter une trame.
2. **Le comportement effectif d'`EventSource` sur `event: state`** : le défaut 1 est établi par la spécification SSE et par le code, mais je n'ai pas pu l'observer dans le navigateur (instance protégée, pas de profil authentifié).
3. **La présence effective de `uiSession.sessionStatus` / `completionUnread`** dans la version DSH déployée : le code les consomme, aucun test ne les injecte autrement que par une `Map` fabriquée (`tests/fixtures/sessions.js:83`).
4. **Le comportement de `uiWorkspace.openSession`** (`src/client/app.js:141-146`) côté natif : savoir s'il marque la session lue dans le runtime est hors dépôt.
5. **La forme des parts de contenu assistant** (reasoning / `tool_result` porteurs de `.text`) : `textOfContent` (`model.js:110-127`) accepterait n'importe quel `.text`, donc une fuite de raisonnement ou de JSON d'outil est possible mais non démontrable sans un événement réel.
6. **Le nombre réel de sessions du profil** (> 400 `turnEnd`) qui rend le défaut 4 atteignable : non mesurable sans accès à `state.json` de l'instance.
7. **Le contenu déjà présent dans `%DSH_HOME%/agent-board/state.json`** (présence d'`acks` d'une exécution antérieure) : accès non vérifié.
8. **Le rendu/CSS** (anneau animé, tons) : hors périmètre de cet audit (seul `tests/board-view.test.js:192-198` l'effleure).
