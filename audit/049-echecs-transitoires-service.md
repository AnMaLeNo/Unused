# 049 — Panne transitoire du service confondue avec un échec de tâche

**Fichiers examinés** : `src/graph.ts:34-53` (`classify`), `src/graph.ts:96-103`
(`applyOutcome`, branche `failure`), `src/graph.ts:107-111` (`isEligible`),
`src/scheduler.ts:129-136` (attente après échec), `src/scheduler.ts:109-122`
(attente après quota, pour comparaison), `src/claude.ts:75-112` (`parseStream`,
`apiRetries`), `src/claude.ts:129-136` (`quotaRejection`),
`src/iterate.ts:150-189` (assemblage de l'issue, rejet du container),
`src/state.ts:9-20` et `:42-59` (`TaskStateSchema`, `ensureTaskState`),
`src/daemon.ts:205-211` (fin de plage), `src/daemon.ts:375-417`
(`taskInfo`, `resetTask`, `setActive`), `src/docker.ts:250-254`
(`removeTaskImages`), `src/cli.ts:113-161` (`printTasks`, `tasks reset`,
`tasks activate`), `src/graph.test.ts:30-68` (ce que les tests figent),
`unused.config.json` (valeurs réellement déployées).

**Verdict** : 3 constats (2 sûrs, 1 à vérifier)

Les trois tiennent à la même chose : `classify` n'a pas de catégorie pour « le
service a flanché ». Tout ce qui n'est ni `completed`, ni un
`rate_limit_event` `rejected`, ni un 401/403 tombe dans `failure`, et `failure`
est la seule issue qui consomme un crédit sur un compteur dont l'état terminal
est irréversible.

## Une panne de quelques minutes sort les tâches de la file pour de bon, et la seule issue détruit leur travail

**Gravité** : sûr
**Où** : `src/graph.ts:49-52`, `src/graph.ts:96-103`, `src/daemon.ts:397-407`

`classify` ne reconnaît comme panne globale que l'authentification :

```ts
const AUTH_STATUSES = new Set([401, 403]);
…
if (r?.api_error_status !== undefined && r.api_error_status !== null && AUTH_STATUSES.has(r.api_error_status)) {
  return { kind: "fatal", reason: "auth", … };
}
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

Un 529 (`Overloaded`), un 500, un 502, un 503, ou un réseau coupé qui laisse la
session mourir sur une sortie illisible, donnent donc tous `failure`. Ce n'est
pas une lecture optimiste du code : `src/graph.test.ts:62` fige exactement cette
forme d'entrée et attend ce résultat —

```ts
expect(classify(res({ terminal_reason: "api_error", api_error_status: 500 }), false))
  .toEqual({ kind: "failure", reason: "api_error" });
```

— et `src/iterate.ts:158` ne rattrape en `fatal` que le démon Docker
(`isDockerDown`, et seulement si `session.lines === 0`), pas l'API.

À partir de là, `applyOutcome` compte les coups :

```ts
case "failure": {
  ts.consecutiveFailures += 1;
  if (ts.consecutiveFailures >= opts.maxConsecutiveFailures) {
    ts.status = "failed";
    return "task-failed";
  }
  return "retry";
}
```

Le scénario, avec les valeurs déployées (`unused.config.json` :
`maxConsecutiveFailures: 3`, `retrySeconds: 60`) :

1. L'API renvoie 529. La session meurt en quelques secondes →
   `failure` → `retry`, `consecutiveFailures = 1`. `applyDecision`
   (`src/graph.ts:147-151`) rend la tâche collante, donc `pickNext` la
   resélectionne (`src/graph.ts:122-125`) : c'est bien la même tâche qui
   encaisse les trois coups.
2. Le scheduler attend `retrySeconds`, soit 60 s (`src/scheduler.ts:133`).
   Deuxième 529 → `consecutiveFailures = 2`. 60 s. Troisième 529 →
   `status = "failed"`, décision `task-failed`.

**Environ 2 min 30 de service dégradé suffisent à sortir une tâche de la file.**
C'est un ordre de grandeur en dessous de la durée d'un incident réel, et c'est
à comparer aux 15 minutes (`backoffMinutes`) que le même scheduler sait attendre
quand le quota est saturé — la panne subie est traitée plus durement que la
limite consentie. Comme `task-failed` libère la tâche collante, la suivante
devient collante et brûle ses trois coups à son tour : avec cinq tâches, la file
entière est vide après ~12 min de panne, et le démon se met en pause sur
`nothing-eligible` (`src/daemon.ts:208-210`).

Le sort est définitif. Une tâche `failed` n'est plus éligible :

```ts
return task.def.active && (ts === undefined || ts.status === "running");
```

et aucun chemin ne ramène `status` à `"running"` pour une tâche existante — la
seule occurrence hors `initialTaskState` est `src/iterate.ts:179`, à l'intérieur
de la branche d'échec de commit d'un `completed`, qui ne peut pas être atteinte
ici. Le seul retour en file passe par `resetTask`, qui efface l'entrée d'état
pour que `ensureTaskState` reparte de `initialTaskState`… et au passage :

```ts
await this.deps.removeTaskImages(name);
```

soit `docker rmi -f <image>:latest <image>:prev` (`src/docker.ts:250-254`).
Or l'image de la tâche *est* son travail : chaque itération `completed` est
commitée dans cette image (`src/iterate.ts:170`). **Remettre en file une tâche
tombée pour cause de 529 exige donc de détruire tout ce qu'elle a accumulé**,
et de la renvoyer sur `task.def.start` avec un container neuf. Une tâche à 400
itérations perd 400 itérations parce que le service a été indisponible deux
minutes et demie.

Facteur aggravant : `consecutiveFailures` est persisté dans `state.json`
(`src/state.ts:16`) et n'est remis à zéro que par un `completed`
(`src/graph.ts:84`). Il ne décroît jamais avec le temps. Trois pannes
transitoires isolées, séparées par des jours et par des plages entières sans
aucune itération réussie entre elles, s'additionnent exactement comme trois
pannes d'affilée.

Le signal qui permettrait de distinguer les deux cas est pourtant déjà lu.
`parseStream` collecte les `system/api_retry` émis quand le CLI réessaie après
une erreur de transport (`src/claude.ts:107`) :

```ts
else if (d.subtype === "api_retry") s.apiRetries.push(d as SessionStream["apiRetries"][number]);
```

`iterate` les recopie dans le journal (`src/iterate.ts:209`) et personne ne les
relit : `grep -rn apiRetries src/` ne donne que la définition du type, le
remplissage, la recopie dans le log, et un test de parsing. `classify` ne reçoit
même pas l'objet qui les porte — sa signature ne prend que
`{ result, rateLimits }` (`src/graph.ts:41-44`). Une session qui a épuisé six
`api_retry` en 529 avant de mourir est, pour le compteur de strikes,
indiscernable d'un skill qui plante sur un bug.

## `tasks activate` dit avoir remis la tâche dans la file sans rien changer

**Gravité** : sûr
**Où** : `src/daemon.ts:410-417`, `src/cli.ts:150-161`

C'est le réflexe naturel face à une tâche affichée `failed` par `unused status`,
et il échoue en silence. La commande se décrit comme « remet une tâche dans la
file » (`src/cli.ts:156`) et confirme `<name> activée` (`src/cli.ts:159`), mais
`setActive` ne touche que le booléen `active` du task.json :

```ts
raw.active = active;
await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
ensureTaskState(this.state, task);
if (active) await this.unpause();
```

`ensureTaskState` renvoie l'entrée existante telle quelle dès qu'elle existe
(`src/state.ts:50-58`) : `status` reste `"failed"`, `consecutiveFailures` reste
à 3. Pire, `unpause()` lève la pause posée par `nothing-eligible`, donc le
démon rouvre une plage, rappelle `pickNext`, ne trouve rien d'éligible, et se
remet en pause. Côté utilisateur : un message de succès, une plage qui démarre,
et zéro itération. Le même aller-retour `deactivate` puis `activate` ne change
rien non plus.

Un `unused tasks list` juste après montre bien `failed` — l'information est
disponible — mais la commande qui vient de répondre « activée » l'a contredite.
À noter aussi que `consecutiveFailures` traverse l'API (`src/daemon.ts:384`,
`DaemonStatus`) sans jamais être affiché : `printTasks` (`src/cli.ts:115-123`)
ne l'imprime pas. Rien ne prévient donc qu'une tâche est à 2 coups sur 3 ; elle
paraît saine jusqu'à ce qu'elle soit morte.

## Un 429 non accompagné d'un `rate_limit_event` `rejected` consomme un strike

**Gravité** : à vérifier
**Où** : `src/graph.ts:45-52`, `src/claude.ts:129-136`

`classify` ne reconnaît le quota que par un événement `rate_limit_event` de
statut `rejected` ; le commentaire de `src/graph.ts:36-40` en fait une règle
explicite. Si une session est refusée par un 429 **sans** qu'un tel événement
soit émis, `api_error_status = 429` n'est pas dans `AUTH_STATUSES` et l'issue
est `failure` : la tâche prend un strike au lieu de déclencher le `backoff`, et
trois refus de ce genre la sortent définitivement de la file — alors que
l'attente de 15 min l'aurait sauvée.

Ce qui rend l'hypothèse crédible, c'est le fixture du dépôt lui-même
(`src/claude.test.ts:41`) :

```
{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429}
```

Le projet sait donc qu'un 429 peut arriver sous forme d'`api_retry` — c'est-à-dire
par un canal que `classify` ne regarde pas — et pas seulement sous forme de
`rate_limit_event`. `src/graph.test.ts:36-47` ne teste que le cas où les deux
sont présents simultanément.

Je classe « à vérifier » et non « sûr » parce que trancher demande d'observer ce
que le CLI émet réellement quand ses `api_retry` sur 429 s'épuisent : si un
`rate_limit_event` `rejected` est toujours émis dans ce cas, le code est juste.
La vérification tient en une session : provoquer un 429 répété et regarder si le
NDJSON contient un `rate_limit_event` de statut `rejected` en plus des
`api_retry`. Elle n'a pas été faite ici, faute de token dans ce container.

## Ce qui a été vérifié et tient

- Le quota saturé est bien traité à part et ne consomme pas de strike :
  `quotaRejection` prime sur tout dans `classify` (y compris sur un `completed`
  tardif, `src/graph.test.ts:50`), `applyOutcome` renvoie `backoff` sans
  toucher à `consecutiveFailures`, et le scheduler attend jusqu'au `resetsAt`
  annoncé plus 30 s de marge, borné par la fin de plage
  (`src/scheduler.ts:110-121`).
- L'abandon demandé (`aborted`) est correctement neutralisé : `src/iterate.ts:162`
  court-circuite `applyOutcome`, l'état n'est pas sauvegardé
  (`src/iterate.ts:189`), et `src/scheduler.ts:100` sort de la boucle avant même
  d'incrémenter les compteurs de plage. Un `unused stop --now` au milieu d'une
  panne ne fait donc pas avancer les strikes.
- Les pannes `fatal` (auth, Docker) sont, elles, traitées comme des pannes
  transitoires au bon sens du terme : `stop-window` conserve `state.window`
  (`src/scheduler.ts:147`) pour que la plage soit reprise après réparation, et
  aucun compteur de tâche n'est touché. C'est précisément l'asymétrie décrite
  dans le premier constat : la panne Docker est réparable, la panne API est
  capitale.
- Le `timeout` de session (`timeoutMinutes: 180`) produit un `failure` et donc
  un strike, ce qui est cohérent avec son intention : 3 h sans terminer est un
  problème de tâche, pas de service. Rien à signaler.
- `discardContainer` + `rm(donePath)` sont bien appelés sur toute issue non
  `completed` (`src/iterate.ts:184-187`) : une panne transitoire ne laisse ni
  container ni DONE parasite derrière elle. L'itération est bien « réputée
  n'avoir jamais eu lieu » au sens du container ; c'est seulement le compteur de
  strikes qui, lui, s'en souvient.
