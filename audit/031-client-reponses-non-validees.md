# 031 — Réponses du démon non validées, sans délai de garde

**Fichiers examinés** : `src/client.ts` (entier), `src/cli.ts:11-31,68-132,178-181`,
`src/api.ts:39-66,113-141`, `src/daemon.ts:15-47,284-301,328-418`,
`src/docker.ts:20-93`, `src/task.ts:164-188`, `src/duration.ts`, `src/config.ts:50-70`,
`deploy/install.sh`, `README.md:100-125`, et l'historique (`git show 03c4c4c`,
`03c4c4c~1:src/daemon.ts`, `03c4c4c~1:src/cli.ts`) pour la forme passée de `DaemonStatus`
**Verdict** : 3 constats (1 sûr, 1 probable, 1 à vérifier)

Ni `node` ni `docker` ne sont installés dans ce conteneur : tout ce qui suit est
établi par lecture, sans exécution.

## `call()` n'a aucun délai de garde : un Docker qui ne répond pas fait pendre `unused start` sans fin — et l'interruption au clavier démarre quand même la plage

**Gravité** : probable
**Où** : `src/client.ts:24-30`, `src/cli.ts:72-75`, `src/api.ts:61-66`, `src/daemon.ts:286-301`, `src/docker.ts:28-60`

La requête cliente est posée sans la moindre borne de temps :

```ts
// client.ts:24-30
const req = http.request(
  {
    socketPath: sock,
    method,
    path,
    headers: data ? { … } : {},
  },
```

Aucun `timeout`, aucun `req.setTimeout`, aucun écouteur `'timeout'`. La promesse
ne se résout que sur `res.on("end")` (`client.ts:34-47`) et ne se rejette que sur
`req.on("error")` (`client.ts:50`). L'auteur connaît pourtant le risque : la
sonde du même fichier voisin le borne explicitement, et traite l'événement.

```ts
// api.ts:130-139
const req = http.request({ socketPath: sock, path: "/status", method: "GET", timeout: 2000 }, …);
req.on("timeout", () => { req.destroy(); resolve(false); });
```

Côté démon, toutes les attentes non bornées passent par `docker()`, qui ne
résout que sur `'close'` du processus fils — jamais de `timeout`, jamais de
`kill` :

```ts
// docker.ts:30,51-55
const child = spawn("docker", args, { … });
child.on("close", (code) => { resolve({ code: code ?? -1, … }); });
```

Chaîne complète pour `unused start --for 8h` :
`cli.ts:73` → `call()` → `api.ts:61-66` → `daemon.startWindow` →
`await this.deps.dockerVersion()` (`daemon.ts:288`) → `mustSucceed(["version", …])`
(`docker.ts:71-74`) → `spawn("docker", …)`.

