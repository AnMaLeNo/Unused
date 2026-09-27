# 016 — Création d'une tâche : squelette, noms réservés, droits des fichiers

**Fichiers examinés** : `src/scaffold.ts` (entier, surtout `:88-103`) ;
`src/api.ts:72-80` (`POST /tasks`) et `:87-95`, `:113-123` (mapping des
erreurs) ; `src/task.ts:8-10` (`TASK_NAME_RE`), `:41-67` (validation
`start`/`next`), `:121-161` (`loadTask`) ; `src/state.ts:38-59`
(`emptyState`, `ensureTaskState`) ; `src/graph.ts:107-133` (`isEligible`,
`pickNext`) ; `src/daemon.ts:375-418` (`taskInfo`, `resetTask`, `setActive`) ;
`src/iterate.ts:80-106` ; `src/claude.ts:15-38` (`buildPrompt`,
`buildCommand`) ; `src/docker.ts:97-99`, `:166-180` ; `src/cli.ts:125-161`,
`:178-181` ; `deploy/install.sh`, `deploy/unused.service`,
`docker/Dockerfile` ; `README.md`. Aucun test n'existe pour `scaffoldTask` ni
pour `POST /tasks` (`grep scaffold src/*.test.ts` : rien).

**Verdict** : 5 constats (2 sûrs, 2 probables, 1 à vérifier)

## Une tâche nommée `constructor` est acceptée, affichée « active », et ne tourne jamais

**Gravité** : sûr
**Où** : `src/state.ts:51` et `src/graph.ts:109` (nom validé en
`src/scaffold.ts:90` / `src/task.ts:10`)

`TASK_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/` accepte `constructor` :
minuscules uniquement, aucun séparateur. Le nom devient une clé de
`state.tasks`, qui est un objet ordinaire — `emptyState()` retourne
`tasks: {}` (`state.ts:39`), donc avec `Object.prototype` dans sa chaîne. Or
les deux lectures de cette table testent la *présence* par une simple
lecture de propriété :

```ts
// state.ts:50-58
export function ensureTaskState(state: RunnerState, task: Task): TaskState {
  let ts = state.tasks[task.name];
  if (!ts) { ts = initialTaskState(task); state.tasks[task.name] = ts; }
  else if (!(ts.cursor in task.def.nodes)) { ts.cursor = task.def.start; }
  return ts;
}

// graph.ts:108-111
export function isEligible(task: Task, state: RunnerState): boolean {
  const ts = state.tasks[task.name];
  return task.def.active && (ts === undefined || ts.status === "running");
}
```

`state.tasks["constructor"]` ne vaut pas `undefined` : c'est la fonction
`Object`, héritée du prototype. Donc :

- `isEligible` : `ts === undefined` est faux, `ts.status` vaut `undefined`,
  `undefined === "running"` est faux → **la tâche n'est jamais éligible**,
  quoi qu'en dise `active` dans task.json.
