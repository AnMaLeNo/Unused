# 033 — `env` d'une tâche : l'environnement du client `docker` de l'hôte

**Fichiers examinés** : `src/docker.ts:20-60` (`docker()`), `src/docker.ts:101-150`
(`resolveTaskImage`, `runInTask`), `src/docker.ts:152-185` (`discardContainer`,
`layerCount`, `commitTask`, `pruneTask`), `src/docker.ts:213-253`
(`flattenTask`, `pipeExportImport`, `removeTaskImages`), `src/task.ts:27-46`
(`ENV_ENTRY_RE`, schéma `env`), `src/task.ts:85-106` (`resolveEnv`),
`src/task.ts:147-160`, `src/iterate.ts:24-31` (`defaultDeps.killContainer`),
`src/iterate.ts:99-147`, `src/iterate.ts:166-190`, `src/graph.ts:40-53`
(`classify`), `src/scheduler.ts:83-134`, `src/daemon.ts:177-226`,
`src/dockerCheck.ts:36-60`, `src/scaffold.ts:5-30`, `docker/Dockerfile:13-23`.

**Verdict** : 3 constats (1 sûr, 2 probables)

Rappel du mécanisme, car les trois constats en découlent. Les valeurs de `env`
ne passent pas par la ligne de commande : `runInTask` n'émet que `-e NOM`
(`docker.ts:145`) et fournit les valeurs via l'environnement du **processus
`docker` de l'hôte** (`docker.ts:31`), ce qui protège bien les secrets de `ps`
(déjà noté en 012). Mais la fusion est faite dans ce sens :

```ts
// src/docker.ts:30-33
const child = spawn("docker", args, {
  env: { ...process.env, ...opts.env },
```

`opts.env` est en dernier : **une entrée de `task.json` écrase la variable de
même nom dans l'environnement du client `docker`**. Et aucun nom n'est réservé :
`ENV_ENTRY_RE` (`task.ts:27`) accepte tout identifiant, `resolveEnv`
(`task.ts:89-106`) ne filtre rien, il n'y a aucune liste d'exclusion dans
`src/` (`grep -rni "denylist\|blacklist\|reserved\|DOCKER_HOST" src/` → vide).
`docker.ts:148` est le seul appel de `docker()` qui reçoit `env`.

## Les variables d'une tâche reconfigurent le client `docker` de l'hôte

**Gravité** : sûr
**Où** : `src/docker.ts:31` et `src/docker.ts:148`, alimentés par
`src/iterate.ts:125` et `src/task.ts:46`

