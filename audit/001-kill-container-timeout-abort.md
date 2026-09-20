# 001 — kill du container sur timeout ou arrêt demandé

**Fichiers examinés** : `src/iterate.ts:112-190`, `src/docker.ts:26-56`, `src/docker.ts:126-154`,
`src/scheduler.ts:56-140`, `src/daemon.ts:137-158`, `src/daemon.ts:303-326`, `src/cli.ts:46-63`,
`deploy/unused.service`, `src/iterate.test.ts:25-180`
**Verdict** : 3 constats (1 sûr, 2 probables)

## `onStart` est appelé avant `spawn` : un arrêt déjà demandé tue un container qui n'existe pas encore

**Gravité** : sûr
**Où** : `src/docker.ts:147`, `src/iterate.ts:128-139`

`runInTask` prévient l'appelant du nom du container *avant* de lancer `docker run` :

```ts
// src/docker.ts:147
opts.onStart?.(container);
const r = await docker(args, { stdin: opts.stdin, env: opts.env });
```

`iterate` profite de ce hook pour armer le timer et, surtout, pour rattraper un
signal déjà levé :

```ts
// src/iterate.ts:134-138
onAbort = () => {
  aborted = true;
  deps.killContainer(container);
};
if (opts.signal?.aborted) onAbort();
```

Dans cette branche, `docker kill unused-<tâche>-<ts>` est lancé alors que
`docker run` n'a pas encore été `spawn`. Le container n'existe pas : le kill
échoue (`Error response from daemon: No such container`, code 1). Comme
`killContainer` est `(c) => void docker(["kill", c])` (`src/iterate.ts:28`), le
code de retour n'est ni testé ni journalisé. La ligne suivante lance malgré tout
`docker run`, et `iterate` reste bloquée sur ce `await` jusqu'à la fin naturelle
de la session ou jusqu'au timer, c'est-à-dire **jusqu'à `claude.timeoutMinutes`,
180 min par défaut** (`src/config.ts:19`).

Scénario concret, avec les valeurs livrées :

1. `runWindow` teste `!signal.aborted` (`src/scheduler.ts:83`), puis fait
   `await loadTasks()` et appelle `iterate`, qui enchaîne `rm(donePath)`,
   `resolveTaskImage` — un `docker image inspect`, donc un spawn et un
   aller-retour au démon Docker — et `mkdir`, tout cela avant `onStart`.
2. `systemctl stop unused` (ou un `unused stop --now`, `src/daemon.ts:321`)
   tombe dans cette fenêtre : `ac.abort()` passe `signal.aborted` à vrai avant
   que `onStart` ne soit atteint.
3. `onStart` prend la branche `opts.signal?.aborted` → kill dans le vide →
   `docker run` démarre la session Claude.
4. `iterate` ne rendra la main que dans 180 min. Le démon ne sort donc pas de
   `daemon.run`, et `deploy/unused.service` fixe `TimeoutStopSec=60` : systemd
   SIGKILL le cgroup au bout d'une minute.
5. `KillMode=mixed` tue le client `docker run`, pas le container : celui-ci
   n'est lancé ni avec `--rm` ni détaché d'un point de vue daemon. Il survit et
   continue de consommer le quota avec le token injecté.

Le même trou existe, plus étroit, quand l'abort arrive juste après `onStart` :
`docker kill <nom>` ne peut réussir qu'une fois le container créé côté démon
(spawn du client + création + start), ce qui n'est pas instantané sur un Pi avec
une image de tâche épaisse. Toute demande d'arrêt tombant dans cette fenêtre est
perdue de la même façon — aucun second essai n'est prévu.

Côté utilisateur, `unused stop --now` répond `plage arrêtée` (`src/cli.ts:82`)
alors que l'itération tourne toujours : l'état annoncé est faux.

Le test `arrêt demandé : tué, jeté, état ni modifié ni sauvé`
(`src/iterate.test.ts:167`) ne peut pas voir le problème : le faux `runInTask`
appelle `onStart?.("ctn")` puis abort *depuis le script*, donc le signal n'est
jamais déjà levé à l'entrée de `onStart`, et le « container » factice existe
toujours.

## Aucun ramassage des containers orphelins : un `unused.task` survivant pollue le `/exchange` de la tâche

**Gravité** : probable
**Où** : `src/daemon.ts:96-113`, `src/iterate.ts:110`, `src/iterate.ts:151`

