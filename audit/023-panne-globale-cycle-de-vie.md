# 023 — Panne globale : jamais persistée, levée seulement par `start`, reprise après redémarrage

**Fichiers examinés** : `src/daemon.ts:33-34,83,96-135` (`init`, `deadline`,
`calendarEnd`), `src/daemon.ts:137-175` (`run`, `idle`), `src/daemon.ts:177-226`
(`execute`), `src/daemon.ts:284-326` (`startWindow`, `stopWindow`),
`src/daemon.ts:328-373` (`status`), `src/scheduler.ts:104-149`,
`src/iterate.ts:99-106,144-147,155-190,232-236`, `src/graph.ts:41-53,81-105,118-152`,
`src/state.ts:22-33`, `src/log.ts:42-67`, `src/cli.ts:48-57,86-111`,
`deploy/unused.service`, `unused.config.json`, `src/daemon.test.ts:223-240`
**Verdict** : 3 constats (2 sûrs, 1 probable)

## Une panne `docker` transitoire éteint le calendrier pour de bon : aucun réveil n'est armé

**Gravité** : sûr
**Où** : `src/daemon.ts:163-165` (avec `src/daemon.ts:123-124` et `src/iterate.ts:158`)

La panne globale est traitée comme un état qui ne peut être quitté que par une
intervention humaine. Une fois `this.fatal` posé, le calendrier est court-circuité
en deux endroits, et le second supprime **le seul minuteur du processus** :

```ts
// daemon.ts:123-124
private calendarEnd(now: Date): Date | null {
  if (this.fatal) return null;
```

```ts
// daemon.ts:161-165
private idle(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const next = this.fatal ? null : this.nextCalendarStart();
    const ms = next ? Math.max(0, next.getTime() - this.deps.now().getTime()) : null;
    const timer = ms !== null ? setTimeout(done, Math.min(ms, 2_147_000_000)) : null;
```

`ms === null` → aucun `setTimeout`. La boucle `run()` reste bloquée dans cette
promesse jusqu'à ce que quelqu'un appelle `this.wake`, et seuls trois chemins le
font : `startWindow` (`daemon.ts:299`) et `unpause` (`daemon.ts:242`), appelé par
`resetTask` et `setActive` — mais `unpause` ne touche pas à `fatal`, donc le tour
de boucle suivant retombe dans `idle()`. **Rien dans le processus ne réessaie
jamais.** À comparer au quota saturé, qui se réveille tout seul
(`scheduler.ts:109-121`), et à un `failure`, qui réessaie après `retrySeconds`.

Or une des deux causes de panne est détectée sur une *seule* observation, à partir
du texte de stderr :

```ts
// iterate.ts:158
else if (session.lines === 0 && isDockerDown(r.stderr)) outcome = { kind: "fatal", reason: "docker", detail: r.stderr.trim() };
```

```ts
// iterate.ts:59
const DOCKER_DOWN = /Cannot connect to the Docker daemon|docker daemon is not running|error during connect|permission denied while trying to connect to the Docker daemon/i;
```

Rien n'exige que cette indisponibilité soit durable, et la condition
`session.lines === 0` ne la limite pas au démarrage du container : la config
livrée utilise `--output-format json` (`unused.config.json:5-7`), donc `claude`
n'écrit son unique objet JSON qu'à la toute fin. Pendant les 180 minutes de
`timeoutMinutes`, stdout est vide et `session.lines` vaut 0. **Toute la durée de
l'itération est donc une fenêtre où un dockerd qui tombe produit une panne
globale**, et non la seconde de démarrage.

**Scénario concret.** Calendrier livré : une seule plage par semaine, lundi
00:00–13:00 (`unused.config.json:18-26`).

1. Lundi 00:05, itération 1 de `t1` en cours. dockerd est tué (OOM killer sur le
   Pi, cf. `docker/Dockerfile:12` ; ou plantage) et redémarre seul 4 s plus tard
   grâce à son propre `Restart=always` — ce qui **ne** redémarre pas `unused`,
   dont l'unité ne dépend de docker.service qu'en `Requires=`/`After=`
   (`deploy/unused.service:7-9`) : aucun arrêt explicite de docker.service n'a eu
   lieu, donc aucune propagation.
2. `docker run` sort en erreur, stdout vide, stderr « error during connect: …
   EOF ». → `fatal docker`, `stop-window`, `summary.endedBecause = "fatal"`.
3. `execute` pose `this.fatal` (`daemon.ts:205-207`), `this.manual = null`, puis
   la boucle : `deadline(null)` = `max()` d'une liste vide = `now`
   (`daemon.ts:116-121`) → `idle()` → **aucun minuteur**.
