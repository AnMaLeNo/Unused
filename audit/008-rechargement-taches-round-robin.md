# 008 — Rechargement des tâches en cours de plage (tâche disparue ou illisible, sticky orpheline, round-robin décalé)

**Fichiers examinés** : `src/graph.ts:107-153`, `src/scheduler.ts:83-99`,
`src/daemon.ts:276-280`, `src/daemon.ts:205-212`, `src/daemon.ts:375-418`,
`src/task.ts:163-188`, `src/state.ts:50-59`, `src/docker.ts:101-105`,
`src/cli.ts:115-161`, `src/graph.test.ts:146-193`
**Verdict** : 3 constats (2 sûrs, 1 probable)

## `loadTasks` perd la distinction « illisible » / « plus rien à faire » : un task.json cassé deux secondes éteint la plage et met le calendrier en pause

**Gravité** : sûr
**Où** : `src/daemon.ts:276-280`, `src/scheduler.ts:88-93`, `src/daemon.ts:208-212`

Le scheduler recharge les tâches avant chaque itération, et c'est revendiqué
comme une fonctionnalité (`scheduler.ts:53-54` : « modifier un task.json ou un
skill pendant la plage est pris en compte »). Mais le chargeur passé au
scheduler jette la moitié de ce que `task.loadTasks` lui rend :

```ts
// src/daemon.ts:276-280
private async loadTasks(): Promise<Task[]> {
  const { tasks, errors } = await loadTasks(this.cfg.tasksDir);
  for (const e of errors) this.deps.print(`tâche ${e.name} ignorée : ${e.message}`);
  return tasks;            // ← `errors` s'arrête ici
}
```

Le scheduler ne reçoit qu'un `Task[]`. Une tâche dont le `task.json` ne parse
pas, dont un `skills/<skill>/SKILL.md` a disparu, dont une variable d'`env` a
été retirée du `.env`, ou dont le dossier entier est momentanément inaccessible
(`task.ts:171-177` renvoie alors une liste **vide** et une seule erreur
« dossier des tâches introuvable ») est indiscernable d'une tâche terminée. Et
la liste vide n'est pas traitée comme un incident, mais comme une fin de
travail :

```ts
// src/scheduler.ts:88-93
const task = pickNext(await loadTasks(), state);
if (!task) {
  summary.endedBecause = "nothing-eligible";
  deps.print("plus aucune tâche éligible");
  break;
}
```

```ts
// src/daemon.ts:208-212
} else if (this.lastWindow.endedBecause === "nothing-eligible") {
  await this.pauseUntil(this.deadline(run.manualUntil), "plus rien à faire");
}
```

Scénario concret, avec la configuration livrée (`unused.config.json` : une
plage `mon 00:00 → 13:00`) et une seule tâche `audit` :

1. lundi 00:30, la plage automatique tourne ; l'utilisateur ajuste
   `tasks/audit/task.json` depuis son éditeur, comme le README l'y invite ;
2. l'éditeur écrit un fichier intermédiaire syntaxiquement invalide (accolade
   non fermée, sauvegarde automatique), ou l'utilisateur renomme une seconde le
   dossier `skills/work` ;
3. l'itération en cours se termine ; `loadTasks` range `audit` dans `errors`,
   rend `[]`, imprime une ligne dans le journal ;
4. `pickNext` rend `null` → `endedBecause = "nothing-eligible"` → la boucle
   sort, `state.window = null` ;
5. `execute` pose `pausedUntil = deadline(...)` = **lundi 13:00**
   (`pauseUntil` ne sort tôt que si `cfg.windows` est vide) ;
6. l'utilisateur sauvegarde la version correcte trois secondes plus tard. Rien
   ne se passe : `calendarEnd` rend `null` tant que la pause court
   (`daemon.ts:125-126`), `nextCalendarStart` repart de lundi 13:00 et tombe sur
   le lundi suivant (`daemon.ts:130-135`).

Obtenu : 12 h 30 de plage perdues sur une faute de frappe de trois secondes,
enregistrées sous l'étiquette « plus rien à faire » (`unused status` affiche
`dernière 4 itérations … (nothing-eligible)`), et un démon qui ne retentera
jamais de lui-même. Attendu : une tâche illisible est sautée, le tour suivant
relit le fichier, la plage continue ; seule une liste de tâches *lisibles* et
toutes terminées/inactives justifie de conclure qu'il n'y a plus rien à faire.