- `ensureTaskState` : `!ts` est faux (la fonction `Object` est *truthy*), donc
  la branche d'initialisation n'est jamais prise et **aucune entrée n'est
  écrite dans `state.tasks`** ; on tombe dans le `else if`, où `ts.cursor` vaut
  `undefined`, `"undefined" in task.def.nodes` est faux, et on exécute
  `ts.cursor = task.def.start`, c'est-à-dire `Object.cursor = "setup"` — une
  propriété posée sur le constructeur global `Object` du processus démon (pas
  d'exception : `Object` est extensible).

Scénario complet, sur une installation neuve (pas de `state.json`) :

```
unused tasks new constructor      → tasks/constructor/ créé (scaffold.ts:90 laisse passer)
unused tasks activate constructor → 200, "constructor activée"
                                    (setActive réécrit active:true, puis
                                     ensureTaskState pollue Object.cursor)
unused tasks list                 → "active    constructor  curseur setup, 0 itérations"
unused start --for 8h             → "plus aucune tâche éligible" ; si c'est la
                                    seule tâche, la plage se termine aussitôt
                                    en `nothing-eligible` et le démon met les
                                    plages automatiques en pause jusqu'à la fin
                                    de la couverture (daemon.ts:208-212)
```

Attendu : soit le nom est refusé à la création, soit la tâche tourne. Obtenu :
la CLI affirme qu'elle est active et à l'arrêt sur `setup`, le scheduler ne la
voit pas, et `data/state.json` ne contient aucune trace d'elle.

La sortie de secours n'en est pas une : `resetTask` fait
`delete this.state.tasks[name]` (`daemon.ts:400`), qui sur une propriété
*héritée* ne supprime rien et retourne `true` ; la CLI imprime
« constructor remise à zéro (curseur sur setup, image supprimée) » et la tâche
reste invisible pour `pickNext`. La seule issue est de renommer le dossier.

`constructor` est le seul nom de `Object.prototype` que la regex accepte
(`__proto__` est rejeté — un nom doit commencer par `[a-z0-9]`, et `hasOwnProperty`
ou `toString` ne sont pas en minuscules). C'est un nom improbable, mais il est
accepté sans réserve par un chemin — `unused tasks new` — dont le rôle est
précisément de valider le nom.

## Le squelette est écrit avec des droits qui interdisent à son destinataire de l'adapter

**Gravité** : sûr (dans le déploiement décrit par `deploy/install.sh`)
**Où** : `src/scaffold.ts:95-101`

`scaffoldTask` crée répertoires et fichiers sans `mode` explicite : `mkdir`
applique `0o777 & ~umask` et `writeFile` `0o666 & ~umask`. Le démon tourne sous
systemd (`deploy/unused.service:12-14` : `User=unused`, `Group=docker`), dont
l'`UMask` par défaut est `0022`. Le squelette est donc écrit
`unused:docker`, répertoires `0755`, fichiers `0644` — alors que
`install.sh:42-44` ouvre délibérément `tasks/` au groupe (`chown unused:docker`,
`chmod 770`) parce que c'est par ce groupe que « les comptes humains
atteignent » le démon et son arborescence.

Conséquence, pour l'opérateur (membre de `docker`, pas `unused`) qui suit
exactement ce que la CLI lui dit de faire :

```
$ unused tasks new revue
/opt/unused/tasks/revue créé — adapte task.json et les skills, puis `unused tasks activate revue`
$ $EDITOR tasks/revue/task.json      → EACCES (0644 unused:docker)
$ mkdir tasks/revue/skills/troisieme → EACCES (0755 unused:docker)
$ rm -rf tasks/revue                 → EACCES (unlink demande l'écriture sur tasks/revue)
```

Le squelette est en lecture seule pour la seule personne censée le remplir, et
elle ne peut même pas le supprimer pour recommencer (elle peut seulement, parce
que `tasks/` est `0770`, déplacer le répertoire entier ailleurs). Il faut
`sudo`, que ni le README ni `install.sh` n'évoquent pour cet usage.

Le défaut symétrique se produit sur une tâche écrite à la main, ce que le README
présente comme la voie normale (« ## Écrire une tâche », arborescence à créer) :
les fichiers appartiennent alors à l'humain, avec son groupe primaire, en `0644`.
Or `setActive` **réécrit task.json** côté démon :

```ts
// daemon.ts:410-418
const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
raw.active = active;
await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
```

L'utilisateur `unused` (gid `docker`) n'est ni propriétaire du fichier ni membre
du groupe `alice` : `unused tasks activate revue` échoue en `EACCES`. L'erreur
n'est pas typée, elle tombe dans le fourre-tout de `api.ts:119-122` → **HTTP
500** `{"error":"EACCES: permission denied, open '…/task.json'"}`. Rien dans le
projet ne dit quel propriétaire ou quel mode les fichiers d'une tâche doivent
avoir pour que les deux comptes puissent y écrire.

## `start` et `next` sont validés avec `in` : les noms héritables passent et cassent la plage entière

**Gravité** : probable
**Où** : `src/task.ts:51` et `:59`

`nodes` est un `z.record(...)` : un objet ordinaire, prototype inclus. La
validation cherche les nœuds avec l'opérateur `in`, qui parcourt la chaîne de
prototypes :

```ts
// task.ts:50-66
if (!(t.start in t.nodes)) { /* nœud introuvable */ }
for (const [name, node] of Object.entries(t.nodes)) {
  if (!(node.next in t.nodes)) { /* nœud introuvable */ }
}
```

Donc `"start": "toString"` (ou `"constructor"`, `"valueOf"`, `"__proto__"`…) est
accepté sans nœud correspondant. Le contrôle d'existence des skills ne rattrape
rien : il itère sur `Object.values(t.nodes)` (`task.ts:148`), donc sur les seules
clés propres. `loadTask` réussit, la tâche est éligible, et l'itération lit :

```ts
// iterate.ts:84-87
const nodeName = ts.cursor;                 // "toString"
const node = task.def.nodes[nodeName]!;     // Object.prototype.toString, une fonction
const prompt = buildPrompt(node, task.def.params);
const command = buildCommand(cfg, node);
```

`buildPrompt` survit (`{...undefined}` est légal) et produit `/undefined
repo=…`, mais `buildCommand` fait `[...cfg.claude.sessionArgs, ...node.args]`
(`claude.ts:28`) avec `node.args === undefined` → `TypeError: node.args is not
iterable`. Cette exception n'est rattrapée ni par `iterate` (elle n'est pas une
`DockerError`) ni par `runWindow` : elle remonte jusqu'à `daemon.ts:213-216`,
qui imprime « plage interrompue par une erreur » et met les plages automatiques
en pause. Une seule tâche mal nommée arrête donc la plage **pour toutes les
autres**, au lieu d'être écartée comme tâche invalide — ce que la validation
existe justement pour faire, et ferait correctement avec
`Object.hasOwn(t.nodes, t.start)`. Le déclencheur est un nom de nœud inhabituel ;
la mécanique, elle, est certaine.

## Un squelette écrit à moitié bloque toute nouvelle tentative, et toute panne est rapportée comme un conflit

**Gravité** : probable
**Où** : `src/api.ts:75-79`, `src/scaffold.ts:94-101`

`POST /tasks` enveloppe *toutes* les erreurs de `scaffoldTask` dans un 409 :

```ts
try {
  return sendJson(res, 200, { dir: await scaffoldTask(cfg.tasksDir, body.name) });
} catch (err) {
  throw new HttpError(409, (err as Error).message);
}
```

Deux conséquences distinctes.

D'abord un nom invalide — le cas que `scaffold.ts:90-92` détecte lui-même — est
rendu comme un conflit : `unused tasks new Revue` sort en **code 3**, que
`cli.ts:180` réserve aux 409 (« déjà là »), là où un 400 donnerait 1. Un script
qui fait `unused tasks new "$n" || [ $? -eq 3 ]` pour être idempotent avale donc
silencieusement une faute de frappe (`Revue`, `ma tâche`, `a--b`) au lieu de
s'arrêter. Rien n'apparaît côté démon : `console.error` n'est appelé que pour
les 500 (`api.ts:121`).

Ensuite, les sept opérations de `scaffoldTask` (trois `mkdir`, quatre
`writeFile`) s'enchaînent sans nettoyage en cas d'échec. Un `EACCES`, `ENOSPC`
ou `EIO` sur la quatrième laisse `tasks/<nom>/` en place, et le diagnostic est
lui aussi renvoyé en 409 ; la tentative suivante bute sur le garde-fou
`scaffold.ts:94` et répond « existe déjà » — même code, autre message. Selon le
point d'arrêt, le résidu est soit invisible (pas de task.json → `loadTasks`
l'ignore, `task.ts:180`), soit affiché en `ERREUR … skills introuvables`. Dans
les deux cas l'opérateur ne peut pas le retirer lui-même (constat précédent) et
la vraie cause n'a été écrite nulle part.

## Aucune limite de longueur alors que le nom sert de référence Docker

**Gravité** : à vérifier
**Où** : `src/scaffold.ts:90`, `src/docker.ts:97-99`

Le commentaire de `TASK_NAME_RE` (`task.ts:8-9`) justifie la regex par le fait
que le nom « sert de nom d'image Docker (unused-task-<nom>) », mais ne contrôle
pas la longueur. Un nom de 244 caractères ou plus passe la création (la limite
du système de fichiers est de 255 octets par composant, donc `mkdir` réussit)
et donne une référence `unused-task-<nom>` de plus de 255 caractères.

La bibliothèque de références de Docker refuse ces noms
(`NameTotalLengthMax = 255`, « repository name must not be more than 255
characters ») — je n'ai pas pu l'exercer ici, il n'y a pas de Docker dans ce
container, d'où la gravité. Si c'est bien le cas, l'échec ne survient pas à la
création mais au premier `commitTask` (`docker.ts:166-180`), après une itération
*réussie* : `mustSucceed` lève une `DockerError`, `iterate.ts:172-183` la
convertit en `outcome fatal:docker`, le container est jeté, le curseur revient
en arrière, et `daemon.ts:205-207` déclare une **panne globale** — « plus rien
ne tourne » pour toutes les tâches, avec un message parlant de Docker alors que
le problème est le nom choisi. Chaque `unused start` rejouerait la même
séquence.

## Ce qui a été vérifié et tient

- **Pas de traversée de chemin par le nom.** `scaffoldTask` teste
  `TASK_NAME_RE` (`:90`) *avant* de construire `path.join(tasksDir, name)`
  (`:93`) ; la regex interdit `/`, `\`, les espaces, les majuscules, un point
  initial ou final et les séparateurs consécutifs, donc ni `..` ni chemin
  absolu. Même contrôle à la relecture (`task.ts:123-127`). Les routes
  `POST /tasks/<nom>/{reset,active}` décodent le nom (`api.ts:89`) mais ne le
  concatènent jamais à un chemin : elles le cherchent parmi les tâches déjà
  chargées (`daemon.ts:389-395`), dont les noms viennent de `path.basename`.
- **Le squelette produit est cohérent avec le reste du code.** `start: "setup"`
  et `nodes.setup.next = "work"`, `work.next = "work"` satisfont la validation
  de `task.ts:50-66` ; les deux `SKILL.md` écrits correspondent exactement aux
  `skill` déclarés, donc le contrôle d'existence de `task.ts:147-155` passe ;
  `active: false` est cohérent avec le message de la CLI qui renvoie vers
  `tasks activate` ; `env: []` ne peut pas faire échouer `resolveEnv`
  (`task.ts:156-159`) ; `describeGraph` sur ce graphe donne
  « setup → work → work (boucle) » sans boucler.
- **Le garde-fou « existe déjà » couvre bien le cas ordinaire.** `stat` sur un
  fichier comme sur un répertoire existant renvoie `true` (`:94`), donc un
  `tasks/<nom>` déjà présent n'est jamais écrasé. La fenêtre TOCTOU entre ce
  `stat` et les `mkdir` n'a pas de conséquence : le contenu écrit est
  déterministe, deux `POST` concurrents sur le même nom produisent le même
  squelette.
- **Le nom n'ouvre pas de collision d'images.** `taskImage` préfixe par
  `unused-task-`, injectif sur les noms admis, et ne peut heurter ni
  `unused-base` ni les containers `unused-<nom>-<ts>` / `unused-flatten-…`. Un
  point dans le nom ne fait pas prendre le nom pour un registre : sans `/`, la
  résolution de référence Docker ne cherche pas de domaine.
- **`exchange/` est créé au bon endroit et au bon moment.** `scaffoldTask` le
  crée (`:97`) et `runInTask` le recrée au besoin (`docker.ts:133`) : une tâche
  écrite à la main sans ce répertoire fonctionne quand même.
