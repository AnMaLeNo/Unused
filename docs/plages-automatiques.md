# Les plages automatiques

`src/calendar.ts` calcule, à partir d'une liste de `WindowSpec` (config
`windows` dans `unused.config.json`), si une plage automatique couvre
l'instant présent et quand la prochaine commence. Le module ne connaît rien
du démon ni de l'état persistant : c'est de l'arithmétique pure sur des
`Date`, appelée par [le démon](le-demon.md) (`this.cfg.windows`).

## `WindowSpec`

```ts
export const WindowSpecSchema = z
  .object({
    days: z.array(z.enum(DAYS)).nonempty(),
    from: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
    to: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
  })
  .strict();
```

Une plage est définie par les jours où elle **commence** (`days`, en anglais
abrégé : `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, `sat`) et une heure de
début/fin locale à la machine. Exemple, tiré de `unused.config.json` — une
plage tous les lundis de minuit à 13h :

```json
"windows": [
  { "days": ["mon"], "from": "00:00", "to": "13:00" }
]
```

Si `to` ≤ `from`, la plage se termine le lendemain (ex. `23:00` → `07:00`
pour une plage de nuit). Une plage ne dépasse jamais 24 h — c'est implicite
dans la façon dont `occurrences()` calcule la fin (un seul jour de plus au
maximum). Plusieurs plages peuvent être déclarées ; elles se cumulent (voir
plus bas).

## `occurrences()` : matérialiser les plages en dates concrètes

```ts
export function occurrences(specs: WindowSpec[], now: Date): Span[] {
  const spans: Span[] = [];
  for (let offset = -1; offset <= 7; offset++) {
    const day = addDays(now, offset);
    day.setHours(0, 0, 0, 0);
    const name = DAYS[day.getDay()]!;
    for (const spec of specs) {
      if (!spec.days.includes(name)) continue;
      const start = at(day, spec.from);
      let end = at(day, spec.to);
      if (end.getTime() <= start.getTime()) end = addDays(end, 1);
      spans.push({ start, end });
    }
  }
  return spans.sort((a, b) => a.start.getTime() - b.start.getTime());
}
```

Elle parcourt les jours de J-1 à J+7 autour de `now`, et pour chaque `spec`
dont `days` contient le jour courant, produit un `Span { start, end }`. La
fenêtre J-1..J+7 est large exprès : une plage qui a commencé la veille
(cas `23:00` → `07:00`) doit apparaître même si `now` est déjà le
lendemain, et il faut pouvoir trouver un « prochain départ » jusqu'à une
semaine à l'avance.

## `coverageEnd()` : est-on dans une plage, et jusqu'à quand ?

```ts
export function coverageEnd(specs: WindowSpec[], now: Date): Date | null {
  let end: Date | null = null;
  for (const s of occurrences(specs, now)) {
    const inside = s.start.getTime() <= now.getTime() && now.getTime() < s.end.getTime();
    const extends_ = end !== null && s.start.getTime() <= end.getTime() && s.end.getTime() > end.getTime();
    if (inside || extends_) end = s.end;
  }
  return end;
}
```

Retourne la fin de la couverture continue si `now` est dans une plage,
sinon `null`. Le point important est la fusion : le calcul ne s'arrête pas
à la première plage qui contient `now`, il continue et étend `end` tant
qu'une autre occurrence chevauche ou enchaîne directement (`s.start <=
end`). Deux plages qui se touchent ou se recouvrent forment donc une seule
couverture continue — utile si on déclare par exemple une plage `22:00` →
`06:00` et une autre `05:00` → `09:00` : la couverture réelle va de `22:00`
à `09:00` sans coupure. `src/calendar.test.ts` vérifie ce cas précis
(chevauchement de deux plages qui commencent des jours différents).

## `nextStart()` : le prochain réveil

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

Si on est déjà dans une plage, le prochain départ pertinent est après la
fin de la couverture courante (`floor = cover`), pas un départ qui serait
en fait déjà couvert par la plage en cours. Sinon, c'est simplement la
première occurrence après `now`. `occurrences()` triant déjà par `start`,
il suffit de prendre la première qui dépasse `floor`.

## Utilisation par le démon

`src/daemon.ts` combine ces deux fonctions pour décider s'il doit
travailler et, sinon, combien de temps attendre :

```ts
private calendarEnd(now: Date): Date | null {
  if (this.fatal) return null;
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  if (paused && paused.getTime() > now.getTime()) return null;
  return coverageEnd(this.cfg.windows, now);
}

private nextCalendarStart(): Date | null {
  const now = this.deps.now();
  const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
  const from = paused && paused.getTime() > now.getTime() ? paused : now;
  return nextStart(this.cfg.windows, from);
}
```

- En panne globale (`this.fatal`) ou en pause manuelle (`state.pausedUntil`
  dans le futur), le calendrier est ignoré : `calendarEnd` renvoie `null`
  même si une plage automatique serait normalement active.
- `deadline()` (`src/daemon.ts:116`) prend le maximum entre la fin de plage
  manuelle et `calendarEnd(now)` : une plage manuelle et une plage
  automatique qui se chevauchent prolongent la session de travail au lieu
  de s'interrompre l'une l'autre — c'est le sens de « les plages… se
  cumulent » mentionné dans `src/config.ts`.
- Pendant l'attente (`idle()`, `src/daemon.ts:160`), le démon programme un
  `setTimeout` jusqu'à `nextCalendarStart()` pour se réveiller pile au
  début de la prochaine plage automatique, plutôt que de faire du polling.

Voir aussi [le démon](le-demon.md) pour le reste de la boucle (plages
manuelles via l'API, pannes globales, reprise après redémarrage).
