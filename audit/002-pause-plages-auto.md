# 002 — portée et levée de `pausedUntil` après stop, « rien à faire » ou erreur

**Fichiers examinés** : `src/daemon.ts:115-135`, `src/daemon.ts:160-250`, `src/daemon.ts:284-326`,
`src/daemon.ts:328-373`, `src/calendar.ts:56-78`, `src/scheduler.ts:56-155`, `src/cli.ts:86-110`,
`src/state.ts:100-118`, `src/daemon.test.ts:168-220`
**Verdict** : 4 constats (3 sûrs, 1 probable)

## Une pause qui expire au milieu d'une plage automatique fait sauter toute la fin de la plage

**Gravité** : sûr
**Où** : `src/daemon.ts:130-135`, `src/daemon.ts:161-175`, `src/calendar.ts:70-78`

`pauseUntil` enregistre comme fin de pause `this.deadline(run.manualUntil)`,
c'est-à-dire **le plus tard** entre la fin de la plage manuelle et la fin de la
couverture calendrier :

```ts
// src/daemon.ts:116-121
private deadline(manualUntil: Date | null): Date {
  const now = this.deps.now();
  const calendar = this.calendarEnd(now);
  const ends = [manualUntil, calendar].filter((d): d is Date => d !== null).map((d) => d.getTime());
  return ends.length > 0 ? new Date(Math.max(...ends)) : now;
}
```

Quand la plage manuelle déborde au-delà de la couverture en cours, cet instant
peut tomber **à l'intérieur** d'une plage automatique à venir. Le réveil est
alors calculé ainsi :

```ts
// src/daemon.ts:130-135
private nextCalendarStart(): Date | null {
  const now = this.deps.now();
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  const from = paused && paused.getTime() > now.getTime() ? paused : now;
  return nextStart(this.cfg.windows, from);
}
```

et `nextStart` saute délibérément la couverture qui contient `from` :

```ts
// src/calendar.ts:71-78
export function nextStart(specs: WindowSpec[], now: Date): Date | null {
  const cover = coverageEnd(specs, now);
  const floor = cover ?? now;
  for (const s of occurrences(specs, now)) {
    if (s.start.getTime() > floor.getTime()) return s.start;
  }
  return null;
}
```

Résultat : si `pausedUntil` tombe dans une plage, le prochain réveil est le début
de la plage *suivante*. Et rien d'autre ne réveille le démon : `idle()` ne pose
qu'un seul timer, celui de `nextCalendarStart()` (`src/daemon.ts:163-165`) — il
n'existe aucun timer sur l'expiration de la pause elle-même.

Scénario concret avec la configuration livrée (`unused.config.json` : une plage
`mon 00:00 → 13:00`) :

