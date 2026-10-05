# 043 — Le reset quota connu n'est jamais écrit : plage suivante et redémarrage relancent une session rejetée

**Fichiers examinés** : `src/scheduler.ts:56-80` (ouverture de plage),
`src/scheduler.ts:109-122` (branche `backoff`), `src/scheduler.ts:141-149`
(fermeture de plage), `src/state.ts:22-44` (`RunnerStateSchema`, `emptyState`),
`src/daemon.ts:96-113` (`init`), `src/daemon.ts:177-243` (`execute`,
`pauseUntil`, `unpause`), `src/daemon.ts:252-274` (`onEvent`),
`src/daemon.ts:284-326` (`startWindow`, `stopWindow`), `src/graph.ts:15-24,92-93,139-152`,
`src/iterate.ts:150-165,189,208`, `src/claude.ts:129-136` (`quotaRejection`),
`src/log.ts:40-66`, `src/calendar.ts:56-78` (`coverageEnd`, `nextStart`),
`deploy/unused.service:17-22`, `deploy/install.sh:64-71`, `README.md:86-96`,
tests `src/scheduler.test.ts:92-105,150-162`, `src/state.test.ts`
**Verdict** : 2 constats (2 sûrs), dont un recouvrement partiel assumé avec le
rapport 003 (voir le second constat)

Point de départ, vérifiable d'un `grep` : `resetsAt` n'existe que dans
`claude.ts`, `graph.ts` et `scheduler.ts:112-114`. Il ne franchit jamais la
frontière de `state.ts` :

```ts
// state.ts:22-33 — tout ce qui survit à un redémarrage
version, window { startedAt, until }, currentTask, lastTask, pausedUntil, tasks
```

