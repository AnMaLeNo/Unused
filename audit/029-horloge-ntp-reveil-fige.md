# 029 — Horloge fausse au démarrage (Pi sans RTC) et saut NTP : réveil calendrier figé, plage reprise à tort

**Fichiers examinés** : `src/daemon.ts:88-113`, `src/daemon.ts:115-175`,
`src/daemon.ts:177-226`, `src/daemon.ts:328-373`, `src/calendar.ts:25-78`,
`src/scheduler.ts:34-45`, `src/scheduler.ts:77-121`, `src/iterate.ts:112-146`,
`src/iterate.ts:196-220`, `src/log.ts:42-48`, `src/state.ts:22-33`,
`src/docker.ts:132`, `deploy/unused.service`, `deploy/install.sh`,
`unused.config.json`
**Verdict** : 4 constats (2 sûrs, 2 probables)

Le terrain visé par le projet est un Raspberry Pi (README, `deploy/`). Un Pi
n'a pas d'horloge sauvegardée : au démarrage, le noyau part de l'epoch, puis
`fake-hwclock` ou `systemd-timesyncd` remonte la date au **dernier instant
connu** — c'est-à-dire, après une coupure de courant, à peu près l'heure de la
coupure. La vraie heure n'arrive qu'à la première réponse NTP, sous la forme
d'un **saut** (step) de la durée de la panne. L'unité systemd ne demande rien
de plus que le réseau :

```ini
After=network-online.target docker.service
Wants=network-online.target
```

`network-online.target` ne dit rien de l'horloge (il faudrait
`After=time-sync.target` + `Wants=time-sync.target`, avec
`systemd-time-wait-sync` activé). Le démon démarre donc, normalement, avec une
horloge en retard de toute la durée de l'arrêt, et la voit sauter quelques
secondes plus tard. Tout le reste de ce rapport découle de là : le code prend
ses décisions et arme ses minuteries sur cette horloge-là, et rien ne les
réévalue quand elle saute.

Point d'appui technique commun aux constats 1 et 3 : les minuteries de Node
(`setTimeout`) reposent sur l'horloge **monotone** de libuv (`CLOCK_MONOTONIC`
sous Linux). Un `settimeofday` / step NTP ne les décale pas : un
`setTimeout(6 h)` armé avant le saut se déclenche bien 6 h de temps réel plus
tard, quelle que soit la date affichée entre-temps. C'est le bon comportement
pour une durée, c'est le mauvais pour un rendez-vous calendaire.

## 1. Le réveil de la prochaine plage est armé une fois pour toutes, sur l'horloge d'avant NTP : la plage est sautée en silence

**Gravité** : sûr
**Où** : `src/daemon.ts:161-175` (calcul de `ms` ligne 164, minuterie ligne
165), alimenté par `src/daemon.ts:145-153`, `deploy/unused.service:7-8`

```ts
  private idle(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const next = this.fatal ? null : this.nextCalendarStart();
      const ms = next ? Math.max(0, next.getTime() - this.deps.now().getTime()) : null;
      const timer = ms !== null ? setTimeout(done, Math.min(ms, 2_147_000_000)) : null;
```

`ms` est une **différence de dates murales** convertie en **durée monotone**.
La conversion n'est valable que si l'horloge ne bouge pas d'ici l'échéance.
Une fois la minuterie armée, plus rien ne la réévalue : les seuls autres
réveils sont `this.wake?.()`, appelé par `startWindow` (`daemon.ts:299`),
`unpause` (`daemon.ts:242`) et l'abort (`daemon.ts:141`). Aucun battement
périodique, aucune surveillance du saut d'horloge.

Scénario concret, avec la config livrée dans le dépôt
(`unused.config.json` : `windows: [{ days: ["mon"], from: "00:00", to: "13:00" }]`,
une seule plage hebdomadaire de 13 h) :

1. Coupure de courant le dimanche 18:05. `fake-hwclock.data` a été écrit à
   18:00 (cron horaire).
2. Le courant revient le **lundi 07:50**. Le Pi démarre, l'horloge affiche
   **dimanche 18:00** (retard Δ = 13 h 50). `unused.service` démarre dès
   `network-online.target`, avant la synchro.
3. `init()` : `nextCalendarStart()` depuis dimanche 18:00 → **lundi 00:00**.
   Le démon annonce « 1 plage(s) automatique(s), prochaine le lundi 00:00 ».
