# 017 — Intégrité de `data/state.json` (`loadState` / `saveState`)

**Fichiers examinés** : `src/state.ts:1-84` (tout le module), `src/daemon.ts:96-113,228-243,284-326,397-418`,
`src/scheduler.ts:74-155`, `src/iterate.ts:160-232`, `src/api.ts:54-125`,
`src/cli.ts:34-64,66-180`, `src/state.test.ts`, `deploy/unused.service`,
`README.md` (recherche de `state.json`)
**Verdict** : 2 constats (1 sûr, 1 probable)

Ni `node` ni `python` ne sont disponibles dans ce conteneur : aucun test du
dépôt n'a pu être exécuté. En revanche la sémantique POSIX dont dépend le
premier constat, elle, a été **vérifiée par exécution** (fds `bash`, plus bas) ;
c'est précisément le point que le rapport 006 laissait « à vérifier ».

## Deux `saveState` qui se chevauchent : le second `rename` échoue toujours, et le fichier promu peut être un mélange

**Gravité** : probable
**Où** : `src/state.ts:78-84`, appelé depuis `src/iterate.ts:189`,
`src/scheduler.ts:79,148`, `src/daemon.ts:234,241,298,318,402`

```ts
// state.ts:77-84 — « Écriture atomique : fichier temporaire puis rename »
export async function saveState(dataDir: string, state: RunnerState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, STATE_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
```

Le chemin temporaire est fixe et partagé par tous les appelants. Le rapport 004
attribuait la collision à deux processus, le rapport 006 a montré qu'un seul
démon suffit (handlers API et boucle d'itération sur le même event loop, aucune
garde, aucune file d'attente — `grep -n "mutex\|lock\|queue" src/*.ts` ne
retourne que des commentaires sur le quota). Les deux rapports supposaient que
le seul dégât possible était un fichier mélangé, d'où la gravité « à vérifier ».

C'est plus large que ça : **dès que les deux `saveState` se chevauchent, l'un
des deux `rename` lève `ENOENT`**, mélange ou pas. Le premier `rename` consomme
le `state.json.tmp` unique ; quand le second arrive, il n'y a plus rien à
renommer. Vérifié :

```
$ exec 3>state.json.tmp   # A: writeFile ouvre en O_TRUNC
$ exec 4>state.json.tmp   # B: writeFile ouvre le même chemin, fd distinct, offset 0
$ printf "$BIG\n"   >&3   # A: write
$ printf "$SMALL\n" >&4   # B: write, sans tronquer -> ne recouvre que le début
$ cat state.json.tmp
{"version":1,"window":null,"tasks":{}}
A","until":"BBBB"},"tasks":{"t":{"iterations":17}}}      <- queue de A, JSON invalide
$ mv state.json.tmp state.json && echo ok                 # rename de A
ok
$ mv state.json.tmp state.json                            # rename de B
mv: cannot stat 'state.json.tmp': No such file or directory
```

Les deux branches sont donc réelles :

- **branche `ENOENT`** (quel que soit l'ordre des `write`) : le perdant voit sa
  promesse `rename` rejetée ;
- **branche mélange** (les deux `open` précèdent les deux `write`, et le plus
  court écrit en dernier — plausible : `fsPromises.writeFile` fait `open` puis
  `write`, et les deux `open` partent en parallèle dans le threadpool libuv) :
  le JSON promu est invalide, ce qui enchaîne sur le constat suivant. Les deux
  instantanés n'ont jamais la même longueur (`window` à `null` contre un objet
  de deux dates, `pausedUntil`, une entrée de tâche en plus ou en moins), donc
  la condition de longueur est satisfaite en pratique.

Une troisième variante a été exécutée pour lever un doute : si le `rename` de A
tombe entre l'`open` et le `write` de B, le fd de B suit l'inode et **écrit
directement dans le `state.json` déjà promu**, hors de toute atomicité — puis le
`rename` de B échoue quand même en `ENOENT`.

Scénario concret : plage en cours, une itération vient de finir, l'opérateur
tape `unused stop` (cas nominal — la commande est explicitement autorisée
pendant une itération, `daemon.ts:308-326`). La requête `DELETE /window` est
servie pendant que `iterate` est dans son `saveState` de fin d'itération
(`iterate.ts:189`), les deux écritures se croisent. Selon le perdant :

**1. C'est `stopWindow` qui perd** (`daemon.ts:317-318`) :

```ts
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
await saveState(this.cfg.dataDir, this.state);   // <- lève ENOENT
run.explicitStop = true;                          // jamais atteint
if (now) { run.ac.abort(); return { stopping: "now" }; }
run.stopRequested = true;                         // jamais atteint
```

