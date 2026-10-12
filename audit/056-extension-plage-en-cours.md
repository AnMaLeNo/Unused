# 056 — Cumul manuel ↔ calendrier : une plage en cours ne s'étend pas, et la fin annoncée par `start` n'est pas la vraie

**Fichiers examinés** : `src/daemon.ts:71-121` (doc de classe, `deadline`,
`calendarEnd`), `src/daemon.ts:137-226` (`run`, `idle`, `execute`),
`src/daemon.ts:245-250` (`source`), `src/daemon.ts:284-326`
(`startWindow`/`stopWindow`), `src/daemon.ts:328-361` (`status`),
`src/daemon.ts:420-424` (`describeWindow`), `src/scheduler.ts:47-83`,
`src/scheduler.ts:109-139`, `src/calendar.ts:56-78`, `src/api.ts:60-66`,
`src/cli.ts:68-75,96-100,179-181`, `src/daemon.test.ts:96-110,167-192`,
`README.md:94-98`, `unused.config.json`
**Verdict** : 2 constats (2 sûrs)

Le cumul est posé comme une règle d'arithmétique, pas comme un cas particulier.
`README.md:94-96` : « Le démon travaille dès qu'une plage le dit, manuelle
(`start`) ou automatique ; elles se cumulent (une plage manuelle de 1 h à 5 h et
une automatique de 3 h à 10 h font une plage de 1 h à 10 h) ». Même promesse en
tête de classe (`src/daemon.ts:73-74`, « les deux se cumulent ») et en tête de
`runWindow` (`src/scheduler.ts:51-52`, « une plage automatique qui s'ouvre
pendant une plage manuelle la prolonge »). L'union est bien implémentée par
`deadline()` (max des deux bornes, réévalué à chaque tour) et `source()` a même
une valeur `"manual+calendar"`.

Les deux constats ci-dessous disent la même chose de deux côtés : l'union n'est
réellement calculée que si la demande manuelle **précède** la couverture. Une
fois la plage lancée, la borne manuelle ne peut plus ni être posée (constat 1)
ni être lue autrement que comme un max silencieux (constat 2).

## `start` est refusé pendant une plage : le cumul ne fonctionne que dans un sens

**Gravité** : sûr
**Où** : `src/daemon.ts:285`, avec `src/daemon.ts:146-149,177-180,196`

La garde d'entrée refuse toute demande manuelle dès qu'une plage tourne, quelle
que soit son origine :

```ts
// src/daemon.ts:284-285
async startWindow(forMs: number): Promise<{ until: Date }> {
  if (this.running || this.manual) throw new ConflictError("une plage est déjà en cours");
```

Il n'existe aucun autre chemin pour poser une borne manuelle : `this.manual`
n'est écrit qu'ici (`src/daemon.ts:295`) et par la reprise au démarrage
(`src/daemon.ts:101`). Et la borne est figée à l'entrée d'`execute` :

```ts
// src/daemon.ts:177-180
private async execute(manualUntil: Date | null, resumed: boolean): Promise<void> {
  const run: Running = {
    startedAt: this.deps.now(),
    manualUntil,                                   // ← copie, plus jamais relue depuis this.manual
...
// src/daemon.ts:196
    () => this.deadline(run.manualUntil),          // ← la seule borne que le scheduler réévalue
```

Le sens « calendrier prolonge le manuel » marche parce que `deadline()` relit
`calendarEnd(now)` à chaque tour (`src/scheduler.ts:83`). Le sens inverse n'a
aucun support : pendant une plage, la seule réponse possible est un `409`.

Scénario concret avec la config du dépôt (`unused.config.json` : une plage
`mon 00:00 → 13:00`) :

1. lundi 00:00 — la plage automatique démarre seule, `execute(null, false)`,
   `run.manualUntil = null` ;
2. lundi 10:00 — l'opérateur regarde `unused status`, voit les tâches avancer et
   veut pousser jusqu'à 20:00 : `unused start --for 10h`. Obtenu :
   `409 « une plage est déjà en cours »`, code de sortie 3
   (`src/cli.ts:180`). Rien n'est enregistré, rien ne sera rejoué ;
3. lundi 13:00 — fin de couverture. `deadline(null)` retombe sur `now`
   (`src/daemon.ts:120`, `ends` vide), la boucle `run` remet `this.manual = null`
   et part en `idle` ; `nextCalendarStart()` rend **lundi prochain 00:00**.

Obtenu : les 7 heures demandées ne tournent jamais, et le seul instant où
l'opérateur pouvait les demander était *avant* 00:00. Attendu d'après la règle
affichée : une plage manuelle 10:00 → 20:00 cumulée à 00:00 → 13:00, soit
00:00 → 20:00 — exactement l'exemple du README, pris dans l'autre ordre
d'arrivée. Pour un produit dont le but est de ne pas perdre de quota, le défaut
porte sur le geste central.

