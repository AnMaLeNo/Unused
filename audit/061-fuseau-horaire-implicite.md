# 061 — angle fuseau horaire : plages en heure locale implicite, tout relu en UTC, TZ ni vérifié ni rapporté

**Fichiers examinés** : `src/calendar.ts:6-54` (`at`, `addDays`, `occurrences`),
`src/calendar.ts:56-78` (`coverageEnd`, `nextStart`), `src/config.ts:29-31`,
`src/daemon.ts:96-135,160-175,228-236,328-373`, `src/scheduler.ts:74-120`,
`src/cli.ts:65-110`, `src/api.ts:60-66`, `src/calendar.test.ts`,
`deploy/unused.service`, `deploy/install.sh`, `docker/`, `README.md:84-99`
**Verdict** : 2 constats (1 sûr, 1 probable)

Le contrat est explicite : les plages sont écrites **en heure locale de la
machine** (`src/config.ts:30`, `src/calendar.ts:8`, `README.md:85`), et tout le
calcul s'y conforme — `at()` utilise `setHours`, `occurrences` lit
`day.getDay()`, `addDays` utilise `setDate` : de l'arithmétique d'horloge
murale, cohérente. Le problème est aux deux bouts de cette chaîne : la
*décision* « `to` ≤ `from` → le lendemain » est prise sur des epochs et non sur
l'horloge murale (constat 1), et la *restitution* est intégralement en UTC sans
que le fuseau soit jamais nommé, vérifié ni affiché (constat 2).

Vérification faite : aucune occurrence de `TZ`, `getTimezoneOffset`,
`toLocaleString` ou `Intl` dans tout le dépôt (`src/`, `deploy/`, `docker/`) —
seulement 28 appels à `toISOString()`.

```
$ grep -rn "toLocale\|getTimezoneOffset\|process.env.TZ\|Intl" src deploy docker
(aucun résultat)
```

## Au passage à l'heure d'été, une plage de 30 min devient une plage de 23 h 30

**Gravité** : probable
**Où** : `src/calendar.ts:49`

```ts
const start = at(day, spec.from);
let end = at(day, spec.to);
if (end.getTime() <= start.getTime()) end = addDays(end, 1);   // ligne 49
```

Le commentaire du schéma (`src/calendar.ts:8`) énonce la règle en termes
d'horloge murale : « `to` ≤ `from` signifie le lendemain ». La ligne 49
l'implémente en comparant des **epochs**. Les deux coïncident 363 jours sur
365, parce que la conversion heure locale → epoch est croissante. Elle ne
l'est pas le jour du passage à l'heure d'été : l'heure locale sautée n'a pas
d'epoch, et `setHours` la reporte *en avant* d'une heure (comportement legacy
de `Date`, celui que `Temporal` a repris sous le nom `disambiguation:
"compatible"`). La fonction `at()` devient donc **non monotone** autour de la
transition, et l'inégalité de la ligne 49 s'inverse sans qu'aucun jour ne soit
réellement franchi.

Données de la transition, confirmées sur la base de fuseaux du container :

```
$ zdump -v -c 2026,2027 Europe/Paris
Europe/Paris  Sun Mar 29 00:59:59 2026 UT = Sun Mar 29 01:59:59 2026 CET  gmtoff=3600
Europe/Paris  Sun Mar 29 01:00:00 2026 UT = Sun Mar 29 03:00:00 2026 CEST gmtoff=7200
```

L'heure locale `[02:00, 03:00)` du 29 mars 2026 n'existe pas. D'où, sur une
machine en `Europe/Paris` :

| `at(2026-03-29, x)` | offset appliqué | epoch obtenu |
|---|---|---|
| `"02:30"` (sautée, reportée à 03:30 CEST) | +01:00 | **01:30 UTC** |
| `"03:00"` (existe, CEST) | +02:00 | **01:00 UTC** |

Scénario concret. Configuration :

```json
"windows": [{ "days": ["sun"], "from": "02:30", "to": "03:00" }]
```

* Attendu : une plage de **30 minutes** le dimanche — et le 29 mars, une plage
  vide ou décalée, puisque 02:30 n'existe pas.
* Obtenu : `start` = 01:30 UTC, `end` = 01:00 UTC. Ligne 49 :
  `end <= start` → vrai → `end = addDays(end, 1)` → lundi 30 mars 03:00 locale
  = 01:00 UTC. La plage retournée dure **23 h 30**.

Ce n'est pas une valeur cosmétique : `coverageEnd` (`src/calendar.ts:56-68`)
rend cette fin au démon, qui en fait la deadline de `runWindow`
(`src/daemon.ts:116-121,196`), et `runWindow` boucle `while (deps.now() <
until())` (`src/scheduler.ts:86`). Le démon enchaîne donc les itérations
Claude pendant une journée entière au lieu d'une demi-heure, et
`pauseUntil(this.deadline(...))` (`src/daemon.ts:211,317`) propagerait la même
borne fausse dans `state.pausedUntil`.

