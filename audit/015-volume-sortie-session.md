# 015 — Volume de la sortie de session

**Fichiers examinés** : `src/docker.ts:28-60` (`docker()`), `:82-93`
(`buildBase`), `:130-150` (`runInTask`) ; `src/log.ts` (entier) ;
`src/iterate.ts:119-230` ; `src/claude.ts:86-112` (`parseStream`) ;
`src/scheduler.ts:83-139` ; `src/daemon.ts:192-226` ; `src/config.ts:12-21` et
`unused.config.json` (`timeoutMinutes`) ; `src/cli.ts:50-60` (handlers de
process) ; `deploy/unused.service` ; `docker/Dockerfile` ; `src/docker.test.ts`.
Relus pour ne pas redire : `audit/009` (streaming de `buildBase`) et
`audit/011` (échec d'écriture du journal).

**Verdict** : 4 constats (3 sûrs, 1 probable)

Ni `node` ni `docker` ne sont installés dans ce conteneur : tout ce qui suit est
établi par lecture, sans exécution.

## `docker()` accumule toute la session en mémoire, sans plafond ni contre-pression, et en tient trois copies sur une seule ligne

**Gravité** : sûr
**Où** : `src/docker.ts:34-35` et `src/docker.ts:51-57`

```ts
// src/docker.ts:34-43
const out: Buffer[] = [];
const err: Buffer[] = [];
child.stdout?.on("data", (d: Buffer) => {
  out.push(d);
  opts.onOutput?.(d.toString("utf8"));
});
…
// src/docker.ts:51-57
child.on("close", (code) => {
  resolve({
    code: code ?? -1,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  });
});
```

Trois faits se combinent :

1. **Aucun plafond.** Rien dans `docker()` ne limite `out`/`err` : ni nombre
   d'octets, ni fenêtre glissante, ni troncature. La seule borne est la durée de
   la commande.
2. **Aucune contre-pression.** Le handler `data` vide le pipe à la vitesse où
   docker écrit et empile le `Buffer` tel quel. Le container n'est donc jamais
   ralenti par le démon : une session qui crache vite remplit la RAM vite. Et
   pour `runInTask` (`docker.ts:148`), `onOutput` n'est pas fourni — personne ne
   consomme ni ne tronque le flux au fil de l'eau, contrairement à `buildBase`.
3. **Le pic est d'au moins 3 × N** à la ligne 54, avec N = octets de stdout.
   Quand `Buffer.concat(out)` s'exécute, le tableau `out` est encore référencé
   par la closure ; `concat` alloue un `Buffer` contigu de N ; puis `.toString()`
   alloue la chaîne, les deux coexistant le temps de la conversion. Les fragments
   (N) + le buffer contigu (N) + la chaîne (N) sont vivants simultanément. Idem
   pour `err` juste après.

**Scénario concret.** `timeoutMinutes` vaut 180 par défaut (`config.ts:19`) et
c'est la valeur du `unused.config.json` livré. La commande lancée est
`claude -p … --output-format stream-json --verbose` (`claude.ts:37`) : une ligne
JSON par message, `tool_result` compris. Une session de trois heures qui boucle
sur des outils bavards produit sans difficulté plusieurs centaines de Mo sur
stdout. Le déploiement visé est un Raspberry Pi (`deploy/unused.service`,
« sur le Pi »), où la limite de tas par défaut de V8 est de l'ordre de la moitié
de la RAM. Un pic à 3 × N pour une seule itération y est un facteur de mort par
OOM bien avant qu'un opérateur ne soupçonne que le coupable est *la lecture* de
la sortie, pas la session elle-même.

À noter que la construction en aval prolonge le pic : la chaîne `stdout` reste
vivante pendant `parseStream` (`iterate.ts:150`), puis pendant tout le corps
d'`iterate`, puis pendant `JSON.stringify` (constat 3).

Le correctif naturel est celui que `buildBase` applique déjà à demi : n'exiger
la sortie complète que quand l'appelant en a besoin. Les appels qui lisent
vraiment `stdout` (`dockerVersion`, `layerCount`, `image inspect`) produisent
quelques octets ; le seul appel volumineux est `runInTask`, dont `iterate`
n'utilise finalement que les lignes `result`/`rate_limit_event`/`system` et les
dernières lignes de `stderr` (`iterate.ts:227`). Un plafond d'octets (ou un
parsing NDJSON incrémental dans le handler `data`) suffirait.