Il n'existe nulle part un balayage des containers portant le label
`unused.task=<tâche>` : `pruneTask` ne prune que des *images*
(`src/docker.ts:184`), et le seul `container prune` du dépôt est celui de la
tâche de diagnostic (`src/dockerCheck.ts:108`). Rien dans `Daemon.init` ne
cherche de container résiduel.

Conséquence du constat précédent : après le SIGKILL de systemd, un container
orphelin reste en vie, monté sur `task.exchangeDir` (`src/docker.ts:141`) — le
même répertoire que toutes les itérations suivantes de la tâche. `Restart=always`
relance le démon 5 s plus tard ; comme `signal.aborted` était vrai,
`state.window` a été conservée (`src/scheduler.ts:141-143`) et la plage reprend
sur la même tâche.

La nouvelle itération efface `DONE` au départ (`src/iterate.ts:110`) puis, à la
fin, teste sa présence (`src/iterate.ts:151`) pour la passer à `classify`. Si le
skill de l'orphelin dépose `DONE` entre-temps, l'itération légitime est classée
`{ kind: "completed", done: true }` → décision `task-done` : la tâche sort
définitivement de la file alors que son travail n'est pas fini. Le `DONE` lu
n'appartient pas à la session journalisée, et rien dans le log ne permet de le
soupçonner.

Deux sessions `claude` écrivent par ailleurs simultanément dans le même
`/exchange`, avec le même token.

## `killContainer` jette une promesse sans handler : un échec de `spawn` tue le démon

**Gravité** : probable
**Où** : `src/iterate.ts:28`

```ts
killContainer: (c) => void docker(["kill", c]),
```

`docker()` rejette sur `child.on("error")` (`src/docker.ts:44-50`), c'est-à-dire
sur un échec de `spawn` : `ENOENT`, mais aussi `EAGAIN`/`EMFILE` quand la
machine manque de processus ou de descripteurs. `void` ne pose aucun handler :
la promesse est rejetée sans consommateur. Sous Node ≥ 15, le comportement par
défaut d'`unhandledRejection` est `throw`, et `src/cli.ts` n'installe pas de
`process.on("unhandledRejection")`.

Scénario : sur un Pi chargé, le timer des 180 min se déclenche, `spawn("docker")`
échoue avec `EAGAIN`. Au lieu d'un message d'erreur, le démon meurt sur-le-champ
— au pire moment, puisque le container qu'on cherchait justement à tuer, lui,
reste debout (cf. constat précédent). Le code de retour n'est pas davantage
regardé quand la promesse aboutit : un `docker kill` qui échoue proprement
(code ≠ 0) est silencieux, donc `timedOut`/`aborted` sont posés à vrai sans
qu'on sache si le container est réellement mort.

À noter que le contrat du type l'encourage : `killContainer: (container: string) => void`
(`src/iterate.ts:19`) est synchrone, donc `iterate` ne peut ni attendre le kill
ni en constater l'échec.

## Ce qui a été vérifié et tient

- **Pas de timeout fantôme après une fin normale.** `clearTimeout` et
  `removeEventListener` sont dans le `.finally` de `runInTask`
  (`src/iterate.ts:140-143`) ; la résolution de la promesse enchaîne des
  microtâches qui s'épuisent avant le prochain tour de `setTimeout`, donc un
  timer expirant « en même temps » que le `close` du process ne peut pas
  s'exécuter après coup.
- **Le chemin timeout nominal (container bien créé) est correct** : kill, puis
  `outcome = failure/timeout`, `discardContainer` (`docker rm -f`) et retrait du
  `DONE` (`src/iterate.ts:184-187`) — l'itération est bien réputée n'avoir jamais
  eu lieu, et l'état n'est pas sauvé quand `aborted` (`src/iterate.ts:189`).
- **Double kill sans danger** : timeout puis abort (ou l'inverse) ne fait qu'un
  `docker kill` qui échoue sur un container déjà mort, et le nettoyage final
  passe par `rm -f`.
- **Pas de timer orphelin si `runInTask` échoue avant `onStart`** (`mkdir` ou
  `resolveTaskImage` en erreur) : `timer` vaut encore `undefined`, et
  `clearTimeout(undefined)` est inoffensif.
- **Pas de risque de tuer le container d'une autre itération** : le nom porte un
  `Date.now()` (`src/docker.ts:132`) et le scheduler est strictement séquentiel.