Le CLI `docker` lit sa propre configuration dans son environnement :
`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`,
`DOCKER_TLS_VERIFY`, `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM`,
`DOCKER_CONTENT_TRUST`, et `HOME` (pour `~/.docker/config.json`, donc
`currentContext` et les helpers d'identifiants). Toutes ces variables sont des
entrées `env` valides, et une tâche qui les déclare pour *son container* les
impose en même temps au client qui lance ce container.

Scénario concret, sur la machine de ce projet (Pi, `aarch64`). Une tâche veut
que l'agent construise des images x86 dans son container :

```json
{ "env": ["DOCKER_DEFAULT_PLATFORM=linux/amd64"] }
```

Chargement : accepté (`ENV_ENTRY_RE`, forme littérale, aucun nom manquant).
Itération : `iterate.ts:125` passe `{DOCKER_DEFAULT_PLATFORM: "linux/amd64",
CLAUDE_CODE_OAUTH_TOKEN: …}`, `runInTask` ajoute `-e DOCKER_DEFAULT_PLATFORM`
puis lance le client avec cette variable. Le client en déduit un `--platform`
implicite et refuse l'image `arm64` de la tâche : code 125, stdout vide.
Ensuite, dans `iterate` : `session.result === null`, `isDockerDown(r.stderr)`
est faux (le message ne parle pas du démon), donc `classify`
(`graph.ts:52`) rend `{kind:"failure", reason:"unreadable_output"}` → `retry`,
puis `task-failed` au bout de `maxConsecutiveFailures`. Résultat obtenu : la
tâche est sortie de la file pour « sortie illisible », attribuée à Claude.
Résultat attendu : la variable ne concernait que le container, l'itération
aurait dû tourner normalement.

La même mécanique vaut pour `HOME=/work` — un choix naturel puisque les skills
sont montés dans `/work/.claude/skills` (`iterate.ts:127`) et que `WORKDIR` vaut
`/work` (`Dockerfile:23`) : le client `docker` cesse alors de lire le
`~/.docker/config.json` de l'opérateur et perd son `currentContext` et ses
`credHelpers`.

Cas voisin que je n'ai **pas** pu vérifier ici (ni `node` ni `docker` dans ce
container) : une entrée `PATH=…` change aussi la façon dont le binaire `docker`
lui-même est localisé. Sous Linux, libuv exécute `environ = options->env` puis
`execvp()` dans l'enfant, donc la recherche utiliserait le *nouveau* `PATH`
(sous macOS, `posix_spawnp` utiliserait celui de l'appelant). Si c'est le cas,
l'échec remonte en `DockerError` « docker introuvable : est-il installé et dans
le PATH ? » (`docker.ts:47`) → `finishFatal("docker", …)` (`iterate.ts:145`) →
`stop-window` et bannière `PANNE docker` du démon (`daemon.ts:206-207`), qui
accuse l'installation Docker de l'hôte pour une ligne de `task.json`. À
confirmer sur une machine équipée.

## `env` n'est appliqué qu'à `docker run` : le reste du cycle de vie vise un autre démon

**Gravité** : probable
**Où** : `src/docker.ts:131` (`resolveTaskImage`), `src/docker.ts:148` (seul
appel avec `env`), `src/docker.ts:152-180`, `src/iterate.ts:28`

Dans `runInTask`, le choix de l'image précède le lancement et se fait **sans**
`env` :

```ts
// src/docker.ts:130-148
const image = await resolveTaskImage(cfg, taskName);   // docker image inspect — env hôte
…
const r = await docker(args, { stdin: opts.stdin, env: opts.env });  // docker run — env tâche
```

Idem pour tout ce qui suit l'itération : `killContainer` (`iterate.ts:28`,
`docker kill`), `commitTask` (`docker.ts:166-180` : `tag`, `commit`, `rm`,
`image inspect`, `image prune`), `discardContainer`, `flattenTask` et
`pipeExportImport` (`spawn` direct, sans `env` du tout). Tant que les variables
de la tâche ne touchent pas la cible du client, cette asymétrie est invisible ;
dès qu'une entrée `DOCKER_HOST`, `DOCKER_CONTEXT` ou `HOME` la déplace (constat
précédent), les deux moitiés du cycle parlent à deux démons différents :

- `resolveTaskImage` interroge le démon A. Si A n'a pas
  `unused-task-<nom>:latest`, il renvoie `cfg.docker.baseImage`
  (`docker.ts:104`) : le `docker run` part de l'**image de base** sur le démon B
  alors que l'état accumulé de la tâche est sur B sous `:latest`. Le travail
  des itérations précédentes est ignoré, le curseur avance quand même.
- `commitTask` s'exécute sur A avec un nom de container qui n'existe que sur B :
  `docker commit` échoue, `mustSucceed` lève, et `iterate.ts:172-183` déroule
  le rattrapage prévu — curseur remis, `iterations -= 1`, `fatal: docker`.
  L'itération réussie est perdue, et le container reste sur B : aucun appel ne
  le voit (`discardContainer` vise A), rien dans `src/` ne balaie les
  containers par label.
