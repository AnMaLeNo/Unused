# 006 — Commandes API concurrentes d'une itération en cours

**Fichiers examinés** : `src/daemon.ts:282-418` (`startWindow`, `stopWindow`,
`status`, `resetTask`, `setActive`), `src/daemon.ts:177-274` (`execute`,
`onEvent`), `src/api.ts:54-125`, `src/scheduler.ts:56-155`,
`src/iterate.ts:72-190`, `src/docker.ts:28-60,101-105,166-185,250-254`,
`src/state.ts:46-84`, `src/task.ts:121-188`, `src/graph.ts:60-152`,
`src/cli.ts:112-160`, `src/client.ts`, `src/scaffold.ts:1-101`,
`src/daemon.test.ts:195-251`
**Verdict** : 4 constats (1 sûr, 2 probables, 1 à vérifier)

Ni `node` ni `docker` ne sont disponibles dans ce conteneur : tout ce qui suit
est établi par lecture, sans exécution.

## `reset` annonce « image supprimée » sans jamais vérifier que Docker a fait quoi que ce soit

**Gravité** : sûr
**Où** : `src/daemon.ts:404`, `src/docker.ts:250-254`, `src/docker.ts:28-60`

`resetTask` efface l'état de la tâche, puis délègue la partie Docker :

