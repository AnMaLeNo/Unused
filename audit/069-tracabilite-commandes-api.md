# 069 — Traçabilité des commandes de l'API

**Fichiers examinés** : `src/daemon.ts:62-69,96-113,177-250,282-425` (les
cinq commandes `startWindow`, `stopWindow`, `resetTask`, `setActive`,
`status`, et les seuls appels à `deps.print`), `src/api.ts` (entier),
`src/cli.ts:33-64,68-161` (le démon branche `print` sur `console.log`, la CLI
imprime chez le client), `src/scheduler.ts:56-156` (lignes de journal de la
plage), `src/iterate.ts:100-243` (lignes de journal de l'itération),
`src/log.ts` (entier : `index.jsonl`, le seul registre durable),
`src/state.ts:22-84` (`pausedUntil`, `window`), `src/client.ts:20-76`,
`src/docker.ts:250-254` (`removeTaskImages`), `src/daemon.test.ts` (aucune
occurrence de `print`), `unused.config.json`.

**Verdict** : 3 constats (3 sûrs)

Ni `node` ni `node_modules` ne sont présents dans ce conteneur : tout ce qui
suit est établi par lecture, en suivant les valeurs d'un appel à l'autre. Les
numéros de ligne sont ceux de la branche `audit`.

Le point de départ de l'angle. Le démon a **un seul récit de sa vie** : les
lignes passées à `deps.print`, branchées sur `console.log` par `cli.ts:40`,
donc le journal systemd. À côté, `data/logs/index.jsonl` (`log.ts:66`) est le
seul registre durable, et il ne contient **que** des itérations. Or
`grep -n "print" src/daemon.ts` ne donne aucune occurrence entre les lignes
282 et 425, c'est-à-dire dans toute la section `// --- commandes de l'API ---`,
et `src/api.ts` n'a ni logger ni accès à `deps.print` (son seul `console.error`,
ligne 121, est réservé aux 500). Conséquence structurelle : **aucune des cinq
commandes de l'API n'apparaît nulle part**, ni dans le journal, ni sur disque.
Les trois constats ci-dessous sont les endroits où cette absence rend le
journal ambigu ou contradictoire — pas la liste de tout ce qui manque.

## Une pause posée par `stop` n'est écrite nulle part : le silence du journal est ambigu

**Gravité** : sûr
**Où** : `src/daemon.ts:308-326` (écriture muette), `src/daemon.ts:228-236` (le seul message de pause existant)

Trois chemins écrivent `state.pausedUntil`, et un seul parle :

```ts
// daemon.ts:228-236 — le SEUL endroit qui imprime une pause
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;                       // ← sortie muette
  if (until.getTime() <= this.deps.now().getTime()) return;        // ← sortie muette
  this.state.pausedUntil = until.toISOString();
  await saveState(this.cfg.dataDir, this.state);
  this.deps.print(`plages automatiques en pause jusqu'à ${until.toISOString()} (${why})`);
}

// daemon.ts:316-318 — stopWindow écrit la même clé, sans un mot
const run = this.running;
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
await saveState(this.cfg.dataDir, this.state);
```

Scénario concret, avec la config du dépôt (`windows: [{days:["mon"], from:"00:00", to:"13:00"}]`).
Lundi 02:00, une plage automatique tourne ; l'opérateur lance `unused stop`.
`stopWindow` pose `pausedUntil = 13:00` (ligne 317), `run.stopRequested = true`,
et la plage se termine après l'itération en cours. Journal obtenu :

```
[02:14:03] itération 7 — refacto
  ...
  issue    completed → next-task (commit)

fin de plage (stopped) : 7 itérations, 5 completed, 1 échecs, 1 attentes quota, $3.41
```

...puis rien jusqu'à 13:00. Onze heures de plage automatique sautées, et le
journal ne contient **aucune trace de la décision** : pas de ligne `stop`, pas
de ligne de pause. Résultat attendu : la même ligne que `pauseUntil` émet dans
le cas symétrique (« plus rien à faire »), par exemple
`plages automatiques en pause jusqu'à …T13:00 (stop)`.

Le dommage n'est pas seulement l'absence : c'est que **le silence devient
ambigu**. Comme `pauseUntil` est le seul à imprimer, un lecteur du journal
apprend à interpréter « pas de ligne de pause » comme « pas de pause ». Or
après un `stop` il y a bien une pause, persistée dans `state.json` et qui
survit au redémarrage du service. L'opérateur qui relance le démon lundi à
04:00 pour une tout autre raison lit :

```
1 plage(s) automatique(s), prochaine le <lundi suivant>T00:00:00.000Z
```

