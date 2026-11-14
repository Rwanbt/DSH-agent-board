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

Restent à raccorder : `schedule`, `push_branch`, `merge`, `protected_branch_write`, `delete_task`, `secrets`, `policy_change`. Les cases ne seront pas simplement déclarées fonctionnelles sans leurs effets réels et leurs contrôles.
