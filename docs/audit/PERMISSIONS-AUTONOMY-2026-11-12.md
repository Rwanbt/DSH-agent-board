# Audit — permissions, autonomie et Super Orchestrateur

Date : 12 novembre 2026. Référence : commit `9cd8d33`. Audit du dépôt, sans modification fonctionnelle ni du profil.

## Verdict

**Le produit ne peut pas encore être qualifié d’entièrement autonome et fonctionnel.** Les fondations (mandat restrictif, ordonnanceur, limites, Stop, reprise, connecteur) sont testées, mais les parcours configuration → autorisation → accord humain → exécution comportent des ruptures. Certaines permissions sont un vocabulaire de politique, pas une capacité exécutable du Super Agent.

L’erreur signalée est un défaut client/serveur reproductible, pas une mauvaise manipulation de l’utilisateur. Il ne faut ni retirer les contrôles de portée, ni transformer L4 en accès illimité pour la corriger.

### Périmètre et niveau de preuve

- Lecture croisée UI, store, contrat de mandat, routes Host, cerveau et décisions, exécution et intégrations ; deux audits indépendants UI et moteur.
- `node --test tests/` : **594 tests, 594 réussis**, aucun ignoré. Tests ciblés des auditeurs : 52 et 33 réussis, inclus dans cette base, pas des tests supplémentaires.
- Reproductions locales de fonctions pures et des corps de requêtes ; les observations statiques ne sont pas des exploits démontrés sur l’installation.
- GET sans authentification sur l’URL existante `/dsh-agent-board/api/v2/state` : **401 unauthorized**. Respect de cette barrière ; aucun contournement. L’inspection Config rapporte l’entrée `include:dsh-agent-board` avec statut `absent` : cela ne prouve pas à lui seul que le plugin ou la page n’existe pas.
- Pas de navigateur piloté, de vérification visuelle de la GUI, de lancement réel de tâches utilisateur ni de test destructif forge/secrets. La correspondance exacte dépôt/version déployée et la configuration effective restent à vérifier dans la GUI authentifiée.

## Constats prioritaires

### A01 — P1 : les cases de permission échouent avec les portées normales — reproduit

