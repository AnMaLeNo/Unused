# 019 — Isolation du container d'itération : ressources, privilèges, secrets

**Fichiers examinés** : `docker/Dockerfile` (entier), `src/docker.ts:107-150`
(`RunOptions`, `runInTask`), `src/docker.ts:166-185` (`commitTask`, `pruneTask`),
`src/docker.ts:199-248` (`importChanges`, `flattenTask`, `pipeExportImport`),
`src/docker.ts:250-254` (`removeTaskImages`), `src/iterate.ts:99-147`,
`src/task.ts:20-27` et `:85-106` et `:147-160` (`env`, `resolveEnv`),
`src/claude.ts:86-112` (`parseStream`), `src/graph.ts:41-53` (`classify`),
`src/daemon.ts:96-113` (`init`) et `:397-407` (`resetTask`),
`src/dockerCheck.ts:36-111`, `deploy/install.sh`, `deploy/unused.service`,
`unused.config.json`, `README.md:1-80`.

`docker` n'est pas installé dans le container d'audit (`command -v docker` →
rien) : les constats ci-dessous sont établis par lecture du code et par la
sémantique documentée de `docker commit` / `docker import`, pas par exécution.
Les commandes de reproduction sont données à chaque fois.

**Verdict** : 3 constats (2 sûrs, 1 probable)

## `docker commit` scelle le token et les secrets de tâche dans l'image de la tâche

**Gravité** : sûr
**Où** : `src/docker.ts:171-174`, alimenté par `src/iterate.ts:125` et `src/docker.ts:145`

Les variables sont transmises au container par `-e NOM` sans valeur, avec la
valeur posée dans l'environnement du processus `docker` :

```ts
// src/docker.ts:111-113 — l'intention affichée
// Variables transmises au container. Elles passent par l'environnement du
// processus docker (`-e NOM` sans valeur), pas par la ligne de commande,
// pour qu'un token n'apparaisse jamais dans `ps`.

// src/docker.ts:145
for (const name of Object.keys(opts.env ?? {})) args.push("-e", name);
```

Ce que ce détour protège, c'est l'argv du processus `docker run`. Il ne change
rien au fait que la CLI résout `-e NOM` contre son propre environnement et
envoie `NOM=valeur` dans la configuration du container créé : `Config.Env` du
container contient donc `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…` et toute
entrée `env` de la tâche (`iterate.ts:125` :
`env: { ...taskEnv.env, [TOKEN_ENV]: token }`).

Or l'itération réussie commite ce container :

```ts
// src/docker.ts:171-174
await mustSucceed(
  ["commit", "--change", `LABEL ${LABEL}=${taskName}`, container, `${name}:latest`],
  "commit du container",
);
```

`docker commit` construit la nouvelle image **à partir de la configuration du
container**, `Env` comprise ; `--change LABEL …` ajoute un label, il ne
réinitialise rien. Le token et les secrets de la tâche se retrouvent donc dans
`Config.Env` de `unused-task-<t>:latest`, puis, à l'itération suivante, dans
`:prev` par la rotation (`docker.ts:168-170`). Reproduction en une ligne :

```
docker run -e SECRET=x --name c debian:bookworm-slim true && docker commit c img \
  && docker image inspect img --format '{{json .Config.Env}}'
```

Le code du dépôt en dépend d'ailleurs explicitement ailleurs : `importChanges`
(`docker.ts:199-211`) reconstruit l'`Env` de l'image aplatie à partir de
`docker image inspect --format '{{json .Config}}'` de l'image de tâche — c'est
bien que l'`Env` d'une image issue d'un `commit` est peuplé. Et comme
l'aplatissement réémet chaque entrée telle quelle (`ENV NOM="valeur"`), la
valeur scellée ne se périme jamais : elle traverse les aplatissements intacte.

**Deux conséquences distinctes.**