`init` (ligne 109-112) affiche la prochaine plage *calculée en tenant compte de
la pause* (`nextCalendarStart`, ligne 130-135, part de `paused`), sans jamais
dire qu'une pause existe ni pourquoi la plage du jour est écartée : le démon
annonce la semaine prochaine comme si la plage de ce lundi n'avait jamais été
prévue. Seul un `unused status` au bon moment (`cli.ts:105`) révèle la pause —
et une fois 13:00 passé, `status` la filtre lui aussi (`daemon.ts:362`) : plus
aucune trace, nulle part, de ce qui a mangé la plage.

## La levée de pause est muette : le journal se contredit sans que rien n'explique l'écart

**Gravité** : sûr
**Où** : `src/daemon.ts:238-243` (`unpause`), `src/daemon.ts:296-299` (`startWindow`), appelés par `src/daemon.ts:405` et `src/daemon.ts:417`

```ts
// daemon.ts:238-243
private async unpause(): Promise<void> {
  if (this.state.pausedUntil === null) return;
  this.state.pausedUntil = null;
  await saveState(this.cfg.dataDir, this.state);
  this.wake?.();                                  // ← réveille la boucle, sans un mot
}
```

`startWindow` fait la même chose en ligne droite, et efface en plus la panne
globale :

```ts
// daemon.ts:296-299
this.manual = { until, resumed: false };
this.fatal = null;              // ← la PANNE annoncée ligne 207 est oubliée en silence
this.state.pausedUntil = null;
await saveState(this.cfg.dataDir, this.state);
```

Scénario concret. Lundi 00:00, la plage automatique s'ouvre ; à 00:05 plus
aucune tâche n'est éligible, donc `execute` passe par `pauseUntil` (ligne
208-212) et le journal dit la vérité :

```
nouvelle plage (calendar) jusqu'à 2026-10-19T13:00:00.000Z
plage jusqu'à 2026-10-19T13:00:00.000Z (13h)
plus aucune tâche éligible

fin de plage (nothing-eligible) : 0 itérations, 0 completed, 0 échecs, 0 attentes quota, $0.00
plages automatiques en pause jusqu'à 2026-10-19T13:00:00.000Z (plus rien à faire)
```

À 09:00 l'opérateur lance `unused tasks activate refacto`. `setActive`
réécrit le `task.json`, appelle `unpause()` (ligne 417), qui réveille
`idle()` ; la boucle recalcule `deadline()`, trouve la couverture calendaire
encore ouverte, et `execute` imprime :

```
nouvelle plage (calendar) jusqu'à 2026-10-19T13:00:00.000Z
```

Le journal contient donc, à neuf heures d'intervalle, « en pause jusqu'à
13:00 » puis « nouvelle plage » à 09:00, **sans une ligne entre les deux**.
Deux affirmations incompatibles et aucun fait pour les réconcilier : rien ne
dit qu'un `activate` est passé, ni quelle tâche a été touchée, ni que la pause
a été levée.

Ce n'est pas qu'un inconfort de lecture, parce qu'une autre cause produit
exactement la même paire de lignes : le constat 1 du rapport 002 (« une pause
qui expire au milieu d'une plage automatique fait sauter toute la fin de la
plage ») vit dans le même mécanisme, et une pause levée par un bug de calcul
produirait le même « nouvelle plage » surgi de nulle part. Le journal est donc
**incapable de distinguer une levée volontaire d'une levée accidentelle** —
précisément la question qu'on lui pose en post-mortem. Même remarque pour la
panne globale : la ligne 207 promet « plus rien ne tourne jusqu'à un
`unused start` », et son annulation (ligne 297) n'écrit rien ; la reprise
après panne ne se déduit qu'indirectement, de la ligne « nouvelle plage »
suivante.

## `reset` détruit état, sentinelle et images sans laisser une ligne ; la seule trace est le stdout du client

**Gravité** : sûr
**Où** : `src/daemon.ts:397-407`, `src/docker.ts:250-254`, `src/cli.ts:142-148`

```ts
// daemon.ts:397-407
async resetTask(name: string): Promise<{ start: string }> {
  const task = await this.findTask(name);
  if (this.running?.current?.task === name) throw new ConflictError(`${name} est en cours d'itération`);
  delete this.state.tasks[name];                                   // curseur, iterations, status, last
  if (this.state.currentTask === name) this.state.currentTask = null;
  await saveState(this.cfg.dataDir, this.state);
  await rm(path.join(task.exchangeDir, DONE_FILE), { force: true });
  await this.deps.removeTaskImages(name);                          // docker rmi -f …:latest …:prev + prune
  await this.unpause();
  return { start: task.def.start };
}
```

Quatre destructions irréversibles — l'entrée d'état (y compris le compteur
`iterations` et le `last`), la sentinelle `DONE`, les deux images Docker de la
tâche, et la pause (constat 2) — et pas un appel à `deps.print`. Le seul texte
produit l'est **chez le client**, par `cli.ts:147` :

```
refacto remise à zéro (curseur sur setup, image supprimée)
```

C'est-à-dire sur le terminal de l'opérateur, dans un processus qui s'arrête
juste après : rien n'en subsiste. Et d'après le constat 1 du rapport 006, cette
phrase affirme « image supprimée » même quand `docker rmi` n'a rien trouvé à
supprimer. La seule trace de la destruction est donc à la fois éphémère et
potentiellement fausse.

Scénario concret. Une tâche tourne depuis trois semaines, `iterations: 212`.
Mardi, l'opérateur fait `unused tasks reset refacto` depuis son poste. Lundi
suivant, la plage automatique s'ouvre et le journal donne :

```
nouvelle plage (calendar) jusqu'à …T13:00:00.000Z

