# Captures d'écran : retirées puis remplacées par une démo fictive

## Pourquoi les anciennes captures ont été supprimées

Les captures qui se trouvaient dans ce dépôt (`docs/e2e/screenshots/`,
`docs/screenshots/`, `docs/ux-audit/evidence/`) étaient de **vraies captures du
cockpit de l'auteur**. Elles affichaient les noms de ses projets personnels et des
extraits de ses sessions. Le dépôt étant public, elles ont été :

1. supprimées de l'arborescence ;
2. **purgées de tout l'historique Git** (tous les commits, toutes les branches),
   puis les branches `main` et `dev` ont été réécrites et forcées. Les empreintes
   SHA des commits ont donc changé : un ancien clone doit être refait
   (`git fetch && git reset --hard origin/dev`) et n'a plus ces images.

Les documents qui les citaient (`docs/GOAL*.md`, `docs/e2e/*`, `docs/ux-audit/*`,
`README.md`) pointent maintenant ici : leurs preuves **textuelles** restent
valables, les PNG ne sont simplement plus publiés.

## Les captures publiques actuelles

| Fichier | Contenu |
|---|---|
| `docs/demo/demo-dark-desktop.png` | cockpit sombre, 1440×900, **données fictives** |
| `docs/demo/demo-dark-mobile.png` | cockpit sombre, 390×844, **données fictives** |

Ces deux images sont rendues par **le vrai bundle client du plugin**
(`src/client.js`) — composants réels, styles réels — alimenté par un état
entièrement factice : trois projets inventés (*Orion Studio*, *Nebula API*,
*Atlas Docs*), des sessions inventées, aucun nom réel, aucun chemin réel, aucun
identifiant de session réel. La pagination est capturée dans le viewport exact
(override de métriques DevTools), pas par une fenêtre redimensionnée.

## Régénérer

```sh
node scripts/capture-demo-screenshots.mjs
```

- Le jeu de données vit **dans le script** (`PROJECTS`, `SESSIONS`) : pour changer
  la démo, on édite le script, jamais une capture.
- Chromium est découvert via `$CHROMIUM`, le cache Playwright, puis Chrome/Edge.
- La sortie est écrasée dans `docs/demo/` ; le script imprime la largeur de
  viewport réelle et le nombre de cartes rendues (contrôle anti-régression).
- L'état factice est chargé **avant** la première peinture et la capture attend
  `data-demo-ready` : les cartes « non lues » / « en attente » ne dépendent pas
  d'une course avec le premier rendu.

## Ce que cette démo ne prouve pas

Une capture n'est pas une preuve d'exécution : les tests
(`node --test tests/`) restent la preuve du comportement de l'hôte. Ces images
servent à montrer l'interface publique du plugin sans exposer de données
personnelles.
