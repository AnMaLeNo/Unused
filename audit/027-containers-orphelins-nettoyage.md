# 027 — Containers laissés derrière : aucun balayage, `docker rm` non vérifié, disque

**Fichiers examinés** : `src/docker.ts:126-185`, `src/docker.ts:250-254`,
`src/iterate.ts:24-31`, `src/iterate.ts:112-190`, `src/daemon.ts:96-113`,
`src/daemon.ts:397-407`, `src/dockerCheck.ts:49-111`, `src/scheduler.ts:80-100`,
`src/cli.ts:35-64`, `src/cli.ts:142-148`, `deploy/unused.service`,
`src/config.ts:16-22`, `src/iterate.test.ts:25-181`, `src/docker.test.ts`
**Verdict** : 5 constats (2 sûrs, 3 probables)

Racine commune : `runInTask` crée un container **nommé et non éphémère**
(`docker.ts:130-150`, ni `--rm` ni `-d`), et la seule chose qui le supprime est
le code qui continue à tourner dans le démon après le retour de `docker run`.
Dès que ce code ne tourne plus — kill du démon, rejet non capturé, kill envoyé
trop tôt — le container survit, et **rien nulle part ne balaye** : un `grep` sur
`LABEL` / `container prune` / `ps -a` ne donne qu'un seul nettoyage par label,
celui de `dockerCheck.ts:108`, réservé à la tâche interne `docker-check-internal`.
`Daemon.init()` (`daemon.ts:96-113`) ne fait que relire `state.json`.

## 1. Le kill de l'itération peut partir avant que le container existe : arrêt sans effet, puis orphelin

**Gravité** : probable (chemin de code certain, déclenchement par course)
**Où** : `src/iterate.ts:128-139`, en particulier `src/iterate.ts:137`

`onStart` est appelé **avant** le `spawn` de `docker run` (`docker.ts:147-148`) :

```ts
opts.onStart?.(container);                       // docker.ts:147
const r = await docker(args, { stdin: opts.stdin, env: opts.env });  // docker.ts:148
```

et le callback installe le timeout puis, s'il est déjà trop tard, tire tout de
suite :

```ts
onAbort = () => { aborted = true; deps.killContainer(container); };
if (opts.signal?.aborted) onAbort();             // iterate.ts:137
else opts.signal?.addEventListener("abort", onAbort);
```

`killContainer` est `docker kill <nom>` (`iterate.ts:28`). À cet instant le
container n'existe pas encore : `docker kill` répond `No such container`, code 1,
résultat ignoré. **Le listener n'est pas réenregistré** (branche `else`), et un
`AbortSignal` déjà levé ne refire jamais. Le `docker run` part ensuite
normalement, crée le container et le laisse aller jusqu'à son terme.

Fenêtre de course : entre le test `!signal.aborted` en tête de boucle du
scheduler (`scheduler.ts:81`) et la création effective du container, il y a
`await loadTasks()`, `resolveTaskImage` (un aller-retour `docker image inspect`),
`mkdir`, le `spawn`, et le démarrage de la CLI docker. Sur le Pi visé, plusieurs
centaines de ms à quelques secondes.

Scénario concret — `unused stop --now` (ou `systemctl stop unused`) tombant dans
cette fenêtre :

1. `stopWindow(now)` → `run.ac.abort()` (`daemon.ts:321`), l'API répond
   `plage arrêtée`.
2. `iterate` passe par `iterate.ts:137`, `docker kill` échoue silencieusement.
3. La session `claude -p` démarre et tourne. Plus rien ne la tuera avant le
   timer de `cfg.claude.timeoutMinutes` — **180 minutes par défaut**
   (`config.ts:21`). Le démon reste bloqué sur ce `await` : `status` affiche
   toujours l'itération en cours, l'utilisateur croit la plage arrêtée.
4. systemd, lui, n'attend pas : `TimeoutStopSec=60` puis SIGKILL
   (`deploy/unused.service`). Le démon meurt ; le container, qui n'est pas un
   enfant du processus node mais de dockerd, **continue de tourner**, avec le
   token et le montage `/exchange`.

Résultat obtenu : une session Claude qui consomme le quota pendant des heures
après un arrêt annoncé comme effectué, et un container que plus personne ne
supprimera (constat 2). Résultat attendu : le container est tué, ou le kill est
rejoué dès qu'il existe.

Le test `arrêt demandé : tué, jeté…` (`iterate.test.ts:166-181`) ne couvre pas ce
cas : le faux `runInTask` appelle `opts.onStart?.("ctn")` **puis** `script()` qui
abort, donc l'abort arrive toujours container « créé », et le faux
`killContainer` réussit toujours.

## 2. Aucun balayage au démarrage : le démon relance une plage à côté de l'orphelin, qui peut écrire DONE

**Gravité** : sûr (absence de balayage) / probable (le DONE croisé)
**Où** : `src/daemon.ts:96-113`, `src/docker.ts:130-150`

