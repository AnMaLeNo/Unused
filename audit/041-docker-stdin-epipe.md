# 041 — src/docker.ts docker()/runInTask : prompt écrit sur un stdin sans écouteur d'erreur

**Fichiers examinés** : `src/docker.ts:27-59` (`docker()`), `src/docker.ts:126-149`
(`runInTask`), `src/docker.ts:214-247` (`flattenTask` / `pipeExportImport`),
`src/iterate.ts:118-182` (seul appelant qui passe `stdin`),
`src/dockerCheck.ts:40-112` (aucun appel avec `stdin`), `src/claude.ts:14-19`
(`buildPrompt`, taille du prompt), `src/cli.ts` (recherche de
`uncaughtException` : absent).

**Verdict** : 3 constats (1 sûr, 2 probables). L'hypothèse de départ — EPIPE sur
le prompt parce que `docker run` sort tôt — **ne tient pas** ; mais les deux
écritures sur un `stdin` d'enfant de ce fichier sont bien dépourvues de
traitement d'erreur, et c'est l'autre (`docker import`) qui est atteignable.

Préalable commun aux trois constats : aucun `process.on("uncaughtException")`
n'est posé (`src/cli.ts:56-57` n'enregistre que SIGINT/SIGTERM). Une erreur
émise sur un flux sans écouteur `error` est donc relancée par `emit` et tue le
processus — pour le démon, cela veut dire mourir au milieu d'une itération.

## `pipeExportImport` : si `docker import` sort tôt, le `docker export` n'est jamais tué et reste bloqué pour toujours

**Gravité** : sûr
**Où** : `src/docker.ts:228-247`

```ts
const exp = spawn("docker", ["export", container], { stdio: ["ignore", "pipe", "pipe"] });
const imp = spawn("docker", importArgs, { stdio: ["pipe", "pipe", "pipe"] });
exp.stdout.pipe(imp.stdin);
...
imp.on("close", (c) => {
  if (c === 0 && (expCode === 0 || expCode === null)) resolve();
  else reject(new DockerError(`aplatissement a échoué :\n…`));
});
```

Le seul lien entre les deux enfants est le `pipe`. Rien, dans aucun chemin, ne
tue `exp` : il n'y a pas de `exp.kill()`, et la promesse se contente de rendre
la main sur le `close` de `imp`.

Scénario : une image de tâche dépasse `flattenAfterLayers`, `commitTask` appelle
`flattenTask` (`src/docker.ts:177`), l'export fait plusieurs Go et le disque de
`/var/lib/docker` sature en cours de route. `docker import` sort en erreur après
quelques secondes, bien avant la fin du flux. Suite des événements :

1. `imp.stdin` est fermé/détruit ; l'écriture en cours échoue (EPIPE).
2. `Readable.prototype.pipe` dépipe la source sur erreur de destination ;
   `unpipe` repasse `exp.stdout` en `flowing = false`. Plus personne ne lit.
3. `docker export` remplit les 64 Kio du tube puis **bloque indéfiniment dans
   `write()`**. Il garde le container `unused-flatten-<tâche>-<ts>` ouvert.
4. `imp.on("close")` rejette, `flattenTask` passe par son `finally` et lance
   `docker(["rm", tmp])` — dont le code de sortie est ignoré (`docker()` ne lève
   jamais sur code ≠ 0, cf. son commentaire `src/docker.ts:26`). Que le daemon
   refuse la suppression (container tenu par l'export) ou l'accepte, l'échec
   éventuel est invisible.
5. `exp` reste un enfant vivant, avec un écouteur `data` sur `exp.stderr`
   (`src/docker.ts:238-239`) : ses handles libuv maintiennent la boucle
   d'événements du démon ouverte, en plus du processus `docker export` orphelin.

Résultat obtenu : à chaque aplatissement échoué, un processus `docker export`
figé + un container temporaire qui ne part pas, et un démon qui ne peut plus
sortir de lui-même à l'arrêt. Résultat attendu : tuer `exp` dès que `imp` sort,
et attendre la fin des deux avant de trancher.

## Même endroit : l'EPIPE sur `imp.stdin` n'a aucun écouteur, et `pipe` finit par le relancer

**Gravité** : probable
**Où** : `src/docker.ts:235`

`imp.stdin` ne reçoit jamais de `.on("error", …)` : seuls les *processus* en ont
un (lignes 245-246), pas les flux. Dans le scénario ci-dessus, l'EPIPE est
d'abord livré au `onerror` interne posé par `pipe` sur la destination ; celui-ci
se retire lui-même, constate `dest.listenerCount("error") === 0` et, l'erreur
ayant déjà été marquée émise par le chemin `errorOrDestroy` du Writable, la
ré-émet sur un flux désormais sans écouteur. `emit("error")` relance alors
l'erreur : exception non rattrapée, démon tué.

Ce qui rend la conséquence sérieuse, c'est le moment : `flattenTask` est appelé
**depuis `commitTask`, après le `docker commit` et après la rotation de `:prev`**
(`src/docker.ts:168-177`), donc avant le `saveState` de l'itération
(`src/iterate.ts:187`). Le processus meurt entre les deux :

- l'image `:latest` a avancé d'une itération, `:prev` a déjà été écrasé ;
- `state.json` sur le disque est resté à l'itération précédente (curseur et
  `iterations` d'avant) ;
- le `DONE` du `/exchange` n'est pas nettoyé.

Au redémarrage, le démon réexécute le même nœud sur une image qui l'a déjà
exécuté, et le `DONE` qui traîne n'est effacé qu'au début de l'itération suivante
(`src/iterate.ts:110`) — l'état sur disque *mentait* sur ce qui a réellement été
commité. Le `catch (err instanceof DockerError)` de `src/iterate.ts:171-181`,
prévu exactement pour « le travail est fait mais l'état ne peut pas être
conservé », ne sert à rien ici : une exception non rattrapée ne passe par aucun
`catch`.

**Non exécuté** : ce conteneur n'a ni `node` ni `docker` (`package.json` exige
node ≥ 22), la ré-émission par `pipe` n'a donc pas pu être observée en vrai, d'où
« probable » et non « sûr ». Reproduction en dix lignes pour la prochaine
session : `spawn("sh", ["-c", "exit 1"])` comme destination, puis piper dedans un
flux de plusieurs Mo.