1. dimanche 21:00 — `unused start --for 10h` (manuel jusqu'au lundi 07:00), rien
   ne tourne encore côté calendrier, la plage démarre ;
2. dimanche 22:00 — `unused stop`. `deadline(manualUntil = lun 07:00)` vaut
   `max(lun 07:00, coverageEnd(dim 22:00) = null)` = **lundi 07:00**, écrit dans
   `pausedUntil` (`src/daemon.ts:317`) ;
3. le démon repasse en `idle`. `nextCalendarStart()` part de lundi 07:00 ;
   `coverageEnd` y répond lundi 13:00, donc `floor` = lundi 13:00, et la première
   occurrence qui commence après est **lundi prochain 00:00**.

Obtenu : le démon dort une semaine, `unused status` affiche
`prochaine plage automatique <lundi+7>`. Attendu : la pause expire lundi 07:00,
la plage automatique couvre encore 07:00 → 13:00, le démon devrait travailler ces
6 heures. Six heures de quota perdues, sans une ligne de log.

Le même calcul vaut pour les deux autres entrées de `pauseUntil` :

```ts
// src/daemon.ts:208-216
} else if (this.lastWindow.endedBecause === "nothing-eligible") {
  await this.pauseUntil(this.deadline(run.manualUntil), "plus rien à faire");
}
} catch (err) {
  ...
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
}
```

Variante « rien à faire », toujours avec la config livrée : `start --for 8h` le
dimanche 21:00, dernière tâche `done` à 23:00 → `pausedUntil` = lundi 05:00 →
lundi 05:00–13:00 (8 h) sautées, réveil lundi prochain.

Le cas testé (`src/daemon.test.ts:168-194`) ne le montre pas : la plage y est
unique et `pausedUntil` y vaut exactement la fin de couverture, borne pour
laquelle `coverageEnd` répond `null` (`s.start <= now && now < s.end`, strict à
droite) et où `nextStart` retombe donc juste.

## Après un `stop` gracieux, la plage en cours ment sur sa source et sa fin

**Gravité** : sûr
**Où** : `src/daemon.ts:317`, `src/daemon.ts:123-128`, `src/scheduler.ts:83`

`stopWindow` écrit la pause **avant** que la plage ne s'arrête, et `deadline`
relit cette même pause :

```ts
// src/daemon.ts:123-128
private calendarEnd(now: Date): Date | null {
  if (this.fatal) return null;
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  if (paused && paused.getTime() > now.getTime()) return null;
  return coverageEnd(this.cfg.windows, now);
}
```

Pour une plage purement calendrier (`run.manualUntil === null`), dès la seconde
qui suit `stop`, `this.deadline(null)` n'a plus aucune borne : `ends` est vide et
la méthode retourne `now`. Or c'est exactement la fonction passée au scheduler
comme `until()` (`src/daemon.ts:196`) et utilisée par le status.

Conséquences, pendant que la dernière itération tourne encore (jusqu'à
`claude.timeoutMinutes`, 180 min par défaut) :

- `unused status` affiche `plage    manual, jusqu'à <maintenant> (0s restantes) —
  arrêt demandé` (`src/cli.ts:100`, `src/daemon.ts:245-250`) : la source bascule
  de `calendar` à `manual` pour une plage qui n'a jamais été manuelle, et le
  restant annoncé est nul alors que l'itération peut durer des heures ;
- à la fin de l'itération, la boucle du scheduler sort sur la condition
  `deps.now() < until()` (`src/scheduler.ts:83`) **avant** de consulter
  `shouldStop()` (`src/scheduler.ts:84-87`). `stopped` reste `false`, donc
  `endedBecause` reste `"window"` au lieu de `"stopped"` : le log final dit
  `fin de plage (window)` et `unused status` affiche `dernière … (window)`
  (`src/cli.ts:107-110`), comme si la plage était arrivée à son terme.

## `stopWindow` pose une pause même quand aucune plage automatique n'existe

**Gravité** : sûr
**Où** : `src/daemon.ts:317` contre `src/daemon.ts:228-236`

`pauseUntil` refuse explicitement de mettre en pause un calendrier vide :

```ts
// src/daemon.ts:228-232
private async pauseUntil(until: Date, why: string): Promise<void> {
  // Sans calendrier, il n'y a rien à mettre en pause : ...
  if (this.cfg.windows.length === 0) return;
  if (until.getTime() <= this.deps.now().getTime()) return;
```

`stopWindow` écrit dans le même champ sans passer par cette fonction, donc sans
aucun des deux garde-fous :

```ts
// src/daemon.ts:317-318
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
await saveState(this.cfg.dataDir, this.state);
```

Scénario : config par défaut (`windows: []`, `src/config.ts:32`),
`unused start --for 8h`, puis `unused stop` cinq minutes plus tard.
`deadline(manualUntil)` vaut la fin de la plage manuelle, donc `state.json`
conserve `pausedUntil` ≈ +7 h 55, et `unused status` affiche pendant tout ce
temps `pause    plages automatiques ignorées jusqu'à <+7h55>` alors qu'il n'y a
aucune plage automatique à ignorer. Aucun effet sur l'exécution
(`coverageEnd([], …)` et `nextStart([], …)` répondent `null` de toute façon) :
c'est l'état affiché et persisté qui est faux.

## Plage interrompue par une erreur sans calendrier : l'oubli de la plage n'est jamais écrit sur disque

**Gravité** : probable
**Où** : `src/daemon.ts:213-222`

```ts
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
} finally {
  if (run.explicitStop && this.state.window) {
    this.state.window = null;
    await saveState(this.cfg.dataDir, this.state);
  }
```

Le `state.window = null` du `catch` n'est suivi d'aucune écriture : le seul
`saveState` du chemin est celui de `pauseUntil`, qui **retourne avant** si
`cfg.windows.length === 0` (voir constat précédent). Le `finally` ne sauve que
sur `explicitStop`, faux ici, et son test `&& this.state.window` est de toute
façon déjà `null`.

Or `runWindow` a persisté la plage dès son démarrage :

```ts
// src/scheduler.ts:78-79
state.window = { startedAt: startedAt.toISOString(), until: until().toISOString() };
await saveState(cfg.dataDir, state);
```

Scénario : config par défaut (`windows: []`), `unused start --for 8h`. Au bout de
cinq minutes une itération lève une erreur qui n'est pas une `DockerError` —
`iterate` ne rattrape que celles-là (`src/iterate.ts:142-145`, `176-178`), donc
un `EACCES` sur `exchangeDir` lors du `rm(donePath)` ou un `ENOSPC` à l'écriture
du log remonte jusqu'ici. Le démon annonce « plage interrompue par une erreur »,
passe en repos définitif (aucune plage, aucun timer) — mais `state.json` contient
toujours `window: { until: <+7h55> }`. Un redémarrage du service dans ces huit
heures relit ce fichier et **reprend la plage** (`src/daemon.ts:98-102`,
« plage interrompue trouvée, reprise jusqu'à … »), exactement ce que le `catch`
voulait empêcher. Avec un calendrier non vide, la même erreur oublie bien la
plage : le comportement dépend d'un champ de config sans rapport.

## Ce qui a été vérifié et tient

- `startWindow` (`src/daemon.ts:296-298`) remet `fatal` et `pausedUntil` à zéro
  puis sauve : une pause posée par un `stop`, un « rien à faire » ou une erreur
  est bien levée par un `start`, et le `wake()` relance la boucle.
- `unpause()` (`src/daemon.ts:238-243`) sort tôt si `pausedUntil` est déjà nul,
  sauve sinon, et réveille la boucle ; `resetTask` et `setActive(true)` l'appellent
  après avoir écrit leur propre état. À noter, sans que ce soit démontrable comme
  un défaut : `pausedUntil` sert à la fois à « plus rien à faire » et à « arrêt
  explicite », donc un `tasks reset` ou un `tasks activate` relance aussi un
  calendrier que l'utilisateur venait d'arrêter à la main.
- `status` masque une pause expirée (`src/daemon.ts:362`) ; une valeur périmée
  traîne dans `state.json` mais n'est jamais relue comme active (`calendarEnd` et
  `nextCalendarStart` comparent toutes deux à `now`).
- La pause ne survit pas à une panne globale : `calendarEnd` et
  `nextCalendarStart` sont court-circuités par `fatal` (`src/daemon.ts:124`,
  `src/daemon.ts:163`, `src/daemon.ts:366`), cohérent avec « plus rien ne tourne
  jusqu'à un start ».
- Chemin `stop --now` : `ac.abort()` → `runWindow` sort sans sauver
  (`src/scheduler.ts:141-143`), et c'est le `finally` d'`execute` qui écrit
  `window: null` grâce à `explicitStop`. Vérifié conforme, test à l'appui
  (`src/daemon.test.ts:116-124`).
