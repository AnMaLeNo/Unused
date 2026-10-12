# 054 — Protocole sortant du skill : un seul canal (`DONE` = succès), aucun pour « je n'ai pas pu », et un curseur qui avance sans rien vérifier

**Fichiers examinés** : `src/graph.ts:5-32` (contrat annoncé), `src/graph.ts:41-53`
(`classify`), `src/graph.ts:64-105` (`applyOutcome`), `src/graph.ts:107-110`
(`isEligible`), `src/iterate.ts:84-88,99-110,148-190,219-230`,
`src/scheduler.ts:83-139` (la boucle de plage et sa comptabilité),
`src/config.ts:33-42` (les seuls réglages de garde-fou),
`src/state.ts:9-20,42-59`, `src/task.ts:28-39` (`NodeSchema`),
`src/task.ts:50-66` (`superRefine`), `src/task.ts:89-106` (`resolveEnv`),
`src/task.ts:147-159` (contrôles de `loadTask`), `src/scaffold.ts:5-14,44-103`
(le squelette livré par `unused tasks new`), `src/cli.ts:115-123`
(`printTasks`), `src/daemon.ts:375-387` (`taskInfo`), `src/daemon.ts:397-407`
(`resetTask`), `src/graph.test.ts:70-135`, `src/iterate.test.ts:79-210`,
`README.md:12-24,70-82`.

**Verdict** : 3 constats (2 sûrs, 1 probable)

Les démonstrations de ce rapport sont faites par lecture du code, pas par
exécution : ce container n'a pas de runtime (`which node` → introuvable,
`node_modules/` et `dist/` absents), donc ni `vitest` ni `tsx`. Les trois
constats ne portent que sur des chemins statiques (une affectation, un
compteur remis à zéro, une boucle sans borne), vérifiables ligne à ligne.

Angle de ce rapport : le **protocole sortant** du skill, c'est-à-dire ce qu'une
session peut dire au runner. Il a exactement un canal, `/exchange/DONE`, et il
signifie « la tâche est finie avec succès ». Rien ne permet de dire « ce nœud
n'a pas pu faire son travail ». Distinct des rapports voisins : 020 examine si
le *cadre `result` de la CLI* dit la vérité sur la session (`is_error`,
`subtype`) ; ici le cadre est parfaitement honnête — la session s'est bien
terminée normalement — et c'est le *skill* qui n'a aucun moyen de dire qu'elle
n'a rien produit. 014 traite le cycle de vie du fichier `DONE` (inode,
effaceurs, rembobinage) ; ici c'est sa *sémantique unique* qui est en cause.
018 traite la sortie de file par le compteur d'échecs ; ici c'est son
inaccessibilité. 023 traite l'épinglage par une panne `fatal` ; ici la tâche
n'est jamais en panne, elle est déclarée en bonne santé.

## 1. Le seul garde-fou automatique est hors d'atteinte pour un nœud qui n'avance plus : boucle sans borne, comptée comme une suite de succès

**Gravité** : sûr
**Où** : `src/graph.ts:83-84` et `src/graph.ts:96-101`, avec `src/scheduler.ts:83-106`

`applyOutcome` n'a que deux leviers de sortie automatique de la file :
`task-done` (il faut `DONE`) et `task-failed` (il faut
`maxConsecutiveFailures` échecs **consécutifs**). Et toute session qui se
termine normalement remet ce compteur à zéro :

```ts
// src/graph.ts:82-90
case "completed": {
  ts.iterations += 1;
  ts.consecutiveFailures = 0;
  if (outcome.done) { ts.status = "done"; return "task-done"; }
  ts.cursor = task.def.nodes[node]!.next;
  return "next-task";
}
```

C'est volontaire et testé (`src/graph.test.ts:113-120`, « un completed remet le
compteur d'échecs à zéro »). La conséquence ne l'est pas : `completed` ne veut
dire que « la session `claude -p` s'est arrêtée proprement » — le runner, par
contrat annoncé, « ne lit jamais ce que Claude a produit » (`src/graph.ts:6-8`,
`README.md:20-22`). Une session qui constate qu'elle ne peut rien faire, le
dit en prose et rend la main se termine exactement comme une session
productive : `terminal_reason: "completed"` (`src/graph.ts:48`). Donc
`consecutiveFailures` ne quitte jamais `0`, `status` reste `"running"`, la
tâche reste éligible (`src/graph.ts:108-110`), et aucun autre compteur
n'existe : `ConfigFileSchema.scheduler` ne propose que `backoffMinutes`,
`retrySeconds`, `maxConsecutiveFailures` (`src/config.ts:33-42`) — ni plafond
d'itérations, ni plafond de coût, ni détection de stagnation. La boucle de
plage (`src/scheduler.ts:83-139`) n'en a pas davantage : elle ne s'arrête que
sur la fin de plage, `shouldStop`, `nothing-eligible` ou `fatal`.

