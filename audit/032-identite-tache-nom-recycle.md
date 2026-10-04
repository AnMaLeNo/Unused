# 032 — Identité d'une tâche réduite à son nom (`ensureTaskState`, `resolveTaskImage`, cycle de vie)

**Fichiers examinés** : `src/state.ts:42-59` (`initialTaskState`, `ensureTaskState`),
`src/docker.ts:95-105,166-185,250-254` (`taskImage`, `resolveTaskImage`, `commitTask`,
`pruneTask`, `removeTaskImages`), `src/daemon.ts:375-418` (`taskInfo`, `findTask`,
`resetTask`, `setActive`), `src/graph.ts:107-133` (`isEligible`, `pickNext`),
`src/iterate.ts:80-85,121-131`, `src/scheduler.ts:88-94`, `src/scaffold.ts:1-103`,
`src/task.ts:10,121-161`, `src/dockerCheck.ts:19-57,105-111`, `src/cli.ts:113-161`,
`src/api.ts:70-95`, `src/graph.test.ts:137-144`, `src/state.test.ts`, `README.md:47-73`
**Verdict** : 4 constats (4 sûrs)

Le fil conducteur : partout, l'identité d'une tâche est la chaîne `task.name`,
c'est-à-dire le nom du dossier (`src/task.ts:122`). Rien n'est attaché à une
tâche *instance* — ni identifiant, ni empreinte du graphe, ni date de création.
L'entrée de `state.tasks`, l'image `unused-task-<nom>`, le label
`unused.task=<nom>` et le dossier `tasks/<nom>/` sont quatre objets couplés par
une simple égalité de chaînes, et trois d'entre eux survivent à la disparition
du quatrième.

Rappel de contexte : il n'existe aucune commande de suppression de tâche
(`src/cli.ts:113-161`, routes de `src/api.ts:70-95` : `new`, `reset`,
`activate`, `deactivate`, rien d'autre). Supprimer une tâche, c'est donc
supprimer son dossier — le README présente d'ailleurs la tâche comme un simple
dossier (`README.md:47-56,68-70`). Les quatre constats ci-dessous partent tous
de là.

## 1. Un nom recyclé : la tâche neuve saute son nœud `setup` et travaille dans le container de l'ancienne

**Gravité** : sûr
**Où** : `src/state.ts:50-59`, `src/docker.ts:102-105`, `src/iterate.ts:80-85,121`

`ensureTaskState` ne répare qu'une chose, le curseur devenu invalide :

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

Si le curseur hérité existe *par hasard* dans le nouveau graphe, il est gardé
tel quel. Et le squelette produit par `unused tasks new` a toujours les deux
mêmes noms de nœuds (`src/scaffold.ts:5-14`) :

```ts
const TASK_JSON = {
  active: false,
  start: "setup",
  nodes: { setup: {...}, work: { skill: "work", next: "work" } },
};
```

Donc, pour deux tâches successives bâties sur le squelette, le curseur hérité
est *toujours* valide. Scénario complet :

1. La tâche `revue` tourne 30 itérations sur `owner/projetA`. État :
   `{cursor:"work", status:"running", iterations:30}`. L'image
   `unused-task-revue:latest` contient le clone de `projetA`, `/work/PLAN.md`
   et `/work/JOURNAL.md`.
2. Le travail est fini (ou abandonné) ; l'utilisateur supprime
   `tasks/revue/`. Il n'a pas lancé `reset` — rien ne le lui dit, et pour une
   tâche qu'on supprime c'est l'inverse du réflexe. `state.tasks.revue` reste,
   `unused-task-revue:latest` et `:prev` restent.
3. Des semaines plus tard : `unused tasks new revue` (le dossier n'existe plus,
   le garde-fou de `scaffold.ts:94` ne se déclenche pas), `params.repo` mis à
   `owner/projetB`, skills réécrits, `unused tasks activate revue`.
4. Première itération. `pickNext` retient `revue` (`active` et
   `status === "running"`, `src/graph.ts:110`). `ensureTaskState` trouve
   l'entrée, voit `"work" in nodes` → **le nœud exécuté est `work`, pas
   `setup`** (`src/scheduler.ts:94`, `src/iterate.ts:84`).
5. `runInTask` appelle `resolveTaskImage` (`src/docker.ts:102-105`), qui
   trouve `unused-task-revue:latest` et **démarre le container sur le
   système de fichiers de l'ancienne tâche**.

Résultat obtenu : la session `work` de la tâche neuve lit le `/work/PLAN.md`
de l'ancienne, prend une case non cochée du plan d'un autre projet, et
commite (voire pousse) dans le clone de `projetA`. `projetB` n'est jamais
cloné, puisque `setup` — le seul nœud qui clone — n'est jamais exécuté. Le
commit Docker de fin d'itération (`src/iterate.ts:170`) fige ce mélange comme
nouvel état « de la tâche neuve ».

Résultat attendu : une tâche dont le dossier vient d'être créé part de
`task.def.start` dans un container issu de l'image de base.

Rien ne signale la reprise : `taskInfo` (`src/daemon.ts:375-387`) affiche
`iterations: 30` et `dernier work → completed` pour une tâche créée la veille,
mais sans dire que ce chiffre vient d'une autre tâche ; et le log d'itération
ne note l'image de départ (`src/iterate.ts:199`) que dans le JSON, après coup.

Variante du même mécanisme, sans recyclage : `consecutiveFailures` est hérité
aussi. Une ancienne tâche laissée à 2 échecs sur 3 fait que la nouvelle sort
définitivement de la file au premier échec (`src/graph.ts:96-102`).

## 2. Statut hérité : une tâche neuve peut naître `done` ou `failed`, et met les plages automatiques en pause

**Gravité** : sûr
**Où** : `src/state.ts:50-57`, `src/graph.ts:108-111`, `src/daemon.ts:208-212`

Même point de départ, mais l'ancienne tâche s'était terminée par un `DONE`
(`status: "done"`, `src/graph.ts:85-88`) ou avait épuisé ses échecs
(`status: "failed"`, `src/graph.ts:98-100`). `ensureTaskState` ne touche pas à
`status`, et `isEligible` ne regarde que ça :

```ts
export function isEligible(task: Task, state: RunnerState): boolean {
  const ts = state.tasks[task.name];
  return task.def.active && (ts === undefined || ts.status === "running");
}
```

Scénario : l'utilisateur crée `tasks/revue/` (nom déjà utilisé et terminé par
le passé), `unused tasks activate revue`, `unused start --for 8h`. `pickNext`
ne retient rien, `runWindow` sort sur `nothing-eligible`
(`src/scheduler.ts:89-93`) et le démon met **les plages automatiques en pause
jusqu'à la fin de la couverture** (`src/daemon.ts:208-212`). Obtenu : la tâche
neuve n'est jamais exécutée, et les nuits suivantes sont perdues jusqu'à la fin
de la couverture en cours. Attendu : une tâche dont le dossier vient d'être
créé est éligible.