- `killContainer` vise A : le délai d'expiration (`iterate.ts:129-132`) et
  l'`AbortSignal` (`iterate.ts:134-138`) ne tuent plus rien — `docker()` ne
  lève pas sur code ≠ 0 et le résultat est jeté (`void`). Si le container
  tourne sur B, `docker run` reste attaché, `deps.runInTask` ne se résout
  jamais : `timedOut` est bien passé à `true` mais l'itération ne se termine
  pas, la plage dépasse sa deadline (`scheduler.ts:83`) et `unused stop`
  (`daemon.ts:321`, `run.ac.abort()`) ne rend pas la main. Cette branche-là
  suppose que le `docker run` ait réellement démarré sur B (image présente).

## Une entrée `env` sans valeur peut écraser le `PATH` de l'image dans le container

**Gravité** : probable
**Où** : `src/task.ts:101-103` (forme « NOM »), `src/docker.ts:145`

La forme sans `=` recopie la valeur de l'hôte dans le container. Pour `PATH`,
c'est la valeur du démon `unused`, et `-e PATH=…` **écrase** le `ENV PATH` de
l'image :

```dockerfile
# docker/Dockerfile:13-14
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"
```

Le binaire `claude` n'est accessible que par ce `PATH`, et c'est `claude` qui
est exécuté (`claude.ts:37`, `["claude", "-p", …]`). Avec
`{"env": ["PATH"]}` — accepté sans réserve, puisque `resolveEnv` ne signale
dans `missing` que les noms *absents* de l'environnement du démon
(`task.ts:156-159`), et `PATH` y est toujours — le container reçoit un `PATH`
hôte sans `/root/.local/bin` : `docker run` échoue sur `executable file not
found in $PATH` (code non nul, stdout vide), donc `unreadable_output`, `retry`,
puis `task-failed`. Le `stderr` est bien journalisé et affiché
(`iterate.ts:227`), donc le diagnostic reste possible ; ce qui est faux, c'est
qu'une entrée documentée comme « variable donnée au container »
(`scaffold.ts:25-27`) puisse désarmer l'image. Même famille : `HOME` recopié
depuis un démon systemd (`HOME=/home/unused` inexistant dans l'image) déplace
la configuration de Claude Code hors de `/root`.

## Ce qui a été vérifié et tient

- **`docker.ts:145` ne met aucune valeur sur la ligne de commande** : seuls les
  *noms* sont passés en `-e NOM`, et `opts.env` contient une valeur explicite
  pour chaque clé — la résolution ne dépend donc pas de ce que le démon a
  hérité. Conclusion de 012 inchangée ; le défaut est le sens de la fusion, pas
  le procédé.
- **Le token est bien le dernier mot** (`iterate.ts:125`,
  `{...taskEnv.env, [TOKEN_ENV]: token}`) : une entrée
  `CLAUDE_CODE_OAUTH_TOKEN=…` dans `task.json` est écrasée, pas honorée.
- **`buildBase`, `dockerVersion`, `imageExists`, `pruneTask`, `removeTaskImages`,
  `pipeExportImport`** n'acceptent pas d'`env` du tout : elles héritent
  uniquement de l'environnement du démon, ce qui est cohérent — c'est
  `runInTask` qui introduit la divergence, pas elles.
- **`dockerCheck`** (`dockerCheck.ts:57`, `83`) appelle `runInTask` sans `env` :
  le bilan Docker ne peut pas être faussé par une tâche, et il ne détecterait
  donc pas non plus le problème.
- **Les valeurs ne sont jamais réinjectées dans l'image** : `importChanges`
  (`docker.ts:199-211`) reconstruit l'`ENV` lu sur l'image aplatie, pas
  l'`opts.env` de l'itération (le scellement du token dans l'image par
  `commit`, lui, est déjà couvert par 019).
- **`resolveEnv`** : découpe sur le premier `=`, `"NOM="` → valeur vide, doublon
  écrasé par le dernier — déjà vérifié en 012, rien de nouveau.
