# 007 — Arithmétique locale des occurrences (changements d'heure, fusion de plages imbriquées, horizon J-1/J+7)

**Fichiers examinés** : `src/calendar.ts:1-78` (intégralement),
`src/calendar.test.ts:1-54`, `src/daemon.ts:98-134` (`deadline`,
`calendarEnd`, `nextCalendarStart`), `src/daemon.ts:136-174` (`run`, `idle`),
`src/daemon.ts:205-244` (`pauseUntil`), `src/daemon.ts:310-320`,
`src/scheduler.ts:56-155` (usage de `until()`), `src/config.ts:32`,
`unused.config.json:18-27`
**Verdict** : 3 constats (1 sûr, 1 probable, 1 à vérifier)

Ni `node` ni aucun autre moteur JS n'est installé dans ce conteneur : les
scénarios ci-dessous ont été déroulés à la main sur le code, pas exécutés. Le
constat 1 n'est que de l'arithmétique entière et ne dépend d'aucune
particularité de moteur ; le constat 2 dépend de la façon dont V8 résout une
heure locale inexistante, d'où sa gravité moindre.

## Une plage imbriquée dans une plage plus longue tronque la couverture

**Gravité** : sûr
**Où** : `src/calendar.ts:65`

`coverageEnd` parcourt les occurrences triées par début et écrase `end` dès
qu'une occurrence contient `now` :

```ts
const inside = s.start.getTime() <= now.getTime() && now.getTime() < s.end.getTime();
const extends_ = end !== null && s.start.getTime() <= end.getTime() && s.end.getTime() > end.getTime();
if (inside || extends_) end = s.end;
```

La branche `extends_` protège bien contre un recul (`s.end > end` exigé), mais
la branche `inside` n'a aucune garde : une occurrence qui contient `now` impose
sa fin **même si elle est antérieure à la fin déjà calculée**. Ce n'est pas une
fusion d'intervalles, c'est un « dernier qui parle a raison » parmi les
occurrences qui contiennent `now`. Comme le tri se fait sur `start`, la plage la
plus courte passe en dernier dès qu'elle commence plus tard — le cas exact d'une
plage imbriquée.

Scénario concret, avec deux plages du même jour dont l'une est incluse dans
l'autre :

```json
"windows": [
  { "days": ["wed"], "from": "20:00", "to": "06:00" },
  { "days": ["wed"], "from": "21:00", "to": "22:00" }
]
```

`now` = mercredi 21:30. `occurrences` produit, triées :

| # | occurrence                    | `inside` | `extends_` | `end` après |
|---|-------------------------------|----------|------------|-------------|
| A | `[mer 20:00, jeu 06:00)`      | vrai     | —          | **jeu 06:00** |
| B | `[mer 21:00, mer 22:00)`      | vrai     | faux       | **mer 22:00** |

`coverageEnd` rend **mercredi 22:00** au lieu de jeudi 06:00. La plage B, qui
ne fait qu'ajouter du recouvrement à l'intérieur de A, **raccourcit** la
couverture de huit heures.

Conséquences en cascade :

- `daemon.deadline` (`src/daemon.ts:116-120`) retient ce 22:00 ; `runWindow`
  annonce `plage jusqu'à …22:00` (`src/scheduler.ts:80`) et écrit
  `state.window.until = 22:00` (`src/scheduler.ts:78`) — un état faux, qui est
  aussi celui relu au redémarrage (`src/daemon.ts:98-107`).
- À 22:00 la boucle de `runWindow` sort (`endedBecause: "window"`), le résumé de
  fin est émis, `state.window` est remis à `null`, puis `run()` recalcule
  `deadline` : à 22:00 l'occurrence B ne contient plus `now`, `coverageEnd` rend
  jeu 06:00 et une **seconde plage** démarre. Le travail reprend, mais la plage
  est coupée en deux, les compteurs (`iterations`, `completed`, `costUsd`,
  `lastWindow`) sont repartis de zéro et deux résumés de fin sont affichés pour
  une seule nuit.
- `nextStart` (`src/calendar.ts:71-77`) prend ce `cover` tronqué comme `floor`
  et peut donc annoncer un début **situé à l'intérieur de la couverture encore
  en cours** — contrairement à ce que promet son commentaire « hors couverture
  en cours ». Avec une troisième plage `{"wed","23:00"→"23:30"}`, `floor` vaut
  mer 22:00 et `nextStart` rend mer 23:00, alors que la couverture court sans
  interruption jusqu'à jeu 06:00. C'est le message affiché au démarrage
  (`src/daemon.ts:110-111`) et le délai du `setTimeout` d'`idle`
  (`src/daemon.ts:165-167`).
- `pauseUntil` (`src/daemon.ts:211`, `:216`) et l'arrêt explicite
  (`src/daemon.ts:317`) enregistrent `pausedUntil = deadline(...)`, donc la fin
  tronquée : la pause « plus rien à faire » se lève huit heures trop tôt.

Les tests ne couvrent que des chaînes qui avancent
(`src/calendar.test.ts:33-42` : 22:00→01:00, puis 00:30→04:00, puis
04:00→06:00, toutes de fin croissante), jamais une plage incluse dans une autre.
Un vrai balayage de fusion (`end = new Date(Math.max(end, s.end))` sur les
occurrences contiguës) ferait disparaître le problème.

## Le passage à l'heure d'été peut inverser une plage et l'étirer sur 24 h

**Gravité** : probable
**Où** : `src/calendar.ts:25-30` et `src/calendar.ts:49`

