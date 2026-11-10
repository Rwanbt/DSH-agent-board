# Preuve E2E — instance DSH isolée (2026-11-09)

But : exécuter le plugin dans une **vraie instance DSH** (pas un faux `ctx`), sur
un `DSH_HOME` jetable, sans toucher au profil réel ni au port 62337. Ce document
est la trace expurgée de ce qui a été observé.

## Montage

| Élément | Valeur |
|---|---|
| DSH | `0.2.2-rc.1` (`dsh.cmd --version`) |
| `DSH_HOME` | `D:\App\dsh-e2e-home` (créé pour le test, supprimé après) |
| Profil | `e2e`, créé par `dsh --profile e2e --from-default-profile web --dump-config` |
| Plugins | `dsh plugin --profile e2e add link:D:/App/DSH-agent-board link:.../dsh-taskboard` (réseau non requis, 860 ms) |
| Serveur | `dsh --profile e2e --port 0 --no-open` → node headless (`ELECTRON_RUN_AS_NODE=1`) |
| Auth | URL `http://127.0.0.1:<port>/?token=…` ; cookie de session pour les appels HTTP |
| Workspace | initialisé par la GUI : `c2fe23cd-…` (`default-workspace`, git, 5 repos) |

## Observations

### 1. Activation réelle du plugin (profil neuf)

- `GET /dsh-agent-board/api/v2/state` → **200**, `mode: off`, `instance.primary: true`.
- Aucun conflit de route, aucune erreur d'import côté client : **0 erreur console**
  sur la page isolée.
- `GET /dsh-taskboard/state` interrogé par le connecteur du board :
  `sync.ok: true`, `ledgerRevision: 0`, `tasksTotal: 0` — **le contrat Task Board
  0.10.2 est lu en vrai**, pas contre une fixture.
- Matrice d'adaptateurs live : `dsh-taskboard` `list/get/run` = vrai,
  `validatedLive: false` (honnête), `github` désactivé.

### 2. Tâche réelle et lancement réel

Tâche créée via l'API Task Board (`POST /dsh-taskboard/tasks`, HTTP **201**) :
`t-mw9ue95x-90qkvm`, `version: 1`, `status: todo`, workspace isolé.

`POST /tick` (mode autonome) a **réellement lancé une session DSH**
(`session-agentboard-…`) sur le backend `board`. Le tour a échoué faute de
credentials dans un `DSH_HOME` neuf :

```text
llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service …
```

C'est le résultat attendu d'un profil isolé sans secret : **aucune credentials
du profil réel n'a été copiée**. La tâche est restée `todo`, `claimedBy: null`,
`executions: 0` (backend `board`, pas d'exécution Task Board — le compromis
documenté).

### 3. Deux défauts trouvés par cet E2E, puis corrigés

1. **Boucle de relance illimitée** : le timer (4 s) relançait la tâche à chaque
   tick, créant 6 sessions en ~20 s (attempts 0→5). Aucun plafond de tentatives,
   aucun cooldown après échec.
2. **Credential manquant classé `unknown`** : le classifieur ne reconnaissait pas
   « no API key » ; le routeur faisait 2 retries sur la même route (délais réels
   observés : 534 ms puis 1069 ms) avant `blocked`, au lieu de traiter la panne
   comme une faute d'authentification non réessayable.

Après correction (code actuel) et **redémarrage de l'instance isolée** :

- `instance.primary: true` avec `reconcileNotes: [{type: 'stale_lock_taken_over'}]`
  → **reprise du verrou mono-écrivain après mort du processus précédent**.
- `mode: autonomous` mais `stoppedAt` renseigné + audit
  `resume_requires_confirmation` → **l'autonomie ne reprend pas silencieusement**
  après un redémarrage.
- `POST /dispatch` avant reprise → **409 `stopped_by_operator`**, aucune session.
- `POST /resume` → 200 ; `POST /tick` → tâche **non relancée** :
  d'abord `autonomy_budget_exhausted` (6 lancements dans l'heure), puis après
  relèvement du budget, **`max_attempts_reached`** sans nouvelle assignation.
- SSE : `EventSource` sur `/events` reçoit **1 trame nommée `state`, 0 trame
  anonyme** → le correctif client est confirmé en conditions réelles.

## Limites de cette preuve

- **Aucun tour de modèle réussi** : pas de credentials dans un `DSH_HOME` neuf,
  et aucune copie de secret n'a été faite. Le chemin « tâche → session →
  rapport → `in_review` » n'est donc **pas** prouvé ici (il l'a été en live lors
  du GOAL 1, avec le build précédent).
- Le **backend `taskboard`** (`POST /tasks/:id/run`) n'a pas été exercé en live :
  il est couvert par un test contrat sur fausse API HTTP. Le refaire en live
  donnerait un `executionId` réel mais le tour échouerait aussi faute de clé.
- Pas de test de charge, pas de Linux, pas de désinstallation du profil réel.

## Nettoyage

Instance arrêtée (port libéré), `D:\App\dsh-e2e-home` supprimé (≈167 Kio), profil
réel et port `62337` intacts (pid 2096 toujours propriétaire). Aucune
modification du profil desktop ni des forges.
