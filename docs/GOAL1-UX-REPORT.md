# GOAL 1 — Refonte UX (cartes + arbres de filiation)

Branche `feat/agent-board-visual-tree`, base `ec955fbc00871db7541388b1953fc8b1671cfe56` (main local, distant vide).

## Diagnostic (vérifié dans le code et sur les données live, DSH 0.2.2-rc.1)
- `projectKeyOf` lisait `workspace.id` alors que `workspaces.list` expose `workspaceId` → aucun groupement par workspace ; repli sur le cwd brut.
- Aucun filtre : chaque session (133 dans le profil, dont 74 sous-agents) était rendue, en liste verticale pleine largeur.
- L'aperçu montrait le dernier segment assistant même en plein tour (pas une réponse finale).
- Sources natives réellement disponibles : `sessions.list` (rows avec `parentId`/`origin:'subagent'`, `projectionValues.{modelSelection, turnOutline, userQuestions, plan, mobilePushLifecycle.lastTurnEnd, subagent.label, agentTeam}`), `uiSession.sessionStatus` (`running`, `completionUnread`), `workspaces.list` (`workspaceId`, `path`, `sessionIds` racines), `uiWorkspace.openSession(id)` (ouvre aussi un sous-agent : vérifié).

## Composants
- `src/supervisor/projection.js` : statut, `resolveProject`, parenté (cycles/orphelins), réponse finale.
- `src/board/view.js` : `buildBoardView`, `aggregateSubtrees`, `sortAttention`, `historyPage`, `boardCounts`.
- `src/board/interaction.js` : arbitrage clic/double-clic/clavier.
- `src/client/ui/` : `toolbar`, `tree` (ProjectGroup/AgentTree/Compact), `card`, `preview`, `history`, `styles`, `strings`.
- `src/client/app.js` : AgentBoard (état, store, routage).

## Captures réelles (profil desktop, 09/11/2026) — `docs/screenshots/goal1/`

## Limites
- Réponse finale : le host ne reçoit pas les `session/event` des sous-agents ; pour eux l'extrait vient de `turnOutline.response` natif (début tronqué ~120 car. de la réponse).
- `pendingInteraction` d'approbation n'apparaît pas dans `sessionStatus` sur cette version ; attentes détectées via `userQuestions.active` et `plan.pending`.
- Zoom/pan de la zone de travail non implémenté (défilement + tuiles à débordement horizontal local).
