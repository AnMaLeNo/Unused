# 067 — Classification des échecs de `docker run`

**Fichiers examinés** : `src/iterate.ts:55-63,110-185,196-230`, `src/docker.ts:27-68,126-180`,
`src/graph.ts:41-105`, `src/claude.ts:86-112`, `src/scheduler.ts:96-137`,
`src/daemon.ts:190-220,397-407`, `src/cli.ts:143-162`, `src/iterate.test.ts:100-180`,
`deploy/unused.service`, `unused.config.json`
**Verdict** : 3 constats (2 sûrs, 1 à vérifier)

## Un `docker run` qui n'a jamais démarré la session est facturé à la tâche

**Gravité** : sûr
**Où** : `src/iterate.ts:155-160`, `src/docker.ts:130-150`

`docker()` ne lève jamais sur code ≠ 0 (`src/docker.ts:27`, commentaire assumé :
« c'est l'appelant qui décide »), et `runInTask` ne décide rien : il rend
`{ code, stdout, stderr }` tel quel (`src/docker.ts:148-149`). Côté appelant, le
code de sortie n'est lu nulle part pour classer : il est seulement recopié dans
le journal (`exitCode: r.code`, `src/iterate.ts:203`) et affiché
(`src/iterate.ts:219`). Vérifié par `grep` sur tout `src/` : aucune autre lecture
de `r.code`.

La chaîne de classement est donc :

```ts
if (aborted) outcome = { kind: "failure", reason: "aborted" };
else if (timedOut) outcome = { kind: "failure", reason: "timeout" };
else if (session.lines === 0 && isDockerDown(r.stderr)) outcome = { kind: "fatal", reason: "docker", … };
else outcome = classify(session, done);
```

Tout échec de lancement de `docker run` — par convention `docker` sort 125 quand
il échoue lui-même, 126/127 quand il ne peut pas exécuter la commande — tombe
donc dans le `classify` final avec `result: null` (stdout vide, rien à parser :
`src/claude.ts:86-112`), ce qui rend `{ kind: "failure", reason:
"unreadable_output" }` (`src/graph.ts:52`), sauf si le texte de stderr contient
l'une des quatre phrases de `DOCKER_DOWN`.

Scénario concret, disque plein (le cas attendu à terme sur la machine cible : une
image est commitée à *chaque* itération, `src/docker.ts:166-180`, et l'aplatissement
n'intervient qu'au bout de 30 couches) :

1. `docker run` échoue à créer la couche d'écriture, code 125, stdout vide,
   stderr `docker: Error response from daemon: … : no space left on device.`
2. `isDockerDown` → false (aucune des quatre phrases), `session.lines === 0`,
   `classify` → `failure: unreadable_output`.
3. `applyOutcome` (`src/graph.ts:96-103`) : `consecutiveFailures += 1`, décision
   `retry`, attente `retrySeconds` (60 s) puis rejeu du même nœud.
4. À la 3ᵉ passe (`maxConsecutiveFailures: 3`) : `ts.status = "failed"`,
   décision `task-failed`. La tâche sort définitivement de la file
   (`isEligible` exige `status === "running"`, `src/graph.ts:110`).
5. L'itération suivante prend la tâche d'après, qui subit exactement le même
   sort. En ~3 minutes par tâche, toutes les tâches sont `failed`, la plage
   finit en `nothing-eligible` (`src/scheduler.ts:90`) et le démon se met en
   pause « plus rien à faire ».

Résultat obtenu : toutes les tâches marquées en échec définitif, quota non
consommé, aucune panne signalée (`status` n'affiche pas de `fatal`, `summary.fatal`
reste vide). Résultat attendu : `fatal:docker` → `stop-window`, la plage est
conservée et reprise une fois le disque libéré — c'est exactement ce que fait
déjà le même fichier quand c'est `docker commit` qui échoue sur le même disque
plein (`src/iterate.ts:170-182` : `DockerError` → `fatal:docker`). Même panne,
deux verdicts opposés selon la sous-commande `docker` qui l'a rencontrée.

Le coût de la sortie de file est réel : il n'existe aucune commande qui remette
une tâche `failed` en `running` en gardant son travail. `tasks activate` ne
touche que `active` dans task.json (`src/daemon.ts:410-415`) et ne change pas
`status` ; `tasks reset` remet le curseur au nœud de départ **et supprime les
images de la tâche** (`removeTaskImages`, `src/daemon.ts:397-406`), donc jette
l'intégralité de l'état accumulé. Hors édition manuelle de `data/state.json`, la
seule issue est la perte de tout l'historique de la tâche.

Mêmes conséquences pour les autres fautes globales qui se présentent en code 125
sans phrase reconnue : image de la tâche ou image de base absente
(`docker system prune`, `rmi` à la main) → `Unable to find image … locally` puis
`pull access denied …` ; `--storage-opt`/montage invalide ; chemin d'un montage
contenant un `:` (`src/docker.ts:141-143`, aucune validation) ; `claude` absent
du PATH de l'image aplatie → code 127. Dans tous ces cas, la session n'a jamais
tourné, et pourtant l'itération est comptée contre la tâche.

À noter : `consecutiveFailures` n'est remis à zéro que par un `completed` de la
*même* tâche (`src/graph.ts:84`) — jamais par le temps ni par un redémarrage du
démon. Deux échecs d'infrastructure laissés par une panne lundi suffisent donc à
faire sortir la tâche de la file au premier échec réel mardi.