## Si la sortie dépasse la taille maximale d'une chaîne V8, le démon ne lève pas : il meurt, et la promesse ne se règle jamais

**Gravité** : sûr (mécanisme) — le seuil, lui, demande une session extrême
**Où** : `src/docker.ts:51-57`

`Buffer.prototype.toString()` jette `ERR_STRING_TOO_LONG` (« Cannot create a
string longer than 0x1fffffe8 characters ») dès que le résultat dépasse
`buffer.constants.MAX_STRING_LENGTH`, soit 2^29 − 24 = 536 870 888 caractères
sur une plateforme 64 bits — valeur stable de Node 12 à Node 22 (`engines:
node >= 22`, `package.json`). Ce n'est pas le seul seuil possible : sur un Pi,
la limite de tas V8 ou l'OOM killer peuvent arriver avant. Les trois conduisent
au même endroit.

Ce qui rend ce point structurel, c'est **où** l'exception est levée :

```ts
child.on("close", (code) => {
  resolve({ …, stdout: Buffer.concat(out).toString("utf8"), … });
  //           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //           évalué AVANT l'appel à resolve()
});
```

Le handler `close` est invoqué par `emit()` longtemps après que l'exécuteur de
la `Promise` soit revenu. Un `throw` à cet endroit n'est donc **pas** converti
en rejet : il traverse `EventEmitter.emit` et devient un `uncaughtException`.
`src/cli.ts` n'installe que des handlers `SIGINT`/`SIGTERM`
(`cli.ts:56-57`), aucun `process.on("uncaughtException")` — le comportement par
défaut s'applique : trace sur stderr et sortie en code 1.

Double conséquence :

- **le `reject` prévu ligne 45 ne sert à rien ici.** Tout le soin pris autour de
  `DockerError` (`docker.ts:44-50`, rattrapé en `iterate.ts:144-147` pour
  produire un `fatal:docker` propre) est contourné : on ne passe pas par
  `finishFatal`, `this.fatal` n'est jamais renseigné, `unused status` n'affiche
  aucune panne ;
- **la promesse reste à jamais en attente.** L'expression jette avant d'appeler
  `resolve`, et il n'y a pas de second chemin de règlement. Si quelqu'un ajoutait
  un `process.on("uncaughtException")` pour « rendre le démon robuste », il
  transformerait un crash en blocage définitif : `await deps.runInTask(…)`
  (`iterate.ts:121`) ne rendrait jamais la main, le `.finally()` ligne 140 ne
  s'exécuterait pas (`clearTimeout`, retrait du listener d'abort), `this.running`
  resterait posé et `unused start` répondrait « une plage est déjà en cours »
  pour toujours.

**Scénario concret, état du disque après coup.** Itération sur la tâche `t` :

1. `runInTask` crée et lance `unused-t-1758400000000` (`docker.ts:132`) ;
2. la session part en vrille et écrit ~600 Mo sur stdout ;
3. `docker run` se termine, `close` se déclenche, `toString` jette ;
4. le processus meurt ; `systemd` le relance 5 s plus tard (`Restart=always`).

Ce qui reste : le container `unused-t-1758400000000` n'a été ni commité
(`iterate.ts:170`) ni jeté (`iterate.ts:180,185`) — et **rien ne ramasse les
containers orphelins au démarrage**. `pruneTask` (`docker.ts:183`) ne filtre que
des *images* ; le seul `container prune` du code est celui de
`dockerCheck.ts:108`, limité à `CHECK_TASK`. Pire, le container arrêté référence
son image de départ, ce qui empêche `image prune` de récupérer les couches
correspondantes au commit suivant. Chaque crash de ce type laisse donc sur la
carte SD du Pi un container mort et l'image qu'il épingle, sans trace dans
`data/logs/` puisque `writeIterationLog` n'a jamais été atteint.

