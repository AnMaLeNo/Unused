# 018 — Sortie définitive de la file (done/failed) : compteur d'échecs, `tasks activate`, reprise après « plus rien à faire »

**Fichiers examinés** : `src/graph.ts:60-153` (`applyOutcome`, `isEligible`,
`pickNext`, `applyDecision`), `src/daemon.ts:116-175` (`deadline`, `run`,
`idle`), `src/daemon.ts:177-243` (`execute`, `pauseUntil`, `unpause`),
`src/daemon.ts:397-418` (`resetTask`, `setActive`), `src/state.ts:42-59`,
`src/scheduler.ts:56-155`, `src/iterate.ts:72-190`, `src/cli.ts:68-161`,
`src/config.ts:33-42`, `src/daemon.test.ts:194-251`, `src/graph.test.ts:88-193`,
`README.md:88-120`
**Verdict** : 2 constats (2 sûrs)

Ni `node` ni `docker` ni `node_modules` ne sont disponibles dans ce conteneur :
tout ce qui suit est établi par lecture du code, en suivant les références
d'objets d'un appel à l'autre.

## Quand la dernière tâche sort de la file, la plage manuelle restante est jetée — et ni `activate` ni `reset` ne la ramènent

**Gravité** : sûr
**Où** : `src/daemon.ts:208-212`, `src/daemon.ts:223`, `src/daemon.ts:228-232`,
`src/daemon.ts:238-243`

Quand `pickNext` ne trouve plus personne (toutes les tâches `done`/`failed`, ou
la seule tâche vivante vient de créer son `DONE`), le scheduler termine la plage
en `nothing-eligible` (`scheduler.ts:88-93`) et `execute` réagit en posant une
pause :

```ts
// src/daemon.ts:208-212
} else if (this.lastWindow.endedBecause === "nothing-eligible") {
  // Rien à faire : inutile de relancer tant que la couverture dure. Un
  // start, un reset ou un activate lèvent la pause.
  await this.pauseUntil(this.deadline(run.manualUntil), "plus rien à faire");
}
```

Le commentaire dit l'intention : la plage n'est pas *terminée*, elle est *mise
en attente*, et `activate`/`reset` la relancent. Deux lignes plus loin, le
`finally` fait autre chose :

```ts
// src/daemon.ts:217-225
} finally {
  if (run.explicitStop && this.state.window) { ... }
  if (!run.ac.signal.aborted || run.explicitStop) this.manual = null;   // ← ici
  this.running = null;
}
```

Aucun abort n'a eu lieu (la plage s'est arrêtée d'elle-même), donc
`this.manual = null` : la **borne manuelle est perdue**. `runWindow` a par
ailleurs déjà effacé `state.window` sur disque (`scheduler.ts:147-148`,
`endedBecause !== "fatal"`), donc un redémarrage du service ne la retrouve pas
non plus (`init`, `daemon.ts:98-108`). La seule borne qui survit est la
couverture calendrier.

Ce qui reste pour relancer :

```ts
// src/daemon.ts:228-232
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;      // ← rien n'est écrit
  ...
// src/daemon.ts:238-243
private async unpause(): Promise<void> {
  if (this.state.pausedUntil === null) return;    // ← ni réveil, ni rien
  ...
  this.wake?.();
}
```

**Scénario A — `windows: []` (défaut de `config.ts:32`)**

1. `unused start --for 8h` à 21:00 ; une seule tâche, `audit`.
2. 21:20 — le skill dépose `/exchange/DONE`, `applyOutcome` passe la tâche à
   `status: "done"` (`graph.ts:85-88`), `applyDecision` rend la main.
3. Tour suivant : `pickNext` rend `null` → `nothing-eligible`. `pauseUntil`
   retourne aussitôt (`windows.length === 0`), donc `pausedUntil` reste `null`,
   et le `finally` efface `this.manual`.