[2026-10-26T00:00:11.004Z] itération 1 — refacto
tâche    refacto
nœud     setup (skill /setup)
```

`itération 1` est le compteur de la plage (`scheduler.ts:96`), mais la ligne
`curseur  setup` (`iterate.ts:228`) et le `status` qui affiche désormais
`0 itérations` racontent une tâche neuve. Rien, dans aucun fichier du dépôt de
données, ne dit que 212 itérations ont existé ni ce qui les a effacées :
l'opérateur qui enquête une semaine plus tard sur « pourquoi la tâche a-t-elle
recommencé du début ? » doit choisir entre un `reset` humain, la dérive de
curseur du rapport 044 (`ensureTaskState` renvoie au `start` quand le nœud a
disparu du graphe, `state.ts:55-57`) et une réécriture de `state.json`. Les
trois produisent le même journal. Le rapport 047 (constat 2) a noté que `reset`
ne touche ni `data/logs/<tâche>/` ni `index.jsonl` ; le point ici est
complémentaire et plus simple : **même en acceptant que les deux vies se
mélangent, aucun enregistrement ne marque la frontière**.

`setActive` est dans le même cas, avec une circonstance en plus : c'est la
seule commande qui **réécrit un fichier de l'utilisateur** (`daemon.ts:410-418`
réécrit `task.json` sur disque), et elle le fait sans ligne de journal. Un
`deactivate` retire définitivement une tâche de la file ; six semaines plus
tard, `status` affiche `inactive` sans date ni cause, et le `task.json` porte
un `active: false` dont la seule trace est l'horodatage du fichier.

## Ce qui a été vérifié et tient

- **Le cycle de vie de la plage et l'itération sont, eux, bien tracés.**
  `init` (lignes 102, 104, 111), `execute` (lignes 190, 207, 214), `pauseUntil`
  (235), `loadTasks` (278), `runWindow` (`scheduler.ts:80,91,96,118,126,132,151`)
  et `iterate` (`iterate.ts:90-93,113,220-229`) couvrent le démarrage, chaque
  itération, le coût, le quota, le curseur et la fin de plage. L'angle de ce
  rapport est l'écart entre cette densité et le silence complet de la section
  des commandes.
- **Une itération tuée par `stop --now` est tracée.** On pouvait craindre une
  itération commencée et jamais conclue dans le journal : non. `iterate`
  n'abandonne pas en cours de route, il va jusqu'à ses lignes 220-229 avec
  `issue    aborted → retry (jeté)` et écrit son fichier de log
  (`writeIterationLog`, ligne 217), même si `onEvent`/`runWindow` ne la
  comptent pas (`daemon.ts:260`, `scheduler.ts:100`). Le journal dit bien que
  le travail a été jeté.
- **Les 500 de l'API sont tracés** (`api.ts:121`, `console.error(err)`), avec la
  pile. Les 4xx (`HttpError`, `ConflictError`, `NotFoundError`) ne le sont pas,
  ce qui est défendable : ce sont des refus adressés au client, pas des
  incidents du démon. Les routes streamées (`docker build`/`check`) impriment
  chez le client sans rien laisser au démon ; leur défaut de code de sortie est
  déjà le constat 1 du rapport 009, non répété ici.
- **La branche `stopWindow` sans plage en cours** (`daemon.ts:309-315`) laisse
  `state.window` tel quel et ne pose pas de pause ; elle semble pratiquement
  inatteignable, `execute` posant `this.running` dans le même tour de boucle
  d'événements que la levée de `wake` (`run` → `execute` → ligne 188, aucun
  `await` intercalé). Rien de démontrable là, donc rien de rapporté.
- **Aucun test ne regarde le journal** : `grep -n "print" src/daemon.test.ts`
  ne renvoie rien, et les suites construisent le `Daemon` sans `print` (défaut
  `() => {}`, ligne 92). Les lignes existantes ne sont donc tenues par aucune
  assertion — à rapprocher du rapport 025.