Encadrer le corps du handler `close` dans un `try/catch` qui `reject`e une
`DockerError` suffirait à ramener ce cas dans le chemin `fatal:docker` déjà
écrit et testé.

## `rawStdout` recopie intégralement la sortie exactement dans le cas où elle est la plus grosse

**Gravité** : sûr
**Où** : `src/iterate.ts:210-211`, écrit par `src/log.ts:47`

```ts
// src/iterate.ts:210-211
...(session.result === null ? { rawStdout: r.stdout } : {}),
stderr: r.stderr,
```

```ts
// src/log.ts:28-29 — l'intention
// Sortie brute si le JSON était illisible, pour comprendre pourquoi.
rawStdout?: string;
```

L'intention (« comprendre pourquoi le JSON était illisible ») est servie par les
derniers kilo-octets. Ce qui est stocké, c'est la sortie entière. Et la
condition de déclenchement sélectionne précisément les sessions les plus
volumineuses :

`session.result === null` signifie qu'aucune ligne `{"type":"result"}` n'a été
lue (`claude.ts:99-101`). Le cas dominant en production n'est pas « sortie
corrompue » mais **le timeout** : à `cfg.claude.timeoutMinutes`, le timer
`iterate.ts:129-132` fait `docker kill`, la session est décapitée avant sa ligne
`result`, et `session.result` vaut `null`. Autrement dit, la session qui a tourné
**le plus longtemps** — donc celle qui a le plus écrit — est exactement celle
dont on duplique la sortie complète dans l'enregistrement.

La suite est mécanique (`log.ts:47`) :

```ts
await writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
```

`JSON.stringify` construit **une seconde chaîne** d'environ 1,1 à 1,2 × N (le
contenu est du NDJSON, déjà plein de `"` et de `\` que le ré-encodage double),
pendant que `r.stdout` est toujours vivant. Deux effets :

- **mémoire** : un nouveau pic d'au moins 2,15 × N, après celui du constat 1 ;
- **disque** : un fichier `data/logs/<tâche>/<horodatage>-<nœud>.json` de la
  taille de la sortie de session. Rien ne fait tourner ni ne purge ces fichiers
  (`grep` : `logsDir` n'apparaît qu'en `log.ts:37,43,66`, et aucun code ne relit
  jamais ces fichiers ni `index.jsonl`, cf. 011).

**Scénario concret.** `maxConsecutiveFailures` vaut 3 et un timeout produit
`decision: "retry"` (`iterate.ts:157`, puis `applyOutcome`). Une tâche dont le
nœud courant part systématiquement en boucle infinie enchaîne trois itérations
qui atteignent chacune le timeout, chacune déposant sur la carte SD un JSON de
la taille de sa sortie, avant que la tâche ne soit sortie de la file. Le disque
se remplit de la trace d'un échec que personne ne lira, et le remplissage du
disque est précisément ce qui, en 011 et 005, casse `writeIterationLog` et
`commitTask` pour *les autres* tâches.

Si N franchit la limite du constat 2, `JSON.stringify` jette le même
`ERR_STRING_TOO_LONG` — mais cette fois à un endroit `await`é, donc en rejet
propre, qui tombe dans le chemin déjà décrit en 011 : plage arrêtée, itération
effacée du journal alors qu'elle a consommé du quota.

Accessoirement, `stderr: r.stderr` (ligne 211) est stocké **en entier et sans
condition**, y compris pour une itération réussie — alors que l'affichage, lui,
prend soin de se limiter (`iterate.ts:227` : `.split("\n").slice(-3)`). La
prudence appliquée à l'écran n'a pas été appliquée au fichier.

## `onOutput` décode chaque chunk isolément : un caractère multi-octets coupé devient deux `U+FFFD`

**Gravité** : probable
**Où** : `src/docker.ts:38` et `src/docker.ts:42`

```ts
child.stdout?.on("data", (d: Buffer) => {
  out.push(d);
  opts.onOutput?.(d.toString("utf8"));   // ← décodage chunk par chunk
});
```

Les chunks arrivent aux frontières d'octets que le pipe veut bien donner (lecture
de 64 Kio par défaut), pas aux frontières de caractères. Un caractère UTF-8 à
plusieurs octets à cheval sur deux chunks est décodé en deux morceaux invalides,
chacun rendu `U+FFFD`. La capture, elle, est correcte : `out` garde les `Buffer`
bruts et le `Buffer.concat` final (ligne 54) recolle bien — seul le flux
*affiché* est abîmé. C'est précisément un défaut de volume : plus la sortie est
grosse, plus il y a de frontières, plus la probabilité de couper un caractère
approche 1.

Le seul consommateur d'`onOutput` est `buildBase` (`docker.ts:84-91`), dont la
sortie part vers `unused docker build` et la route streamée (cf. 009). Le
`Dockerfile` (`docker/Dockerfile:13`) exécute `curl -fsSL
https://claude.ai/install.sh | bash` et un `apt-get install` : ces installeurs
écrivent des coches, des barres et des descriptions de paquets non-ASCII. Le
correctif standard est `new StringDecoder("utf8")` par flux, qui retient les
octets incomplets jusqu'au chunk suivant.