Ce qui limite les dégâts, et qui ne les annule pas : `unused status` affiche à
la fois la pause et la ligne `ERREUR audit …` (`cli.ts:115-123`), et
`unused tasks activate audit` lève la pause (`daemon.ts:417`). Il faut donc
qu'un humain regarde — sur une machine qui, par construction, travaille la
nuit pendant que personne ne regarde.

Le rapport 006 décrit la même conséquence par un autre chemin (la fenêtre de
troncature de `setActive`, de l'ordre de la microseconde). La cause commune est
ici : la signature `() => Promise<Task[]>` ne laisse aucun moyen au scheduler de
distinguer « je n'ai rien à faire » de « je n'ai pas pu lire ». Le corriger
côté `setActive` ne corrige pas l'éditeur de l'utilisateur.

## L'état d'une tâche supprimée survit sans trace et ressuscite sur une tâche homonyme — avec son container

**Gravité** : probable
**Où** : `src/state.ts:50-59`, `src/daemon.ts:375-407`, `src/docker.ts:101-105`

`state.tasks` n'est jamais nettoyé. Les seules écritures sont
`ensureTaskState` (création/correction du curseur, `state.ts:50-59`) et le
`delete` de `resetTask` (`daemon.ts:400`) :

```
$ grep -rn "state.tasks" src/*.ts | grep -v test
src/daemon.ts:376, src/daemon.ts:400, src/graph.ts:109, src/state.ts:51, src/state.ts:54
```

Quand un dossier `tasks/<nom>/` disparaît, son entrée d'état reste dans
`state.json` et devient à la fois invisible et inatteignable :

- `status()` construit la liste des tâches à partir de `loadTasks`
  (`daemon.ts:370`), donc l'entrée orpheline n'apparaît nulle part ;
- `resetTask` commence par `findTask`, qui lève `NotFoundError` si le dossier
  n'existe pas (`daemon.ts:389-400`) : impossible de l'effacer ;
- l'image Docker `unused-task-<nom>` reste elle aussi, `removeTaskImages`
  n'étant appelé que par `resetTask`.

Le nom du dossier est la seule identité d'une tâche. Créer une tâche portant un
nom déjà utilisé — cas banal : `audit` rebranché sur un autre dépôt, ou une
tâche refaite après un `rm -rf tasks/audit` puis `unused tasks new audit` —
recolle l'état et le container de la précédente :

- si l'ancien statut était `done` ou `failed`, `isEligible` (`graph.ts:108-110`)
  rend `false` : la tâche neuve n'est **jamais** élue par `pickNext`, et
  `unused tasks list` l'affiche `done  audit  curseur work, 120 itérations`
  alors qu'elle n'en a jamais fait une seule. Si c'est la seule tâche, on
  retombe sur le constat précédent (plage close, calendrier en pause) ;
- si l'ancien statut était `running`, `ensureTaskState` ne remet le curseur sur
  `start` que si le nœud a disparu du graphe. Le squelette de
  `unused tasks new` contient justement un nœud `work` (`scaffold.ts:10-13`) :
  un ancien curseur `work` est conservé tel quel, la tâche neuve saute son nœud
  `setup` ;
- et `resolveTaskImage` ne regarde que le nom (`docker.ts:101-105`) :

  ```ts
  const latest = `${taskImage(taskName)}:latest`;
  return (await imageExists(latest)) ? latest : cfg.docker.baseImage;
  ```

  La première session de la tâche neuve démarre donc dans le container de
  l'ancienne : `/work/repo` est le clone de l'autre dépôt, `/work/PLAN.md`
  l'autre plan. Le skill `work` livré par le squelette commence par « Lis
  /work/PLAN.md et prends la première case non cochée » — il travaillera sur le
  plan de la tâche précédente.

Obtenu : une tâche neuve hérite silencieusement du statut, du curseur, du
compteur d'itérations et de l'espace de travail d'une tâche supprimée.
Attendu : un dossier de tâche absent n'a pas d'état, et un nom réutilisé repart
de zéro (ou, au minimum, le dit). La seule sortie est de recréer le dossier
puis de lancer `unused tasks reset <nom>` — ce qui suppose de savoir que
l'entrée fantôme existe, alors qu'aucune commande ne la montre.

## `tasks activate` annonce « remise dans la file » une tâche que `pickNext` ne reprendra pas

**Gravité** : sûr
**Où** : `src/daemon.ts:410-418`, `src/graph.ts:108-110`, `src/cli.ts:151-161`

`isEligible` demande deux choses : `active` dans le `task.json` **et** un statut
`running` dans `state.json`.

```ts
// src/graph.ts:108-110
const ts = state.tasks[task.name];
return task.def.active && (ts === undefined || ts.status === "running");
```

`setActive` ne touche que la première :

```ts
// src/daemon.ts:410-418
raw.active = active;
await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
ensureTaskState(this.state, task);   // crée l'entrée, ne remet jamais `status`
if (active) await this.unpause();
```

Scénario concret : une tâche accumule trois échecs consécutifs — trois
timeouts, trois `blocking_limit`, ou trois `docker run` malheureux — et
`applyOutcome` la passe à `status: "failed"` (`graph.ts:96-103`). L'utilisateur
voit `failed  audit` dans `unused tasks list`, corrige la cause, et lance la
commande dont la description est « remet une tâche dans la file » :

```
$ unused tasks activate audit
audit activée
```

Obtenu : `active` était déjà `true`, le statut reste `failed`, `isEligible`
rend toujours `false`, la tâche ne tournera plus jamais — et l'`unpause` fait
en prime réveiller le démon, qui ouvre une plage, ne trouve aucune tâche
éligible, et repose aussitôt la pause jusqu'à la fin de la couverture
(`daemon.ts:208-212`). La commande dit « activée » et produit exactement
l'inverse. Attendu : soit `activate` remet le statut à `running`, soit elle
refuse en disant que la tâche est en échec et qu'il faut `reset`.

La seule commande qui remet le statut à `running` est `tasks reset`, et elle
détruit au passage l'image Docker de la tâche (`daemon.ts:404` →
`removeTaskImages` → `docker rmi -f …:latest …:prev`) : tout le travail
accumulé dans le container depuis le début de la tâche. Il n'existe donc aucun
moyen, par l'API, de remettre en file une tâche sortie sur trois échecs sans
perdre son espace de travail — hors arrêt du service et édition manuelle de
`state.json`, le démon gardant son état en mémoire et le réécrivant à chaque
itération.

