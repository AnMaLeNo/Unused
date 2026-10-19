# 065 — Surface de diagnostic : ce que `status` montre, écrête ou cache

**Fichiers examinés** : `src/cli.ts:86-132` (`status`, `printTasks`, `tasks list`),
`src/daemon.ts:15-49` (`DaemonStatus`, `TaskInfo`), `src/daemon.ts:205-207`
(annonce de panne), `src/daemon.ts:245-274` (`source`, `onEvent`),
`src/daemon.ts:308-326` (`stopWindow`), `src/daemon.ts:328-387` (`status`,
`taskInfo`), `src/daemon.ts:420-424` (`describeWindow`), `src/scheduler.ts:8-16`
(`WindowSummary`), `src/scheduler.ts:104-137` (compteurs), `src/graph.ts:64-105`
(`applyOutcome`, étiquette `last`), `src/iterate.ts:140-186,219-236`
(construction de `fatal.detail`), `src/docker.ts:60-66,160-247`
(`mustSucceed`, `commitTask`, `pipeExportImport`), `src/log.ts:7-68`
(`IterationRecord`), `src/daemon.test.ts:60-262`, `README.md:108-121`.

**Verdict** : 5 constats (5 sûrs, dont 3 d'impact limité au diagnostic)

Ni `node` ni `node_modules` ne sont présents dans ce conteneur : tout ce qui suit
est établi par lecture du code, en suivant les valeurs d'un appel à l'autre. Les
numéros de ligne sont ceux de la branche `audit`.

## La ligne `PANNE` de `status` garde exactement la partie du message qui ne dit pas la cause

**Gravité** : sûr
**Où** : `src/cli.ts:94`, alimenté par `src/iterate.ts:176` et `src/docker.ts:65,243`

Le README désigne `status` comme l'endroit où l'opérateur apprend ce qui s'est
cassé :

> Deux pannes sont globales […] : le token refusé (401/403) et Docker
> injoignable. `status` l'affiche en tête ; réparer, puis `unused start`
> (`README.md:108-111`)

Or l'affichage ne garde que la **première ligne** du détail :

```ts
// src/cli.ts:94
if (s.fatal) console.log(`PANNE    ${s.fatal.reason} depuis ${s.fatal.at} : ${s.fatal.detail.split("\n")[0]}\n         plus rien ne tourne — …`);
```

Et le détail des pannes `docker` nées d'un échec de commande est, par
construction, un message dont la première ligne est un libellé et dont la cause
est sur les lignes suivantes :

```ts
// src/docker.ts:65
throw new DockerError(`${what} a échoué (docker ${args[0]}, code ${r.code}) :\n${r.stderr.trim()}`, r);
// src/docker.ts:243
else reject(new DockerError(`aplatissement a échoué :\n${Buffer.concat(errs).toString("utf8").trim()}`));
```

```ts
// src/iterate.ts:174-176
      if (!(err instanceof DockerError)) throw err;
      …
      outcome = { kind: "fatal", reason: "docker", detail: err.message };
```

**Scénario concret.** Pi à court d'espace disque, tâche dont l'image dépasse
`flattenAfterLayers` (30, `config.ts:27`). L'itération réussit (`completed`),
`commitTask` tague et commite, puis `layerCount > 30` déclenche `flattenTask`
(`docker.ts:174-176`) ; le `docker import` du pipe rend un code non nul avec
`write /var/lib/docker/…: no space left on device` sur stderr. `pipeExportImport`
rejette avec `DockerError("aplatissement a échoué :\n…no space left on device")`,
`iterate.ts:176` en fait la panne globale, le démon la mémorise
(`daemon.ts:206`).

L'opérateur tape `unused status` et lit, mot pour mot :

```
PANNE    docker depuis 2026-10-19T04:12:08.001Z : aplatissement a échoué :
         plus rien ne tourne — répare, puis `unused start` ou redémarre le service
```

Résultat obtenu : une panne globale annoncée par une phrase qui se termine sur
« : » et ne nomme ni le disque plein, ni quoi que ce soit d'autre — on ne sait
même pas que c'est un problème d'espace plutôt qu'un dockerd mal configuré.
Résultat attendu : la cause, ou au minimum les lignes suivantes indentées comme
le fait déjà `printTasks` pour les erreurs de tâche (`cli.ts:122`,
`e.message.replace(/\n/g, "\n            ")`).

Le journal du démon ne sauve pas la mise : les deux impressions qui le
remplissent coupent au même endroit (`iterate.ts:226` et `iterate.ts:234`,
`detail.split("\n")[0]`), et l'annonce de `execute` aussi (`daemon.ts:207`,
`this.fatal.detail.split("\n")[0]`). Le détail complet n'existe que dans
`status --json` (`cli.ts:92`, qui sérialise `s.fatal` entier) tant que le démon
vit, et — pour ce chemin-ci seulement — dans `data/logs/<tâche>/<stamp>-<nœud>.json`
via `rec.outcome` (`log.ts:32`, `iterate.ts:215`). Rien dans la sortie humaine
n'y renvoie. Sur les chemins `finishFatal` (`iterate.ts:145,232-236`) il n'y a
même pas de log d'itération (`logFile: null`, déjà relevé en `audit/023`) : la
troncature est alors la seule trace qui subsiste après un redémarrage.

