# 035 — Découverte des tâches sur le disque : dossier symbolique ignoré, task.json absent silencieux, EACCES pris pour une absence

**Fichiers examinés** : `src/task.ts:112-119` (`exists`), `src/task.ts:121-161`
(`loadTask`), `src/task.ts:163-188` (`loadTasks`), `src/daemon.ts:276-280`
(`Daemon.loadTasks`), `src/daemon.ts:328-373` (`status`), `src/daemon.ts:389-395`
(`findTask`), `src/daemon.ts:205-212` (bascule `nothing-eligible` → pause),
`src/scheduler.ts:83-93` (rechargement avant chaque itération),
`src/graph.ts:107-132` (`isEligible`, `pickNext`), `src/state.ts:50-59`,
`src/cli.ts:103-131` (`printTasks`), `src/api.ts:72-93`, `src/scaffold.ts:88-102`,
`deploy/install.sh:36-50`, `README.md:50-75`.

Pas de `node` dans ce container : les deux faits de système de fichiers sur
lesquels reposent les constats ont été vérifiés directement au niveau POSIX
(`stat` sous un compte non privilégié, `stat`/`stat -L` sur un lien), le reste
par lecture du code et des appels Node concernés.

```
$ ls -l tasks/
lrwxrwxrwx 1 root root   19 bar -> /tmp/disc/elsewhere
drwx------ 2 root root 4096 foo
$ su nobody -s /bin/sh -c 'stat -c %n tasks/foo/task.json'
stat: cannot statx 'tasks/foo/task.json': Permission denied
$ stat -c '%n %F' tasks/bar  →  bar symbolic link      # ce que voit un Dirent
$ stat -Lc '%n %F' tasks/bar →  bar directory          # ce qu'il faudrait suivre
```

**Verdict** : 3 constats (1 sûr, 2 probables)

Racine commune : la découverte est écrite comme un filtre, pas comme un
diagnostic. Trois décisions (`isDirectory()`, `exists(task.json)`, le `catch`
du `readdir`) répondent oui/non à une question qui a trois réponses
possibles — *c'est une tâche*, *ce n'en est pas une*, *je n'ai pas pu
savoir* — et la troisième est systématiquement rangée avec la deuxième. Or
`loadTasks` est la seule source de vérité du démon sur ce qui existe :
`status`, `tasks list`, `reset`, `activate` et le choix de la prochaine
itération en découlent tous.

## 1. Un dossier de tâche illisible disparaît sans trace, et le démon conclut « plus rien à faire »

**Gravité** : sûr
**Où** : `src/task.ts:112-119` et `src/task.ts:180`

`exists` avale toutes les erreurs de `stat` :

```ts
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
```

et `loadTasks` s'en sert comme unique garde avant de charger :

```ts
for (const name of entries) {
  const dir = path.join(tasksDir, name);
  if (!(await exists(path.join(dir, TASK_FILE)))) continue;   // ← ligne 180
```

`stat` ne répond pas seulement ENOENT. Si `tasks/<nom>/` n'est pas
traversable par le compte du service, l'appel échoue en EACCES (vérifié
ci-dessus) et la tâche est traitée exactement comme un dossier qui n'est pas
une tâche : `continue`. Elle n'entre ni dans `tasks` ni dans `errors` — elle
n'existe nulle part.