4. `run()` : `deadline(null)` → `coverageEnd(dim. 18:00)` = `null`, donc
   `idle()`. `ms = 6 h 00` → `setTimeout(21_600_000)`.
5. Quinze secondes plus tard, `systemd-timesyncd` obtient l'heure et saute à
   **lundi 07:50**. La plage est ouverte depuis 00:00 et se ferme à 13:00 :
   **5 h 10 de plage disponibles, tout de suite**.
6. La minuterie, monotone, se déclenche 6 h de temps réel après le démarrage,
   soit **lundi 13:50**. `deadline()` est alors recalculé :
   `coverageEnd(lun. 13:50)` = `null` (la plage s'est fermée à 13:00). Retour
   dans `idle()`, `nextStart` → **lundi 12 octobre 00:00**, six jours de
   sommeil.

Résultat : les 5 h 10 de la seule plage de la semaine passent sans une seule
itération, sans une ligne de journal, et la prochaine occasion est dans 7
jours. Le coût de la panne n'est pas la durée de la panne, c'est la durée de
la panne **plus la plage entière qui suit**.

Formulation générale : réveillé à l'instant réel `T` avec une horloge en
retard de Δ, le démon dort `D = nextStart(T−Δ) − (T−Δ)` de temps réel et se
réveille à `T+D`. Tout ce qui s'ouvre dans `[T, T+D)` est enjambé. Δ vaut la
durée de l'arrêt : plus la panne est longue, plus l'horloge de référence est
ancienne, et plus le rendez-vous calculé est décalé.

Aggravant : `status` ne le dit pas. `nextCalendarStart` y est **recalculé à
chaque appel** (`daemon.ts:366`), donc juste après le saut il renvoie la bonne
réponse — pendant que la minuterie, elle, reste fausse. Le lundi à 09:00
réel, `unused status` affiche `window: null` et
`nextCalendarStart: lundi 12 octobre 00:00` : rien n'indique qu'une plage est
ouverte à cet instant et que le démon la dort. L'état affiché contredit le
comportement réel sans jamais se contredire lui-même.

Le même mécanisme joue hors démarrage, en plus petit : un step correctif
pendant une attente de plusieurs jours décale le réveil d'autant.

## 2. La reprise d'une plage interrompue est décidée sur cette même horloge, et le verdict est écrit sur disque avant toute synchro

**Gravité** : sûr (la décision) / probable (l'itération lancée)
**Où** : `src/daemon.ts:96-108`, avec `src/scheduler.ts:77-79` et
`src/scheduler.ts:83`

```ts
    this.state = await loadState(this.cfg.dataDir);
    if (this.state.window) {
      const until = new Date(this.state.window.until);
      if (until.getTime() > this.deps.now().getTime()) {
        this.manual = { until, resumed: true };
        this.deps.print(`plage interrompue trouvée, reprise jusqu'à ${until.toISOString()}`);
      } else {
        this.deps.print("plage enregistrée expirée, oubliée");
        this.state.window = null;
        await saveState(this.cfg.dataDir, this.state);
      }
    }
