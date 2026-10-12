# 060 — angle calendrier 24/7 : couverture tronquée à l'horizon J+7, pause de 8 jours, démon parqué sans réveil

**Fichiers examinés** : `src/calendar.ts:38-78`, `src/daemon.ts:96-135,137-175,177-236,284-326,328-373`,
`src/scheduler.ts:74-78,86-92,141-148`, `src/cli.ts:48-63,105`, `src/state.ts:31,39`, `README.md:84-99`
**Verdict** : 4 constats (3 sûrs, 1 probable)

Le fil conducteur : `occurrences` n'énumère que les plages qui commencent
entre J-1 et J+7, et toute la logique de calendrier du démon est construite
sur cette liste finie. Pour un calendrier *continu* — `{"days": [les 7],
"from": "00:00", "to": "00:00"}`, ou deux plages bout à bout
(`00:00→12:00` + `12:00→00:00`) — la fusion de `coverageEnd` consomme toute la
fenêtre et retourne le bord de l'horizon : une « fin de couverture » qui n'est
pas une vraie borne, mais un artefact de la boucle `for (let offset = -1;
offset <= 7; offset++)`. Deux valeurs en découlent : une pause de ~8 jours, et
un `nextStart` qui vaut `null` — ce dernier parque le démon dans une attente
sans minuteur.

Le cas 24/7 est bien dans le contrat : le schéma accepte `to == from` et le
commentaire de `WindowSpecSchema` (`src/calendar.ts:6-10`) documente
explicitement la plage de 24 h.

## `nextStart` retourne `null` sous couverture continue, et `idle()` attend alors sans minuteur

**Gravité** : sûr
**Où** : `src/calendar.ts:71-77`, `src/daemon.ts:161-175`

`nextStart` cherche un début de plage *strictement après* la fin de la
couverture :

```ts
export function nextStart(specs: WindowSpec[], now: Date): Date | null {
  const cover = coverageEnd(specs, now);
  const floor = cover ?? now;
  for (const s of occurrences(specs, now)) {
    if (s.start.getTime() > floor.getTime()) return s.start;
  }
  return null;
}
```

En 24/7, `occurrences` produit 9 spans contigus `[J-1 00:00, J 00:00)` …
`[J+7 00:00, J+8 00:00)`. `coverageEnd` entre dans le span du jour (`inside`)
puis enchaîne de `extends_` en `extends_` jusqu'au dernier : il rend
`J+8 00:00`. Ce `floor` est au-delà du dernier `s.start` de la liste
(`J+7 00:00`) — la boucle ne retourne rien et `nextStart` vaut `null`.

`idle()` interprète ce `null` comme « aucune plage automatique à venir » et
n'arme **aucun** minuteur :

```ts
const next = this.fatal ? null : this.nextCalendarStart();
const ms = next ? Math.max(0, next.getTime() - this.deps.now().getTime()) : null;
const timer = ms !== null ? setTimeout(done, Math.min(ms, 2_147_000_000)) : null;
```

La promesse ne peut plus être résolue que par `this.wake` — c'est-à-dire par
`start`, `tasks reset` ou `tasks activate` (`src/daemon.ts:299,242`) — ou par
l'abort du processus. Or `pausedUntil` n'est relu que par `calendarEnd`
(`:125-127`), appelé depuis `deadline()`, appelé depuis la boucle `run()` —
qui est bloquée dans `idle()`. **Personne ne réveille le démon à l'expiration
de la pause.**

Scénario concret, horloge locale :

1. `windows: [{days: [sun…sat], from: "00:00", to: "00:00"}]`. Lundi 12/10
   10:00, toutes les tâches ont posé `/exchange/DONE` (ou sont inactives) :
   `pickNext` rend `null`, `runWindow` sort en `nothing-eligible`
   (`src/scheduler.ts:86-92`).
2. `execute()` appelle `pauseUntil(this.deadline(...))` (`:208-212`) :
   `pausedUntil = 2026-10-20T00:00` — 7 j 14 h de pause.
3. Tour suivant de `run()` : `calendarEnd` rend `null` (pause active),
   `deadline()` rend `now`, donc `idle(signal)`.
4. `idle()` : `nextCalendarStart()` prend `from = pausedUntil` (20/10 00:00),
   `nextStart` recentre `occurrences` sur cette date, retrouve une couverture
   continue jusqu'au 28/10, et rend `null`. Aucun minuteur.
5. Le 20/10 passe. Rien ne se produit. On ajoute une nouvelle tâche dans
   `tasksDir` : le démon est endormi, il ne la verra jamais. Le quota 24/7
   que l'outil existe pour consommer ne l'est plus — jusqu'à ce qu'un humain
   tape `unused start` ou `unused tasks reset`.

Pour un calendrier *non* continu le même chemin est correct : avec
`mon-fri 09:00-17:00`, `nextStart(specs, pausedUntil = lundi 17:00)` rend
mardi 09:00 et le minuteur est armé. Le défaut est propre à la contiguïté.

Et à partir du 20/10, `status` ment doublement : `pausedUntil` est filtré
s'il est passé (`:362`), `window` est `null`, `nextCalendarStart` est `null` —
le démon se présente comme simplement disponible alors qu'il est parqué dans
une promesse sans échéance.

## La durée de la pause est l'horizon J+7, pas la fin d'une couverture

**Gravité** : sûr
**Où** : `src/daemon.ts:116-121,228-236` (valeur produite par `src/calendar.ts:41`)

