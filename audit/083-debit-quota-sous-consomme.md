# 083 — angle débit : itérations sérielles, sommeils globaux, pause « rien à faire »

**Fichiers examinés** : `src/scheduler.ts:34-45` (`sleep`), `src/scheduler.ts:56-102`
(mise en place, tête de boucle, rechargement), `src/scheduler.ts:104-139`
(les quatre branches du `switch` et les deux attentes), `src/scheduler.ts:141-155`
(sorties et motif de fin), `src/daemon.ts:116-135` (`deadline`, `calendarEnd`,
`nextCalendarStart`), `src/daemon.ts:137-175` (`run`, `idle`),
`src/daemon.ts:177-236` (`execute`, `pauseUntil`), `src/daemon.ts:238-243`
(`unpause`), `src/daemon.ts:284-326` (`startWindow`, `stopWindow`),
`src/config.ts:8-44` (toutes les bornes du schéma) et `unused.config.json`
(le régime livré), `src/graph.ts:92-105` (`applyOutcome`),
`src/graph.ts:107-152` (`isEligible`, `pickNext`, `applyDecision`),
`src/iterate.ts:150-190` (classement, rejet du container),
`src/claude.ts:114-136` (`quotaSnapshot`, `quotaRejection`),
`src/calendar.ts:60-78` (`coverageEnd`, `nextStart`), `src/state.ts:42-59`,
`src/task.ts:163-188` (`loadTasks`), `src/api.ts:54-124` (les leviers de reprise),
`README.md:20-24`, `src/scheduler.test.ts:30-56` et `:176-186`.

Rapports antérieurs relus avant d'écrire, pour ne pas redire : 002, 003, 008,
013, 018, 030, 035, 043, 045, 046, 049, 055, 056, 063, 072, 074, 076, 078.

Ni `node`, ni `node_modules`, ni `docker` dans ce conteneur : tout ce qui suit
est établi par lecture du code, en suivant les références d'un appel à l'autre.

**Verdict** : 1 constat (sûr). Les trois gisements de temps mort que l'angle
désigne — la sérialisation, les deux sommeils globaux, la pause « rien à
faire » — ont été repris un par un : l'un contient un temps mort qui
n'appartient à aucun rapport antérieur et qui ne sert à rien (ci-dessous) ;
tout le reste est soit un choix assumé et documenté, soit déjà déposé, avec
le propriétaire nommé en fin de rapport.

## Une tâche qui sort de la file fait dormir la plage `retrySeconds` pour rien

**Gravité** : sûr
**Où** : `src/scheduler.ts:129-136`, contre `src/config.ts:37-38` et `src/graph.ts:140-146`

Les deux décisions `retry` et `task-failed` partagent la même branche, donc la
même attente :

```ts
// src/scheduler.ts:129-136
case "retry":
case "task-failed": {
  summary.failures += 1;
  if (r.decision === "task-failed") deps.print(`  ${task.name} sortie de la file après ${cfg.scheduler.maxConsecutiveFailures} échecs consécutifs`);
  const wait = Math.min(cfg.scheduler.retrySeconds * 1000, until().getTime() - deps.now().getTime());
  if (wait > 0) await deps.sleep(wait, signal);
  break;
}
```

Or ce réglage a un objet précis, écrit dans le schéma :

```ts
// src/config.ts:37-38
// Pause après un échec (hors quota) avant de rejouer le même nœud.
retrySeconds: z.number().nonnegative().default(60),
```

« avant de rejouer le même nœud » — c'est exactement ce que `task-failed` ne
fait pas. Cette décision vient de `applyOutcome`, qui a posé
`ts.status = "failed"` (`src/graph.ts:98-100`), si bien que `isEligible` écarte
la tâche pour tout le reste de la plage (`src/graph.ts:108-110`) ; et
`applyDecision` a **relâché le verrou collant** dans le même mouvement :

```ts
// src/graph.ts:140-146
case "next-task":
case "task-done":
case "task-failed":
  state.currentTask = null;
  state.lastTask = task.name;
  return;
```