*1. Une rotation de token ne purge rien.* Le seul chemin du code qui supprime
les images d'une tâche est `removeTaskImages`, appelé uniquement par
`resetTask` (`daemon.ts:404`) — qui commence par `delete this.state.tasks[name]`
(`daemon.ts:400`). Après régénération du token, l'opérateur a donc le choix
entre laisser l'ancien token scellé dans `:latest` et `:prev` de chaque tâche,
ou réinitialiser chaque tâche et perdre en même temps son curseur, son compteur
d'itérations et tout l'espace de travail accumulé dans l'image — c'est-à-dire
tout ce que le projet cherche à conserver (`README.md:16-19`).

*2. Une variable retirée de `task.json` continue d'être injectée, avec son
ancienne valeur.* C'est le vrai défaut fonctionnel, indépendant de toute
considération de secret. Scénario :

1. `tasks/t/task.json` porte `"env": ["GH_TOKEN"]`, le `.env` du démon porte
   `GH_TOKEN=ghp_ancien`. Une itération se termine en `completed` :
   `unused-task-t:latest` est commité avec `ENV GH_TOKEN=ghp_ancien`.
2. La clé est révoquée. L'opérateur retire `GH_TOKEN` du `task.json` **et** du
   `.env`, ce qui est exactement le geste attendu pour couper l'accès.
3. Itération suivante : `resolveEnv([], …)` renvoie `{}` (`task.ts:89-106`),
   `runInTask` ne pousse aucun `-e` pour cette variable (`docker.ts:145`), mais
   le container démarre depuis `:latest` — et y trouve toujours
   `GH_TOKEN=ghp_ancien` dans son environnement.

