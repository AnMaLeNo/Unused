# 039 — `env` déclarée mais absente : exclusion de la tâche, et chemin `fatal:auth` mort

**Fichiers examinés** : `src/task.ts:27-46` (`ENV_ENTRY_RE`, champ `env`),
`src/task.ts:85-106` (`resolveEnv`), `src/task.ts:147-160` (fin de `loadTask`),
`src/task.ts:162-186` (`loadTasks`), `src/iterate.ts:24-31` (`defaultDeps`),
`src/iterate.ts:99-106` (token + `env` de la tâche), `src/iterate.ts:232-236`
(`finishFatal`), `src/cli.ts:17-23` (`daemonSetup`), `src/daemon.ts:276-280`
(`Daemon.loadTasks`), `src/daemon.ts:389-395` (`findTask`),
`src/daemon.ts:396-418` (`resetTask`, `setActive`), `src/scheduler.ts:56-93`,
`src/graph.ts:105-130` (`isEligible`, `pickNext`), `src/api.ts:86-95` et
`119-122`, `src/client.ts:42-45`, `src/scaffold.ts:5-30`,
`deploy/unused.service:16-19`, `README.md:100-130`.

**Verdict** : 2 constats (2 sûrs)

Le mécanisme, d'abord, car les deux constats en découlent. Une entrée `env` de
la forme `"NOM"` est résolue contre l'environnement du démon, et refusée deux
fois si elle y manque :

