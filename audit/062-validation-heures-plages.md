# 062 — Validation des entrées : bornes `HH:MM`, `from === to`, jours dupliqués

**Fichiers examinés** : `src/calendar.ts:1-54` (`WindowSpecSchema`, `at`,
`occurrences`), `src/config.ts:8-78` (schéma complet, `loadConfig`),
`src/calendar.test.ts:10-15`, `src/daemon.ts:115-135`,
`src/scheduler.ts:70-85`, `README.md:83-98`, `unused.config.json:18-26`.
Rapports antérieurs relus pour ne pas les redire : 007, 013, 028, 061.
**Verdict** : 1 constat (sûr) — une conséquence nouvelle et plus grave d'un
trou déjà rapporté en 013/007 ; les deux autres pistes de l'angle
(`from === to`, jours dupliqués) ont été vérifiées et ne sont pas des défauts.

Aucun moteur JS dans ce conteneur (`node` absent) : le scénario ci-dessous est
déroulé à la main. Il n'est que de l'arithmétique entière
(`Date.prototype.setHours` appelle `MakeTime` **sans borner** ses arguments,
puis reporte le dépassement sur la date) et ne dépend ni du fuseau ni d'un
changement d'heure.

## Un dépassement de minutes dans `from` n'est pas un décalage, il inverse la plage et en fait une plage de 24 h

