# 004 — Reprise au démarrage de la plage enregistrée (source, pause, until figé, panne)

**Fichiers examinés** : `src/daemon.ts:96-113` (`init`), `src/daemon.ts:115-158`,
`src/daemon.ts:177-250` (`execute`, `pauseUntil`), `src/daemon.ts:284-326`
(`startWindow`, `stopWindow`), `src/daemon.ts:328-373` (`status`),
`src/scheduler.ts:56-155`, `src/state.ts:178-240`, `src/iterate.ts:116-190`,
`src/graph.ts:60-105`, `src/cli.ts:35-64,86-111`, `deploy/unused.service`,
`src/daemon.test.ts:126-240`
**Verdict** : 3 constats (2 sûrs, 1 probable)

## Une plage *automatique* interrompue revient au démarrage déguisée en plage manuelle

**Gravité** : sûr
**Où** : `src/scheduler.ts:78`, `src/daemon.ts:98-108`

`runWindow` enregistre `state.window` pour **toutes** les plages, sans
distinguer leur origine :

```ts
// scheduler.ts:77-79
const startedAt = deps.now();
state.window = { startedAt: startedAt.toISOString(), until: until().toISOString() };
await saveState(cfg.dataDir, state);
```

`until()` vaut ici `this.deadline(run.manualUntil)`, c'est-à-dire le plus tard
entre la plage manuelle (souvent `null`) et la fin de couverture du calendrier.
Au démarrage suivant, `init` ne se pose pas la question de l'origine : tout
`state.window` non expiré devient une plage **manuelle** figée.

```ts
// daemon.ts:98-102
if (this.state.window) {
  const until = new Date(this.state.window.until);
  if (until.getTime() > this.deps.now().getTime()) {
    this.manual = { until, resumed: true };
```

Le champ `state.window` est pourtant documenté comme la plage manuelle
(`state.ts:180` : « Plage en cours (`run --for`), conservée pour reprendre après
un redémarrage »), et c'est bien ainsi qu'il est utilisé ensuite : `deadline()`
prend le max avec le calendrier, `source()` annonce `manual`.

Scénario concret, avec la config du dépôt (`windows: [{days:["mon"], from:"00:00", to:"13:00"}]`) :

1. Lundi 09:00, la plage automatique démarre seule. Disque :
   `window = { startedAt: "…09:00", until: "…13:00" }`.
2. 10:00, coupure de courant sur le Pi (ou `SIGKILL` après les
   `TimeoutStopSec=60` de `deploy/unused.service`). Le `finally` de `execute`
   ne tourne pas, `state.window` reste sur le disque.
3. 10:02, systemd relance (`Restart=always`). `init` affiche « plage
   interrompue trouvée, reprise jusqu'à 13:00 » et pose `manual`.
4. `unused status` annonce `plage manual+calendar, jusqu'à 13:00` (`source()`
   voit `manualUntil !== null`) alors que l'utilisateur n'a jamais lancé de
   `start`, et `startedAt` affiche 10:02 : `state.window.startedAt` est écrit
   mais n'est relu nulle part.
5. L'utilisateur édite `unused.config.json` pour raccourcir la plage à
   `to: "10:00"` et redémarre le service — seul moyen de recharger la config,
   lue une fois dans `daemonSetup()`. Attendu : plus aucune plage. Obtenu : la
   plage « manuelle » figée à 13:00 fait travailler le démon trois heures de
   plus, hors de toute plage configurée, parce que `deadline(manualUntil)`
   retourne `max(13:00, null)`.

La fin de plage d'origine calendaire est donc gelée au moment du crash et
survit à toute modification du calendrier, y compris à sa suppression complète.

## Un `stop` suivi d'un arrêt brutal relance la plage arrêtée et ignore la pause qu'il a posée

**Gravité** : sûr
**Où** : `src/daemon.ts:316-325` puis `src/daemon.ts:217-222`, `src/daemon.ts:96-108`

`stopWindow` rend la pause durable tout de suite, mais l'effacement de la plage
enregistrée — l'autre moitié de l'arrêt — n'a lieu que bien plus tard, dans le
`finally` de `execute` :

```ts
// daemon.ts:316-325
const run = this.running;
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
await saveState(this.cfg.dataDir, this.state);   // ← pausedUntil sur le disque
run.explicitStop = true;
if (now) { run.ac.abort(); return { stopping: "now" }; }
run.stopRequested = true;                         // ← l'itération continue
```

```ts
// daemon.ts:217-222
} finally {
  if (run.explicitStop && this.state.window) {
    this.state.window = null;                     // ← seulement ici
    await saveState(this.cfg.dataDir, this.state);
  }
```

Entre les deux, `shouldStop()` n'est consulté qu'en tête de boucle
(`scheduler.ts:83-87`) : l'itération en cours va jusqu'au bout, soit jusqu'à
`claude.timeoutMinutes` (180 par défaut dans `unused.config.json`). Pendant ces
trois heures au pire, le disque contient **à la fois** `window` et
`pausedUntil`.

Scénario :

1. Lundi 09:00, plage automatique en cours ; disque : `window.until = 13:00`.
2. 09:30, `unused stop`. Réponse : « arrêt demandé : la plage s'arrêtera après
   l'itération en cours ». Disque : `window.until = 13:00`,
   `pausedUntil = 13:00`.
3. 09:45, coupure de courant pendant l'itération.
4. Redémarrage à 09:50. `init` ne regarde jamais `pausedUntil` : il voit
   `until = 13:00 > now` et repose `manual`. Dans `deadline()`, `calendarEnd()`
   retourne bien `null` à cause de la pause…