Scénario concret : `dockerd`/`containerd` reste en vie mais ne répond plus (shim
bloqué, disque de `/var/lib/docker` en I/O wait — sur le Pi visé par le README,
pendant un `export|import` d'aplatissement de plusieurs Go). Un `docker version`
bloque alors indéfiniment.

```
$ unused start --for 8h
   (rien. Jamais. Pas de message, pas de code de retour, pas de borne.)
```

Le processus ne sort même pas en silence : la socket de la requête est `ref`'ée,
donc la boucle d'événements reste vivante — la CLI *pend*. Rien ne distingue
« le démon réfléchit » de « Docker est planté » de « ma requête est perdue ». Et
si une socket arrivait à expirer, `ClientRequest` se contente d'émettre
`'timeout'` : personne ne l'écoute dans `client.ts`, Node ne détruit pas la
socket de lui-même, et la promesse ne se règle donc toujours ni dans un sens ni
dans l'autre.

Pire que l'attente : la suite. L'utilisateur finit par taper Ctrl-C. Rien dans
`api.ts` n'écoute `req.on("close")` et `startWindow` ne reçoit aucun
`AbortSignal` ; le gestionnaire continue donc après le départ du client. Quand
Docker se débloque (ou quand l'opérateur relance `dockerd`), `startWindow`
reprend son cours ligne 294 et suivantes :

```ts
// daemon.ts:294-300
const until = new Date(this.deps.now().getTime() + forMs);
this.manual = { until, resumed: false };
this.fatal = null;
this.state.pausedUntil = null;
await saveState(this.cfg.dataDir, this.state);
this.wake?.();
```

`wake()` réveille `idle()` (`daemon.ts:160-176`), `run()` reboucle, `deadline()`
est dans le futur, `execute()` démarre la plage (`daemon.ts:177-192`). La réponse
`sendJson` part dans une socket détruite, où l'erreur d'écriture est avalée
(`ServerResponse` sans écouteur `'error'`) : **une plage de 8 h démarre, comptée
à partir du déblocage de Docker, alors que l'utilisateur a vu sa commande ne rien
faire et l'a interrompue**. `fatal` est au passage effacé et `pausedUntil` remis à
null, donc une panne globale précédemment affichée disparaît sans que personne
n'ait validé quoi que ce soit.

« Probable » et non « sûr » : le mécanisme est entièrement démontré par le code,
mais son déclencheur (un `docker version` qui ne rend pas la main) est une
condition externe que je ne peux pas exécuter ici. Les mêmes chemins non bornés
existent pour `unused tasks reset` (`daemon.ts:403` → `removeTaskImages`).

## Toute erreur interne de la CLI est réduite à son message par un ternaire sans effet

**Gravité** : sûr
**Où** : `src/cli.ts:178-181`

```ts
program.parseAsync().catch((err: Error) => {
  console.error(err instanceof DaemonUnreachable || err instanceof ApiError ? err.message : err.message);
  process.exit(err instanceof ApiError && err.status === 409 ? 3 : 1);
});
```

Les deux branches du ternaire sont le même `err.message` : le test
`instanceof` ne distingue rien. La branche « erreur inattendue » — celle qui
devait manifestement afficher autre chose, une trace par exemple — n'existe pas.

Conséquence concrète : tout ce qui n'est *pas* une erreur d'API arrive à
l'écran décontextualisé, sans trace, sans nom de fichier, sans indication que
l'erreur est interne et non un refus du démon.

```
$ unused status
Cannot read properties of undefined (reading 'length')
$ echo $?
1
```

(exemple : `printTasks(s.tasks, s.taskErrors)` sur une réponse amputée, cf.
constat suivant). L'utilisateur ne peut pas savoir si le démon a refusé, si la
config est cassée, ou si la CLI a planté sur sa propre réponse ; et il n'y a pas
de `--debug` ni de variable d'environnement pour obtenir la pile. Le même
aplatissement frappe une `ZodError` formatée par `loadConfig`, un `EACCES` sur
le socket, ou n'importe quel `TypeError`.

## Rien ne valide la forme des réponses : contre un démon d'une autre version, `status` affirme `plage undefined`

**Gravité** : à vérifier
**Où** : `src/client.ts:46`, `src/cli.ts:91-111`, `src/cli.ts:115-123`

`call()` rend le JSON tel quel, avec un transtypage sec :

```ts
// client.ts:46
resolve(parsed as T);
```

`status` déréference ensuite la réponse en confiance : `s.daemon.pid`,
`w.source`, `w.costUsd.toFixed(2)`, `l.endedBecause`, `s.fatal.detail.split("\n")`,
`list.length`/`errors.length` dans `printTasks`. Aucun schéma, aucun numéro de
version de protocole, aucune vérification de `content-type`.

Le déclencheur réaliste est le décalage de versions, et il n'est pas théorique :
`DaemonStatus` a déjà changé de forme dans l'historique. `03c4c4c` (« Quota
exact, pannes globales, plages automatiques ») ajoute `nextCalendarStart`,
`pausedUntil`, `fatal` et le champ `window.source`. Or `deploy/install.sh`
réécrit `dist/` (donc la CLI, servie par le wrapper `/usr/local/bin/unused`)
*avant* de redémarrer le service, en fin de script :

```sh
npm ci --no-audit --no-fund
npm run build            # ← la nouvelle CLI est déjà en place
…
systemctl restart unused # ← le démon ne change qu'ici
```

Sur un Pi, `npm ci` + `tsc` durent des minutes ; pendant toute cette fenêtre —
et indéfiniment pour qui fait simplement `git pull && npm run build` sans
redémarrer le service — la nouvelle CLI parle à l'ancien démon. En reconstituant
la réponse de `03c4c4c~1:src/daemon.ts` (`{daemon, window, lastWindow, tasks,
taskErrors}`, sans `source`) et en la passant à l'afficheur actuel
(`cli.ts:99`) :

```
démon    pid 1234, démarré 2026-09-16T20:11:04.000Z
plage    undefined, jusqu'à 2026-09-17T04:11:04.000Z (7h58 restantes)
```

Pas de plantage dans ce sens-là — juste une ligne d'état fausse, et les lignes
`prochaine plage automatique` / `pause` muettes faute de champs. Mais c'est bien
le signe qu'aucune des deux parties ne contrôle le contrat : dans l'autre sens
(un champ retiré ou renommé, `tasks` absent, `costUsd` disparu) le même code
part en `TypeError`, rendu illisible par le constat précédent. « À vérifier »
parce que le décalage de versions est un scénario d'exploitation que je ne peux
pas reproduire ici, et que la forme actuelle, elle, est cohérente (vérifié
champ par champ ci-dessous).

Détail annexe, même famille : `unused tasks list` sort en **1** quand une tâche
est illisible (`cli.ts:131`) alors que la commande a parfaitement fait son
travail, tandis que `unused status` sort en **0** même quand il affiche
`PANNE auth` (`cli.ts:94`). Un `unused status || alerte` en cron n'alerte donc
jamais sur une panne globale, et un `unused tasks list && …` casse sur un
`task.json` mal formé. Aucun contrat de code de sortie n'est documenté
(README `:113-125`), seul `409 → 3` est traité (`cli.ts:180`).

## Ce qui a été vérifié et tient

- **Aucun plantage de `status` n'est atteignable avec la version actuelle du
  démon.** Vérifié champ par champ : `daemon`, `window`, `nextCalendarStart`,
  `pausedUntil`, `fatal`, `lastWindow`, `tasks`, `taskErrors` sont tous écrits
  inconditionnellement par `daemon.status()` (`daemon.ts:328-371`) ; `window.live`
  (`iterations`, `completed`, `failures`, `backoffs`, `costUsd`) est initialisé à
  0 dans `execute()` (`daemon.ts:184`) et seulement incrémenté (`daemon.ts:258-266`,
  avec `?? 0` sur le coût) ; `WindowSummary` (`scheduler.ts:8-16`) porte toujours
  `costUsd` et `endedBecause`. Les routes JSON d'`api.ts` renvoient toutes un
  objet, jamais un corps vide ni un scalaire, donc le `resolve(null as T)` du cas
  « corps vide » (`client.ts:38`) n'est pas atteignable aujourd'hui.
- `formatDuration` (`duration.ts:19-26`) est robuste : `Math.max(0, …)` en entrée
  et `remainingMs` est déjà borné côté démon (`daemon.ts:339`, `daemon.ts:350`).
- Chemins d'erreur réseau de `call()` corrects : non-2xx → `ApiError` portant
  `parsed.error` quand il existe (`client.ts:42-45`), corps illisible → `ApiError`
  tronquée à 200 caractères (`client.ts:40`), réponse coupée en vol ou démon mort
  → `req.on("error")` avec `ECONNRESET`, que `unreachable()` laisse passer en
  « démon injoignable : … » (`client.ts:13-18`). `ENOENT`/`ECONNREFUSED` (socket
  périmé après un SIGKILL) donnent bien le message « le démon n'est pas lancé ».
- `stream()` : le découpage en lignes et le résidu final sont corrects, et le cas
  « statut ≠ 2xx sur une route streamée » (corps JSON imprimé comme une ligne de
  build puis rejeté tel quel) ainsi que la sortie 0 sur échec de `docker
  build`/`check` sont déjà traités par le rapport **009** — non redupliqués ici.
- Le choix du socket (`cli.ts:26-31`, `loadConfig` relatif au CWD, `UNUSED_SOCKET`
  absent des shells non-login) est déjà couvert par les rapports **024** et **028**.
- Écriture dans une réponse dont le client est parti : `OutgoingMessage` n'émet
  `'error'` que s'il a un écouteur, et `ServerResponse` n'en a pas ici — le démon
  ne tombe pas (même conclusion que 009, toujours non exécutée faute de runtime).
- Pas de blocage synchrone de la boucle d'événements côté démon :
  `grep -n "Sync("` ne trouve que `chmodSync` (`api.ts:154`) et `existsSync`
  (`cli.ts:21`), tous deux hors du service des requêtes. `loadTasks`
  (`task.ts:164-188`) ne fait que des lectures de `task.json`. Un `status` qui
  pend ne peut donc venir que d'un blocage externe (processus arrêté, FS gelé),
  pas d'un chemin interne.
- Aucun test ne couvre `client.ts` ni `cli.ts` : il n'existe ni
  `src/client.test.ts` ni `src/cli.test.ts`.
