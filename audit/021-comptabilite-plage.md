# 021 — Comptabilité de la plage : itérations gonflées, coût absent, résumé perdu au redémarrage

**Fichiers examinés** : `src/scheduler.ts:56-156` (`runWindow`, `WindowSummary`),
`src/daemon.ts:15-38` (`DaemonStatus`), `src/daemon.ts:51-60` (`Running`),
`src/daemon.ts:96-113` (`init`), `src/daemon.ts:177-226` (`execute`),
`src/daemon.ts:252-274` (`onEvent`), `src/daemon.ts:328-373` (`status`),
`src/iterate.ts:99-106,160-236` (issue, rollback de commit, `costUsd`),
`src/graph.ts:64-105` (`applyOutcome`), `src/state.ts:22-40` (schéma persistant),
`src/log.ts:37-68` (`index.jsonl`), `src/cli.ts:88-110` (affichage de `status`),
`src/claude.ts:86-112` (`parseStream`), `src/scheduler.test.ts`,
`src/daemon.test.ts:20-44`, `README.md:104-128`
**Verdict** : 4 constats (2 sûrs, 2 probables)

Ni `node` ni `node_modules` ne sont disponibles dans ce conteneur : tout ce qui
suit est établi par lecture du code, en suivant les valeurs d'un appel à
l'autre. Les numéros de ligne sont ceux de la branche `audit`.

Rappel du contrat affiché. `WindowSummary` porte cinq compteurs
(`scheduler.ts:8-16`), recopiés à l'identique dans `DaemonStatus.window` via
`...run.live` (`daemon.ts:342`) et imprimés tels quels :

```ts
// src/cli.ts:99-108
console.log(`         ${w.iterations} itérations, ${w.completed} completed, ${w.failures} échecs, ${w.backoffs} attentes quota, $${w.costUsd.toFixed(2)}`);
...
console.log(`dernière ${l.iterations} itérations, ${l.completed} completed, ${l.failures} échecs, $${l.costUsd.toFixed(2)} (${l.endedBecause})`);
```

## Une plage reprise après un redémarrage repart à zéro et se présente comme neuve

**Gravité** : sûr
**Où** : `src/scheduler.ts:77-79`, `src/daemon.ts:98-108`, `src/daemon.ts:178-187`,
`src/daemon.ts:82`, `src/daemon.ts:337-342`

`README.md:126` annonce : « Le démon reprend une plage interrompue par un
redémarrage. » C'est vrai de la *borne* de la plage, et de rien d'autre : toute
sa comptabilité est en mémoire de processus, et la reprise réinitialise les
trois choses qui la décrivent.

**1. Les compteurs.** `execute` fabrique un `Running` neuf à chaque entrée, sans
jamais consulter ce qui a déjà été consommé :

```ts
// src/daemon.ts:178-187
const run: Running = {
  startedAt: this.deps.now(),
  ...
  live: { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0 },
```

**2. `startedAt`.** `runWindow` réécrit `state.window` inconditionnellement, sans
regarder s'il en existe déjà un :

```ts
// src/scheduler.ts:77-79
const startedAt = deps.now();
state.window = { startedAt: startedAt.toISOString(), until: until().toISOString() };
await saveState(cfg.dataDir, state);
```

`init` ne lit que `.until` de la plage retrouvée (`daemon.ts:99`), jette
`.startedAt`, et le `runWindow` de la reprise l'écrase par l'heure courante. Un
`grep startedAt` sur `src/` hors tests le confirme : **`state.window.startedAt`
est écrit par cette seule ligne et lu par personne**. C'est la seule trace
durable du début de la plage, et la reprise la détruit au lieu de la lire.

**3. Le résumé de la plage interrompue.** `lastWindow` est un champ privé
(`daemon.ts:82`), absent du schéma persistant (`state.ts:22-33`) : il meurt avec
le processus.

Scénario. `unused start --for 8h` à 22:00. Douze itérations passent, $4,50
dépensés, trois heures écoulées. À 01:00, `systemctl restart unused` : SIGTERM →
`run.ac.abort()` (`daemon.ts:139-142`) → `runWindow` voit `signal.aborted`,
conclut `stopped` et **garde** `state.window` exprès pour la reprise
(`scheduler.ts:141-143`). Sur disque : `{ startedAt: "22:00", until: "06:00" }`.