Celui-ci est moins silencieux que le constat 1 : `unused tasks list` affiche
bien `done` ou `failed` (`src/cli.ts:118`), et `tasks reset` répare — le
dossier existe de nouveau. Il reste que l'activation est acceptée sans un mot
(`setActive`, `src/daemon.ts:410-418`, appelle `ensureTaskState` et ne regarde
jamais `status`) et que `unused start` répond « plage démarrée » pour une plage
qui n'exécutera rien.

## 3. Une fois le dossier supprimé, plus aucune commande ne peut purger l'entrée d'état ni les images

**Gravité** : sûr
**Où** : `src/daemon.ts:389-407`, `src/docker.ts:183-185,250-254`

`resetTask` est le seul chemin qui supprime une entrée de `state.tasks` et les
images d'une tâche (`grep` sur `state.tasks` : `src/daemon.ts:400` est la seule
suppression du dépôt). Or il commence par exiger que la tâche soit chargeable :

```ts
async resetTask(name: string): Promise<{ start: string }> {
  const task = await this.findTask(name);   // NotFoundError si le dossier a disparu
  ...
  delete this.state.tasks[name];
  ...
  await this.deps.removeTaskImages(name);
```

`findTask` (`src/daemon.ts:389-395`) lève `NotFoundError` dès que le dossier
n'existe plus (`tâche X introuvable`) ou que son `task.json` est devenu
invalide (`tâche X invalide : …`). Le seul outil de nettoyage refuse donc de
fonctionner exactement dans le cas où il y a quelque chose à nettoyer.

Conséquences, toutes vérifiables sur le code :

- `state.tasks.<nom>` reste indéfiniment, et n'est affiché par rien : `status`
  et `tasks list` itèrent sur les tâches *chargées* depuis le disque
  (`src/daemon.ts:370`), pas sur les clés de l'état. Le piège du constat 1 est
  invisible, et `state.json` ne décroît jamais.
