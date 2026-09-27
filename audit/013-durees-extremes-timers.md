# 013 — Durées extrêmes ou dégénérées : `Date` invalide, `setTimeout` > 2^31, timeout non borné

**Fichiers examinés** : `src/duration.ts:1-27` (`parseDuration`, `formatDuration`),
`src/api.ts:61-66` (`POST /window`), `src/config.ts:8-44` (bornes du schéma),
`src/daemon.ts:115-173` (`deadline`, `calendarEnd`, `idle`),
`src/daemon.ts:284-301` (`startWindow`), `src/daemon.ts:328-360` (`status`),
`src/iterate.ts:116-155` (timer de session), `src/scheduler.ts:34-45` (`sleep`),
`src/scheduler.ts:104-136` (attentes backoff/retry), `src/calendar.ts:11-54`,
`src/state.ts:22-33`, `src/cli.ts:69-73`, `src/client.ts:20-52`,
`src/duration.test.ts`, `unused.config.json`.

Repère chiffré utilisé partout ci-dessous : `TIMEOUT_MAX` de Node vaut
2 147 483 647 ms, soit **35 791,39 minutes ≈ 24,855 jours**. Au-delà (ou pour
`Infinity`), Node émet un `TimeoutOverflowWarning` sur stderr et **ramène le
délai à 1 ms**. Le maximum d'un `Date` est ±8,64e15 ms depuis l'epoch ; au-delà
le `Date` est invalide et `toISOString()` lève `RangeError: Invalid time value`.

**Verdict** : 4 constats (1 sûr, 2 probables, 1 à vérifier)

## `claude.timeoutMinutes` non borné : au-delà de 24,8 jours le timeout se déclenche au bout de 1 ms et tue chaque itération

**Gravité** : sûr
**Où** : `src/iterate.ts:129-132`, schéma `src/config.ts:19`

Le schéma n'impose aucun plafond, ni même l'entier :

```ts
// src/config.ts:19
timeoutMinutes: z.number().positive().default(180),
```

et la valeur part telle quelle dans un `setTimeout` :

```ts
// src/iterate.ts:129-132
timer = setTimeout(() => {
  timedOut = true;
  deps.killContainer(container);
}, cfg.claude.timeoutMinutes * 60_000);
```

Dès que `timeoutMinutes > 35791.39`, le produit dépasse `TIMEOUT_MAX` et Node
remplace le délai par 1 ms. Le timer, armé dans `onStart` c'est-à-dire juste
après le démarrage du conteneur, tire donc immédiatement : `timedOut = true` et
`killContainer` sur un conteneur qui vient de naître.

Scénario concret. Un opérateur veut « en pratique pas de timeout » et met
`"timeoutMinutes": 43200` (30 jours) dans `unused.config.json`. Le schéma
l'accepte (positif). 43200 × 60000 = 2 592 000 000 ms > 2 147 483 647.
Résultat par itération :

1. `runInTask` démarre le conteneur, `onStart` arme le timer → 1 ms plus tard
   `killContainer`.
2. `session.lines === 0`, mais `timedOut` est testé avant tout le reste
   (`src/iterate.ts:156`) → `outcome = { kind: "failure", reason: "timeout" }`.
3. `applyOutcome` incrémente `consecutiveFailures`. Le scheduler dort
   `retrySeconds` puis recommence.
4. Au bout de `maxConsecutiveFailures` (3 par défaut) la tâche est sortie de la
   file avec le message « sortie de la file après 3 échecs consécutifs »
   (`src/scheduler.ts:132`), pour un motif — « timeout » — qui est l'exact
   contraire de ce que la config demandait.

Attendu : soit un rejet à la lecture de la config, soit un timeout de 30 jours.
Obtenu : toutes les tâches tombent en échec en quelques minutes, et la cause
affichée (timeout de 30 jours dépassé) est un mensonge.

Que le problème soit connu ailleurs dans le code renforce le constat : `idle`
borne explicitement son propre `setTimeout`, et c'est le **seul** des trois
sites qui le fasse :

