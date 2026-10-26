# 080 — Survie au crash : l'orphelin vivant, sans timeout, qui partage /exchange

**Fichiers examinés** : `src/docker.ts:28-60` (`docker`), `:126-154`
(`runInTask`, `discardContainer`), `:161-185` (`commitTask`, `pruneTask`),
`:213-226` (`flattenTask`) ; `src/iterate.ts:14-31` (`IterateDeps`,
`defaultDeps`), `:99-147` (garde token, effacement de DONE, timer et
`onAbort` posés dans `onStart`), `:148-190` (classification, `commitTask`,
`discardContainer`, `saveState`), `:232-236` (`finishFatal`) ;
`deploy/unused.service:1-26` (intégralité) ; `deploy/install.sh:36-75` ;
`src/daemon.ts:96-113` (`init`), `:137-226` (`run`, `execute`) ;
`src/scheduler.ts:56-156` (`runWindow`) ; `src/graph.ts:107-153`
(`isEligible`, `pickNext`, `applyDecision`) ; `src/state.ts:55-84`
(`loadState`, `saveState`) ; `src/log.ts:37-68` ; `src/cli.ts:35-64`
(signaux du démon) ; `src/dockerCheck.ts:36-112` ; `src/scaffold.ts:1-80`
(ce que les skills livrés écrivent dans `/exchange`) ; `README.md:16-22,100-128`.
Ni `node` ni `docker` dans ce conteneur : aucun scénario n'a pu être exécuté,
tout ce qui suit est établi par lecture.

**Verdict** : rien trouvé — aucun constat *nouveau*. La chaîne complète de
l'aspect (mort brutale → container `unused.task` encore vivant → plus de
timer → `/exchange` partagé → DONE croisé) est déjà rapportée, maillon par
maillon, par 001, 005, 015, 019, 027, 055, 072 et 076. Les quatre angles
restants que j'ai suivis en propre — permission d'`unlink` du DONE écrit par
root, collision de nom de container après un retour d'horloge,
cycle de vie du timer et de l'écouteur `abort`, atomicité de `state.json` —
tiennent. Détail ci-dessous pour que la session suivante ne refasse pas le
chemin.

## La chaîne de l'aspect, et où chaque maillon est déjà rapporté

Re-tracée intégralement sur la branche `audit`, dans l'ordre d'exécution :

1. **Le container n'est ni éphémère ni détaché.** `runInTask`
   (`docker.ts:134-146`) construit `docker run --name unused-<tâche>-<ms>
   --label unused.task=<tâche> -v <exchangeDir>:/exchange …` : pas de `--rm`,
   pas de `--stop-timeout`, pas de `-d`. Le seul code qui le supprime est
   `commitTask` (`docker.ts:175`) ou `discardContainer` (`docker.ts:152-154`),
   tous deux *après* le retour de `docker run`, donc à l'intérieur du démon.
   → déjà dit en tête de **027**.
2. **La mort brutale laisse le container debout.** Le container tourne sous
   `dockerd`, hors du cgroup de `unused.service` ; `KillMode=mixed` +
   `TimeoutStopSec=60` (`unused.service:22-23`) n'atteignent que le démon et
   le client `docker run`. Un SIGKILL du client n'est pas proxié au container.
   → **055** (constat 1 : la phase post-session n'est pas interruptible et
   c'est précisément là que systemd envoie SIGKILL), **001** (constat 1 : kill
   parti avant la création du container), **027** (constat 5 :
   `killContainer` jette une promesse non capturée et tue le démon).
3. **Plus aucun timeout.** Le seul garde-fou est
   `setTimeout(…, cfg.claude.timeoutMinutes * 60_000)` posé dans `onStart`
   (`iterate.ts:128-132`) : un timer *en mémoire du démon*. Le démon mort, il
   n'existe plus rien côté hôte ni côté Docker pour borner la session, et
   `claude -p` garde le token (`iterate.ts:125`). → le point est posé par
   **019** (`:236`, `:263`) et **076** (`:93`), qui renvoient à 001/027.
4. **Rien ne balaye au démarrage.** `Daemon.init` (`daemon.ts:96-113`) ne
   relit que `state.json` ; aucun `docker ps -a --filter label=unused.task`
   nulle part (le seul `container prune` du dépôt est celui de la tâche de
   diagnostic, `dockerCheck.ts:108`, filtré sur `docker-check-internal`).
   → **027** (constat 2), **001** (constat 2), **015** (`:136`).
5. **La plage repart sur la même tâche.** `state.window` est conservée quand
   `signal.aborted` (`scheduler.ts:141-143`) et n'est de toute façon jamais
   effacée par un SIGKILL ; `init()` la reprend (`daemon.ts:98-108`) ;
   `Restart=always` / `RestartSec=5` (`unused.service:18-19`) relance 5 s plus
   tard ; `state.currentTask` persisté rend la tâche collante
   (`graph.ts:122-125`). → **004** (constats 1 et 2), **021**.
