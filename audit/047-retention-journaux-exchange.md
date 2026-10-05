# 047 — Rétention de `data/logs` et de `/exchange` : ce qui s'accumule, et ce qui arrive quand la carte ne prend plus d'écriture

**Fichiers examinés** : `src/log.ts` (entier), `src/iterate.ts:108-110`,
`src/iterate.ts:167-230`, `src/daemon.ts:96-113` (`init`),
`src/daemon.ts:137-158` (`run`), `src/daemon.ts:177-243` (`execute`,
`pauseUntil`, `unpause`), `src/daemon.ts:389-418` (`findTask`, `resetTask`,
`setActive`), `src/scheduler.ts:56-80` et `:141-155`, `src/state.ts:61-84`,
`src/api.ts:52-113` (table des routes), `src/cli.ts:34-64` et `:178-181`,
`src/dockerCheck.ts:49-53,105-111`, `src/docker.ts:130-150,166-185`,
`src/scaffold.ts:16-42,88-103`, `deploy/unused.service`,
`unused.config.json`, `README.md:100-128`, rapports antérieurs 002, 011, 014,
015, 017, 032, 036 (pour ne pas les redire).

**Verdict** : 3 constats (1 sûr, 1 probable, 1 à vérifier)

Trois faits de départ, chacun vérifiable d'un `grep`, qui cadrent l'angle :

1. **Rien ne tourne, rien ne purge, rien ne relit.** `logsDir` n'apparaît qu'à
   trois endroits : sa définition (`log.ts:37`) et les deux écritures
   (`log.ts:43` pour le dossier de la tâche, `log.ts:66` pour `index.jsonl`).
   Aucun `readdir`, `unlink`, `rm` ni `stat` ne porte sur `data/logs` dans tout
   le dépôt ; aucune route de l'API (`api.ts:57-113` : `status`, `window`,
   `tasks`, `tasks/<t>/reset`, `tasks/<t>/active`, `docker/build`,
   `docker/check`) ne le mentionne ; `unused.config.json` n'a aucune clé de
   rétention, alors qu'il en a une pour le seuil d'aplatissement des images
   (`flattenAfterLayers`). Le volume *par fichier* a déjà été traité en 015
   (`rawStdout` recopié en entier, `stderr` sans condition) : je ne le redis
   pas. Ce qui s'y ajoute ici, c'est que le **nombre** de fichiers croît d'une
   unité par itération, pour toujours, et pour toute tâche ayant jamais existé.
2. **Du côté `/exchange`, le démon n'efface qu'un seul nom**, `DONE`
   (`iterate.ts:110,181,186`, `daemon.ts:403`) ; le reste de ce que les
   sessions y déposent — « DONE, rapports… », dit `README.md:55` — reste sur
   l'hôte sans date de péremption. Que le rembobinage d'une itération ratée ne
   couvre pas `/exchange` est le constat 1 de 014 ; je n'y reviens pas.
3. **Le seul endroit où la croissance se retourne contre le programme est
   l'écriture qui échoue.** C'est de là que part le constat 1 : non pas du
   remplissage lui-même, mais de ce que le code fait quand `data/` répond
   `ENOSPC` — ou `EROFS`, cas très concret sur un Pi, le noyau remontant un
   ext4 en lecture seule dès qu'une carte SD usée renvoie des erreurs d'E/S.

## 1. Sur un `data/` qui refuse l'écriture, le gestionnaire d'erreur écrit lui aussi : le démon ne se met pas en pause, il meurt — et systemd le relance toutes les 5 s

**Gravité** : sûr (mécanisme entièrement lisible dans le code ; la condition
d'entrée est l'aboutissement de la croissance non bornée décrite ci-dessus)
**Où** : `src/daemon.ts:213-216` (le `catch`) avec `src/daemon.ts:228-236`
(`pauseUntil`), `src/daemon.ts:103-107` (`init`), et l'absence de tout
rattrapage de `src/daemon.ts:149` jusqu'à `src/cli.ts:178-181`

Le `catch` de `execute` est le seul filet de la chaîne. Il réagit à une
exception d'itération ou de plage en… écrivant sur le disque :

```ts
// src/daemon.ts:213-216
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
}
```