```ts
// daemon.ts:123-128
private calendarEnd(now: Date): Date | null {
  if (this.fatal) return null;
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  if (paused && paused.getTime() > now.getTime()) return null;
```

   …mais `deadline(manualUntil)` prend le **max** des deux et `manualUntil`
   vaut 13:00 : la plage repart quand même.

Attendu : le démon reste au repos jusqu'à 13:00, comme il l'aurait fait sans
crash (le test `daemon.test.ts:168-192` vérifie exactement cela en mémoire).
Obtenu : il travaille jusqu'à 13:00, et `unused status` affiche les deux lignes
contradictoires `plage    manual, jusqu'à 13:00` et `pause    plages
automatiques ignorées jusqu'à 13:00`.

Le même trou existe, plus court, avec `stop --now` : `pausedUntil` est écrit,
puis `abort()` déclenche le `docker kill` et le retour de l'itération ; tant que
le `finally` n'a pas tourné, le disque décrit une plage arrêtée comme encore
vivante.

## La reprise saute les vérifications Docker que `start` impose

**Gravité** : probable
**Où** : `src/daemon.ts:284-301` contre `src/daemon.ts:96-113`

`startWindow` refuse de démarrer si Docker ne répond pas ou si l'image de base
manque — précisément pour ne pas enchaîner des itérations vouées à l'échec :

```ts
// daemon.ts:286-293
try { await this.deps.dockerVersion(); }
catch (err) { throw new ConflictError(`Docker ne répond pas : …`); }
if (!(await this.deps.imageExists(this.cfg.docker.baseImage))) {
  throw new ConflictError(`image de base ${…} absente : lance \`unused docker build\``);
}
```

`init` ne fait aucune de ces deux vérifications avant de reposer `manual`, et la
boucle `run()` enchaîne aussitôt sur `execute`. Si l'image de base est absente,
`docker run` échoue avec « Unable to find image … / pull access denied » : la
sortie ne correspond pas à `DOCKER_DOWN` (`iterate.ts:59-64`), donc pas de panne
globale — `classify` retourne `{ kind: "failure", reason: "unreadable_output" }`
(`graph.ts:45-52`), et `applyOutcome` incrémente `consecutiveFailures` puis
marque la tâche :

```ts
// graph.ts:96-102
case "failure": {
  ts.consecutiveFailures += 1;
  if (ts.consecutiveFailures >= opts.maxConsecutiveFailures) {
    ts.status = "failed";
    return "task-failed";
```

Scénario : migration du service sur une nouvelle machine (ou `docker image
prune -a`) alors que `data/state.json` contient une plage non expirée — le cas
même que la reprise est censée traiter. Au démarrage, la plage repart sans
image ; avec `maxConsecutiveFailures: 3` et `retrySeconds: 60`, chaque tâche est
passée à `status: "failed"` en environ deux minutes, puis `pickNext` ne trouve
plus rien et la plage se met en pause. Un `unused start` aurait répondu
« image de base absente : lance `unused docker build` » sans toucher à l'état.

Aggravant : une tâche `failed` n'est plus éligible (`graph.ts:107-110`) et
`setActive(name, true)` ne remet pas `status` à `running`
(`state.ts:206-215`) ; la seule sortie est `unused tasks reset`, qui appelle
`removeTaskImages(name)` et détruit donc l'image où s'accumulait le travail de
la tâche.

## Ce qui a été vérifié et tient

- L'expiration à la reprise est correcte et durable : `init` remet
  `state.window` à `null` **et** sauvegarde quand `until` est passé
  (`daemon.ts:103-107`), et `loadState`/`saveState` écrivent via
  fichier temporaire + `rename` (`state.ts:233-240`).
- L'arrêt propre (SIGTERM → `ac.abort()`) conserve bien la plage : `runWindow`
  ne nettoie pas `state.window` quand `signal.aborted` (`scheduler.ts:141-149`),
  `iterate` ne sauvegarde pas l'état d'une itération avortée
  (`iterate.ts:186`), et la reprise repart sur la même `until`
  (test `daemon.test.ts:127-141`).
- La reprise après **panne globale** est cohérente avec ce qui est annoncé :
  `runWindow` garde `state.window` quand `endedBecause === "fatal"`
  (`scheduler.ts:146-147`), `fatal` n'est qu'en mémoire, donc un redémarrage
  rejoue la plage une fois — comme le dit le message
  « ou un redémarrage du service une fois réparé » (`daemon.ts:207`).
- `deadline()` reste recalculée pendant une plage reprise : une plage
  automatique qui s'ouvre après la reprise la prolonge bien (`daemon.ts:196`,
  `scheduler.ts:83`).
- Pas de course entre la reprise et l'API : `daemon.init()` est terminé avant
  `listen()` (`cli.ts:42-45`), et `execute` pose `this.running` avant son
  premier `await`, donc un `stop` arrivant au démarrage ne peut pas tomber dans
  la branche « plage manuelle sans `running` » de `stopWindow`.
- Le chemin d'erreur (`execute` catch, `daemon.ts:213-216`) persiste bien
  `window: null` **quand un calendrier est configuré**, puisque `pauseUntil`
  sauvegarde l'état complet ; avec `windows: []` la remise à `null` reste en
  mémoire seule (`pauseUntil` sort en `return` dès la première ligne), ce qui ne
  se voit qu'au redémarrage suivant — plage abandonnée sur erreur mais reprise
  quand même. Trop dépendant d'un `saveState` ultérieur fortuit pour être
  chiffré ici, mais c'est le même défaut d'atomicité que le constat 2.