- `unused-task-<nom>:latest` et `:prev` restent sur le disque. `pruneTask`
  (`src/docker.ts:183-185`) ne vise que les images *sans tag*
  (`image prune --filter label=…`) : les deux images taguées y survivent. Ce
  sont des images de tâche aplaties (base Debian + Claude Code + tout ce que
  la session a installé et cloné, `docker/Dockerfile`), et il n'existe aucune
  commande pour les lister ou les supprimer.
- Renommer un dossier de tâche (`tasks/revue` → `tasks/revue-projetA`) a le
  même effet : la nouvelle identité repart de l'image de base et du nœud
  `start`, tout le container accumulé devient un orphelin inaccessible, et
  rien n'est dit.

Le seul retour en arrière passe par l'extérieur de l'outil : `docker rmi` à la
main, et édition de `state.json` — après arrêt du démon, puisqu'il garde l'état
en mémoire et le réécrit intégralement au prochain `saveState`
(`src/state.ts:78-84`).

## 4. `unused docker check` détruit les images de toute vraie tâche nommée `docker-check-internal`

**Gravité** : sûr
**Où** : `src/dockerCheck.ts:19-20,50,107`

L'auto-test réutilise la mécanique des vraies tâches avec un nom choisi pour
être improbable, et c'est tout ce qui le sépare d'elles :

```ts
// Nom valide pour une image Docker, et improbable pour une vraie tâche.
const CHECK_TASK = "docker-check-internal";
...
await removeTaskImages(CHECK_TASK);   // ligne 50, avant le test
...
await removeTaskImages(CHECK_TASK);   // ligne 107, dans le finally
```

« Improbable » n'est pas « impossible » : `docker-check-internal` satisfait
`TASK_NAME_RE` (`src/task.ts:10`), `scaffoldTask` l'accepte
(`src/scaffold.ts:90-94`) et aucun contrôle ne réserve ce nom. Scénario : une
tâche `docker-check-internal` existe et tourne depuis 40 itérations ;
l'utilisateur lance `unused docker check` pour diagnostiquer autre chose. La
ligne 50 supprime `unused-task-docker-check-internal:latest` et `:prev`
(`src/docker.ts:250-254`), le test réécrit ces mêmes tags avec son container
jetable, et le `finally` les supprime à nouveau.

Obtenu : l'état réel de la tâche — son container — est détruit, mais `state.tasks` garde
`cursor`, `status: "running"` et `iterations: 40`. À l'itération suivante,
`resolveTaskImage` ne trouve plus rien et rend `cfg.docker.baseImage`
(`src/docker.ts:104`) : la session reprend au nœud `work` dans un container
vierge, sans `/work/repo` ni `/work/PLAN.md`. L'état affiché par
`unused status` continue d'annoncer 40 itérations et un curseur avancé.
Attendu : l'auto-test travaille dans un espace de noms qui ne peut pas
rencontrer celui des tâches de l'utilisateur (nom réservé au `scaffold` et au
chargement, ou préfixe distinct de `unused-task-`).

## Ce qui a été vérifié et tient

- La réparation du curseur par `ensureTaskState` fonctionne et est couverte
  (`src/graph.test.ts:137-144`) ; `taskInfo` (`src/daemon.ts:381`) applique la
  même repli à l'affichage, donc la ligne affichée et le nœud exécuté ne
  divergent pas.
- `resetTask` purge correctement quand le dossier existe : entrée d'état,
  `currentTask`, `DONE` et images, puis `unpause` (`src/daemon.ts:397-407`).
- `pickNext` tolère un `currentTask` ou un `lastTask` pointant sur une tâche
  disparue : le `find` collant échoue et `findIndex` rend `-1`, ce qui fait
  simplement repartir le tour à l'indice 0 (`src/graph.ts:122-132`) — biais de
  round-robin, pas de boucle ni de plantage.
- Les noms de containers (`unused-<nom>-<ms>`, `src/docker.ts:132`) et les
  filtres de label (`label=unused.task=<nom>`, correspondance exacte) ne
  créent pas de collision entre deux tâches de noms différents, même avec les
  séparateurs `.`/`_`/`-` autorisés.
- `commitTask` et `flattenTask` reposent sur les mêmes tags dérivés du nom,
  mais la rotation `:latest` → `:prev` et la reconstruction de la config à
  l'import (`importChanges`) sont cohérentes avec ce couplage ; rien n'y a été
  trouvé qui concerne l'identité.
- La validation du nom à `loadTask` (`src/task.ts:123-127`) empêche qu'un nom
  de dossier produise une référence Docker illégale ; le cas des noms héritant
  d'`Object.prototype` (`constructor`) a déjà été traité par le rapport 016 et
  n'est pas repris ici.
