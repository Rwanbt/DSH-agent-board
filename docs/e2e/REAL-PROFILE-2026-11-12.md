# GOAL 6 — preuve sur le profil desktop réel (installation de production)

- Date : 2026-11-12, Europe/Paris
- Profil DSH : `desktop` (`%USERPROFILE%\.dsh\profiles\desktop`), plugin lié
  `dsh-agent-board → D:\App\DSH-agent-board`
- Hôte : GUI `http://127.0.0.1:50373` (processus démarrés 09:19), API non authentifiée
  répond **401** (comportement attendu : l'API exige la session/cookie du host).
- Fichiers durables : `%USERPROFILE%\.dsh\agent-board\state.json` (334 847 octets),
  `audit.jsonl` (40 132 lignes).

## 1. État après redémarrage du host (lecture seule)

| Fait observé | Valeur |
|---|---|
| `schemaVersion` | **2** |
| `mode` | `off` |
| `stoppedAt` | `1794423239972` (Stop persistant antérieur, conservé) |
| `mandate` présent | oui |
| `mandate.scopeMode` | **`none`** |
| `mandate.level` | **`L0`** |
| `mandate.requiresConfiguration` | **`true`** |
| `mandate.projects` | **vide** (aucun projet autorisé) |
| `superagent` | `null` (aucune session IA créée) |
| `assignments` historiques | 2 (aucune nouvelle) |

Interprétation : l'installation réelle a bien été migrée vers le mandat explicite, et
elle est **inerte** : aucun projet sélectionné, niveau L0, configuration non confirmée.
C'est exactement le comportement P0 attendu (aucun lancement possible après upgrade).

## 2. Preuve d'audit

`audit.jsonl` contient un unique événement de migration :

```
1794466706095 mandate_migrated reason=goal6_scope_mode_v2
              to={scopeMode:none, level:L0, requiresConfiguration:true}
```

Après cet horodatage : **0** événement `launch`, **0** `delegation_allowed`, **0**
`policy_changed`, **0** `mode_changed`. Les seuls événements postérieurs sont des
`ack` (lecture opérateur) et des `session_gone` (observation de sessions disparues).

## 3. Ce que cette preuve ne couvre pas

- Aucune interaction GUI : l'URL du host est protégée par le token de session détenu
  par l'application ; un navigateur externe reçoit 401. Aucun contournement n'a été
  tenté.
- Aucune session Super Agent ni appel de modèle réel n'a été déclenché sur ce profil :
  le mode est `off` et le mandat non configuré. Le chemin « vrai LLM distant » reste
  donc **non testé** (voir `GOAL6-DELIVERY.md` §10).
- Aucune écriture Task Board publique : `DSH_TASKBOARD_PUBLIC_TOKEN` n'est pas défini
  (l'API répond 503 `public_api_disabled`, voir l'audit dédié).

## 4. Reproduction (lecture seule)

```powershell
$s = Get-Content "$env:USERPROFILE\.dsh\agent-board\state.json" -Raw | ConvertFrom-Json
$s.schemaVersion, $s.mode, $s.mandate.scopeMode, $s.mandate.level, $s.mandate.requiresConfiguration
$s.audit | Where-Object { $_.type -eq 'mandate_migrated' } | Select-Object -Last 1
(Get-Content "$env:USERPROFILE\.dsh\agent-board\audit.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.at -gt 1794466706095 -and $_.type -in @('launch','delegation_allowed','policy_changed') }).Count
```