```ts
// src/task.ts:155-159 — au chargement de la tâche
const env = resolveEnv(task.def.env, process.env);
if (env.missing.length > 0) {
  throw new Error(`variables absentes de l'environnement du démon (.env) : ${env.missing.join(", ")}`);
}
```

```ts
// src/iterate.ts:103-106 — à chaque itération
const taskEnv = resolveEnv(task.def.env, deps.env);
if (taskEnv.missing.length > 0) {
  return finishFatal("auth", `variables absentes de l'environnement du démon : ${taskEnv.missing.join(", ")}`);
}
```

Les deux sources sont le **même objet** : `process.env` directement en
`task.ts:156`, et `defaultDeps.env = process.env` en `iterate.ts:29`, que
`scheduler.ts:66` n'écrase jamais (`iterate(cfg, task, state, {print, signal})`,
sans `deps`). Et cet objet est figé : le seul endroit où le `.env` est lu est

```ts
// src/cli.ts:19-21
const envFile = path.join(cfg.rootDir, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
```

appelé une fois dans `daemonSetup()`, avant `new Daemon(...)`. `grep -rn
"loadEnvFile\|dotenv" src/ deploy/ docker/` ne rend que cette ligne, aucune
affectation ni `delete` sur `process.env` n'existe dans `src/`, et l'unité
systemd n'a pas d'`ExecReload` (`deploy/unused.service:16-19` :
`EnvironmentFile=`, `ExecStart=`, `Restart=always`, `RestartSec=5`).

## La réparation prescrite par le message (« mets-la dans `.env` ») ne répare rien sans redémarrage du service

**Gravité** : sûr
**Où** : `src/cli.ts:21`, message émis en `src/task.ts:158` et `src/iterate.ts:101`

Le `.env` du démon est lu au démarrage du processus et plus jamais. Les messages
d'erreur, eux, désignent le fichier comme le levier de réparation :
« variables absentes de l'environnement du démon (.env) : GH_TOKEN »
(`task.ts:158`), « `CLAUDE_CODE_OAUTH_TOKEN` absent : lance `claude
setup-token` et mets le token dans .env » (`iterate.ts:101`). Éditer le fichier
ne change rien à `process.env` du démon en cours d'exécution, donc l'erreur
persiste à l'identique après le geste demandé.

**Scénario concret**, celui du parcours documenté par `scaffold.ts` (README de
la tâche, lignes 25-27 : « `"GH_TOKEN"` transmet la valeur du `.env` du démon ») :

1. `unused tasks new monrepo` → `task.json` avec `active: false`, `env: []`
   (`scaffold.ts:5-14`). La tâche se charge sans erreur.
2. L'opérateur ajoute `"env": ["GH_TOKEN"]` pour cloner un dépôt privé, puis
   ajoute `GH_TOKEN=ghp_…` à `/opt/unused/.env`. Le service tourne depuis des
   jours.
3. `unused tasks activate monrepo` → `POST /tasks/monrepo/active`
   (`api.ts:86-95`) → `setActive` → `findTask` (`daemon.ts:411`, `390`) →
   `loadTasks` → `loadTask` lève en `task.ts:158` → `NotFoundError`
   (`daemon.ts:394`) → HTTP 404 (`api.ts:120`) → `ApiError`
   (`client.ts:43-44`) → la CLI affiche et sort en 1 :

   ```
   tâche monrepo invalide : variables absentes de l'environnement du démon (.env) : GH_TOKEN
   ```

   Résultat obtenu : la tâche est refusée en nommant un fichier qui contient
   déjà la variable. Résultat attendu : soit l'activation réussit, soit le
   message dit qu'il faut redémarrer le service pour que le `.env` soit relu.
   Le `task.json` n'est pas réécrit (`setActive` lève avant
   `writeFile`, `daemon.ts:411-415`) : la tâche reste `active: false`.

Le même mur se dresse sur `unused tasks reset monrepo` (`findTask`,
`daemon.ts:397`) et sur `unused tasks deactivate` : les trois commandes de
gestion d'une tâche passent par `findTask`, donc aucune n'est utilisable sur une
tâche dont une variable manque — y compris celles qui servent à la sortir de la
file.

Et la variante token aggrave le cas, parce que le `README` propose les deux
remèdes comme équivalents :

```
README.md:109-111
Deux pannes sont globales et arrêtent la plage … le token refusé (401/403) et
Docker injoignable. `status` l'affiche en tête ; réparer, puis `unused start`
ou redémarrer le service.
```

`unused start` (`daemon.startWindow`, `daemon.ts:283-306`) ne relit pas le
`.env` : il vérifie Docker, pose `manual`, efface `this.fatal` et réveille la
boucle. Première itération de la nouvelle plage : `deps.env[TOKEN_ENV]` est
toujours `undefined`, `finishFatal("auth", …)` → `stop-window` →
`PANNE auth` immédiate, plage consommée pour rien. Des deux remèdes annoncés,
un seul fonctionne pour une réparation faite dans `.env`, et c'est le second.
Même constat pour l'écran de `status` (`cli.ts:95-96` : « répare, puis `unused
start` ou redémarre le service »).

## Le second contrôle (`iterate.ts:103-106`) est inatteignable : il n'y a aucun rattrapage entre deux itérations

**Gravité** : sûr
**Où** : `src/iterate.ts:103-106`, inatteignable depuis `src/scheduler.ts:66`

Pour que `taskEnv.missing` soit non vide, il faudrait qu'un `Task` arrive dans
`iterate` avec une entrée `env` absente de `deps.env`. Or :

- le seul appelant de production est `scheduler.ts:66`, qui ne passe pas de
  `deps` → `deps.env === process.env` (`iterate.ts:29`) ;
- le `Task` vient de `pickNext(await loadTasks(), state)` (`scheduler.ts:88`),
  c'est-à-dire de `Daemon.loadTasks` → `loadTask`, qui vient de valider
  `task.def.env` contre ce même `process.env` (`task.ts:156`) — les tâches sont
  rechargées **avant chaque itération**, donc la validation précède l'appel de
  quelques millisecondes ;
- `process.env` n'est pas modifiable entre les deux : rien dans `src/` ne
  l'écrit, et `loadEnvFile` a déjà eu lieu avant `Daemon.init()`.

`resolveEnv` étant pure et appelée avec les deux mêmes arguments, le second
contrôle rend toujours `missing: []`. La branche est morte hors tests
(`iterate.test.ts:194-199` la force via `deps({env: {...}})`).

La conséquence n'est pas seulement du code mort : le filet de sécurité qu'elle
semble tendre n'existe pas. Un `.env` amputé entre deux itérations n'est pas
rattrapé — il n'est même pas vu, puisque le démon ne relit pas le fichier
(constat précédent). Scénario concret :

1. Une tâche tourne avec `"env": ["GH_TOKEN"]`, `GH_TOKEN=ghp_ancien` dans
   `.env`, chargé au démarrage du service.
2. Le jeton fuite. L'opérateur **retire la ligne du `.env`** — le geste attendu
   pour couper l'accès — et laisse le démon tourner.
3. Itération suivante : `process.env.GH_TOKEN` vaut toujours `ghp_ancien`
   (lecture figée). `loadTask` ne signale rien, `iterate.ts:103` ne signale
   rien, `runInTask` pousse `-e GH_TOKEN` avec cette valeur
   (`docker.ts:145`, `docker.ts:31`).

Résultat obtenu : la variable retirée du `.env` continue d'être injectée dans
chaque container, pour toute la durée de vie du service, sans une ligne dans le
log d'itération (`IterationRecord` ne journalise pas l'environnement) ni dans
`status`. Résultat attendu, d'après les deux contrôles existants : la tâche part
en `taskErrors`, ou l'itération s'arrête en `fatal: auth`. Le seul geste
efficace est `systemctl restart unused`, que rien n'indique.

Ce constat corrige deux affirmations des rapports précédents, vérifiables sur
`cli.ts:19-21` : 012 (« Un `.env` amputé entre deux itérations est donc
rattrapé ») et 026 (« modifier une variable d'environnement du démon est pris en
compte à l'itération suivante, sans redémarrage »). C'est vrai d'une variable
changée dans l'environnement *du processus* (impossible de l'extérieur), pas
d'une variable changée dans le fichier `.env`. À distinguer aussi de 019, qui
traite du cas voisin où c'est l'`Env` scellée dans l'image qui conserve la
valeur : ici la valeur survit dans le démon lui-même, image neuve ou pas.

## Ce qui a été vérifié et tient

- **L'exclusion n'est pas silencieuse**, contrairement à la formulation de
  l'aspect : `Daemon.loadTasks` imprime `tâche <nom> ignorée : <message>`
  (`daemon.ts:278`) à chaque rechargement, `status` et `GET /tasks` renvoient
  `taskErrors` (`daemon.ts:371`, `api.ts:83-84`), `printTasks` les affiche en
  `ERREUR` (`cli.ts:122`) et `unused tasks list` sort en code 1
  (`cli.ts:131`). La visibilité est bonne ; ce qui manque, c'est l'indication
  du bon geste de réparation (constat 1).
- **La politique « tâche refusée en entier »** est la même que pour toutes les
  autres erreurs de chargement (JSON illisible, nœud `next` inconnu, `SKILL.md`
  absent) : `loadTasks` capture l'exception par tâche et continue
  (`task.ts:176-181`), les autres tâches tournent. `env` n'introduit pas
  d'asymétrie de ce côté.
- **La bascule `nothing-eligible` → pause des plages automatiques** quand la
  tâche exclue était la seule active est le comportement déjà décrit en 008,
  018 et 035 ; rien de spécifique à `env` à y ajouter.
- **`pickNext` tolère un `currentTask` périmé** : la tâche collante est
  cherchée dans `eligible` (`graph.ts:122-124`) et, si elle a disparu de la
  liste, le round-robin reprend sans erreur (`graph.ts:126-131`). L'exclusion
  d'une tâche en cours ne bloque donc pas la file.
- **Aucune perte d'état** : `state.tasks[<nom>]` et l'image
  `unused-task-<nom>:latest` survivent à l'exclusion ; une fois le `.env`
  complété et le service redémarré, la tâche repart à son curseur.
- **`resolveEnv`** (`task.ts:89-106`) : relue une fois de plus, elle est pure et
  conforme — découpe sur le premier `=`, `"NOM="` → valeur vide, variable hôte
  présente mais vide **non** comptée comme manquante (`v === undefined`,
  `task.ts:102`). Déjà couvert par 012 et 026.
- **`process.loadEnvFile` n'écrase pas l'environnement existant**, conformément
  au commentaire de `cli.ts:17` : sous systemd, `EnvironmentFile=` a déjà
  chargé le même fichier au démarrage du service, donc les deux lectures
  coïncident — et gèlent au même instant.
