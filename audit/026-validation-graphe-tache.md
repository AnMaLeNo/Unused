# 026 — Validation du graphe de tâche (`loadTask` / `TaskFileSchema`)

**Fichiers examinés** : `src/task.ts:27-201`, `src/state.ts:42-59`, `src/graph.ts:64-105`,
`src/iterate.ts:80-90`, `src/iterate.ts:218`, `src/claude.ts:15-38`, `src/log.ts:42-47`,
`src/daemon.ts:194-224`, `src/daemon.ts:376-386`, `src/scheduler.ts:82-140`, `src/scaffold.ts:5-40`
**Verdict** : 2 constats (2 sûrs)

Racine commune : les **clés** de `nodes` sont le seul identifiant du graphe qui ne
soit jamais contraint. Le nom de tâche a `TASK_NAME_RE` (`task.ts:10`), les entrées
`env` ont `ENV_ENTRY_RE` (`task.ts:27`), `skill` et `next` ont `min(1)` — mais
`z.record(NodeSchema)` (`task.ts:47`) accepte n'importe quelle chaîne comme nom de
nœud, y compris la chaîne vide, un nom de méthode de `Object.prototype`, ou un nom
contenant `/`. Les deux constats ci-dessous sont deux conséquences distinctes.

## 1. Les clés héritées d'`Object.prototype` passent la validation et font tomber la plage entière

**Gravité** : sûr
**Où** : `src/task.ts:51` et `src/task.ts:59` (aussi `src/state.ts:55`, `src/daemon.ts:381`)

Le `superRefine` vérifie l'appartenance au graphe avec l'opérateur `in` :

```ts
if (!(t.start in t.nodes)) { … }          // task.ts:51
…
if (!(node.next in t.nodes)) { … }        // task.ts:59
```

`in` parcourt la chaîne de prototypes. `t.nodes` est un objet ordinaire : zod v3
construit le résultat d'un `ZodRecord` dans un littéral `{}` (et même sans zod,
`JSON.parse` produit un objet dont le prototype est `Object.prototype`). Donc
`"constructor" in t.nodes` vaut `true` alors qu'aucun nœud ne porte ce nom.
Idem pour `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `__proto__`…

À l'inverse, tout le reste du chargement utilise des accès aux clés **propres** :
`Object.entries(t.nodes)` (`task.ts:58`) et `Object.values(task.def.nodes)`
(`task.ts:148`, la vérification des `SKILL.md`). Le nœud fantôme n'est donc jamais
confronté à un skill, ni à quoi que ce soit — il n'existe que pour le test `in`.

Scénario concret — `tasks/demo/task.json` :

```json
{ "active": true, "start": "constructor",
  "nodes": { "a": { "skill": "work", "next": "a" } } }