6. **Le DONE croisé.** La nouvelle itération efface `DONE`
   (`iterate.ts:110`), tourne, puis teste sa présence (`iterate.ts:151`) sans
   regarder *qui* l'a écrit ni *quand* — `exists` est un simple `stat`
   (`iterate.ts:50-57`). Le DONE déposé entre-temps par l'orphelin est pris
   pour celui de la session journalisée : `classify(session, true)` →
   `task-done`. → **027** (constat 2) et **001** (constat 2), tous deux avec
   le même scénario et la même conclusion ; **014** (constat 2) pour « le
   lecteur accepte n'importe quel inode ».
7. **Le disque, à froid.** La couche inscriptible de l'orphelin et son image
   parente ne sont jamais libérées : `pruneTask` ne vise que les *images* sans
   tag (`docker.ts:183-185`) et échoue tant qu'un container les référence.
   → **027** (constat 2, dernier paragraphe), **036**.

Je n'ai trouvé aucun maillon manquant à cette chaîne, et aucune variante qui
produirait un résultat faux par un autre chemin que celui de 027.

## Ce qui a été vérifié et tient

Quatre questions que la lecture de l'aspect pose naturellement et qu'aucun
rapport antérieur ne tranche. Toutes se résolvent en « pas de défaut » :

- **Le démon peut-il effacer un `DONE` écrit par root dans le container ?**
  Oui. Le container tourne en root sans `userns-remap` (`docker.ts:134-146`
  ne passe ni `--user` ni `--userns`), donc `/exchange/DONE` appartient à root
  sur l'hôte, alors que `rm(donePath, { force: true })` (`iterate.ts:110`,
  `:186`) est exécuté par l'utilisateur `unused`. Un `unlink` ne dépend pas du
  propriétaire du fichier mais du droit d'écriture sur le répertoire, et
  `exchangeDir` est créé par le démon lui-même (`docker.ts:133`) donc lui
  appartient ; aucun sticky bit n'est posé — ni par ce `mkdir`, ni par
  `install.sh:39-44` qui fait `chmod 770 data tasks` (non récursif) et
  `chown -R unused:docker`. L'effacement du DONE de l'orphelin fonctionne
  donc, et ne peut pas échouer en silence sur les permissions.
- **Une collision de nom de container est-elle atteignable après un retour
  d'horloge ?** Le nom est `unused-<tâche>-${Date.now()}`
  (`docker.ts:132`). Sur un Pi sans RTC, l'horloge *recule* au redémarrage
  avant la resynchronisation NTP (angle 029), donc l'intervalle de noms déjà
  consommé par l'orphelin peut être réutilisé — mais il faut tomber sur la
  **même milliseconde** que lui, et le scheduler est strictement séquentiel
  (`scheduler.ts:83-98`) : une seule itération par démon. Non démontrable, je
  ne le compte pas comme constat. À noter pour qui y reviendrait : si la
  collision arrivait, `docker run` sortirait en code 125 (« name is already in
  use »), l'issue ne serait pas `completed`, et `discardContainer(container)`
  (`iterate.ts:185`) ferait un `docker rm -f` **sur le nom** — donc
  supprimerait l'orphelin au lieu d'un container à soi. L'effet serait un
  nettoyage fortuit, pas une perte.
- **Le timer et l'écouteur `abort` fuient-ils ?** Non. `timer` et `onAbort`
  sont assignés synchronement dans `onStart`, appelé depuis
  `docker.ts:147` avant le `spawn` ; le `.finally` attaché à
  `deps.runInTask(…)` (`iterate.ts:140-143`) voit donc toujours leurs valeurs
  et fait `clearTimeout` + `removeEventListener`. Si `runInTask` lève *avant*
  `onStart` (échec de `spawn`, `mkdir` refusé), les deux valent `undefined` et
  le `.finally` s'en accommode. Aucun timer survivant à une fin normale, aucun
  écouteur accumulé d'une itération à l'autre.
- **`state.json` survit-il à la coupure ?** `saveState` écrit `.tmp` puis
  `rename` (`state.ts:77-84`) : le fichier n'est jamais vu à moitié écrit. Le
  `fsync` manquant et le `loadState` qui lève sur JSON invalide
  (`state.ts:68-74`) relèvent de 017 et 079, pas de cet aspect.

Deux autres pistes creusées sans résultat : `data/logs/index.jsonl` n'est relu
par personne dans `src/` (un `grep index.jsonl logsDir` hors `log.ts` ne rend
rien), donc une ligne tronquée par un SIGKILL pendant l'`appendFile`
(`log.ts:66`) ne casse aucun lecteur ; et les skills livrés par `scaffold.ts`
n'écrivent dans `/exchange` que `DONE` (`scaffold.ts:34-41,63`), donc le
partage de `/exchange` avec l'orphelin n'expose pas d'autre fichier d'état que
celui déjà couvert par 014 et 027.