4. Boucle `run` (`daemon.ts:145-154`) : `manualUntil = null`,
   `deadline(null)` → `ends` vide → `now`, `now > now` est faux → `idle()`.
   `nextCalendarStart()` rend `null`, donc `ms === null` et **aucun timer n'est
   armé** (`daemon.ts:163-165`) : le démon dort jusqu'à un `wake` explicite.
5. 21:30 — l'utilisateur prépare une deuxième tâche et lance
   `unused tasks activate blog`. `setActive` écrit `active: true`, puis
   `unpause()` **retourne à la première ligne** (`pausedUntil` est `null`) :
   pas de `this.wake?.()`.

Obtenu : la tâche `blog` est active, éligible, et ne tournera pas. Le démon
dort, `unused status` affiche `plage    aucune` alors que l'utilisateur a
demandé 8 h et qu'il en reste 7 h 30 de quota payé. Attendu : ou bien la plage
manuelle reste ouverte jusqu'à son terme et la nouvelle tâche part, ou bien
`activate` dit que plus aucune plage n'est en cours. Rien ne le signale : le
journal du démon dit `fin de plage (nothing-eligible)` comme pour une fin
normale.

**Scénario B — calendrier configuré, plage manuelle hors couverture**

Avec `windows: [{days:["mon"], from:"00:00", to:"13:00"}]` (la config livrée) et
`unused start --for 8h` le dimanche 21:00 : au `nothing-eligible` de 21:20,
`pauseUntil` écrit bien `pausedUntil = lundi 05:00`, et `this.manual` est
effacé. `unused tasks activate blog` appelle cette fois `unpause()` →
`pausedUntil = null` + `wake()`. La boucle se réveille, calcule
`deadline(null)` → `calendarEnd(dim 21:30)` = `coverageEnd([...], 21:30)` =
`null` (on est hors plage) → `now` → `idle()` de nouveau. Le réveil a lieu, et
il ne sert à rien : les 7 h 30 restantes sont perdues de la même façon. Le seul
cas où `activate`/`reset` relancent vraiment le travail est celui où l'instant
courant est **à l'intérieur** d'une plage calendrier — c'est exactement le seul
cas couvert par le test (`daemon.test.ts:194-221`, plage calendrier en cours,
levée par un `reset`).

La sortie de secours existe (`unused start --for …` repasse, `this.manual`
étant `null` la garde 409 de `startWindow` ne se déclenche pas), mais rien
n'indique à l'utilisateur qu'elle est nécessaire, et le commentaire du code
affirme le contraire.

## `setActive` peut réécrire le curseur d'une itération en vol ; `applyOutcome` relit `ts.cursor` au lieu du nœud qu'il a exécuté

**Gravité** : sûr
**Où** : `src/daemon.ts:416`, `src/state.ts:55-57`, `src/graph.ts:70`,
`src/graph.ts:89`, `src/iterate.ts:80-85`, `src/iterate.ts:164`

`setActive` appelle `ensureTaskState` avec la définition **fraîchement
relue** par `findTask` :

```ts
// src/daemon.ts:410-418
async setActive(name: string, active: boolean): Promise<void> {
  const task = await this.findTask(name);        // ← loadTasks(), def à jour
  ...
  ensureTaskState(this.state, task);
```

et `ensureTaskState` n'est pas un simple « garantir une entrée » : il **mute le
curseur** si le nœud n'existe plus dans la définition qu'on lui donne.

```ts
// src/state.ts:50-58
let ts = state.tasks[task.name];
if (!ts) { ts = initialTaskState(task); state.tasks[task.name] = ts; }
else if (!(ts.cursor in task.def.nodes)) { ts.cursor = task.def.start; }
return ts;
```