Le scénario concret est celui de l'installation décrite par le dépôt.
`deploy/install.sh:43-44` ne pose les droits que sur `tasks/` lui-même
(`chown unused:docker tasks; chmod 770 tasks`), pas sur son contenu ; le
service tourne sous `unused`. Un opérateur qui installe une tâche autrement
que par `unused tasks new` — `sudo cp -r ~/review-monprojet /opt/unused/tasks/`,
ou un `sudo mkdir` avec un umask serré — laisse un `tasks/review-monprojet/`
en `drwx------ root root`. `readdir(tasksDir)` le liste sans difficulté (il
suffit de lire `tasks/`, dont le mode 770 l'autorise) et `isDirectory()` est
vrai ; c'est le `stat` de l'enfant qui bute.

Résultat obtenu, en partant d'une installation dont c'est la seule tâche :

- `unused status` affiche `tâches   aucune` (`cli.ts:116` : la ligne « aucune »
  est conditionnée à `list.length === 0 && errors.length === 0`, les deux le
  sont) ;
- `unused tasks list` affiche la même chose et **sort en 0** (`cli.ts:131`
  ne met `exitCode = 1` que s'il y a des erreurs) ;
- `unused tasks reset review-monprojet` répond `tâche review-monprojet
  introuvable` (`daemon.ts:394`, branche sans erreur correspondante) ;
- le démon ne journalise rien : `Daemon.loadTasks` (`daemon.ts:278`) n'imprime
  que les entrées de `errors`, et il n'y en a aucune ;
- à l'ouverture de la plage, `runWindow` recharge (`scheduler.ts:88`),
  `pickNext([], state)` rend `null`, la plage se termine en
  `nothing-eligible` (`scheduler.ts:90-92`), et le démon en déduit qu'il
  n'y a plus de travail : `pauseUntil(deadline, "plus rien à faire")`
  (`daemon.ts:208-211`). Les plages automatiques sont alors ignorées jusqu'au
  bout de la couverture en cours.

Résultat attendu : `errors.push({ name, message: "…EACCES…" })`, donc une
ligne `ERREUR  review-monprojet  …` dans `status`, un exit code 1 pour
`tasks list`, et une plage qui ne se met pas en pause en prétendant avoir fini.

Le plus net est que le message juste existe déjà et que c'est cette garde qui
l'empêche de sortir. Sans le pré-test de la ligne 180, `loadTask` lirait le
fichier et lèverait `impossible de lire task.json : EACCES: permission
denied, open '…'` (`task.ts:130-134`), qui serait rangé dans `errors` par le
`catch` de la ligne 183 et affiché. La garde ne sert qu'à distinguer un
dossier-non-tâche ; elle n'a besoin de rien d'autre que de ENOENT, et en
traitant tout le reste comme ENOENT elle supprime un diagnostic correct.

Même helper, même confusion, un cran plus bas : `task.ts:149` teste les
`SKILL.md` avec le même `exists`. Un `skills/` recopié en root mode 700 (le
même `sudo cp -r`, quand le `task.json` est lisible mais pas le sous-dossier)
produit `skills introuvables (attendus dans skills/<nom>/SKILL.md) : work`
alors que `skills/work/SKILL.md` est là. La tâche est bien écartée et le
problème est bien signalé — c'est la raison qui est fausse, et elle envoie
l'opérateur recréer un fichier qui existe.

## 2. Un dossier de tâche atteint par lien symbolique n'est jamais vu

**Gravité** : probable
**Où** : `src/task.ts:171-174`

```ts
entries = (await readdir(tasksDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
```

Avec `withFileTypes`, le type porté par un `Dirent` est celui de l'entrée de
répertoire, pas celui de sa cible : pour un lien, `isSymbolicLink()` est vrai
et `isDirectory()` est faux (`readdir` ne déréférence pas). Vérifié au niveau
POSIX ci-dessus : `tasks/bar` est un `symbolic link` en lstat et un
`directory` seulement en stat suivi.

Donc `tasks/review-monprojet -> /home/moi/projets/review-monprojet` est écarté
par le `filter`, avant même d'arriver au test du `task.json`. Comme pour le
constat 1, la sortie est un `continue` muet : rien dans `tasks`, rien dans
`errors`, rien dans le journal, `tâches   aucune`.

Le montage est naturel sur cette installation, et c'est ce qui rend le
silence coûteux : `tasks/` est le seul dossier du déploiement ouvert en
écriture au service (`install.sh:37`), le code de `/opt/unused` appartient à
un autre compte, et des tâches versionnées ailleurs se posent là par lien
plutôt que par copie — d'autant que le nom du dossier *est* le nom de la
tâche (`README.md:70`, `task.ts:122`), ce qu'un lien permet de choisir sans
toucher à la cible. L'asymétrie achève de rendre le comportement illisible :
`tasksDir` peut, lui, être un lien (`readdir` suit le chemin qu'on lui
donne) ; un dossier de tâche ne peut pas.

Que les liens soient volontairement hors périmètre est défendable — ce qui
ne l'est pas, c'est qu'un répertoire contenant un `task.json` valide soit
écarté sans qu'une seule ligne, ni dans `status` ni dans le journal, ne dise
pourquoi. `e.isDirectory() || e.isSymbolicLink()` suffirait à les accepter
(`stat` et `readFile` suivent ensuite les liens d'eux-mêmes) ; les refuser
demanderait au moins de le signaler.

## 3. Toute erreur sur `tasks/` est rapportée comme « dossier des tâches introuvable »

**Gravité** : probable
**Où** : `src/task.ts:175-177`

```ts
} catch {
  return { tasks, errors: [{ name: tasksDir, message: "dossier des tâches introuvable" }] };
}
```

Le `catch` ne regarde pas `err.code`. ENOENT, EACCES (dossier présent mais
fermé au compte du service — par exemple un `tasks/` restauré en
`drwx------ root root`, ou un `install.sh` non rejoué après une réinstallation),
ENOTDIR (`tasks` est un fichier), EMFILE, EIO : tout devient « introuvable ».
L'opérateur lit que le dossier n'est pas là, va le recréer, le voit déjà
présent, et le vrai message (`EACCES: permission denied, scandir
'/opt/unused/tasks'`) n'est affiché nulle part.

S'y ajoute une incohérence de l'entrée produite : son `name` est le chemin
absolu de `tasksDir`, là où toutes les autres entrées de `errors` portent un
nom de tâche (`task.ts:184`). `findTask` (`daemon.ts:393`) cherche l'erreur
par nom de tâche, ne la trouve jamais, et `reset`/`activate` répondent donc
`tâche <nom> introuvable` — au lieu de remonter la cause réelle qui empêche
*toutes* les tâches d'être vues.

## Ce qui a été vérifié et tient

- L'ordre de découverte est déterministe (`.sort()` sur les noms, `task.ts:174`)
  et c'est bien lui qui ancre le round-robin de `pickNext` (`graph.ts:126-131`) ;
  pas de dépendance à l'ordre de `readdir`.
- Un `task.json` présent mais invalide (JSON cassé, schéma refusé, nom de
  dossier hors `TASK_NAME_RE`, skill manquant, variable d'env absente) est
  correctement converti en entrée de `errors` avec un message exploitable
  (`task.ts:181-185`), affichée par `printTasks` (`cli.ts:122`) et par le
  journal du démon (`daemon.ts:278`), et `tasks list` sort alors en 1.
- Aucun élagage de `state.json` sur la base des tâches découvertes :
  `ensureTaskState` (`state.ts:50-59`) ne crée que des entrées, rien ne
  supprime celles des tâches absentes. Une tâche momentanément invisible
  (constats 1 ou 2) ne perd donc ni son curseur, ni son compteur
  d'itérations, ni son statut — le défaut est de visibilité et
  d'ordonnancement, pas de perte de données.
- Les fichiers ordinaires de `tasks/` (un `README.md`, un `.gitignore`) et les
  dossiers sans `task.json` sont écartés sans bruit, ce qui est le
  comportement voulu et documenté (`task.ts:163`).
- `loadTasks` n'a aucun test : `task.test.ts` ne couvre que `resolveEnv` et la
  résolution d'`env` de `loadTask`. Les trois branches ci-dessus
  (`isDirectory`, `exists`, `catch` du `readdir`) ne sont exercées par rien.