4. À 00:06, dockerd est de nouveau parfaitement sain. Il reste 12 h 54 de plage.
   Résultat obtenu : rien ne tourne, ni cette plage, ni celle de lundi prochain,
   ni les suivantes. Résultat attendu : ce que fait n'importe quelle autre issue
   non-`completed` — réessayer, au pire après `backoffMinutes`.

Le coût n'est pas une plage mais *toutes* les plages, jusqu'à ce qu'un humain
tape `unused start` ou redémarre le service : avec ce calendrier, une hoquet de
4 s de dockerd coûte une semaine entière de quota par semaine d'inattention.
`unused status` dit la vérité (`cli.ts:94`), mais il faut aller la lire.

Deux constats déjà écrits notent le symptôme **inverse** — un vrai problème Docker
que `DOCKER_DOWN` ne reconnaît pas et qui dégénère en `task-failed`
(`audit/004`, constat 3 ; `audit/006`). Les deux branches de l'alternative sont
donc fausses : reconnu → arrêt définitif, non reconnu → tâche condamnée. Aucune
ne réessaie.

## Une panne globale épingle la tâche fautive et aucun compteur ne l'en délogera

**Gravité** : probable
**Où** : `src/graph.ts:94-95` et `src/graph.ts:147-151`, avec `src/graph.ts:118-125`

`applyOutcome` traduit un `fatal` en `stop-window` **sans toucher au compteur
d'échecs** :

```ts
// graph.ts:92-103
case "quota":
  return "backoff";
case "fatal":
  return "stop-window";
case "failure": {
  ts.consecutiveFailures += 1;
  if (ts.consecutiveFailures >= opts.maxConsecutiveFailures) {
    ts.status = "failed";
    return "task-failed";
```

et `applyDecision` range `stop-window` avec `backoff`/`retry`, c'est-à-dire du
côté des décisions qui rendent la tâche **collante** :

```ts
// graph.ts:147-151
case "backoff":
case "retry":
case "stop-window":
  state.currentTask = task.name;
```

`iterate` appelle bien les deux et **persiste** (`iterate.ts:165,189`). Il en
résulte un épinglage durable : `pickNext` sert la tâche collante avant tout
round-robin (`graph.ts:122-125`), la tâche reste éligible (statut `running`,
`graph.ts:108-110`), aucun compteur n'arrivera jamais à `maxConsecutiveFailures`
pour elle, et aucun des chemins qui lèvent la panne ne remet `currentTask` à nul :
ni `startWindow` (`daemon.ts:294-299`, qui ne touche que `manual`, `fatal` et
`pausedUntil`), ni `init` (`daemon.ts:96-113`). Le seul effacement est
`resetTask` (`daemon.ts:401`) — qui détruit au passage les images de la tâche.

Tant que la panne est réellement globale (token révoqué), l'épinglage est sans
effet. Il devient un blocage total dès que la cause est propre à *une* tâche, ce
que le code produit lui-même :

```ts
// iterate.ts:172-182
} catch (err) {
  if (!(err instanceof DockerError)) throw err;
  outcome = { kind: "fatal", reason: "docker", detail: err.message };
  …
  applyDecision(state, task, "stop-window");
```