Or `this.state` est l'objet même que le démon passe au scheduler
(`daemon.ts:195`), que le scheduler passe à `iterate` (`scheduler.ts:98`), et
`ensureTaskState` rend `state.tasks[name]` **par référence** : le `ts` que
`iterate` garde pendant toute la session (`iterate.ts:80`, jusqu'à
`claude.timeoutMinutes`, 180 min par défaut) est le même objet. Une commande API
arrivant pendant l'itération écrit donc dans l'état de l'itération en cours.

Et à la fin de la session, `applyOutcome` ne se sert pas du nœud qu'`iterate` a
réellement exécuté (`nodeName`, figé ligne 84) : il relit le curseur.

```ts
// src/graph.ts:70,79,89
const node = ts.cursor;                      // ← relu, pas nodeName
ts.last = { at: …, node, outcome: label };
...
ts.cursor = task.def.nodes[node]!.next;      // ← `task` est la def d'AVANT
```

**Scénario concret.** Tâche `audit`, graphe `{setup, find, do}`,
`start: "setup"`, curseur sur `find`, une plage en cours.

1. 23:05 — l'itération sur `find` démarre ; la session durera 40 min.
2. 23:10 — l'utilisateur remanie son graphe : il renomme `find` en `choose` et
   met `"start": "choose"` dans `tasks/audit/task.json`. C'est le geste que le
   projet encourage (`scheduler.ts:53-54` : « modifier un task.json ou un skill
   pendant la plage est pris en compte », `README.md:74` : « tu peux les
   modifier entre deux itérations »).
3. 23:11 — il lance `unused tasks deactivate audit` pour travailler tranquille.
   `findTask` relit la **nouvelle** définition `{setup, choose, do}` ;
   `ts.cursor` vaut `find`, absent de cette définition, donc
   `ensureTaskState` écrit `ts.cursor = "choose"` — dans l'état de l'itération
   en vol. Rien n'est sauvegardé sur disque (`setActive` n'appelle pas
   `saveState`), mais la mémoire est déjà changée. À noter : `resetTask` refuse
   dans ce cas (`daemon.ts:399`, `ConflictError`), `setActive` n'a aucune garde
   équivalente.
4. 23:45 — la session se termine en `completed`. `iterate` appelle
   `applyOutcome(task, ts, …)` ligne 164, avec `task` = la définition
   **d'avant** (celle chargée au début de l'itération, `{setup, find, do}`).
   `applyOutcome` lit `node = ts.cursor = "choose"`, incrémente `iterations`,
   remet `consecutiveFailures` à 0, écrit `ts.last.node = "choose"` — puis
   évalue `task.def.nodes["choose"]` → `undefined` → **`TypeError: Cannot read
   properties of undefined (reading 'next')`** ligne 89.

Ce que ça coûte, en suivant la pile : l'exception part de `applyOutcome`
(`iterate.ts:164`), donc **avant** `commitTask` (ligne 170), **avant**
`saveState` (189) et **avant** `writeIterationLog` (217). Aucun `try` ne
l'attrape : celui de `iterate` ne couvre que `runInTask` (120-147), celui du
`catch` de commit ne couvre que le commit (172-183) ; `runWindow` appelle
`deps.runIteration` sans filet (`scheduler.ts:98`). Elle remonte jusqu'au
`catch` de `execute` (`daemon.ts:213-216`).

- 40 minutes de session `completed` **jamais commitées** : le container n'est ni
  commité ni jeté (`discardContainer` est dans la branche `else`, ligne 185), il
  reste sur l'hôte indéfiniment — `pruneTask` ne nettoie que les images sans
  tag, pas les containers.
- Aucune ligne dans `data/logs/` ni dans `index.jsonl` : l'itération, son coût
  et son quota consommé n'existent nulle part.
