# Le container comme état persistant

Chaque tâche vit dans une image Docker qui *est* son état : le dépôt cloné,
les modifications commitées d'itération en itération, tout ce qu'une session
`claude -p` a laissé sur le disque. Il n'y a pas de volume persistant pour le
code de la tâche — c'est l'image elle-même qui sert de mémoire, à la manière
d'un commit git. `src/docker.ts` porte cette logique : lancer un container à
partir du dernier état connu, le commiter en cas de succès, le jeter sinon,
et empêcher la pile de couches de grossir indéfiniment.

## `docker()` : le socle

Tout passe par une seule fonction bas niveau, `docker(args, opts)`
(`src/docker.ts:28`), qui `spawn` le binaire `docker` et capture stdout/stderr
sans jamais lever sur un code de sortie non nul — c'est à l'appelant de
décider si l'échec est normal (ex. `image inspect` sur une image absente) ou
fatal. `mustSucceed()` (`src/docker.ts:62`) est le raccourci pour le second
cas : il lève une `DockerError` avec stderr si le code n'est pas 0.

Un détail de sécurité : les variables d'environnement du container (comme le
token Claude) passent par `-e NOM` sans valeur sur la ligne de commande, la
valeur étant héritée de l'environnement du process `docker` lui-même
(`src/docker.ts:111-114`). Ça évite qu'un token traîne en clair dans une sortie
`ps`.

## Résoudre l'image de départ

```ts
// src/docker.ts:102
export async function resolveTaskImage(cfg: Config, taskName: string): Promise<string> {
  const latest = `${taskImage(taskName)}:latest`;
  return (await imageExists(latest)) ? latest : cfg.docker.baseImage;
}
```

`taskImage(taskName)` retourne `unused-task-<taskName>`. Si cette image existe
en tag `:latest`, c'est elle qui sert de point de départ (le dernier état
commité de la tâche) ; sinon on repart de l'image de base construite par
`buildBase()` à partir de `docker/Dockerfile`. `runInTask()`
(`src/docker.ts:130`) s'en sert pour lancer un container neuf, nommé
`unused-<taskName>-<timestamp>`, étiqueté `unused.task=<taskName>` et monté
avec le dossier d'échange (`/exchange`) et les skills du graphe en lecture
seule. Ce container n'est **jamais** supprimé par `runInTask()` lui-même : le
commentaire au-dessus de la fonction est explicite — c'est à l'appelant de le
commiter ou de le jeter.

C'est `iterate()` (`src/iterate.ts`) qui prend cette décision, selon l'issue
de la session :

```ts
// src/iterate.ts:167-186
if (outcome.kind === "completed") {
  try {
    await deps.commitTask(cfg, task.name, r.container);
    committed = true;
  } catch (err) {
    // ... l'état ne peut pas être conservé : itération réputée n'avoir jamais eu lieu
  }
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

## `commitTask()` : commit, rotation, aplatissement

```ts
// src/docker.ts:166
export async function commitTask(cfg: Config, taskName: string, container: string): Promise<void> {
  const name = taskImage(taskName);
  if (await imageExists(`${name}:latest`)) {
    await mustSucceed(["tag", `${name}:latest`, `${name}:prev`], "rotation de l'image");
  }
  await mustSucceed(
    ["commit", "--change", `LABEL ${LABEL}=${taskName}`, container, `${name}:latest`],
    "commit du container",
  );
  await docker(["rm", container]);
  if ((await layerCount(`${name}:latest`)) > cfg.docker.flattenAfterLayers) {
    await flattenTask(taskName);
  }
  await pruneTask(taskName);
}
```

Quatre étapes, dans l'ordre :

1. **Rotation** — si un `:latest` existe déjà, il est retaggé `:prev` avant
   d'être remplacé. C'est la seule sauvegarde : un `:prev`, pas un historique
   complet. Ça permet de revenir en arrière d'une itération en cas de
   commit malheureux, sans garder toute la pile des tentatives passées.
2. **Commit** — le container devient le nouveau `:latest`, avec le label
   `unused.task=<taskName>` réappliqué (`docker commit` ne le propage pas
   automatiquement depuis l'image de base).
3. **Suppression du container** — une fois commité, le container lui-même est
   jetable ; son contenu vit désormais dans l'image.
4. **Aplatissement conditionnel** — `docker commit` empile une nouvelle couche
   à chaque appel. Si le nombre de couches dépasse
   `cfg.docker.flattenAfterLayers` (30 par défaut, `src/config.ts:27`),
   `flattenTask()` est appelé pour repartir d'une image à une seule couche.

Enfin `pruneTask()` (`src/docker.ts:183`) supprime les images sans tag de la
tâche (anciens `:prev` écrasés, chaînes intermédiaires d'aplatissement) via
`docker image prune` filtré sur le label `unused.task=<taskName>`.

## `flattenTask()` : repartir à plat

Sans aplatissement, chaque itération commitée ajoute une couche Docker, et la
pile finirait par devenir ingérable (limites du storage driver, lenteur). Le
principe est simple : exporter le filesystem complet du container en un seul
tar, puis le réimporter comme image à une seule couche.

```ts
// src/docker.ts:214
export async function flattenTask(taskName: string): Promise<void> {
  const latest = `${taskImage(taskName)}:latest`;
  const inspect = await mustSucceed(["image", "inspect", "--format", "{{json .Config}}", latest], "inspect");
  const changes = importChanges(JSON.parse(inspect.stdout) as ImageConfig);

  const tmp = `unused-flatten-${taskName}-${Date.now()}`;
  await mustSucceed(["create", "--name", tmp, latest], "création du container d'export");
  try {
    await pipeExportImport(tmp, latest, changes);
  } finally {
    await docker(["rm", tmp]);
  }
}
```

Le piège de `docker export` / `docker import` : ça ne préserve que le
filesystem, pas la config de l'image (`ENV`, `WORKDIR`, `ENTRYPOINT`, `CMD`,
labels). `importChanges()` (`src/docker.ts:199`) reconstruit ces instructions
à partir de la config de l'image aplatie, sous forme d'arguments `-c` pour
`docker import`, de façon à ce que l'image reconstruite se comporte
exactement comme l'originale. `pipeExportImport()` (`src/docker.ts:228`)
fait le gros du travail : il crée un container temporaire (jamais démarré,
juste `docker create`) depuis `:latest`, pipe sa sortie `docker export`
directement dans l'entrée de `docker import -c ... - <image>`, et écrase
`:latest` avec le résultat à une couche.

## Nettoyage d'une tâche

`removeTaskImages()` (`src/docker.ts:250`) supprime `:latest` et `:prev` puis
prune les images orphelines restantes — c'est ce que le démon appelle
(`src/daemon.ts:404`) quand une tâche est terminée ou retirée, pour ne pas
laisser traîner son état Docker.

## Où c'est exercé

`src/dockerCheck.ts` fait tourner ce cycle complet (run → commit → run à
nouveau pour vérifier que l'état a persisté → discard d'un run raté →
nettoyage final) sans consommer de quota Claude, en lançant des commandes
shell triviales (`cat`, `echo`) à la place d'une vraie session. C'est le
moyen de vérifier que Docker fonctionne correctement sur une machine donnée
avant de laisser le démon tourner pour de vrai.
