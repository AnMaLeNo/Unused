# 044 — Dérive du graphe : nœud renommé, curseur replacé sur `start` sans trace

**Fichiers examinés** : `src/state.ts:42-59` (`initialTaskState`, `ensureTaskState`),
`src/daemon.ts:375-387` (`taskInfo`), `src/daemon.ts:409-418` (`setActive`),
`src/daemon.ts:328-373` (`status`), `src/scheduler.ts:83-99`,
`src/iterate.ts:72-96,160-189,219-230`, `src/graph.ts:60-102` (`applyOutcome`),
`src/task.ts:28-66` (schéma et `superRefine`), `src/task.ts:188-201` (`describeGraph`),
`src/scaffold.ts:5-14,41-60`, `src/cli.ts:113-161`, `src/graph.test.ts:136-144`,
`src/state.test.ts`
**Verdict** : 3 constats (2 sûrs, 1 probable)

Angle distinct du rapport 032 : celui-ci partait d'un **dossier supprimé puis
recréé** sous le même nom. Ici le dossier ne bouge pas, la tâche tourne, et
l'utilisateur fait ce que le code l'invite explicitement à faire — éditer
`task.json` en cours de route (`src/scheduler.ts:53-54` : « modifier un
task.json ou un skill pendant la plage est pris en compte »). Le rapport 032
concluait dans « ce qui tient » que la réparation du curseur « fonctionne » et
que « la ligne affichée et le nœud exécuté ne divergent pas » : les deux points
sont faux dès qu'on regarde le moment où la réparation est décidée, et ce
qu'elle coûte.

## 1. Renommer un nœud rejoue `setup` au milieu de la tâche, et rien ne le dit

**Gravité** : sûr
**Où** : `src/state.ts:55-56`, `src/scheduler.ts:94-97`, `src/iterate.ts:80-93`

La réparation est muette et irréversible :

```ts
// src/state.ts:50-59
export function ensureTaskState(state: RunnerState, task: Task): TaskState {
  let ts = state.tasks[task.name];
  if (!ts) {
    ts = initialTaskState(task);
    state.tasks[task.name] = ts;
  } else if (!(ts.cursor in task.def.nodes)) {
    ts.cursor = task.def.start;   // ni log, ni ts.last, ni compteur
  }
  return ts;
}
```

Le curseur est un **nom de nœud**, et rien d'autre. Renommer un nœud, c'est
donc faire disparaître la position courante.

Scénario, sur le squelette que `unused tasks new` produit
(`src/scaffold.ts:5-14`, `start: "setup"`, `nodes: {setup → work, work → work}`) :

1. La tâche `revue` tourne depuis 30 itérations. État :
   `{cursor: "work", status: "running", iterations: 30}`. Le container
   `unused-task-revue:latest` contient `/work/repo` cloné, `/work/PLAN.md`,
   `/work/JOURNAL.md`.
2. L'utilisateur veut un nom plus parlant : il renomme le nœud `work` en
   `boucle` dans `task.json` et met `setup.next` à `"boucle"`. Le fichier reste
   valide — `superRefine` (`src/task.ts:50-66`) ne vérifie que `start in nodes`
   et l'existence des `next`, il ne connaît pas l'état.
3. Itération suivante. `pickNext` retient `revue`, puis
   `ensureTaskState(state, task).cursor` (`src/scheduler.ts:94`) constate que
   `"work"` n'est plus dans `nodes` et **rend `"setup"`**. `iterate` refait le
   même calcul (`src/iterate.ts:80-84`) et exécute le nœud `setup`.
4. `runInTask` part de `unused-task-revue:latest` : le skill `setup` tourne
   dans le container **déjà préparé**.

Or le skill `setup` du squelette est précisément celui qui ne doit tourner
qu'une fois (`src/scaffold.ts:46,54-56`) :

```
description: Prépare le container pour la tâche (une seule fois, au premier nœud).
...
1. Installe ce qui manque (apt, outils) et clone le dépôt `repo` dans /work/repo.
3. Établis le plan de travail : un fichier /work/PLAN.md, une liste à cocher …
```