Obtenu : `unused stop` sort en 1 sur
`ENOENT: no such file or directory, rename '…/state.json.tmp' -> '…/state.json'`
(erreur non typée ⇒ 500, `api.ts:119-122`) **et la plage continue de tourner**,
puisque ni `explicitStop` ni `stopRequested` n'ont été posés. Pire, l'affectation
de la ligne 317 a déjà eu lieu en mémoire : `GET /status` annonce désormais
« pause plages automatiques ignorées jusqu'à … » (`daemon.ts:362`,
`cli.ts:105`) pendant que les itérations s'enchaînent. L'état affiché contredit
l'état réel, et un opérateur qui relance `unused stop` — sans plus aucune
itération en vol cette fois — obtiendra une réponse correcte : le défaut
ressemble donc à un caprice, pas à un bug. Attendu : soit l'arrêt est demandé,
soit il est refusé ; pas « refusé, mais à moitié appliqué ».

Même forme pour les autres commandes :

- `startWindow` (`daemon.ts:294-300`) pose `this.manual`, `fatal = null`,
  `pausedUntil = null`, **puis** sauve, **puis** réveille la boucle. Si le
  `saveState` lève : la CLI dit que le démarrage a échoué, mais le démon a
  accepté la plage en mémoire sans jamais appeler `this.wake?.()` — s'il est
  dans `idle()` il y reste jusqu'à la prochaine plage du calendrier (ou
  indéfiniment sans calendrier, `daemon.ts:163-165`). La plage « échouée »
  démarre donc plus tard, toute seule, ou jamais ; et comme elle n'est pas dans
  `state.json`, un redémarrage l'oublie.
- `resetTask` (`daemon.ts:400-406`) efface `state.tasks[name]` en mémoire puis
  sauve avant de supprimer le fichier `DONE` et les images. Si le `saveState`
  lève, le reset est annoncé en échec alors que le curseur est déjà effacé, et
  la sentinelle `DONE` survit — c'est-à-dire que la première itération suivante
  de cette tâche sera classée `completed` sans avoir rien fait
  (`iterate.ts:159`, `classify(session, done)`).

**2. C'est `iterate` qui perd** (`iterate.ts:189`) — conséquence plus lourde :
l'exception traverse `runWindow` (aucun `try` sur `deps.runIteration`,
`scheduler.ts:98`) jusqu'au `catch` de `execute` :

```ts
// daemon.ts:213-216
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
}
```

Obtenu : la plage entière meurt sur un `ENOENT` de `rename`, et les plages
**automatiques** sont mises en pause jusqu'à la fin de la couverture courante —
un `unused stop` d'une plage manuelle peut ainsi éteindre la nuit de calendrier
qui la suivait. Au passage, tout ce qui vient après la ligne 189 est sauté :
`writeIterationLog` (`iterate.ts:217`) n'est jamais appelé, donc l'itération qui
vient de tourner — container déjà commité, image `:latest` déjà retaguée
(`iterate.ts:170-172`) — ne laisse **aucune trace dans le journal**, et
l'événement `iteration-end` n'étant jamais émis, les compteurs de `run.live`
l'ignorent. Attendu : une écriture d'état concurrente n'a aucune raison
d'échouer, et un échec d'écriture d'état n'a aucune raison de faire disparaître
le journal d'une itération payée.

Le correctif est le même que celui déjà proposé en 004 et 006 et ne coûte rien :
un suffixe unique (`${file}.${process.pid}.${counter}.tmp`) ou un écrivain
sérialisé. Ce qu'ajoute ce rapport, c'est que la branche `ENOENT` rend le défaut
**bien plus probable que la branche « fichier mélangé »** : elle ne demande
aucune coïncidence sur la longueur des instantanés ni sur l'ordre des `write`,
seulement que les deux intervalles se recouvrent.

## Un seul octet invalide dans `state.json` et plus aucune commande ne fonctionne, sans aucun moyen de réparer

**Gravité** : sûr
**Où** : `src/state.ts:61-75`, `src/daemon.ts:96-97`, `src/cli.ts:39-42,176-180`,
`deploy/unused.service:19-20`

`loadState` ne tolère que l'absence du fichier ; tout le reste est fatal :

```ts
// state.ts:61-75
try {
  raw = JSON.parse(await readFile(file, "utf8"));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
  throw new Error(`Impossible de lire ${file} : ${(err as Error).message}`);
}
const parsed = RunnerStateSchema.safeParse(raw);
if (!parsed.success) {
  throw new Error(`${file} invalide :\n${formatZodError(parsed.error)}`);
}
```

Ce choix est délibéré et testé (`state.test.ts:31-34`, « refuse un fichier
corrompu avec un message clair »), et refuser de repartir sur un état inventé
est raisonnable. Le problème est ce qu'il n'y a **pas** en face : aucune reprise,
aucune mise de côté du fichier fautif, et surtout aucun chemin de réparation
dans le produit.

Chaîne complète, vérifiée par lecture :

1. `daemon.init()` (`daemon.ts:97`) est le premier `await` de l'action `daemon`
   (`cli.ts:39-42`) — avant `createApi` et avant `listen`. Le rejet remonte à
   `program.parseAsync().catch(...)` (`cli.ts:176-180`) : message sur stderr,
   `process.exit(1)`. **Le socket n'est jamais créé.**