Le message est trompeur par-dessus : l'utilisateur ne demande pas une seconde
plage concurrente, il demande une borne. Le démon, lui, sait parfaitement
additionner les deux (`deadline` = max) une fois la borne posée.

**Aggravation : le refus survit à la plage.** `this.running` n'est remis à nul
que dans le `finally` d'`execute` (`src/daemon.ts:224`), donc après le retour de
`runWindow` — qui ne sort qu'**entre** deux itérations
(`src/scheduler.ts:83`). Une itération démarrée à 12:59 peut courir jusqu'à
`claude.timeoutMinutes` (180 min dans `unused.config.json`, cf. rapport 030).
Pendant ces trois heures :

- `unused status` affiche `plage manual, jusqu'à <maintenant> (0s restantes)`
  (`src/daemon.ts:335-339`, `src/cli.ts:99`) — la plage est finie ;
- `unused start --for 8h` répond pourtant `409 « une plage est déjà en cours »`.

Les deux réponses se contredisent, et un `start` scripté à 13:05 (cron, ou
l'opérateur qui enchaîne) repart en code 3 sans que rien ne tourne jusqu'au lundi
suivant. Même refus pendant un sommeil quota, qui peut occuper toute la fin de
plage (`src/scheduler.ts:115-120`).

Le rapport 030 avait croisé cette garde et l'avait classée en « tient » sous
l'angle « pas de plage concurrente pendant le débordement » — c'est exact :
aucune course n'est possible. Ce qui est rapporté ici est l'autre moitié : ce
refus est aussi le seul moyen d'exprimer une extension, et il n'en existe pas de
second.

## `start` annonce une fin de plage que le démon remplace dans le même tour

**Gravité** : sûr
**Où** : `src/daemon.ts:294-300`, avec `src/api.ts:64-65` et `src/cli.ts:73-74`

`startWindow` calcule la borne manuelle seule et la rend telle quelle, sans
jamais consulter le calendrier :

```ts
// src/daemon.ts:294-300
const until = new Date(this.deps.now().getTime() + forMs);
this.manual = { until, resumed: false };
this.fatal = null;
this.state.pausedUntil = null;                 // ← la couverture redevient active
await saveState(this.cfg.dataDir, this.state);
this.wake?.();
return { until };                              // ← borne manuelle, pas la borne réelle
```

La boucle réveillée appelle aussitôt `execute`, qui calcule la vraie fin :

```ts
// src/daemon.ts:147-149
if (this.deadline(manualUntil).getTime() > this.deps.now().getTime()) { … await this.execute(manualUntil, resumed); }
// src/daemon.ts:190
this.deps.print(`${resumed ? "reprise de la" : "nouvelle"} plage (${source}) jusqu'à ${this.deadline(manualUntil).toISOString()}`);
```

Le journal du démon est donc juste, et `status` aussi (`src/daemon.ts:335`), mais
la réponse HTTP rendue au client — et la ligne que l'utilisateur lit — sont
fausses dès qu'une couverture calendaire est ouverte :

```ts
// src/api.ts:64-65
const { until } = await daemon.startWindow(parseDuration(body.for));
return sendJson(res, 200, { until: until.toISOString() });
// src/cli.ts:73-74
console.log(`plage démarrée jusqu'à ${r.until}`);
```

Scénario concret, toujours avec `mon 00:00 → 13:00` :

1. lundi 00:30 — l'opérateur arrête la plage automatique : `unused stop`.
   `pausedUntil = deadline(null) = 13:00` (`src/daemon.ts:317`), plus rien ne
   tourne ;
2. lundi 01:00 — il veut une courte reprise de 30 minutes pour vérifier un skill
   qu'il vient de modifier : `unused start --for 30m`. La garde du constat 1
   passe (`running` et `manual` sont nuls), `pausedUntil` est remis à nul
   (ligne 297), `manual = { until: 01:30 }`. Réponse : `200 {"until":"…01:30"}`,
   la CLI imprime `plage démarrée jusqu'à 01:30` ;
3. la boucle enchaîne : `deadline(01:30)` = `max(01:30, coverageEnd(01:00) = 13:00)`
   = **13:00**. Le démon journalise « nouvelle plage (manual+calendar) jusqu'à
   13:00 » et enchaîne les itérations pendant douze heures.

Obtenu : 30 minutes demandées, 24 fois plus consommé, sans un mot au moment de
la demande ; l'opérateur part se coucher sur la foi de `01:30`. Attendu : soit la
borne réelle dans la réponse (`deadline(until)` est à portée de main — même
expression qu'en `src/daemon.ts:190`), soit un refus explicite, soit au minimum
une mention « prolongée par le calendrier jusqu'à 13:00 ». Le seul recours est
`unused stop`, qui remet alors les plages automatiques en pause jusqu'à 13:00
(constat 1 du rapport 042) : il n'existe donc **aucune** façon d'obtenir une
plage manuelle courte à l'intérieur d'une couverture, ni d'être prévenu que la
durée demandée ne sera pas celle appliquée.

L'état accepté est atteignable par toutes les portes normales, pas seulement par
une course : après un `stop` (scénario ci-dessus, c'est exactement le chemin du
test `src/daemon.test.ts:182-191`), après une pause « plus rien à faire » levée
par un `start` (`src/daemon.ts:208-212`), et après réparation d'une panne globale
(`fatal` muselle `calendarEnd`, `src/daemon.ts:124`, puis `start` le remet à nul).

Les tests laissent passer l'écart : `src/daemon.test.ts:100-103` vérifie
`status().window.until === r.until`, égalité qui ne tient que parce que ce test
tourne avec `windows: []` ; le test qui, lui, a un calendrier ouvert
(`src/daemon.test.ts:182-191`) ne regarde que `source` (`"manual+calendar"`) et
jamais la borne rendue par le `POST`.

## Ce qui a été vérifié et tient

- **Le sens implémenté du cumul est correct.** `deadline()` est passée en
  fonction (`src/daemon.ts:196`) et réévaluée à chaque tour de boucle
  (`src/scheduler.ts:83`) : une plage automatique qui s'ouvre pendant une plage
  manuelle la prolonge réellement, y compris après une reprise au démarrage
  (déjà vérifié en rapport 004). `deadline` étant un `max`, le calendrier ne peut
  jamais *raccourcir* une plage manuelle — cherché un chemin où il le ferait
  (pause, panne, couvertures disjointes, `coverageEnd` strict à droite) : il n'y
  en a pas, seul le terme calendaire disparaît.
- **Le `finally` d'`execute` jetterait de toute façon une borne manuelle posée en
  cours de plage** : `if (!run.ac.signal.aborted || run.explicitStop) this.manual = null;`
  (`src/daemon.ts:223`) ne regarde pas si `this.manual` pointe encore vers le
  futur ni s'il s'agit du même objet que `run.manualUntil`. C'est le mécanisme
  déjà observé en rapport 022 (constat 1, via la course sur la garde) et en
  rapport 018 (borne manuelle perdue sur `nothing-eligible`) ; pas recompté ici,
  mais c'est ce qui fait que corriger la seule garde du constat 1 ne suffirait
  pas.
- **Déjà rapporté, non recompté** : l'horizon de `pausedUntil` calculé sur
  `deadline` au lieu de la couverture (002, 042), l'effondrement de
  `deadline(null)` et le `source` qui bascule en `"manual"` après un `stop`
  (002, 042), la branche « plage annoncée, pas encore démarrée » de `status` qui
  annonce `source: "manual"` sous couverture (022, explicitement non comptée là
  non plus), la plage calendaire reprise en manuelle avec une borne figée (004).
- **Déclencheur nouveau d'un défaut connu, même racine, non recompté** : le
  sommeil quota est écrêté par la borne du moment
  (`wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs)`,
  `src/scheduler.ts:115`) et n'est jamais recalculé si la plage s'allonge
  ensuite. Avec un `start --for 2h` le dimanche 23:00 et la config du dépôt :
  rejet quota à 23:10 annonçant un reset à 04:00, sommeil tronqué à 01:00 (borne
  manuelle), puis la couverture du lundi ouvre à 00:00 → au réveil `until()` vaut
  13:00, la boucle relance aussitôt une session que le quota rejette d'entrée
  (container, log, `iterations` et `backoffs` incrémentés pour rien) avant de
  dormir correctement jusqu'à 04:00. C'est la non-persistance / le non-recalcul
  du reset du rapport 043, atteint par l'extension plutôt que par un redémarrage.
- **`describeWindow()`** (`src/daemon.ts:420-424`) formate précisément le temps
  restant réel (`deadline(r.manualUntil) - now`) et n'est appelé de nulle part
  (`grep describeWindow src/` : une seule occurrence) : le formateur honnête que
  le constat 2 réclame existe déjà, mort.
- **Pas de boucle chaude sur la réentrée d'`execute`.** Cherché un cas où
  `runWindow` rend la main avec `deadline` encore dans le futur et où la boucle
  rouvrirait une plage en rafale : `nothing-eligible` pose une pause et/ou
  libère `this.manual`, `fatal` muselle `calendarEnd`, `stopped` passe par
  `explicitStop`. Les trois sorties convergent vers `idle`.