Attendu : la variable a disparu de l'environnement de la session. Obtenu : la
session la voit encore, figée à sa valeur d'il y a N itérations. Les deux
garde-fous qui existent pour ce genre de dérive — le `missing` du chargement
(`task.ts:156-159`, la tâche part en `taskErrors`) et celui de chaque itération
(`iterate.ts:103-106`, `fatal: auth`) — sont tous deux inopérants ici : ils
comparent `task.def.env` à l'environnement du **démon**, et n'ont aucune vue sur
l'`Env` de l'image. Rien n'est signalé, ni dans le log d'itération
(`IterationRecord` ne journalise pas l'environnement) ni dans `status`.

À noter que le cas symétrique fonctionne, lui : une valeur *modifiée* est bien
prise en compte, puisque `-e NOM` est toujours poussé pour les clés présentes
dans `opts.env` et que la valeur du processus `docker` écrase celle de l'image.
Seul le retrait d'une entrée est silencieusement sans effet.

## L'aplatissement remet le token en clair dans `ps`, ce que `-e NOM` était censé éviter

**Gravité** : sûr (conditionné au constat précédent : c'est l'`Env` scellée qui
est réémise)
**Où** : `src/docker.ts:228-234`, via `src/docker.ts:199-211`

`flattenTask` reconstruit la configuration perdue par `docker import` en
instructions Dockerfile, puis les passe en arguments `-c` :

```ts
// src/docker.ts:202-205
for (const kv of config.Env ?? []) {
  const i = kv.indexOf("=");
  changes.push(`ENV ${kv.slice(0, i)}=${q(kv.slice(i + 1))}`);   // q = JSON.stringify
}

// src/docker.ts:231-234
const importArgs = ["import"];
for (const c of changes) importArgs.push("-c", c);
importArgs.push("-", image);
const imp = spawn("docker", importArgs, { stdio: ["pipe", "pipe", "pipe"] });
```

`spawn` sans shell : ces chaînes sont l'argv du processus `docker import`. La
ligne de commande réellement présente sur l'hôte pendant l'aplatissement est
donc :

```
docker import -c 'ENV PATH="/root/.local/bin:/usr/local/sbin:…"' \
              -c 'ENV IS_SANDBOX="1"' -c 'ENV DISABLE_AUTOUPDATER="1"' \
              -c 'ENV CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-…"' \
              -c 'ENV GH_TOKEN="ghp_…"' -c 'WORKDIR /work' … - unused-task-t:latest
```

`/proc/<pid>/cmdline` est lisible par tous sur un Debian/Raspberry Pi OS par
défaut (pas de `hidepid`), donc `ps aux` de n'importe quel compte local, tout
collecteur de métriques qui échantillonne la table des processus, et toute
trace de support contenant un `ps` voient le token en clair. C'est précisément
l'exposition que le commentaire de `docker.ts:111-113` déclare écarter, et que
le rapport 012 avait vérifiée et validée sur le seul chemin `runInTask` — le
chemin `flattenTask` la rouvre.

La fenêtre n'est pas étroite : l'aplatissement se déclenche tous les
`flattenAfterLayers: 30` commits (`unused.config.json:16`) et fait transiter
tout le système de fichiers de la tâche par `docker export | docker import`,
soit plusieurs minutes sur la cible du projet, pendant lesquelles le processus
existe avec cet argv. Elle est aussi facile à provoquer : `dockerCheck`
(`dockerCheck.ts:93`) appelle `flattenTask` directement, donc un
`unused docker check` suffit à exercer le chemin (avec l'`Env` de la tâche de
test, vide de secrets — mais le code est le même).

`docker import` n'offre pas d'autre canal que `-c` pour ses instructions, mais
rien n'oblige à passer par lui pour restaurer l'`Env` : reconstruire l'image
aplatie par un `docker build` minimal (`FROM` l'image importée, les `ENV` dans
un Dockerfile sur disque) garde les valeurs hors de tout argv. Ne réémettre que
les variables héritées de l'image de base suffirait aussi — mais seulement si
le constat précédent est corrigé, sans quoi le token reste de toute façon dans
l'image.

## Aucune limite de ressources : un dépassement mémoire ressort en `unreadable_output` et retire la tâche

**Gravité** : probable
**Où** : `src/docker.ts:134-146`

L'inventaire est sans ambiguïté — `grep -rn "memory\|cpus\|pids\|ulimit\|cap-drop\|security-opt\|storage-opt\|read-only\|tmpfs\|--user" src docker deploy` ne
renvoie que deux lignes de `deploy/unused.service` sans rapport. La commande
construite est :

```ts
// src/docker.ts:134-146
const args = ["run", "--name", container, "--label", `${LABEL}=${taskName}`,
              "-v", `${opts.exchangeDir}:/exchange`];
for (const m of opts.mounts ?? []) args.push("-v", `${m.host}:${m.container}${m.readonly ? ":ro" : ""}`);
if (opts.stdin !== undefined) args.push("-i");
for (const name of Object.keys(opts.env ?? {})) args.push("-e", name);
args.push(image, ...opts.cmd);
```

Pas de `--memory`, `--memory-swap`, `--cpus`, `--pids-limit`, `--ulimit`, pas de
`--storage-opt`, pas de `--network`, pas de `--cap-drop` ni de
`--security-opt no-new-privileges`. Le container est root
(`docker/Dockerfile:1-3`, assumé) avec le jeu de capacités par défaut, et la
session tourne en `--dangerously-skip-permissions` (`unused.config.json:8`) :
aucun accord n'est demandé pour aucun appel d'outil. La seule borne d'une
itération est un `setTimeout` côté hôte, dans le processus démon
(`iterate.ts:129-132`, `timeoutMinutes: 180`) — une borne de temps, jamais de
ressource.

Ce qui est *démontrable* ici, au-delà de l'absence elle-même, c'est ce que
devient un dépassement mémoire. Le cgroup du container n'ayant pas de
`memory.max`, il n'y a pas d'OOM scopé : c'est l'OOM killer global qui tranche
quand l'hôte est à court, et il vise le plus gros `oom_score` — le processus
emballé lui-même, dans le cas courant. Il reçoit SIGKILL, PID 1 du container
meurt, `docker run` sort en 137 avec un stdout coupé net. Côté runner :

- `parseStream` (`claude.ts:86-112`) ne trouve pas de message `result` →
  `result: null`, mais `lines > 0` (la session avait déjà émis son `system/init`
  et des événements) ;
- `iterate.ts:158` ne peut donc pas requalifier en `fatal: docker` (la
  condition exige `session.lines === 0`) ;
- `classify` (`graph.ts:52`) renvoie
  `{ kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" }` ;
- `timedOut` vaut `false` (le timer du démon n'a pas tiré), donc rien ne
  distingue ce cas d'une sortie illisible ordinaire.

L'itération est comptée en échec ordinaire, `retry`, et la ligne affichée est
`issue unreadable_output → retry`. Trois de suite
(`maxConsecutiveFailures: 3`) et la tâche sort de la file en `task-failed`,
définitivement jusqu'à un `unused tasks reset`. Le seul élément qui nomme la
vraie cause est `exitCode: 137` dans le fichier de log (`iterate.ts:203`), que
rien ne lit ni n'affiche : ni le résumé imprimé (`iterate.ts:219-229`), ni
`index.jsonl` (`log.ts:49-65`, qui ne reprend pas `exitCode`), ni `status`. Un
opérateur voit une tâche retirée pour « sortie illisible », là où la machine
manquait de mémoire.

Une limite `--memory` ne se contenterait pas de borner les dégâts : elle
rendrait le diagnostic possible, Docker positionnant alors `State.OOMKilled` sur
le container — que `iterate` pourrait lire avant de jeter le container
(`iterate.ts:185`), ce qu'aucune limite ne permet aujourd'hui.

Je classe ce constat *probable* et non *sûr* : la chaîne de code est certaine,
mais je n'ai pas pu provoquer un OOM réel ici pour confirmer que `claude` est
bien la victime désignée et que son stdout est effectivement tronqué avant le
message `result`. Le mode d'échec voisin — l'OOM killer frappant le démon plutôt
que le container — relève du rapport 001 (containers orphelins après un SIGKILL
du démon) et n'est pas repris ici.

## Ce qui a été vérifié et tient

- **Le montage des skills est bien en lecture seule** : `iterate.ts:127` passe
  `readonly: true` et `docker.ts:143` produit le suffixe `:ro`. Une session ne
  peut pas réécrire les skills du graphe pour l'itération suivante, ce que le
  commentaire `iterate.ts:126` annonce.
- **Rien de ce que le container produit n'est exécuté côté hôte.** Le seul
  chemin de retour est `/exchange`, et le démon n'en fait qu'une chose : tester
  l'existence de `DONE` (`iterate.ts:151`) et l'effacer. Aucun `exec`, aucun
  `require`, aucune désérialisation d'un fichier venu du container.
- **L'API du démon est hors de portée du container** : elle écoute sur un socket
  Unix dans `dataDir` (`api.ts:14-16`, `listen` + `chmod 660`), et `dataDir`
  n'est jamais monté — les seuls montages sont `exchangeDir` et `skillsDir`
  (`docker.ts:141-143`). Le réseau ouvert du container ne lui donne donc pas
  prise sur le pilotage du démon.
- **Le nom de container est unique par construction**
  (`unused-<tâche>-<Date.now()>`, `docker.ts:132`) : pas de collision de nom
  entre deux itérations, y compris successives.
- **`-e NOM` sans valeur protège bien l'argv de `docker run`** (constat 012
  confirmé) : la valeur passe par `env: { ...process.env, ...opts.env }`
  (`docker.ts:31`). C'est le chemin `flattenTask`, et lui seul, qui rouvre
  l'exposition.
- **La divergence image/curseur en cas d'échec d'aplatissement** et les
  conséquences d'un disque plein sont hors de ce rapport : déjà couvertes par
  005 et 011. Les containers orphelins et le montage `/exchange` partagé le sont
  par 001.