**Gravité** : sûr
**Où** : `src/calendar.ts:14` (le regex), `src/calendar.ts:25-30` (`at`),
`src/calendar.ts:49` (le test d'inversion)

Le regex ne borne que le nombre de chiffres, et la valeur part telle quelle
dans `setHours` :

```ts
from: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),   // :14
…
d.setHours(h, m, 0, 0);                                                      // :28
```

Posons `F = 60·h_from + m_from` et `T = 60·h_to + m_to`, en minutes depuis le
minuit local du jour traité : `at(day, …)` rend exactement `minuit + F` et
`minuit + T`, quelles que soient les valeurs. `occurrences` interprète ensuite
`end ≤ start` comme « la plage passe minuit » :

```ts
const start = at(day, spec.from);
let end = at(day, spec.to);
if (end.getTime() <= start.getTime()) end = addDays(end, 1);                 // :49
```

Rien ne distingue « l'utilisateur a décrit une plage de nuit » de « la
normalisation a poussé `start` au-delà de `end` ». Dès que le débordement
franchit `to` (`F ≥ T`), la plage obtenue ne dure pas `T − F` mais
**`T + 1440 − F` minutes**, c'est-à-dire presque 24 h pour tout petit
débordement.

Scénario concret, avec exactement la faute de frappe déjà citée en 013 — mais
un `to` juste après l'heure voulue au lieu de `18:00` :

```json
"windows": [ { "days": ["mon"], "from": "08:60", "to": "09:00" } ]
```

* `F = 8·60 + 60 = 540` → `start` = lundi **09:00** ;
* `T = 9·60 = 540` → `end` = lundi 09:00 ;
* `end ≤ start` est vrai → `end` = **mardi 09:00** ;
* occurrence retenue : `[lundi 09:00, mardi 09:00)`, soit **24 h**.

Attendu : soit un refus au démarrage (le message du schéma, « heure attendue au
format HH:MM », le laisse croire), soit la plage d'une heure décrite
(08:00→09:00). Obtenu : une plage de 24 h, qui couvre tout le lundi et la
matinée du mardi — un jour que la config ne déclare pas. Facteur 24 sur le
quota consommé, pour un chiffre de trop.

Même mécanisme avec `"from": "07:70"` / `"to": "08:00"` : `F = 490`, `T = 480`
→ `[lundi 08:10, mardi 08:00)`, 23 h 50 au lieu des ~50 min visées.

En aval, rien ne rattrape la valeur : `daemon.deadline` (`daemon.ts:116-120`)
retient cette fin, `runWindow` annonce « plage jusqu'à <mardi 09:00> » et écrit
`state.window.until` (`scheduler.ts:78-80`) — donc la plage est aussi reprise
telle quelle après un redémarrage (`daemon.ts:98-107`) — et un `stop` enregistre
`pausedUntil` = mardi 09:00 (`daemon.ts:211-216`). Aucun de ces points ne
compare la durée obtenue au jour déclaré.

Différence avec ce qui était déjà écrit :

* **013** décrit le même trou de validation, avec `{"from":"08:60","to":"18:00"}`
  → « la plage commence une heure plus tard », et le classe *probable*. Ici la
  cause est la même mais la conséquence change de nature (24 h au lieu d'une
  heure de retard), et elle est purement arithmétique, d'où *sûr*.
* **007** montre le cas inverse, `to` hors bornes (`"60:00"`), qui fabrique une
  plage **de plus de 24 h** et casse l'horizon J-1 d'`occurrences`. Ici la
  plage reste ≤ 24 h — l'invariant du commentaire d'en-tête
  (`calendar.ts:9`) est respecté, l'horizon tient, le dégât est la durée.
* **061** signalait l'angle sans le dérouler.

À noter pour le correctif : le test de format existant vérifie les refus de
`"23h"` et `"lun"` (`calendar.test.ts:13-14`) mais aucune valeur numérique hors
bornes, ce qui donne l'impression que les heures sont validées. Un regex
`^(?:[01]\d|2[0-3]):[0-5]\d$` ferme les trois variantes (`24:00`, `07:70`,
`99:99`) d'un coup.

## Ce qui a été vérifié et tient

* **`from === to` → 24 h : conforme, pas un défaut.** Le commentaire d'en-tête
  documente explicitement la règle (« `to` ≤ `from` signifie le lendemain »,
  `calendar.ts:8-9`) ; `{"from":"09:00","to":"09:00"}` donne
  `[lundi 09:00, mardi 09:00)`, soit exactement 1440 min, ce qui respecte aussi
  « une plage ne dépasse pas 24 h ». Conséquence assumée : il n'existe aucune
  façon d'écrire une plage vide, mais rien en aval ne suppose une plage plus
  courte que 24 h, et une config `7 jours × from === to` donne simplement un
  fonctionnement permanent — les occurrences de jours consécutifs sont
  jointives et fusionnent correctement par la branche `extends_`
  (`s.start <= end`, `calendar.ts:64`).
* **Jours dupliqués : inoffensif.** `days: ["mon","mon"]` passe le schéma, mais
  `occurrences` itère sur les **jours du calendrier** (`offset` de −1 à 7) et
  n'interroge `spec.days` que par `includes` (`calendar.ts:46`), un test
  d'appartenance : un spec produit au plus une occurrence par jour. Deux specs
  strictement identiques produisent bien deux occurrences jumelles, mais
  `coverageEnd` y est idempotent (`inside` repose la même fin ; `extends_`
  exige `s.end > end`, faux).
* **Le reste du regex est correct** : ancré aux deux bouts, donc `"7:00"`,
  `" 07:00"`, `"07:00 "` et `"07:00:00"` sont refusés ; deux chiffres de chaque
  côté interdisent le champ vide et le signe, si bien que le cast
  `as [number, number]` de `calendar.ts:26` ne peut pas produire de `NaN`.
* **`days`** : `z.enum(DAYS)` + `.nonempty()` refusent bien `[]`, `"lun"` et
  `"Mon"` (couvert par `calendar.test.ts:12-14`), et la correspondance
  `DAYS[day.getDay()]` est juste (indice 0 → `"sun"`).
* **`config.ts`** : rien de neuf sur cet angle. Le plafond manquant de
  `claude.timeoutMinutes` appartient à 013, l'absence de `.strict()` sur les
  sous-objets à 028 ; `windows` est bien un tableau d'objets stricts et son
  défaut `[]` rend le calendrier optionnel sans piège.
