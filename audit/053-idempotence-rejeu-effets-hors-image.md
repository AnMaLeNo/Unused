# 053 — Idempotence du rejeu : tout ce qui sort du container n'est pas rembobiné, et le skill rejoué n'a aucun moyen de l'apprendre

**Fichiers examinés** : `src/iterate.ts` (entier, en particulier le docstring
`:66-71`, le `rm` de `DONE` `:110`, le montage et l'`env` passés à `runInTask`
`:121-139`, le choix de l'issue `:155-159`, la branche de rejet `:184-187`, le
journal `:191-217`), `src/graph.ts:5-32` (l'invariant annoncé),
`src/graph.ts:64-105` (`applyOutcome`), `src/graph.ts:139-153`
(`applyDecision`, la tâche collante), `src/docker.ts:107-154` (`RunOptions`,
`runInTask`, `discardContainer`), `src/claude.ts:15-18` (`buildPrompt`),
`src/log.ts:37-68` (où vont les journaux), `src/scaffold.ts:16-103` (les trois
textes livrés : README de tâche, skill `setup`, skill `work`),
`src/scheduler.ts:83-140` (cadence des rejeux), `src/daemon.ts:397-406`
(`resetTask`), `src/task.ts:8-27,:76,:143`, `src/state.ts:9-20,:42-59`,
`docker/Dockerfile`, `unused.config.json`, `README.md:11-24,:47-81`,
`src/iterate.test.ts` (entier).

**Verdict** : 2 constats (2 sûrs)

Angle de ce rapport : l'idempotence du rejeu pour les effets qui ne sont **ni
dans le container ni dans `/exchange`**. Les deux autres moitiés du sujet sont
déjà traitées et ne sont pas reprises ici : l'image qui avance pendant que le
curseur recule (`commitTask` non atomique, rapport 005, constat 1, avec sa note
sur `ts.last`/`consecutiveFailures` non restaurés), et `/exchange` que le
rollback ne rembobine pas au-delà de `DONE` (rapport 014, constat 1). Le rejeu
de `setup` provoqué par un renommage de nœud est dans le rapport 044, constat 1.

## 1. Le contrat « réputée n'avoir jamais eu lieu » est annoncé sans restriction, alors que le rejet ne défait ni un `git push` ni aucun effet réseau ; le rejeu le rejoue

**Gravité** : sûr
**Où** : `src/graph.ts:9-13` et `src/iterate.ts:66-71` (le contrat), `src/iterate.ts:184-187` (ce que le rejet défait réellement), `README.md:18-19` et `README.md:76-81`, `src/scaffold.ts:34-41`, `src/scaffold.ts:56-58` et `src/scaffold.ts:80-81` (ce que le projet demande au skill de faire)

Le contrat est écrit quatre fois, toujours sans réserve :

```ts
// graph.ts:9-13
 * Règle : une itération qui ne se termine pas en `completed` est réputée
 * n'avoir jamais eu lieu. Le container n'est pas commité, et un DONE laissé
 * dans /exchange est retiré, pour que le rejeu reparte de l'état exact
 * d'avant l'itération. C'est l'exécuteur (étape 3) qui applique ça.
```

```ts
// iterate.ts:69-71
 * dans son container. Réussie (`completed`), elle est commitée et le curseur
 * avance ; sinon elle est réputée n'avoir jamais eu lieu : container jeté,
 * DONE retiré, même nœud.
```

```
README.md:18-19 — « Une itération qui échoue (erreur, quota, timeout) est
réputée n'avoir jamais eu lieu : container jeté, même nœud. »
README.md:81  — « Découper en deux nœuds […] rend chaque session petite et la
perte d'une itération indolore. »
scaffold.ts:36-37 — « Une session qui échoue est réputée n'avoir jamais eu
lieu : le container revient à l'état d'avant. »
```

Ce que le code défait tient en deux lignes :

```ts
// iterate.ts:184-187
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

Le système de fichiers du container, et `DONE`. Rien d'autre. Or le container
livré a un accès réseau complet et de quoi s'en servir : `runInTask`
(`docker.ts:134-146`) construit `docker run` sans `--network` ni `--dns`, donc
bridge par défaut ; l'image de base installe `ca-certificates curl git`
(`Dockerfile:7-10`) ; et `env` transmet les secrets de la tâche
(`iterate.ts:125`, `docker.ts:145`). Tout effet poussé par là — `git push`,
`gh pr create`, un POST d'API, un mail — est hors d'atteinte de
`discardContainer`, et le rejeu le refait.

Ce n'est pas un usage exotique : c'est celui que le projet décrit et outille.
Le skill `setup` livré clone un dépôt distant avec le token du démon :

```
scaffold.ts:56-58 — « Installe ce qui manque (apt, outils) et clone le dépôt
`repo` dans /work/repo. Pour un dépôt privé, un token est disponible dans la
variable d'environnement GH_TOKEN si la tâche le transmet. »
```

le skill `work` livré demande de commiter (`scaffold.ts:81`, « Commite dans le
dépôt si c'est pertinent »), l'exemple du README est une revue sur
`https://github.com/moi/monprojet` (`README.md:62`), et le seul autre endroit
où le travail survit est l'image de la tâche, dont le rapport 036 montre la
fragilité. Pousser est la conclusion naturelle, et aucune des quatre
formulations du contrat ne met en garde contre elle.

**Scénario concret, avec les valeurs livrées.** `unused.config.json` :
`timeoutMinutes: 180`, `backoffMinutes: 15`, `retrySeconds: 60`,
`maxConsecutiveFailures: 3`. Tâche d'audit de ce dépôt, nœud `analyze`,
branche `audit`, dépôt distant à `C0` (dernier rapport poussé) :

1. La session écrit le rapport, `git commit` → `C1` **dans le container**,
   `git push` → la référence distante `audit` passe à `C1`. C'est le seul
   effet qui ait quitté la machine.
2. La session continue (un dernier tour de synthèse) et la requête est refusée
   pour quota : `rate_limit_event` `status: "rejected"`. `classify`
   (`graph.ts:45-46`) rend `{ kind: "quota" }`, `applyOutcome` rend `"backoff"`
   (`graph.ts:92`) sans toucher au curseur, `applyDecision` garde la tâche
   collante (`graph.ts:147-151`).
   Ce déclencheur est le mode de terminaison *normal* du projet, pas une
   avarie : le but affiché est de tourner « jusqu'à taper la limite »
   (`README.md:6`). Un timeout à 180 min ou un `unused stop` au milieu
   (`iterate.ts:156`, issue `aborted`) donnent la même suite.
3. `iterate.ts:185` jette le container. `C1` n'existe plus localement ; l'image
   `:latest` est restée à `C0`.
4. Le quota revient, le scheduler attend `resetsAt + 30 s`
   (`scheduler.ts:109-116`) et relance **le même nœud** sur l'image à `C0`.
   Dans ce container, `refs/remotes/origin/audit` vaut aussi `C0` : rien n'y
   indique le push.
5. Le skill relit `tail -n 1 /work/ANALYZED.md` — l'instruction est inchangée,
   la ligne est dans l'image, déjà committée par l'itération `choose`
   précédente — récrit le rapport, commite `C1'` (même travail, autre
   empreinte) et pousse.
6. `git push` est refusé : `C1` n'est pas un ancêtre de `C1'`
   (*non-fast-forward*). La session n'a plus que de mauvaises sorties :
   - elle abandonne → `failure` → `retry` 60 s plus tard (`scheduler.ts:133`),
     et comme la cause est dans l'état du distant, les trois tentatives
     échouent : à `consecutiveFailures >= 3`, `applyOutcome`
     (`graph.ts:96-101`) met `status: "failed"` et la tâche **sort
     définitivement de la file** ;
   - elle rebase → le même patch est appliqué deux fois : conflit, ou contenu
     dupliqué dans les fichiers (une ligne de `JOURNAL.md` écrite deux fois,
     une case cochée deux fois, cf. `scaffold.ts:80`) ;
   - elle force → `push --force` écrase `C1`, c'est-à-dire **la seule copie
     survivante** du travail de la tentative rejetée.

Attendu, d'après les quatre textes cités : l'itération n'a pas eu lieu, le
rejeu repart « de l'état exact d'avant ». Obtenu : le container est à `N`, le
dépôt distant est à `N+1`, et le nœud ne peut plus réussir sans intervention
humaine. Le rapport 014 a montré la même asymétrie pour `/exchange` ; elle est
ici d'un cran plus grave, parce que le rejeu ne se contente pas de laisser une
trace, il se heurte à ce que la tentative précédente a publié.

Aucun test ne couvre cette direction, et aucun ne peut : `iterate.test.ts`
remplace `runInTask` par un double (`iterate.test.ts:27-44`) qui n'a par
construction aucun effet hors du dossier temporaire du test.

Ce que le projet pourrait faire, et ne fait nulle part : dire la restriction là
où le contrat est annoncé (« le rembobinage porte sur le container ; un effet
qui sort du container — push, API, mail — n'est pas défait et sera rejoué »),
et l'imposer aux textes livrés par `scaffoldTask`, qui sont la seule
documentation que lira l'agent. C'est un changement de prompt, pas de
mécanique : le rembobinage d'un effet distant n'est pas à la portée du runner.
Le constat 2 porte sur ce qui l'est.

## 2. Un skill rejoué ne peut pas savoir qu'il rejoue : rien de ce qui entre dans le container ne distingue la tentative 1 de la tentative 2

**Gravité** : sûr
**Où** : `src/claude.ts:15-18` (`buildPrompt`), `src/iterate.ts:121-139` (tout ce qui entre dans le container), `src/docker.ts:134-146` (la ligne `docker run`), `src/log.ts:37-47` (où va la seule trace), `src/state.ts:9-20` (ce que le runner sait et ne dit pas)

La parade évidente au constat 1 — et celle que le rapport 014 appelle pour
`/exchange` — est un skill qui vérifie avant d'agir : « est-ce que la tentative
précédente a déjà poussé ? ». Elle n'est pas implémentable, parce que le skill
ne reçoit aucun moyen de poser la question.

Inventaire exhaustif de ce qui franchit la frontière, en relisant la seule
construction de `docker run` (`docker.ts:134-146`) et son unique appelant
(`iterate.ts:121-139`) :

| ce qui entre | d'où ça vient | varie entre deux tentatives du même nœud ? |
|---|---|---|
| le prompt sur stdin | `buildPrompt(node, params)` → `` `/${skill} ${args}` `` (`claude.ts:15-18`) | **non** — fonction pure de `task.json`, identique à l'octet près |
| `argv` | `buildCommand(cfg, node)` (`claude.ts:25-38`) | **non** — `cfg.claude.sessionArgs` + `node.args` |
| les variables `-e` | `{ ...resolveEnv(task.def.env, env), [TOKEN_ENV]: token }` (`iterate.ts:103,125`) | **non** — déclarées dans `task.json` |
| `/work/.claude/skills` | montage hôte en lecture seule (`iterate.ts:127`) | **non** |
| `/exchange` | montage hôte en lecture-écriture (`docker.ts:141`) | seulement si une session précédente y a écrit — et `DONE` vient d'en être retiré (`iterate.ts:110`) |
| le système de fichiers | `resolveTaskImage` → `:latest` (`docker.ts:102-105`) | **non, par construction** : c'est exactement l'image d'avant la tentative rejetée |

Le runner, lui, sait tout : `ts.cursor`, `ts.iterations`, `ts.consecutiveFailures`,
`ts.last = { at, node, outcome }` (`state.ts:9-20`, écrit par `graph.ts:79`), et
il écrit un enregistrement complet par tentative — `outcome`, `decision`,
`committed`, `container`, `image` (`log.ts:7-35`). Mais ce journal part dans
`<dataDir>/logs/<tâche>/` (`log.ts:43-47`), et `dataDir` n'est monté dans aucun
container : `grep -rn "exchangeDir\|mounts" src/` ne donne que les deux
montages du tableau. Rien de cette connaissance n'est transmis.

Conséquence, exactement là où elle se paie : le rollback efface *précisément*
la trace que le skill livré est invité à tenir. Le skill `work`
(`scaffold.ts:80`) note ce qu'il a fait dans `/work/JOURNAL.md`, donc dans le
container, donc dans ce que `discardContainer` jette. Après un rejet, le
container est net de toute mention de la tentative, le prompt est identique, et
l'effet distant, lui, est là. La session suivante est structurellement aveugle :
elle ne *peut pas* être idempotente, faute d'un fait sur lequel se brancher.
La seule voie ouverte est de deviner depuis le monde extérieur (un
`git fetch && git log origin/audit` avant d'écrire), ce qu'aucun des textes
livrés ne demande puisque le contrat affirme qu'il n'y a rien à vérifier.

Vérification que ce n'est pas un détour qui existe ailleurs :

- l'hôte pourrait le dire par `/exchange`, mais aucun code n'y écrit quoi que
  ce soit : le seul usage de `exchangeDir` côté démon est un `mkdir`
  (`docker.ts:133`) et trois suppressions de `DONE` (`iterate.ts:110,181,186`,
  `daemon.ts:403`) ;
- le container ne peut pas se reconnaître lui-même : son nom
  `unused-<tâche>-<Date.now()>` (`docker.ts:132`) et son label
  (`docker.ts:138-139`) sont du côté du démon Docker, pas lisibles de
  l'intérieur sans le socket, qui n'est pas monté ;
- `ensureTaskState` et `applyOutcome` sont les seuls lecteurs/écrivains de
  `iterations` et `consecutiveFailures` (`grep` dans `src/`) : ces compteurs ne
  sortent que par `GET /status` (`daemon.ts:375-386`), côté hôte.

Le correctif est mécanique et tient dans la ligne `docker run` déjà construite :
ajouter au prompt ou à l'`env` un repère de tentative que le runner a sous la
main — numéro d'itération, `consecutiveFailures`, `ts.last.outcome`, ou un
identifiant de tentative stable par nœud. Un skill peut alors écrire
« si ce n'est pas ma première tentative sur ce nœud, vérifie l'état du distant
avant d'agir », ce qui transforme le constat 1 en problème traitable. En
l'état, le système demande au skill d'être rejouable (`README.md:5-6`,
`:76-81`) tout en lui cachant qu'il est rejoué.

## Ce qui a été vérifié et tient

- **`apt` et les installations sont bien rembobinés**, contrairement à ce que
  l'intitulé de cet angle laissait craindre : tout ce que `setup` installe vit
  dans le système de fichiers du container (`Dockerfile:1-3`), donc dans ce que
  `docker rm -f` (`docker.ts:152-154`) détruit. Un `setup` interrompu ne laisse
  aucun paquet à moitié installé derrière lui ; il perd simplement l'intégralité
  de son travail, ce qui est le comportement annoncé. Seul le téléchargement
  (bande passante, miroir) est refait, sans conséquence sur la correction.
- **Les trois chemins de rejet appellent bien `discardContainer` *et* le
  retrait de `DONE`** : `failure`, `quota` et `fatal` passent tous par le même
  `else` (`iterate.ts:184-187`), et le chemin `aborted` aussi (l'issue est
  forcée en `failure` ligne 156 avant le test ligne 168). Les deux sorties
  précoces `finishFatal` (`iterate.ts:101,105`) n'ont rien à jeter : elles sont
  en amont de `runInTask`, aucun container n'existe encore.
- **`DONE` ne peut pas être pris pour celui d'une session antérieure** :
  `iterate.ts:110` l'efface avant le lancement, et le rejet l'efface à nouveau
  (`:186`). Les cas pathologiques du fichier lui-même (répertoire, lien,
  propriétaire) sont traités par le rapport 014, constat 2.
- **Le `commitTask` d'un `completed` n'est pas contournable par un `DONE`
  tardif** : `exists(donePath)` est lu une seule fois (`iterate.ts:151`), après
  que `docker run` a rendu la main, donc après la fin du processus du container.
- **`git push` depuis deux itérations simultanées de la même tâche n'est pas un
  risque à ajouter** : une seule plage peut tourner à la fois
  (`daemon.ts:285`, `ConflictError`) et la boucle de `scheduler.ts:83-140`
  attend chaque itération.
- **Rien, nulle part, ne tente de rembobiner un effet hors container**, donc il
  n'y a pas de rattrapage partiel à auditer : `grep -rn "revert\|rollback\|undo"
  src/` ne renvoie rien, et le seul vestige de rembobinage existant est le tag
  `:prev`, écrit et jamais relu (déjà constaté, rapport 005).
- Non repris ici, déjà constaté : image avancée contre curseur reculé et champs
  d'état non restaurés (005, constat 1) ; `/exchange` hors du rollback (014,
  constat 1) ; `setup` rejoué par dérive du graphe (044, constat 1) ; coût d'une
  itération abandonnée perdu des comptabilités (037) ; `reset` qui laisse les
  journaux et les fichiers d'`exchange` (047, constat 2).