`commitTask` lève une `DockerError` pour des causes qui dépendent de la taille de
l'image de *cette* tâche : `layerCount` puis `flattenTask` passent par
`mustSucceed`, et l'aplatissement fait transiter tout le système de fichiers par
`docker export | docker import` (cf. `audit/005`, qui traite l'atomicité de ce
même `catch` ; ici c'est sa conséquence sur la file qui est en cause).

**Scénario concret.** `tasks/` contient `big` (31 couches, plusieurs Go) et
`small`. `flattenAfterLayers: 30`.

1. Lundi 00:00, plage ouverte. `pickNext` sert `big`, l'itération se termine en
   `completed` après 90 min. `commitTask` commite, compte 31 couches, aplatit →
   `ENOSPC` sur la carte SD → `DockerError`.
2. `fatal docker`, curseur de `big` ramené en arrière, `currentTask = "big"`,
   `state.json` sauvé. Plage arrêtée, `this.fatal` posé.
3. L'opérateur voit `PANNE docker : … no space left`, libère 2 Go et tape
   `unused start --for 8h`. `dockerVersion` et `imageExists` répondent bien
   (`daemon.ts:287-293`), la plage repart.
4. `pickNext` : `currentTask = "big"` toujours éligible → `big`. 90 min
   d'itération, commit, 32 couches, aplatissement d'une image plus grosse que les
   2 Go libérés → `ENOSPC` → panne, plage arrêtée. Retour à l'étape 3.

Résultat obtenu : `small`, qui n'a besoin de rien, **ne tourne plus jamais** ; le
round-robin annoncé en tête de `scheduler.ts:48-49` ne reprend pas la main, et
chaque cycle brûle 90 min de quota jetées. Résultat attendu : ce que `failure`
obtient au bout de `maxConsecutiveFailures` — la tâche sort de la file et les
autres continuent.

Gravité « probable » et non « sûr » : les trois faits de code sont certains
(collage, absence de comptage, aucun effacement) et la starvation en découle
mécaniquement dès qu'une panne est propre à une tâche ; ce qui reste
environnemental, c'est l'échec répété d'un `docker export` — un `ENOSPC` franc,
une fois de l'espace libéré en quantité suffisante, laisse le cycle se débloquer.
Le même épinglage s'obtient avec un `403` propre à un nœud, `classify`
(`graph.ts:49-51`) rangeant tout `403` parmi les pannes d'authentification alors
qu'un nœud peut choisir son modèle (`args`, `task.ts:35`) et ses variables
(`env`, `task.ts:46`).

## Le verrou de panne n'existe qu'en mémoire : un redémarrage quelconque le lève, et la panne ne laisse aucune trace dans `data/`

**Gravité** : sûr
**Où** : `src/daemon.ts:83` et `src/iterate.ts:99-102,232-236`

`fatal` est un champ privé du `Daemon` (`daemon.ts:83`) ; `RunnerStateSchema`
(`state.ts:22-33`) n'a pas de place pour lui. Le contrat annoncé à l'opérateur est
pourtant explicitement à deux issues :

```ts
// daemon.ts:207
`PANNE … — plus rien ne tourne jusqu'à un \`unused start\` (ou un redémarrage du service une fois réparé)`
```

Le « une fois réparé » n'est pas une condition que le code vérifie : c'est un
espoir. Le redémarrage lève le verrou *quoi qu'il arrive*, et il n'est pas
toujours décidé par un humain qui vient de réparer — `Restart=always` +
`RestartSec=5` (`deploy/unused.service:18-19`), un déploiement, une coupure de
courant sur le Pi. Le verrou est donc à la fois trop rigide (constat 1 : jamais
levé quand la cause a disparu) et trop faible (ici : levé quand la cause
persiste).

Reste alors la trace. Pour la panne d'authentification la plus banale — le token
absent — il n'y en a aucune dans `data/` :

```ts
// iterate.ts:99-102
const token = deps.env[TOKEN_ENV];
if (!token) {
  return finishFatal("auth", `${TOKEN_ENV} absent : lance \`claude setup-token\` …`);
}
```

```ts
// iterate.ts:232-236
function finishFatal(reason, detail): IterateResult {
  const outcome: Outcome = { kind: "fatal", reason, detail };
  print(`panne    ${detail.split("\n")[0]}`);
  return { node: nodeName, outcome, decision: "stop-window", logFile: null };
}
```

Ce retour anticipé saute tout ce qui écrit : pas d'`applyOutcome` (donc `ts.last`
et `consecutiveFailures` inchangés), pas d'`applyDecision`, pas de `saveState`
(`iterate.ts:164-189`), et pas de `writeIterationLog` — donc **ni fichier dans
`data/logs/<tâche>/`, ni ligne dans `index.jsonl`** (`log.ts:42-67`). Le chemin
`401/403` de `classify`, lui, journalise bien : c'est la panne « token absent »
qui est muette.

**Scénario concret.** Le token est régénéré et la ligne de `/opt/unused/.env` est
laissée vide (`CLAUDE_CODE_OAUTH_TOKEN=`, cas déjà relevé par `audit/012`) : Node
en fait une chaîne vide, donc falsy.

1. Lundi 00:00, la plage automatique s'ouvre. Itération 1 : `finishFatal("auth")`.
   Aucun container n'a tourné, rien n'est écrit dans `data/` sauf `state.window`
   que `runWindow` avait posé en entrée et que la panne conserve
   (`scheduler.ts:78,147`). `this.fatal` en mémoire, `idle()` sans minuteur.
2. Mardi 04:00, coupure de courant ; systemd relance.
3. `init` : `window.until` = lundi 13:00 < maintenant → « plage enregistrée
   expirée, oubliée », `state.window = null`. `fatal` repart à `null`,
   `lastWindow` à `null`.
4. `unused status` affiche alors : `plage aucune`, `prochaine plage automatique
   <lundi prochain 00:00>`, et chaque tâche `active … dernier <nœud> →
   completed (<la semaine d'avant>)`. Aucune ligne `PANNE`, aucune ligne
   `dernière …`. C'est mot pour mot le status d'un démon en pleine santé qui
   attend sa plage.

Résultat obtenu : un état où plus rien ne signale qu'une plage s'est ouverte et a
été tuée par une panne globale — `state.json` ne le sait pas, `logs/index.jsonl`
non plus, `status` non plus ; seule la sortie journald du démon le dit. Et le
lundi suivant recommence à l'identique, toujours sans trace. Résultat attendu :
une panne globale qui survit au redémarrage, ou au minimum qui laisse dans `data/`
de quoi la reconstituer.

Distinct du constat 1 d'`audit/021` (les *compteurs* de la plage sont perdus au
redémarrage) : ce qui saute ici, c'est le verrou lui-même, et l'absence totale
d'écriture sur le chemin `finishFatal`.

## Ce qui a été vérifié et tient

- **Pas d'emballement après une panne.** `deadline()` prend le max de la plage
  manuelle et du calendrier, et seul le second est coupé par `fatal` : une panne
  avec `this.manual` encore posé ferait donc repartir une plage aussitôt, en
  boucle serrée. Ce cas est inatteignable. Le `finally` d'`execute`
  (`daemon.ts:223`) remet `manual` à nul sauf si `run.ac.signal.aborted &&
  !explicitStop`, et `run.ac` n'est abandonné que par l'abort du démon (la boucle
  `run()` sort alors sur `!signal.aborted`) ou par `stopWindow(now)`, qui pose
  `explicitStop` avant d'abandonner (`daemon.ts:319-322`). Toutes les branches où
  la boucle continue ont donc `manual === null`.
- **`startWindow` ne lève la panne qu'après les contrôles Docker**
  (`daemon.ts:287-296`) : un `start` alors que dockerd est toujours absent sort en
  409 et laisse `fatal` en place. Une panne `docker` ne peut pas être effacée par
  mégarde ; une panne `auth`, elle, n'a aucun contrôle équivalent, mais la plage
  relancée meurt sur sa première itération.
- **L'arrêt explicite gagne contre la conservation de la plage.** Une panne
  garde `state.window` (`scheduler.ts:147`) mais le `finally` d'`execute`
  l'efface quand `explicitStop` est posé (`daemon.ts:218-222`) : un `stop`
  suivi d'une panne sur la dernière itération ne laisse pas de plage à reprendre.
  (Le trou jumeau, `stop` reçu avant que `running` ne soit posé, est déjà
  documenté dans `audit/022`.)
- **`stop-window` implique toujours `outcome.kind === "fatal"`** avec le
  `runIteration` réel : `iterate.ts:188` force la décision depuis l'issue, et
  `applyOutcome` ne rend `stop-window` que dans le `case "fatal"`
  (`graph.ts:94-95`). Le `if` de `scheduler.ts:125` ne peut donc pas laisser
  `summary.fatal` indéfini en production — sinon la plage se terminerait en
  `endedBecause: "fatal"` sans que le démon ne pose `this.fatal`
  (`daemon.ts:205`), donc sans couper le calendrier, et repartirait en boucle
  serrée. Défaut latent réservé à un `runIteration` injecté ; non démontrable ici.
- **`endedBecause` écrasé par `"stopped"` quand le signal est abandonné**
  (`scheduler.ts:141-143`) n'égare pas la panne : `summary.fatal` survit et le
  démon teste bien `lastWindow.fatal`, pas `endedBecause`. La combinaison exige
  un abort tombant entre le retour d'`iterate` et le `switch`, et le démon est de
  toute façon en train de sortir.
- **`resetTask`/`setActive` ne relancent rien sous panne** : `unpause()` réveille
  la boucle, mais `calendarEnd` rend toujours `null` et le tour suivant retourne
  dans `idle()`. (Le revers — la pause détruite par `unpause` — est traité dans
  `audit/002`.)
- **`status()` sous panne est cohérent** : `window: null` (ni `running` ni
  `manual`), `nextCalendarStart: null` (`daemon.ts:366`), `fatal` renseigné ;
  c'est ce que vérifie `daemon.test.ts:223-240`.
- **La seconde panne `auth` d'`iterate` (variables de tâche absentes,
  `iterate.ts:103-106`) est inatteignable** : `loadTask` refuse déjà la tâche au
  chargement (`task.ts:156-159`), `loadTasks` la range dans `errors` et
  `pickNext` ne la voit jamais. Cherché là une escalade « une tâche mal
  configurée provoque une panne globale » : elle n'existe pas.
- **La reprise après panne au redémarrage** est conforme à ce qui est annoncé —
  déjà vérifié par `audit/004`, non rejoué ici.