2. `deploy/unused.service` déclare `Restart=always` / `RestartSec=5` : le service
   reboucle indéfiniment, cinq secondes par tour, sur la même erreur.
3. Les onze autres commandes de la CLI (`start`, `stop`, `status`,
   `tasks list|new|reset`, `docker build|check`) passent **toutes** par
   `await sock()` puis `call`/`stream` (`cli.ts:66-174`) : sans socket, chacune
   répond « démon injoignable ». Y compris `unused tasks reset`, la seule
   commande capable de toucher à `state.tasks`, et `unused status`, qui pourrait
   au moins expliquer la panne.

Obtenu : le produit est intégralement mort, et le seul remède est de savoir
qu'il faut supprimer à la main `data/state.json` — un fichier que le `README.md`
ne mentionne **jamais** (aucune occurrence de `state.json` dans `README.md` ni
dans `deploy/install.sh`), au prix de la perte de tous les curseurs et
compteurs. Attendu, au minimum : que le fichier refusé soit déplacé en
`state.json.corrupt-<date>` et que le démon reparte sur `emptyState()` en le
criant dans le journal, ou qu'une commande locale (ne passant pas par le socket)
permette d'inspecter et de réinitialiser l'état.

Le déclencheur n'est pas hypothétique : c'est exactement la branche « mélange »
du constat précédent, et le mélange est promu en `state.json` par le `rename`
gagnant, donc il survit à l'arrêt du démon. Deux autres déclencheurs, moins
probables mais sans plus de porte de sortie : un retour en arrière de version
après qu'un `version: 2` a été écrit (`version: z.literal(1)`, `state.ts:23`),
et une coupure d'alimentation (voir plus bas). À noter aussi que le message pour
un fichier tronqué est trompeur — « Impossible de lire … : Unexpected end of
JSON input » alors que la lecture a parfaitement réussi, c'est l'analyse qui a
échoué : `JSON.parse` est dans le même `try` que `readFile` (`state.ts:65`).

## Ce qui a été vérifié et tient

- **`rename` comme mécanisme d'atomicité** : un lecteur ne voit jamais un
  `state.json` à moitié écrit ; c'est bien la garantie annoncée ligne 77, et
  elle vaut mieux que le `writeFile` direct de `setActive` (constat 3 du
  rapport 006). Nuance sur « pour survivre à une coupure » : il n'y a aucun
  `fsync` du fichier temporaire avant le `rename`, ni du répertoire après. Sur
  ext4 l'heuristique `auto_da_alloc` force l'allocation lors d'un `rename` de
  remplacement, ce qui couvre le cas usuel — mais c'est une heuristique du
  système de fichiers, pas une garantie du programme. Non démontrable ici
  (aucune coupure à provoquer), donc pas rapporté comme constat.
- **Absence de fichier** : `loadState` retourne `emptyState()` sans rien écrire
  (`state.ts:67`), et `saveState` crée `dataDir` avec `recursive: true`
  (`state.ts:79`) : une installation neuve démarre sans état et le premier
  `saveState` suffit. Cohérent avec `iterate.test.ts:179`, qui vérifie qu'une
  itération avortée n'écrit rien.
- **Un `state.json.tmp` orphelin** (écriture réussie, `rename` échoué) n'empoisonne
  pas les démarrages suivants : `loadState` ne lit que `state.json`, et le
  `writeFile` suivant ouvre le temporaire en `O_TRUNC`.
- **Clés de tâches dangereuses** : `state.tasks["__proto__"]` serait avalé par
  `JSON.stringify` (affectation de prototype, pas de propriété propre) et la
  tâche perdrait son curseur à chaque redémarrage — mais `TASK_NAME_RE`
  (`task.ts:122-126`) refuse le nom bien avant, un nom de tâche devant rester un
  nom d'image Docker. Rien à signaler.
- **Tolérance de schéma à la relecture** : `pausedUntil` a un `.default(null)`
  (`state.ts:31`), donc un `state.json` écrit avant l'introduction du champ se
  relit. Les autres champs sont `nullable` mais requis ; comme `emptyState()`
  les écrit tous depuis toujours, aucune migration cassée n'a pu être
  démontrée.
- **`ensureTaskState`** repositionne bien le curseur sur `start` quand le nœud a
  disparu du `task.json` (`state.ts:50-58`), et `taskInfo` fait la même
  correction en lecture sans écrire (`daemon.ts:381`) : un `task.json` réécrit
  ne bloque pas le démarrage.
- **`delete this.state.tasks[name]`** dans `resetTask` ne corrompt pas l'objet
  relu ensuite par zod (`z.record` reconstruit un objet neuf), et le `JSON.stringify`
  de `saveState` sérialise l'état complet à chaque fois — pas de fusion
  partielle, le dernier écrivain gagne (déjà noté en 010).
