# 064 — Réconciliation de `state.json` et du journal d'itérations

**Fichiers examinés** : `src/iterate.ts:148-237` (issue, rollback de commit,
`finalDecision`, `writeIterationLog`), `src/graph.ts:64-105` (`applyOutcome`) et
`src/graph.ts:107-153` (`pickNext`, `applyDecision`), `src/state.ts` (entier :
schéma persistant, `ensureTaskState`, `saveState`), `src/log.ts` (entier :
`IterationRecord`, ligne d'`index.jsonl`), `src/scheduler.ts:83-149`
(`runWindow`, filtre d'abandon, sauvegarde de fin de plage),
`src/daemon.ts:177-241` (`execute`, son `catch`, `pauseUntil`),
`src/daemon.ts:375-407` (`taskInfo`, `resetTask`), `src/docker.ts:166-246`
(`commitTask`, `flattenTask`, `pipeExportImport`), `src/cli.ts:87-124`
(affichage de `status`), `src/iterate.test.ts:148-180`, `src/state.test.ts`,
`unused.config.json`.

**Verdict** : 2 constats (2 probables)

Ni `node` ni `node_modules` ne sont présents dans ce conteneur (`which node`
échoue, `npm` non installé) : tout ce qui suit est établi par lecture du code,
en suivant les valeurs d'un appel à l'autre. Les numéros de ligne sont ceux de
la branche `audit`.

Le point de départ de l'angle. Il existe deux enregistrements de ce qui s'est
passé, et aucun code ne les rapproche jamais (`grep -rn "index.jsonl" src/` ne
donne que l'écriture, `log.ts:66` — déjà noté en 011) :

* `state.json` — `tasks[t].cursor`, `.iterations`, `.consecutiveFailures`,
  `.last = {at, node, outcome}`, plus la file `currentTask` / `lastTask`
  (`state.ts:9-33`), écrit par `saveState` (`iterate.ts:189`) ;
* `data/logs/index.jsonl` — une ligne par itération, `{at, task, node, outcome,
  done, decision, durationMs, costUsd, …}` (`log.ts:49-66`), écrite par
  `writeIterationLog` (`iterate.ts:217`), **après** la sauvegarde d'état.

La réconciliation nominale tient (détail en fin de rapport). Les deux constats
ci-dessous sont des cas où elle ne tient pas, et où le trou n'est pas
diagnosticable depuis ce qui reste sur le disque.

## Le rollback de commit laisse `state.lastTask` sur une tâche qui n'a pas rendu la main

**Gravité** : probable
**Où** : `src/iterate.ts:162-183`, `src/graph.ts:139-152`

Quand une session réussit mais que `commitTask` échoue, `iterate` défait l'effet
de l'itération. Mais `applyDecision` a déjà été appelé **avant** l'échec, avec la
décision du succès :

```ts
// src/iterate.ts:162-165 — chemin du succès : decision = "next-task" (ou "task-done")
const decision: Decision = aborted ? "retry" : applyOutcome(task, ts, outcome, {…});
if (!aborted) applyDecision(state, task, decision);
```

```ts
// src/graph.ts:139-152
case "next-task":
case "task-done":
case "task-failed":
  state.currentTask = null;
  state.lastTask = task.name;   // ← écrit ici
  return;
case "backoff":
case "retry":
case "stop-window":
  state.currentTask = task.name;  // ← ne touche pas à lastTask
  return;
```

Puis le `catch` du commit restaure trois champs de la tâche et rejoue
`applyDecision` avec `stop-window` :

```ts
// src/iterate.ts:174-183
// Le travail est fait mais l'état ne peut pas être conservé : on ne
// ment pas au curseur, l'itération est réputée n'avoir jamais eu lieu.
outcome = { kind: "fatal", reason: "docker", detail: err.message };
ts.cursor = nodeName;
ts.iterations -= 1;
ts.status = "running";
await deps.discardContainer(r.container);
await rm(donePath, { force: true });
applyDecision(state, task, "stop-window");
```

`applyDecision("stop-window")` ne remet `currentTask` qu'à `task.name` ; la
branche `stop-window` **n'écrit pas** `lastTask`, donc la valeur posée par le
premier appel reste. `state.lastTask` est pourtant documenté comme « Dernière
tâche à avoir rendu la main proprement » (`state.ts:28-29`) et sert de point de
départ au round-robin (`graph.ts:127`). Après ce chemin, il nomme une tâche dont
le code vient d'affirmer, trois lignes plus haut, que son itération n'a jamais eu
lieu. Et la ligne écrite dans `index.jsonl` pour cette itération dit
`decision: "stop-window"` (`iterate.ts:188,214`, `log.ts:55`) : rien dans le
journal ne laisse deviner qu'un `next-task` a été appliqué à la file puis
partiellement défait.

La correction symétrique existe déjà ailleurs dans le fichier : `aborted`
n'appelle simplement pas `applyDecision` (`iterate.ts:165`), ce qui préserve
`currentTask` **et** `lastTask` (vérifié en 045). Ici les deux appels se
superposent.

**Scénario concret.** Deux tâches, `tasks/audit` et `tasks/work` ;
`loadTasks` trie par nom de dossier (`task.ts:171-174`), donc l'ordre est
`[audit, work]`. État : `lastTask: "work"`, `currentTask: null`,
`tasks.audit.cursor: "analyze"`.

1. `pickNext` : pas de tâche collante, `lastIdx = 1` (`work`), `i = 1` →
   `tasks[0]` = `audit` (`graph.ts:127-131`). `audit` prend son tour.
2. La session sur `analyze` finit en `completed` sans `DONE` → `applyOutcome`
   rend `next-task`, `applyDecision` écrit `currentTask: null`,
   `lastTask: "audit"`.
3. `commitTask` lève une `DockerError` — avec `flattenAfterLayers: 30`
   (`unused.config.json`), une itération sur trente déclenche en plus
   l'aplatissement, qui a ses propres façons d'échouer (005). Rollback :
   `cursor` revient à `analyze`, `iterations` redescend, `currentTask: "audit"`.
   `lastTask` reste `"audit"`. `saveState` écrit ça sur le disque
   (`iterate.ts:189`), la plage s'arrête en `fatal` (`scheduler.ts:123-128`).
4. L'opérateur répare Docker. Le premier constat de 005 l'invite à nettoyer
   l'image de la tâche, dont `:latest` a pu avancer sans le curseur : il tape
   `unused tasks reset audit`. `resetTask` fait
   `delete this.state.tasks.audit` puis, parce que `currentTask === "audit"`,
   `currentTask = null` (`daemon.ts:400-401`) — mais ne touche pas à `lastTask`.
5. `unused start --for 2h`. `pickNext` : plus de tâche collante,
   `lastIdx = 0` (`audit`), `i = 1` → `tasks[1]` = **`work`**.

Attendu : `audit` n'ayant consommé aucun tour (son itération « n'a jamais eu
lieu »), c'est elle qui doit repartir, exactement comme à l'étape 1. Obtenu :
`work` passe devant et `audit` attend un tour complet. Avec N tâches, elle
attend N-1 itérations, soit jusqu'à 3 h chacune (`timeoutMinutes: 180`).

Tant que `currentTask` reste collant, le mensonge est masqué — c'est pourquoi je
classe le constat en « probable » plutôt qu'en « sûr » : le champ est à coup sûr
faux (c'est de la lecture directe), la conséquence visible demande le `reset`,
qui est précisément le geste que la panne de commit provoque. Le test qui couvre
ce chemin vérifie `cursor`, `iterations`, `status` et `currentTask`
(`iterate.test.ts:154-155`) et ne regarde pas `lastTask`.

À rapprocher des trous déjà consignés sur le même `catch`, non repris ici :
`ts.consecutiveFailures` et `ts.last` ne sont pas restaurés non plus (005,
note secondaire du premier constat), et `summary.iterations` compte en sens
inverse de `ts.iterations` sur ce même événement (021, troisième constat).

## Une erreur hors `DockerError` pendant le commit persiste une itération que le journal n'a jamais vue

**Gravité** : probable
**Où** : `src/iterate.ts:172-173`, `src/docker.ts:245-246`,
`src/daemon.ts:213-216`, `src/daemon.ts:228-234`

Le `catch` du commit ne rattrape qu'un type d'erreur et relance le reste :

```ts
// src/iterate.ts:170-183
await deps.commitTask(cfg, task.name, r.container);
committed = true;
} catch (err) {
  if (!(err instanceof DockerError)) throw err;   // ← sortie par exception
```

Or `commitTask` a au moins deux voies qui rejettent avec autre chose qu'une
`DockerError`. Les deux sont dans la phase d'aplatissement, déclenchée
automatiquement au-delà de `flattenAfterLayers` couches (`docker.ts:176`) :

```ts
// src/docker.ts:245-246 — rejet avec l'Error brute de spawn, pas une DockerError
exp.on("error", reject);
imp.on("error", reject);
```

```ts
// src/docker.ts:217 — SyntaxError si la sortie n'est pas du JSON,
// TypeError dans importChanges si `.Config` vaut `null`
const changes = importChanges(JSON.parse(inspect.stdout) as ImageConfig);
```

Un `spawn` qui échoue pour une raison de ressource (`EAGAIN` faute de PID ou de
mémoire, `ENOMEM`) donne un `Error` nu — et c'est au moment précis où l'on
lance deux processus de plus pour pousser une image entière de `docker export`
vers `docker import` que la machine est le plus serrée. Ce rejet n'est pas une
`DockerError`, donc il traverse `iterate` : **pas de rollback, pas de
`discardContainer`, pas de `saveState` (ligne 189), pas de
`writeIterationLog` (ligne 217)**. `runWindow` appelle `deps.runIteration` sans
filet (`scheduler.ts:98`), l'exception remonte donc au `catch` de `execute` :

```ts
// src/daemon.ts:213-217
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
```

```ts
// src/daemon.ts:231-234
if (this.cfg.windows.length === 0) return;
if (until.getTime() <= this.deps.now().getTime()) return;
this.state.pausedUntil = until.toISOString();
await saveState(this.cfg.dataDir, this.state);   // ← écrit l'état muté
```

`this.state` est l'objet même qu'`iterate` vient de muter via `applyOutcome` :
`cursor` avancé au nœud suivant, `iterations + 1`, `consecutiveFailures` remis à
0, `last = {node: X, outcome: "completed"}` (`graph.ts:79-90`). Le chemin
d'erreur le sauvegarde donc lui-même, immédiatement. Avec `windows` vide le
`return` de la ligne 231 reporte seulement l'écriture : l'objet reste en mémoire
dans le démon et le premier `saveState` de la plage suivante
(`scheduler.ts:79`) l'écrit tel quel.

**Scénario concret.** Tâche `audit`, trentième itération depuis le dernier
aplatissement, nœud `analyze`, plage automatique du lundi en cours
(`unused.config.json`).

1. La session finit en `completed` après 50 min. `applyOutcome` :
   `iterations: 412 → 413`, `cursor: "analyze" → "choose"`,
   `last = {node: "analyze", outcome: "completed"}`.
2. `commitTask` : `:prev` posé, `docker commit` réussi (`:latest` avance),
   `docker rm` du container de l'itération fait (`docker.ts:169-175`),
   `layerCount` rend 31 > 30 → `flattenTask`.
3. `spawn("docker", ["export", …])` échoue en `EAGAIN`. `exp.on("error",
   reject)` rejette un `Error: spawn EAGAIN`. Le `finally` de `flattenTask`
   nettoie son container temporaire (`docker.ts:223-224`), puis l'erreur
   remonte.
4. `iterate.ts:173` la relance. `daemon.ts:214` imprime `plage interrompue par
   une erreur : spawn EAGAIN`, `pauseUntil` sauvegarde l'état et met les plages
   automatiques en pause jusqu'à lundi 13 h.

Résultat sur le disque :

| | contenu |
|---|---|
| `state.json` | `cursor: "choose"`, `iterations: 413`, `last: {node: "analyze", outcome: "completed"}` |
| `data/logs/audit/` | aucun fichier pour cette itération |
| `data/logs/index.jsonl` | 412 lignes, aucune pour cette itération |
| `lastWindow` / `status` | la plage **précédente** (021, deuxième constat) |

L'itération 413 existe donc uniquement dans `state.json`, qui la déclare
`completed`, et nulle part ailleurs. Ce qui est perdu définitivement est
exactement ce que le journal est seul à porter (`log.ts:7-35,49-66`) : les 50
minutes de durée, le `total_cost_usd`, les fenêtres de quota avant/après, le
modèle, le `num_turns`, le nom du container et de l'image. `unused status`
affiche `413 itérations, dernier analyze → completed`, et un décompte
`grep -c '"outcome":"completed"' index.jsonl` en trouve 412 : l'écart est
visible, mais rien sur le disque ne dit laquelle manque, ni ce qu'elle a coûté,
ni si elle a été commitée.

Le cas voisin est déjà instruit, et c'est bien un cas voisin, pas celui-ci :
005 (troisième constat) décrit l'`EPIPE` de `imp.stdin`, qui n'a **aucun**
écouteur et tue le processus entier — l'état n'est alors pas sauvé du tout et le
curseur reste en arrière. Ici l'erreur est un rejet propre de la promesse : le
démon survit, et c'est son propre chemin d'erreur qui persiste un curseur
avancé. 011 (premier constat) décrit la même absence de journal quand c'est
`writeIterationLog` qui échoue — mais à ce moment-là l'état sauvé est
*cohérent* avec l'itération qui a tourné ; ce qui manque est la trace. Dans le
constat présent, l'état avance en se réclamant d'une itération dont il ne reste
rien.

Une seule ligne suffirait à ramener ce chemin dans le cas déjà traité :
remplacer `if (!(err instanceof DockerError)) throw err;` par un traitement
uniforme (tout échec de commit est un `fatal:docker`), ce que le `catch` sait
déjà faire — rollback, `discardContainer`, `stop-window`, journal écrit.

## Ce qui a été vérifié et tient

- **La réconciliation nominale est exacte.** `ts.iterations` est incrémenté
  seulement par la branche `completed` d'`applyOutcome` (`graph.ts:83`), et
  chaque itération qui passe par là écrit une ligne `outcome: "completed"` dans
  `index.jsonl` (`log.ts:53`). Le curseur du journal se reconstruit aussi :
  `rec.node` est le nœud figé en début d'itération (`iterate.ts:84,193`), et
  `ts.cursor` après coup vaut `nodes[node].next` pour un `completed`, le même
  nœud sinon. Les deux enregistrements concordent sur les quatre issues
  ordinaires (`completed`, `quota`, `failure`, `fatal` issu de `classify`).
- **`ts.iterations` ne peut pas devenir négatif.** Le `-= 1` du rollback
  (`iterate.ts:178`) n'est atteignable que dans `if (outcome.kind ===
  "completed")`, et un `outcome` `completed` implique `aborted === false`
  (ligne 156 l'écraserait sinon), donc `applyOutcome` — et son `+= 1` — a
  forcément eu lieu juste avant. Le `nonnegative()` du schéma
  (`state.ts:14`), qui ferait échouer `loadState` et interdirait tout
  redémarrage, n'est pas en danger par ce chemin.
- **Le rollback de commit ne laisse pas `status: "done"` derrière lui.** Le cas
  `completed + DONE` passe par `ts.status = "done"` sans avancer le curseur
  (`graph.ts:85-88`) ; le `catch` remet `status: "running"` et réécrit
  `cursor = nodeName`, qui était déjà la bonne valeur, et supprime le `DONE` du
  dossier d'échange (`iterate.ts:177-181`). `isEligible` (`graph.ts:108-110`)
  revoit donc la tâche.
- **L'abandon ne crée pas d'écart état/journal.** Sur `aborted`, `applyOutcome`
  et `applyDecision` ne sont pas appelés et `saveState` est sauté
  (`iterate.ts:162-165,189`) ; la ligne écrite dans `index.jsonl` porte
  `outcome: "aborted"` et `done` tel qu'il a été observé, ce qui décrit
  fidèlement une tentative que l'état ignore volontairement. Le seul écart
  connu sur ce chemin est le coût non compté dans la plage (037), et il porte
  sur `summary`/`status`, pas sur `state.json`.
- **Le timeout est journalisé conformément à l'état.** `timedOut` force
  `outcome = failure/timeout` (`iterate.ts:157`), donc `consecutiveFailures + 1`
  et `ts.last.outcome = "timeout"`, et la ligne du journal porte
  `timedOut: true` avec la même issue. Le `clearTimeout` du `.finally`
  (`iterate.ts:140-143`) empêche un timer de se déclencher après la fin de la
  session (démontré en 001). Reste la fenêtre inverse, que je ne rapporte pas
  faute de pouvoir la démontrer sans `node` : la phase `timers` passant avant
  la phase `poll`, un timer échu au même tour de boucle qu'un `close` déjà prêt
  s'exécute d'abord, et une session terminée en `completed` à la milliseconde
  près serait étiquetée `timeout` — une ligne de journal alors
  auto-contradictoire (`exitCode: 0`, `result.terminal_reason: "completed"`,
  `done: true`, `outcome: failure/timeout`). La fenêtre vaut quelques
  millisecondes sur un plafond de 180 min, et le traitement retenu (jeter) est
  de toute façon celui d'une session qui aurait fini une milliseconde plus tard.
- **`ts.last.at` n'est pas une incohérence de production.** `iterate` appelle
  `applyOutcome` sans passer `now` (`iterate.ts:164`), donc `graph.ts:79`
  utilise `new Date()` tandis que tous les horodatages du journal viennent de
  `deps.now()` (`iterate.ts:112,148`). Les deux sont la même horloge hors
  tests, et l'instant retenu (fin de session, avant commit) se recoupe avec le
  journal par `at + durationMs` : réconciliable, seulement indirect. Signalé
  pour mémoire, pas rapporté comme défaut.
- **La discontinuité de `reset` est volontaire mais muette.**
  `resetTask` fait `delete this.state.tasks[name]` (`daemon.ts:400`) : la tâche
  repart à `iterations: 0` sans que `last` ni le curseur gardent trace du passé,
  alors que les lignes déjà écrites dans `index.jsonl` restent. L'écart est donc
  détectable mais inexpliqué — aucun événement de cycle de vie (reset,
  activate, début/fin de plage, panne globale) n'est journalisé, le journal ne
  contenant que des itérations. Rien à corriger dans le code tel qu'il est
  spécifié ; la conséquence côté panne globale est déjà consignée en 023.
- **Déjà rapporté ailleurs, non repris ici** : `ts.last` et
  `consecutiveFailures` non restaurés par le rollback de commit, et l'image qui
  avance quand le curseur recule (005) ; `summary.iterations` qui compte une
  itération sans ligne de journal et qui contredit `ts.iterations` (021) ;
  l'échec de `writeIterationLog` qui détruit la plage et efface l'itération
  qu'il devait décrire, et le fait qu'`index.jsonl` n'est relu par aucun code
  (011) ; le curseur réécrit en silence par `ensureTaskState` sans log ni
  compteur (044) ; l'avance de curseur sur un nœud qui n'a pas tourné quand le
  graphe change en vol (018) ; le journal inaccessible au container qui
  rejoue (053).