`pauseUntil` reçoit `this.deadline(...)`, qui est le `max` entre la fin
manuelle et `coverageEnd`. Sous couverture continue, cette valeur est
`J+8 00:00` : jusqu'à 8 jours, déterminés par la borne `offset <= 7` de
`occurrences`. Trois chemins l'écrivent :

- `nothing-eligible` (`:211`) ;
- une erreur de plage, y compris transitoire (`:213-216` : `pauseUntil(…, "erreur")`) ;
- `unused stop` (`:317`).

Donc, en 24/7 : une seule exception remontée par `runWindow` gèle les plages
automatiques pendant ~8 jours (et, cumulé au constat précédent,
indéfiniment). Le README annonce autre chose : « `stop` met les plages
automatiques en pause jusqu'à la fin de la couverture en cours »
(`README.md:97-99`) — pour un calendrier continu il n'existe pas de « fin de
couverture », et l'utilisateur qui tape `stop` un lundi pour la soirée
retrouve son calendrier éteint la semaine suivante. `unused status` affiche
fidèlement `pause plages automatiques ignorées jusqu'à 2026-10-20T00:00`
(`src/cli.ts:105`) : la valeur n'est pas cachée, elle est simplement fausse
en intention.

Même artefact dans l'affichage de la plage en cours : `status.window.until` et
`remainingMs` (`:336-339`), le `print` de `execute` (`:190`) et
`describeWindow` (`:423`) annoncent une fin à J+8 pour une plage qui, en
pratique, est illimitée (la `deadline` est recalculée à chaque tour via le
callback passé à `runWindow`). `unused status` dit « 7 j 14 h restantes ».

## `state.window.until` persiste l'horizon : au redémarrage, une plage « manuelle » fantôme de 8 jours

**Gravité** : probable
**Où** : `src/scheduler.ts:75-78` puis `src/daemon.ts:96-108`

`runWindow` enregistre la plage **une seule fois**, au démarrage, avec la
valeur de `until()` à cet instant :

```ts
state.window = { startedAt: startedAt.toISOString(), until: until().toISOString() };
```

En 24/7 cet `until` est l'horizon (J+8). Si le service est arrêté pendant la
plage (`SIGTERM` → `ac.abort()`, `src/cli.ts:48-57`), `state.window` est
délibérément conservé (`src/scheduler.ts:141-144`, « la plage sera reprise au
prochain démarrage »). Au redémarrage, `init()` ne le relit pas comme une
plage de calendrier mais comme une plage **manuelle** :

```ts
if (until.getTime() > this.deps.now().getTime()) {
  this.manual = { until, resumed: true };
```

Le démon repart donc avec `manual.until = J+8`. Conséquences : `source` passe
à `manual`/`manual+calendar` alors que personne n'a tapé `start` ; et surtout
`deadline()` prend le `max` des deux, si bien que cette plage manuelle de
8 jours survit à un calendrier modifié. Scénario : on tourne en 24/7, le
service est redémarré (déploiement) lundi 11:00 → `state.window.until` =
20/10 00:00 ; on remplace ensuite `windows` par une plage de nuit
`23:00→07:00` et on redémarre → `init()` ressuscite la plage « manuelle »
jusqu'au 20/10 et le démon travaille 24 h/24 pendant huit jours en ignorant le
nouveau calendrier. Marqué probable : il faut le redémarrage *pendant* une
plage, et la gravité dépend de l'écart entre l'ancien et le nouveau
calendrier ; le mécanisme, lui, est déterministe.

## `stopWindow` écrit `pausedUntil` même sans aucune plage automatique

**Gravité** : sûr (impact limité)
**Où** : `src/daemon.ts:317` contre `:228-232`

`pauseUntil` se garde explicitement du cas sans calendrier :

```ts
if (this.cfg.windows.length === 0) return;
```

mais `stopWindow` n'y passe pas, il écrit l'état directement :

```ts
this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
```

Avec `windows: []`, `unused start --for 2h` puis `unused stop` laisse donc
`pausedUntil` en base, et `status` / la CLI annoncent « pause plages
automatiques ignorées jusqu'à … » alors qu'il n'y a aucune plage automatique à
ignorer. Si des `windows` sont ajoutées à la config avant cette échéance, le
nouveau calendrier est réellement ignoré jusque-là (`calendarEnd` rend `null`
tant que la pause court). Faible portée — la fenêtre est bornée par la plage
manuelle — mais c'est un état inventé et affiché.

## Ce qui a été vérifié et tient

- `occurrences` et la fusion de `coverageEnd` sont corrects pour les cas
  *non* contigus : plages chevauchantes, plages imbriquées (09:00-17:00 +
  13:00-15:00, la plus courte ne raccourcit pas la couverture grâce au test
  `s.end > end`), franchissement de minuit (`to <= from` → `addDays`), et
  l'horizon de 9 jours civils suffit à garantir une occurrence pour toute
  spec hebdomadaire.
- La contiguïté survit aux changements d'heure : `at()` puis `addDays()`
  travaillent en heure locale (`setHours`/`setDate`), donc la fin d'un span
  minuit→minuit tombe exactement sur le début du suivant même un dimanche de
  changement d'heure.
- La `deadline` glissante fonctionne : `runWindow` reçoit un callback
  (`src/daemon.ts:196`) réévalué à chaque tour de boucle, une plage manuelle
  prolongée par l'ouverture d'une plage automatique n'est pas coupée.
- Le clamp `Math.min(ms, 2_147_000_000)` de `idle()` est sain : un réveil
  prématuré repasse par la boucle `run()` qui réévalue et se remet en attente.
- `unpause()` est bien appelé par les trois commandes documentées (`start`,
  `tasks reset`, `tasks activate`) et réveille le démon via `this.wake`.