## `docker()` : si le `spawn` échoue, l'écriture du prompt tue le processus au lieu de rendre « docker introuvable »

**Gravité** : probable
**Où** : `src/docker.ts:58`

```ts
child.on("error", (e: NodeJS.ErrnoException) => {
  reject(new DockerError(e.code === "ENOENT" ? "docker introuvable : …" : e.message));
});
…
if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
```

Quand `uv_spawn` échoue avec ENOENT ou EAGAIN, `child_process` ne s'arrête pas
là : il continue de construire les sockets stdio, mais `createSocket` reçoit
`null` au lieu du handle, parce que `pid` vaut 0. `child.stdin` est donc un
`net.Socket` **sans handle et pas encore détruit** (la destruction n'a lieu qu'au
`process.nextTick(onErrorNT, …)`, après notre code synchrone). L'`?.` de la
ligne 58 ne protège que le cas EMFILE/ENFILE, où le tableau stdio n'est pas
construit du tout.

L'`.end(prompt)` tombe donc sur la branche « pas de handle » de
`Socket.prototype._writeGeneric`, qui rappelle le callback d'écriture avec
`ERR_SOCKET_CLOSED`. Le flux n'étant pas encore détruit, `errorOrDestroy` ne
sort pas en avance : l'erreur est émise sur `child.stdin`, qui n'a aucun
écouteur → exception non rattrapée.

Scénario concret : le démon tourne, `docker` disparaît du PATH (mise à jour du
paquet) ou l'hôte est à court de processus/mémoire (EAGAIN au `fork`). Prochaine
itération : `runInTask` passe toujours un `stdin` (`src/iterate.ts:123`, le
prompt n'est jamais `undefined`). Résultat obtenu : le démon meurt sur
`Error: Socket is closed`, aucune itération enregistrée, `saveState` jamais
appelé. Résultat attendu : le rejet `DockerError("docker introuvable …")` déjà
écrit ligne 44-50, que `src/iterate.ts:135-138` convertit proprement en
`finishFatal("docker", …)`.

À noter : même si l'ordre des `nextTick` fait que le rejet `DockerError` part
*avant* l'erreur du socket, le processus meurt quand même au tick suivant ;
le message propre est affiché, puis la trace d'exception le recouvre.

**Non exécuté** pour la même raison que ci-dessus (pas de `node` dans le
conteneur) : le raisonnement s'appuie sur le chemin
`ChildProcess.prototype.spawn` → `createSocket(pid !== 0 ? handle : null)` →
`Socket.prototype._writeGeneric` → `ERR_SOCKET_CLOSED`. Variante possible si
cette ligne a changé de forme selon la version : le handle existe mais n'a pas
de fd (libuv ferme les deux bouts du socketpair dans son chemin d'erreur), et
l'écriture échoue alors en EBADF — même conclusion, erreur émise sans écouteur.

## Ce qui a été vérifié et tient

- **L'hypothèse de départ est fausse** : le prompt ne peut pas provoquer d'EPIPE
  parce que `docker run` sort tôt. `child.stdin.end(prompt)` est appelé dans le
  même tour synchrone que `spawn` (`src/docker.ts:30` puis `:58`) : à cet
  instant le bout lecteur du tube est forcément encore ouvert, et le prompt est
  minuscule — `buildPrompt` ne produit qu'une ligne `/<skill> clé=valeur …`
  (`src/claude.ts:14-19`), très loin des 64 Kio du tampon de tube. L'écriture est
  donc absorbée par le noyau avant que `docker run` ait la moindre chance de
  sortir ; que le container ignore son stdin, échoue sur une image absente ou
  parte en conflit de nom ne change rien. Il faudrait un prompt > 64 Kio (donc
  un paramètre de tâche gigantesque dans la config) pour que des morceaux
  restent en file et échouent après la sortie de `docker` : hors d'atteinte en
  pratique, et non retenu comme constat.
- `runInTask` ajoute bien `-i` quand et seulement quand `stdin` est fourni
  (`src/docker.ts:144`), et `stdio[0]` vaut `"ignore"` sinon (`:32`) — pas de
  fuite de handle, pas de container qui attend un stdin jamais fermé.
- `src/dockerCheck.ts` n'appelle jamais `runInTask` avec `stdin` : le seul
  chemin concerné est celui du prompt d'itération.
- Le double `resolve`/`reject` possible dans `docker()` (`error` puis `close`)
  est inoffensif : la première issue gagne.