La condition de déclenchement, générale : `from` dans l'heure locale sautée et
`to` dans `[fin de la transition, from + 1 h]`. Pour Paris, `from ∈ [02:00,
03:00)` et `to ∈ ["03:00", from+1h]`. Le cas limite `from: "02:00", to:
"03:00"` — une plage d'une heure, formulation parfaitement naturelle — donne
`start = end = 01:00 UTC`, donc `end <= start`, donc exactement **24 h** de
plage. Le même mécanisme vaut partout où l'heure sautée est franchie :
`America/Santiago` saute `[00:00, 01:00)` le 6 septembre 2026 (zdump ci-dessous),
ce qui touche le `from: "00:00"` de la config livrée.

```
America/Santiago  Sun Sep  6 03:59:59 2026 UT = Sat Sep  5 23:59:59 2026 -04
America/Santiago  Sun Sep  6 04:00:00 2026 UT = Sun Sep  6 01:00:00 2026 -03
```

Pourquoi « probable » et non « sûr » : le container d'audit n'a pas de runtime
JS (`node`, `tsx`, `bun` absents), je n'ai donc pas pu exécuter `occurrences`.
Le raisonnement repose sur deux éléments vérifiés — la table de transition
ci-dessus (zdump, données réelles du container) et la règle de désambiguïsation
de `Date.prototype.setHours` pour une heure locale sautée (report en avant).
Si cette seconde règle était inversée dans une implémentation donnée,
l'inversion ne se produirait pas. À confirmer en une commande :

```bash
TZ=Europe/Paris node -e '
  const {occurrences} = require("./dist/calendar.js");
  const s = [{days:["sun"],from:"02:30",to:"03:00"}];
  for (const o of occurrences(s, new Date(2026,2,29,12)))
    if (o.start.getDate() === 29)
      console.log(o.start.toString(), "→", o.end.toString(),
                  (o.end-o.start)/3600000 + "h");'
```

Note secondaire, même racine, gravité *à vérifier* : au passage à l'heure
d'hiver l'heure locale est **répétée** (`[02:00, 03:00)` le 25 octobre 2026 à
Paris, cf. zdump) et `at()` en choisit une des deux occurrences — la première
(CEST) avec la désambiguïsation legacy. Pas d'inversion ici : `at()` reste
croissante, donc pas de plage de 24 h. Mais une plage `02:30 → 04:00` démarre
à 02:30 CEST et finit à 04:00 CET, soit **2 h 30 au lieu de 1 h 30**. Une
heure de travail en trop, une fois par an : réel, mais sans commune mesure
avec le constat ci-dessus.

## Configuration en heure locale, restitution intégralement en UTC, fuseau jamais affiché

**Gravité** : sûr
**Où** : `src/daemon.ts:111`, `src/cli.ts:105`, `deploy/unused.service`

L'utilisateur écrit ses plages en heure locale (`src/config.ts:30`). Tout ce
qu'il peut lire en retour est sérialisé par `toISOString()`, donc en UTC avec
suffixe `Z`, et jamais accompagné du fuseau employé pour le calcul :

* `src/daemon.ts:102` (reprise de plage), `:111` (prochaine plage automatique),
  `:190` (ouverture de plage), `:233,235` (pause), `:206` (panne) — les logs
  du service ;
* `src/daemon.ts:337-349,364-366` → `src/api.ts:60` → `src/cli.ts:90-105` —
  tout `unused status`, y compris `nextCalendarStart` et `pausedUntil` ;
* `src/scheduler.ts:78,80,95,117`, `src/iterate.ts:113,196-197,220`,
  `src/graph.ts:79` — le journal d'itérations et `state.json`.

Aucun de ces points n'affiche l'heure locale, le nom du fuseau ou le décalage.
Le calcul interne, lui, est cohérent (local en entrée, local en sortie) : le
défaut est de **diagnosticabilité**, et il est total.

Scénario concret, avec la configuration livrée dans `unused.config.json`
(`{"days": ["mon"], "from": "00:00", "to": "13:00"}`), un vendredi de janvier :

* Pi correctement réglé sur `Europe/Paris` (UTC+1) : la plage visée est bien
  lundi 19 janvier 00:00 → 13:00 locales. `unused status` affiche
  `prochaine plage automatique 2026-01-18T23:00:00.000Z` — un **dimanche**.
