# 063 — Interruptibilité des attentes : `shouldStop` et la deadline pendant un sommeil de plusieurs heures

**Fichiers examinés** : `src/scheduler.ts:34-45` (`sleep`),
`src/scheduler.ts:56-83` (entrée de `runWindow`, `state.window`, tête de
boucle), `src/scheduler.ts:84-87` (`shouldStop`), `src/scheduler.ts:109-122`
(attente quota), `src/scheduler.ts:129-136` (attente retry),
`src/scheduler.ts:138-155` (sorties de boucle et motif de fin),
`src/daemon.ts:116-128` (`deadline`, `calendarEnd`),
`src/daemon.ts:138-175` (`run`, `onAbort`, `idle`),
`src/daemon.ts:177-226` (`execute` et son `finally`),
`src/daemon.ts:284-326` (`startWindow`, `stopWindow`),
`src/daemon.ts:328-361` (`status`), `src/api.ts:66-71,114-123`,
`src/cli.ts:34-64,77-106`, `src/state.ts:77-84` (`saveState`),
`src/iterate.ts:156-189` (issue `aborted`, `saveState` final),
`src/graph.ts:41-105` (`classify`, `applyOutcome`),
`src/config.ts:33-42`, `src/scheduler.test.ts:29-37,105-150`,
`src/daemon.test.ts:20-40`.
Rapports antérieurs relus avant d'écrire : 003, 004, 006, 013, 025, 029, 030,
042, 046, 055, 056.

**Verdict** : rien trouvé — aucun constat nouveau. Le défaut visé par l'angle
est réel, mais il est déjà rapporté, et à l'identique : rapport 003, premier
constat. Les variantes et conséquences que ce passage a fait apparaître sont
elles aussi déjà couvertes (042, 056, 013, 029, 004). Ce rapport sert donc à
fermer l'angle : il dit où chaque facette est déjà écrite, et ce qui a été
creusé en plus sans tenir.

Aucun moteur JS dans ce conteneur (`node`, `npm` absents, pas de
`node_modules`) : tout ce qui suit est déroulé sur le code.

## L'angle est déjà couvert, facette par facette

Le mécanisme est bien celui annoncé. `shouldStop()` n'est lu qu'en tête de
boucle (`src/scheduler.ts:84`), et l'attente quota est un `setTimeout` qui ne
se réveille que sur le `signal` (`src/scheduler.ts:34-45`, appelé en `:120`) —
or `stopWindow(false)` ne lève pas `ac`, il pose `run.stopRequested`
(`src/daemon.ts:324`). Pendant un sommeil de plusieurs heures, ni l'arrêt
gracieux ni la deadline ne sont relus. Correspondances exactes :

