# Le modèle de tâche

Une tâche est un **graphe de skills** décrit par `tasks/<nom>/task.json` et
chargé par `src/task.ts`. C'est le seul format que le runner comprend ; tout
le reste (`src/scaffold.ts`, la doc utilisateur) n'est que du sucre autour.

## `task.json`

Le schéma est défini par `TaskFileSchema` dans `src/task.ts` :

```ts
const NodeSchema = z
  .object({
    skill: z.string().min(1),
    params: z.record(z.string()).default({}),
    args: z.array(z.string()).default([]),
    next: z.string().min(1),
  })
  .strict();

const TaskFileSchema = z
  .object({
    active: z.boolean().default(true),
    start: z.string().min(1),
    params: z.record(z.string()).default({}),
    env: z.array(z.string().regex(ENV_ENTRY_RE, 'attendu "NOM" ou "NOM=valeur"')).default([]),
    nodes: z.record(NodeSchema),
  })
  .strict()
  // ...
```

Un exemple minimal, celui que génère `unused tasks new` (`src/scaffold.ts`) :

```json
{
  "active": false,
  "start": "setup",
  "params": { "repo": "owner/projet" },
  "env": [],
  "nodes": {
    "setup": { "skill": "setup", "next": "work" },
    "work": { "skill": "work", "next": "work" }
  }
}
```

- `start` : le premier nœud exécuté.
- `nodes` : chaque nœud lance un skill (`skills/<skill>/SKILL.md`, monté
  dans le container) et désigne son `next` — le nœud suivant une fois que
  le skill a rendu la main proprement (`completed`). Il n'y a pas de nœud
  final : `work` pointe vers lui-même, et le graphe tourne indéfiniment tant
  qu'aucun skill n'a créé `/exchange/DONE`.
- `params` : au niveau de la tâche, fusionnés avec ceux du nœud (le nœud
  l'emporte) pour former les arguments du skill. `buildPrompt`
  (`src/claude.ts`) les transforme en `$ARGUMENTS` :

  ```ts
  export function buildPrompt(node: TaskNode, taskParams: Record<string, string>): string {
    const args = renderArguments({ ...taskParams, ...node.params });
    return args ? `/${node.skill} ${args}` : `/${node.skill}`;
  }
  ```

- `args` : arguments `claude` propres au nœud, ex. `["--model", "opus"]`,
  ajoutés par `buildCommand` (`src/claude.ts`) à ceux de la session.
- `env` : variables données au container, avec la sémantique de
  `docker run -e`. `"NOM"` transmet la valeur de l'hôte (le `.env` du
  démon), `"NOM=valeur"` la fixe littéralement. Résolu par `resolveEnv` :

  ```ts
  export function resolveEnv(
    entries: string[],
    source: Record<string, string | undefined>,
  ): { env: Record<string, string>; missing: string[] } {
  ```

  Une variable `"NOM"` introuvable dans l'environnement du démon fait
  échouer le chargement de la tâche (`loadTask` lève une erreur listant les
  noms absents) — pas de démarrage avec un secret manquant en silence. Le
  token Claude, lui, est toujours transmis et n'a pas besoin de figurer ici.
- `active` : si `false`, la tâche est ignorée par le round-robin
  (`src/scheduler.ts`) sans être supprimée du disque.

## Nom de tâche = nom d'image Docker

Le nom du dossier (`tasks/<nom>/`) sert directement de nom d'image Docker
(`unused-task-<nom>`), d'où la contrainte de format imposée par
`TASK_NAME_RE` :

```ts
export const TASK_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
```

Minuscules, chiffres, et un seul séparateur `.`, `_` ou `-` entre deux
groupes. `loadTask` refuse tout dossier qui ne respecte pas ce format avant
même de lire `task.json`.

## Chargement et validation (`loadTask`, `loadTasks`)

`loadTask(dir)` fait plus que parser du JSON : c'est le point où toutes les
incohérences d'une tâche sont détectées d'un coup, avant qu'elle tourne :

1. le nom du dossier respecte `TASK_NAME_RE` ;
2. `task.json` est un JSON valide conforme à `TaskFileSchema` — y compris
   deux vérifications croisées faites par `superRefine` : `start` désigne un
   nœud existant, et chaque `next` aussi (un graphe qui pointe dans le vide
   est rejeté au chargement, pas découvert en cours de route) ;
3. chaque skill référencé par un nœud a bien un fichier
   `skills/<skill>/SKILL.md` (`skillFile`) ;
4. chaque variable `"NOM"` de `env` existe dans l'environnement du démon.

Toute violation lève une erreur explicite. `loadTasks(tasksDir)` parcourt
tous les sous-dossiers de `tasks/` contenant un `task.json`, charge chacun
avec `loadTask`, et sépare le résultat en deux listes plutôt que de tout
faire échouer :

```ts
export async function loadTasks(
  tasksDir: string,
): Promise<{ tasks: Task[]; errors: TaskLoadError[] }> {
```

Une tâche cassée (`errors`) n'empêche pas les autres de tourner ; le démon
et `unused status` affichent ces erreurs sans planter (voir
`taskErrors` dans `DaemonStatus`, `src/daemon.ts`).

## Le curseur : où en est une tâche

`task.ts` décrit le graphe, mais pas où on en est — c'est le rôle de
`TaskState` (`src/state.ts`), persisté dans `data/state.json` :

```ts
const TaskStateSchema = z.object({
  // Nœud courant : celui que la prochaine itération exécute.
  cursor: z.string(),
  status: z.enum(["running", "done", "failed"]),
  iterations: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  last: z.object({ at: z.string(), node: z.string(), outcome: z.string() }).optional(),
});
```

`ensureTaskState` initialise le curseur à `start` pour une tâche jamais vue,
et le ramène à `start` si `task.json` a changé entre-temps et que le nœud
pointé n'existe plus — plutôt que de bloquer la tâche :

```ts
export function ensureTaskState(state: RunnerState, task: Task): TaskState {
  let ts = state.tasks[task.name];
  if (!ts) {
    ts = initialTaskState(task);
    state.tasks[task.name] = ts;
  } else if (!(ts.cursor in task.def.nodes)) {
    ts.cursor = task.def.start;
  }
  return ts;
}
```

À chaque itération (`iterate()` dans `src/iterate.ts`), le nœud exécuté est
`task.def.nodes[ts.cursor]` ; une issue `completed` fait avancer `cursor`
vers `node.next`, une issue ratée le laisse inchangé pour retenter le même
nœud. Le détail de cette bascule fait l'objet de la page sur le cycle d'une
itération.

## `describeGraph` : un graphe en une ligne

`describeGraph` déroule le chemin depuis `start` jusqu'au premier nœud déjà
vu, pour un résumé lisible d'un graphe (utile pour une inspection rapide,
par exemple en console) :

```ts
/** "setup → find → do → find (boucle)" — le chemin depuis start jusqu'au premier retour. */
export function describeGraph(def: TaskFile): string {
```

Sur l'exemple `setup → work → work`, ça donne `setup → work (boucle)`.