Le nœud fautif ne sera donc jamais rejoué, et le prochain `pickNext`
(`src/scheduler.ts:88`) rendra une **autre** tâche, saine, qui était prête à
partir. L'attente ne protège personne : elle ne ralentit pas un rejeu
(il n'y en a pas), elle ne laisse pas un quota se reconstituer (la branche
quota est ailleurs, lignes 109-122), elle ne laisse pas Docker respirer (le
container de l'itération est déjà jeté, `src/iterate.ts:184-186`). Elle ne fait
que retirer `retrySeconds` du temps de plage, c'est-à-dire du quota visé.

### Scénario concret

Config livrée (`unused.config.json` : `retrySeconds: 60`,
`maxConsecutiveFailures: 3`), deux tâches `a` et `b`, plage de 10 minutes, et
une itération qui dure 1 minute — ce sont littéralement les paramètres du test
`src/scheduler.test.ts:176-186`. La tâche `a` casse de façon reproductible
(par exemple un `args: ["--model", "opus-inexistant"]` sur son nœud,
`src/task.ts:35`, une forme que le modèle de `scaffold.ts:30` suggère
lui-même) : chaque session se termine hors `completed`, donc `failure` →
`retry`, trois fois de suite → `task-failed`.

| t (min) | ce qui se passe |
|---|---|
| 0 → 1 | itération `a` (échec 1) → `retry` |
| 1 → 2 | `sleep(60s)` — légitime : même nœud à rejouer |
| 2 → 3 | itération `a` (échec 2) → `retry` |
| 3 → 4 | `sleep(60s)` — légitime |
| 4 → 5 | itération `a` (échec 3) → `task-failed`, `status = "failed"`, verrou relâché |
| **5 → 6** | **`sleep(60s)` — pour rien : `a` ne sera plus jouée, `b` attend** |
| 6 → 10 | itérations de `b` |

Obtenu : `b` dispose de 4 minutes sur les 10 de la plage. Attendu : 5 minutes —
`pickNext` rend `b` immédiatement après la sortie de `a`. Une minute de plage
(donc de quota) est perdue sans qu'aucune ligne ne l'explique : le seul message
imprimé est « sortie de la file après 3 échecs consécutifs », qui n'annonce pas
une attente.

Le coût se répète par tâche sortante : avec N tâches qui s'épuisent dans la
même plage, c'est N × `retrySeconds`. Il est aussi payé par le cas terminal —
dernière tâche éligible qui sort, puis `sleep(60s)`, puis seulement
`pickNext → null` et la pause « plus rien à faire » (`src/daemon.ts:208-211`) :
une minute de sommeil avant d'aller dormir. Et il est proportionnel au réglage :
un opérateur qui choisit une cadence de rejeu douce — `retrySeconds: 900`, que
le schéma accepte sans plafond — s'achète 15 minutes de plage morte à chaque
sortie de file, en croyant n'avoir réglé qu'un rejeu.

La correction tient dans la condition déjà présente deux lignes plus haut :
l'attente appartient à `retry`, pas à `task-failed` (et la ligne 132 distingue
d'ailleurs déjà les deux cas pour l'affichage).

Le test ne l'attrape pas : son horloge simulée avance bien de 60 s à chaque
`sleep` (`src/scheduler.test.ts:36`), mais il n'assert que l'**ordre** des
tâches (`["a:retry", "a:task-failed", "b:next-task"]`), jamais le temps écoulé
ni le nombre d'itérations tenues dans la plage. Supprimer le sommeil de la
branche `task-failed` laisserait la suite verte.

## Ce qui a été vérifié et tient

- **La sérialisation n'est pas un défaut, c'est le contrat.** `README.md:23-24`
  l'énonce : « Une file, pas de parallélisme (le quota est partagé) : une
  itération de la tâche A, une de B, une de C… Sur quota saturé, tout le monde
  attend. » Le code s'y conforme (un seul `await deps.runIteration` par tour,
  `src/scheduler.ts:98`) et `src/config.ts` n'offre aucune clé de concurrence
  qui promettrait autre chose. Rien à déposer : une absence documentée n'est
  pas un mensonge sur l'état.