`init()` relit `state.json` et reprend une plage interrompue
(`daemon.ts:98-108`), sans jamais demander à Docker ce qui traîne. Or
`state.window` n'est effacé que sur fin propre (`scheduler.ts:139-141`) : après
un kill, il est toujours là, et `deploy/unused.service` relance
(`Restart=always`, `RestartSec=5`).

Chaîne complète, à partir de n'importe quelle mort brutale (constat 1, constat 5,
OOM killer, coupure de courant) pendant une itération :

1. Le container `unused-<tâche>-<ms>` continue, `-v <exchangeDir>:/exchange`
   monté (`docker.ts:140-141`).
2. 5 s plus tard, le démon repart, `init()` reprend la plage, `pickNext` ressort
   la même tâche, `runInTask` crée un **second** container à partir de l'image
   de la tâche.
3. L'itération neuve fait `rm(donePath)` (`iterate.ts:110`) puis tourne.
4. Le skill de l'orphelin termine son travail et touche `/exchange/DONE`.
5. L'itération neuve finit en `completed` ; `exists(donePath)` (`iterate.ts:151`)
   voit le DONE **de l'orphelin** ; `classify(session, true)` rend
   `{kind:"completed", done:true}` → décision `task-done`.

Résultat obtenu : la tâche sort de la file, marquée terminée, alors que son
propre nœud n'a jamais déposé DONE. Résultat attendu : le DONE d'une session
morte ne compte pas — c'est exactement la règle annoncée en tête de `graph.ts:9-13`.

Et à froid, hors course : l'orphelin garde sa couche inscriptible (dépôt cloné,
`node_modules`, artefacts de build) et l'image parente. Rien ne la libère jamais :
`pruneTask` (`docker.ts:183-185`) ne vise que les **images** sans tag, et échoue
de toute façon tant qu'un container référence l'image. Sur le Pi, chaque crash
laisse ainsi durablement plusieurs centaines de Mo à plusieurs Go. Un
`docker ps -a --filter label=unused.task` au démarrage suffirait à les voir : le
label est bien posé (`docker.ts:138-139`), il n'est simplement jamais relu.

## 3. `unused tasks reset` annonce « image supprimée » sans jamais regarder si docker a réussi

**Gravité** : sûr (le silence) / probable (le déclenchement)
**Où** : `src/docker.ts:250-254`, `src/daemon.ts:404`, `src/cli.ts:147`

```ts
export async function removeTaskImages(taskName: string): Promise<void> {
  const name = taskImage(taskName);
  await docker(["rmi", "-f", `${name}:latest`, `${name}:prev`]);   // code ignoré
  await pruneTask(taskName);                                       // code ignoré
}
```

`docker()` ne lève jamais sur code ≠ 0 (`docker.ts:27`), et ici, contrairement à
tout le reste du module, `mustSucceed` n'est pas utilisé. `resetTask`
(`daemon.ts:397-407`) enchaîne sans condition sur `return { start: … }`, l'API
répond 200 et la CLI imprime :

```
${name} remise à zéro (curseur sur ${r.start}, image supprimée)   // cli.ts:147
```

Scénario concret, en présence d'un orphelin (constats 1-2) encore **en cours
d'exécution** à partir de `unused-task-t:latest` :

1. `docker rmi -f unused-task-t:latest unused-task-t:prev` →
   `conflict: … image is being used by running container …`, code 1, ignoré.
   (Même avec un orphelin seulement *stoppé*, `-f` se contente de retirer le tag
   et `image prune` ne peut pas récupérer la couche.)
2. `image prune --filter label=unused.task=t` ne retire rien non plus.
3. La CLI affiche « image supprimée ». L'état JSON, lui, a bien été effacé
   (`daemon.ts:400-402`).
4. À l'itération suivante, `resolveTaskImage` (`docker.ts:102-105`) trouve
   toujours `unused-task-t:latest` et **repart du système de fichiers d'avant le
   reset**, avec un curseur remis sur `start`.

Résultat obtenu : le nœud `setup` se rejoue dans un container déjà préparé, avec
un état de travail qui ne correspond plus au curseur — exactement ce que le reset
devait éliminer, et l'utilisateur n'a aucun signal. Résultat attendu : `rmi` qui
échoue remonte une erreur, `reset` renvoie 409 ou 500.

Le garde-fou de `resetTask` ne couvre pas ce cas : il ne refuse que si
`this.running?.current?.task === name` (`daemon.ts:399`), c'est-à-dire l'itération
en cours du démon **vivant** ; un container laissé par un démon mort n'y figure
évidemment pas.

## 4. `docker check` prune les images avant les containers : l'image de la tâche survit au nettoyage annoncé

**Gravité** : sûr
**Où** : `src/dockerCheck.ts:105-111`

