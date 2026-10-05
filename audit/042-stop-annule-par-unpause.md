# 042 — src/daemon.ts stopWindow/unpause + resetTask/setActive : angle arrêt explicite

**Fichiers examinés** : `src/daemon.ts:115-135`, `src/daemon.ts:181-243`, `src/daemon.ts:303-330`, `src/daemon.ts:360-418`, `src/calendar.ts:58-78`, `src/scheduler.ts:74-150`, `src/api.ts:69-95`, `src/cli.ts:78-106`, `src/daemon.test.ts:168-220`
**Verdict** : 3 constats (2 sûrs, 1 probable)

L'angle annoncé — « `reset`/`activate` lèvent la pause d'un `stop` » — est un
comportement **voulu et documenté** (`README.md:96-98`, commentaire
`src/daemon.ts:209-210`) : rien à signaler de ce côté. Les défauts trouvés sont
dans la valeur que `stopWindow` écrit dans `pausedUntil`.

## `stop` met les plages automatiques en pause jusqu'à la fin de la plage *manuelle*, pas de la couverture

**Gravité** : sûr
**Où** : `src/daemon.ts:317` (via `src/daemon.ts:116-120`)

`stopWindow` écrit comme horizon de pause `this.deadline(run.manualUntil)`, or
`deadline` renvoie le **maximum** de la plage manuelle et de la couverture
calendaire :

```ts
private deadline(manualUntil: Date | null): Date {
  const ends = [manualUntil, calendar].filter(...).map((d) => d.getTime());
  return ends.length > 0 ? new Date(Math.max(...ends)) : now;
}
...
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
```

Quand la plage manuelle dépasse la couverture en cours, la pause déborde très
au-delà de ce que promettent le doc-comment de la méthode (« jusqu'à la fin de
la couverture actuelle ») et `README.md:96-98`. La plage manuelle est pourtant
abandonnée au même instant (`this.manual = null` en `src/daemon.ts:223`,
`state.window = null` en `src/daemon.ts:218-221`) : son horizon ne survit que
sous forme de pause.

Scénario : `windows` = `[{mon-fri, 09:00→12:00}, {mon-fri, 14:00→16:00}]`.
À 10:00 l'utilisateur lance `unused start --for 8h` (manuel jusqu'à 18:00), la
plage tourne en `manual+calendar`. À 10:30 il lance `unused stop --now`.

- `deadline` = max(18:00, `coverageEnd` = 12:00) = **18:00** → `pausedUntil = 18:00`.
- Boucle `run` : `calendarEnd` renvoie `null` tant que la pause court
  (`src/daemon.ts:125-126`) → `idle`.
- `nextCalendarStart` part de `from = pausedUntil = 18:00`
  (`src/daemon.ts:132-133`) → `nextStart` ignore l'occurrence 14:00 et rend
  **demain 09:00**.

Obtenu : la plage automatique 14:00→16:00 du jour est purement sautée, le démon
dort ~23 h. Attendu : pause jusqu'à 12:00, puis la plage de 14:00 démarre
normalement.

Variante aggravée, quand `pausedUntil` tombe *à l'intérieur* d'une couverture
ultérieure — impossible avec un horizon calendaire seul (il tombe toujours sur
une frontière de couverture fusionnée), possible dès qu'un horizon manuel s'en
mêle. `windows` = `[{14:00→20:00}]` + couverture en cours 09:00→12:00, manuel
jusqu'à 18:00, `stop` à 10:30 → `pausedUntil = 18:00`. `nextCalendarStart` :
`coverageEnd(windows, 18:00)` = 20:00 (18:00 est dans la plage), donc
`floor = 20:00` et le prochain départ retenu est **demain 14:00**. Le démon
traverse les 14:00→20:00 d'aujourd'hui endormi, y compris les deux heures
postérieures à l'expiration de la pause : `idle` ne programme un réveil que sur
`nextCalendarStart`, jamais sur la fin de `pausedUntil`.

Même racine en `src/daemon.ts:211` et `src/daemon.ts:216` (`pauseUntil(this.deadline(run.manualUntil), …)`),
avec la même conséquence de plages automatiques sautées.

## `stopWindow` contourne le garde-fou « pas de calendrier » de `pauseUntil`

**Gravité** : sûr
**Où** : `src/daemon.ts:317`, à comparer à `src/daemon.ts:228-232`

`pauseUntil` refuse explicitement d'écrire quoi que ce soit sans calendrier, et
dit pourquoi :

```ts
private async pauseUntil(until: Date, why: string): Promise<void> {
  // Sans calendrier, il n'y a rien à mettre en pause : seules les plages
  // automatiques sont concernées, une plage manuelle ne revient pas seule.
  if (this.cfg.windows.length === 0) return;
  if (until.getTime() <= this.deps.now().getTime()) return;
```

`stopWindow` écrit directement dans `this.state.pausedUntil` sans passer par
cette méthode, donc sans aucun des deux gardes.

