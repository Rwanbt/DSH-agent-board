# GOAL 6 — Preuves visuelles du cockpit (hôte réel)

- Instance : profil DSH `e2e` **isolé** (aucune modification du profil desktop), plugin
  `dsh-agent-board` lié au dépôt, GUI `http://127.0.0.1:50735`, home jetable
  `%TEMP%\dsh-e2e-home-goal3`.
- Bords simulés : fournisseurs OpenAI-compatibles scriptés, Task Board simulé. Le host,
  le client, les sessions DSH et l'API sont réels.
- Console navigateur : **0 erreur, 0 avertissement**. Requête observée :
  `POST /dsh-agent-board/api/v2/superagent/directives → 200 OK`.
- Captures : `docs/e2e/screenshots/goal6-*.png`.

| Capture | Ce qu'elle prouve |
|---|---|
| `goal6-1366-cockpit.png` | Bandeau : deux états distincts — « Super Orchestrator · Supervision » (couche synthétique) et « Super Agent · session non démarrée ». Modèle, niveau, `2/2 projets activés`, contrôles Démarrer/Pause/Arrêter/Reprendre. Jeton « Mode : Autonome » et compteurs réels. |
| `goal6-1366-overview.png` | Inspecteur 4 onglets, objectif factuel (« Aucun objectif publié — not_started »), matrice de capacités avec raisons (`Déléguer — Non disponible — level_too_low`), incidents, boîte de décisions (0). |
| `goal6-1366-projects.png` | Portée réelle : 2 projets sélectionnés ; A `Actif · L4 · prio 1 · 20/h`, B `Actif · L3 · prio 5`, C `Hors portée · L0` avec `Raison : project_not_selected` ; bouton **Simuler** (lecture seule). |
| `goal6-1366-directives.png` | État vide explicite + formulaire + exemples. |
| `goal6-1366-directive-saved.png` | Directive **persistée** (auteur, date, portée, statut, bouton Révoquer) après un `POST` réel 200 ; l'ajout a déclenché un cycle Super Agent : la session DSH est apparue dans la barre latérale (`Super Agent — super-agent-896006…`) et, le fournisseur simulé ne renvoyant pas de JSON d'assessment valide, le statut est `en erreur` **sans aucun effet** (aucune tâche lancée). C'est le chemin sûr attendu. |
| `goal6-1366-settings.png` | Modèle principal + fallbacks (`non disponible — models_not_discovered`), autonomie L3, budgets (cycles 0/6, appels 1/12, `Budget de jetons : métrique indisponible`), permissions par action avec checkbox **et** raison effective (`Déléguer` décoché, `Raison : action_disabled`), notifications. |
| `goal6-1366-dark.png` | Thème sombre via `prefers-color-scheme`, jetons du cockpit conservés. |
| `goal6-390-band.png` | Mobile 390 px : bandeau compact, chip Super Agent distinct, bouton **Arrêter** atteignable, cartes non tronquées sans marqueur. |
| `goal6-390-settings.png` | Mobile 390 px : inspecteur en **bottom sheet** plein largeur, onglets tactiles. |

## Ce que ces captures ne prouvent pas

- Le fournisseur LLM réel : le JSON d'assessment n'est pas produit par le faux
  fournisseur ; le test d'intégration hôte (`tests/goal6-superagent-host.test.js`) couvre
  le cycle complet avec un assessment valide, mais pas avec un vrai modèle distant.
- Les écritures Task Board publiques (API 503, aucun token) et GitHub (aucun dépôt de
  test autorisé) — voir `docs/GOAL6-DELIVERY.md` §10.