```

`until` est une date absolue écrite au début de la plage
(`scheduler.ts:78`). La comparer à `this.deps.now()` **au premier instant de
vie du processus** est exactement le moment où l'horloge est la moins fiable.

**Branche « reprise ».** Sur un Pi sans RTC, l'horloge au démarrage vaut à peu
près l'instant de la coupure, et `until` était dans le futur à cet instant-là
— sinon la plage n'aurait pas été enregistrée. La comparaison est donc
**toujours vraie**, quelle que soit la durée de l'arrêt : un jour, une
semaine, un mois.

1. Dimanche 20:00, `unused start 2h` → la plage tourne, le scheduler écrit
   `state.window = { until: "dimanche 22:00" }`.
2. Coupure à 20:10 ; `fake-hwclock.data` date de 20:00.
3. Le Pi est rebranché le **mercredi 09:00**. Horloge au démarrage : dimanche
   20:00.
4. `init()` : 22:00 > 20:00 → « plage interrompue trouvée, reprise jusqu'à
   dimanche 22:00 ». `run()` : `deadline` = dimanche 22:00 > dimanche 20:00 →
   `execute()` → `runWindow`.
5. `runWindow` réécrit `state.window`, puis entre dans sa boucle :
   `while (!signal.aborted && deps.now() < until())` — vrai, l'horloge dit
   toujours dimanche 20:00. `pickNext` choisit une tâche et **une itération
   démarre** : container, `claude -p`, jusqu'à `timeoutMinutes: 180`.
6. Le saut NTP arrive quelques secondes après. La fin de plage n'est
   réévaluée qu'entre deux itérations (par construction, `scheduler.ts:48-51`)
   : l'itération va au bout, est commitée, comptée et journalisée.

Une itération que personne n'a demandée, trois jours après la demande, un
mercredi matin — c'est-à-dire précisément ce que les plages servent à
empêcher. La décision de reprise est fausse dans 100 % de ces cas ; seule la
visibilité de la conséquence dépend d'une course de quelques secondes entre le
premier `deps.now()` de la boucle et le step de `timesyncd`. Cette course est
perdue dès que la synchro tarde : NTP filtré (UDP/123 bloqué), DNS lent sur le
pool, wifi qui se réassocie, ou `timesyncd` désactivé au profit de
`fake-hwclock` seul — dans ce dernier cas l'horloge reste fausse
indéfiniment et le démon travaille des heures sur une plage périmée.

À noter, ce n'est pas réservé aux plages manuelles : `scheduler.ts:78` écrit
`state.window` pour **toute** plage, y compris une plage calendrier, et
`init()` la rétablit en `this.manual` — donc hors calendrier et hors
`pausedUntil`.

**Branche « oubliée ».** Le miroir est pire dans sa forme : si l'horloge de
démarrage dépasse `until`, la plage est effacée **et le fichier réécrit
immédiatement** (`daemon.ts:105-106`). La correction NTP qui arrive dix
secondes plus tard ne peut plus rien : l'information est détruite. Il faut
pour cela une horloge en avance au démarrage — RTC additionnel à pile morte,
`fake-hwclock.data` écrit alors que l'heure était déjà fausse, ou un `date`
manuel. Moins courant sur un Pi nu que la branche « reprise », d'où la
gravité globale annoncée sur la décision plutôt que sur cette branche-ci ;
mais la faute est la même : un verdict irréversible rendu sur une horloge non
encore validée.

## 3. Le backoff quota compare un instant fourni par le serveur à l'horloge locale : un retard Δ décale le redémarrage de Δ

**Gravité** : probable
**Où** : `src/scheduler.ts:110-120` (ligne 114), avec `src/claude.ts:54-57` et
`src/scheduler.ts:34-45`

```ts
        const nowMs = deps.now().getTime();
        const resetsAt = r.outcome.kind === "quota" ? r.outcome.resetsAt : undefined;
        const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
        const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
