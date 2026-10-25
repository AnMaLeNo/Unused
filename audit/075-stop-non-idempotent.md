# 075 — src/daemon.ts stopWindow + calendarEnd : angle réentrance

**Fichiers examinés** : `src/daemon.ts:115-135` (`deadline`, `calendarEnd`,
`nextCalendarStart`), `src/daemon.ts:137-158` (boucle `run`),
`src/daemon.ts:177-243` (`execute`, `pauseUntil`, `unpause`),
`src/daemon.ts:303-326` (`stopWindow`), `src/daemon.ts:328-373` (`status`),
`src/scheduler.ts:56-156` (`runWindow`), `src/calendar.ts:56-78`,
`src/api.ts:54-70` (routage, absence de sérialisation),
`src/cli.ts:34-84` (`daemon`, `stop`), `src/config.ts:14-20`
(`claude.timeoutMinutes`), `src/daemon.test.ts:98-125,168-193`
**Verdict** : 1 constat (sûr)

Aucun runtime Node dans ce container (`node`, `npx`, `node_modules` absents) :
le constat est établi par lecture, en suivant pas à pas les valeurs lues et
écrites. Les conséquences *d'un seul* `stop` (affichage `source: "manual"`,
`remainingMs: 0`, `endedBecause: "window"`) sont déjà au rapport 042 et ne sont
pas redites ici ; ce rapport porte sur ce que fait le **deuxième** appel.

## Un second `stop` pendant la même plage écrase par `now` la pause que le premier avait posée, et le calendrier redémarre aussitôt

**Gravité** : sûr
**Où** : `src/daemon.ts:317` (valeur écrite), via `src/daemon.ts:116-128`

`stopWindow` calcule l'horizon de pause avec `deadline`, et `deadline` ne sait
agréger que des bornes non nulles :

```ts
// src/daemon.ts:116-128
private deadline(manualUntil: Date | null): Date {
  const now = this.deps.now();
  const calendar = this.calendarEnd(now);
  const ends = [manualUntil, calendar].filter((d): d is Date => d !== null).map((d) => d.getTime());
  return ends.length > 0 ? new Date(Math.max(...ends)) : now;   // ← aucune borne : now
}

private calendarEnd(now: Date): Date | null {
  if (this.fatal) return null;
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  if (paused && paused.getTime() > now.getTime()) return null;   // ← la pause muselle le calendrier
  return coverageEnd(this.cfg.windows, now);
}
```

```ts
// src/daemon.ts:316-325
const run = this.running;
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
await saveState(this.cfg.dataDir, this.state);
run.explicitStop = true;
if (now) { run.ac.abort(); return { stopping: "now" }; }
run.stopRequested = true;
return { stopping: "after-iteration" };
```

La pause écrite par le premier `stop` est exactement ce qui rend `calendarEnd`
muet. Au second appel, pour une plage **purement calendaire**
(`run.manualUntil === null`, cas de toute plage automatique), `ends` est vide et
`deadline` retombe sur la branche `now` : `pausedUntil` passe de la fin de
couverture à l'instant présent, c'est-à-dire à rien du tout. Rien ne s'y oppose :
`stopWindow` n'a aucune garde de réentrance (pas de test sur `stopRequested` ni
sur `explicitStop`), elle n'utilise pas `pauseUntil` et donc pas son garde
`until <= now` (`src/daemon.ts:232`), et l'API ne sérialise pas les commandes
(`src/api.ts:68-70`).

La fenêtre pour y entrer est large : `shouldStop()` n'est consulté qu'**entre**
deux itérations (`src/scheduler.ts:83-87`), et une itération dure jusqu'à
`claude.timeoutMinutes`, **180 min par défaut** (`src/config.ts:19`). Tant que
l'itération court, `this.running` reste posé et chaque `stop` est accepté.

Scénario, `windows: [{ days: [...], from: "09:00", to: "18:00" }]`, aucune plage
manuelle :

1. 10:00 — le démon tourne en `calendar`, `state.pausedUntil === null`.
   `deadline(null)` = `coverageEnd` = 18:00, une itération est en cours.
2. 10:00:05 — `unused stop`. `calendarEnd(10:00:05)` : pas de pause → 18:00 ;
   `pausedUntil = "…T18:00"` persisté ; `stopRequested = true`. La CLI répond
   « arrêt demandé : la plage s'arrêtera après l'itération en cours »
   (`src/cli.ts:83`). L'itération, elle, continue.
3. 10:05 — l'utilisateur s'impatiente et relance `unused stop --now` (ou
   simplement `unused stop`). `this.running` est toujours posé, donc on passe
   ligne 317 : `calendarEnd(10:05)` voit `paused = 18:00 > 10:05` et rend
   **`null`** ; `manualUntil` est `null` ; `ends.length === 0` →
   `deadline` = **10:05**. `state.pausedUntil = "…T10:05"` est persisté.
