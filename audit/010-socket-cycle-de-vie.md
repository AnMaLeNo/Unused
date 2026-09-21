# 010 — Cycle de vie du socket (listen/probe, démons concurrents, fermeture sur signal)

**Fichiers examinés** : `src/api.ts:127-155`, `src/cli.ts:35-64`, `src/client.ts:13-18`,
`src/state.ts:61-84`, `src/daemon.ts:96-158`, `src/task.ts:164-177`,
`deploy/unused.service`, `deploy/install.sh`, `src/daemon.test.ts:46-60,253-262`
**Verdict** : 3 constats (2 sûrs, 1 probable)

## `listen` ne crée pas `dataDir` : sur une installation neuve, le démon ne démarre jamais

**Gravité** : sûr
**Où** : `src/api.ts:144-154`, `src/cli.ts:44-45`

Le socket est ouvert dans `<dataDir>/unused.sock`, mais rien ne garantit que
`dataDir` existe au moment du `listen`. Le seul `mkdir` de `dataDir` du projet est
dans `saveState` (`src/state.ts:79`), et il n'est pas atteint au démarrage :
`loadState` renvoie `emptyState()` sans rien écrire quand `state.json` est absent
(`src/state.ts:66-67`), et `init()` ne sauvegarde que s'il a trouvé une plage
expirée dans un `state.json` existant (`src/daemon.ts:98-107`) — impossible sans
répertoire.

```ts
// cli.ts
const daemon = new Daemon(cfg, { print: log });
await daemon.init();            // ne crée pas data/
const server = createApi(cfg, daemon);
await listen(server, socketPath(cfg));   // bind dans un répertoire inexistant
```

Scénario : on suit le README à la lettre (`README.md:28-41`) — `git clone`,
`npm install && npm run build`, puis `node dist/cli.js daemon`. `data/` est
gitignoré (`.gitignore:3`) donc absent d'un clone neuf. `bind()` sur un chemin dont
le répertoire n'existe pas échoue en `ENOENT` ; le `server.once("error", reject)`
de `listen` propage, `program.parseAsync().catch` (`src/cli.ts:178-181`) affiche
`listen ENOENT /opt/unused/data/unused.sock` et sort en 1. Attendu : le démon
démarre et crée son répertoire de données. Obtenu : il ne démarre pas, avec un
message qui ne dit pas quoi faire.

Sous systemd c'est pire : le README installe l'unité sans passer par
`deploy/install.sh` (`README.md:37-41`), alors que seul `install.sh:41` fait le
`mkdir -p data`. Avec `Restart=always` / `RestartSec=5`
(`deploy/unused.service:18-19`), l'unité part en boucle de redémarrage
indéfinie, cinq secondes par tour, sur la même `ENOENT`.

À noter le contraste : un `tasksDir` absent, lui, est toléré et remonté comme une
erreur lisible (`src/task.ts:175-177`). Les tests ne voient rien parce que leur
`dataDir` est un `mkdtemp` déjà créé avant `boot()`.

## `probe()` confond « pas de réponse » et « pas de démon », et `listen` délie le socket quand même

**Gravité** : probable
**Où** : `src/api.ts:128-146`

`probe` résout `false` sur *toute* anomalie — erreur de connexion, mais aussi
expiration du `timeout: 2000` :

```ts
req.on("error", () => resolve(false));
req.on("timeout", () => { req.destroy(); resolve(false); });
...
if (await probe(sock)) throw new Error(`un démon répond déjà sur ${sock}`);
await unlink(sock).catch(() => {});
await new Promise(... server.listen(sock) ...);
```

La garde est purement consultative : une fois le `unlink` passé, le chemin est
libre et le `bind` ne peut plus échouer en `EADDRINUSE`. Le démon déjà en place
garde sa socket d'écoute sur l'inode délié — il ne reçoit ni erreur ni
événement, il devient simplement injoignable. Aucun autre verrou n'existe
(aucun pid-file, aucun `flock` : rien de tel dans `src/`), alors que `Daemon` se
déclare « seul propriétaire de state.json » (`src/daemon.ts:72`).

Scénario concret : le démon A tourne, une itération sature le Pi (container en
compilation, carte SD saturée) et `GET /status` — qui relit tout `tasksDir`
(`src/daemon.ts:327`) — met plus de deux secondes. L'opérateur, dont
`unused status` semble bloqué, lance `unused daemon`. B sonde, expire à 2 s,
conclut « pas de démon », supprime le socket de A et se lie sur un socket neuf.
Résultat :