`at()` construit l'heure avec `d.setHours(h, m, 0, 0)`, sans vérifier que
l'heure locale demandée existe. Le dimanche du passage à l'heure d'été (par
exemple `Europe/Paris`, 2026-03-29 : 02:00 → 03:00), les heures locales de
02:00 à 02:59 n'existent pas. ECMA-262 résout un tel « trou » avec le décalage
**d'avant** la transition, donc `setHours(2, 30)` sur ce jour donne 01:30 UTC,
c'est-à-dire 03:30 locale — l'heure est poussée en avant, silencieusement.

`occurrences` compare ensuite les deux instants pour décider si la plage passe
minuit :

```ts
const start = at(day, spec.from);
let end = at(day, spec.to);
if (end.getTime() <= start.getTime()) end = addDays(end, 1);
```

Avec `{ "days": ["sun"], "from": "02:30", "to": "03:00" }` sur le 2026-03-29 :

- `start` = 02:30 locale inexistante → **01:30 UTC** (03:30 locale) ;
- `end` = 03:00 locale, qui existe → **01:00 UTC** (03:00 locale) ;
- `end <= start` est donc vrai alors que l'utilisateur n'a décrit aucune plage
  de nuit → `end` est repoussé au **lundi 03:00**.

Une plage de trente minutes devient une plage de 23 h 30. Le démon lance une
`plage jusqu'à <lundi 03:00>`, brûle du quota toute la journée du dimanche, et
`state.window.until` porte cette date. Le même mécanisme s'applique à toute
plage dont `from` tombe dans le trou et dont `to` est au plus l'heure de fin du
trou (`02:00`→`03:00`, `02:15`→`02:45`, `02:30`→`03:00`…).

Le cas symétrique — `from` dans le trou et `to` bien après (`02:00`→`07:00`) —
ne produit qu'un raccourcissement d'une heure, ce qui est le comportement
attendu d'une plage exprimée en heure locale : ce n'est pas un défaut. Le
retour à l'heure d'hiver (heure locale ambiguë, jouée deux fois) allonge
symétriquement la plage d'une heure, ce qui est également cohérent avec une
sémantique locale.

Ce constat est marqué « probable » parce que je n'ai pas pu exécuter le code
pour confirmer la résolution du trou par V8 ; l'inversion `end <= start` en
découle en revanche mécaniquement.

## Le format `HH:MM` accepte des heures impossibles, qui cassent l'horizon J-1

**Gravité** : à vérifier
**Où** : `src/calendar.ts:14-15`

Le schéma annonce « heure attendue au format HH:MM » mais ne contraint que le
nombre de chiffres :

```ts
from: z.string().regex(/^\d{2}:\d{2}$/, "heure attendue au format HH:MM"),
```

`"99:99"`, `"36:00"` ou `"24:00"` passent la validation, et `setHours` les
normalise en silence en débordant sur les jours suivants. Cela casse
l'invariant documenté en tête de fichier (« Une plage ne dépasse pas 24 h »),
sur lequel repose l'horizon de `occurrences` : la boucle ne remonte qu'à
`offset = -1` (`src/calendar.ts:41`), donc seule une plage démarrée il y a moins
de ~24 h peut être retrouvée.

Scénario : `{ "days": ["mon"], "from": "08:00", "to": "60:00" }`. L'occurrence
va du lundi 08:00 au mercredi 12:00. Le mercredi à 06:00, `occurrences`
n'énumère que mardi (J-1) à mercredi+7 : l'occurrence du lundi n'est jamais
construite, `coverageEnd` rend `null` et le démon reste au repos alors que sa
propre configuration décrit une couverture en cours. Le même jour à 23:00 la
plage est au contraire bien vue (elle démarre à J-1), d'où un comportement qui
s'allume et s'éteint sans raison visible.

Marqué « à vérifier » parce qu'il faut une configuration écrite à la main et
manifestement erronée pour l'atteindre : la question ouverte est de savoir si
`unused` doit refuser ces valeurs (`(?:[01]\d|2[0-3]):[0-5]\d`) plutôt que de
les normaliser sans le dire.

## Ce qui a été vérifié et tient

- **Horizon J-1/J+7 pour les plages conformes** : tant qu'une plage ne dépasse
  pas 24 h, `offset = -1` suffit à retrouver l'occurrence en cours lancée la
  veille (nuit `23:00`→`07:00` vue à 03:00, cas testé en
  `src/calendar.test.ts:22-26`), et `offset ≤ 7` garantit qu'une plage
  hebdomadaire a toujours une occurrence future (`nextStart` ne rend `null` que
  si `specs` est vide ou ne contient aucun jour — vérifié pour le cas samedi
  depuis un samedi soir, `src/calendar.test.ts:44-48`).
- **`addDays`** utilise `setDate`, qui préserve l'heure locale murale à travers
  un changement d'heure : `23:00` + 1 jour reste `23:00` locale, ce qui est le
  comportement voulu pour des plages exprimées en heure locale.
- **Bornes de `inside`** : début inclus, fin exclue, conforme au commentaire et
  aux tests (`src/calendar.test.ts:28-31`) ; deux plages jointives (`…→04:00`
  puis `04:00→…`) fusionnent bien via `extends_` (`s.start <= end`).
- **`nextStart` depuis une pause future** : `pauseUntil` et l'arrêt explicite
  passent toujours `deadline(...)`, c'est-à-dire une fin de couverture, jamais
  un instant strictement intérieur à une plage. `pausedUntil` retombe donc sur
  une borne où `inside` est faux (fin exclue) et `nextStart` rend bien le
  démarrage suivant — sauf si la fin en question a été tronquée par le constat 1.
- **`occurrences` est sans effet de bord** : `at` et `addDays` copient la date
  reçue, `now` n'est jamais muté malgré les `setHours`/`setDate`.