- **Arrêt gracieux ignoré pendant l'attente quota, deadline non réévaluée** →
  rapport **003**, constat 1 (« L'arrêt gracieux n'est pas honoré pendant
  l'attente quota »), gravité sûr. Il cite les mêmes lignes
  (`scheduler.ts:120`, `:83-87`, `daemon.ts:324`), le même scénario (plage
  00 h–08 h, `resetsAt` à 04 h 00, `stop` à 00 h 25) et va jusqu'à
  l'effondrement de `until()` sur `now` via `pausedUntil`.
- **Attente rognée par la fin de plage, annoncée comme une reprise, reset
  oublié** → rapport **003**, constat 2.
- **Statut qui ment pendant ce sommeil** (`source` qui retombe sur `manual`,
  `until` déjà passé, `remainingMs` à 0, `endedBecause` qui reste `"window"`
  alors que l'arrêt était explicite) → rapport **042**, constat 3. Le
  raisonnement y est fait pour une itération en cours ; le sommeil quota n'en
  change que la durée, pas le mécanisme (`stopped` reste faux parce que la
  boucle sort par sa condition, pas par le `break` de `:86`).
- **`unused start` refusé pendant tout le sommeil** (`this.running` n'est remis
  à nul qu'au `finally` d'`execute`, `src/daemon.ts:224`) → rapport **056**,
  constat 1, qui le dit explicitement : « Même refus pendant un sommeil quota ».
- **`wait` non borné par `TIMEOUT_MAX`** (réveil au bout de 1 ms au-delà de
  24,8 jours) → rapport **013**, constat 4, qui traite aussi l'attente retry
  de `:133` et conclut qu'elle ne peut pas déborder.
- **Sommeil faussé par un saut d'horloge** (`resetsAt` serveur comparé à
  l'horloge locale, réveil armé sur l'horloge d'avant NTP) → rapport **029**,
  constats 1 et 3.
- **SIGTERM pendant le sommeil → plage calendaire reprise déguisée en plage
  manuelle** (`state.window.until` écrit une seule fois en `scheduler.ts:78`
  avec la deadline *combinée*, relu par `init` en `daemon.ts:98-102`) →
  rapport **004**, constat 1.
- **Le trou est invisible pour la suite de tests** : la doublure de sommeil
  (`scheduler.test.ts:36`) ignore le signal et avance l'horloge, et la
  doublure de scheduler du démon (`daemon.test.ts:32`) relit `shouldStop` à
  chaque tour, donc implémente elle-même ce qui manque → rapport **025**,
  constat 2.

## Ce qui a été vérifié et tient

- **`sleep` lui-même est correct** (`src/scheduler.ts:34-45`) : court-circuit
  si `signal.aborted` est déjà vrai *avant* d'armer le timer, `clearTimeout` et
  `removeEventListener` dans le chemin commun `done`, résolution unique quelle
  que soit la course timer/abort. Pas de fuite d'écouteur ni de double
  `resolve`. Le défaut est dans ce que `sleep` ne sait pas (`shouldStop`,
  `until()`), pas dans ce qu'il fait.
- **`stop --now` pendant le sommeil fonctionne de bout en bout** :
  `run.ac.abort()` (`daemon.ts:321`) réveille `sleep`, la condition de boucle
  `!signal.aborted` sort, `summary.endedBecause = "stopped"`
  (`scheduler.ts:141-143`) ; `state.window` n'est volontairement pas effacé
  par le scheduler, et c'est le `finally` d'`execute`
  (`daemon.ts:218-222`, garde `run.explicitStop`) qui l'efface pour qu'un
  arrêt explicite ne soit pas repris au démarrage suivant. Cohérent.
- **Croissance de la deadline pendant un sommeil rogné : une seule itération
  perdue, pas de boucle serrée.** Scénario construit pour le déclencher :
  `windows` = `[{sun 23:00 → 07:00}]`, `unused start --for 1h` à 22:00. À 22:10
  quota rejeté, `resetsAt` à 02:00. `until()` vaut alors 23:00 (le calendrier
  n'a pas commencé, `coverageEnd` rend null), donc `wait` est rogné à 50 min
  (`scheduler.ts:115`) et le sommeil finit à 23:00 — l'heure où la plage
  automatique s'ouvre. La boucle repart (`until()` vaut maintenant 07:00),
  lance un container pour une session immédiatement rejetée, puis recalcule
  correctement `wait` = 3 h 00 jusqu'à 02:00:30. Coût : une itération gâchée,
  pas un emballement. La cause profonde — le reset connu n'est mémorisé nulle
  part — est le constat 2 du rapport 003 et le rapport 043 ; rien à ajouter.
- **Pas de `NaN` atteignable dans les attentes.** `wait` vaut `NaN` si
  `until()` est un `Date` invalide (`NaN <= 0` est faux, donc le
  `if (wait <= 0)` ne protège pas, et `new Date(nowMs + NaN).toISOString()` de
  `:117` lèverait un `RangeError`). Mais pour que `runWindow` tourne, `execute`
  a déjà exigé `deadline() > now` (`daemon.ts:147`), et les deux seules sources
  de la deadline restent finies ensuite : `run.manualUntil` est figé, et
  `calendarEnd` ne produit que des dates valides, même avec un `to` aberrant
  comme `"99:99"` (rapport 013, constat 3). Chemin non atteignable.
- **`resetTask` pendant un sommeil quota ne corrompt rien**, bien que la garde
  `this.running?.current?.task === name` (`daemon.ts:399`) soit inopérante à ce
  moment-là : `onEvent` a remis `run.current` à null à la fin de l'itération
  (`daemon.ts:259`), mais il n'y a justement plus de container ni de session en
  vol. Au réveil, la boucle refait `pickNext(await loadTasks(), state)`
  (`scheduler.ts:88`) et `ensureTaskState` recrée l'entrée supprimée ; la
  stickiness est levée proprement par `state.currentTask = null`
  (`daemon.ts:401`). Pas de référence périmée conservée à travers le sommeil.
- **Arrêt à moitié appliqué si `saveState` échoue dans `stopWindow`** : creusé,
  pas retenu. `stopWindow` mute `this.state.pausedUntil` en RAM (`:317`)
  *avant* de persister (`:318`), et n'arme `explicitStop`/`stopRequested`
  qu'après (`:319`, `:324`). Un échec du `saveState` rend donc un 500 au client
  (`api.ts:120-122`) alors que la pause est déjà effective en mémoire —
  `calendarEnd` la lit directement (`daemon.ts:125-126`) — ce qui, pour une
  plage purement calendaire, suffit à faire mourir la plage à la sortie de
  boucle suivante. Deux raisons de ne pas en faire un constat : le déclencheur
  (deux `saveState` concurrents sur le même `state.json.tmp`) est déjà le
  constat 4 du rapport 006 et y est classé « à vérifier », et le résultat
  observable — plage qui s'arrête en annonçant `"window"` — est exactement
  celui du constat 3 du rapport 042. Rien de démontrable en propre.
- **Branche `!this.running && this.manual` de `stopWindow`**
  (`daemon.ts:309-315`) : réexaminée, et la conclusion « non démontré » du
  rapport 042 tient. Le seul point de suspension où `this.manual` est posé sans
  `this.running` est l'`await saveState` de `startWindow` (`:298`), et un
  `stop` qui y tomberait annulerait correctement la plage demandée (la boucle
  `run` relit `this.manual` après le `wake?.()`). Rien entre `init()` et le
  premier `execute` : `listen` est résolu puis `run()` est appelé dans le même
  macrotâche (`cli.ts:41-60`), et `execute` pose `this.running` avant son
  premier `await` (`daemon.ts:178-188`).
- **`idle` reste le site correct** (`daemon.ts:161-175`) : `Math.max(0, …)`,
  plafond de `setTimeout` sous `TIMEOUT_MAX`, `wake` posé puis relâché dans le
  `finally`, et relecture de `signal.aborted` après l'armement. L'asymétrie
  avec `sleep` est frappante — `wake` n'existe que pendant l'attente du
  calendrier, pas pendant les attentes du scheduler — mais c'est la même
  cause que le constat 1 du rapport 003, pas une seconde.