À noter que le troisième chemin, `detail: r.stderr.trim()` sur dockerd absent
(`iterate.ts:158`), s'en sort : la première ligne de ce stderr est la phrase
utile (`Cannot connect to the Docker daemon…`). Le défaut ne touche que les
détails issus d'une `DockerError` de commande.

## `stop --now` ne pose jamais `stopping` : pendant l'agonie de la plage, `status` la décrit en bonne santé — tout en annonçant une pause jusqu'à son terme

**Gravité** : sûr
**Où** : `src/daemon.ts:308-326` et `src/daemon.ts:341`

Le seul champ machine qui porte « un arrêt a été demandé » est
`window.stopping`, recopié de `run.stopRequested` :

```ts
// src/daemon.ts:341
        stopping: run.stopRequested,
```

```ts
// src/daemon.ts:317-325
    this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
    await saveState(this.cfg.dataDir, this.state);
    run.explicitStop = true;
    if (now) {
      run.ac.abort();
      return { stopping: "now" };      // ← stopRequested reste faux
    }
    run.stopRequested = true;
```

La branche `--now` pose `explicitStop` (privé, jamais exposé) et abandonne `ac`,
mais **pas** `stopRequested`. Tant qu'`execute` n'a pas atteint son `finally`
(`daemon.ts:224`, `this.running = null`), `status` continue donc à décrire la
plage comme nominale : `stopping: false`, `until` et `remainingMs` recalculés sur
la deadline d'origine (`daemon.ts:337-339`), et `current` encore positionné —
`run.current` n'est remis à `null` qu'à l'événement `iteration-end`
(`daemon.ts:259`), c'est-à-dire après le retour d'`iterate`.

**Scénario concret.** Plage manuelle jusqu'à 18:00, itération en cours sur
`t1 / work`, il est 14:48. `unused stop --now` :

1. La CLI imprime `plage arrêtée` (`cli.ts:83`, `r.stopping === "now"`).
2. `iterate` reçoit l'abort : `killContainer`, le client `docker run` sort, puis
   `parseStream`, `writeIterationLog` (le JSON complet de la session, plusieurs
   Mo possibles, cf. `audit/015`) et `discardContainer` (`docker rm -f`, un
   aller-retour docker de plus). Sur le Pi visé, quelques secondes à quelques
   dizaines de secondes — et sans limite si le kill se perd (`audit/027`).
3. Pendant tout ce temps, `unused status` affiche :

```
plage    manual, jusqu'à 2026-10-19T18:00:00.000Z (3h12 restantes)
en cours t1 / work depuis 2026-10-19T14:31:02.004Z
pause    plages automatiques ignorées jusqu'à 2026-10-19T18:00:00.000Z
```

Résultat obtenu : trois lignes qui se contredisent — une plage qui court encore
3 h 12, une itération en cours, et une pause des plages automatiques jusqu'à
l'instant exact où cette plage « non arrêtée » finirait. Aucun « — arrêt
demandé », alors que l'arrêt gracieux, lui, l'affiche (`cli.ts:99`,
`w.stopping ? " — arrêt demandé" : ""`). Résultat attendu : `--now` marque la
plage comme en arrêt, exactement comme `stop` sans `--now`.

