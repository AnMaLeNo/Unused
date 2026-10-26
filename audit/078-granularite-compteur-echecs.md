# 078 — Granularité du compteur d'échecs : par tâche, sans nœud ni horizon de temps

**Fichiers examinés** : `src/graph.ts:55-105` (`ApplyOptions`, `applyOutcome`,
les quatre branches et le seul endroit qui remet le compteur à zéro),
`src/graph.ts:107-133` (`isEligible`, `pickNext`), `src/state.ts:9-20`
(`TaskStateSchema` et le commentaire qui documente le compteur),
`src/state.ts:38-59` (`emptyState`, `initialTaskState`, `ensureTaskState`),
`src/state.ts:61-84` (`loadState`, `saveState`), `src/iterate.ts:72-90`
(obtention de `ts` et du nœud), `:155-189` (issue, `applyOutcome`, rollback de
commit, persistance), `src/scheduler.ts:83-139` (tête de boucle, `loadTasks`
par itération, branches `retry`/`task-failed` et leur message),
`src/daemon.ts:96-113` (`init`), `:177-243` (`execute`, `pauseUntil`),
`:375-407` (`taskInfo`, `resetTask`), `src/task.ts:27-67` (ce que le schéma de
graphe garantit sur `start` et `next`), `:121-161` (`loadTask`),
`src/cli.ts:113-150` (`printTasks`, `tasks reset`), `src/graph.test.ts:88-120`
(ce que les tests figent), `unused.config.json` (le régime livré :
`maxConsecutiveFailures: 3`, une seule plage, le lundi).

Rapports antérieurs relus pour ne pas redire : 005 (constat 1 : le rollback de
commit ne restaure ni `ts.last` ni `consecutiveFailures`), 018, 032 (constats 1
et 2 : héritage de `status`/compteurs par un nom recyclé), 044 (constats 1 et 2 :
dérive du curseur quand le graphe change — le compteur y est explicitement
renvoyé à 032), 049 (constat 1 : trois 529 en 2 min 30 sortent une tâche de la
file ; constat 2 : `tasks activate` ne ramène pas une tâche `failed`), 053, 065
(constat 4 : `consecutiveFailures` n'est affiché nulle part), 076.

Ni `node` ni `docker` ne sont disponibles dans ce conteneur : tout ce qui suit
est établi par lecture, en suivant les références d'objet d'un appel à l'autre
(`ensureTaskState` renvoie l'objet *stocké* dans `state.tasks`, que
`applyOutcome` mute en place, et que `saveState` sérialise).

**Verdict** : 2 constats (1 sûr, 1 probable)

Les deux viennent du même trou : `consecutiveFailures` est un entier par
*tâche*, et le seul événement qui le remet à zéro est un `completed`
(`src/graph.ts:84`). Il n'est indexé ni par nœud, ni par cause, ni par instant
— alors que la décision qu'il déclenche, `status = "failed"`, est définitive
(`isEligible`, `src/graph.ts:110`) et que la seule sortie documentée,
`tasks reset`, détruit l'image de la tâche (`src/daemon.ts:404`, constat 1 du
rapport 049).

## Les échecs d'un nœud disparu sont facturés au nœud `start` qui le remplace

**Gravité** : sûr
**Où** : `src/state.ts:50-59` (relocalisation du curseur sans toucher au
compteur), `src/graph.ts:96-103` (le compteur qui décide), `src/scheduler.ts:132`
(le message)

`ensureTaskState` est le seul chemin qui déplace un curseur sans qu'une
itération ait réussi :

```ts
export function ensureTaskState(state: RunnerState, task: Task): TaskState {
  let ts = state.tasks[task.name];
  if (!ts) {
    ts = initialTaskState(task);
    state.tasks[task.name] = ts;
  } else if (!(ts.cursor in task.def.nodes)) {
    ts.cursor = task.def.start;
  }
  return ts;
}
```