* Pi resté sur le fuseau par défaut d'une installation Raspberry Pi OS neuve
  (`Etc/UTC`, jusqu'à ce que `raspi-config` ou `timedatectl set-timezone` le
  change) : la plage tourne en réalité lundi 02:00 → 15:00 locales, deux
  heures à côté en été. `unused status` affiche
  `prochaine plage automatique 2026-01-19T00:00:00.000Z` — un **lundi**.

Le diagnostic est donc *inversé* : l'affichage est rassurant (le bon jour de
la semaine, la bonne heure ronde) exactement dans la configuration cassée, et
déroutant (un dimanche à 23 h pour une plage du lundi) dans la configuration
correcte. Un opérateur qui vérifie son réglage à partir de `status` conclura à
l'envers.

Rien ne rattrape cela en amont :

* `deploy/unused.service` ne contient aucun `Environment=TZ=` ; le fuseau du
  démon est celui de `/etc/localtime`, hérité implicitement. Le seul apport
  d'environnement est `EnvironmentFile=/opt/unused/.env`, destiné au token.
* `deploy/install.sh` vérifie `node`, `docker`, le dépôt, le `.env` — mais
  n'affiche ni ne contrôle jamais le fuseau, alors que c'est le seul endroit
  où un avertissement serait vu (« fuseau de la machine : UTC — les plages de
  `unused.config.json` seront interprétées dans ce fuseau »).
* `loadConfig` (`src/config.ts:50-70`) valide les formats et résout les
  chemins, sans jamais relever le fuseau sous lequel les plages vont être
  interprétées.
* `Daemon.init()` (`src/daemon.ts:109-112`) est précisément l'endroit qui
  annonce `N plage(s) automatique(s), prochaine le <ISO UTC>` : une ligne qui
  nomme le fuseau et donne l'heure locale y lèverait toute l'ambiguïté.

## Ce qui a été vérifié et tient

* **Plages manuelles** : aucune exposition au fuseau. `unused start --for 8h`
  passe par `parseDuration` (`src/cli.ts:66-72`, `src/api.ts:62-65`) et
  `startWindow` calcule `now + forMs` (`src/daemon.ts:294`) — une durée, jamais
  une heure murale. Il n'existe aucun `--until HH:MM` à mal interpréter.
* **Allers-retours par `state.json`** : `state.window.until`,
  `state.pausedUntil` et les horodatages de `graph.ts` sont écrits en ISO UTC
  puis relus par `new Date(iso)` (`src/daemon.ts:99,125,132,362`). L'epoch est
  préservé exactement ; aucune perte de sens au redémarrage du service, y
  compris si le fuseau de la machine change entre deux lancements.
* **Attentes et minuteurs** : `idle()` (`src/daemon.ts:161-175`) et les
  `sleep` du scheduler (`src/scheduler.ts:113-120,141`) calculent des durées
  par différence d'epochs, et les timers Node reposent sur l'horloge monotone
  de la boucle. Un changement d'heure pendant une attente ne décale donc pas le
  réveil — le démon se réveille bien à l'instant promis.
* **Arithmétique d'horloge murale sur les nuits ordinaires** : testé à la main
  sur les deux transitions parisiennes de 2026 avec la plage de référence
  `23:00 → 07:00` (`README.md:89`). Nuit du 28 au 29 mars : 7 h au lieu de 8
  (l'heure sautée). Nuit du 24 au 25 octobre : 9 h. C'est le comportement juste
  pour une plage exprimée en heure murale — `addDays` via `setDate` est le bon
  outil ici, le constat 1 ne porte **que** sur la non-monotonie de `at()`.
* **Containers** : aucun réglage de fuseau dans `docker/`, mais les plages sont
  entièrement calculées côté hôte et rien dans `iterate.ts` ne compare un
  horodatage produit dans le container à un horodatage de l'hôte. Hors sujet
  pour cet angle.
* **Tests** : `src/calendar.test.ts` construit ses dates avec
  `new Date(2026, 8, 16, h, m)` — donc en heure locale, cohérent avec le code
  testé — mais choisit une semaine de septembre sans transition et ne fixe pas
  `TZ` (ni `package.json`, ni un `vitest.config`, absent). Les tests passent
  dans n'importe quel fuseau sans en couvrir aucune transition : ils ne
  pouvaient pas attraper le constat 1.

**Piste pour un cycle « validation des entrées », hors de cet angle** : le
regex `^\d{2}:\d{2}$` (`src/calendar.ts:14-15`) ne borne ni les heures ni les
minutes. `from: "25:00"`, `"07:70"` ou `"99:99"` passent la validation, et
`setHours` les normalise silencieusement — `{"days": ["mon"], "from": "24:00",
"to": "06:00"}` produit une plage le **mardi** 00:00 → 06:00, sans erreur. Même
mécanisme que le constat 1 (une normalisation de `Date` qui déplace une plage
d'un jour local), mais c'est un défaut de validation, pas de fuseau.