4. La plage se termine (abort, ou fin d'itération). `runWindow` rend
   `endedBecause: "stopped"`, donc ni la branche `fatal` ni la branche
   `nothing-eligible` de `src/daemon.ts:205-212` ne repose de pause ; le
   `finally` remet `state.window` à `null` et libère `this.running`
   (`src/daemon.ts:217-225`).
5. Tour de boucle suivant (`src/daemon.ts:145-151`) : `manualUntil = null`,
   `calendarEnd(10:05:00.1)` voit `paused = 10:05:00.0`, qui n'est **plus**
   strictement futur → `coverageEnd` rend 18:00 → `deadline > now` →
   `execute()`. Le démon imprime « nouvelle plage (calendar) jusqu'à …T18:00 »
   et repart pour une plage neuve, `stopRequested` à `false`.

Obtenu : après deux `stop`, le démon enchaîne les itérations jusqu'à 18:00 et
`unused status` ne montre aucune pause (`src/daemon.ts:362` écarte un
`pausedUntil` non futur). Attendu : plages automatiques en pause jusqu'à la fin
de la couverture, ce que promettent le doc-comment de la méthode
(`src/daemon.ts:303-307`, « sinon le calendrier relancerait aussitôt ») et
`README.md:96-98`. C'est précisément le « relancerait aussitôt » qui se produit.

Variantes, même racine :

- **`manual+calendar`, manuel plus court que la couverture.** `start --for 1h` à
  10:00 dans la couverture 09:00→18:00 : premier `stop` → `pausedUntil` =
  max(11:00, 18:00) = 18:00 ; second `stop` → `calendarEnd` muet, `ends = [11:00]`
  → `pausedUntil = 11:00`. La pause n'est pas annulée mais tronquée de sept
  heures, et le calendrier reprend à 11:00.
- **`manual+calendar`, borne manuelle déjà expirée.** `start --for 30m` à 10:00,
  premier `stop` à 10:40 → `pausedUntil = 18:00` ; second `stop` à 10:45 →
  `ends = [10:30]` → `pausedUntil = "…T10:30"`, déjà passé : pause annulée comme
  dans le cas calendaire pur.

Non permanent, mais rejouable : une fois `pausedUntil` dans le passé, un `stop`
isolé repose correctement la pause (`calendarEnd` n’est plus muselé). C'est
chaque `stop` **supplémentaire adressé à une plage encore vivante** qui détruit
la pause du précédent — soit, pour l'utilisateur, le réflexe « ça ne s'arrête
pas, je relance avec `--now` ».

Un correctif tiendrait en une ligne : calculer l'horizon avant que la pause ne
soit écrite, ou ignorer la pause dans le calcul (`coverageEnd(this.cfg.windows,
now)` directement), ou sortir tôt si `run.explicitStop` est déjà vrai.

## Ce qui a été vérifié et tient

- **`startWindow` réentrante** : la garde `if (this.running || this.manual)`
  (`src/daemon.ts:285`) rejette en 409 avant tout effet de bord ; aucun des
  `pausedUntil = null` / `fatal = null` / `saveState` n'est atteint par un second
  appel. Le fait qu'elle rejette *aussi* pendant une plage en cours est le
  constat 1 du rapport 056, pas un problème de réentrance.
- **`unpause` réentrante** (`src/daemon.ts:238-243`) : court-circuit sur `null`,
  donc un second appel ne réécrit rien et ne réveille pas inutilement.
  `resetTask`/`setActive` peuvent l'appeler en rafale sans dommage.
- **`stopWindow` sur plage manuelle *en attente*** (`src/daemon.ts:309-315`) :
  réentrance sans effet, le second appel tombe sur le `throw ConflictError`. La
  piste « cette branche laisse un `state.window` périmé » est restée non
  démontrable, comme au rapport 042 : entre `listen` et `daemon.run`
  (`src/cli.ts:44-59`) il n'y a aucun `await`, et `execute` pose `this.running`
  avant son premier point d'attente.
- **Effondrement de `deadline` sur l'itération en cours** : `runWindow` reçoit
  `() => this.deadline(run.manualUntil)` (`src/daemon.ts:196`) et le relit à
  chaque tour, mais `iterate` ne reçoit que `run.ac.signal` ; les deux autres
  usages de `until()` (`src/scheduler.ts:115`, `src/scheduler.ts:133`) se
  contentent d'un `wait <= 0` sans sommeil. L'itération en cours n'est donc pas
  tuée par le second `stop` gracieux.
- **`source`, `until`, `remainingMs` et `endedBecause` faux après un `stop`
  gracieux d'une plage calendaire** : même racine (l'effondrement de `deadline`),
  déjà rapporté en détail au rapport 042, troisième constat. Rien à ajouter.
- **Débordement de pause `max(manuel, couverture)` et plages automatiques
  sautées** : rapport 042, premier constat.
- **Écritures concurrentes de `state.json` par deux `stop` rapprochés** : le
  risque de `state.json.tmp` partagé est déjà au rapport 006 ; non rejoué ici.
