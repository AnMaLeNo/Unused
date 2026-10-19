# 072 — angle isolation des fautes : une erreur propre à une tâche tue la plage des autres

**Fichiers examinés** : `src/scheduler.ts:56-156` (`runWindow`, en particulier
`88-139`), `src/iterate.ts:72-237` (tout le corps, en particulier
`99-110`, `120-147`, `155-190`, `217`, `232-236`), `src/graph.ts:41-53`
(`classify`), `src/graph.ts:64-105` (`applyOutcome`), `src/graph.ts:107-152`
(`isEligible`, `pickNext`, `applyDecision`), `src/daemon.ts:116-175`
(`deadline`, `calendarEnd`, `run`, `idle`), `src/daemon.ts:177-236`
(`execute`, `pauseUntil`), `src/daemon.ts:252-280` (`onEvent`, `loadTasks`),
`src/daemon.ts:375-418` (`taskInfo`, `resetTask`, `setActive`),
`src/state.ts:9-59` (schéma, `ensureTaskState`), `src/task.ts:27-67`
(`TaskFileSchema`), `src/task.ts:85-188` (`resolveEnv`, `loadTask`,
`loadTasks`), `src/docker.ts:28-68` (`docker`, `mustSucceed`),
`src/docker.ts:130-180` (`runInTask`, `discardContainer`, `commitTask`),
`src/docker.ts:214-248` (`flattenTask`, `pipeExportImport`),
`src/log.ts:42-67` (`writeIterationLog`), `src/api.ts:54-124`
(gestion d'erreur des routes), `src/claude.ts:85-112` (`parseStream`),
`src/scaffold.ts:5-30` (le `task.json` modèle), `unused.config.json`.

**Verdict** : rien trouvé — aucun constat nouveau sur cet angle. Les trois
chemins d'escalade « faute d'une tâche → plage de tout le monde » que le code
contient sont réels mais tous déjà consignés, chacun avec son déclencheur, dans
les rapports antérieurs. Ce rapport sert donc à borner le terrain : il dit où
sont ces chemins, qui les possède déjà, et ce qui a été vérifié sans rien
trouver, pour qu'une session suivante ne refasse pas le parcours.

Ni `node`, ni `node_modules`, ni `docker` ne sont présents dans ce conteneur :
tout ce qui suit est établi par lecture, en suivant les références d'objets et
les signatures d'un appel à l'autre.

## La carte des escalades, et à qui elles appartiennent déjà

Le modèle de fautes du projet distingue explicitement trois niveaux
(`src/graph.ts:15-32`) : `failure` est propre à la tâche et borné par
`maxConsecutiveFailures`, `quota` est global et légitime (un seul abonnement),
`fatal` arrête tout. L'isolation ne peut donc se casser que de trois façons, et
les trois existent :

1. **Une exception non rattrapée pendant l'itération.** `scheduler.ts:98`
   appelle `deps.runIteration` sans `try`, et `iterate` n'en a qu'un seul, posé
   autour de `runInTask` et filtrant sur `DockerError`
   (`iterate.ts:144-147`), plus celui de `commitTask` (`172-183`). Tout ce qui
   lève ailleurs — `rm(donePath)` (`110`), `saveState` (`189`),
   `writeIterationLog` (`217`), un cast de `parseStream` qui déréférence du
   `null`, un `err` non-`DockerError` relancé en `173` — traverse `runWindow`
   intact et tombe dans `daemon.ts:213-216` : message
   « plage interrompue par une erreur », `state.window = null` en mémoire,
   `pauseUntil(deadline)` sur les plages automatiques. Aucun compteur d'échec
   n'est touché, donc la tâche fautive **ne sort jamais de la file** et la
   plage suivante meurt de la même manière. Déjà consigné, avec déclencheurs
   distincts : `011` (log d'itération), `014` (DONE répertoire → `ERR_FS_EISDIR`
   sur les quatre `rm` sans `recursive`), `026` (un `/` dans un nom de nœud, et
   `node.args` non itérable), `050` (champ NDJSON null ou non numérique),
   `047` (EROFS), `017` (`saveState`), `018`, `021`, `064`, `070`.
2. **Un `fatal` prononcé sur une cause propre à une tâche.** `classify`
   (`graph.ts:49-51`) range tout `401/403` en `fatal:auth`, et
   `iterate.ts:144-147` tout `DockerError` de `runInTask` en `fatal:docker` —
   alors qu'un nœud choisit son modèle (`args`, `task.ts:35`, que le modèle de
   `scaffold.ts:30` suggère lui-même) et ses variables (`env`, `task.ts:46`), et
   que `commitTask` passe par `layerCount` puis `flattenTask`, dont le coût
   dépend de la taille de l'image de *cette* tâche. `stop-window` pose
   `this.fatal` (`daemon.ts:205-207`), qui annule le calendrier
   (`123-124`) et désarme le seul minuteur du processus (`163-165`). Déjà
   consigné : `023` (constat 1, avec le scénario `big`/`small` et la variante
   `403` de nœud), `005` (atomicité du même `catch`), `067`, `046`.
