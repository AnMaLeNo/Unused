# 076 — Angle charge : boucle serrée d'échecs rapides, `retrySeconds` sans plancher, logs / containers / quota sans plafond

**Fichiers examinés** : `src/scheduler.ts:104-139` (les quatre branches du
`switch`, les deux attentes), `src/scheduler.ts:34-45` (`sleep`),
`src/scheduler.ts:83-102` (tête de boucle, `loadTasks`, sortie `aborted`),
`src/scheduler.ts:141-155` (sorties et motif de fin), `src/config.ts:8-44`
(toutes les bornes du schéma) et `unused.config.json` (le régime réellement
livré), `src/log.ts` (entier : `writeIterationLog`, `index.jsonl`),
`src/graph.ts:81-105` (`applyOutcome`, le seul compteur de strikes),
`src/graph.ts:107-153` (`isEligible`, `pickNext`, `applyDecision`),
`src/iterate.ts:112-190` (classement, rejet du container, rollback de commit)
et `:191-217` (ce qui part dans le journal), `src/docker.ts:28-60` (`docker()`),
`:130-150` (`runInTask`), `:152-185` (`discardContainer`, `commitTask`,
`pruneTask`), `src/daemon.ts:137-158` (boucle principale, `idle`),
`:177-243` (`execute`, `pauseUntil`), `:252-274` (`onEvent`),
`src/calendar.ts:60-78` (`coverageEnd`, `nextStart`), `src/task.ts:27-67`
(ce que le schéma de graphe borne), `src/state.ts:42-84`, `src/api.ts:27-37`.

Rapports antérieurs relus avant d'écrire, pour ne pas redire : 001, 003, 005,
011, 013, 015, 018, 019, 021, 026, 027, 029, 036, 037, 041, 043, 045, 046, 047,
049, 051, 055, 056, 058, 063, 065.

**Verdict** : rien trouvé — aucun défaut nouveau et démontrable sur cet angle.
Tous les chemins de charge que la lecture rend réellement atteignables sont
soit bornés, soit déjà déposés par un rapport antérieur, nommé ci-dessous.

Ni `node` ni `docker` ne sont installés dans ce conteneur : tout ce qui suit est
établi par lecture du code, en suivant les références d'un appel à l'autre.

## Ce qui a été vérifié et tient