- **Les deux sommeils sont bornés par la fin de plage, et le plancher du
  backoff est correct.** `Math.min(…, until() - nowMs)` aux lignes 115 et 133 ;
  `until()` est réévalué à chaque tour, donc une plage qui s'étend pendant
  l'attente est vue (le revers — l'itération gâchée par une attente déjà
  commencée — est le sujet de 056). `Math.max(target, 60_000)` neutralise un
  `resetsAt` déjà passé, et `if (wait <= 0) break` (ligne 116) ne peut pas
  boucler à chaud : `wait <= 0` implique `until() <= now`, donc la condition
  `while` de la ligne 83 sort au tour suivant. Déjà instruit par 013.
- **Aucune itération n'est précédée d'une attente après un succès.** Les
  branches `next-task` et `task-done` (lignes 105-108) ne font qu'incrémenter
  un compteur : le régime nominal enchaîne les sessions sans délai imposé par
  le runner. Le seul temps mort inter-itérations du régime sain est la phase
  post-session (commit, aplatissement éventuel), qui appartient à 055, 036, 041
  et 005.
- **L'attente quota globale sur une saturation globale est la bonne conduite,
  et ses défauts démontrables sont tous déposés.** Arrêt gracieux non honoré
  pendant l'attente (003 §1), attente tronquée annoncée comme une reprise
  (003 §2), `resetsAt` présent seulement dans `unifiedWindows` → repli aveugle
  sur `backoffMinutes` (003 §3), attente non persistée au redémarrage (043 §1),
  saturation *par modèle* traitée comme globale alors que d'autres tâches ont
  encore du quota (045), saturation sans `rejected` comptée en échec (046 §2,
  049 §3), rejection périmée qui jette une itération réussie (046 §1),
  `backoffMinutes` documenté sur un événement qui ne l'utilise pas (046 §3).
  Vérifié à nouveau ici : `summary.backoffs` n'est comparé à rien
  (`scheduler.ts:110,153`, `daemon.ts:264`, `cli.ts:100`), donc une saturation
  longue se traduit par une répétition sans fin bornée par la fin de plage —
  conduite correcte, coût d'une session rejetée par cycle (déjà pesé par 076 §2).
- **La pause « plus rien à faire » et sa portée appartiennent à 002 et 035.**
  Repris intégralement : `pauseUntil(this.deadline(run.manualUntil))`
  (`daemon.ts:211`) peut dépasser la couverture en cours et faire sauter une
  plage entière (002 §1, avec le chiffrage en heures de quota) ; la pause n'est
  levée que par `startWindow`, `resetTask` ou `setActive(true)`
  (`daemon.ts:238-243, 297, 405, 417`) — il n'existe aucune route d'unpause
  (`api.ts:54-124`) et aucun minuteur sur l'expiration de la pause
  (`daemon.ts:163-165`) ; et une tâche momentanément illisible suffit à faire
  conclure « plus rien à faire » (035 §1, `task.ts:180` ; vérifié que le même
  trajet vaut pour un `task.json` invalide pendant une édition, puisque
  `loadTasks` range l'erreur dans `errors` et rend `tasks: []`,
  `task.ts:181-186`, et que `daemon.ts:278` se contente de l'imprimer). Rien de
  neuf : même cause, même conséquence, mêmes propriétaires. Le chemin de
  reprise officiel d'une tâche ajoutée pendant la pause passe bien par
  `tasks activate` (`scaffold.ts:6` pose `active: false`), qui appelle
  `unpause` — ce n'est donc pas un gisement supplémentaire.
- **La boucle du démon ne tourne pas à vide, et ne perd pas de réveil
  qu'un rapport ne possède déjà.** Les cinq sorties de plage ont été reprises
  (`daemon.ts:145-154`, `192-225`) comme dans 076 §3, avec la même conclusion ;
  les deux pertes de plage qui s'y cachent — `pauseUntil` inopérant quand
  `cfg.windows` est vide (ligne 231) et la plage manuelle jetée par le `finally`
  de la ligne 223 — sont déjà déposées (018 §1, 074).
- **Le débordement de la dernière itération au-delà de la fin de plage**
  (une session démarrée à `until - 1 min` peut courir jusqu'à
  `claude.timeoutMinutes`, 180 min par défaut) est l'exact inverse d'une
  sous-consommation, et appartient à 030.