```ts
} finally {
  step("Nettoyage");
  await removeTaskImages(CHECK_TASK);                                     // 107
  await docker(["container", "prune", "-f", "--filter", `label=unused.task=${CHECK_TASK}`]);  // 108
  await rm(exchangeDir, { recursive: true, force: true });
  ok(`images et containers de ${CHECK_TASK} supprimés`);                  // 110
}
```

L'ordre est inversé. Sur le chemin d'échec — et ce `finally` n'existe que pour
lui — un container non jeté reste : si `expectOutput` lève ligne 74, ou le test
`:prev` ligne 77, le container `r2`, issu de `unused-task-docker-check-internal:latest`,
n'a été ni commité ni jeté.

Déroulé ligne à ligne :

1. `removeTaskImages` → `rmi -f …:latest …:prev` sur une image référencée par ce
   container. Les deux issues possibles laissent la couche en place : docker
   refuse (code 1, ignoré, tag conservé), ou `-f` se contente de détaguer et
   l'image devient sans tag mais toujours référencée.
2. `pruneTask` → `image prune -f --filter label=…` : le container référence
   encore l'image, rien n'est retiré.
3. `container prune -f` (ligne 108) supprime enfin le container — trop tard,
   plus personne ne repassera sur l'image.
4. Ligne 110 : `✔ images et containers de docker-check-internal supprimés`.

Résultat obtenu : une image complète (base Claude Code + couches du check) reste
sur le disque du Pi, invisible dans `docker images` si elle a été détaguée, avec
un message de succès. Résultat attendu : les deux `prune` dans l'ordre
containers → images, ou le message conditionné au résultat. Il faut lancer un
second `unused docker check` pour que le `removeTaskImages` de la ligne 50 la
récupère enfin ; sans cela elle reste indéfiniment.

## 5. `killContainer` jette une promesse rejetée : le rejet non capturé tue le démon et fabrique l'orphelin

**Gravité** : probable
**Où** : `src/iterate.ts:28`

```ts
killContainer: (c) => void docker(["kill", c]),
```

`void` évacue la valeur, pas le rejet. `docker()` **rejette** sur erreur de
`spawn` (`docker.ts:44-50`) : `ENOENT`, mais aussi `EAGAIN` / `EMFILE` quand le
fork échoue. Aucun `.catch`, et aucun `process.on("unhandledRejection")` nulle
part (`grep` : seuls SIGINT et SIGTERM sont écoutés, `cli.ts:56-57`). Sous Node
≥ 22 (`package.json` `engines`), un rejet non traité est relancé en exception non
capturée et **termine le processus**.

Scénario concret sur le Pi, mémoire saturée pendant qu'une itération dépasse
`timeoutMinutes` :

1. Le timer tire (`iterate.ts:129-132`) → `killContainer(container)`.
2. `spawn("docker", …)` échoue en `EAGAIN` faute de pouvoir forker.
3. `DockerError` rejetée, personne ne l'attrape → le démon meurt sur le champ,
   au milieu de l'itération.
4. Le container, lui, n'a pas été tué : il tourne toujours.
5. `Restart=always` relance 5 s plus tard, `init()` ne balaye rien (constat 2).

Résultat obtenu : le mécanisme censé borner une session emballée est précisément
ce qui tue le superviseur et laisse la session emballée en liberté. Résultat
attendu : l'échec du `docker kill` est journalisé, l'itération se termine en
`timeout` comme prévu. Le même code s'applique au chemin `onAbort`
(`iterate.ts:134-136`), donc à `stop --now` et à SIGTERM.

## Ce qui a été vérifié et tient

- Les chemins **nominaux** de `iterate` ne fuient pas : tout `outcome` non
  `completed` passe par `discardContainer` (`rm -f`, `iterate.ts:185`), et
  l'échec de `commitTask` jette aussi le container avant de rétablir le curseur
  (`iterate.ts:176-182`). `finishFatal` avant le `run` (`iterate.ts:101-106`)
  ne peut pas laisser de container : aucun n'a encore été créé.
- `flattenTask` supprime son container temporaire dans un `finally`
  (`docker.ts:220-225`), y compris si `pipeExportImport` échoue.
- Un `docker run` qui sort en code ≠ 0 en laissant un container à l'état
  `Created` (montage invalide, image cassée) est bien couvert : `docker()`
  résout au lieu de lever, l'issue n'est pas `completed`, `discardContainer`
  passe.
- Le label `unused.task=<tâche>` est correctement posé sur les containers
  (`docker.ts:138-139`) et propagé aux images au commit (`docker.ts:172`) : le
  matériel d'un balayage existe, seul l'appel manque.
- L'arrêt propre (SIGTERM hors fenêtre de course du constat 1) fonctionne :
  `ac.abort()` → `onAbort` → `docker kill` → `docker run` rend la main →
  `discardContainer`.
- Pas d'écrasement de nom possible entre deux containers : `Date.now()` dans le
  nom (`docker.ts:132`) et exécution strictement séquentielle du scheduler.
