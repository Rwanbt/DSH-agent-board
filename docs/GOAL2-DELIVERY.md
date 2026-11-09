# GOAL 2 — Livraison 1 : reprise, rollback, essai isolé

Complément de [`GOAL2-AUDIT-MATRIX.md`](GOAL2-AUDIT-MATRIX.md) et de
[`TEST-REPORT.md`](TEST-REPORT.md) §10.

## Base et commits

| Élément | Valeur |
|---|---|
| Base (GOAL 1 UX validé) | `75b40d8d50c867a2b179c9e1a95f59e276f69789` |
| Branche | `fix/agent-board-runtime-e2e` (non poussée) |
| Commit de code + docs | `0880d03` — 38 fichiers, +4457/−362 |
| Commit de preuve live | `b9775c8` — TEST-REPORT §10 |
| État | arbre propre ; `docs/ux-audit/` non suivi, produit par une autre session (non commité) |

## Rollback

```sh
# revenir au GOAL 1 validé, sans réécrire l'histoire
git switch feat/agent-board-visual-tree        # 75b40d8
# ou annuler uniquement cette livraison sur la branche de travail
git revert --no-commit 0880d03 b9775c8 && git commit -m "revert: goal2 runtime"
```

Le plugin est installé en `link:` (`~/.dsh/profiles/desktop/node_modules/dsh-agent-board`
→ `D:\App\DSH-agent-board`) : aucun paquet à désinstaller. Un **redémarrage du
host DSH** est nécessaire pour recharger la moitié host (`src/host/*`) ; la
moitié client est resservie depuis le disque au rechargement de la page.

État durable : `~/.dsh/agent-board/state.json` + `audit.jsonl` + `instance.lock`.
Le nouveau code tolère l'ancien document (schéma 1). En cas de doute, copier le
dossier `agent-board` avant le premier démarrage ; un `state.json` illisible est
mis en quarantaine, jamais supprimé. Supprimer `instance.lock` n'est utile que si
un processus mort l'a laissé ET que le PID a été réutilisé (sinon la reprise est
automatique).

## Essai dans un profil isolé (non exécuté ici)

```powershell
$env:DSH_HOME = 'D:\App\dsh-e2e-home'
# 1. amorcer un profil dédié sans toucher au profil réel
dsh --profile e2e --from-default-profile web --dump-config | Out-Null
# 2. brancher les plugins locaux (aucune dépendance externe)
dsh plugin --profile e2e add link:D:/App/DSH-agent-board link:C:/Users/barat/Documents/deepseek-harness/default-workspace/dsh-taskboard
# 3. configurer un provider OpenAI-compatible FACTICE (baseURL local, clé bidon)
#    + une routeChain explicite dans le patch du profil
# 4. démarrer sur un port libre, sans ouvrir de navigateur
dsh --profile e2e web --port 0 --no-open
```

Blocage connu : un `DSH_HOME` neuf n'a **pas** `.credentials.yaml`. Sans provider
factice, aucun tour de modèle ne peut être exécuté. Ne pas copier les
credentials réels dans un dossier de test sans accord explicite.

Scénario minimal à rejouer : créer une tâche `todo` dans le Task Board isolé →
autonome → vérifier la session lancée → forcer un 503/429 sur le provider
factice → vérifier `recovering`, le switch, le checkpoint, la reprise sans
doublon → vérifier que la carte reste `in_review` (jamais `done`).

## Ce qui reste ouvert (P1)

- **Tour de modèle réussi** en instance isolée : bloqué par l'absence de
  credentials dans un `DSH_HOME` neuf (aucune copie de secret faite). Le
  parcours complet a été prouvé une fois en live lors du GOAL 1 (build
  précédent) ; l'activation, le lancement réel, la reprise, le verrou, l'arrêt
  et le SSE le sont désormais aussi en live sur l'instance isolée.
- **Failover live** sur une route sacrificielle (testé avec des messages réels
  d'erreur, pas avec un vrai 429/5xx réseau).
- **Backend `taskboard`** non exercé contre un exécuteur Task Board live.
- **Forge réelle** (GitHub/GitLab) : contrat + pagination + rate-limit testés
  sur fausse API, aucun appel live ni webhook.
- Retour au provider principal, fencing enforced, réconciliation des effets
  externes.
- Charge 30 agents / 200 sessions, Linux, désinstallation réversible.

## Deuxième lot (même branche)

| Commit | Contenu |
|---|---|
| `0880d03` | P0 état/orchestration/durabilité/Task Board contract |
| `b9775c8` | preuve live SSE (TEST-REPORT §10) |
| `cee333f` | consignes de reprise/rollback/essai |
| *(ce lot)* | résilience (restart, watchdog, ticks concurrents, lock), contrat forge sur fausse API, backend `taskboard` (exécution native/worktree) |

Tests : **148/148** (revue indépendante incluse). Voir TEST-REPORT §11–§13.

### Lot 3 — revue croisée indépendante

| Commit | Contenu |
|---|---|
| `1253729` | bornage du document durable |
| `92f8f8c` | un hôte secondaire n'écrit plus le journal ni l'état |
| `c06087a` | P1 : porte de handoff, course Stop/handoff, verrou CAS (bug Windows `:` réel) ; P2 revue |
| `86dc5b0` | un hôte démis ne relance pas les retries différés |

Tests : **148/148**, trois exécutions consécutives sans échec. Les points restants
sont documentés dans TEST-REPORT §13 (turn/end précoce du backend `taskboard`,
dérive du bundle généré quand une autre session édite `src/client/**`).