```

`resetsAt` est un **epoch absolu émis par l'API** (`claude.ts:54-57`), donc
exact. `nowMs` est l'horloge locale. Leur différence n'a de sens que si les
deux horloges sont d'accord ; le résultat est ensuite endormi via `sleep()`,
monotone (`scheduler.ts:34-45`). L'erreur d'horloge passe donc intégralement
dans la durée d'attente.

Le cas « horloge fausse mais API joignable » n'a rien de théorique : TLS
tolère plusieurs heures de dérive (les certificats sont valables des mois), et
beaucoup de réseaux laissent passer HTTPS tout en bloquant UDP/123. Un Pi
resté sur `fake-hwclock` sans NTP est en retard de tout son temps d'arrêt
cumulé.

Horloge en retard de Δ = 4 h, plage du lundi 00:00→13:00, il est réellement
09:00 (l'horloge dit 05:00) :

- une itération est rejetée sur `five_hour`, avec `resetsAt` = l'instant réel
  09:45 ;
- `target = epoch(09:45) − epoch(05:00) = 4 h 45` au lieu des 45 minutes
  réelles ;
- `wait = min(max(4 h 45, 60 s), until − now = 8 h) = 4 h 45` ;
- `sleep(4 h 45)` monotone → réveil à **13:45 réel**, après la fermeture de la
  plage à 13:00.

Le quota redevient disponible à 09:45 et les 3 h 15 de plage qui restaient ne
produisent rien. La ligne journalisée
(`reprise à ${new Date(nowMs + wait).toISOString()}`, ligne 117) affiche une
date elle aussi décalée de Δ : elle ne permet pas de repérer l'anomalie.

Miroir, horloge en avance de Δ : `target` devient négatif ou trop petit, le
plancher `Math.max(target, 60_000)` ramène l'attente à 60 s, et le démon
relance un container par minute jusqu'au vrai reset — chaque tentative étant
une itération complète rejetée, comptée en `backoffs`.

## 4. `daemon.startedAt` et `durationMs` gardent l'heure d'avant le saut

**Gravité** : probable
**Où** : `src/daemon.ts:93` et `src/daemon.ts:364`, `src/iterate.ts:112`,
`src/iterate.ts:146`, `src/iterate.ts:199`, `src/log.ts:45-46`

`this.startedAt = this.deps.now()` est capturé dans le constructeur, avant
même `init()`, et n'est jamais rafraîchi ; `status` le renvoie tel quel. Dans
le scénario du constat 1, `unused status` annonce indéfiniment
`daemon.startedAt: dimanche 18:00` alors que le processus a démarré le lundi
07:50 : 13 h 50 d'uptime fantôme, pour un démon sous `Restart=always` dont la
question « a-t-il redémarré ? » est précisément ce qu'on vient lire dans
`status`. Même origine pour `window.startedAt` (`daemon.ts:179`).

Côté itération, `durationMs = endedAt.getTime() - startedAt.getTime()`
(`iterate.ts:199`) est une soustraction de deux lectures murales encadrant
plusieurs minutes de session : un step de +13 h 50 entre les deux affiche une
itération de 13 h 50 dans `index.jsonl`, dans le fichier de log et dans la
ligne `fin … (49800s, code 0)` (`iterate.ts:220`). Le nom du fichier de log
est bâti sur `startedAt` (`log.ts:45-46`), donc cette itération se classe
avant des itérations qui l'ont réellement précédée.

Aucune décision ne s'appuie sur ces valeurs — `durationMs` n'est utilisé que
pour la journalisation, et le timeout de session est monotone (voir plus bas).
L'impact est donc limité au diagnostic, mais c'est un diagnostic faux au
moment précis où l'on cherche à comprendre pourquoi la nuit n'a rien produit.

## Ce qui a été vérifié et tient

- **Les durées, elles, sont justes.** Le timeout de session
  (`iterate.ts:129-132`, `cfg.claude.timeoutMinutes`) et le `sleep()` du
  scheduler sont des `setTimeout` monotones : un step NTP ne les raccourcit ni
  ne les allonge. 180 minutes restent 180 vraies minutes.
- **Une plage en cours n'est pas prolongée par un saut.** `deadline()`
  (`daemon.ts:116-121`) est passé en callback et réévalué à chaque tour de
  boucle (`scheduler.ts:83`, `daemon.ts:196`) : dès que l'horloge se corrige,
  la fin de plage est recalculée et la boucle sort à la fin de l'itération en
  cours. C'est ce qui borne la casse du constat 2 à une itération.
- **Un recul d'horloge pendant l'attente est inoffensif.** La minuterie se
  déclenche trop tôt en temps mural, `run()` (`daemon.ts:145-153`) reteste
  `deadline()`, ne trouve pas de couverture et réarme `idle()` avec l'horloge
  corrigée. Seul le sens « réveil trop tard » (constat 1) perd du travail.
- **Le plafond `Math.min(ms, 2_147_000_000)`** (`daemon.ts:165`) protège du
  débordement 32 bits ; quand il mord, la minuterie se déclenche tôt et tout
  est recalculé — une attente calculée sur une horloge absurde serait
  réévaluée à ce moment-là.
- **`occurrences()`** (`calendar.ts:39-54`) balaye J−1 à J+7 autour du `now`
  qu'on lui passe : après un saut, le recalcul repart du bon `now` et retrouve
  les bonnes occurrences. Le calendrier n'a pas de cache à invalider ; le
  problème est uniquement dans le réveil (constat 1).
- **`unused-${taskName}-${Date.now()}`** (`docker.ts:132`, idem `:219`) : un
  recul d'horloge ne pourrait provoquer une collision de nom qu'avec un
  container de la même milliseconde encore présent. Non démontrable, écarté.
- **`deploy/install.sh`** n'installe ni ne vérifie aucun service de temps ; ce
  n'est pas un défaut du script en soi, la correction relève de l'unité
  systemd (constat 1).
