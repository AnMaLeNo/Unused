# La configuration du démon

Toute la configuration passe par un unique fichier JSON, validé par un schéma
Zod dans `src/config.ts`. Par défaut c'est `unused.config.json` à la racine du
dépôt (`CONFIG_FILE`, `src/config.ts:6`), mais chaque commande accepte
`-c/--config <file>` (`src/cli.ts:14`) pour en pointer un autre.

## Chargement (`loadConfig`)

```ts
export async function loadConfig(file: string = CONFIG_FILE): Promise<Config> {
  const absFile = path.resolve(file);
  const rootDir = path.dirname(absFile);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absFile, "utf8"));
  } catch (err) {
    throw new Error(`Impossible de lire ${absFile} : ${(err as Error).message}`);
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${absFile} invalide :\n${formatZodError(parsed.error)}`);
  }
  ...
}
```

(`src/config.ts:51`) `loadConfig` lit le fichier, le parse en JSON, puis le
valide avec `ConfigFileSchema.safeParse` — `.strict()` sur le schéma racine et
chaque sous-objet, donc une clé inconnue ou mal orthographiée fait échouer le
chargement avec un message clair (`formatZodError`, `src/config.ts:74`)
plutôt que d'être silencieusement ignorée.

`rootDir` (le dossier contenant le fichier de config) sert ensuite à résoudre
en chemins absolus les champs relatifs du fichier : `tasksDir`, `dataDir` et
`docker.dockerfileDir` sont tous réécrits par rapport à `rootDir`, pas par
rapport au répertoire courant du process :

```ts
const cfg = parsed.data;
return {
  ...cfg,
  rootDir,
  tasksDir: path.resolve(rootDir, cfg.tasksDir),
  dataDir: path.resolve(rootDir, cfg.dataDir),
  docker: { ...cfg.docker, dockerfileDir: path.resolve(rootDir, cfg.docker.dockerfileDir) },
};
```

Le type `Config` retourné est donc `z.infer<typeof ConfigFileSchema>` plus ce
`rootDir` ajouté après coup (`src/config.ts:46`).

## Le schéma (`ConfigFileSchema`)

Chaque champ a une valeur par défaut, donc `unused.config.json` peut être
vide (`{}`) et tourner avec des réglages raisonnables. Le dépôt en fournit un
exemple à la racine :

```json
{
  "tasksDir": "./tasks",
  "dataDir": "./data",
  "claude": {
    "sessionArgs": ["--output-format", "json", "--no-session-persistence", "--dangerously-skip-permissions"],
    "timeoutMinutes": 180
  },
  "docker": {
    "baseImage": "unused-base",
    "dockerfileDir": "./docker",
    "flattenAfterLayers": 30
  },
  "windows": [{ "days": ["mon"], "from": "00:00", "to": "13:00" }],
  "scheduler": {
    "backoffMinutes": 15,
    "retrySeconds": 60,
    "maxConsecutiveFailures": 3
  }
}
```

- **`tasksDir`** (défaut `./tasks`) — dossier contenant un sous-dossier par
  tâche (`task.json` + skills), voir
  [le modèle de tâche](modele-de-tache.md).
- **`dataDir`** (défaut `./data`) — état persistant du démon : c'est aussi
  là que vit le socket Unix de l'API, via `socketPath()`
  (`src/api.ts:14` : `path.join(cfg.dataDir, SOCKET_FILE)`), voir
  [l'API HTTP et la CLI cliente](api-et-cli.md).
- **`claude`**
  - `sessionArgs` (défaut `[]`) — arguments ajoutés à *chaque* session
    `claude -p`, quel que soit le nœud du graphe de skills. Le runner
    garantit par ailleurs la présence de `--output-format json`, nécessaire
    pour lire `terminal_reason` (voir
    [le parsing de la sortie Claude](parsing-sortie-claude.md)).
  - `timeoutMinutes` (défaut `180`) — au-delà, la session est tuée et
    l'itération comptée en échec.
- **`docker`**
  - `baseImage` (défaut `unused-base`) et `dockerfileDir` (défaut `./docker`,
    résolu en absolu) — l'image de base et où trouver son Dockerfile.
  - `flattenAfterLayers` (défaut `30`) — au-delà de ce nombre de couches,
    l'image de la tâche est aplatie ; voir
    [le container comme état persistant](container-etat-persistant.md).
- **`windows`** (défaut `[]`) — les plages automatiques, validées par
  `WindowSpecSchema` (`src/calendar.ts:11`) : une liste de jours (`days`,
  parmi `sun`..`sat`) et une paire d'heures locales `from`/`to` au format
  `HH:MM`. Voir [les plages automatiques](plages-automatiques.md) pour le
  calcul de couverture qui en découle.
- **`scheduler`**
  - `backoffMinutes` (défaut `15`) — attente globale après un quota saturé,
    utilisée quand l'API ne fournit pas de `resetsAt`.
  - `retrySeconds` (défaut `60`) — pause avant de rejouer une tâche après un
    échec hors quota.
  - `maxConsecutiveFailures` (défaut `3`) — échecs consécutifs avant de
    sortir une tâche de la file.

  Le détail de leur usage est dans [le scheduler](scheduler.md).

## Où `loadConfig` est appelé

Uniquement depuis `src/cli.ts`, à deux endroits distincts (`src/cli.ts:7`) :

```ts
/** Démon uniquement : la config, puis un éventuel .env à côté (token) sans écraser l'environnement. */
async function daemonSetup(): Promise<Config> {
  const cfg = await loadConfig(program.opts().config);
  const envFile = path.join(cfg.rootDir, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return cfg;
}

/** Client : où est le démon ? Flag, variable d'environnement, sinon déduit de la config. Jamais .env. */
async function sock(): Promise<string> {
  const opts = program.opts<{ socket?: string; config: string }>();
  if (opts.socket) return path.resolve(opts.socket);
  if (process.env.UNUSED_SOCKET) return path.resolve(process.env.UNUSED_SOCKET);
  return socketPath(await loadConfig(opts.config));
}
```

- `daemonSetup()` est utilisée par la commande `daemon` (le process lancé par
  systemd) : elle charge la config, puis, s'il existe un fichier `.env` à côté
  du fichier de config (`cfg.rootDir`), le charge avec
  `process.loadEnvFile` — c'est le mécanisme attendu pour fournir
  `CLAUDE_CODE_OAUTH_TOKEN` sans le committer.
- `sock()` sert à toutes les commandes clientes (`status`, `add-task`, etc.) :
  elles n'ont besoin que du socket Unix pour parler au démon déjà lancé, donc
  elles ne chargent jamais `.env` — la résolution privilégie le flag
  `--socket`, puis `$UNUSED_SOCKET`, et ne retombe sur la config que pour en
  déduire `dataDir` → le chemin du socket.

Un fichier de config invalide fait donc échouer immédiatement la commande
lancée, avec le détail Zod (chemin du champ + message) plutôt qu'une erreur
générique.