```ts
// src/daemon.ts:228-236
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;
  if (until.getTime() <= this.deps.now().getTime()) return;
  this.state.pausedUntil = until.toISOString();
  await saveState(this.cfg.dataDir, this.state);   // ← même disque, même erreur
  this.deps.print(`plages automatiques en pause jusqu'à ${until.toISOString()} (${why})`);
}
```

Quand la cause de l'exception est *persistante* — et un disque plein ou un
système de fichiers en lecture seule l'est — ce `saveState` échoue avec la même
erreur que celui qui a déclenché le `catch`. Le rejet part alors **de
l'intérieur du `catch`** : plus rien ne le rattrape. Le `finally` (217-225)
s'exécute (`run.explicitStop` est faux, donc sans écriture), puis l'exception
traverse la boucle `while` de `run` — `await this.execute(...)` en
`daemon.ts:149` n'a pas de `try`, seulement un `finally` en 155 — traverse
`cli.ts:59` (`await daemon.run(ac.signal)`, là aussi `try`/`finally` sans
`catch`) et atterrit dans :

```ts
// src/cli.ts:178-181
program.parseAsync().catch((err: Error) => {
  console.error(…);
  process.exit(err instanceof ApiError && err.status === 409 ? 3 : 1);
});
```

Le processus sort en code 1. Et l'unité de service est explicite :

```ini
# deploy/unused.service
Restart=always
RestartSec=5
```

**Scénario concret.** Pi, calendrier configuré (`windows` non vide — c'est le
cas documenté en `README.md:83-98`, et la condition exacte pour que
`pauseUntil` ne sorte pas en `return` dès sa première ligne), carte SD passée
en lecture seule au bout de quelques mois, pendant lesquels `data/logs` a
grossi d'un fichier par itération sans que rien ne le purge.

1. 23:00, la plage automatique s'ouvre. `run` voit `deadline() > now` et appelle
   `execute`, qui appelle `runWindow`.
2. Première chose que fait `runWindow`, avant toute itération :
   `state.window = {…}; await saveState(cfg.dataDir, state)`
   (`scheduler.ts:78-79`, aucun `try`). `writeFile` du fichier temporaire
   (`state.ts:82`) rejette `EROFS`.
3. Le rejet arrive dans le `catch` de `daemon.ts:213`, qui imprime « plage
   interrompue par une erreur : EROFS… », met `this.state.window = null` en
   mémoire, puis appelle `pauseUntil`.
4. `cfg.windows.length > 0` et `until > now` (la plage vient de s'ouvrir) :
   `pauseUntil` va jusqu'à son `saveState`, qui rejette `EROFS` à son tour.
5. Le démon sort en code 1. systemd le relance 5 s plus tard. `init()` relit
   `state.json` (la lecture, elle, marche), `pausedUntil` n'ayant jamais atteint
   le disque, `calendarEnd` rend toujours la fin de couverture, et on repart
   à l'étape 1.

**Obtenu** : une boucle de redémarrage toutes les 5 s jusqu'à 07:00, soit
environ 5 700 démarrages dans la nuit. Le socket n'existe que la fraction de
seconde qui sépare `listen` (`cli.ts:45`) du rejet, si bien que `unused status`
répond « démon injoignable » presque à coup sûr, et que la seule trace du
diagnostic est le `console.error` d'un processus qui meurt — dans journald,
c'est-à-dire sur la même carte. **Attendu** : exactement ce que le `catch`
prétend faire, et ce que 011 et 017 lui prêtaient — le démon reste vivant,
imprime l'erreur, met les plages automatiques en pause, et `unused status`
montre `pausedUntil` et `lastWindow`.

**Variante encore plus directe, et sans plage du tout** : si `state.json`
contient une plage manuelle expirée, `init` l'oublie *en écrivant* —

```ts
// src/daemon.ts:103-107
} else {
  this.deps.print("plage enregistrée expirée, oubliée");
  this.state.window = null;
  await saveState(this.cfg.dataDir, this.state);
}
```

— et `cli.ts:42` (`await daemon.init()`) précède `createApi`/`listen`
(43-45). Sur le même disque en lecture seule, le démon meurt donc **avant même
d'avoir créé son socket**, à chaque redémarrage, toutes les 5 s, sans qu'aucune
commande de la CLI ne puisse jamais lui parler. L'opérateur voit un service qui
« redémarre en boucle » et une CLI qui dit « démon injoignable » : rien ne
pointe vers le disque.

Ce que ce constat ajoute à 017 et 002, qui citent tous deux ce `catch` : 017
raisonne sur une erreur *transitoire* (`ENOENT` de `rename` entre deux
`saveState` concurrents) et conclut « la plage meurt, les plages automatiques
sont mises en pause » — ce qui suppose que le `saveState` de `pauseUntil`
réussisse ; 002 examine la branche où `pauseUntil` sort tôt
(`cfg.windows.length === 0`) et n'écrit donc rien. Le cas d'une erreur
d'écriture *durable* — celui vers lequel une rétention non bornée fait tendre
l'installation — n'est couvert par aucun des deux, et il ne dégrade pas le
service : il le supprime.

## 2. `reset` ne touche ni à `data/logs/<tâche>/` ni à `index.jsonl` : deux vies d'une même tâche se mélangent dans le seul registre de coût, et aucune commande ne peut les séparer

**Gravité** : probable
**Où** : `src/daemon.ts:397-407` (`resetTask`) face à `src/log.ts:42-67`

```ts
// src/daemon.ts:397-407
async resetTask(name: string): Promise<{ start: string }> {
  const task = await this.findTask(name);
  if (this.running?.current?.task === name) throw new ConflictError(…);
  delete this.state.tasks[name];                      // curseur, iterations, échecs
  if (this.state.currentTask === name) this.state.currentTask = null;
  await saveState(this.cfg.dataDir, this.state);
  await rm(path.join(task.exchangeDir, DONE_FILE), { force: true });  // DONE seul
  await this.deps.removeTaskImages(name);             // :latest et :prev
  await this.unpause();
  return { start: task.def.start };
}
```

`reset` remet à zéro tout ce qui *décide* (état, sentinelle, images) et rien de
ce qui *raconte*. Or le journal est indexé par le seul nom de la tâche, et ne
porte aucune notion de vie :

```ts
// src/log.ts:43-46
const dir = path.join(logsDir(cfg), rec.task);
…
const file = path.join(dir, `${stamp}-${rec.node}.json`);
```

```ts
// src/log.ts:49-66 — la ligne d'index
const line = { at, task: rec.task, node, outcome, done, decision, durationMs,
               costUsd, turns, model, fiveHour…, sevenDay…, file };
