# Écrire et créer une tâche

Une tâche vit dans `tasks/<nom>/` (voir [le modèle de tâche](modele-de-tache.md)
pour le format de `task.json`). `src/scaffold.ts` fournit le point de départ :
la structure de dossier minimale, générée à la commande `unused tasks new`,
que l'auteur adapte ensuite à la main.

## `unused tasks new <task>`

Côté CLI (`src/cli.ts`), la commande appelle simplement la route HTTP
`POST /tasks` du démon :

```ts
tasks
  .command("new <task>")
  .description("crée le squelette d'une tâche (task.json inactif, README, skills setup et work)")
  .action(async (name: string) => {
    const r = await call<{ dir: string }>(await sock(), "POST", "/tasks", { name });
    console.log(`${r.dir} créé — adapte task.json et les skills, puis \`unused tasks activate ${name}\``);
  });
```

qui, dans `src/api.ts`, délègue à `scaffoldTask` :

```ts
if (route === "POST /tasks") {
  const body = await readJson<{ name?: unknown }>(req);
  if (typeof body.name !== "string") throw new HttpError(400, "champ `name` attendu");
  try {
    return sendJson(res, 200, { dir: await scaffoldTask(cfg.tasksDir, body.name) });
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
}
```

## Ce que `scaffoldTask` écrit

`scaffoldTask(tasksDir, name)` (`src/scaffold.ts`) refuse un nom qui ne
respecte pas `TASK_NAME_RE` (même contrainte que le nom de dossier —
il sert aussi de nom d'image Docker) et un dossier déjà existant, puis crée :

```ts
export async function scaffoldTask(tasksDir: string, name: string): Promise<string> {
  if (!TASK_NAME_RE.test(name)) {
    throw new Error(`nom de tâche invalide "${name}" : minuscules, chiffres, et un seul . _ ou - entre deux groupes`);
  }
  const dir = path.join(tasksDir, name);
  if (await stat(dir).then(() => true, () => false)) throw new Error(`${dir} existe déjà`);
  await mkdir(path.join(dir, "skills", "setup"), { recursive: true });
  await mkdir(path.join(dir, "skills", "work"), { recursive: true });
  await mkdir(path.join(dir, "exchange"), { recursive: true });
  await writeFile(path.join(dir, TASK_FILE), JSON.stringify(TASK_JSON, null, 2) + "\n");
  await writeFile(path.join(dir, "README.md"), README.replaceAll("<name>", name));
  await writeFile(path.join(dir, "skills", "setup", "SKILL.md"), SETUP);
  await writeFile(path.join(dir, "skills", "work", "SKILL.md"), WORK);
  return dir;
}
```

Résultat : `tasks/<name>/`

- `task.json` — `active: false` (la tâche n'entre pas dans le round-robin tant
  qu'elle n'a pas été relue), un graphe à deux nœuds `setup → work → work`
  (`work` boucle sur lui-même), et `params: { repo: "owner/projet" }` à
  adapter.
- `README.md` — la doc de la tâche elle-même : explique `task.json` (`active`,
  `start`, `params`, `env`, `nodes`) et rappelle la règle de fonctionnement
  d'un skill (rejoué tant qu'il n'a pas créé `/exchange/DONE`, container
  conservé d'une itération à l'autre, échec = retour à l'état d'avant).
- `skills/setup/SKILL.md` et `skills/work/SKILL.md` — deux skills prêts à
  l'emploi, décrits ci-dessous.
- `exchange/` — le dossier monté dans le container à chaque itération (voir
  [le container comme état persistant](container-etat-persistant.md)) ; vide
  au départ.

## Les deux skills générés

**`setup`** ne s'exécute qu'une fois, au premier nœud. Son rôle : préparer le
container (cloner `repo`, installer ce qu'il faut, configurer git) et écrire
`/work/PLAN.md`, la liste à cocher que les itérations suivantes consommeront
une case à la fois :

```
1. Installe ce qui manque (apt, outils) et clone le dépôt `repo` dans /work/repo.
   Pour un dépôt privé, un token est disponible dans la variable d'environnement
   GH_TOKEN si la tâche le transmet.
2. Configure git (nom et e-mail sont dans l'environnement si la tâche les fournit).
3. Établis le plan de travail : un fichier /work/PLAN.md, une liste à cocher des
   unités de travail que les sessions suivantes traiteront une par une.

Ne fais rien d'autre. Ne crée pas /exchange/DONE : la tâche ne fait que commencer.
```

**`work`** est le nœud qui boucle : chaque itération prend la première case
non cochée de `/work/PLAN.md`, la réalise, la coche, journalise en une ligne
dans `/work/JOURNAL.md`, commite si pertinent, et rend la main — sauf s'il ne
reste plus de case, auquel cas elle crée `/exchange/DONE` pour arrêter la
tâche :

```
1. Lis /work/PLAN.md et prends la première case non cochée.
2. Réalise cette seule unité. Reste court : si tu vois que c'est trop gros,
   découpe-la dans le plan et fais la première partie.
3. Coche la case, note en une ligne ce que tu as fait dans /work/JOURNAL.md.
4. Commite dans le dépôt si c'est pertinent.

S'il ne reste aucune case à cocher, crée le fichier /exchange/DONE : la tâche
est terminée et ne sera plus relancée. Sinon, rends simplement la main : une
autre session prendra la suite.
```

## Après la génération

Le README généré le rappelle : `task.json` (repo, `env`, éventuellement plus
de nœuds) et les deux `SKILL.md` sont à adapter au cas réel — le squelette
n'est qu'un point de départ générique. Une fois prêt, `unused tasks activate
<name>` (`POST /tasks/:name/active`) bascule `active` à `true` et la tâche
entre dans le round-robin du [scheduler](scheduler.md).