Sources : [client/core.js:401–411](../../src/client/core.js#L401-L411), [mandate.js:524–545](../../src/contracts/mandate.js#L524-L545), [route Host:4005–4009](../../src/host/index.js#L4005-L4009).

`setAction` renvoie `scopeMode`, mais ni `selectedWorkspaces` ni `allConsent`. Le serveur valide le scope déclaré dans le patch avant la fusion avec l’existant :

- `selected` → `selected_scope_requires_workspaces`, même si des projets sont déjà sélectionnés ;
- `all` → `all_scope_requires_confirmation`, même si le consentement a déjà été enregistré.

Le commentaire client prétend que POST remplace le mandat, alors que le serveur fusionne. **Correction minimale : envoyer un patch d’actions, sans redéclarer la portée.** Préférer ensuite une mutation atomique par action avec révision, pour ne pas réécrire une ancienne copie de toute la carte d’actions.

Acceptation : cocher ET décocher sous `none`, `selected` et `all`, traverser le vrai store et la vraie route ; portée, consentement, projets et autres permissions inchangés. Une permission peut être préparée sous `none`, mais aucune mutation de projet ne doit devenir autorisée.

### A02 — P1 : une modification de priorité transforme l’héritage en L0 — reproduit localement

Sources : [normalisation:199–205](../../src/contracts/mandate.js#L199-L205), [sélection:4037–4042](../../src/host/index.js#L4037-L4042), [route:4060–4067](../../src/host/index.js#L4060-L4067), [affichage:619–628](../../src/client/ui/hierarchy.js#L619-L628).

Les projets sélectionnés peuvent avoir `level:null`, signifiant « hériter du niveau global ». La route calcule `body.level ?? current.level ?? 'L0'` : changer uniquement une priorité matérialise L0. Un projet autorisé à L3 cesse alors de lancer des tâches. L’UI affiche aussi L0 à la place du niveau hérité.

Correction : distinguer champ absent, `null` explicite et valeur. Conserver l’héritage lors d’une modification sans rapport. Afficher « Hérité — L3 » et proposer le retour à l’héritage.

### A03 — P1 : recours à l’accord humain incomplet — prouvé par contrat et lecture du cycle

Sources : [mandat:445–481](../../src/contracts/mandate.js#L445-L481), [refus du cycle:3312–3325](../../src/host/index.js#L3312-L3325), [décisions issues du modèle:3411–3437](../../src/host/index.js#L3411-L3437).

Un accord ne lève ni `action_disabled`, ni `level_too_low`, ni les limites de portée. Seul le lancement devient possible à L2 avec approbation ; commenter/créer/modifier demande L3 même avec accord. Reproduction : `approved:true` laisse `comment` refusé si sa permission est désactivée ou si le niveau est L2.

De plus, refuser une proposition n’engendre pas automatiquement une demande humaine : le code l’ajoute à `refused`, puis dépend des questions que le modèle a lui-même émises. Le message « vous pouvez demander l’accord » n’est donc pas une garantie de parcours utilisable.

Correction : distinguer **droit permanent**, **droit ponctuel à demander** et **interdit**. Produire une demande déterministe pour une action concrète admissible à approbation ; ne jamais convertir automatiquement les refus de sécurité/portée en autorisations. Voir matrice cible ci-dessous.

### A04 — P1 : plusieurs permissions n’ont pas d’exécuteur dans la boucle Super Agent — statique confirmé

Source : [switch d’exécution:3328–3392](../../src/host/index.js#L3328-L3392).

La boucle exécute `launch`, `create_task`, `update_task`, `comment`. `read`, `analyse`, `propose` relèvent du raisonnement. Les autres mutations autorisées en principe aboutissent à `no_adapter_for_action` dans cette boucle : notamment `delegate`, `schedule`, `push_branch`, `open_pr`, `merge`, `protected_branch_write`, `delete_task`, `secrets`, `policy_change`.

Cela ne signifie pas qu’aucune route ou intégration séparée n’existe pour certaines de ces opérations ; cela signifie que **cocher la permission ne rend pas cette action exécutable par ce Super Agent**.

Correction : registre unique des actions avec `implemented`, connecteur requis, disponibilité effective, mode, droit, approbation et exécuteur. Une capacité absente doit être annoncée avant de proposer l’action, pas seulement après autorisation. Ne pas faire passer « permission activée » pour « prêt à exécuter ».

### A05 — P0 potentiel : l’autorisation d’une écriture ne vérifie pas le projet réel de la tâche — analyse statique

Sources : [gate:3312–3321](../../src/host/index.js#L3312-L3321), [update/comment:3360–3378](../../src/host/index.js#L3360-L3378), validateur de propositions dans [brain.js](../../src/superagent/brain.js).

Le gate utilise le `projectId` proposé ; update/comment utilisent ensuite le `taskId` proposé sans vérifier que la tâche appartient réellement à ce projet. Un identifiant étranger n’est pas une preuve de possession du projet. L’auditeur a confirmé que le validateur accepte un identifiant de tâche étranger avec un projet connu ; pas de mutation hors portée démontrée sur le serveur installé. L’effet final dépend aussi des contrôles du Task Board.

Correction prioritaire : résoudre la tâche canonique, vérifier workspace et version avant l’autorisation, refuser le décalage ; autoriser sur les faits résolus, jamais sur une déclaration du modèle. Tester projet A autorisé/B interdit et tâche de B déclarée dans A.

### A06 — P0 potentiel : le cerveau est une session d’agent sans confinement explicite de ses outils — statique

Sources : [création:2916–2924](../../src/host/index.js#L2916-L2924), [framing:2978–2984](../../src/host/index.js#L2978-L2984).

La session du cerveau est créée avec modèle et cwd, sans preset dédié ni restriction explicite d’outils. « Répondre uniquement en JSON » reste une instruction, pas une frontière de sécurité. Si le preset par défaut donne des outils mutateurs, le modèle pourrait agir avant la validation de son assessment. **Aucun contournement réel n’a été tenté** ; l’exposition exacte dépend du preset effectif.

Correction : cerveau sans outils à effet, ou appel modèle strictement structuré sans agent exécuteur ; les effets passent exclusivement par les exécuteurs déterministes. Vérifier le jeu d’outils effectivement résolu, y compris les plugins, avec injection de données malveillantes en test.

### A07 — P1 : affecter les permissions d’un worker peut échouer silencieusement — statique

Source : [createSession:1760–1776](../../src/host/index.js#L1760-L1776). Le contrat runtime inspecté de `permissionPresets.set(session,name)` confirme qu’un nom inconnu lève une exception.

Le setter est optionnel, conditionné à une session retrouvée, et toute exception est avalée comme « cosmetic / optional ». Une tâche peut donc démarrer sans preuve que le niveau demandé a été appliqué ; si aucun niveau n’est déclaré, elle dépend du défaut de déploiement.

Correction : résoudre un niveau effectif explicite, appliquer ET vérifier avant tout message de travail. Échec/manque de service → annulation de l’agent, libération du bail et motif visible. Le contrôle de permissions ne doit pas être cosmétique.

### A08 — P1 : approbations trop peu liées à l’opération exacte — statique

Sources : [recherche d’accord:443–469](../../src/superagent/decisions.js#L443-L469), [cycle:3314–3321](../../src/host/index.js#L3314-L3321), [association questions:3421–3435](../../src/host/index.js#L3421-L3435).

`approvalFor` ne rejette pas lui-même `usedAt`. Le chemin de lancement filtre les accords consommés séparément, mais le chemin générique ne le fait pas. Les écritures non-launch n’y consomment pas d’accord. Aujourd’hui elles sont normalement autonomes dès L3 ; c’est notamment un défaut latent si on les rend supervisables.

Les questions sont associées à la première proposition du même projet, plutôt qu’à une opération identifiée. Plusieurs propositions d’un projet peuvent donc être mal reliées au consentement. Le contrat n’attache pas l’accord au hash du payload et à une version de tâche précise.

Correction : intention persistée et immuable `{action,projectId,taskId,taskVersion,payloadHash,mandateRevision,expiry}` ; consommer atomiquement une seule fois. Une question générale d’arbitrage n’est pas une autorisation de mutation. Tester payload modifié, version modifiée, mauvais projet, double clic, redémarrage et accord expiré.

### A09 — P2 : projets au-delà du vingtième sans contrôle individuel dans l’inspecteur — statique

Sources : [limite:104–105](../../src/client/ui/inspector.js#L104-L105), [troncature:331–332](../../src/client/ui/inspector.js#L331-L332), [rendu:363–399](../../src/client/ui/inspector.js#L363-L399).

Le `+N` annonce les projets masqués, mais ne donne ni pagination ni recherche permettant de les sélectionner/configurer. « Tous les projets » n’est pas un remède acceptable : cela élargit la portée.

Correction : recherche/pagination avec contrôles individuels ; test d’interaction sur le 21e projet.

### A10 — P2 : impossible de réinitialiser niveau/modèle projet via `null` — confirmé API

Source : [route:4063–4065](../../src/host/index.js#L4063-L4065).

L’opérateur `??` conserve l’ancien modèle quand le corps contient `model:null`, et l’ancien niveau quand `level:null` est demandé. Pas d’éditeur de modèle projet dans l’inspecteur actuel : l’affichage du modèle ne doit pas être pris pour un contrôle. L’éditeur existant concerne le modèle du Super Agent.

Correction : sémantique claire « absent = conserver ; null = hériter/réinitialiser ». Ajouter les contrôles manquants sans confondre cerveau et workers.

### A11 — P2 : le dry-run n’est pas une garantie de lancement — statique

Sources : [dry-run:3540–3560](../../src/host/index.js#L3540-L3560), [vrai gate:1633–1699](../../src/host/index.js#L1633-L1699).

Le dry-run vérifie mandat, backend et readiness, mais pas toute la chaîne de `authorizeLaunch` : permission demandée par carte, quota horaire consommé, isolation worktree, réservation par Task Board, politique de route, budget global. Il peut donc afficher un candidat autorisé que l’exécution réelle refusera.

Correction : extraire un préflight pur commun à l’affichage, au dry-run et à l’exécution ; la réservation et les écritures restent séparées. Un candidat doit expliquer chaque blocage et sa remédiation.

## Matrice cible recommandée — décision produit, pas comportement déjà acquis

### Principes

1. **Le niveau est un plafond d’automatisation, pas un sélecteur de projets et pas une permission système.** Changer de niveau ne sélectionne jamais tous les projets implicitement.
2. Distinguer trois décisions par action : `interdit`, `demander à chaque fois`, `automatique dans le mandat`. Un checkbox binaire ne représente pas correctement le besoin exprimé.
3. Un consentement ponctuel n’augmente jamais durablement le niveau global et ne change pas les permissions des autres actions.
4. Une action non implémentée ne peut pas être « débloquée » par un consentement : afficher l’intégration manquante et proposer un plan alternatif réel.
5. Portée, service indisponible, secret absent, action illégale et refus système sont des prérequis/limites, pas des obstacles à contourner.

| Niveau | Fonctionnement attendu | Hors automatisation autorisée |
|---|---|---|
| L0 — observation | Afficher l’état et les diagnostics ; pas de boucle d’analyse ni de mutation autonome. | Expliquer la configuration ; geste humain explicite pour activer un mode. |
| L1 — conseil | Analyser les projets sélectionnés et préparer un plan. Aucune mutation automatique. | Proposer une intention ; exécution par parcours humain explicite, sans mutation cachée. |
| L2 — supervisé | Préparer des actions implémentées ; exécuter uniquement l’intention approuvée une fois. | Créer une demande ciblée, montrer l’effet/diff et les limites. |
| L3 — autonomie bornée | Automatiser actions opérationnelles autorisées (lancement, commentaires, tâches, selon capacités), avec quotas/limites. | Demander un accord ponctuel pour les actions admissibles non automatiques. |
| L4 — autonomie étendue | Ajouter délégation, planification et opérations de livraison réellement implémentées et autorisées. | Décisions critiques toujours soumises à accord ; aucune extension implicite du périmètre. |

Les actions critiques (merge, écriture protégée, suppression, accès sensible, changement de politique) doivent garder une décision humaine explicite et une politique dédiée. Pour les secrets, approuver une utilisation contrôlée n’autorise jamais à exposer leur valeur.

### Décision et remédiation uniformes

| Situation | Réponse cohérente |
|---|---|
| Action automatique, implémentée, dans la portée, préflight valide | Exécuter et journaliser. |
| Action réglée « demander » et prérequis valides | Créer une intention + demande ; suspendre cette action seulement. |
| Action réglée « interdit » | Ne pas exécuter ; expliquer et proposer à l’opérateur une modification explicite, sans harcèlement de demandes. |
| Pas de projet sélectionné | Donner accès au sélecteur ; ne pas sélectionner tous les projets automatiquement. |
| Projet hors portée | Demande distincte de changement de portée ; pas de réutilisation d’un accord de lancement. |
| Niveau trop faible | Expliquer « demande ponctuelle possible » si le mode le prévoit, sinon proposer le changement de mode explicitement. |
| Adaptateur absent / capacité non implémentée | Indiquer indisponible, avec intégration ou travail nécessaire ; ne pas afficher prêt. |
| Budget/concurrence épuisé | Attendre un réveil borné et visible ; changement de limite seulement sur décision explicite. |
| Stop/Pause | Aucun nouvel effet après la frontière vérifiée ; distinguer pause du cerveau et arrêt des workers. |
| Approvals indisponibles/refusées par l’hôte | Indiquer la limite ; jamais considérer une absence de réponse comme un accord. |

## Plan de remise en état

### Lot 1 — sécuriser les effets avant d’élargir l’autonomie

- A05, A06, A07 : projet canonique, cerveau sans outils mutateurs, permissions workers fail-closed.
- A08 : autorisations liées aux intentions, consommation unique, version/hash.
- Critère : tests négatifs prouvant qu’aucune session, requête d’écriture ou mutation n’échappe au gate.

### Lot 2 — réparer la configuration quotidienne

- A01, A02, A10 : patch permission atomique, héritage préservé, resets explicites.
- A09 : tous les projets accessibles individuellement.
- Critère : parcours store → serveur sans mock permissif, puis vérification GUI authentifiée aux trois scopes et cinq niveaux.

### Lot 3 — rendre les capacités honnêtes et l’accord humain utilisable

- A03, A04 : registre réel des actions et exécuteurs, politique tri-état, demandes déterministes et ciblées.
- Choisir pour chaque permission : implémenter son parcours complet ou la déclarer indisponible. Ne pas prétendre que toutes fonctionnent si seules certaines routes existent.
- Critère : pour chaque action, succès, refus, demande, approbation, rejet, expiration, double réponse et reprise sont couverts.

### Lot 4 — préflight commun et qualification autonome

- A11 : une raison et une remédiation identiques dans configuration, capacité, dry-run et lancement.
- Tests d’endurance : plusieurs projets, tâches dépendantes, worktree, budgets, panne fournisseur, arrêt pendant await, redémarrage, changement de mandat en vol, versions concurrentes.
- Qualification réelle non destructive, puis effets forge uniquement sur dépôt de test dédié et consentement approprié.

## Grille de recette avant de déclarer « utilisable en autonomie »

- [ ] Les permissions peuvent être cochées/décochées sans reconfigurer le scope.
- [ ] Priorité, budget, note et modèle ne changent pas accidentellement le niveau.
- [ ] Tous les projets restent configurables, y compris le 21e et au-delà.
- [ ] Chaque permission affichée correspond à une capacité réelle, ou porte explicitement « indisponible ».
- [ ] Une proposition hors automatisation mais admissible ouvre une demande déterministe exploitable.
- [ ] L’accord affiche et verrouille action, projet, tâche, version et contenu ; il ne s’applique qu’une fois.
- [ ] Une tâche d’un autre projet ne peut pas être modifiée par falsification de projectId.
- [ ] Le cerveau ne peut pas muter via des outils hors du pipeline d’exécution.
- [ ] L’échec d’application des permissions empêche le démarrage du worker.
- [ ] Dry-run, matrice de capacités et vrai lancement partagent le même préflight.
- [ ] Stop, Pause, reprise, limites, failover et redémarrage sont vérifiés sur les parcours nouveaux.
- [ ] La version réellement chargée dans la GUI est identifiée et la recette visuelle authentifiée réalisée.

## Limites de la conclusion

Cet audit fournit des blocages et risques concrets, pas une preuve exhaustive d’absence d’autres défauts. Les 594 tests verts sont une base de régression utile ; ils n’invalident pas les défauts de contrats entre composants. En particulier, le test client du changement de permission valide un corps envoyé à un faux serveur, sans vérifier que le serveur réel l’accepte : [test:528–542](../../tests/cockpit-superagent.test.js#L528-L542).

Aucune correction fonctionnelle n’a été appliquée dans cet audit. Les élargissements de droits, le changement de comportement des modes et les opérations critiques demandent une implémentation et une recette explicites ; ils ne doivent pas être obtenus en supprimant les garde-fous existants.