Scénario : `windows: []` (cas par défaut d'une install sans calendrier). `unused
start --for 8h` à 10:00, puis `unused stop` à 10:30. `deadline(18:00)` = 18:00
→ `pausedUntil = "…T18:00:00Z"` est persisté dans `state.json`. `status`
(`src/daemon.ts:362`) le retient puisqu'il est futur, et `unused status`
affiche (`src/cli.ts:105`) :

```
pause    plages automatiques ignorées jusqu'à 2026-10-05T18:00:00.000Z
```

Il n'existe aucune plage automatique à ignorer. L'état affiché est faux et le
reste jusqu'au prochain `start`, `tasks reset` ou `tasks activate`, seules
portes qui remettent le champ à `null` (`src/daemon.ts:297`, `src/daemon.ts:240`).
Pas d'effet fonctionnel (avec `windows: []`, `coverageEnd`/`nextStart` rendent
`null` de toute façon) : le défaut est dans l'état rapporté.

## Arrêt gracieux d'une plage purement calendaire : la plage se déclare « manual », expirée, et finit en « window »

**Gravité** : probable
**Où** : `src/daemon.ts:317-325`, effets en `src/daemon.ts:245-249` et `src/daemon.ts:336-345`

`stopWindow` persiste `pausedUntil` **avant** de poser `run.stopRequested`, et
`pausedUntil` est précisément ce qui fait taire `calendarEnd`
(`src/daemon.ts:125-126`). Pour une plage sans composante manuelle
(`run.manualUntil === null`), `deadline(null)` n'a dès lors plus aucune borne à
agréger et retombe sur la branche `ends.length === 0` → `now`.

Scénario : `windows` = `[{09:00→18:00}]`, aucune plage manuelle, une itération
en cours (`claude.timeoutMinutes` = 180 par défaut, donc la fenêtre peut durer
des heures). À 10:00, `unused stop` sans `--now`. Pendant tout le reste de
l'itération, `unused status` lit :

- `window.until` = `deadline(null)` = maintenant, `remainingMs` = 0 ;
- `source(run)` : `manual` faux (`manualUntil` nul) et `calendar` faux
  (`calendarEnd` muselé par la pause) → la chaîne de `src/daemon.ts:249` retombe
  sur `"manual"`.

Soit la ligne `src/cli.ts:99` : `plage manual, jusqu'à <instant déjà passé> (0s
restantes) — arrêt demandé`, pour une plage calendaire encore vivante.

Le motif de fin est faux aussi, et non déterministe. En tête de boucle, le
scheduler évalue `while (!signal.aborted && deps.now() < until())`
(`src/scheduler.ts:80`) *avant* `shouldStop()` (`src/scheduler.ts:81`). `until()`
appelle `deadline`, qui relit l'horloge après le `deps.now()` de la comparaison :

- les deux lectures tombent dans la même milliseconde (cas courant) → condition
  fausse, sortie de boucle sans passer par `shouldStop`, `stopped` reste faux et
  `summary.endedBecause` garde sa valeur initiale `"window"` ;
- elles encadrent une frontière de milliseconde → condition vraie, `shouldStop()`
  est consulté et `endedBecause` vaut `"stopped"`.

Donc l'arrêt explicite est enregistré, la plupart du temps, comme une plage
arrivée à son terme : `lastWindow.endedBecause === "window"` dans `status`, et la
ligne de log `fin de plage (window)` (`src/scheduler.ts:150`). Une plage
`manual` ou `manual+calendar` n'a pas le problème : `deadline` conserve
`manualUntil`, la condition de boucle passe, `shouldStop()` est lu et
`endedBecause` vaut bien `"stopped"`.

## Ce qui a été vérifié et tient

- `reset`/`activate` qui lèvent la pause d'un `stop` et relancent la plage :
  **voulu**, écrit noir sur blanc en `README.md:96-98` et en commentaire
  `src/daemon.ts:209-210`. Inutile d'y revenir. À noter seulement que `setActive`
  n'appelle `unpause` que si `active === true` (`src/daemon.ts:417`), donc un
  `deactivate` ne relance rien : correct.
- `unpause` (`src/daemon.ts:238-243`) : court-circuit sur `null`, persistance
  avant le `wake?.()`, rien à signaler.
- Chemin `explicitStop` dans le `finally` de `execute`
  (`src/daemon.ts:217-225`) : `state.window` est bien remis à `null` pour que la
  plage ne soit pas reprise au prochain démarrage, et `this.manual` est libéré
  même quand le signal a été avorté.
- L'itération en cours n'est pas tuée par l'effondrement de `deadline` décrit au
  troisième constat : `iterate` reçoit `run.ac.signal`, pas la deadline, et les
  seuls autres usages de `until()` dans la boucle (`backoff`, `retry`) se
  contentent d'un `wait <= 0` sans sommeil. L'arrêt « après l'itération en
  cours » est donc respecté ; c'est le motif rapporté qui est faux.
- Branche `!this.running && this.manual` de `stopWindow`
  (`src/daemon.ts:309-315`) : cherché un scénario où elle laisse un
  `state.window` périmé derrière elle. Non démontré — `init` puis `run`
  atteignent `execute` (qui pose `this.running`) sans point de reprise
  macrotâche, et `startWindow` n'écrit jamais `state.window`.