```

1. `TaskFileSchema` : `"constructor" in t.nodes` → `true`, aucun `addIssue`.
   `"a".next === "a"` → OK. **Validation réussie.**
2. `loadTask` : `Object.values(nodes)` ne voit que `a`, `skills/work/SKILL.md`
   existe → **tâche chargée sans erreur**, elle apparaît normalement dans
   `unused tasks list`.
3. `initialTaskState` (`state.ts:43`) pose `cursor = "constructor"`.
   `ensureTaskState` (`state.ts:55`) revérifie avec `in` → `true`, donc le
   garde-fou « le curseur pointe sur un nœud disparu, on repart de `start` » ne
   se déclenche pas.
4. `iterate.ts:85` : `const node = task.def.nodes["constructor"]!` renvoie la
   fonction `Object` (héritée), pas un nœud.
5. `iterate.ts:86` `buildPrompt` ne casse pas (`{...undefined}` vaut `{}`) et
   produit le prompt `/undefined`. Puis `iterate.ts:87` → `buildCommand` :

```ts
const src = [...cfg.claude.sessionArgs, ...node.args];   // claude.ts:27
```

`node.args` est `undefined` → `TypeError: node.args is not iterable`.

6. L'exception traverse `deps.runIteration` (`scheduler.ts:98`), sort de
   `runWindow`, et est attrapée par le démon (`daemon.ts:213-217`) :

```ts
} catch (err) {
  this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
  this.state.window = null;
  await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
}
```

Résultat obtenu : **toute la plage s'arrête** et les plages automatiques sont
mises en pause jusqu'à son terme, sur le message opaque
`plage interrompue par une erreur : node.args is not iterable` — qui ne nomme ni
la tâche ni le nœud. Les autres tâches, parfaitement saines, ne tournent plus non
plus. Résultat attendu : `task.json invalide : start → nœud "constructor"
introuvable dans nodes`, au chargement, la tâche étant seule à être écartée
(`loadTasks` la mettrait dans `errors`, cf. `task.ts:183`).

Variantes équivalentes vérifiées sur le même chemin :

- `"next": "toString"` sur un nœud valide : la validation passe, la première
  itération réussit, `graph.ts:89` (`ts.cursor = task.def.nodes[node]!.next`)
  pose `cursor = "toString"`, l'état est sauvegardé, et c'est **l'itération
  suivante** qui tue la plage — avec un `state.json` que `ensureTaskState` ne
  répare pas, donc à chaque redémarrage.
- `"nodes": {}` avec `"start": "constructor"` : un graphe vide passe la
  validation, alors que n'importe quel autre `start` la ferait échouer.
- `"__proto__"` comme nom de nœud : `mergeObjectSync` de zod v3 écarte
  explicitement cette clé, le nœud est donc silencieusement perdu, mais
  `"__proto__" in t.nodes` reste `true` — la validation ne signale rien.

À noter au passage, sur le même défaut : `describeGraph` (`task.ts:191-201`)
boucle sur `def.nodes[cur]!.next`. Avec `start: "constructor"` elle pose
`cur = undefined` au premier tour puis déréférence `def.nodes[undefined]`
(`undefined`) au second → `TypeError`. La fonction est exportée mais n'est
appelée nulle part dans `src/` (vérifié par grep), donc ce chemin est mort
aujourd'hui ; il le redeviendra le jour où on l'affichera dans `tasks list`.

## 2. Un `/` dans un nom de nœud casse l'écriture du log et interrompt la plage après une itération réussie

**Gravité** : sûr
**Où** : `src/log.ts:43-47`, nom non contraint en `src/task.ts:47`

```ts
const dir = path.join(logsDir(cfg), rec.task);
await mkdir(dir, { recursive: true });
const stamp = rec.startedAt.replace(/[:.]/g, "-");
const file = path.join(dir, `${stamp}-${rec.node}.json`);
await writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
```

Le nom du nœud est interpolé tel quel dans un nom de fichier. Seul
`data/logs/<tâche>/` est créé par le `mkdir`. Rien, ni dans `TaskFileSchema`, ni
dans le README généré par `scaffold.ts:20-30` (qui décrit `nodes` sans dire un mot
sur la forme des noms), n'interdit un `/` — alors que des noms comme
`audit/choose` ou `find/do` sont une façon naturelle de nommer les étapes d'un
graphe à deux niveaux.

Scénario concret : `"start": "audit/choose"`, `"nodes": { "audit/choose": {…} }`.

1. Validation et `loadTask` : rien à redire, le graphe est cohérent.
2. L'itération s'exécute entièrement : container lancé, session `claude`
   terminée en `completed`, `applyOutcome` avance le curseur, `commitTask`
   commite l'image, `saveState` écrit l'état (`iterate.ts:187`).
3. `iterate.ts:218` → `writeIterationLog` tente d'écrire
   `data/logs/demo/2026-09-28T10-00-00-000Z-audit/choose.json`. Le dossier
   `…-audit/` n'existe pas → `ENOENT`.
4. `writeIterationLog` n'est pas dans un `try` ; l'exception remonte comme au
   constat 1 jusqu'à `daemon.ts:214` : **la plage s'arrête et se met en pause**,
   sur `plage interrompue par une erreur : ENOENT: no such file or directory, open '…'`.

Résultat obtenu : une itération qui a *réussi* et a été commitée fait tomber la
plage, et le nœud étant dans une boucle, chaque reprise la refait tomber au même
endroit — la tâche n'avance plus d'un nœud par plage, pour une raison sans rapport
visible avec elle. Aucun compteur n'est incrémenté non plus, puisque
`onEvent("iteration-end")` (`scheduler.ts:99`) n'est jamais atteint : le `status`
sous-déclare le travail réellement effectué. Résultat attendu : soit un nom de
nœud refusé au chargement, soit un échec d'écriture de log qui ne fait pas tomber
la plage.

## Ce qui a été vérifié et tient

- **Nœuds injoignables** : le `superRefine` ne vérifie pas l'accessibilité depuis
  `start`, mais aucun chemin de code ne s'en trouve faussé. Les nœuds orphelins
  voient quand même leur `SKILL.md` vérifié (`task.ts:148` itère sur *tous* les
  nœuds, pas seulement les accessibles), et `describeGraph` — seule fonction qui
  suive la chaîne — n'est appelée nulle part. C'est du bruit de configuration,
  pas un défaut démontrable. Le contrôle inverse, lui, tient : tout `next` et le
  `start` pointent sur une clé présente, donc `graph.ts:89` ne peut pas produire
  de curseur hors graphe (hors constat 1), et la boucle `while` de `describeGraph`
  termine toujours grâce à son `Set`.
- **`env` résolue au chargement** : `loadTask` appelle bien `resolveEnv` à
  `task.ts:156`, mais **jette le résultat** — seul `missing` sert, pour refuser la
  tâche. La valeur réellement transmise au container est recalculée à chaque
  itération depuis `deps.env` (`iterate.ts:103`), donc il n'y a pas de valeur
  figée au chargement : modifier une variable d'environnement du démon est pris en
  compte à l'itération suivante, sans redémarrage. Les deux sources sont
  cohérentes (`cli.ts:21` charge le `.env` dans `process.env` avant tout, et
  `defaultDeps.env` est `process.env`, `iterate.ts:29`). `resolveEnv` elle-même a
  été relue : `indexOf("=")` gère correctement `"B=x=y"` (valeur `x=y`) et une
  valeur vide `"B="`, et une variable présente mais vide côté hôte n'est pas
  comptée comme manquante (test `v === undefined`, `task.ts:102`) — conforme à la
  sémantique `docker run -e` annoncée.
- **`.strict()`** : posé sur `NodeSchema` comme sur `TaskFileSchema`, donc une
  clé inconnue dans un nœud ou à la racine est bien refusée ; la faille du
  constat 1 ne vient pas de là.
- **`TASK_NAME_RE`** (`task.ts:10`, appliqué au `basename` du dossier en
  `task.ts:123`) rejette bien `..`, `/`, les majuscules et les séparateurs
  doublés : le nom de tâche, lui, ne peut pas casser `path.join(logsDir, rec.task)`.
