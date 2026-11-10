# Audit UX/UI — Agent Board (DSH 0.2.2-rc.1)

> Date : 09/11/2026, 22:50–23:20 (Europe/Paris). Audit **sans modification du code applicatif** : seuls ce rapport, des wireframes SVG et des captures de preuve ont été ajoutés sous `docs/ux-audit/` (non commités).
> Légende : **[V]** observation vérifiée (rendu réel ou code lu), **[H]** hypothèse, **[R]** recommandation.

---

## 0. Contexte et réserves préalables

- **[V] Capture utilisateur absente.** Aucune image n'est jointe à la demande de cet audit. La « capture fournie » n'a donc pas pu être examinée ; l'audit confronte le code au **rendu réel** du profil `desktop` (`http://127.0.0.1:62337`), capturé par Playwright.
- **[V] Copie de travail partagée et modifiée par un autre agent.** Pendant l'audit, la copie `D:\App\DSH-agent-board` est passée sur la branche `fix/agent-board-runtime-e2e` (session « GOAL 2 — AGENT BOARD » et ses 6 sous-agents), avec des modifications non commitées sur `src/board/view.js`, `src/client/core.js`, `src/supervisor/projection.js`, `src/contracts/model.js`, `src/host/*`, `src/orchestrator/*`. Le plugin étant installé **par lien**, le rendu audité inclut ces modifications en cours. Le dossier `docs/audit/` appartient à cet autre agent ; ce rapport est volontairement dans `docs/ux-audit/`.
  **Conséquence pour l'implémentation :** aucune refonte UI ne doit démarrer avant que GOAL 2 soit commité ou isolé (worktree dédié), sinon conflit garanti sur `view.js`/`core.js`/`projection.js`.