Distinct d'`audit/001` et d'`audit/027`, qui établissent que la *réponse*
`plage arrêtée` est fausse quand le kill se perd : ici le défaut est dans l'état
exposé, et il se produit même quand le kill réussit — aucune relecture de
`status` ne peut révéler qu'un arrêt a été demandé, puisque rien ne le porte.

## La ligne « dernière » perd les attentes quota : ses itérations ne s'additionnent plus

**Gravité** : sûr (impact : diagnostic)
**Où** : `src/cli.ts:106-109`

`WindowSummary` porte cinq compteurs (`scheduler.ts:8-16`). La plage en cours les
imprime tous (`cli.ts:100`), la plage passée en imprime quatre :

```ts
// src/cli.ts:108
      console.log(`dernière ${l.iterations} itérations, ${l.completed} completed, ${l.failures} échecs, $${l.costUsd.toFixed(2)} (${l.endedBecause})`);
```

`backoffs` disparaît, alors que `iterations` compte bien les itérations qui ont
fini en `backoff` (`scheduler.ts:101` incrémente avant le `switch`, pour toute
issue non abandonnée).

**Scénario concret.** Plage de 4 h ouverte alors que la fenêtre 5 h est déjà
saturée : deux itérations rendent un `rate_limit_event` `rejected`, chacune suivie
d'une attente jusqu'au reset annoncé, et la plage se termine sur sa deadline.
`summary` = `{iterations: 2, completed: 0, failures: 0, backoffs: 2, costUsd: 0}`.
`unused status` affiche :

```
dernière 2 itérations, 0 completed, 0 échecs, $0.00 (window)
```

Résultat obtenu : deux itérations qui ne sont ni des réussites ni des échecs et
dont rien ne dit où elles sont passées — la lecture naturelle est « ça a planté
sans rien dire ». Résultat attendu : la mention des deux attentes quota, comme
sur la ligne de la plage en cours, qui porte le même champ.