- A est définitivement injoignable : `unused stop`, `unused stop --now`,
  `unused status` atterrissent tous chez B. A continue à lancer des containers
  jusqu'au `kill` manuel ;
- les deux démons tiennent chacun leur `RunnerState` en mémoire et réécrivent
  `state.json` en entier à chaque sauvegarde (`src/state.ts:78-84`) : le dernier
  qui écrit efface les curseurs et compteurs de l'autre ;
- les deux peuvent exécuter la même tâche : le nom d'image est global par tâche
  (`unused-task-<nom>`, `src/docker.ts:97-98`), donc deux itérations concurrentes
  commitent sur le même tag et l'une écrase l'autre — l'invariant « une itération
  ratée n'a jamais eu lieu » tombe.

La même issue s'ouvre par pur TOCTOU : deux `unused daemon` lancés dans la même
milliseconde sondent tous les deux avant que l'un ait bindé (il n'y a qu'un
`unlink` entre le `probe` et le `listen`), et les deux réussissent.

Attendu : refuser de démarrer quand on ne peut pas prouver que le socket est
périmé. Obtenu : on le supprime et on prend la place.

## L'arrêt ne coupe pas les requêtes streamées, mais annonce « démon arrêté »

**Gravité** : sûr
**Où** : `src/cli.ts:58-63`, `src/api.ts:97-111`

```ts
try {
  await daemon.run(ac.signal);
} finally {
  server.close();
  log("démon arrêté");
}
```

`server.close()` ferme l'écoute, pas les connexions en cours, et n'est pas
attendu ; `buildBase(cfg, print)` et `dockerCheck(cfg, opts, print)` ne reçoivent
aucun `AbortSignal` (`src/api.ts:99,106`) — rien ne les interrompt.

Scénario : `unused docker check` (plusieurs minutes : build de l'image de base,
cycle run → commit → run, aplatissement) est en cours quand le service est
redémarré — c'est exactement ce que fait `deploy/install.sh:67` (`systemctl
restart unused`). SIGTERM arrive ; `daemon.run` sort tout de suite puisqu'aucune
plage ne tourne ; le `finally` ferme l'écoute et affiche « démon arrêté ». Or :

- le processus ne s'arrête pas : la connexion HTTP ouverte et le processus
  `docker` enfant restent des handles actifs, la boucle d'événements ne se vide
  pas. Le journal affirme un arrêt qui n'a pas eu lieu ;
- l'écoute est fermée (et Node délie le fichier socket à la fermeture) : dès cet
  instant, toute commande cliente tombe sur `ENOENT`/`ECONNREFUSED` et répond
  « le démon n'est pas lancé » (`src/client.ts:13-16`), alors que le processus
  est bien vivant et continue à construire des images ;
- systemd attend `TimeoutStopSec=60` puis `SIGKILL` sur tout le cgroup
  (`KillMode=mixed`, `deploy/unused.service:22-23`) : le check est tué au milieu,
  sans passer par ses nettoyages, laissant container et images
  `unused-task-docker-check-internal` derrière lui.

Attendu : soit on coupe les requêtes en vol et on sort, soit on attend leur fin
avant d'annoncer l'arrêt. Obtenu : ni l'un ni l'autre — on ment, puis on se fait
tuer.

## Ce qui a été vérifié et tient

Le nettoyage d'un socket périmé après un `SIGKILL` fonctionne : `probe` reçoit
`ECONNREFUSED`, `unlink` retire le fichier et le `bind` réussit (couvert par
`src/daemon.test.ts:253-262`). Le refus d'un second démon est correct **quand**
`/status` répond. Le chemin du socket est bien le même côté démon
(`socketPath(cfg)`) et côté client par défaut, et `--socket`/`UNUSED_SOCKET` ne
concernent que le client, conformément au README. Le double signal
(`process.exit(130)`, `src/cli.ts:52`) laisse un fichier socket derrière lui, mais
le démarrage suivant le nettoie : sans conséquence. La propagation de
l'abandon depuis `onSignal` jusqu'à l'itération en cours (`ac.abort()` →
`run.ac.abort()`, `src/daemon.ts:139-143`) est correcte, et les gestionnaires de
signaux de Node étant `unref`, ils n'empêchent pas la sortie.