- **[V] Mobile = viewport simulé uniquement** (Chromium desktop, `pointer: fine`, pas de toucher réel, pas de vrai clavier virtuel ; le « clavier » est simulé par une hauteur réduite à 450 px). Aucune affirmation « testé sur téléphone ».
- **[V] Vault Obsidian** : `D:\Documents\Obsidian\IA_Dev_Brain\projects\dsh-agent-board\` (INDEX, BOARD, AGENTS, `operations/sessions/2026-11-09-dsh-agent-board-mvp.md`, modifiés le 09/11 à 22:03). Ils documentent le MVP (liste de 74 sessions, ancien UI) ; **aucune décision de design** n'y figure. Le MCP Obsidian était injoignable (« Unable to connect ») : lecture directe des fichiers.

---

## 1. Synthèse exécutive

L'arborescence par projet fonctionne (filtrage d'attention, filiation, aperçu/ouverture vérifiés), mais l'interface **ne ressemble pas encore à une page native DSH** et **gaspille l'espace** :

1. **P0 – Mobile inutilisable en l'état** : à 390×844, la barre d'outils occupe **313 px (37 % de la hauteur)**, la première carte commence à y = 456 ; clavier ouvert (hauteur 450), **aucune carte n'est visible**. Les champs font 12 px (zoom iOS forcé), **27/35 cibles < 44 px**.
2. **P0 – Non-conformité à la charte DSH** : graisses 550–700 (charte : ≤ 500), bordures 1 px (charte : hairline 0,5 px), rayons hors échelle (10 px, 14 px), `:hover` hors `@media (hover: hover)`, pastilles `999px` sans `corner-shape: round`, tailles 11/12/12,5 px hors rôles typographiques (13 px = taille ligne/détail établie).
3. **P1 – Zones mortes** : surface couverte par les cartes = **22 % à 1280, 19 % à 1366, 9 % à 1920, 5 % à 2560**. La grille de projets en colonnes fixes (`minmax(560px,1fr)`) crée de larges vides à droite des arbres et sous les petites familles.
4. **P1 – Double/triple encadrement** : projet → tuile (`bg-layer-1` + bordure) → carte (`bg-base` + bordure). Une racine sans enfant est une carte dans un cadre, sans raison.
5. **P1 – Lisibilité** : titres coupés à une ligne (« Fix StateStore durabili… ») alors que la carte a la hauteur pour deux ; branches à peine visibles ; contrôle « ▾ 6 » cryptique.
6. **P1 – Barre d'outils surchargée** : 13 contrôles visibles sur 2 lignes (3 à 1280 px), dont des filtres secondaires toujours exposés.

**Recommandation : direction C « Hybride adaptative »** (rail de projets + canevas d'arbre + inspecteur ; mobile en 2 niveaux), réalisée en 5 lots sans régression fonctionnelle, après stabilisation de GOAL 2.

---

## 2. Inventaire du code réellement concerné

| Fichier | Rôle | Constats |
|---|---|---|
| `scripts/build-client.mjs` | Concatène 12 modules ESM dans `src/client.js` (pas de bundler) | Pas de CSS Modules possibles en l'état ; noms globaux au bundle |
| `src/client/ui/styles.js` | Tout le CSS (≈ 190 lignes) injecté via `<style id="dsh-agent-board-style">` | N'utilise pas le builtin officiel `styles.insert()` ; voir §3 |
| `src/client/app.js` | `AgentBoardPage` : état UI (localStorage `dsh-agent-board:ui:v2`), ResizeObserver (`narrow ≤ 720 px`), arbiter clic, rendu | Bascule mobile pilotée par JS **et** par `@container dab (max-width:720px)` — deux sources de vérité |
| `src/client/ui/toolbar.js` | `DabToolbar` (compteurs, recherche, select projet, 3 filtres, 2 vues, historique, mode, stop, refresh) | 13 contrôles, aucun regroupement ; `DabExecutionList`, `DabOrchestratorState` |
| `src/client/ui/tree.js` | `DabProjectGroup`, `DabAgentTree` (tuile), `DabTreeBranch` (`ul/li` récursif), `DabCompactProject` | Connecteurs en pseudo-éléments CSS (`::before/::after`), géométrie figée à `top:24px` |
| `src/client/ui/card.js` | `DabAgentCard` (`React.memo` + signature) | 210 px (enfant) / 250 px (racine), titre 1 ligne, pied de carte conditionnel |
| `src/client/ui/preview.js` | Inspecteur 340 px (desktop) / bottom sheet 62 % (étroit) | Pas de poignée, pas de piège de focus, pas de fermeture par geste |
| `src/client/ui/history.js` | Tiroir 460 px, recherche + pagination 30 | `autoFocus` du champ → ouvre le clavier sur mobile (contraire à la charte) |
| `src/client/ui/strings.js` | fr/en, statuts | — |
| `src/board/view.js`, `src/supervisor/projection.js` | Modèle pur (filtrage, tri, agrégats, statuts) | **En cours de modification par GOAL 2** |

**Composants DSH réutilisés : aucun.** [V] Le loader client n'expose au plugin que `ctx`, `React`, `host`, `styles`, `console` (inspect `Builtin.listBuiltins`) : les `ui-primitives` (Button, SegmentedControl, Menu, MenuSurface, Tooltip…) ne sont **pas importables** par un plugin externe. Seuls les **tokens CSS** et les **services** (`uiWorkspace.openSession`, `layout`) sont partagés.

---

## 3. Conformité à la charte officielle DeepSeek

Sources lues : [web-styling.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.md), [dsh-client-ui-ux SKILL](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-client-ui-ux/SKILL.md), [ui-radius.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/ui-radius.md), [dsh-responsive-ui SKILL](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/skills/dsh-responsive-ui/SKILL.md). Les README `ui-theme`, `ui-primitives`, `ui-layout` sont référencés par ces documents ; les valeurs ont été **lues sur le thème réellement chargé** (variables calculées sur `body`).

### 3.1 Tokens disponibles localement [V]

| Famille | Tokens (valeurs en sombre) |
|---|---|
| Surfaces | `bg-base`, `bg-layer-1`, `bg-layer-2`, `bg-overlay`, `settings-card-fill` (#2c2c2e), `specific-sidebar-fill` |
| Texte | `label-primary`, `label-secondary`, `label-tertiary` (#adb2b8) |
| Bordures | `border-l1`…`border-l4`, `settings-card-stroke` (#fff3) |
| Élévation | `--dsw-elevation-panel/prominent/soft/stroke` (incluent le hairline 0,5 px) |
| États | `state-warn-primary` #f59e0b, `state-success-primary` #22c55e, `state-error-primary` #f25a5a, `state-idle-primary` #545557, `state-business-primary` #7aaaff, `state-done-primary` #a78bfa, + `-secondary/-tertiary` |
| Interaction | `interactive-bg-hover`, `-hover-danger`, `button-*-fill/hover`, `link` |
| Typo | `--dsw-font-xs-13` (13/20 400), `xs-strong-13` (500), `s-14`, `s-strong-14`, `m-18` (500 16/28), `l-20` (500 20/28), `base-16` |
| Rayons | `--dsw-radius-xs 4`, `sm 8`, `md 12`, `lg 16`, `xl 20`, `panel 28` |

**Écart doc en ligne / version locale [V]** : la doc mentionne un `SegmentedControl` R12/R8 et des primitives non exposées aux plugins ; `--dsw-alias-fill-*` et `label-quaternary` sont déclarés mais **vides** localement ; aucune variable de durée/easing (`--dsw-motion-*`) n'est exposée en 0.2.2-rc.1 → les durées doivent rester locales et courtes. `brand-primary` vaut **#f9fafb en sombre** (presque blanc) et quasi noir en clair : l'anneau « en cours » est donc monochrome, ce qui est cohérent avec les indicateurs natifs du compositeur (cercles gris « 16 % », « 53 % »).

### 3.2 Écarts constatés dans `styles.js` [V]

| Règle charte | État Agent Board | Gravité |
|---|---|---|
| Graisse ≤ 500 dans le CSS de feature | 550, 600, 650, 700 (titre, noms, pastilles, libellés) | P0 |
| Bordure neutre = 0,5 px | 1 px partout (cartes, tuiles, boutons, champs) | P0 |
| Rayons sur l'échelle `--dsw-radius-*`, selon le rôle | littéraux 6, 8, 10, 12, 14, 999 ; carte R10 (hors échelle) | P0 |
| Cercles/capsules : `corner-shape: round` | absent | P2 |
| `:hover` sous `@media (hover: hover)` | `.dab-card:hover`, `.dab-btn:hover`, `.dab-pill:hover`… hors condition | P1 |
| Élévation **sans** bordure neutre | bottom sheet/tiroir : `border-left/top` + `box-shadow` maison | P1 |
| Typo : rôles du thème, 13 px pour lignes/détails | 11, 12, 12,5, 13, 14, 15 px littéraux | P1 |
| Pas de couleur littérale | `color-mix(... black 14%)` pour les ombres | P2 |
| Pas d'ouverture automatique du clavier mobile | `inputRef.focus()` à l'ouverture de l'Historique | P1 |
| Champ ≥ 16 px sous `(pointer: coarse)` | 12 px | P1 |
| Barre de défilement partagée | onglets mobiles avec barre visible (`scrollbar-width: thin`) | P2 |
| Styles via le builtin plugin | `<style>` injecté à la main au lieu de `styles.insert()` | P2 |

Référence native comparée [V] : la page **Plugins** (`evidence/audit-native-plugins.png`) : colonne de contenu centrée à largeur maîtrisée, titre 20/28 500 + sous-titre, `SegmentedTabs`, lignes 13–14 px sans cadres imbriqués, actions primaires en haut à droite. Agent Board est plein écran, encadré deux fois, et plus « gras ».

---

## 4. Hiérarchie et organisation de l'information

| Question utilisateur | Réponse actuelle [V] | Évaluation |
|---|---|---|
| Quels projets ont des agents actifs ? | Titre de groupe + compteurs (points) | Lisible mais dispersé dans une grille 1–3 colonnes ; pas de vue synthétique |
| Qui travaille, quels sous-agents ? | Arbre horizontal, enfants à droite | Bon principe ; branches trop pâles (`border-l2` 1 px sur fond `layer-1`) |
| Qui attend une intervention ? | Pastille jaune + bordure de carte | **Non remonté en tête** : un agent en attente dans un projet bas de page reste invisible |
| Qui vient de terminer ? | Pastille verte | OK ; seul le compteur global le signale |
| Lien session/tâche | `taskId` dans la méta (rare) | OK |
| Où cliquer ? | Carte entière (clic/double-clic) + bouton ↗ au survol | Affordance faible : rien n'indique le double-clic ; ↗ invisible tant qu'on ne survole pas |

Constats spécifiques [V] :
- **Colonnes** : `grid-template-columns: repeat(auto-fill, minmax(560px,1fr))` → 1 colonne à 1280/1366, 2 à 1920, 3 à 2560. Chaque cellule fait 735–1050 px alors qu'un arbre à 2 niveaux mesure ≈ 520 px et une racine seule 270 px.
- **Ordre** : DSH-agent-board (8 agents) occupe toute la hauteur gauche tandis que les colonnes voisines contiennent une seule carte — les hauteurs de groupes ne s'équilibrent pas (grille, pas masonry).
- **Profondeur** : seule la profondeur visible compte ; pas de zoom, pas de recentrage. À > 3 niveaux, la tuile défile horizontalement **dans** la tuile (scroll imbriqué).
- **Densité** : 11 cartes visibles sur 143 sessions (attention) — la politique de filtrage est bonne ; c'est la **mise en page** qui gaspille.
- **Historique** : tiroir séparé, recherche + pagination : conforme à l'intention.

---

## 5. Matrice d'audit (rendu réel, viewport simulé)

| Viewport | Thème | Barre d'outils | 1re carte (y) | Couverture cartes | Débordement page | Constat principal |
|---|---|---|---|---|---|---|
| 1280×720 | sombre | **148 px (3 lignes)** | ≈ 207 | 22 % | non | « Rafraîchir » seul sur sa ligne ; 2e projet sous la ligne de flottaison |
| 1366×768 | sombre | 88 px | ≈ 150 | 19 % | non | Grand vide à droite des arbres |
| 1920×1080 | clair & sombre | 88 px | ≈ 150 | 9 % | non | 2 colonnes déséquilibrées |
| 2560×1440 | sombre | 88 px | ≈ 150 | **5 %** | non | ≈ 70 % de la surface vide |
| 430×932 | sombre | 228 px | 371 | — | non | Onglets projets + select redondants |
| 390×844 | sombre | **313 px** | **456** | — | non | 6 rangées de contrôles avant le contenu |
| 360×800 | sombre | 313 px | 456 | — | non | Le tiroir natif DSH recouvre le panneau (comportement DSH, pas du plugin) |
| 844×390 (paysage) | sombre | 162 px | 219 | — | non | Une seule carte visible |
| 390×450 (« clavier ») | sombre | 313 px | **456 > hauteur** | — | non | **Aucune carte visible** |
| Zoom 80 % / 150 % (1366) | clair | — | — | — | non (mesuré) | OK |
| `prefers-reduced-motion` | sombre | — | — | — | — | Anneau figé, seul « running » animé (mesuré) |

Cibles tactiles : 27/35 contrôles < 44 px à 390 px (mesure `getBoundingClientRect`). `pointer: coarse` = faux en simulation → les règles tactiles de la charte n'ont **pas** pu être déclenchées.

---

## 6. Défauts classés (avec preuves)

### P0 — bloquants avant validation visuelle
| # | Défaut | Preuve |
|---|---|---|
| P0-1 | Mobile : contrôles = 37 % de l'écran, contenu masqué avec clavier | `evidence/audit-m390.png`, `audit-kbd.png`, mesures §5 |
| P0-2 | Graisses > 500, bordures 1 px, rayons hors échelle (non natif) | `styles.js` (`.dab-title 650`, `.dab-name 600`, `.dab-card border 1px / radius 10px`…) |
| P0-3 | Aucune remontée globale des **attentes jaunes** : un agent en attente dans un projet hors écran reste invisible | tri par projet puis par tier (`view.js`), pas de bande d'attention |

### P1
| # | Défaut | Preuve |
|---|---|---|
| P1-1 | Zones mortes 78–95 % à ≥ 1366 px | §5, `audit-1920x1080.png`, `audit-2560x1440.png` |
| P1-2 | Cadres imbriqués (groupe → tuile → carte), racine seule encadrée | `audit-1366x768.png` |
| P1-3 | Titres tronqués à 1 ligne, titre complet uniquement en `title=` (inaccessible au toucher) | carte « Fix StateStore durabili… » |
| P1-4 | Barre d'outils : 13 contrôles, 3 lignes à 1280 px | `audit-1280x720.png` |
| P1-5 | Contrôle de branche « ▾ 6 » / « ▾ − » cryptique ; deux pastilles (« +4 masqués », « ▾ 4 ») pour une même notion | `audit-2560x1440.png` |
| P1-6 | `:hover` non conditionné → états collants au toucher ; ↗ invisible sans survol sur desktop | `styles.js` |
| P1-7 | Historique : focus auto → clavier mobile ; champ 12 px → zoom iOS **[H]** | `history.js` |
| P1-8 | Mobile : bandeau d'onglets projets + select projet + titre de projet = triple redondance | `audit-m390.png` |
| P1-9 | Branches peu contrastées (1 px `border-l2` ≈ #ffffff1f en sombre) | captures sombres |

### P2
| # | Défaut |
|---|---|
| P2-1 | Pas de `corner-shape: round` sur pastilles/points |
| P2-2 | « État orchestrateur et adaptateurs » occupe toute la largeur en pied de page |
| P2-3 | Bottom sheet sans poignée ni geste de fermeture ; pas de gestion du focus à l'ouverture/fermeture |
| P2-4 | Double logique responsive (ResizeObserver JS + container query CSS) |
| P2-5 | `<style>` manuel au lieu de `styles.insert()` |
| P2-6 | Statut « basculement de modèle » (`routeHistory`) non affiché sur la carte ; « bloqué » non distingué de « attente » |

---

## 7. Animations et états

| État | Actuel [V] | Conforme ? | Recommandation [R] |
|---|---|---|---|
| En cours | anneau CSS 0,9 s, `brand-primary` (monochrome) | Oui | Conserver ; 1 s linéaire ; figé en mouvement réduit (déjà le cas) |
| Attente humaine | point `warn-primary` + halo + bordure jaune | Oui (bordure d'état autorisée) | Ajouter la bande d'attention globale |
| Terminé non lu | point `success-primary` + halo | Oui | Conserver |
| Terminé lu | point `state-idle-primary` | Oui | Conserver |
| Échec | losange `error-primary` (plein si non vu, contour si vu) | Oui | Conserver ; message 1 ligne |
| Inconnu | cercle pointillé | Oui | Conserver |
| Bascule de modèle | non affiché | — | Icône discrète `↻` + `state-business-primary`, détail dans l'inspecteur |
| Bloqué | confondu avec « attente » | — | Uniquement si une source native existe ; sinon ne pas l'inventer |

Micro-interactions [R] : ouverture de branche = fondu 120 ms + translation 4 px (aucune animation de hauteur) ; changement de statut = transition de couleur 150 ms ; sélection = contour 2 px instantané ; inspecteur = glissement 160 ms ; zoom/pan sans inertie. Tout désactivé sous `prefers-reduced-motion`. Pas de halo pulsant permanent, pas de flou.

---

## 8. Performances

Analyse du code [V] (avant les modifications GOAL 2 en cours) :

| Point | Comportement | Risque |
|---|---|---|
| Notifications natives | coalescées à 1 / 200 ms (`core.js`) | faible |
| Reconstruction | `buildProjection` + `aggregateSubtrees` **complets** à chaque notification | O(n) ; mesuré < 25 ms pour 230 nœuds (test unitaire) |
| Vue | `buildBoardView` recalculée à chaque nouvelle projection (identité change toujours) | O(n) |
| Rendu | `DabAgentCard` mémoïsé par signature ; branches non mémoïsées | réconciliation O(cartes visibles) |
| Horloge | `nowBucket` chaque minute → re-rendu de toutes les cartes (l'âge change) | faible |
| Historique | calculé seulement quand le tiroir est ouvert ; 30 par page | faible |
| Écouteurs | désinscription au `destroy` ; EventSource fermé ; ResizeObserver déconnecté | OK |
| Perte d'état | sélection/scroll gardés en mémoire module ; UI en localStorage | OK |

Projection par volume [H, extrapolation de la mesure] : 5–20 agents : négligeable ; 50 : OK ; 150 agents actifs visibles : ~150 cartes DOM + pseudo-éléments, rendu OK mais lisibilité nulle → le **plafond doit être UX** (≈ 25–30 cartes visibles), pas technique ; plusieurs centaines d'historiques : sans impact tant qu'ils restent hors vue.

[R] Mémoïser par projet (clé = signature des statuts du projet) ; rendre les connecteurs en **SVG par famille** calculé depuis les rectangles mesurés (1 `<path>` par famille au lieu de 3 pseudo-éléments par carte) ; `content-visibility: auto` sur les familles hors écran ; aucune bibliothèque de graphe.

---

## 9. Trois directions de refonte (wireframes = **propositions**, pas des captures)

### A. Arbre minimaliste — `wireframes/A-arbre-minimaliste.svg`
- **Layout** : barre d'outils sur 1 ligne (titre, compteurs, recherche, « À traiter ▾ », « Orchestrateur ▾ ») ; un seul canevas ; projets = libellés de section, **sans tuile** ; familles en flux *masonry* (largeur intrinsèque).
- **Cartes** : racine 240×64 R16, enfant 210×44 R12, titre 2 lignes max, statut à gauche.
- **Volumes** : enfants calmes résumés par une carte fantôme « +N terminés ».
- **Mobile** : même flux en vertical. **Avantages** : changement minimal, très épuré. **Compromis** : pas de vue synthétique des projets ; attentes toujours dispersées. **Difficulté** : faible.

### B. Carte de projets → familles — `wireframes/B-carte-projets.svg`
- **Layout** : rangée de cartes projet (matériau settings-card R20) avec mini-pastilles d'état ; la famille du projet sélectionné s'affiche dessous.
- **Volumes** : excellents (un projet à la fois). **Mobile** : naturellement en 2 niveaux.
- **Compromis** : on ne voit plus plusieurs familles simultanément sur desktop ; un clic de plus. **Difficulté** : moyenne.

### C. Hybride adaptative (recommandée) — `wireframes/C-hybride-adaptative.svg`
- **Desktop ≥ 1100 px** : barre d'outils 1 ligne · **bande d'attention** (attentes jaunes et échecs, tous projets, cliquables) · **rail de projets** à gauche (≈ 200 px, compteurs, « Tous » par défaut) · **canevas** des familles en *masonry* sans cadres imbriqués, avec **zoom −/+ et « recentrer »** quand une famille dépasse · **inspecteur** à droite (élévation `panel`, R28 côté contenu).
- **720–1100 px** : rail replié en select compact ; inspecteur en surcouche.
- **Mobile < 720 px** : **Niveau 1** = liste de cartes projet (R16, ≥ 56 px, compteurs, chevron) ; **Niveau 2** = famille d'un projet en arbre vertical, enfants repliables ; toucher une carte = **bottom sheet** d'aperçu avec bouton « Ouvrir la session » ; jamais de double-tap obligatoire ; barre d'outils réduite à titre + recherche (icône) + menu ⋯.
- **Avantages** : réunit A (épure) et B (vue projet), traite P0-1/P0-3, exploite les grands écrans. **Compromis** : plus de code UI ; zoom/pan à rendre accessible (boutons + clavier, pas uniquement molette). **Difficulté** : moyenne-élevée, découpable.

Éléments à reprendre : de **A** les cartes fantômes « +N » et l'absence de tuiles ; de **B** le matériau de carte projet pour le niveau 1 mobile.

---

## 10. Recommandation

**Direction C**, car c'est la seule qui (1) remonte les attentes humaines quel que soit le projet (P0-3), (2) rend le mobile utilisable par la navigation à 2 niveaux (P0-1), (3) supprime les zones mortes sur grands écrans, tout en conservant l'arbre généalogique et les interactions validées (clic = aperçu, double-clic/Entrée = ouvrir, bouton explicite au toucher).

Spécification de carte [R] :
- Racine : 240 px, hauteur ≈ 64 px, `--dsw-radius-lg`, fond `settings-card-fill`, bordure 0,5 px `settings-card-stroke` ; enfant : 210 px, ≈ 48 px, `--dsw-radius-md`.
- Titre : `--dsw-font-xs-strong-13` (500), **2 lignes** puis ellipse, titre complet dans l'inspecteur ; méta : `--dsw-font-xs-13` en `label-secondary` (rôle · modèle · âge).
- Statut : 14×14 à gauche du titre ; bordure d'état réelle seulement pour attente/échec.
- Action « Ouvrir » toujours visible en `(hover: none)`, au survol/focus sinon.
- Branches : SVG 1 px `border-l3`, coudes à angle droit, rayon 4 px.

---

## 11. Plan d'implémentation progressif (après validation)

Pré-requis : GOAL 2 commité/mergé ou travail dans un **worktree** `feat/agent-board-ux-c` à partir d'un SHA stable.

| Lot | Contenu | Fichiers | Risque |
|---|---|---|---|
| L1 Conformité charte | graisses ≤ 500, hairlines 0,5 px, rayons tokens, rôles typo, `@media (hover:hover)`, `corner-shape`, `styles.insert()` | `ui/styles.js`, `app.js` | faible, visuel seulement |
| L2 Barre d'outils | 1 ligne ; filtres/vue/historique dans un menu « Affichage ▾ » ; orchestrateur dans « Orchestrateur ▾ » (mêmes boutons, mêmes appels) | `ui/toolbar.js` | moyen (régression contrôles) |
| L3 Canevas desktop | suppression des tuiles, masonry, cartes 2 lignes, connecteurs SVG, bande d'attention, rail projets | `ui/tree.js`, `ui/card.js`, nouveau `ui/rail.js`, `ui/attention.js` ; `board/view.js` (+ `attentionItems()` pur) | moyen |
| L4 Mobile 2 niveaux | niveau projets / niveau famille, bottom sheet accessible, pas d'autofocus, champs 16 px en `coarse` | `app.js`, `ui/preview.js`, `ui/history.js` | moyen |
| L5 Zoom/recentrage | − / + / 100 % / recentrer sur sélection, clavier (`+ - 0`), transform CSS, désactivable | nouveau `ui/canvas.js` | moyen ; optionnel |

Chaque lot : tests unitaires existants verts, captures avant/après comparables, aucun changement de `projection.js` sauf ajout de fonctions pures.

---

## 12. Tests à réaliser après validation

- **Unitaires** : `attentionItems()` (tri jaune > rouge > vert, tous projets), layout masonry pur si extrait, arbiter inchangé.
- **E2E Playwright (scénarios enregistrés dans le dépôt)** : 1280×720, 1366×768, 1920×1080, 2560×1440, 360×800, 390×844, 430×932, paysage 844×390 ; clair/sombre ; zoom 80/150 % ; `reduced-motion` ; assertions : pas de débordement horizontal, barre d'outils ≤ 1 ligne desktop / ≤ 96 px mobile, première carte au-dessus de 40 % de la hauteur, clic = aperçu sans navigation, double-clic = 1 ouverture, chevron sans navigation ni accusé de lecture, Entrée/Espace.
- **Tactile réel** : appareil Android/iOS via « Accès mobile » DSH (non fait ici).
- **Accessibilité** : axe-core / Lighthouse (contraste `label-secondary` sur `settings-card-fill`, rôles `tree/treeitem`, focus visible, ordre de tabulation, piège de focus de la bottom sheet).
- **Performance** : trace Chrome avec 30 actifs + 200 historiques (fixture), FPS pendant streaming, mémoire après 30 min, nombre de rendus par seconde (`store.getStats()`).

---

## 13. Points non vérifiés et causes exactes

| Point | Cause |
|---|---|
| Capture utilisateur | non jointe à la demande |
| Toucher, gestes, vrai clavier virtuel | viewport Chromium simulé, `pointer: fine` |
| README `ui-primitives` / `ui-layout` / `ui-theme` détaillés | seuls web-styling, ui-radius et les deux SKILL ont été lus en entier ; les valeurs de thème ont été lues sur l'instance |
| Redimensionnement d'une vraie fenêtre Windows DSH Desktop | audit via navigateur Playwright sur l'URL Web, pas via la fenêtre Electron |
| Thème clair à toutes les tailles | clair vérifié à 1366/1920 (captures GOAL 1) ; audit principal en sombre (préférence active) |
| Contraste chiffré (WCAG) | pas d'audit axe/Lighthouse exécuté |
| Rendu stable | l'UI auditée inclut des modifications non commitées d'un autre agent (GOAL 2) |
| Statut « bloqué » / bascule de modèle en réel | aucun cas présent dans les données live |

---

## Annexes

- Preuves : `docs/ux-audit/evidence/` (captures réelles du 09/11/2026, profil `desktop`).
- Wireframes (propositions, non des captures) : `docs/ux-audit/wireframes/A-arbre-minimaliste.svg`, `B-carte-projets.svg`, `C-hybride-adaptative.svg`.

**Fin de l'audit. Aucune modification de code n'est engagée ; en attente de validation de la direction.**