**Scénario concret.** Tâche créée par `unused tasks new`, graphe livré tel
quel : `setup → work`, `work → work` (`src/scaffold.ts:5-14`). Le paramètre
`repo` comporte une faute de frappe. Itération 1, nœud `setup` : la session
tente le clone, échoue, écrit « je n'ai pas pu cloner owner/projet », et rend
la main — comme le skill le lui demande (« Ne crée pas /exchange/DONE : la
tâche ne fait que commencer », `src/scaffold.ts:63`). `classify` →
`{kind:"completed"}` ; `commitTask` scelle le container (`src/iterate.ts:170`) ;
`iterations = 1` ; `cursor = "work"`. Itérations 2 à N, nœud `work` : le skill
demande de lire `/work/PLAN.md` (`src/scaffold.ts:77`), qui n'existe pas ; la
session le signale et rend la main → `completed`, `iterations += 1`,
`consecutiveFailures = 0`, `cursor = "work"` (`next` du nœud, c'est lui-même).

Attendu : la tâche quitte la file, ou au moins quelque chose se plaint.
Obtenu : chaque itération est commitée, chaque plage en consomme sa part
(round-robin, `src/graph.ts:118-133`), indéfiniment, nuit après nuit. Et toutes
les surfaces que l'opérateur regarde affichent un succès :

- l'itération : `issue    completed → next-task (commit)` (`src/iterate.ts:221`) ;
- le résumé de plage : `summary.completed += 1` pour chaque `next-task`
  (`src/scheduler.ts:104-107`), donc `12 itérations, 12 completed, 0 échecs` ;
- `unused status` : `active    ma-tache  curseur work, 57 itérations, dernier
  work → completed` (`src/cli.ts:119-121`).

Le seul indice disponible est que `iterations` monte sans que `status` change —
ce qui est aussi, exactement, la signature d'une tâche infinie qui travaille
bien. Rien ne distingue les deux, et ce projet est fait pour laisser tourner
des tâches infinies sans surveillance (`README.md:13-15`).

Noter que le garde-fou existant protège contre le seul mode d'échec que le
skill ne contrôle pas (le crash : `failure` → container jeté, 3 fois → `failed`,
`src/graph.ts:96-101`, `src/iterate.test.ts:105-117`) et pas du tout contre
celui qu'il contrôle (ne pas réussir son unité de travail).

## 2. Le nœud `setup` s'exécute une fois, sans qu'on vérifie qu'il a réussi, et aucun chemin ne peut y ramener sans détruire la tâche

**Gravité** : sûr
**Où** : `src/graph.ts:89`, avec `src/task.ts:28-39` et `src/daemon.ts:397-407`

L'avancement du curseur est inconditionnel : une affectation, prise de `next`
sans aucun prédicat (`src/graph.ts:89`). Il ne peut pas en être autrement, car
la notion de précondition n'existe nulle part dans le modèle : `NodeSchema` ne
porte que `skill`, `params`, `args`, `next` (`src/task.ts:28-39`), et
`/exchange` n'est jamais lu que pour l'existence de `DONE` — `grep -rn
"exchangeDir\|DONE_FILE" src/` hors tests ne donne, côté lecture, que
`src/iterate.ts:88` et `src/iterate.ts:151` ; tous les autres accès sont des
`rm`. Un rapport que le skill déposerait dans `/exchange` pour dire « setup
incomplet » n'est lu par personne.

Or le squelette livré fait de `setup` un nœud à passage unique, explicitement
(« Prépare le container pour la tâche (une seule fois, au premier nœud) »,
`src/scaffold.ts:46`), et le graphe `setup → work`, `work → work` ne contient
aucun retour. La liste exhaustive des écritures du curseur le confirme : seuls
`src/graph.ts:89` (avance), `src/iterate.ts:177` (rollback sur commit
impossible, qui le *remet* sur le même nœud) et `src/state.ts:56` (réparation
vers `start` quand le nœud a disparu de `task.json` — rapport 044). Le seul
moyen de rejouer `setup` est `unused tasks reset`, qui supprime l'état **et**
appelle `removeTaskImages` (`src/daemon.ts:404-405`) : toute la lignée de
containers de la tâche part avec.

**Scénario concret**, celui que le squelette produit par défaut. `task.json`
livré avec `env: []` (`src/scaffold.ts:9`), tandis que le skill `setup` livré
annonce à la session : « Pour un dépôt privé, un token est disponible dans la
variable d'environnement GH_TOKEN si la tâche le transmet »
(`src/scaffold.ts:57-58`). L'utilisateur met un dépôt privé dans `params.repo`
et ne touche pas à `env`. `resolveEnv` ne contrôle que les variables
*déclarées* (`src/task.ts:95-104`) : une variable absente de la liste ne
produit aucun signalement, ni dans `loadTask` (`src/task.ts:156-159`, qui ne
voit rien à vérifier) ni dans `iterate` (`src/iterate.ts:103-106`, même
liste). La session `setup` démarre donc sans token, le clone privé échoue, la
session rend la main → `completed` → commit → `cursor = "work"`, définitivement.

Attendu : la tâche ne quitte pas `setup` tant que `/work/repo` n'existe pas, ou
signale la variable manquante. Obtenu : le curseur a quitté pour de bon le seul
nœud qui savait préparer le terrain, l'image commitée fait foi pour toutes les
itérations suivantes, et le prompt de chaque session `work` lui affirme
désormais quelque chose de faux — « le dépôt est dans /work/repo et le plan
dans /work/PLAN.md » (`src/scaffold.ts:74-75`). La réparation coûte la
destruction des images de la tâche.

## 3. Dans le squelette livré, la condition d'arrêt de `work` est satisfaite par un plan absent : un `setup` raté se solde par une tâche `done`

**Gravité** : probable
**Où** : `src/scaffold.ts:83-85`, avec `src/graph.ts:85-87`

Puisque `DONE` est le seul canal sortant, c'est aussi le seul moyen pour un
skill de ne plus être rejoué — et il signifie « succès » : `ts.status = "done"`,
`task-done`, sortie définitive de la file (`src/graph.ts:85-87`,
`src/state.ts:12`). Il n'existe aucune valeur de `status` qu'un skill puisse
atteindre pour dire « bloqué » : `failed` n'est écrit que par le compteur
d'échecs (`src/graph.ts:99`), inaccessible par le constat 1.

Le texte livré par `unused tasks new` formule la condition d'arrêt du nœud de
travail comme une absence :

```
// src/scaffold.ts:83-85
S'il ne reste aucune case à cocher, crée le fichier /exchange/DONE : la tâche
est terminée et ne sera plus relancée.
```

« Aucune case à cocher » est vrai de deux états que rien ne distingue : le plan
est entièrement coché (succès) et le plan n'existe pas ou est vide (le `setup`
du constat 2 n'a jamais écrit `/work/PLAN.md`). Une session `work` qui applique
l'instruction à la lettre, premier cas de figure après un `setup` raté, crée
donc `DONE`. Résultat : `done = true` (`src/iterate.ts:151`), `classify` →
`{kind:"completed", done:true}`, `status = "done"`, `unused status` affiche
`done      ma-tache  curseur setup, 1 itérations, dernier work → completed+DONE`
(`src/cli.ts:119-121`) — une tâche déclarée terminée avec succès, zéro ligne de
travail produite, et plus jamais relancée sans intervention humaine.

Gravité `probable` et non `sûr` parce que le déclencheur dépend de la lecture
que la session fait de l'instruction : rien ne garantit qu'elle préfère créer
`DONE` plutôt que signaler l'anomalie en prose (ce qui retombe alors sur le
constat 1, boucle indéfinie). Les deux issues sont silencieuses ; le chemin de
code, lui, est certain dès que `DONE` apparaît. Les deux branches du protocole
sont ainsi asymétriques au mauvais endroit : dire « j'ai fini » coûte un
`touch`, dire « je n'y arrive pas » est impossible.