## La détection de panne Docker est inatteignable dès qu'une ligne a été émise

**Gravité** : sûr
**Où** : `src/iterate.ts:158`

La condition est conjonctive : `session.lines === 0 && isDockerDown(r.stderr)`.
`session.lines` compte toute ligne de stdout commençant par `{` et parsable
(`src/claude.ts:88-97`), c'est-à-dire *la première ligne du flux*, le
`system/init` émis au démarrage de `claude -p`. Autrement dit, la panne Docker
n'est reconnaissable que si le démon était déjà injoignable **avant** que la
session n'écrive quoi que ce soit.

Or une session dure jusqu'à `timeoutMinutes` (180 par défaut dans
`unused.config.json`). Si le démon Docker disparaît pendant ces trois heures
(crash, OOM-kill de `dockerd`, rechargement, socket qui change de droits), le
`docker run` attaché perd sa connexion et sort en erreur, mais stdout contient
déjà des dizaines de lignes : `session.lines > 0`, donc `isDockerDown` n'est
même pas appelé, quel que soit le contenu de stderr. Le message est alors ignoré
*alors qu'il est dans la liste* : `error during connect` figure dans
`DOCKER_DOWN` (`src/iterate.ts:59`) et ne correspond à aucun cas où
`session.lines === 0` — c'est l'erreur de connexion en vol, précisément celle
que le garde `lines === 0` rend inaccessible.

Le flux tronqué n'a pas de message `result`, donc `classify` rend
`failure: unreadable_output` (`src/graph.ts:52`) et on retombe dans l'escalade du
constat précédent : `retry`, `retry`, `task-failed`, puis les tâches suivantes.
Résultat obtenu : la panne d'infrastructure est imputée aux tâches, qui sortent
de la file ; résultat attendu : `fatal:docker`, plage conservée, reprise après
réparation.

Le test existant ne couvre que la moitié atteignable du garde : il injecte
`{ code: 125, stdout: "", stderr: "docker: Cannot connect to the Docker daemon …" }`
(`src/iterate.test.ts:136-140`), c'est-à-dire stdout vide **et** phrase anglaise
exacte. Rien ne teste la panne survenue en cours de session.

## `isDockerDown` lit un canal qui transporte aussi la sortie d'erreur du container

**Gravité** : à vérifier
**Où** : `src/iterate.ts:62-63,158`, `src/docker.ts:40-43`

`docker run` est lancé sans `-t` avec stderr en `pipe` (`src/docker.ts:30-33`) :
le `r.stderr` rendu par `runInTask` mélange les diagnostics de la CLI `docker`
et la sortie d'erreur du processus exécuté dans le container. La reconnaissance
de panne se fait donc par recherche de phrase dans un tampon dont le contenu est
en partie produit par la session elle-même.

Conséquence symétrique du constat précédent : si une session écrit sur stderr un
texte contenant `Cannot connect to the Docker daemon` (cas très atteignable ici :
un skill qui lance `docker …` dans le container, où aucune socket Docker n'est
montée — `src/docker.ts:134-146` — reçoit mot pour mot ce message) **et** que
stdout ne contient aucune ligne JSON parsable, alors `outcome` devient
`fatal:docker` avec `detail` = la sortie du container. Décision `stop-window`,
`summary.fatal` renseigné, `this.fatal` posé dans le démon, et plus rien ne
tourne jusqu'à un `unused start` manuel (`src/daemon.ts:204-206`) — pour une
infrastructure parfaitement saine.

Ce que je n'ai pas pu démontrer : la conjonction exacte. Il faut `lines === 0`,
donc une session qui ne produit *aucune* ligne NDJSON lisible tout en ayant
laissé ce texte sur stderr. C'est pour cette raison que la gravité reste « à
vérifier » : le défaut de conception (un test de phrase sur un canal non fiable)
est certain, son déclenchement dépend d'un scénario que je n'ai pas réussi à
rendre certain par la seule lecture.

## Ce qui a été vérifié et tient

- Le chemin `DockerError` (`src/iterate.ts:144-147`) couvre bien ce que
  `runInTask` peut lever : `docker` absent du PATH / échec de `spawn`
  (`src/docker.ts:44-50`). `resolveTaskImage` et `imageExists` n'y lèvent pas.
- Les gardes `aborted` et `timedOut` passent avant la classification du flux,
  donc une session tuée par le runner n'est jamais confondue avec un échec de
  lancement, et le code 137 correspondant n'a pas besoin d'être lu.
- Le chemin « commit impossible » (`src/iterate.ts:170-182`) est cohérent :
  curseur et compteur d'itérations rendus à leur valeur d'avant, container jeté,
  DONE retiré, `fatal:docker` → `stop-window`.
- `discardContainer` ignore volontairement l'échec de `docker rm -f`
  (`src/docker.ts:152-154`) ; appelé après un `docker run` qui n'a créé aucun
  container, il n'introduit pas d'erreur.
- `exitCode`, `stderr` et `rawStdout` figurent bien dans l'enregistrement de
  journal (`src/iterate.ts:196-216`) : l'information nécessaire au bon classement
  est capturée, elle n'est simplement pas utilisée pour décider.
