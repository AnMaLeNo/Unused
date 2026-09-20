# Vue d'ensemble

`unused` fait tourner, sur le quota inutilisé d'un abonnement Claude Code,
des **tâches infinies** : des skills rejoués en boucle dans des containers
Docker jusqu'à ce que le skill lui-même décide que c'est fini, ou que le
quota (5 h glissantes / hebdomadaire) soit atteint.

Le `package.json` résume ça en une phrase :

```json
"description": "Consomme le quota inutilisé d'un abonnement Claude Code en faisant tourner des tâches infinies dans des containers."
```

Quatre pièces s'emboîtent : les **tâches** (ce qui tourne), le **démon**
(ce qui décide quand et fait tourner), l'**API** (comment on lui parle) et
la **CLI** (avec quoi on lui parle). Docker fournit l'espace de travail
persistant de chaque tâche.

## Les tâches : un graphe de skills

Une tâche vit dans `tasks/<nom>/` :

```
tasks/review-monprojet/
  task.json
  skills/
    find-next/SKILL.md
    do-review/SKILL.md
  exchange/            ← monté sur /exchange dans le container (DONE, rapports…)
```

`task.json` décrit un graphe de nœuds ; chaque nœud lance un skill et
désigne son successeur (`src/task.ts`) :

```ts
/**
 * Une tâche = un graphe de nœuds. Chaque nœud lance un skill et désigne son
 * successeur. La seule condition de sortie est le fichier DONE créé par le
 * skill dans /exchange ; sinon on suit `next` indéfiniment.
 */
```

Il n'y a pas de fin de graphe prévue par construction : la seule sortie est
que le skill en cours crée `/exchange/DONE`. Le nom du dossier sert aussi de
nom d'image Docker (`unused-task-<nom>`), d'où la contrainte de format
(`TASK_NAME_RE` dans `src/task.ts`) : minuscules, chiffres, et un seul
séparateur `.`, `_` ou `-` entre deux groupes.

## Le container comme état persistant

Chaque tâche a son image Docker (`src/docker.ts`). À chaque itération, le
runner lance un container à partir de cette image, monte `skills/` en
lecture seule et `exchange/` en lecture-écriture, puis exécute `claude -p`
dedans. Claude y est root et installe ce qu'il veut : c'est son espace de
travail, pas un simple sandbox jetable.

- Itération réussie → le container est commité (`commitTask`) : la prochaine
  itération repart exactement de cet état.
- Itération ratée (erreur, quota, timeout) → le container est jeté
  (`discardContainer`) et réputée n'avoir jamais eu lieu ; on retentera le
  même nœud.
- Au-delà d'un certain nombre de couches, l'image est aplatie
  (`flattenTask`) pour ne pas accumuler indéfiniment de layers Docker.

Le runner ne lit jamais ce que Claude a produit dans le container : il ne
regarde que comment la session `claude -p` s'est terminée
(`terminal_reason`, voir `src/claude.ts`) et si `/exchange/DONE` existe
(`DONE_FILE` dans `src/iterate.ts`). Tout l'état métier de la tâche vit dans
le container et dans `exchange/`, géré par le skill lui-même.

## Le démon : la boucle qui décide

`src/daemon.ts` contient `Daemon`, le processus qui vit en tâche de fond
(lancé par `node dist/cli.js daemon` ou par systemd via
`deploy/unused.service`). Il :

- calcule quand il doit tourner : plages manuelles (`unused start --for 8h`)
  et plages automatiques issues de `unused.config.json` (`src/calendar.ts`),
  cumulées ;
- pendant une plage, délègue à `runWindow` (`src/scheduler.ts`) le
  round-robin entre les tâches actives — une itération de la tâche A, une de
  B, une de C… (une seule à la fois, le quota est partagé) ;
- chaque itération individuelle est `iterate()` dans `src/iterate.ts` : elle
  lance le container, parse le flux `stream-json` de Claude, décide
  commit/discard, et écrit un log ;
- s'arrête proprement sur deux pannes globales : token refusé (401/403) ou
  Docker injoignable (`fatal` dans `DaemonStatus`) — plutôt que d'épuiser
  toutes les tâches en échecs une par une ;
- reprend une plage interrompue par un redémarrage, en relisant l'état
  persisté (`src/state.ts`).

L'extrait suivant, dans `DaemonStatus` (`src/daemon.ts`), montre ce que le
démon expose à tout moment : la fenêtre en cours, la prochaine plage
automatique, une éventuelle panne globale, et l'état de chaque tâche.

```ts
export interface DaemonStatus {
  daemon: { pid: number; startedAt: string };
  window: null | { startedAt: string; until: string; /* … */ };
  nextCalendarStart: string | null;
  pausedUntil: string | null;
  fatal: null | { reason: "auth" | "docker"; detail: string; at: string };
  lastWindow: WindowSummary | null;
  tasks: TaskInfo[];
  taskErrors: TaskLoadError[];
}
```

## L'API et la CLI : comment on pilote le démon

Le démon expose une API HTTP en JSON sur un socket Unix
(`createApi` dans `src/api.ts`) :

```ts
/**
 * L'API du démon : HTTP + JSON sur socket Unix. La CLI en est le seul
 * client aujourd'hui ; un front pourra parler aux mêmes routes demain.
 */
export function createApi(cfg: Config, daemon: Daemon): http.Server { … }
```

`src/cli.ts` (le binaire `unused`, exposé via `bin` dans `package.json`) est
un client `commander` de cette API — il ne parle jamais directement à Docker
ou aux tâches, seulement au socket. Il trouve le démon via `--socket`, sinon
`$UNUSED_SOCKET`, sinon un chemin déduit de `unused.config.json`
(`src/client.ts`). C'est aussi la CLI qui expose les commandes utilisateur
au quotidien :

```
unused start --for 8h        # démarre une plage (jusqu'à taper la limite)
unused status                # plage, itération en cours, tâches
unused stop                  # après l'itération en cours ; --now pour tuer
unused tasks list | reset <t> | activate <t> | deactivate <t>
```

Seul le processus démon lit `.env` (le token Claude) ; la CLI ne le voit
jamais.

## Comment les pièces s'emboîtent

```
unused.config.json ──> Daemon (src/daemon.ts)
                          │  calcule les plages (src/calendar.ts)
                          ▼
                     runWindow (src/scheduler.ts)  ← round-robin sur les tâches actives
                          │
                          ▼
                     iterate() (src/iterate.ts)
                          │  lance / parse claude -p, décide commit/discard
                          ▼
                     Docker (src/docker.ts) ── un container par itération, une image par tâche
                          │
                          ▼
                     tasks/<nom>/ (task.json, skills/, exchange/)

CLI (src/cli.ts) ──HTTP/socket Unix──> API (src/api.ts) ──> Daemon
```

Chacune de ces pièces est détaillée dans sa propre page : voir
[l'index de la documentation](README.md).