## Ce qui a été vérifié et tient

- **Le graphe lui-même est cohérent au chargement** : `superRefine` exige que
  `start` et chaque `next` existent dans `nodes` (`src/task.ts:50-66`), et
  `loadTask` exige `skills/<skill>/SKILL.md` pour chaque nœud
  (`src/task.ts:147-155`). Le curseur avancé par `src/graph.ts:89` pointe donc
  toujours sur un nœud exécutable *du task.json courant* ; le seul cas de
  divergence est l'édition en cours de route, déjà traitée en 044.
- **Les sessions qui échouent vraiment sont bien traitées** : `failure`
  incrémente, jette le container, retire `DONE`, rejoue le même nœud, et sort
  la tâche de la file au N-ième (`src/graph.ts:96-101`,
  `src/iterate.ts:184-187`, `src/iterate.test.ts:105-117`). Le constat 1 porte
  uniquement sur les sessions qui *ne* tombent *pas* dans cette branche.
- **`DONE` n'est pas confondu d'une itération à l'autre** : il est retiré avant
  chaque session (`src/iterate.ts:108-110`) et dans toutes les branches de
  rejet. Les trous restants de son cycle de vie sont ceux du rapport 014 ; rien
  de neuf trouvé de ce côté.
- **Un arrêt demandé ne pollue pas l'avancement** : `aborted` court-circuite
  `applyOutcome`/`applyDecision` et n'écrit pas l'état
  (`src/iterate.ts:156,162-165,189`), donc il ne peut pas faire avancer un
  curseur ni remettre un compteur à zéro.
- **Le rollback du commit impossible remet bien `cursor`, `iterations` et
  `status`** (`src/iterate.ts:176-179`) ; les champs qu'il ne restaure pas
  (`ts.last`, `consecutiveFailures`) sont déjà relevés en 005 et rappelés en
  053 — non redoublé ici.
- **Aucun mécanisme de précondition n'existe à auditer.** Les seules
  vérifications d'état du dépôt sont celles de `src/dockerCheck.ts:24-27`
  (`expectOutput`), qui portent sur le filet de sécurité `unused doctor` et non
  sur les nœuds d'une tâche (rapport 052) ; `NodeSchema` est fermé
  (`.strict()`, `src/task.ts:28-39`), donc un `task.json` ne peut même pas
  déclarer de condition d'entrée. Il n'y a pas de garde-fou partiel ou mal
  branché à chercher — l'absence est complète, et c'est elle que les constats 1
  et 2 chiffrent.