```ts
// src/daemon.ts:165
const timer = ms !== null ? setTimeout(done, Math.min(ms, 2_147_000_000)) : null;
```

Variante du même défaut, sans avoir besoin d'une grande valeur : `z.number()`
n'exclut pas `Infinity`, et `JSON.parse` le produit à partir d'un littéral JSON
parfaitement légal — `JSON.parse('1e400')` vaut `Infinity`. Un
`"timeoutMinutes": 1e400` passe donc `.positive()` (`Infinity > 0`) et aboutit
au même `setTimeout(…, 1)`. À noter que `backoffMinutes`,
`maxConsecutiveFailures` et `flattenAfterLayers` y échappent parce qu'ils
portent `.int()` (`Number.isInteger(Infinity)` est faux) ; `timeoutMinutes` et
`retrySeconds` sont les deux seuls numériques sans `.int()`.

## `POST /window` avec une durée absurde : 500 au client, mais l'état est déjà muté et le démon se rendort en ignorant la plage calendrier en cours

**Gravité** : probable
**Où** : `src/daemon.ts:294-300`, `src/api.ts:64-65`, `src/daemon.ts:117-121`

`parseDuration` n'a aucun plafond : le nombre de chiffres est libre et le seul
rejet porte sur `total <= 0` (`src/duration.ts:13`). `parseDuration("999999999999d")`
rend 8,64e19 ms, une valeur finie et positive. Elle traverse l'API telle quelle :

```ts
// src/daemon.ts:294-300
const until = new Date(this.deps.now().getTime() + forMs);   // 8,64e19 > 8,64e15 → Date invalide
this.manual = { until, resumed: false };
this.fatal = null;
this.state.pausedUntil = null;
await saveState(this.cfg.dataDir, this.state);               // ← déjà écrit sur disque
this.wake?.();
return { until };
```

```ts
// src/api.ts:64-65
const { until } = await daemon.startWindow(parseDuration(body.for));
return sendJson(res, 200, { until: until.toISOString() });   // ← RangeError
```

Le `RangeError` remonte au `catch` de `createApi`, n'est ni `HttpError` ni
`ConflictError` ni `NotFoundError` → status 500, `{"error":"Invalid time value"}`.
Mais les quatre mutations ci-dessus ont déjà eu lieu, `pausedUntil` compris,
et l'écriture d'état est déjà committée.

Ensuite `deadline` propage le `NaN`, puisque `Math.max` rend `NaN` dès qu'un
argument l'est :

```ts
// src/daemon.ts:117-121
const ends = [manualUntil, calendar].filter((d): d is Date => d !== null).map((d) => d.getTime());
return ends.length > 0 ? new Date(Math.max(...ends)) : now;  // Math.max(NaN, cal) === NaN
```

Le `Date` invalide est un objet **truthy** : `this.manual?.until ?? null` le
laisse passer, il n'est pas filtré par le `filter(d => d !== null)`, et il
contamine le maximum même quand une couverture calendrier valide est présente.

Scénario concret, avec la config du dépôt (`windows: [{days:["mon"], from:"00:00", to:"13:00"}]`) :

1. Lundi 10:00, on est dans la couverture. `unused stop` → `pauseUntil(13:00)`,
   `calendarEnd` rend `null` tant que la pause dure, la boucle passe en `idle`.
2. Lundi 11:00, `unused start --for 999999999999d` (intention : « en continu »).
3. `startWindow` efface `pausedUntil`, pose `manual.until = Invalid Date`,
   sauvegarde, réveille la boucle. La CLI reçoit un 500 « Invalid time value ».
4. La boucle `run` (`src/daemon.ts:145-151`) relit `manual` :
   `this.deadline(Invalid Date).getTime()` vaut `NaN`, et `NaN > now` est faux
   → `this.manual = null` puis `idle()`.
5. `idle` appelle `nextCalendarStart` → `pausedUntil` étant désormais `null`,
   `nextStart(specs, now=11:00)` calcule `cover = coverageEnd(...) = 13:00`,
   prend `floor = 13:00` et rend **le lundi suivant 00:00**.

