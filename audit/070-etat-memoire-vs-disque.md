# 070 — État en mémoire contre état sur disque

**Fichiers examinés** : `src/state.ts` (entier : schéma, `loadState`,
`saveState`, `ensureTaskState`), `src/daemon.ts:77-135` (`init`, le champ
`this.state`), `src/daemon.ts:177-250` (`execute`, `pauseUntil`, `unpause`),
`src/daemon.ts:284-418` (les cinq commandes de l'API et leurs
`saveState`), `src/scheduler.ts:56-156` (les deux `saveState` de la plage),
`src/iterate.ts:72-200` (la mutation de `ts` et le `saveState` de fin
d'itération), `src/graph.ts:107-153` (`isEligible`, `pickNext`,
`applyDecision` : les champs d'état qu'ils lisent), `src/api.ts:54-155`
(sérialisation des requêtes, `listen`/`probe`), `src/cli.ts:33-64` (ordre
`init` → `listen`), `src/config.ts:30-44` (`windows` par défaut),
`src/daemon.test.ts` (entier), `src/state.test.ts`, `src/scheduler.test.ts`,
`unused.config.json`.

**Verdict** : 3 constats (1 sûr, 1 probable, 1 à vérifier)

Ni `node` ni `node_modules` dans ce conteneur : tout ce qui suit est établi
par lecture, en suivant les valeurs d'un appel à l'autre. Les numéros de ligne
sont ceux de la branche `audit`.

Le cadre de l'angle. `this.state` est chargé **une seule fois**
(`daemon.ts:97`) et vit ensuite en mémoire pour toute la vie du processus.
C'est le *même objet* qui est passé par référence à `runWindow`
(`daemon.ts:195`) puis à `iterate` (`scheduler.ts:66`), si bien que les
mutations des commandes de l'API sont bien vues par la plage en cours, et
réciproquement — ce point tient. Le disque, lui, n'est qu'une projection,
réécrite en entier par neuf appels à `saveState` dispersés dans trois modules
(`daemon.ts:106,221,234,241,298,318,402`, `scheduler.ts:79,148`,
`iterate.ts:189`). Les trois constats sont les endroits où cette projection
peut diverger de la mémoire, ou être détruite.

## Une plage abandonnée après erreur reste enregistrée sur disque et repart au redémarrage