`ts.cursor` change, `ts.consecutiveFailures` est conservé tel quel (et `ts.last`
aussi, qui continue de décrire un nœud qui n'existe plus). Or ce n'est pas un
chemin théorique : le scheduler recharge les tâches depuis le disque **avant
chaque itération** (`src/scheduler.ts:88`, `loadTasks()` passé en fonction par
`src/daemon.ts:194`), donc une édition de `task.json` pendant la plage est prise
en compte au tour suivant, et le schéma de graphe (`src/task.ts:49-66`) oblige à
garder les références cohérentes : retirer ou renommer un nœud est une édition
*valide et complète*, qui laisse simplement le curseur pointer dans le vide.

Scénario concret, avec les valeurs livrées (`maxConsecutiveFailures: 3`,
`retrySeconds: 60`) sur une tâche à trois nœuds `setup → work → review → work` :

1. Le curseur est sur `work`, dont le skill vient d'être cassé. Itération :
   `failure` → `retry`, `consecutiveFailures = 1`. La tâche est collante
   (`applyDecision`, `src/graph.ts:147-151`), donc elle reprend la main.
2. Deuxième itération sur `work` : `failure` → `retry`,
   `consecutiveFailures = 2`. Il reste un strike.
3. L'opérateur regarde les logs, comprend que le graphe est en cause et
   réorganise : il renomme `work` en `work2` (ou le supprime en redirigeant
   `review.next`). `task.json` est valide, le démon le recharge au tour suivant.
4. Itération suivante : `ensureTaskState` constate que `"work"` n'est plus dans
   `nodes` et ramène le curseur sur `start`, soit `setup`. **`consecutiveFailures`
   vaut toujours 2.** Et d'après le constat 1 du rapport 044, rejouer `setup` sur
   un container déjà installé est précisément le cas où ce nœud a de bonnes
   raisons d'échouer.
5. `setup` échoue une fois — une seule. `applyOutcome` :
   `consecutiveFailures = 3 >= 3` → `ts.status = "failed"`, décision
   `task-failed`. La tâche sort définitivement de la file, et le scheduler
   annonce :

   ```
   <tâche> sortie de la file après 3 échecs consécutifs
   ```

Résultat obtenu : la tâche est éjectée pour de bon sur le premier échec du nœud
qu'elle vient de commencer, après une correction de l'opérateur, avec un message
qui affirme trois échecs consécutifs là où le nouveau nœud n'en a produit qu'un.
Résultat attendu : le compteur ne devrait pas pouvoir être dépensé par un nœud
qui n'existe plus — soit parce qu'il est indexé par nœud, soit parce que la
relocalisation du curseur, qui est un *changement de travail*, le remet à zéro
comme le fait `resetTask`.

À noter que `ensureTaskState` est appelé deux fois par tour, aux deux bouts
(`src/scheduler.ts:94` pour l'affichage, `src/iterate.ts:80` pour l'exécution) :
la relocalisation est donc bien effective avant `applyOutcome`, et elle est
persistée par le `saveState` de fin d'itération (`src/iterate.ts:189`).

## Rien ne borne les strikes dans le temps : deux échecs d'une plage se paient à la plage suivante, une semaine plus tard

**Gravité** : probable
**Où** : `src/state.ts:15` (la sémantique documentée), `src/graph.ts:96-103`,
`src/scheduler.ts:134-135` (l'attente de retry tronquée par la fin de plage),
`src/daemon.ts:96-108` (le démarrage ne touche à aucun compteur)

Le commentaire du schéma dit ce que fait le code, et rien de plus :

```ts
// Échecs consécutifs hors quota ; remis à zéro par un `completed`.
consecutiveFailures: z.number().int().nonnegative(),
```

« Consécutifs » s'entend donc au sens de la suite des itérations, sans aucun
horizon de temps. J'ai cherché un endroit qui remettrait le compteur à zéro
ailleurs que sur un `completed` : il n'y en a aucun. `runWindow` ne touche
qu'à `state.window` en début et en fin de plage (`src/scheduler.ts:78`, `:147`) ;
`Daemon.init` ne relit l'état que pour décider de reprendre la plage
(`src/daemon.ts:97-108`) ; `execute` ne remet rien à zéro avant d'appeler
`runWindow` ; `loadState` restitue le compteur tel qu'il a été écrit. Le seul
chemin qui l'efface est `resetTask`, qui supprime l'entrée entière — et qui
détruit l'image au passage.

Le régime livré rend l'écart entre deux itérations consécutives très grand :
`unused.config.json` ne déclare qu'une plage automatique, `mon 00:00 → 13:00`.
Deux itérations « consécutives » peuvent donc être séparées de **sept jours**.

Scénario concret :

1. Lundi, vers la fin de la plage, un incident côté API (529, 500, réseau
   coupé — tous classés `failure`, cf. rapport 049 constat 1) fait échouer la
   tâche deux fois : `consecutiveFailures = 2`, persisté par
   `src/iterate.ts:189`. L'attente de retry est tronquée par la fin de plage
   (`Math.min(retrySeconds * 1000, until - now)`, `src/scheduler.ts:134`), la
   boucle `while (deps.now() < until())` sort : le troisième coup n'a pas lieu.
   La plage se termine normalement, `state.window = null`.
2. Rien entre-temps : pas de plage, pas d'itération, donc pas de `completed`.
   `state.json` conserve `consecutiveFailures: 2` toute la semaine.
3. Lundi suivant, 00:00. **Première** itération de la plage, sur un service
   parfaitement sain, qui échoue une fois pour une raison quelconque (timeout
   d'une session longue, sortie illisible). `applyOutcome` : `3 >= 3` →
   `status = "failed"`, `task-failed`, et le même message qu'au constat
   précédent : « sortie de la file après 3 échecs consécutifs ».

Résultat obtenu : la tâche est éjectée définitivement au premier échec d'une
plage, sur la foi de deux strikes vieux d'une semaine, issus d'un incident
étranger et déjà résolu ; `status` ne montrera jamais pourquoi, puisqu'il
n'affiche pas le compteur (rapport 065, constat 4). Résultat attendu : le
mécanisme est censé détecter « cette tâche n'avance plus », c'est-à-dire un
enchaînement serré d'échecs ; trois échecs étalés sur huit jours ne sont pas cet
enchaînement. Un horizon (remise à zéro en début de plage, ou décroissance avec
le temps) ferait dire au compteur ce que son nom prétend.

Je classe « probable » et non « sûr » parce que l'arrivée en fin de plage avec
exactement `maxConsecutiveFailures - 1` strikes dépend du moment de l'incident ;
le reste de la chaîne — persistance du compteur, absence de remise à zéro au
démarrage comme à l'ouverture de plage, `>=` qui déclenche, irréversibilité —
est, lui, établi par lecture directe.

## Ce qui a été vérifié et tient

- **La remise à zéro par un `completed` est intentionnelle et figée par les
  tests** (`src/graph.test.ts:113-119`). Je ne la rapporte pas comme un défaut
  en soi : le cas « 2 échecs / 1 succès » répété n'est pas une tâche bloquée,
  c'est une tâche qui avance au tiers de son rythme (le curseur progresse à
  chaque `completed`, `src/graph.ts:89`), et la plage la facture honnêtement
  dans `summary.failures` (`src/scheduler.ts:131`), que `status` et la ligne
  « dernière » affichent (`src/cli.ts:100`, `:108`). Le seul angle où cette
  alternance devient réellement aveugle est l'absence d'affichage du compteur
  par tâche, qui est le constat 4 du rapport 065 et n'est pas repris ici.
- **Le quota ne consomme pas de strike et n'en efface pas** : `applyOutcome`
  renvoie `backoff` sans toucher au compteur (`src/graph.ts:92-93`), donc une
  attente quota de plusieurs heures au milieu de deux échecs ne les sépare pas
  mais ne les aggrave pas non plus. Cohérent avec l'intention documentée
  (`src/graph.ts:17-18`).
- **`fatal` non plus** : `stop-window` sort sans incrémenter
  (`src/graph.ts:94-95`), ce qui évite qu'une panne Docker ou d'auth mange les
  strikes de toutes les tâches. Déjà noté par 049.
- **Un `aborted` est bien neutre** : `src/iterate.ts:162` court-circuite
  `applyOutcome` et `src/iterate.ts:189` n'enregistre rien, donc un
  `stop --now` ne fait ni avancer ni reculer le compteur.
- **Le compteur ne peut pas dépasser `max` par accident ni devenir négatif** :
  la seule incrémentation est `+= 1` suivie du test `>=`, l'initialisation est à
  0 (`src/state.ts:43`), le schéma exige un entier non négatif, et
  `maxConsecutiveFailures` est validé `int().positive()`
  (`src/config.ts:40`) — un `0` en config, qui ferait échouer toute tâche au
  premier échec, est donc rejeté au chargement.
- **Le trou de rollback du commit raté** (`src/iterate.ts:168-183` restaure
  `cursor`, `iterations` et `status` mais laisse `consecutiveFailures` à 0 et
  `ts.last` à « completed ») appartient bien à cet angle, mais il est déjà
  déposé : rapport 005, constat 1, rappelé par 011 et 053. Rien à ajouter.
- **`resetTask` est le seul effacement du compteur et il est correct** : il
  supprime l'entrée entière (`delete this.state.tasks[name]`,
  `src/daemon.ts:400`) et persiste, donc aucun strike ne survit à un reset. Son
  coût — la destruction de l'image — est le constat 1 de 049.