Résultat : le démon dort jusqu'à la semaine suivante alors que la plage
calendrier est ouverte jusqu'à 13:00 et que la pause qui justifiait le sommeil
a été effacée. Attendu : soit un 400 « durée trop grande » sans toucher à
l'état, soit une plage manuelle réellement ouverte. Obtenu : une erreur 500,
`pausedUntil` perdu, et deux heures de travail calendrier silencieusement
sautées — rien dans les logs ne le signale.

Corollaire, sur la même fenêtre de temps : entre l'étape 3 et l'étape 4,
`GET /status` répond 500 lui aussi, car il déréférence le même `Date` invalide :

```ts
// src/daemon.ts:349
until: this.manual.until.toISOString(),
```

`status()` commence par un `await loadTasks(...)`, la fenêtre est donc réelle et
non théorique. L'opérateur qui enchaîne `unused start` puis `unused status`
après un 500 peut recevoir un second 500 sans rapport apparent.

## Le regex `HH:MM` des plages accepte `99:99` : `setHours` déborde et déplace la plage de plusieurs jours, sans erreur

**Gravité** : probable
**Où** : `src/calendar.ts:14-15`, appliqué en `src/calendar.ts:25-30`

```ts
// src/calendar.ts:14-15
from: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
to: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
```

Le regex ne contrôle que « deux chiffres, deux-points, deux chiffres ». Aucune
borne sur 0–23 et 0–59. La valeur part directement dans `setHours`, qui ne
rejette rien et reporte le débordement sur la date :

```ts
// src/calendar.ts:25-30
const [h, m] = hhmm.split(":").map(Number) as [number, number];
const d = new Date(day);
d.setHours(h, m, 0, 0);
```

Scénario concret. Faute de frappe dans `unused.config.json` :
`{"days":["mon"],"from":"08:60","to":"18:00"}`. Le schéma l'accepte, aucun
message. `at(lundi, "08:60")` fait `setHours(8, 60)` → **lundi 09:00**. La plage
annoncée pour 08:00 commence en réalité une heure plus tard, tous les lundis,
et `unused status` affiche 09:00 comme si c'était ce qui était demandé.

Version plus visible du même trou : `"from":"99:99"` est accepté aussi.
`setHours(99, 99)` sur un lundi 00:00 ajoute 99 h + 99 min, soit **le vendredi
suivant 04:39**. Une plage déclarée `days:["mon"]` s'ouvre donc un vendredi.
Comme `occurrences` ne balaie que J-1 à J+7 et trie sur `start`, la plage
existe bien mais le jour déclaré et le jour effectif n'ont plus de rapport.

Attendu : le schéma rejette une heure hors 00:00–23:59, comme son propre
message le laisse croire. Obtenu : décalage silencieux de l'horaire, jusqu'à
plusieurs jours.

## `sleep` du scheduler n'a aucun garde-fou : un backoff supérieur à 24,8 jours se réveille au bout de 1 ms tout en journalisant l'attente complète

**Gravité** : à vérifier
**Où** : `src/scheduler.ts:37`, alimenté par `src/scheduler.ts:114-120`

```ts
// src/scheduler.ts:34-37
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
```

```ts
// src/scheduler.ts:114-120
const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
if (wait <= 0) break;
const untilIso = new Date(nowMs + wait).toISOString();
deps.print(`  quota ... saturé, reprise à ${untilIso} (${formatDuration(wait)})`);
deps.onEvent({ type: "backoff", ms: wait, until: untilIso });
await deps.sleep(wait, signal);
```

`wait` est plafonné par la fin de plage, pas par `TIMEOUT_MAX`. Si `wait`
dépasse 2 147 483 647 ms, `sleep` rend la main au bout de 1 ms alors que la
ligne de log et l'événement `backoff` annoncent l'attente entière : le scheduler
repart aussitôt taper sur un quota saturé, en boucle serrée, et le journal
comme `status` affirment le contraire.

Il faut deux conditions simultanées, d'où la gravité basse : une plage de plus
de 24,8 jours (`until() - nowMs` est le plafond) **et** un `target` du même
ordre. Deux chemins :