(Les autres pertes de cette même ligne sont ailleurs : `l.fatal` n'est pas
imprimé mais la ligne `PANNE` le couvre, et le fait que `lastWindow` disparaisse
à chaque redémarrage est le constat 1 d'`audit/021`.)

## `consecutiveFailures` est calculé, servi par l'API, et affiché nulle part

**Gravité** : sûr (impact : diagnostic)
**Où** : `src/daemon.ts:384` et `src/cli.ts:115-123`

`TaskInfo` expose `consecutiveFailures` et `start` (`daemon.ts:40-49`),
`taskInfo` les remplit (`daemon.ts:381-385`), l'API les sert sur `/status` et
`/tasks` — et `printTasks`, seul rendu humain des deux commandes, n'en montre
aucun :

```ts
// src/cli.ts:118-120
    const flag = !t.active ? "inactive" : t.status === "running" ? "active  " : t.status === "done" ? "done    " : "failed  ";
    const last = t.last ? `, dernier ${t.last.node} → ${t.last.outcome} (${t.last.at})` : "";
    console.log(`  ${flag}  ${t.name}  curseur ${t.cursor}, ${t.iterations} itérations${last}`);
```

**Scénario concret.** `maxConsecutiveFailures: 3` (`unused.config.json:30`). Une
tâche a échoué deux fois de suite sur `work` (`ts.consecutiveFailures === 2`,
`graph.ts:95-100`) : la prochaine issue non-`completed` la sort définitivement de
la file (`status = "failed"`, plus jamais éligible, `graph.ts:108-110`).

```
  active    t1  curseur work, 12 itérations, dernier work → unreadable_output (…)
```

C'est mot pour mot ce qu'affiche une tâche qui vient d'échouer pour la première
fois : `last` ne porte que la dernière issue, et le compteur qui dit « il reste
un essai » n'est imprimé nulle part. Résultat obtenu : le seul avertissement
avant la sortie définitive d'une tâche est invisible depuis la CLI ; il faut
`status --json` ou lire `state.json`. Résultat attendu : le compteur apparaît
dès qu'il est non nul.

Même remarque pour `start` : quand le curseur a été rabattu sur `start` parce que
le nœud enregistré a disparu du `task.json` (`daemon.ts:381`, `ts.cursor in
task.def.nodes`), l'affichage montre un curseur qui n'est pas celui de
`state.json` et rien ne distingue les deux cas (dérive déjà traitée en
`audit/044`).

## `describeWindow()` n'est appelé par personne

**Gravité** : sûr (impact : code mort)
**Où** : `src/daemon.ts:420-424`

```ts
  describeWindow(): string {
    const r = this.running;
    if (!r) return "aucune plage en cours";
    return `plage en cours, ${formatDuration(…)} restantes`;
  }
```

Une méthode publique, et aucun appelant : `grep -rn "describeWindow" src/` ne
rend que sa définition — ni `api.ts` (qui n'expose que `status`, `startWindow`,
`stopWindow`, `resetTask`, `setActive`), ni `cli.ts`, ni les tests. Elle est
aussi le seul usage de `formatDuration` dans `daemon.ts` : l'import de la ligne 5
ne sert qu'à du code mort. Sans conséquence à l'exécution, mais c'est une
deuxième formulation de « combien de temps reste-t-il » qui ne passe pas par
`remainingMs` (elle n'écrête pas, `formatDuration` le fait pour elle) et qui
divergera silencieusement de celle de `status` à la première évolution.

## Ce qui a été vérifié et tient

- **`remainingMs` écrêté à 0** (`daemon.ts:339`, `Math.max(0, …)`) ne ment pas :
  quand une itération déborde la deadline (`audit/030`), `status` affiche
  `0s restantes` et la plage toujours en cours, ce qui est exactement l'état.
  `formatDuration` écrête de son côté (`duration.ts:104`), testé
  (`duration.test.ts:24`).
- **`...run.live` ne masque ni ne duplique rien** : les cinq clés de `live`
  (`daemon.ts:57`) et les cinq champs correspondants de `DaemonStatus.window`
  (`daemon.ts:22-27`) coïncident, aucune ne collisionne avec `stopping`,
  `source`, `until` ou `startedAt` posés avant le spread (`daemon.ts:336-345`).
  La cohérence des compteurs eux-mêmes est le périmètre d'`audit/021`.
- **`taskErrors` est bien exposé et bien rendu** : `status()` renvoie les erreurs
  de chargement (`daemon.ts:371`), `printTasks` les imprime avec les lignes
  suivantes indentées (`cli.ts:122`), et `tasks list` en fait un code de sortie
  (`cli.ts:131`). Seule asymétrie relevée, sans conséquence démontrable :
  `status` sort en 0 même sous `PANNE` ou avec des tâches invalides, alors que
  `tasks list` sort en 1 — un superviseur qui appelle `status` doit parser le
  texte.
- **`status` ne mute pas l'état** : `taskInfo` lit `this.state.tasks[name]` sans
  passer par `ensureTaskState` (`daemon.ts:376-386`), donc une consultation
  pendant une itération ne réécrit ni curseur ni `state.json` ; `loadTasks` y est
  appelé en lecture seule (`daemon.ts:329`). `probe()` tape `/status` à chaque
  démarrage (`api.ts:130`) sans autre effet qu'un `loadTasks`.
- **`pausedUntil` est filtré sur l'instant présent** (`daemon.ts:362`) : une
  pause expirée n'est pas affichée, et `nextCalendarStart` part bien de la fin de
  pause (`daemon.ts:132-134`), cohérent avec le minuteur d'`idle` (`daemon.ts:163`).
  La *raison* de la pause n'est en revanche nulle part : `pauseUntil(…, why)`
  l'imprime dans le journal (`daemon.ts:235`) et ne la garde pas, donc `status`
  ne distingue pas « pause posée par un `stop` » de « plus rien à faire ». Pas de
  scénario d'échec à l'appui : les deux cas se lèvent de la même façon.
- **`last.outcome` affiché tel quel** (`cli.ts:119`) reprend l'étiquette de
  `applyOutcome` (`graph.ts:70-78`), sans saut de ligne possible. Les mensonges
  de cette étiquette après un rollback de commit sont déjà documentés
  (`audit/005`, `audit/011`, `audit/018`).
