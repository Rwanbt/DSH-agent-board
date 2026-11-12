# Corrections de l’audit permissions et autonomie

Date : 13 novembre 2026 (Europe/Paris). Référence : `9cd8d33` + ce lot. Suite complète : **627/627**.

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
| A10 — reset niveau/modèle impossible | **Corrigé côté API et niveau** | `null` explicite réinitialise l’héritage ; l’éditeur de modèle projet reste limité à l’affichage + reset de l’override existant. |
| A11 — dry-run différent du vrai lancement | **Corrigé partiellement** | Le dry-run partage `preflightLaunch` (mandat, doublon, délégation) + backend. La réservation/écriture reste évidemment exclusive au lancement réel. |

## Sémantique retenue

- `deny` : jamais exécuté ; aucune demande.
- `ask` : exécution uniquement après accord humain lié à l’opération exacte.
- `auto` : exécuté automatiquement dans le mandat ; les actions critiques gardent L4 + accord.
- Le niveau plafonne l’automatisation : L2 peut demander une action non critique sous son seuil automatique ; L1 ne peut pas exécuter ; L0 observe.
- Les booléens historiques restent lus comme `deny`/`auto` (compatibilité). Les modes explicites sont conservés.

## Preuves exécutées

- `node --test tests/` : **627 tests, 627 passés**.
- `node scripts/build-client.mjs` : bundle 24 modules cohérent avec ses modules.
- `node --check src/host/index.js`, `node --check src/client.js`.
- `node scripts/smoke-host.mjs` : OK.
- Nouveaux tests ciblés : `tests/approval-intents.test.js`, `tests/host-security.test.js`, `tests/mandate-tristate.test.js`, régressions A05–A08 et héritage dans `tests/goal6-superagent-host.test.js`, tri-état/pagination dans `tests/cockpit-superagent.test.js`.

## Risques et limites restants

1. **Aucune recette live authentifiée.** L’API GUI sans authentification répond 401 ; aucune session navigateur n’a été pilotée. Les parcours sont prouvés par tests de route avec des doubles, pas contre l’instance DSH réelle.
2. **Contrats DSH inspectés pour 0.2.2-rc.2.** Le confinement (`setup`, `tools.restrict`, `permissionPresets`) est vérifié par fixtures reproduisant ces contrats. Une version différente peut refuser la création du cerveau/worker : ce sera visible et fail-closed, pas silencieux.
3. **Modèle worker non éditable** dans l’inspecteur (hors périmètre de ce lot). Le reset d’un override existant est proposé ; l’édition complète demanderait une décision produit.
4. **Actions non implémentées** (`merge`, `push_branch`, `open_pr`, `secrets`, etc.) restent déclarées indisponibles pour le cerveau. Les routes manuelles forge existantes ne sont pas concernées.
5. **Le dry-run** partage le préflight de lancement mais ne prouve pas la création effective de session ni les écritures Task Board.
6. **Idempotence du vault** : `vault.py check` reste rouge sur une génération d’un autre projet (`projects/ravum-flow/BOARD.md`), donc pas de commit/push du vault.

## Fichiers principaux

- Contrat : `src/contracts/mandate.js` (modes tri-état, héritage).
- Décisions : `src/superagent/decisions.js` (intentions, opérations, anti-rejeu).
- Hôte : `src/host/index.js` (patch routier, préflight, exécution approuvée, capacités).
- Confinement : `src/host/security.js`.
- Client : `src/client/core.js`, `src/client/app.js`, `src/client/ui/{inspector,hierarchy,strings,superbar}.js`, bundle régénéré.