**Gravité** : sûr
**Où** : `src/daemon.ts:213-225` (le chemin d'erreur), `src/daemon.ts:228-236`
(la sortie prématurée de `pauseUntil`), `src/daemon.ts:96-108` (la reprise)

Quand `runWindow` lève, `execute` décide explicitement d'oublier la plage,
puis délègue l'écriture à `pauseUntil` :

```ts
// daemon.ts:213-225
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;                                   // ← mémoire
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
} finally {
  if (run.explicitStop && this.state.window) {                // ← faux ici
    this.state.window = null;
    await saveState(this.cfg.dataDir, this.state);             // ← seul save du finally
  }
  ...
}
```

Or `pauseUntil` commence par refuser de travailler s'il n'y a pas de
calendrier :

```ts
// daemon.ts:228-236
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;   // ← aucun saveState
  ...
  this.state.pausedUntil = until.toISOString();
  await saveState(this.cfg.dataDir, this.state);
```

`windows` vaut `[]` par défaut (`config.ts:32`), et c'est aussi la
configuration du fixture de test (`daemon.test.ts` ne la peuple que dans un
seul cas). Dans cette configuration — usage purement manuel, `start --for` —
`this.state.window = null` n'atteint **jamais** le disque, et
`run.explicitStop` est faux (aucun `stop` n'a été demandé) donc le `finally`
ne sauve pas non plus.

Scénario concret, configuration sans `windows` :

1. `unused start --for 8h`. `runWindow` écrit
   `window = {until: T+8h}` sur disque (`scheduler.ts:78-79`).
2. Une itération se termine, `iterate.ts:189` ré-enregistre l'état — `window`
   est toujours là, c'est normal, la plage court.
3. L'itération suivante lève : disque plein sur le `writeIterationLog` de
   `iterate.ts:217`, ou `EACCES` sur `data/logs`, ou un `saveState` qui échoue,
   ou toute erreur non-`DockerError` remontée par `runInTask`
   (`iterate.ts:146`). `runWindow` ne rattrape rien, l'exception arrive dans le
   `catch` ci-dessus.
4. En mémoire : `window = null`, `manual = null` (`daemon.ts:223`),
   `running = null`. `unused status` affiche « plage aucune », sans pause ni
   plage automatique annoncée. Le démon s'endort dans `idle` sans minuterie.
5. Sur disque : `window` vaut toujours `{until: T+8h}`.
6. L'opérateur fait de la place et redémarre le service, à T+1h. `init`
   (`daemon.ts:98-102`) trouve la plage, la juge non expirée et imprime
   « plage interrompue trouvée, reprise jusqu'à T+8h » : sept heures de plage
   repartent, alors que le code avait décidé de les abandonner et que la CLI
   venait d'affirmer qu'aucune plage n'existait.

Les deux sources de vérité se contredisent, et c'est le hasard du redémarrage
qui tranche. À comparer avec le chemin voisin, cohérent lui : `stop --now`
passe par `run.explicitStop` et écrit bien `window = null`
(`daemon.ts:218-222`, couvert par le test « stop --now : la plage n'est pas
reprise au redémarrage »). Le chemin d'erreur, lui, n'est couvert par aucun
test.

Avec un calendrier configuré, `pauseUntil` sauve et la divergence n'apparaît
pas : le constat est spécifique à `windows: []`. À noter honnêtement — le
`unused.config.json` du dépôt déclare, lui, une plage (`mon 00:00-13:00`) et
échappe donc au constat ; celui-ci vise un déploiement purement manuel, qui
est la valeur par défaut du schéma (`config.ts:32`) et la configuration du
fixture de `daemon.test.ts`.

## Deux `saveState` concurrents partagent un unique fichier temporaire : état illisible et démon qui ne redémarre plus

**Gravité** : probable
**Où** : `src/state.ts:77-84`, appelé en concurrence depuis
`src/daemon.ts:402` et `src/daemon.ts:241`/`298`/`318`
(handlers de l'API, non sérialisés : `src/api.ts:54-125`)

Le nom du fichier temporaire est dérivé du seul chemin de destination, donc
constant pour tout le processus, et rien ne sérialise les écritures :

```ts
// state.ts:77-84
/** Écriture atomique : fichier temporaire puis rename, pour survivre à une coupure. */
export async function saveState(dataDir: string, state: RunnerState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, STATE_FILE);
  const tmp = `${file}.tmp`;                 // ← toujours state.json.tmp
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
```

Le commentaire est exact sur la coupure (un `rename` est atomique) et muet sur
le cas qu'il ne couvre pas : deux écritures simultanées. Elles sont
atteignables, parce que `createApi` (`api.ts:55`) sert les requêtes en
parallèle — aucun verrou, aucune file — et que chaque handler fait des
`await` d'entrées-sorties avant son `saveState`.

Scénario concret, sans la moindre coïncidence à la milliseconde : l'opérateur
remet deux tâches à zéro en parallèle, par exemple
`unused tasks reset a & unused tasks reset b` (ou la même chose depuis un
script de déploiement). Les deux requêtes `POST /tasks/<nom>/reset` entrent
dans `resetTask` :

```ts
// daemon.ts:397-406
const task = await this.findTask(name);        // ← readdir + readFile : rend la main
...
delete this.state.tasks[name];
await saveState(this.cfg.dataDir, this.state); // ← A et B peuvent se superposer ici
```

`findTask` relit tout `tasksDir` : A rend la main, B démarre, et les deux
`saveState` se retrouvent en vol en même temps. `writeFile` ouvre en
troncature, écrit, ferme ; `rename` suit. Comme A et B sérialisent l'objet
partagé à des instants différents (A peut encore contenir la tâche `b`, B
non), **les deux contenus n'ont pas la même longueur**. Un entrelacement
possible, et suffisant :

1. A ouvre `state.json.tmp` (troncature), B ouvre le même chemin (troncature).
2. A écrit 900 octets, ferme, et renomme `state.json.tmp` → `state.json`.
3. B écrit ses 700 octets sur **son** descripteur, qui désigne l'inode
   désormais nommé `state.json` : le fichier devient « 700 octets de B + les
   200 derniers octets de A ». `JSON.parse` échoue dessus (contenu après
   l'accolade fermante).
4. B renomme `state.json.tmp` → `state.json` : le chemin n'existe plus,
   `rename` rejette avec `ENOENT`. La commande `reset b` répond 500
   (`api.ts:120-122`) alors que la suppression a bien eu lieu en mémoire.

Dans tous les entrelacements où les deux écritures se superposent, l'un des
deux `rename` échoue en `ENOENT` et le contenu publié peut garder la queue de
l'écriture la plus longue. Conséquence au redémarrage suivant : `loadState`
(`state.ts:70-73`) refuse le fichier, `daemon.init()` rejette, et comme
`cli.ts:41` n'a aucun rattrapage, le processus meurt sur le `catch` global de
`cli.ts:177` — **le démon ne redémarre plus**, en boucle sous systemd, jusqu'à
réparation manuelle de `state.json`. Tous les curseurs de toutes les tâches
sont dans ce seul fichier, sans copie de secours (seul `index.jsonl` permet de
les reconstituer à la main, itération par itération).

Les mêmes couples existent entre une commande de l'API et l'ordonnanceur
(`iterate.ts:189` en fin d'itération, `scheduler.ts:79` en début de plage),
avec une fenêtre de superposition plus étroite. Je n'ai pas pu exécuter
l'entrelacement ici (pas de `node` dans le conteneur) : la concurrence des
handlers et le partage du chemin `.tmp` sont, eux, lisibles directement.

## `init()` écrit dans `state.json` avant de vérifier qu'aucun autre démon ne le possède

**Gravité** : à vérifier
**Où** : `src/cli.ts:41-44`, `src/daemon.ts:103-107`

L'ordre du démarrage met l'écriture avant le garde-fou :

```ts
// cli.ts:40-44
const daemon = new Daemon(cfg, { print: log });
await daemon.init();                    // ← peut écrire state.json
const server = createApi(cfg, daemon);
const sock = socketPath(cfg);
await listen(server, sock);             // ← refuse si un démon répond déjà
```

`init` écrit quand la plage enregistrée est expirée (`daemon.ts:103-107`).
Un second `unused daemon` lancé à la main pendant que le service tourne
réécrit donc `state.json` à partir de l'instantané qu'il vient de lire, puis
seulement après se voit refuser le socket par `listen` (`api.ts:55-56`, testé)
et meurt. Si le démon légitime a sauvé entre le `loadState` et le `saveState`
de l'intrus, l'écriture de l'intrus ramène l'état à l'instantané antérieur :
curseur et compteur d'itérations reculent d'un cran, sans trace.

La situation demande que la plage sur disque soit expirée alors que le démon
légitime vit encore — ce qui est le cas après une panne globale, puisque
`scheduler.ts:146-147` conserve volontairement `window` dans ce cas et que le
démon reste en vie sur son `fatal`. La fenêtre de recouvrement est en revanche
très courte, et je n'ai pas pu la provoquer ici : classé à vérifier. Le
correctif d'ordre (prendre le socket avant de toucher au fichier) est de toute
façon indépendant de la probabilité.

## Ce qui a été vérifié et tient

- **Le partage de `this.state` par référence** entre le démon, `runWindow` et
  `iterate` est sain : `resetTask`, `startWindow`, `stopWindow` et `setActive`
  mutent l'objet que l'itération en cours utilisera, et la prochaine écriture
  (`iterate.ts:189`) les persiste. Aucun chemin ne recharge le disque par
  dessus la mémoire une fois `init` passé.
- **`setActive` ne sauve pas** après son `ensureTaskState` (`daemon.ts:416`),
  et c'est sans conséquence : `ensureTaskState` est idempotent et rejoué par
  `iterate.ts:80` et `scheduler.ts:94` ; une entrée créée ou un curseur
  recalé en mémoire seulement sera recalculé à l'identique après un
  redémarrage. Même raisonnement pour le `ensureTaskState` d'`iterate.ts:80`
  lorsque l'itération est avortée et que `saveState` est sauté
  (`iterate.ts:189`).
- **L'abandon d'itération** (`aborted`) ne touche ni `ts` ni le disque :
  `applyOutcome`/`applyDecision` sont sous `if (!aborted)`
  (`iterate.ts:162-165`), donc rien de partiel n'est persisté.
- **Le garde de `resetTask`** (`daemon.ts:399`) empêche de supprimer l'entrée
  d'une tâche pendant son itération ; `iterate` garde une référence vers `ts`
  à travers ses `await`, mais le seul moment où l'entrée peut disparaître sous
  ses pieds est exclu par ce garde.
- **La plage expirée au démarrage** (`daemon.ts:103-107`) et l'arrêt explicite
  (`daemon.ts:218-222`) écrivent bien le `window = null` qu'ils décident, et
  sont couverts par `daemon.test.ts`.
- **L'édition externe de `state.json`** n'a pas d'autre auteur que le démon :
  la CLI est exclusivement cliente (`cli.ts:68-161`, toutes les commandes
  passent par l'API), et un second démon est refusé par `probe`. Une
  modification à la main pendant que le démon tourne est silencieusement
  écrasée à la prochaine écriture — c'est la propriété exclusive annoncée en
  `daemon.ts:72`, pas un défaut.
- **`loadState` sur fichier absent** rend `emptyState()` sans écrire
  (`state.ts:67`), et un JSON invalide est refusé bruyamment plutôt que
  silencieusement réinitialisé (`state.ts:70-73`) : c'est le bon choix, et
  c'est précisément ce qui rend le constat 2 bloquant.