Il n'y a donc aucun porteur pour « le quota est saturé jusqu'à T ». La valeur
vit uniquement dans la pile de `runWindow` (`scheduler.ts:112-120`, le temps
d'un `setTimeout`) et dans `run.waitingQuotaUntil` (`daemon.ts:268-269`), deux
emplacements qui meurent avec le processus. Elle est bien écrite sur disque —
`rateLimits` brut dans le fichier d'itération (`iterate.ts:208`) — mais dans le
seul fichier que le démon ne relit jamais.

## Un redémarrage pendant l'attente quota relance aussitôt une session rejetée

**Gravité** : sûr
**Où** : `src/scheduler.ts:112-120` (le reset reste en mémoire) et
`src/daemon.ts:98-102` (la plage, elle, est persistée)

L'asymétrie est le cœur du défaut : **la plage survit au redémarrage, la raison
de ne pas travailler non**.

Côté plage, `runWindow` écrit `state.window` dès l'ouverture, puis le relit à
l'`init` suivant :

```ts
// scheduler.ts:77-79
const startedAt = deps.now();
state.window = { startedAt: startedAt.toISOString(), until: until().toISOString() };
await saveState(cfg.dataDir, state);
```

```ts
// daemon.ts:98-102
if (this.state.window) {
  const until = new Date(this.state.window.until);
  if (until.getTime() > this.deps.now().getTime()) {
    this.manual = { until, resumed: true };
```

Côté quota, rien n'est écrit : le reset est consommé sur place, en argument
d'un sommeil, et `break` sort du `switch` sans toucher à `state` :

```ts
// scheduler.ts:111-121
const nowMs = deps.now().getTime();
const resetsAt = r.outcome.kind === "quota" ? r.outcome.resetsAt : undefined;
const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
if (wait <= 0) break;
…
await deps.sleep(wait, signal);
break;
```

`Daemon.onEvent` reçoit pourtant l'instant de reprise et ne le range que dans
l'objet volatil `run` — alors qu'il tient `this.state`, que cinq autres
chemins sauvegardent :

```ts
// daemon.ts:268-269
case "backoff":
  run.waitingQuotaUntil = new Date(e.until);
```

Scénario concret (calendrier du README, `mon-fri 23:00→07:00`) :

1. Lundi 23 h 00 — la plage s'ouvre, `state.window = { until: "mardi 07:00" }`
   est écrit (`scheduler.ts:77-79`).
2. Lundi 23 h 20 — l'itération se termine sur un `rate_limit_event` `rejected`,
   `rateLimitType: "five_hour"`, `resetsAt` = mardi 03 h 00. `applyOutcome` rend
   `backoff` (`graph.ts:92-93`), `applyDecision` rend la tâche collante
   (`currentTask`, `graph.ts:147-151`) et `iterate` sauvegarde l'état
   (`iterate.ts:189`). Le scheduler dort 3 h 40. **Mardi 03 h 00 n'est écrit
   nulle part.**
3. Lundi 23 h 30 — le service redémarre. Pas besoin d'un incident :
   `deploy/install.sh:67-69` fait exactement ça à chaque mise à jour
   (`systemctl restart unused` si le service tourne), et l'unité porte
   `Restart=always` / `RestartSec=5` (`deploy/unused.service:18-19`), plus un
   `Requires=docker.service` qui l'emmène avec un redémarrage de Docker.
4. Nouveau processus : `init()` lit `state.window.until` = mardi 07 h 00 > now,
   affiche « plage interrompue trouvée, reprise jusqu'à … » et pose
   `manual = { until, resumed: true }` (`daemon.ts:98-102`).
5. `run()` → `execute()` → `runWindow` → `pickNext` retrouve la tâche collante
   dans `state.currentTask` (persisté à l'étape 2) → `iterate` : `docker run`
   de l'image de la tâche (`docker.ts:130-149`), session `claude -p` **rejetée
   d'entrée**, container `rm -f`, fichier de log complet et ligne dans
   `index.jsonl` (`log.ts:41-65`), `summary.iterations += 1` et
   `live.iterations += 1` (`scheduler.ts:101`, `daemon.ts:261`).
6. Le démon recalcule alors le backoff à partir du *nouveau* `rejected` et
   dort — jusqu'au prochain redémarrage.

Attendu : au réveil, le démon sait que rien ne peut réussir avant mardi
03 h 00 et attend sans rien lancer. Obtenu : une session facturée en
« itération » (fichier de log, compteur de plage, `ts.last`) pour un travail
qui n'a pas eu lieu, à chaque redémarrage, et un `docker run` par cycle de 5 s
si le démon est en boucle de redémarrage.

Le même trou vaut pour l'arrêt propre : sur `SIGTERM`, `runWindow` prend la
branche `signal.aborted` et ne sauvegarde **rien** (`scheduler.ts:141-143`,
commentaire « la plage reste enregistrée »), et `execute` ne nettoie
`state.window` que sur `explicitStop` (`daemon.ts:218-222`). Un
`systemctl restart` pendant l'attente quota passe donc exactement par le
scénario ci-dessus.

Deux aggravations, documentées ailleurs mais qui se branchent ici : si le
`rejected` ne porte pas son `resetsAt` au premier niveau (rapport 003, 3ᵉ
constat), la relance ne retombe pas sur un sommeil long mais sur 15 min
aveugles — soit une session rejetée tous les quarts d'heure ; et pendant tout
le sommeil, `stop` reste sans effet (rapport 003, 1ᵉʳ constat).

## Le champ qui manquerait existe (`pausedUntil`) et n'est écrit que pour des raisons plus faibles

**Gravité** : sûr
**Où** : `src/daemon.ts:228-236` (`pauseUntil`), appelé depuis
`daemon.ts:208-216` — jamais depuis la branche quota

`RunnerState` possède déjà un « ne rouvre pas de plage avant T » persistant, et
le démon s'en sert pour trois raisons strictement moins informées que le reset
quota :

```ts
// daemon.ts:228-236
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;
  if (until.getTime() <= this.deps.now().getTime()) return;
  this.state.pausedUntil = until.toISOString();
  await saveState(this.cfg.dataDir, this.state);
```

- `nothing-eligible` → pause jusqu'à la fin de couverture (`daemon.ts:208-212`) ;
- plage interrompue par une erreur → idem (`daemon.ts:213-216`) ;
- `stop` → pause jusqu'à la fin de couverture (`daemon.ts:317-318`).

Le quota, seul cas où le démon connaît un instant **exact et autoritaire**
donné par le serveur, ne l'utilise pas. `calendarEnd` consulte `pausedUntil`
avant toute chose (`daemon.ts:123-128`) : une écriture dans la branche
`backoff` suffirait à couvrir les deux symptômes (redémarrage et plage
suivante), sans nouvelle machinerie.

Scénario concret, quota **7 jours** et calendrier du README :

1. Lundi 23 h 20 — `rejected`, `rateLimitType: "seven_day"`, `resetsAt` = jeudi
   14 h 00. `target` ≈ 62 h ; `wait = Math.min(62 h, until − now = 7 h 40)` →
   7 h 40 (`scheduler.ts:115`). Le démon dort jusqu'à mardi 07 h 00 sans rien
   faire, plage tenue, `stop` inopérant.
2. Mardi 07 h 00 — fin de plage : `state.window = null`,
   `endedBecause: "window"`, `pausedUntil` intact (`scheduler.ts:144-149`).
   `lastWindow` dit « 1 itérations, 0 completed, 1 attentes quota » ; ni
   `status` ni `state.json` ne mentionnent jeudi 14 h 00.
3. Mardi 23 h 00 — `coverageEnd` rend mercredi 07 h 00, `pausedUntil` est nul :
   nouvelle plage, `docker run`, session rejetée, re-sommeil tronqué de 8 h.
4. Mercredi 23 h 00 — rejoué à l'identique.
5. Jeudi 23 h 00 — le reset est passé, le travail reprend.

Attendu : `pausedUntil = jeudi 14:00:30` écrit au premier refus ; le démon
n'ouvre ni la nuit de mardi ni celle de mercredi, `unused status` affiche
« pause … jusqu'à jeudi 14 h 00 » (`cli.ts:105`) et l'opérateur comprend
pourquoi. Obtenu : deux nuits de plage ouvertes pour rien, deux sessions
rejetées, 16 h de sommeil pendant lesquelles `status` annonce une plage « en
cours » et `nextCalendarStart` annonce une reprise que le quota interdit.

Recouvrement : le rapport 003 (2ᵉ constat, dernier paragraphe) note déjà que le
reset n'est écrit « ni dans `state`, ni dans `pausedUntil` » et qu'une plage
ouvrant avant le reset relance un container pour rien. Ce qui est ajouté ici :
la répétition sur plusieurs jours (le reset 7 jours dépasse le pas du
calendrier, pas seulement l'horizon d'une plage), et le fait que le mécanisme
de persistance nécessaire existe déjà et soit employé pour des motifs plus
faibles. Une limite honnête de la correction esquissée : `pauseUntil` sort tôt
quand `cfg.windows.length === 0` (`daemon.ts:231`), donc une installation sans
calendrier aurait besoin d'un champ propre plutôt que d'un détournement de
`pausedUntil`.

## Ce qui a été vérifié et tient

- **L'arithmétique du backoff en mémoire est juste** quand le reset tient dans
  la plage : `resetsAt * 1000 + 30_000`, plancher 60 s, plafond « fin de
  plage », epoch secondes → ms cohérents (`scheduler.ts:112-116`, testé en
  `scheduler.test.ts:92-105`). Le défaut est la non-persistance, pas le calcul.
- **La tâche collante survit, elle, au redémarrage** : `applyDecision` écrit
  `currentTask` sur `backoff` (`graph.ts:147-151`), `iterate` sauvegarde
  (`iterate.ts:189`), `RunnerStateSchema` le relit. Après reprise, c'est bien
  la même tâche au même nœud qui est rejouée — ce qui est voulu, et ce qui rend
  la session relancée systématiquement rejetée plutôt qu'aléatoire.
- **L'état de la tâche n'est pas corrompu par ces sessions pour rien** :
  `quota` ne touche ni `cursor`, ni `iterations`, ni `consecutiveFailures`
  (`graph.ts:79,92-93`), le container est jeté et `DONE` effacé
  (`iterate.ts:184-187`). La casse est en ressources, en compteurs de plage et
  en lisibilité, pas en progression de tâche.
- **Le test qui encadre la troncature ne regarde pas la persistance** :
  `scheduler.test.ts:150-162` (« l'attente quota ne dépasse pas la fin de
  plage ») vérifie l'horloge et `endedBecause`, jamais `state` ni
  `loadState(dataDir)` — contrairement au test voisin de fin de plage
  (`scheduler.test.ts:88-89`) qui, lui, relit le disque. Rien ne verrouille le
  comportement actuel : la correction n'aurait pas de test à combattre.
- **`saveState` est atomique** (`state.ts:77-83`, tmp + `rename`) : écrire un
  champ de plus ne crée pas de nouveau risque de fichier tronqué (les
  chevauchements de `saveState` sont traités par le rapport 017).
- **Aucun autre lecteur de quota n'existe** : `grep resetsAt src/*.ts` ne sort
  que `claude.ts`, `graph.ts` et `scheduler.ts` ; `DaemonStatus` n'a aucun
  champ de quota hors `waitingQuotaUntil` volatil (`daemon.ts:15-35`), et
  `api.ts` n'expose rien de plus. Il n'y a donc pas de voie de secours par
  laquelle le reset serait retrouvé.