await appendFile(path.join(logsDir(cfg), "index.jsonl"), JSON.stringify(line) + "\n", "utf8");
```

Après un `reset`, `state.tasks[name].iterations` repart de 0 et le curseur de
`start`, tandis que `data/logs/<name>/` conserve tous les fichiers de la vie
précédente et `index.jsonl` toutes ses lignes. Les noms de fichiers
(`<horodatage>-<nœud>.json`) ne se distinguent que par l'heure, et la ligne
d'index ne contient rien — ni génération, ni numéro d'itération, ni identifiant
de vie — qui permette de trancher.

**Scénario concret.** Une tâche `review` a tourné trois semaines, puis son
graphe est repris : le nœud `do-review` devient `review-one`, et l'utilisateur
fait `unused tasks reset review` pour repartir proprement (c'est précisément ce
que la commande promet, `README.md:119`). Un mois plus tard il veut l'usage que
`README.md:100-107` vend explicitement — « le coût et le modèle sont dans
`data/logs/index.jsonl` : de quoi rapprocher un coût en dollars d'un
pourcentage de quota » — et somme `costUsd` sur `task == "review"`.

**Obtenu** : la somme des deux vies, celle qu'il a jetée et celle qu'il mesure,
sans aucun moyen de les séparer autrement qu'en retrouvant à la main l'heure du
`reset` (qui n'est consignée nulle part : `resetTask` n'écrit aucune ligne de
journal). **Attendu** : soit un `reset` qui archive ou purge l'historique de la
tâche, soit une ligne d'index qui distingue les vies.

Le cas se durcit avec le constat 1 de 032 (nom de tâche recyclé) : si le dossier
`tasks/review/` est supprimé puis qu'une tâche *différente* est créée plus tard
sous le même nom, elle hérite du dossier de journaux et des lignes d'index de la
précédente. Deux tâches sans rapport deviennent une seule série dans le seul
registre durable du programme — et comme `resetTask` commence par `findTask`
(`daemon.ts:398`), qui lève `NotFoundError` si le dossier n'existe plus, aucune
commande ne peut même tenter le ménage. Le volume, lui, ne redescend jamais :
les journaux des tâches mortes restent à leur place pour la durée de vie de
l'installation.

## 3. Une ligne d'index tronquée souderait deux enregistrements en un seul, définitivement

**Gravité** : à vérifier
**Où** : `src/log.ts:66`

```ts
await appendFile(path.join(logsDir(cfg), "index.jsonl"), JSON.stringify(line) + "\n", "utf8");
```

`appendFile` ouvre en `'a'` et confie l'écriture à la boucle de `writeAll` de
Node : une charge utile peut donc partir en plusieurs `write(2)`. Si l'un des
appels suivants échoue — `ENOSPC` sur un disque qui vient de se remplir, ce
qu'une rétention non bornée finit par produire — la fin de fichier reste une
ligne **tronquée, sans `\n`**. Comme aucune ligne n'est jamais relue ni
validée (constat de départ 1), personne ne le voit. Après libération de place,
l'`appendFile` suivant reprend à la position de fin de fichier et colle son
`{"at":…}` derrière le fragment : le fichier contient alors une ligne
inanalysable qui a avalé deux itérations, et elle y restera, puisque rien ne
réécrit ce fichier. Pour un lecteur strict (`jq -s` sur tout le fichier, un
tableur), c'est le registre entier qui devient illisible, non pas une entrée
qui manque.

Ce que je n'ai **pas** pu démontrer, et pourquoi le constat reste « à
vérifier » : qu'un `write(2)` partiel suivi d'un échec se produise réellement
ici. Sur ext4 avec allocation différée, `ENOSPC` est le plus souvent rendu dès
la réservation, donc sur une charge utile de l'ordre de 300 octets le cas
probable est le rejet complet (l'exception remonte alors dans le chemin déjà
décrit en 011), pas la troncature. Il n'y a pas de Docker ni de Node dans ce
container pour l'éprouver, et aucun test n'approche `index.jsonl`. Le point
reste que l'écriture de l'index n'a aucune des précautions prises pour
`state.json` — ni temporaire + `rename` (`state.ts:77-84`), ni relecture, ni
validation — alors que c'est le seul enregistrement durable du coût et du
quota.

## Ce qui a été vérifié et tient

- **`state.json` est à l'abri du disque plein, lui.** `saveState` écrit un
  temporaire puis `rename` (`state.ts:78-84`) : un `ENOSPC` laisse au pire un
  `state.json.tmp` partiel et jamais un `state.json` tronqué, et `loadState`
  continue de lire l'ancien. Le fichier de rétention zéro est le seul qui soit
  écrit proprement ; le reproche du constat 3 est exactement l'écart entre les
  deux.
- **`unused docker check` ne laisse rien derrière lui.** Son dossier
  d'échange est créé dans `dataDir` (`dockerCheck.ts:49-53`) et supprimé dans un
  `finally` avec les images et les containers de la pseudo-tâche
  (`dockerCheck.ts:105-111`), y compris quand un test échoue. Il ne passe pas
  par `writeIterationLog` : un `check` n'ajoute aucune ligne à `index.jsonl`.
- **Les noms de fichiers de journal ne peuvent pas se télescoper.**
  `stamp` vient de `rec.startedAt` en ISO à la milliseconde
  (`log.ts:45`) et les itérations sont strictement séquentielles
  (`scheduler.ts:83-99`, un seul démon par socket) : deux itérations de la même
  tâche ne peuvent pas partager un horodatage, donc `writeFile` n'écrase jamais
  un journal existant. (Le risque sur les noms de *nœuds*, qui ne sont pas
  validés et servent de nom de fichier, est le constat 2 de 011.)
- **Le `mkdir` couvre bien les deux écritures.** `mkdir(dir, { recursive: true })`
  en `log.ts:44` crée `data/logs/<tâche>/` *et* son parent, si bien que
  l'`appendFile` de `index.jsonl` (ligne 66) ne peut pas échouer sur un
  `data/logs` absent, même à la première itération d'une installation neuve.
- **Croissance en mémoire du démon : rien ne s'accumule au fil des
  itérations.** `run.live` et `lastWindow` sont des agrégats de taille fixe
  (`daemon.ts:57`, `scheduler.ts:8-16` — `WindowSummary` ne garde aucune liste
  d'itérations), et les trois écouteurs `abort` sont retirés systématiquement
  (`iterate.ts:140-143`, `daemon.ts:143/156`, `scheduler.ts:38-44`). L'angle
  « croissance non bornée » ne vaut que pour le disque, pas pour le processus —
  la mémoire d'une *session* est, elle, le sujet de 015.
- **`/exchange` ne fausse rien par sa seule accumulation.** Le démon n'y lit
  qu'un nom, `DONE` (`iterate.ts:151`), toujours précédé de son effacement
  (`iterate.ts:110`) ; les autres fichiers déposés par les sessions ne sont
  jamais ni lus ni listés côté hôte, et `runInTask` se contente de recréer le
  dossier s'il manque (`docker.ts:133`). Ce qui s'y entasse coûte de la place et
  revient dans le container de l'itération suivante (c'est le constat 1 de 014),
  mais ne trompe aucune décision du runner.