Résultat obtenu : une session `setup` reclone par-dessus `/work/repo` (ou
échoue parce qu'il existe déjà) et réécrit `/work/PLAN.md` — c'est-à-dire
qu'elle efface le plan et le travail non poussé de 30 itérations. Si elle se
termine en `completed`, `commitTask` (`src/iterate.ts:170`) **fige** ce
container appauvri comme nouvel état de la tâche, et le curseur repart sur
`boucle`. Résultat attendu : renommer un nœud ne change pas la position de la
tâche dans son travail, ou alors le dit avant de la changer.

Le « sans trace » est littéral — vérifié sur tous les canaux de sortie :

- aucun `print` dans `ensureTaskState` (le module `state.ts` n'a aucune sortie),
  ni chez ses deux appelants d'exécution (`src/scheduler.ts:94`,
  `src/iterate.ts:80`) ;
- l'en-tête d'itération du démon ne mentionne pas le nœud
  (`src/scheduler.ts:96` : `itération N — <tâche>`) ; le nœud n'apparaît qu'en
  `nœud setup (skill /setup)` (`src/iterate.ts:91`), indistinguable d'un
  premier démarrage normal ;
- `ts.last` n'est pas touché par la réparation : jusqu'à la fin de l'itération
  rejouée, `unused tasks list` affiche `curseur setup, 30 itérations, dernier
  work → completed` (`src/cli.ts:119-120`) — un `dernier` qui pointe sur un
  nœud absent du graphe, sans un mot sur le recul ;
- `iterations` n'est pas remis à zéro et continue de monter : le compteur
  prétend 31 itérations de progression alors que la tâche vient de revenir à
  son point de départ ;
- le log d'itération (`src/iterate.ts:192-217`) n'enregistre que
  `node: "setup"`, l'ancien curseur n'est écrit nulle part ;
- le graphe effectif n'est affiché par rien : `describeGraph`
  (`src/task.ts:188-201`) est exporté mais **jamais appelé** — `grep -rn
  describeGraph src/` ne rend que sa définition. L'utilisateur n'a aucun moyen
  de voir le chemin que le démon suit.

Variante du même mécanisme, pire parce qu'il n'y a même pas de recul visible :
**échanger deux noms de nœuds**. Avec `cursor: "work"` et un `task.json` édité
en `{setup: {skill:"work", …}, work: {skill:"setup", …}}`, le curseur reste
« valide », la branche `else if` ne se déclenche pas, et l'itération suivante
lance le skill `setup` en croyant être sur `work`. Le curseur suit les noms, pas
les nœuds.

## 2. `tasks activate` / `deactivate` détruit le curseur en mémoire sans l'écrire : le nœud exécuté dépend d'un redémarrage sans lien

**Gravité** : sûr
**Où** : `src/daemon.ts:416` (`setActive`), `src/daemon.ts:238-243` (`unpause`),
`src/daemon.ts:381` (`taskInfo`)

`ensureTaskState` **mute** l'état ; or elle est appelée depuis un chemin qui
n'a rien à réparer et qui ne sauvegarde pas :

```ts
// src/daemon.ts:410-418
async setActive(name: string, active: boolean): Promise<void> {
  const task = await this.findTask(name);
  const file = path.join(task.dir, TASK_FILE);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw.active = active;
  await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
  ensureTaskState(this.state, task);        // ← mutation du curseur
  if (active) await this.unpause();          // ← seul chemin vers saveState…
}
```

et `unpause` ne sauvegarde que si une pause existe :

```ts
// src/daemon.ts:238-243
private async unpause(): Promise<void> {
  if (this.state.pausedUntil === null) return;   // cas courant → aucun saveState
  ...
}
```

Donc : `deactivate` n'appelle jamais `unpause`, et `activate` hors pause en
sort aussitôt. Dans les deux cas la remise à `start` existe **en mémoire
seulement**, pendant que `state.json` garde l'ancien curseur. `taskInfo`
(`src/daemon.ts:381`), lui, applique le même repli mais **en lecture seule**,
sans rien écrire.

Scénario, à partir de `{cursor: "work", iterations: 30}` sur disque, hors plage :

1. L'utilisateur renomme `work` → `boucle` dans `task.json`.
2. `unused tasks list` affiche `curseur setup` (repli de `taskInfo`).
   `state.json` contient toujours `"cursor": "work"`.
3. Voyant ça, il annule son renommage (retour à `work`) — et c'est suffisant :
   la prochaine itération repartira bien de `work`. Le `setup` affiché était un
   mensonge, mais inoffensif.
4. Même séquence avec un `unused tasks deactivate revue` inséré entre 1 et 3
   (réflexe naturel : on retire la tâche de la file pendant qu'on édite son
   graphe). `setActive` a écrasé `cursor` à `"setup"` en mémoire, sans
   l'écrire. Après le `reactivate`, la prochaine itération exécute **`setup`**,
   pas `work` : la position est perdue, et c'est la commande `deactivate` qui
   l'a détruite.
5. Même séquence que 4, mais le service est redémarré avant l'itération
   suivante (déploiement, `systemctl restart`) : `loadState`
   (`src/state.ts:61-76`) relit `"cursor": "work"` du disque, le `task.json` est
   de nouveau valide, et l'itération repart de `work`.

Résultat obtenu : pour une suite de commandes identique (étapes 1→3), le nœud
exécuté est `setup` ou `work` selon qu'un `deactivate` a eu lieu et selon qu'un
redémarrage du service s'est intercalé — et dans le cas 4, `state.json` affirme
`work` pendant que le démon s'apprête à lancer `setup`. Résultat attendu : une
commande dont le travail est d'écrire `active` dans `task.json` ne déplace pas
le curseur ; et une réparation de curseur décidée est soit persistée au moment
où elle est décidée, soit pas appliquée du tout.

L'appel à `ensureTaskState` dans `setActive` n'a d'ailleurs aucun usage : son
retour est ignoré, et les deux chemins d'exécution (`src/scheduler.ts:94`,
`src/iterate.ts:80`) la rappellent de toute façon avant chaque itération.

