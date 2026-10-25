# 074 — Après-coup d'une plage tuée par une exception

**Fichiers examinés** : `src/daemon.ts:177-226` (`execute`, son `try/catch/finally`),
`src/daemon.ts:228-236` (`pauseUntil` et ses deux sorties prématurées),
`src/daemon.ts:115-135` (`deadline`, `calendarEnd`, `nextCalendarStart`),
`src/daemon.ts:96-113` (`init`, la reprise), `src/daemon.ts:284-326`
(`startWindow`, `stopWindow`), `src/daemon.ts:328-373` (`status`),
`src/daemon.ts:245-274` (`source`, `onEvent`), `src/scheduler.ts:56-156`
(les deux `saveState` de la plage, l'absence de `try` autour de
`runIteration`), `src/iterate.ts:144-147,172-190,217` (ce qui peut lever),
`src/cli.ts:35-64` (le démon et son SIGTERM), `src/cli.ts:86-111`
(l'affichage de `status`), `src/state.ts:22-33,77-84`,
`src/daemon.test.ts:20-44,89-140`, `unused.config.json`, et les rapports
antérieurs `002`, `011`, `018`, `021`, `070`, `072`.

**Verdict** : 2 constats (1 sûr, 1 probable). Les trois défauts que le registre
annonçait pour cet angle sont déjà consignés mot pour mot ailleurs (voir la
dernière section) ; les deux constats ci-dessous sont les cas que ces rapports
avaient explicitement mis **hors** de leur périmètre, et le premier contredit
une limite qu'ils affirment tous les deux.

Ni `node`, ni `node_modules` dans ce conteneur : tout ce qui suit est établi par
lecture, en suivant les valeurs d'un appel à l'autre. Les numéros de ligne sont
ceux de la branche `audit`.

Le cadre. Sur le chemin d'erreur, deux écritures disputent le même champ :

```ts
// src/daemon.ts:213-225
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;                                        // ← mémoire seule
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");  // ← seul saveState du catch
} finally {
  if (run.explicitStop && this.state.window) {
    // Arrêt explicite : on ne reprendra pas cette plage au prochain démarrage.
    this.state.window = null;
    await saveState(this.cfg.dataDir, this.state);                  // ← seul saveState du finally
  }
  if (!run.ac.signal.aborted || run.explicitStop) this.manual = null;
  this.running = null;
}
```

Le `catch` vide `this.state.window` **avant** que le `finally` ne le lise. Le
garde `&& this.state.window` est donc toujours faux après une exception : sur ce
chemin, le `saveState` du `finally` est inatteignable, quelle que soit la valeur
de `run.explicitStop`. Reste celui de `pauseUntil`, lui-même gardé deux fois :

```ts
// src/daemon.ts:228-234
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;                  // (A)
  if (until.getTime() <= this.deps.now().getTime()) return;   // (B)
  this.state.pausedUntil = until.toISOString();
  await saveState(this.cfg.dataDir, this.state);
```

La sortie (A) est le constat 1 de `070` et le constat 4 de `002`, tous deux
conclus par « avec un calendrier non vide, la même erreur oublie bien la
plage ». C'est la sortie (B) qui rend cette conclusion fausse.

## Un `stop` gracieux suivi d'une exception : la plage reste sur disque et repart au prochain démarrage

**Gravité** : sûr
**Où** : `src/daemon.ts:213-222` (l'ordre des deux écritures),
`src/daemon.ts:232` (sortie B), `src/daemon.ts:317` et `src/daemon.ts:123-128`
(la pause que `stopWindow` vient de poser), `src/daemon.ts:116-121` (`deadline`)

Pour une plage **purement calendrier** — `run.manualUntil === null`, cas normal
d'une plage automatique (`daemon.ts:146,149`) — `stopWindow` commence par écrire
la pause, puis marque l'arrêt explicite :

```ts
// src/daemon.ts:316-325
const run = this.running;
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
await saveState(this.cfg.dataDir, this.state);
run.explicitStop = true;
if (now) { run.ac.abort(); return { stopping: "now" }; }
run.stopRequested = true;                 // ← arrêt gracieux : pas d'abort
return { stopping: "after-iteration" };
```

`stopRequested` n'est consulté qu'au **tour suivant** de la boucle du scheduler
(`scheduler.ts:84-87`) : l'itération en cours, elle, continue jusqu'à son terme
ou jusqu'à `claude.timeoutMinutes` (180 min dans `unused.config.json`). Si elle
lève, on arrive dans le `catch`, et `deadline(null)` n'a plus aucune borne :

```ts
// src/daemon.ts:123-128
private calendarEnd(now: Date): Date | null {
  if (this.fatal) return null;
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  if (paused && paused.getTime() > now.getTime()) return null;   // ← la pause de stopWindow
  return coverageEnd(this.cfg.windows, now);
}
```

`calendarEnd` rend `null` (la pause qu'on vient d'écrire est dans le futur),
`manualUntil` est `null`, donc `ends` est vide et `deadline` rend `now`
(`daemon.ts:120`). `pauseUntil` sort alors en (B) sans écrire. Et le `finally`
ne peut pas compenser, puisque `this.state.window` est déjà `null` en mémoire.
**Aucune des deux écritures n'a lieu** : le disque garde la plage telle que
`runWindow` l'a enregistrée à son démarrage (`scheduler.ts:78-79`).

Scénario concret, avec la configuration livrée (`unused.config.json` :
`mon 00:00 → 13:00`) :

1. lundi 02:00 — la plage automatique tourne ; `state.json` contient
   `window: { startedAt: "02:00", until: "13:00" }`.
2. lundi 02:05 — `unused stop`. Réponse « arrêt demandé : la plage s'arrêtera
   après l'itération en cours » (`cli.ts:83`). `pausedUntil` = lundi 13:00,
   écrit sur disque.
3. lundi 02:40 — l'itération en cours lève : `saveState` ou
   `writeIterationLog` sur disque plein (`iterate.ts:189`, `iterate.ts:217`),
   `EACCES` sur `data/logs`, ou toute erreur non-`DockerError` relancée par
   `iterate.ts:173`. `runWindow` n'entoure pas `runIteration` d'un `try`
   (`scheduler.ts:98`) : l'exception arrive dans le `catch` d'`execute`.
4. Le démon imprime « plage interrompue par une erreur : … », repasse en `idle`.
   `unused status` : `plage aucune`, `pause plages automatiques ignorées
   jusqu'à lundi 13:00` (`cli.ts:97,105`). Cohérent avec un arrêt demandé.
5. L'opérateur fait de la place et redémarre le service à 03:00 — c'est la
   réaction attendue, le journal vient d'annoncer un disque plein.
   `init` relit `state.json`, trouve `until` = 13:00 > maintenant, et repart :

   ```ts
   // src/daemon.ts:98-102
   if (this.state.window) {
     const until = new Date(this.state.window.until);
     if (until.getTime() > this.deps.now().getTime()) {
       this.manual = { until, resumed: true };
       this.deps.print(`plage interrompue trouvée, reprise jusqu'à ${until.toISOString()}`);
   ```

Obtenu : dix heures de plage repartent, alors que l'utilisateur les avait
arrêtées à la main et que le commentaire de `daemon.ts:219` promet le contraire
(« Arrêt explicite : on ne reprendra pas cette plage au prochain démarrage »).
Pire, la plage reprise est **manuelle** (`daemon.ts:101`), donc elle ignore la
pause : `deadline(13:00)` vaut `max(13:00, null)` = 13:00. `status` affiche
alors les deux lignes contradictoires côte à côte —
`plage manual, jusqu'à 13:00` et `pause plages automatiques ignorées jusqu'à
13:00` — pour une plage qui n'a jamais été manuelle et que personne n'a
redemandée. Attendu : la plage arrêtée reste arrêtée, comme sur le chemin
`stop --now`, qui passe par `run.explicitStop` et écrit bien `window: null`
(couvert par le test `src/daemon.test.ts:116-124`).

Portée exacte des trois cas, pour corriger la limite annoncée par `002` et
`070` :

| configuration au moment de l'erreur | `pauseUntil` | plage oubliée sur disque ? |
| --- | --- | --- |
| `windows: []` (défaut du schéma, `config.ts:32`) | sort en (A) | non — constat de `070`/`002` |
| calendrier + borne manuelle encore future | écrit | oui, chemin sain |
| calendrier seul **après un `stop` gracieux** | sort en (B) | **non** — ce constat |

Aucun test ne couvre le chemin d'erreur (`src/daemon.test.ts` n'a pas de
`runWindow` factice qui lève).

## Une exception concomitante d'un SIGTERM oublie la plage que l'arrêt du service promet de reprendre

**Gravité** : probable
**Où** : `src/daemon.ts:215` contre `src/scheduler.ts:141-143` et `src/cli.ts:53`

Le chemin d'abandon par signal est construit pour **conserver** la plage :

```ts
// src/scheduler.ts:141-143
if (signal.aborted) {
  summary.endedBecause = "stopped";
  // La plage reste enregistrée : le démon la reprendra au prochain démarrage.
}
```

et le démon l'annonce à l'opérateur : « SIGTERM reçu : arrêt (l'itération en
cours est jetée, la plage sera reprise au prochain démarrage) » (`cli.ts:53`),
propriété figée par le test `src/daemon.test.ts:126-140`.

Le `catch` d'`execute`, lui, ne regarde pas `run.ac.signal.aborted` : il efface
`state.window` inconditionnellement (`daemon.ts:215`). Il suffit donc qu'une
exception et l'abort tombent dans la même itération pour que la plage soit
oubliée au lieu d'être conservée — et là, contrairement au constat précédent,
`pauseUntil` écrit bien : avec un calendrier et une borne manuelle encore
future, `deadline` est dans le futur, donc `window: null` est **persisté**.

Scénario : `unused start --for 8h` à 22:00 avec un calendrier non vide. À 23:30,
`data/` est plein ; l'opérateur lance `systemctl restart unused` pendant que
l'itération en cours échoue sur son `writeIterationLog` (`iterate.ts:217`). Le
SIGTERM pose `run.ac.abort()` (`daemon.ts:139-142`) ; l'exception, elle, remonte
dans le `catch`, qui vide `window` et sauve via `pauseUntil`. Au redémarrage,
`init` ne trouve plus rien : les 6 h 30 restantes sont perdues, après que le
démon a imprimé qu'elles seraient reprises.

Classé **probable** et non sûr parce qu'il faut les deux événements dans la même
itération : l'enchaînement est déterministe par lecture, mais je n'ai pas pu le
provoquer ici (pas de `node`). À noter que la cause d'erreur la plus plausible
sur ce chemin — un disque plein — est précisément celle qui pousse l'opérateur à
redémarrer le service à ce moment-là.

## Ce qui a été vérifié et tient

Les trois défauts annoncés par le registre pour cet angle sont réels et déjà
consignés ; inutile d'y revenir :

- **« résumé périmé donné pour le dernier »** — `this.lastWindow` n'est affecté
  que par la résolution de `runWindow` (`daemon.ts:192`), donc le `catch` laisse
  en place le résumé de la plage *précédente*, que `status` renvoie
  (`daemon.ts:369`) et que la CLI étiquette « dernière » (`cli.ts:106-109`), avec
  son `endedBecause: "window"` rassurant. C'est le constat 2 de **`021`**
  (gravité sûr), scénario et conséquences compris (`run.live` jeté avec le
  `Running` en `daemon.ts:224`, consommateurs `--json` inclus). Vérifié de
  nouveau ici : aucune autre affectation de `lastWindow` dans `src/`, et
  `this.fatal` reste `null` sur ce chemin (déjà noté par **`011`**).
- **« window non persisté »** — sortie (A) de `pauseUntil` : constat 1 de
  **`070`** (sûr) et constat 4 de **`002`** (probable). Le présent rapport n'y
  ajoute que la sortie (B) et le garde mort du `finally`.
- **« plage manuelle abandonnée sans trace »** — `daemon.ts:223` remet
  `this.manual` à nul dès que le signal n'est pas levé, donc une borne manuelle
  de plusieurs heures disparaît sur la première exception, sans compteur d'échec
  (la tâche fautive ne sort jamais de la file) et sans trace ailleurs que dans le
  journal du service. Le jumeau de ce chemin — même `finally`, déclencheur
  `nothing-eligible` — est le constat 1 de **`018`** (sûr), et l'escalade
  « exception d'une itération → plage de tout le monde » est cartographiée par
  **`072`**, qui en attribue déjà chaque déclencheur.
- **La pause posée par le `catch` dépasse la couverture en cours** (`deadline`
  = `max(manuel, calendrier)`, `daemon.ts:216`), et une pause qui expire au
  milieu d'une plage automatique fait sauter toute la fin de cette plage :
  constat 1 de **`002`** (sûr), qui cite nommément l'entrée « erreur ».

Vérifié sans rien trouver de neuf :

- **La variante « débordement » de la sortie (B)**, sans `stop` : une itération
  d'une plage calendrier qui dépasse la fin de couverture (12:30 + 180 min de
  timeout) et lève à 15:30. `deadline(null)` rend `now`, `pauseUntil` sort en
  (B), la plage reste sur disque — mais son `until` (13:00) est alors **déjà
  passé**, donc `init` prend la branche d'expiration, imprime « plage
  enregistrée expirée, oubliée » et écrit `window: null` (`daemon.ts:103-107`).
  Le cas se répare de lui-même : aucune reprise fantôme, rien à signaler.
- **La divergence mémoire/disque ne se propage pas plus loin dans le processus.**
  Après le `catch`, toute écriture ultérieure de `state.json` repart de l'objet
  en mémoire, où `window` vaut `null` : un `tasks reset` (`daemon.ts:402`), un
  `start` (`daemon.ts:298`) ou la plage suivante (`scheduler.ts:79`) effacent la
  plage fantôme. La fenêtre de risque est exactement « démon au repos jusqu'au
  prochain démarrage », celle des deux constats ci-dessus.
- **`status` pendant le déroulement du `catch`** : `this.running` n'est remis à
  `null` que dans le `finally` (`daemon.ts:224`), donc une requête servie pendant
  le `await pauseUntil` voit encore la plage et ses compteurs. L'écart dure le
  temps d'un `saveState` et la valeur affichée est celle qui était vraie une
  milliseconde plus tôt : pas un mensonge sur l'état.
- **Le `source` de la plage reprise** (`manual` pour une plage calendrier
  interrompue, `daemon.ts:101`) est déjà signalé en fin de **`021`** comme hors
  périmètre ; je m'y appuie dans le constat 1 sans le recompter.
- **`startWindow` reste utilisable après l'erreur** : `this.manual` et
  `this.running` sont tous deux nuls, donc le garde de conflit
  (`daemon.ts:285`) laisse passer, et `startWindow` remet `fatal` et
  `pausedUntil` à zéro avant de sauver (`daemon.ts:296-298`). Un `unused start`
  relance donc proprement, y compris dans les deux scénarios ci-dessus — c'est
  le seul rattrapage, et il suppose que l'opérateur ait lu le journal.