**1. La boucle de retry est bornée par le compteur de strikes, et le plancher
manquant ne la rend pas chaude.** `retrySeconds` est le seul délai sans
plancher (`scheduler.ts:133`, à comparer au `Math.max(target, 60_000)` de la
branche quota ligne 115), et `config.ts:38` l'autorise à zéro
(`z.number().nonnegative()`). Mais le `if (wait > 0)` de la ligne 134 absorbe
le cas, et surtout la boucle qui en dépend est fermée : tout `outcome.kind ===
"failure"` passe par `applyOutcome` (`graph.ts:96-103`), qui incrémente
`ts.consecutiveFailures` et met la tâche en `failed` dès le seuil ; `pickNext`
l'écarte alors (`graph.ts:108-110`) et la plage sort en `nothing-eligible`.
Le plafond est donc `maxConsecutiveFailures × tâches éligibles` itérations par
plage, soit 3 par tâche avec la config livrée. J'ai cherché un chemin d'échec
qui rende la main au `switch` *sans* consommer de strike : il n'y en a aucun.
Les deux seuls `decision: "retry"` qui ne passent pas par `applyOutcome` sont
le `dryRun` (`iterate.ts:96`, jamais atteint depuis `runWindow` : le
`runIteration` par défaut ne passe pas l'option, `scheduler.ts:66`) et l'issue
`aborted` (`iterate.ts:163`), que la boucle intercepte avant le `switch`
(`scheduler.ts:100`). `retrySeconds: 0` était déjà examiné et classé sans
conséquence par 013 (§ *vérifié et tient*).

**2. La branche quota n'a pas de compteur de strikes — et c'est le
comportement juste.** Vérifié par `grep` que `maxConsecutiveFailures` n'est lu
qu'en deux endroits (`iterate.ts:164`, `graph.ts:98`) et que `summary.backoffs`
n'est jamais comparé à quoi que ce soit (`scheduler.ts:110,153`,
`daemon.ts:264`, `cli.ts:100` : incrémenté, affiché, rien d'autre). Une
saturation qui dure plus longtemps que l'attente se traduit donc par une
répétition sans fin : itération rejetée → attente ≥ 60 s → même nœud, la tâche
restant collante (`applyDecision`, `graph.ts:147-150`). Je ne le dépose pas en
constat : attendre la réouverture du quota *est* la bonne conduite, le coût par
cycle est une session rejetée en quelques secondes, et le plafond réel est la
fin de plage (`Math.min(…, until() - nowMs)`). Les défauts démontrables de
cette branche sont ailleurs et déjà déposés : arrêt gracieux non honoré pendant
l'attente (003 §1), attente tronquée annoncée comme une reprise (003 §2),
`resetsAt` ignoré quand il n'est que dans `unifiedWindows` → repli sur
`backoffMinutes` (003 §3), attente non persistée au redémarrage (043 §1),
saturation sans `rejected` comptée en échec et sortie définitive après trois
coups (046 §2, 049 §3), itération gâchée quand la plage s'étend pendant
l'attente (056).

**3. La boucle principale du démon ne tourne pas à vide après une fin de
plage.** Les cinq sorties ont été reprises une à une (`daemon.ts:145-154`,
`192-225`) : `window` (la couverture est passée, donc `coverageEnd` rend `null`
— `calendar.ts:60-67` exige `start <= now < end` — et `deadline()` retombe sur
`now`, d'où `idle`) ; `fatal` (`this.fatal` neutralise `calendarEnd` ligne 124
et `nextCalendarStart` ligne 163 : `idle` sans minuterie) ; `stopped`
(`stopWindow` a posé `pausedUntil` ligne 317) ; `nothing-eligible`
(`pauseUntil`, ligne 211) ; exception (`pauseUntil`, ligne 216). Le `continue`
de la ligne 150 ne peut donc pas reboucler immédiatement sur un `execute` qui
sort aussitôt. Les deux trous de ce raisonnement — `pauseUntil` qui ne fait
rien quand `cfg.windows` est vide (ligne 231) et la plage manuelle jetée par le
`finally` ligne 223 — sont des pertes de plage, pas des boucles, et sont déjà
déposés (018 §1, 074).

**4. Rien ne s'accumule sans borne qui ne soit déjà déposé.** Inventaire
complet des accumulateurs du régime permanent, un par un :
`data/logs/<tâche>/*.json` et `index.jsonl` (aucune rotation, aucun relecteur,
aucune purge par `reset` : 047 §2, 011) ; `rawStdout` qui recopie
intégralement la sortie exactement dans le cas du timeout, plus `stderr`
stocké sans condition ni troncature (015 §3) ; la mémoire de `docker()`, qui
tient toute la session en tampon sans contre-pression et meurt au-delà de la
taille maximale d'une chaîne V8 (015 §1 et §2) ; les couches d'image entre deux
aplatissements et le coût de l'aplatissement lui-même (036, 005, 041) ; les
containers orphelins laissés par un `kill` parti trop tôt ou par la mort du
démon (001, 027) ; l'absence de toute limite de ressources sur `docker run`
(019). Les seuls objets réellement bornés par construction : `state.json`
(écriture atomique d'un état de taille fixe par tâche, `state.ts:78-83`), le
tag `:prev` (un par tâche, `docker.ts:168-169`), le container temporaire
d'aplatissement (supprimé dans un `finally`, `docker.ts:224`) et le `.tmp` de
`saveState`. Rien de neuf à ajouter à cette liste.

**5. Le coût par cycle d'échec a été chiffré, il n'y a pas d'amplification
cachée.** Une itération en échec vaut : un `loadTasks()` (une lecture de
`task.json` et un `stat` par nœud, `task.ts:121-161`), deux `docker image
inspect` (`resolveTaskImage`), un `docker run`, un `docker rm -f`
(`iterate.ts:185`), un `writeFile` de journal, un `appendFile` d'index, un
`writeFile` + `rename` d'état. Aucun de ces appels n'est répété ni mis en file
d'attente, et aucun n'est lancé en parallèle : la boucle est strictement
séquentielle (`await` à chaque tour). La seule répétition par itération que
j'aie trouvée est l'impression d'une ligne `tâche X ignorée` par tâche invalide
avant *chaque* itération (`daemon.ts:278`) — bruit de journal systemd, sans
conséquence sur l'état ni sur le disque de `data/`, et borné par le nombre de
tâches cassées.

**6. Les bornes du schéma de config ont été revues sous l'angle de la charge,
sans trouver de nouveau réglage dangereux.** `backoffMinutes` (`int` positif),
`maxConsecutiveFailures` (`int` positif), `flattenAfterLayers` (`int` positif)
rejettent zéro, les négatifs et `Infinity` ; `retrySeconds` et `timeoutMinutes`
sont les deux seuls numériques sans `.int()`, ce que 013 a déjà traité (timeout
non borné par le haut, `setTimeout` au-delà de 2^31). Aucun des quatre réglages
n'a de plafond, mais une valeur haute allonge les attentes au lieu de les
raccourcir : le sens du risque est celui que 013 décrit, pas une charge.

**7. Deux absences de plafond vues au passage et volontairement non déposées,
faute de défaut démontrable.** `readJson` (`api.ts:27-30`) accumule le corps
d'une requête sans limite de taille, mais la seule surface est un socket Unix
en `0o660` dont la CLI locale est le seul client (`api.ts:154`) : je n'ai pas
de scénario d'échec qui ne soit pas « l'opérateur se tire dessus ». Et
`POST /docker/build` n'a aucun garde-fou de concurrence, mais deux `docker
build` simultanés sur le même tag sont sérialisés par le démon Docker ; le
défaut réel de ce chemin (rebuild pendant une plage) est déjà déposé par 051.