Le rapport 009 a examiné ce code et conclu que « le découpage en lignes de
`buildBase` est correct » : c'est vrai du découpage sur `\n`, la remarque ici
porte sur le décodage en amont. Dans la même zone et pour la même raison
(nombre de chunks), `buildBase` partage **un seul** `buf` (`docker.ts:83`) entre
les deux flux, puisque `onOutput` est appelé aussi bien depuis le handler de
`stdout` (ligne 38) que depuis celui de `stderr` (ligne 42) : un chunk stdout
qui arrive au milieu d'une ligne stderr incomplète voit ses octets collés à la
suite de celle-ci, et la « ligne » imprimée est un assemblage de deux flux.
Pour `docker build` c'est fréquent — buildkit écrit sa progression sur stderr et
l'identifiant d'image sur stdout.

## Ce qui a été vérifié et tient

- **`parseStream` (`claude.ts:86-112`)** : le `stdout.split("\n")` ligne 88 ne
  double pas la mémoire des caractères — V8 produit des `SlicedString` qui
  référencent la chaîne parente au-delà de 13 caractères. Le surcoût se limite
  aux en-têtes d'objets et au tableau (de l'ordre de 40 octets par ligne), soit
  quelques pour-cent de N. La fonction ne retient elle-même que `result`, les
  `rate_limit_event`, l'`init` et les `api_retry` (lignes 98-109) : elle ne
  recopie pas le corps des messages `assistant`/`user`, qui constituent
  l'essentiel du volume. C'est le seul endroit de la chaîne qui se comporte
  correctement vis-à-vis du volume.
- **Les autres appelants de `docker()`** produisent des sorties bornées par
  construction : `dockerVersion` (un format Go), `imageExists`, `layerCount`,
  `image inspect --format {{json .Config}}`, `tag`, `commit`, `rm`, `rmi`,
  `image prune`. Aucun n'est un vecteur de volume.
- **`pipeExportImport` (`docker.ts:228-248`)** est le seul endroit qui fait les
  choses dans le bon sens : le tar de l'image, qui pèse des gigaoctets, transite
  par `exp.stdout.pipe(imp.stdin)` sans jamais passer en mémoire du démon ;
  seuls les `stderr` (petits) sont accumulés. L'aplatissement n'est donc pas
  concerné par cet aspect.
- **Le timer de timeout n'est pas une protection de volume** : il borne la
  *durée* (`iterate.ts:129-132`), pas le débit. Une session qui écrit 10 Mo/s
  pendant une minute est plus dangereuse pour la mémoire qu'une session calme de
  trois heures, et rien ne la voit venir.
- **`writeIterationLog` ne peut pas corrompre à moitié un fichier** : `writeFile`
  écrit un fichier neuf par itération (nom horodaté, `log.ts:46`) ; un échec en
  cours d'écriture laisse un `.json` tronqué mais ne détruit aucune trace
  antérieure. La ligne d'index (`log.ts:66`) est ajoutée après et reste courte
  quel que soit le volume — `rawStdout` n'y figure pas.