- L'état en mémoire garde `iterations + 1`, `consecutiveFailures = 0` et
  `ts.last = {node: "choose", outcome: "completed"}` pour une itération jetée —
  et ces valeurs seront persistées par le premier `saveState` suivant
  (`scheduler.ts:79`, au démarrage de la plage d'après).
- La plage entière meurt sur `plage interrompue par une erreur : Cannot read
  properties of undefined (reading 'next')`, et les plages automatiques sont
  mises en pause jusqu'à la fin de la couverture (`daemon.ts:216`) : la nuit y
  passe.

**Variante sans exception, même cause.** Si le nouveau `start` existe aussi
dans l'ancienne définition (l'utilisateur renomme `do` en `apply` et pose
`start: "do"`, curseur sur `find`), il n'y a pas de `TypeError` : le curseur
avance depuis un nœud qui n'a pas tourné. Le container **est** commité, et le
curseur désigne `task.def.nodes["do"].next` au lieu de
`task.def.nodes["find"].next` : une étape du graphe est sautée ou rejouée
silencieusement, et `ts.last.node` nomme un nœud que la session n'a pas
exécuté. Attendu dans les deux variantes : `applyOutcome` avance depuis le nœud
que l'itération a exécuté (`nodeName`, déjà calculé et déjà passé à `iterate`),
et `setActive` ne touche pas au curseur d'une itération en vol.

Le constat « `setActive` sur la tâche en cours d'itération ne fait pas dérailler
l'itération » de 006 (section « ce qui a été vérifié et tient ») ne regardait
que le champ `active`, relu au tour suivant ; c'est l'`ensureTaskState` de la
même méthode qui déraille.

## Ce qui a été vérifié et tient

- **Le compteur d'échecs est réellement « consécutif ».** `applyOutcome` le
  remet à 0 à chaque `completed` (`graph.ts:84`) et ne l'incrémente que sur
  `failure` (97) : ni `quota` (92) ni `fatal` (94) ne le nourrissent, et une
  itération `aborted` (`stop --now`, SIGTERM) ne passe même pas par
  `applyOutcome` (`iterate.ts:162-165`, décision forcée à `retry`, ni
  `applyDecision` ni `saveState`). Trois échecs comptés veulent donc bien dire
  trois échecs de suite sans succès intercalé : il n'y a pas de péremption à
  ajouter, seulement le fait — déjà instruit en 008 — qu'aucune commande ne
  remet `failed` à `running` sans détruire l'image de la tâche.
- Le seuil est cohérent avec ce qu'il annonce : compteur incrémenté *puis*
  comparé en `>=` (`graph.ts:97-98`), donc `maxConsecutiveFailures: 3` sort la
  tâche au 3ᵉ échec, ce que le scheduler imprime exactement
  (`scheduler.ts:132`) et ce que décrit `config.ts:39`.
- `isEligible` / `pickNext` excluent proprement une tâche `done` ou `failed`,
  sticky comprise : `eligible` est filtré avant la recherche de
  `state.currentTask` (`graph.ts:119-124`), donc une tâche qui sort de la file
  pendant qu'elle est collante n'est pas rechoisie, et `applyDecision` remet
  `currentTask` à `null` sur `task-done` comme sur `task-failed`
  (`graph.ts:141-146`). Une tâche sortie ne peut pas non plus atteindre
  `iterate` et lever son « rien à itérer » (`iterate.ts:81-83`) : `pickNext` est
  le seul chemin d'élection et il est synchrone avec `ensureTaskState`.
- `applyOutcome` n'avance pas le curseur sur un `completed + DONE`
  (`graph.ts:85-88`) : le curseur reste sur le nœud qui a produit `DONE`, ce qui
  est ce que `tasks list` affiche et ce que `reset` remet à `start`.
- Déjà rapporté ailleurs, non repris ici : `tasks activate` qui annonce
  « remise dans la file » une tâche `failed` et le fait que `reset` soit le seul
  remède au prix de l'image Docker (008) ; le rollback de `commitTask` qui ne
  restaure ni `consecutiveFailures` ni `ts.last` (005) ; le calcul trop lointain
  de `pausedUntil` sur `nothing-eligible` et l'absence d'écriture atomique de
  `task.json` par `setActive` (002, 006).