## Ce qui a été vérifié et tient

- **Le round-robin ne décale pas.** `pickNext` ne mémorise aucun indice : il
  retrouve `lastTask` par son nom à chaque appel (`graph.ts:127`). Une tâche
  ajoutée, retirée ou renommée entre deux itérations ne déplace donc personne.
  Quand `lastTask` est justement la tâche disparue, `findIndex` rend `-1` et la
  boucle repart de `tasks[0]` : un demi-tour de retard, une seule fois, puisque
  l'itération suivante réécrit `lastTask` avec une tâche présente dans la liste.
- **La boucle `for (let i = 1; i <= tasks.length; i++)` visite bien tous les
  indices**, y compris avec `lastIdx = -1` (`(-1+i) % n` pour `i` de 1 à `n`
  couvre `0…n-1`). Le `return eligible[0]!` de `graph.ts:132` est donc
  inatteignable dès que `eligible` est non vide — code mort, sans conséquence.
- **La tâche collante orpheline ne bloque pas la file.** `eligible.find` passe
  avant le round-robin (`graph.ts:122-125`) : un `currentTask` qui n'est plus
  chargé, plus actif ou plus `running` est simplement ignoré, et la file
  continue (comportement couvert par `graph.test.ts:186-192`). Le nom fantôme
  survit dans `state.currentTask` jusqu'au prochain `applyDecision`, sans effet
  autre que de redevenir collant si la tâche réapparaît — ce qui est l'intention
  affichée.
- **`eligible.includes(candidate)` compare des identités valides** : `eligible`
  est filtré de la même instance de tableau dans le même appel. Le fait que
  `loadTasks` reconstruise des objets `Task` neufs à chaque itération ne casse
  rien, aucune comparaison ne traverse deux appels.
- **Pas de décalage entre le nœud annoncé et le nœud exécuté.** Le scheduler lit
  le curseur via `ensureTaskState(state, task).cursor` (`scheduler.ts:94`) et
  passe *le même* objet `Task` à `iterate`, qui rappelle `ensureTaskState` sur
  la même entrée (`iterate.ts:80`, référence partagée) : l'événement
  `iteration-start` et la session portent le même nœud.
- **Un `task.json` réécrit dont le nœud courant disparaît** remet le curseur sur
  `start` au lieu de planter (`state.ts:55-57`), conformément au commentaire ;
  une tâche ajoutée en cours de plage est prise au tour suivant.