3. **Le verrou collant qui survit à la faute.** `applyDecision`
   (`graph.ts:147-151`) pose `state.currentTask = task.name` sur `retry`,
   `backoff` **et** `stop-window`, et `pickNext` (`graph.ts:122-125`) rend la
   tâche collante en priorité absolue tant qu'elle est éligible. Une tâche qui
   échoue de façon reproductible garde donc la main jusqu'à
   `maxConsecutiveFailures` — et pour un `fatal`, indéfiniment, puisque le
   compteur n'est pas incrémenté : chaque `unused start` rejoue la même tâche,
   la même panne, et la plage meurt avant que le round-robin annoncé en
   `scheduler.ts:48-49` n'ait servi personne. Déjà consigné : `045` (équité),
   `023` (constat 1), `008` (round-robin décalé quand `lastTask` a disparu).

Le pendant de ces trois chemins — une panne **globale** imputée aux tâches, qui
les sort une à une de la file en trois itérations chacune, avec un
`consecutiveFailures` persisté qui ne décroît jamais et un `tasks activate` qui
ne lève pas `failed` — appartient à `049`, `030` et `018`.

## Ce qui a été vérifié et tient

- **Le curseur ne peut pas faire lever `iterate` après un rechargement.**
  `iterate.ts:85` déréférence `task.def.nodes[nodeName]!` sans garde, mais
  `ensureTaskState` replace le curseur sur `task.def.start` dès qu'il pointe
  hors du graphe (`state.ts:55-57`), et il est appelé deux fois sur l'objet
  `Task` fraîchement rechargé avant ce déréférencement : `scheduler.ts:94` puis
  `iterate.ts:80`. `TaskFileSchema` garantit par ailleurs `start in nodes`
  (`task.ts:50-57`), donc le repli ne peut pas pointer dans le vide. Le silence
  de ce repli est le sujet de `044`, pas une exception.
- **Le chemin `env` manquante → `fatal:auth` n'est pas atteignable depuis le
  démon.** `loadTask` refuse la tâche au chargement contre `process.env`
  (`task.ts:156-159`) et `loadTasks` la range dans `errors` sans la rendre à
  `pickNext` (`task.ts:181-185`, `daemon.ts:276-280`) ; `defaultDeps.env` est
  ce même objet (`iterate.ts:29`), jamais remplacé par `scheduler.ts:66`. Une
  tâche mal déclarée est donc bien *isolée* — c'est le bon comportement, et le
  chemin mort est le sujet de `039`.
- **Les routes de l'API ne peuvent pas emporter la plage.** Le handler de
  `createApi` est intégralement sous `try/catch` (`api.ts:58-123`) : une faute
  propre à une tâche déclenchée par une commande (`resetTask` dont le `rm` ou le
  `rmi` lève, `setActive` sur un `task.json` illisible) repart en 409/404/500 et
  ne traverse pas le processus. Les effets de ces commandes *pendant* une
  itération sont le sujet de `006` et `042`.
- **`saveState` ne mélange pas les tâches.** L'état est sérialisé en bloc
  (`state.ts:82`) mais ne contient que des chaînes, des booléens et des nombres
  entiers (`state.ts:9-33`) : aucune valeur venue d'une session ne peut faire
  lever `JSON.stringify` et emporter la progression des autres tâches.
- **Pas de ressource partagée entre les itérations de deux tâches.** Le
  minuteur de timeout et l'écouteur `abort` sont des locales d'`iterate`
  retirées dans le `finally` (`iterate.ts:117-143`) ; le nom de container porte
  la tâche et l'horodatage (`docker.ts:132`) ; `exchangeDir` et `skillsDir`
  dérivent du dossier de la tâche (`task.ts:142-143`). Les angles voisins —
  espace de noms Docker global (`059`), containers orphelins (`027`), kill en
  `void` (`001`) — sont déjà couverts.