## 3. Un nœud laissé en place mais détaché de `start` fige la tâche dans la branche morte

**Gravité** : probable
**Où** : `src/task.ts:50-66`, `src/state.ts:55`, `src/graph.ts:89`

La validation du graphe vérifie que `start` existe et que chaque `next` existe
(`src/task.ts:51,59`), mais **pas que les nœuds soient atteignables depuis
`start`**. Et `ensureTaskState` ne vérifie qu'une chose : que le curseur soit
une clé de `nodes` — pas qu'il soit encore sur le chemin.

Scénario : graphe `setup → revue → revue`, curseur sur `revue` à l'itération
30. L'utilisateur change de boucle : il ajoute
`audit: {skill: "audit", next: "audit"}`, met `setup.next` à `"audit"`, et
laisse l'entrée `revue` en place (par prudence, ou par oubli — rien ne demande
de la supprimer, et la supprimer est justement ce qui déclencherait le constat 1).

`task.json` est valide. `ensureTaskState` trouve `"revue" in nodes` et ne
touche à rien. `applyOutcome` avance sur `task.def.nodes["revue"].next`
(`src/graph.ts:89`), c'est-à-dire `"revue"`. Résultat obtenu : la tâche tourne
indéfiniment sur l'ancien skill, le nœud `audit` n'est jamais exécuté, aucun
message ne le signale, et le seul indice est un `curseur revue` dans
`unused tasks list` — que rien ne rapproche du graphe, puisque le graphe n'est
affiché nulle part (`describeGraph` inutilisé, constat 1). Résultat attendu :
soit le chargement refuse un graphe dont des nœuds sont inatteignables depuis
`start`, soit le curseur hors chemin est signalé.

Gravité « probable » et non « sûr » : on peut soutenir qu'un nœud encore défini
est un nœud que l'utilisateur veut garder, et que c'est son erreur. Ce qui
reste un défaut sans discussion, c'est l'absence totale de signal : le démon
sait qu'il tourne sur un nœud que `start` n'atteint plus, et ne le dit pas.

## Ce qui a été vérifié et tient

- `taskInfo` (`src/daemon.ts:381`) et `ensureTaskState` (`src/state.ts:52-57`)
  appliquent bien le *même* repli (`ts.cursor in task.def.nodes ? … :
  task.def.start`) : une fois la réparation persistée, l'affichage et le nœud
  exécuté concordent. La divergence du constat 2 vient de la fenêtre
  mémoire/disque, pas d'un repli différent.
- `scheduler.ts:94` et `iterate.ts:80` appellent `ensureTaskState` sur le
  *même* objet `Task` (celui du `loadTasks()` du tour) : le nœud annoncé par
  l'événement `iteration-start` et le nœud exécuté ne peuvent pas diverger à
  l'intérieur d'une itération.
- `applyOutcome` (`src/graph.ts:70,89`) ne peut pas déréférencer un nœud
  inexistant : `ensureTaskState` a validé `ts.cursor` juste avant, dans la même
  itération et contre le même `task.def`.
- Le schéma de `task.json` interdit bien un `start` absent de `nodes` et un
  `next` pendant (`src/task.ts:51-66`) ; `describeGraph` (`src/task.ts:191-201`)
  ne peut donc pas boucler sur un `undefined`, et son `Set` le protège des
  cycles — c'est du code mort, pas du code faux.
- La réparation du curseur est couverte par un test
  (`src/graph.test.ts:137-144`), mais ce test n'observe que la valeur rendue :
  ni la persistance, ni l'absence de trace, ni `ts.last`/`iterations` laissés
  en arrière ne sont vérifiés nulle part.
- `resetTask` (`src/daemon.ts:397-407`) est le seul chemin qui remet
  explicitement le curseur à `start`, et il le persiste et l'annonce
  correctement (`src/cli.ts:147`) ; c'est le contre-exemple qui montre à quoi
  ressemblerait une remise à `start` honnête.
- L'héritage de `status`, d'`iterations` et de `consecutiveFailures` par une
  tâche recréée sous un nom déjà utilisé relève du rapport 032 (constats 1 et
  2) et n'est pas repris ici.