```ts
// daemon.ts:397-407
async resetTask(name: string): Promise<{ start: string }> {
  const task = await this.findTask(name);
  if (this.running?.current?.task === name) throw new ConflictError(`${name} est en cours d'itération`);
  delete this.state.tasks[name];
  if (this.state.currentTask === name) this.state.currentTask = null;
  await saveState(this.cfg.dataDir, this.state);
  await rm(path.join(task.exchangeDir, DONE_FILE), { force: true });
  await this.deps.removeTaskImages(name);
  await this.unpause();
  return { start: task.def.start };
}
```

```ts
// docker.ts:250-254
export async function removeTaskImages(taskName: string): Promise<void> {
  const name = taskImage(taskName);
  await docker(["rmi", "-f", `${name}:latest`, `${name}:prev`]);
  await pruneTask(taskName);
}
```

`docker()` est documenté ligne 27 comme ne levant **pas** sur code ≠ 0 : « c'est
l'appelant qui décide ». Ici personne ne décide : le `ExecResult` est jeté.
`removeTaskImages` ne lève que si le binaire `docker` est introuvable
(`docker.ts:44-50`), jamais si le démon Docker a refusé. `resetTask` retourne
alors `{ start }` comme si tout s'était bien passé, et la CLI l'affirme :

```ts
// cli.ts:146-147
const r = await call<{ start: string }>(await sock(), "POST", `/tasks/${encodeURIComponent(name)}/reset`);
console.log(`${name} remise à zéro (curseur sur ${r.start}, image supprimée)`);
```

Scénario concret : le démon Docker est arrêté (service `docker` coupé, socket
non accessible au compte du service, `unused` lancé après un redémarrage avant
que Docker ne soit remonté). `docker rmi` s'exécute, échoue avec
« Cannot connect to the Docker daemon » et sort en code 1.

- obtenu : `unused tasks reset t1` affiche « t1 remise à zéro (curseur sur
  setup, image supprimée) », `state.tasks.t1` est effacé et sauvegardé, et
  `unused-task-t1:latest` existe toujours, intacte ;
- attendu : soit l'échec est remonté (409/500), soit l'état n'est pas effacé.

Conséquence durable : à la plage suivante, `resolveTaskImage`
(`docker.ts:101-105`) retrouve `unused-task-t1:latest` et redémarre le nœud
`start` **dans le container qui contient déjà tout le travail accumulé**. Le
skill `setup`, écrit pour un container vierge (`scaffold.ts` : « Prépare le
container pour la tâche (une seule fois, au premier nœud) »), se rejoue sur une
arborescence déjà remplie, et le curseur repart de zéro sur un système de
fichiers qui, lui, n'est jamais revenu en arrière. La remise à zéro est à
moitié appliquée et personne ne le sait.

À noter que `reset` est la seule commande touchant à Docker qui ne fasse aucun
contrôle préalable : `startWindow` (`daemon.ts:287-293`) appelle `dockerVersion()`
et `imageExists()` et refuse proprement si Docker ne répond pas.

Le même trou couvre les cas moins spectaculaires (image verrouillée par un
container survivant d'un démon tué — cf. constat 002 du rapport 001, `no space
left on device` pendant le `prune`) : tous sont rapportés comme un succès.

## La garde `current` est évaluée une fois et ne couvre pas la durée du reset

**Gravité** : probable
**Où** : `src/daemon.ts:399-405`, `src/scheduler.ts:88-98`, `src/state.ts:50-59`

La garde protège le cas « une itération de cette tâche tourne déjà » :

```ts
// daemon.ts:399
if (this.running?.current?.task === name) throw new ConflictError(`${name} est en cours d'itération`);
```

Elle est correcte dans ce sens-là : `run.current` est posé par `onEvent`
(`daemon.ts:254-256`) de façon synchrone juste avant `runIteration`
(`scheduler.ts:97-98`) et n'est relâché qu'après son retour, donc une itération
en vol ne peut pas commencer sans que `current` soit déjà visible.

Le sens inverse n'est pas protégé. Entre la garde et la fin du reset il y a
quatre `await` : `saveState`, `rm`, `removeTaskImages` (deux `spawn` Docker,
`rmi` puis `image prune` — de l'ordre de quelques centaines de ms) et
`unpause`. Rien ne bloque la boucle du scheduler pendant ce temps, et elle
n'observe aucune garde de son côté.

Scénario concret, plage en cours, `t1` seule tâche active, le scheduler est
entre deux itérations (fin d'attente `retrySeconds`, défaut 60 s, ou reprise
après un backoff quota, ou simplement le `await loadTasks()` de
`scheduler.ts:88`) :

1. `POST /tasks/t1/reset` : `current` est `null`, la garde passe ;
2. `delete this.state.tasks.t1`, `currentTask = null`, `await saveState(…)` ;
3. le scheduler reprend la main : `pickNext` voit `t1` éligible
   (`graph.ts:105-109` : `ts === undefined` ⇒ éligible), `ensureTaskState`
   **recrée l'entrée** effacée à l'étape 2 (`state.ts:50-58`), `onEvent`
   pose `current`, `runInTask` appelle `resolveTaskImage` qui trouve encore
   `unused-task-t1:latest` et lance un container dessus ;
4. le reset reprend : `rmi -f` détague l'image pendant que le container tourne,
   `unpause()` sauve à nouveau l'état — celui que l'itération vient de recréer.

Résultat obtenu : `unused tasks reset t1` répond 200, la CLI dit « image
supprimée », mais l'itération en cours travaille dans l'ancien système de
fichiers et, si elle se termine en `completed`, `commitTask`
(`docker.ts:166-180`) **re-tague** `unused-task-t1:latest` à partir de ce
container. L'image est donc reconstituée avec tout l'historique, curseur remis
au nœud `start` : exactement l'état incohérent du constat précédent, cette
fois sans aucune panne Docker.

Résultat attendu : soit le reset est refusé (comme il l'est une seconde plus
tard), soit il est appliqué en entier avant que quoi que ce soit ne redémarre.

Variante plus bénigne de la même fenêtre : si le `rmi` tombe entre le
`imageExists` de `resolveTaskImage` (`docker.ts:103-104`) et le `docker run`
(`docker.ts:148`), c'est `docker run` qui échoue sur une image absente
localement ; `isDockerDown` ne reconnaît pas ce message (`iterate.ts:59`), donc
l'itération est classée `unreadable_output` (`graph.ts:53`) et compte un échec
consécutif de plus vers `task-failed`.

## `setActive` réécrit le `task.json` de l'utilisateur sans écriture atomique

**Gravité** : probable
**Où** : `src/daemon.ts:410-418`

```ts
// daemon.ts:410-418
async setActive(name: string, active: boolean): Promise<void> {
  const task = await this.findTask(name);
  const file = path.join(task.dir, TASK_FILE);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw.active = active;
  await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
  ensureTaskState(this.state, task);
  if (active) await this.unpause();
}
```

`writeFile` ouvre en `O_TRUNC` puis écrit : le fichier passe par un état vide.
C'est le seul endroit du programme qui réécrit un fichier **écrit par
l'utilisateur**, et c'est le seul qui ne prenne pas la précaution que `state.ts`
prend pour un fichier que le programme est seul à posséder :

```ts
// state.ts:77-83 — « Écriture atomique : fichier temporaire puis rename »
const tmp = `${file}.tmp`;
await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
await rename(tmp, file);
```

Deux scénarios :

1. **L'écriture échoue ou est coupée** (ENOSPC sur la partition des tâches, le
   service reçoit un SIGKILL — `deploy/unused.service` tue au bout du
   `TimeoutStopSec` —, arrêt machine). `task.json` reste vide ou tronqué.
   `loadTask` (`task.ts:129-134`) lève « impossible de lire task.json », la
   tâche disparaît de `unused tasks` et bascule dans `taskErrors`
   (`task.ts:181-185`), et elle ne tournera plus jamais tant que l'utilisateur
   ne réécrit pas à la main ses nœuds, ses `params` et son `env` — que
   personne n'a sauvegardés. Obtenu : la définition de la tâche est perdue par
   un `unused tasks deactivate`. Attendu : `deactivate` bascule un booléen sans
   jamais pouvoir détruire le fichier.

2. **Une lecture concurrente tombe dans la fenêtre de troncature.** Le démon
   relit `tasks/*/task.json` avant *chaque* itération (`scheduler.ts:88`,
   commentaire ligne 53-54) et à chaque `GET /status` ; rien ne sérialise ces
   lectures avec l'écriture du handler API, dans le même processus. Une lecture
   qui voit le fichier vide range la tâche dans `errors`. Si c'est la seule
   tâche éligible du moment, `pickNext` retourne `null`, et le scheduler ne se
   contente pas de sauter un tour : il termine la plage
   (`scheduler.ts:89-93`, `endedBecause = "nothing-eligible"`) et `execute`
   pose une pause sur tout le calendrier jusqu'à la fin de la couverture
   (`daemon.ts:208-212`). Un `unused tasks activate t1` mal synchronisé peut
   donc éteindre la nuit de travail qu'il était censé préparer. La fenêtre est
   de l'ordre de la microseconde ; c'est la disproportion de la conséquence qui
   rend le défaut gênant, pas sa fréquence.

## Deux `saveState` simultanés dans le même processus partagent le même fichier temporaire

**Gravité** : à vérifier
**Où** : `src/state.ts:78-83`, `src/daemon.ts:241,317-318,402`, `src/iterate.ts:189`

Le rapport 004 signale déjà le chemin temporaire fixe `${file}.tmp`, mais en
concluant qu'« il ne s'agit pas de l'API mais de deux processus qui écrivent le
même fichier ». C'est inexact : un seul démon suffit. Les handlers de l'API et
la boucle d'itération tournent dans le même processus, sur le même event loop,
et plusieurs commandes sauvent l'état **sans aucune garde d'itération** :

- `stopWindow` (`daemon.ts:317-318`) est explicitement autorisée pendant une
  itération ;
- `setActive` → `unpause` → `saveState` (`daemon.ts:241`) n'a aucune garde ;
- `resetTask` sauve deux fois pour une tâche autre que celle en cours.

En face, `iterate` sauve à chaque fin d'itération (`iterate.ts:189`). Les deux
`writeFile` visent le même `state.json.tmp`, chacun avec son propre descripteur
ouvert en `O_TRUNC`, et les instantanés n'ont pas la même longueur (`pausedUntil`
à `null` d'un côté, une date ISO de l'autre ; une entrée de tâche en plus ou en
moins). Si les deux `open` précèdent les deux `write` — possible, les opérations
fs passent par le threadpool libuv —, le fichier final porte le contenu court
suivi de la queue du contenu long, et les deux `rename` promeuvent ce mélange en
`state.json`. Au démarrage suivant, `loadState` (`state.ts:70-73`) refuse le
fichier et le démon ne démarre pas.

Ce qui reste à vérifier est l'entrelacement réel des `open`/`write` de deux
`fsPromises.writeFile` concurrents (rien ici ne permet de l'exécuter), et la
largeur de la fenêtre : `saveState` dure quelques millisecondes, donc la
collision demande que la commande tombe précisément dessus. Le remède est le
même que pour 004 et ne coûte rien : un suffixe unique sur le fichier
temporaire, ou une file d'attente d'un seul écrivain.

## Ce qui a été vérifié et tient

- La garde `current` est correctement *posée* : `onEvent` la met à jour de
  façon synchrone entre `pickNext` et `runIteration` (`scheduler.ts:94-99`),
  donc aucun `await` ne sépare le choix de la tâche de sa publication. Un reset
  arrivant après le début d'une itération est bien refusé ; c'est seulement
  l'ordre inverse qui n'est pas couvert (constat 2).
- `status()` pendant une itération lit `run.live`, alimenté par `onEvent` : les
  compteurs sont cohérents, et l'exclusion des itérations `aborted`
  (`daemon.ts:260-266`) correspond à ce que le scheduler compte de son côté
  (`scheduler.ts:100-101`).
- `resetTask` sur une tâche *autre* que celle en cours ne corrompt pas
  l'itération en vol : `iterate` garde une référence sur `ts` obtenue par
  `ensureTaskState` pour **sa** tâche (`iterate.ts:80`), que le `delete` d'une
  autre clé ne touche pas.
- `setActive` sur la tâche en cours d'itération ne fait pas dérailler
  l'itération : `pickNext` ne relit `active` qu'au tour suivant, ce que la
  documentation de la méthode annonce (`daemon.ts:409`).
- `POST /tasks` (scaffold) pendant une plage est sans danger : le task.json
  généré porte `active: false` (`scaffold.ts:6`), donc même lu avant que les
  skills ne soient écrits, la tâche n'est jamais élue — elle apparaît au pire
  une fois dans `taskErrors`.
- Les deux `POST /window` concurrents laissent bien passer les deux requêtes
  (la garde `daemon.ts:285` précède deux appels Docker `await`), le second
  `until` écrasant le premier : c'est réel, mais aucun usage plausible de la
  CLI ne déclenche deux `start` simultanés.
- `readJson`/`sendJson` (`api.ts:27-42`) et la traduction
  `ConflictError`/`NotFoundError` en 409/404 (`api.ts:119-122`) sont corrects,
  y compris le cas « en-têtes déjà envoyés » des routes streamées.