Au redémarrage, `init` reprend jusqu'à 06:00, `execute` pose
`startedAt: 01:00` et `live` à zéro, `runWindow` réécrit
`startedAt: "01:00"` sur disque. `unused status` affiche alors :

```
plage    manual, jusqu'à 06:00 (5h restantes)
         0 itérations, 0 completed, 0 échecs, 0 attentes quota, $0.00
```

Attendu : une plage commencée à 22:00, déjà à 12 itérations et $4,50. Obtenu :
une plage qui prétend n'avoir rien fait et venir de commencer. La ligne
`dernière …` ne compense rien : `lastWindow` est `null`, et de toute façon la
CLI la masque tant qu'une plage tourne (`cli.ts:106`, `s.lastWindow && !w`).

Rien ne permet de reconstituer le chiffre ailleurs. `state.tasks[].iterations`
survit, mais ne compte que les `completed` (`graph.ts:83`, seule branche qui
l'incrémente) et cumule *toutes* les plages depuis le dernier `reset` : il ne
répond pas à « combien dans celle-ci ». `data/logs/index.jsonl` a une ligne par
itération, mais aucune ne porte la plage à laquelle elle appartient
(`log.ts:47-58`) — et l'heure de début de la plage, seule clé qui aurait permis
de les découper, est justement celle que la reprise écrase.

Conséquence pratique : sur un service redémarré (mise à jour, reboot de
l'hôte), la seule mesure de ce que la plage a consommé — le nombre d'échecs, le
nombre d'attentes quota, le coût — est perdue silencieusement, alors que
`state.window` était là pour la porter.

## Une plage tuée par une exception laisse `lastWindow` sur la plage *précédente*

**Gravité** : sûr
**Où** : `src/daemon.ts:192`, `src/daemon.ts:213-216`, `src/daemon.ts:369`

`lastWindow` n'est affecté que par la résolution de `runWindow` :

```ts
// src/daemon.ts:192-204
this.lastWindow = await this.deps.runWindow( ... );
```

```ts
// src/daemon.ts:213-216
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
}
```

Sur le chemin `catch`, l'affectation n'a pas lieu et rien ne la remplace :
`this.lastWindow` **garde la valeur de la plage d'avant**. Ce n'est pas une
valeur neutre, c'est une valeur fausse : `status` la renvoie sans réserve
(`daemon.ts:369`) et la CLI l'étiquette « dernière ».

Scénario. Plage de lundi : 40 itérations, $12, `endedBecause: "window"` →
`lastWindow` en mémoire. Plage de mardi : trois itérations passent, puis
`runWindow` lève — les chemins existent, `saveState` sur disque plein
(`scheduler.ts:79` / `148`, cf. 017), `writeIterationLog` en échec
(`iterate.ts:217`, cf. 011), une erreur non-`DockerError` remontée par
`runInTask` (`iterate.ts:144-147`), ou `iterate` refusant une tâche qui n'est
plus `running` (`iterate.ts:81-83`). `execute` attrape, met les plages
automatiques en pause, le démon retourne en `idle`, donc `status.window` est
`null` et la ligne s'affiche :

```
dernière 40 itérations, 40 completed, 0 échecs, $12.00 (window)
```

Attendu : le résumé de la plage qui vient de mourir, ou au minimum l'aveu qu'il
n'y en a pas. Obtenu : le résumé d'une plage terminée la veille, présenté comme
celui de la dernière — avec `endedBecause: "window"`, c'est-à-dire « tout s'est
bien passé jusqu'au bout de la plage », pour une plage qui a explosé. Les trois
itérations réellement faites mardi ne sont comptées nulle part : `run.live` est
jeté avec le `Running` (`daemon.ts:224`), `summary` est perdu dans la pile de
`runWindow`. Le message d'erreur est imprimé une fois dans le journal du
service, et c'est tout ce qui reste.

À noter : les consommateurs `--json` (`cli.ts:92`) voient la même valeur périmée
en permanence, y compris pendant la plage suivante.

## `iterations` compte une itération qui n'a jamais démarré, et contredit le compteur de la tâche

**Gravité** : probable
**Où** : `src/scheduler.ts:100-102`, `src/scheduler.ts:123-128`,
`src/daemon.ts:260-265`, `src/iterate.ts:99-106`, `src/iterate.ts:176-183`

Le seul cas soustrait du comptage est l'abandon :

```ts
// src/scheduler.ts:100-102
if (r.outcome.kind === "failure" && r.outcome.reason === "aborted") break;
summary.iterations += 1;
summary.costUsd += r.costUsd ?? 0;
```

puis, dans le `switch`, `stop-window` ne touche à aucun des quatre autres
compteurs (`scheduler.ts:123-128`), et `onEvent` fait le même calcul en
excluant explicitement `stop-window` de `failures` (`daemon.ts:265`). Donc une
panne globale ajoute 1 à `iterations` et à rien d'autre.

Or `iterate` peut rendre `stop-window` **avant d'avoir rien lancé** :

```ts
// src/iterate.ts:99-106
const token = deps.env[TOKEN_ENV];
if (!token) {
  return finishFatal("auth", `${TOKEN_ENV} absent : ...`);
}
const taskEnv = resolveEnv(task.def.env, deps.env);
if (taskEnv.missing.length > 0) {
  return finishFatal("auth", `variables absentes de l'environnement du démon : ...`);
}
```

`finishFatal` (`iterate.ts:232-236`) se contente d'imprimer et de rendre
`{ decision: "stop-window", logFile: null }` : pas de `runInTask`, pas de
container, pas de `writeIterationLog`, pas de `costUsd`.

Scénario. Le `.env` du service perd `CLAUDE_CODE_OAUTH_TOKEN` (ou une tâche
déclare `env: ["GH_TOKEN"]` absent du démon). `unused start --for 1h` : premier
tour de boucle, `pickNext` rend la tâche, `iterate` rend `stop-window`
immédiatement, `break`. Le scheduler imprime :

```
fin de plage (fatal auth) : 1 itérations, 0 completed, 0 échecs, 0 attentes quota, $0.00
```

et `status` la même chose en `dernière … (fatal)`. Aucun container n'a tourné,
`data/logs/<tâche>/` n'a pas gagné un fichier, `index.jsonl` pas une ligne.
Le chiffre affiché ne correspond à rien de vérifiable — et il casse l'égalité
`iterations = completed + failures + backoffs` que toutes les autres décisions
respectent, donc le lecteur ne peut même pas déduire qu'il y a un trou.

Le même incrément se produit dans un cas où le code affirme noir sur blanc le
contraire. Quand la session a réussi mais que `docker commit` échoue :

```ts
// src/iterate.ts:174-183
// Le travail est fait mais l'état ne peut pas être conservé : on ne
// ment pas au curseur, l'itération est réputée n'avoir jamais eu lieu.
outcome = { kind: "fatal", reason: "docker", detail: err.message };
ts.cursor = nodeName;
ts.iterations -= 1;
```

`ts.iterations -= 1` annule l'incrément d'`applyOutcome` (`graph.ts:83`) : côté
tâche, l'itération n'a pas eu lieu. Côté plage, la même itération donne
`decision: "stop-window"` → `summary.iterations += 1`. Les deux compteurs
bougent en sens opposés sur le même événement, et `unused status` affiche les
deux côte à côte (`cli.ts:100` pour la plage, `cli.ts:120` pour la tâche).

L'un des deux a tort ; le commentaire du code dit lequel.

## Un coût inconnu est compté comme zéro, et c'est sur les itérations les plus chères

**Gravité** : probable
**Où** : `src/iterate.ts:230`, `src/scheduler.ts:102`, `src/log.ts:57`,
`src/claude.ts:99-101`

Le coût n'existe que dans le cadre `result` final de la session :

```ts
// src/iterate.ts:230
return { node: nodeName, outcome, decision: finalDecision, logFile, costUsd: session.result?.total_cost_usd, quotaAfter };
```

`parseStream` ne retient que ce cadre-là (`claude.ts:98-109` : les messages
`assistant` et leur `usage` sont comptés dans `lines` puis jetés). Donc pas de
cadre `result` → `costUsd` undefined → `?? 0` dans l'addition
(`scheduler.ts:102`), et `$0.00` dans un total présenté comme exact.

Le journal, lui, fait la distinction :

```ts
// src/log.ts:57
costUsd: rec.result?.total_cost_usd ?? null,
```

`null` y veut dire « inconnu », et `README.md:104-107` en fait une
fonctionnalité (« de quoi rapprocher un coût en dollars d'un pourcentage de
quota »). La plage écrase cette nuance : son `costUsd` est un `number`, `0` y
signifie à la fois « rien dépensé » et « on ne sait pas ».

Scénario. Une tâche dont le skill se bloque (attente d'entrée, build qui
dépasse le budget). Le container est tué au `timeoutMinutes`, 180 min dans
`unused.config.json` (`iterate.ts:129-132`) ; le flux est coupé en cours et
aucun cadre `result` n'arrive, donc `session.result === null` et `costUsd` est
undefined (`iterate.ts:230`). L'issue est `failure/timeout` (`iterate.ts:157`) ;
une session tronquée sans dépassement de délai — container tué par l'OOM, sortie
illisible — prend le même chemin sous le nom `unreadable_output`
(`graph.ts:52`), avec la même perte de coût. Sur une plage de 12 h, quatre
itérations de ce type :

```
plage    calendar, jusqu'à 13:00 (1h restantes)
         4 itérations, 0 completed, 4 échecs, 0 attentes quota, $0.00
```

Attendu : douze heures de sessions Claude, donc un coût très supérieur à zéro,
ou à défaut un aveu d'ignorance. Obtenu : `$0.00`, indistinguable d'une plage
qui n'a rien consommé. Le biais n'est pas symétrique : les itérations qui
rendent un `result` (donc les courtes, y compris les échecs propres) comptent
leur coût correctement ; celles qui tournent jusqu'à la limite de temps — les
plus chères — comptent zéro. Le total ne sous-estime pas au hasard, il
sous-estime exactement là où il y a le plus à compter.

Un substitut existe et n'est pas utilisé : `quotaAfter`, remonté par `iterate`
(`iterate.ts:230`), vient des cadres `rate_limit_event` et survit donc à une
sortie tronquée — l'utilisation des fenêtres 5 h / 7 j bouge même sans cadre
`result`. Ce n'est pas un coût en dollars, mais c'est une mesure de
consommation. Ni `WindowSummary` ni `Running` ne le conservent : le scheduler
reçoit le champ et ne le lit jamais.

## Ce qui a été vérifié et tient

- **`summary` et `run.live` ne divergent pas.** Les deux comptabilités sont
  écrites deux fois (`scheduler.ts:100-137` et `daemon.ts:258-266`) à partir de
  la même `decision`, et les conditions correspondent une à une, y compris le
  filtre d'abandon (`outcome.kind === "failure" && reason === "aborted"`) et
  l'exclusion de `stop-window` des `failures`. La duplication est fragile mais
  aujourd'hui exacte ; les quatre constats ci-dessus touchent les deux de la
  même manière.
- **`costUsd` est bien additionné pour les échecs qui rendent un `result`** :
  `iterate.ts:230` lit `session.result` sans regarder l'`outcome`, donc une
  session qui s'arrête proprement sur un échec (contexte plein, budget de tours
  épuisé) contribue son coût. Seule l'absence de cadre `result` le perd.
- **L'itération abandonnée n'est comptée nulle part** : `scheduler.ts:100`
  sort avant l'incrément, `daemon.ts:260` pose la même garde, `iterate.ts:189`
  ne sauve pas l'état et `iterate.ts:165` n'applique pas la décision. Cohérent
  avec « une itération abandonnée n'a jamais eu lieu ».
- **`backoffs` et `waitingQuotaUntil`** : l'incrément est au bon endroit
  (`scheduler.ts:110`, une fois par décision `backoff`), et
  `waitingQuotaUntil` est bien remis à `null` au départ de l'itération
  suivante (`daemon.ts:256`). S'il reste positionné quand la plage se termine
  pendant l'attente, `this.running = null` (`daemon.ts:224`) le rend
  inatteignable depuis `status`.
- **Le `break` de `scheduler.ts:116`** (`if (wait <= 0) break;`) sort du
  `switch`, pas de la boucle — mais `wait <= 0` implique
  `until() - now <= 0`, donc la condition de boucle termine au tour suivant.
  Pas de tour parasite.
- **`completed`** compte `next-task` et `task-done`, soit exactement les deux
  décisions produites par un `outcome.kind === "completed"` (`graph.ts:82-91`).
  Pas de double comptage du `task-done`.

Hors périmètre de cet aspect, repéré en chemin : une plage **calendrier**
interrompue par un redémarrage est reprise comme plage *manuelle*
(`daemon.ts:101`, `this.manual = { until, resumed: true }`), donc `status`
l'annonce en `source: "manual"` ou `"manual+calendar"` (`daemon.ts:245-250`)
alors que personne n'a appelé `start`. À traiter avec la provenance des plages.