- `"backoffMinutes": 40000` (27,8 jours — `.int().positive()` ne borne pas par
  le haut) avec une plage `unused start --for 30d` : `target` = 2,4e9 ms, `wait`
  = 2,4e9 ms > `TIMEOUT_MAX`. Pas de donnée externe nécessaire, uniquement de la
  config.
- `resetsAt` aberrant reçu du flux `claude`. Il est lu sans validation
  (`src/claude.ts:133`, typé `number`, recopié tel quel depuis le JSON), et le
  code suppose des secondes epoch. Un `resetsAt` exprimé en millisecondes
  donnerait `target ≈ 1,77e15 ms`, ramené par le `Math.min` à la longueur de la
  plage — donc débordant dès que celle-ci dépasse 24,8 jours.

Je n'ai pas pu exécuter le scénario : aucun runtime JS n'est présent dans ce
conteneur (`node`, `bun`, `deno` absents), et le déclenchement demande un vrai
rejet de quota. Le calcul et le comportement documenté de `setTimeout` sont en
revanche vérifiables sur pièces.

## Ce qui a été vérifié et tient

- `parseDuration` rejette correctement le vide, le zéro (`total <= 0` attrape
  `"0m"`, `"0h0m"`), le signe négatif (le regex n'accepte pas `-`) et les restes
  non consommés (`last !== s.length` attrape `"8h!"`, `"8x"`). Le regex sticky
  ne peut pas boucler : chaque tour consomme au moins deux caractères. Le seul
  angle mort est le **haut** de l'échelle, traité ci-dessus. La répétition d'une
  unité (`"1h1h"` → 2 h) est tolérée mais additionne correctement.
- `formatDuration` est sûr sur les entrées dégénérées : `Math.max(0, …)` clampe
  le négatif (`-5` → `"0s"`, couvert par le test), et les arrondis aux frontières
  sont justes (`3_599_600` → `"1h00"`, `59_600` → `"1m00s"`). Il rend `"NaNs"`
  sur `NaN`, mais ses deux appelants (`src/scheduler.ts:80` et `:118`) ne sont
  atteignables que derrière un `deadline()` déjà validé non-`NaN`.
- `idle` (`src/daemon.ts:165`) borne bien son `setTimeout` à 2 147 000 000 ms et
  reste en deçà de `TIMEOUT_MAX` ; le `Math.max(0, …)` de la ligne 164 protège
  d'un `next` déjà passé. C'est le site correct des trois.
- L'attente de retry (`src/scheduler.ts:133`) ne peut pas déborder :
  `retrySeconds` est plafonné par la fin de plage et, même à `Infinity` (via un
  `1e400` JSON, que `.nonnegative()` laisse passer), le `Math.min` le ramène à
  la durée restante. `retrySeconds: 0` est géré par le `if (wait > 0)`.
- Le plancher `Math.max(target, 60_000)` du backoff neutralise correctement un
  `resetsAt` déjà passé (`target` négatif → 60 s), et le `if (wait <= 0) break`
  gère une plage expirée pendant l'itération.
- `to === from` donne bien 24 h et non une plage vide (`src/calendar.ts:49` :
  `end <= start` → +1 jour), conforme au commentaire. Une plage permanente
  (7 jours, `00:00`→`00:00`) fusionne sans trou dans `coverageEnd` et rend une
  fin à J+8, recalculée à chaque tour — pas de dégénérescence.
- Les bornes `.int().positive()` de `backoffMinutes`, `maxConsecutiveFailures`
  et `flattenAfterLayers` rejettent `Infinity` et les valeurs nulles ou
  négatives ; seule l'absence de plafond haut de `backoffMinutes` est en cause
  ci-dessus.
- Le décalage horaire (DST) n'a pas été creusé ici : `at()` et `addDays`
  s'appuient sur `setHours`/`setDate`, dont le comportement au passage
  heure d'été est un sujet distinct, déjà partiellement couvert par le
  rapport 007 (heure locale et fusion).
