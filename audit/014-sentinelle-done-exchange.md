# 014 — Cycle de vie du sentinelle DONE dans /exchange

**Fichiers examinés** : `src/iterate.ts:50-57,88,108-110,148-190` (`exists`, l'effacement
d'avant-session, la lecture, les deux branches de rejet), `src/graph.ts:5-53,64-105`
(l'invariant annoncé, `classify`, `applyOutcome`), `src/docker.ts:107-153`
(`runInTask`, le montage `-v`, `discardContainer`), `src/docker.ts:161-180`
(`commitTask`), `src/daemon.ts:397-406` (`resetTask`), `src/daemon.ts:190-222`
(ce qui rattrape une exception de `iterate`), `src/scaffold.ts:30-41,88-97`
(ce que le README promet aux skills), `src/dockerCheck.ts:49-112` (l'auto-test),
`src/state.ts:61-84`, `src/api.ts:87-95,143-155`, `src/cli.ts:1-181`,
`docker/Dockerfile`, `deploy/unused.service`, `src/iterate.test.ts:85-205`,
`src/graph.test.ts:32-95`.

**Verdict** : 2 constats (1 probable, 1 à vérifier)

## Le rollback « l'itération n'a jamais eu lieu » ne couvre pas /exchange : DONE est le seul fichier rembobiné

**Gravité** : probable
**Où** : `src/iterate.ts:184-187` et `src/iterate.ts:176-182`, contre l'invariant de `src/graph.ts:9-13`

`graph.ts` annonce une garantie sans réserve :

```ts
 * Règle : une itération qui ne se termine pas en `completed` est réputée
 * n'avoir jamais eu lieu. Le container n'est pas commité, et un DONE laissé
 * dans /exchange est retiré, pour que le rejeu reparte de l'état exact
 * d'avant l'itération. C'est l'exécuteur (étape 3) qui applique ça.
```

L'exécuteur applique exactement deux gestes :

```ts
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

Or `/exchange` n'est pas dans le container : c'est un bind mount
(`docker.ts:140-141`, `` `${opts.exchangeDir}:/exchange` ``, sans `:ro`
contrairement au montage des skills à `iterate.ts:127`). `docker commit` ne
capture jamais le contenu d'un montage — c'est précisément pourquoi `donePath`
a besoin d'une ligne à lui : l'auteur sait que ce répertoire survit au rejet du
container. Mais le traitement s'arrête à ce seul nom de fichier. Tout le reste de
ce qu'une session a fait dans `/exchange` est définitif, y compris quand
l'itération est déclarée n'avoir jamais eu lieu. `grep -rn "exchangeDir" src/`
confirme qu'aucun autre chemin ne rembobine quoi que ce soit : `iterate` n'y
touche que via `donePath`, `docker.ts:133` y fait un `mkdir`, `daemon.ts:403`
y retire DONE, et le seul `rm` récursif du projet
(`dockerCheck.ts:51,109`) porte sur le répertoire jetable de l'auto-test.

Ce n'est pas une inquiétude théorique sur un répertoire inutilisé : le README
que `scaffoldTask` écrit dans chaque tâche invite explicitement les skills à
s'en servir comme sortie (`scaffold.ts:38-41`) —

```
Le container est conservé d'une itération à l'autre (commit Docker) ; tout ce
que Claude y installe ou y écrit reste. `/exchange/` est ce dossier-ci,
monté dans le container : DONE, rapports, ce que tu veux lire depuis l'hôte.
```

— trois lignes après avoir promis au skill que « Une session qui échoue est
réputée n'avoir jamais eu lieu » (`scaffold.ts:36-37`).

**Scénario concret 1 — écriture doublée.** Un nœud `report` dont le skill
(i) ajoute une ligne à `/exchange/JOURNAL.md`, (ii) puis écrit le rapport dans
le dépôt du container. La session fait (i), et meurt en (ii) : dépassement de
`timeoutMinutes` (`iterate.ts:129-132`), erreur API, ou simple `SIGTERM` du
service. Issue `failure` → container jeté, DONE retiré, curseur inchangé,
`retry` sur le même nœud. Le rejeu repart d'un container où la ligne n'existe
pas, mais d'un `/exchange/JOURNAL.md` où elle existe : la ligne est écrite deux
fois. Attendu d'après `graph.ts:11-13` : « le rejeu reparte de l'état exact
d'avant l'itération ». Obtenu : container à N, `/exchange` à N+1. Aucun test ne
couvre ce cas — `dockerCheck.ts:82-90` (« Itération jetée : pas de commit,
l'état ne bouge pas ») ne vérifie que `/work/marker`, à l'intérieur du
container, et n'écrit jamais dans `/exchange`.

**Scénario concret 2 — perte de données, celui-là irréversible.** Le montage est
en écriture et sans `:ro` : une session peut écraser ou supprimer les fichiers
que l'hôte a déposés dans `/exchange`. Un skill qui régénère
`/exchange/rapport.md` en place, puis échoue, laisse la version tronquée sur
l'hôte pendant que le container qui contenait de quoi la reconstruire est
supprimé par `discardContainer`. La version précédente n'existe plus nulle part :
il n'y a ni copie, ni `:prev`, ni journal du contenu (`log.ts` n'enregistre que
la sortie de la session). C'est le seul état de ce runner qui n'a aucun mécanisme
de retour arrière — l'image a `:prev` (`docker.ts:168-169`), `state.json` est
écrit par `rename` atomique (`state.ts:78-83`), `/exchange` n'a rien.

Le défaut n'est pas la persistance de `/exchange` en soi, qui est l'intérêt du
répertoire : c'est que la garantie « au plus une fois » sur laquelle repose tout
le graphe est affirmée sans restriction dans `graph.ts`, appliquée à un seul
fichier dans `iterate.ts`, et jamais démentie auprès des skills qui écrivent là.
Un correctif possible sans toucher au montage : dire l'exception à l'endroit où
la règle est énoncée (commentaire de `graph.ts` et README de `scaffoldTask`),
pour qu'un skill sache qu'une écriture dans `/exchange` doit être idempotente,
là où une écriture dans le container n'a pas à l'être.

## Le lecteur de DONE accepte n'importe quel inode, ses quatre effaceurs non

**Gravité** : à vérifier
**Où** : `src/iterate.ts:50-57` face à `src/iterate.ts:110,181,186` et `src/daemon.ts:403`

La présence de DONE est lue par un `exists` maison :

```ts
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
```

et effacée par quatre appels identiques, tous sans `recursive` :

```ts
await rm(donePath, { force: true });
```

Deux asymétries en découlent, dans les deux sens.

**Sens 1 — un DONE que le lecteur accepte et que l'effaceur ne peut pas retirer.**
`stat` réussit sur un répertoire : `/exchange/DONE` créé comme répertoire (un
skill utilisateur qui fait `mkdir` au lieu de `touch`, un `cp -r` mal ciblé)
vaut « tâche terminée » pour `classify` (`graph.ts:48`) exactement comme un
fichier vide. Côté effacement, `force` ne couvre que l'absence du chemin — la
documentation de `node:fs` le restreint à « exceptions will be ignored if path
does not exist » — et `fs.rm` sans `recursive` rejette un répertoire
(`ERR_FS_EISDIR`). Le projet en a d'ailleurs la preuve interne : le seul `rm`
de répertoire du code, `dockerCheck.ts:51`, passe `{ recursive: true, force: true }`,
les quatre `rm` de DONE seulement `{ force: true }`. **Je n'ai pas pu exécuter
ce cas** : ce container n'a ni `node` ni `python3`, le constat repose donc sur la
sémantique documentée de `force` et sur cette différence de traitement dans le
code, pas sur une exécution — d'où la gravité « à vérifier ».

Si le rejet a bien lieu, les conséquences sont, elles, entièrement lisibles dans
le code appelant :

- `daemon.resetTask` (`daemon.ts:397-406`) place le `rm` **entre** la sauvegarde
  de l'état et la suppression des images :

  ```ts
  delete this.state.tasks[name];
  if (this.state.currentTask === name) this.state.currentTask = null;
  await saveState(this.cfg.dataDir, this.state);
  await rm(path.join(task.exchangeDir, DONE_FILE), { force: true });
  await this.deps.removeTaskImages(name);
  ```

  Une exception ici remonte en HTTP 500 (`api.ts:119-122`) après que l'état a
  déjà été effacé **et écrit sur disque**, et avant que `removeTaskImages` ait
  tourné. Résultat : curseur revenu à `start`, `iterations` à 0, mais
  `unused-task-<t>:latest` intacte avec tout le travail accumulé — la prochaine
  itération rejoue le premier nœud sur un container déjà entièrement construit.
  Et l'opération n'est pas réparable en la relançant : `unused tasks reset`
  échouera au même endroit tant que le DONE n'est pas retiré à la main.
  Le message rendu à l'utilisateur est un échec, alors que la moitié
  destructrice a bien eu lieu.
- dans `iterate`, le `rm` de la branche d'échec (ligne 186) est franchi **après**
  `discardContainer` (185) et **avant** `saveState` (189) et
  `writeIterationLog` (217). L'exception traverse `runWindow` (aucun `try` autour
  de `runIteration`, `scheduler.ts:98`) et n'est rattrapée qu'à
  `daemon.ts:213-217`, qui imprime « plage interrompue par une erreur », met
  `state.window` à `null` et met les plages automatiques en pause. Bilan d'une
  itération qui a pourtant tourné et consommé du quota : container supprimé,
  aucun journal écrit, `state.json` toujours dans son état d'avant (donc
  `consecutiveFailures` non incrémenté, échec non compté), plage abandonnée au
  lieu d'être reprise. `unused status` n'en gardera aucune trace.

**Sens 2 — un DONE présent que le lecteur déclare absent.** Le `catch` de
`exists` avale *toutes* les erreurs de `stat`, pas seulement `ENOENT` ;
`loadState` (`state.ts:66-68`) montre que le projet sait faire la distinction
quand elle compte. Un `stat` qui échoue autrement — `EACCES` sur le répertoire,
`EIO`, `ESTALE` — rend `done === false`, ce qui est la direction dangereuse : le
seul mécanisme de terminaison du runner est ce fichier (`task.ts:14-15`, « La
seule condition de sortie est le fichier DONE »). Une tâche qui a réellement
fini est donc relancée indéfiniment sur le même nœud, et le journal enregistre
`done: false` (`iterate.ts:212`) — il affirme que le fichier n'était pas là,
alors que le code ne le sait pas.

La combinaison qui rend ce sens atteignable est propre à ce déploiement, et elle
est certaine des deux côtés : le container tourne en **root**
(`docker/Dockerfile:1-3`, aucun `USER`), le démon tourne en
**`User=unused`** (`deploy/unused.service:13`), et les deux voient le même inode
à travers le bind mount. Une session qui fait un `chmod`/`chown` sur `/exchange`
(un skill qui « range » ses sorties, un `chown -R` un peu large) modifie les
permissions du répertoire **de l'hôte** et peut retirer au démon le droit d'y
faire `stat` et `unlink` — ce qui déclenche les deux sens à la fois. Je n'ai pas
pu le reproduire ici (pas de Docker dans ce container), et aucun test ne
l'explore.

À noter que ce chemin-là n'est vérifié nulle part, alors qu'un auto-test existe
pour ça : `unused docker check` fait bien lire `/exchange/ping` par le container
(`dockerCheck.ts:63-67`), mais ne fait **jamais écrire le container dans
`/exchange`**, et ne fait donc jamais effacer par le démon un fichier créé par
root dans le montage. Le geste exact sur lequel repose tout le protocole DONE —
container (root) crée, démon (`unused`) lit puis supprime — n'est exercé par
aucun test ni par l'auto-test.

## Ce qui a été vérifié et tient

- **Pas de faux positif possible sur la lecture de DONE.** L'unique lecture
  (`iterate.ts:151`) est toujours précédée de l'effacement d'avant-session
  (`iterate.ts:110`), et les deux sorties anticipées qui contournent cet
  effacement — `dryRun` (95-97) et les deux `finishFatal("auth")` (100-106) —
  retournent avant la lecture. `rm` avec `force` n'avale que `ENOENT`, il ne peut
  donc pas échouer silencieusement en laissant un DONE périmé derrière lui.
  (Cet effacement d'avant-session n'a en revanche aucun test : aucun cas de
  `iterate.test.ts` ne plante un DONE avant l'appel pour vérifier qu'il n'est pas
  porté au crédit de la session suivante.)
- **Pas de concurrence sur le fichier.** Un seul démon peut tourner (`listen`
  refuse le socket si un autre répond, `api.ts:144-146`), `runWindow` est
  séquentiel, la CLI n'a aucun chemin qui appelle `iterate` en direct (tout passe
  par le socket, `cli.ts:66-181`), et `resetTask` rejette en `ConflictError` si
  la tâche visée est justement en cours d'itération (`daemon.ts:399`). Les cinq
  accès à DONE sont donc bien sérialisés.
- **Ordre correct entre la mort de l'écrivain et l'effacement.** Dans les deux
  branches de rejet, `discardContainer` (`docker rm -f`) est attendu avant le
  `rm` du DONE (185→186 et 180→181) : aucun processus du container ne peut
  recréer le fichier après son effacement.
- **Le rejet d'un DONE sur une issue non-`completed` est cohérent et couvert** :
  `classify` n'honore `done` que sur `terminal_reason === "completed"`
  (`graph.ts:48`, testé `graph.test.ts:65-81`), et `iterate` efface bien le
  fichier sur `failure`, `quota`, `timeout` et `aborted` (testé
  `iterate.test.ts:105-116`). Le fait qu'un `rejected` de quota tardif l'emporte
  sur un `completed+DONE` est un choix documenté, déjà instruit en 003.
- **Le journal ne cache pas un effacement** : `rec.done` (`iterate.ts:212`)
  enregistre la présence brute du fichier indépendamment de l'issue, et la ligne
  imprimée (`iterate.ts:221`) affiche `… + DONE` même quand la décision est
  `retry` ou `backoff`. Un opérateur peut donc voir qu'une session avait fini et
  que son DONE a été jeté.
- **Après un `task-done`, le DONE reste sur l'hôte et c'est sans conséquence** :
  `isEligible` (`graph.ts:108-110`) sort la tâche de la file sur
  `status === "done"`, l'état terminal vit dans `state.json` et pas dans le
  fichier. Créer ou supprimer `/exchange/DONE` à la main ne rouvre ni ne ferme
  donc une tâche ; `unused tasks reset` reste le seul chemin, et sa description
  CLI (`cli.ts:144`) annonce correctement qu'il ne retire que DONE et garde les
  autres fichiers d'exchange.
- **Pas de collision de répertoire `exchange` entre tâches** :
  `task.ts:143` dérive `exchangeDir` de `tasksDir/<nom>`, unique par tâche, et
  l'auto-test travaille dans `<dataDir>/<CHECK_TASK>-exchange`
  (`dockerCheck.ts:49`), hors de `tasksDir` — un `docker check` ne peut pas
  effacer le DONE d'une vraie tâche, même homonyme.
- Le rollback de `commitTask` (`iterate.ts:170-183`), qui efface aussi DONE, a
  déjà été instruit en 005, y compris ce qu'il ne restaure pas
  (`consecutiveFailures`, `ts.last`) ; rien à ajouter ici de ce côté.
