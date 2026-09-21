# 005 — Atomicité du commit et de l'aplatissement

**Fichiers examinés** : `src/docker.ts:156-254` (`layerCount`, `commitTask`, `pruneTask`,
`flattenTask`, `pipeExportImport`, `importChanges`), `src/iterate.ts:148-190`,
`src/graph.ts:64-105` (`applyOutcome`), `src/state.ts:42-84`,
`src/scheduler.ts:104-140`, `src/daemon.ts:190-222`, `src/dockerCheck.ts:62-102`,
`src/docker.test.ts`, `src/iterate.test.ts:148-156`, `docker/Dockerfile`,
`deploy/unused.service`.

**Verdict** : 3 constats (1 sûr, 2 probables)

## `commitTask` n'est pas atomique : l'image avance, le curseur recule

**Gravité** : sûr
**Où** : `src/docker.ts:166-180`, rattrapé (mal) par `src/iterate.ts:170-183`

`commitTask` enchaîne cinq opérations non transactionnelles :

```ts
export async function commitTask(cfg, taskName, container) {
  const name = taskImage(taskName);
  if (await imageExists(`${name}:latest`)) {
    await mustSucceed(["tag", `${name}:latest`, `${name}:prev`], "rotation de l'image");  // 1
  }
  await mustSucceed(["commit", …, container, `${name}:latest`], "commit du container");   // 2  ← :latest avance ICI
  await docker(["rm", container]);                                                        // 3
  if ((await layerCount(`${name}:latest`)) > cfg.docker.flattenAfterLayers) {              // 4  ← peut lever
    await flattenTask(taskName);                                                           // 4' ← peut lever
  }
  await pruneTask(taskName);                                                               // 5
}
```

Dès l'étape 2, `unused-task-<t>:latest` contient le travail du nœud. Les étapes 4
et 4' peuvent encore lever une `DockerError` : `layerCount` passe par `mustSucceed`,
et `flattenTask` en enchaîne trois (`image inspect`, `create`, puis le rejet de
`pipeExportImport`).

Côté appelant, cette `DockerError` est interprétée comme « le commit n'a pas eu
lieu » :

```ts
} catch (err) {
  if (!(err instanceof DockerError)) throw err;
  // Le travail est fait mais l'état ne peut pas être conservé : on ne
  // ment pas au curseur, l'itération est réputée n'avoir jamais eu lieu.
  outcome = { kind: "fatal", reason: "docker", detail: err.message };
  ts.cursor = nodeName;        // ← curseur ramené en arrière
  ts.iterations -= 1;
  ts.status = "running";
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
  applyDecision(state, task, "stop-window");
}
```

Le curseur recule, mais **rien ne fait reculer l'image**. `:prev` existe
précisément pour ça (`docker.ts:163` : « garde l'état précédent sous :prev ») et
n'est relu nulle part : `grep -rn "prev" src/` ne trouve que l'écriture
(`docker.ts:169`), le `rmi` de nettoyage (`docker.ts:252`) et une assertion du
self-test (`dockerCheck.ts:77`). Le rollback est donc à moitié fait.

**Scénario concret.** Configuration livrée : `flattenAfterLayers: 30`
(`unused.config.json:16`). À la 31ᵉ itération d'une tâche, le nœud `analyze`
tourne, se termine en `completed`, `applyOutcome` avance `ts.cursor` de `analyze`
vers `choose` et incrémente `iterations`. `commitTask` rote `:prev`, commite
`:latest` (l'image contient maintenant le rapport 005 écrit et poussé), supprime
le container, constate 31 couches et appelle `flattenTask`. L'aplatissement fait
transiter tout le système de fichiers par `docker export | docker import` ; sur la
cible du projet (un Raspberry Pi, cf. `docker/Dockerfile:12`) un `ENOSPC` à ce
moment est le mode d'échec le plus banal. `pipeExportImport` rejette avec une
`DockerError`, `commitTask` la propage.

État résultant :

| | attendu par le runner | réel |
|---|---|---|
| `state.tasks.t.cursor` | `analyze` | `analyze` |
| `unused-task-t:latest` | état d'avant `analyze` | état d'**après** `analyze` |
| `state.tasks.t.iterations` | N | N |
| log de l'itération | `committed: false`, `decision: stop-window` | idem |

Au redémarrage (`state.window` est conservé en cas de panne fatale,
`scheduler.ts:147`, et `daemon.init` reprend la plage), `resolveTaskImage`
(`docker.ts:102-105`) renvoie `:latest` — l'image avancée — et le runner relance
`analyze` dessus. Le skill repart d'un container où son propre travail est déjà
fait : pour ce dépôt, il relit `tail -n 1 /work/ANALYZED.md`, retrouve la ligne
005 déjà inscrite et **réécrit un second rapport 005** par-dessus le premier, ou
part en erreur. Plus généralement, l'invariant annoncé en tête de `graph.ts:9-13`
(« une itération qui ne se termine pas en `completed` est réputée n'avoir jamais
eu lieu … pour que le rejeu reparte de l'état exact d'avant l'itération ») est
violé exactement dans le cas où le code croit l'appliquer.

Deux correctifs possibles, aucun présent : restaurer `:latest` depuis `:prev`
dans le `catch` (le tag est là, intact), ou sortir l'aplatissement de
`commitTask` pour qu'un échec d'aplatissement n'annule plus un commit réussi —
une pile de couches trop haute n'est pas une raison de jeter le travail.

Le test qui couvre ce chemin (`iterate.test.ts:148`) simule `commitTask` comme un
tout-ou-rien (`commitTask: async () => { throw new DockerError(…) }`) : il vérifie
que le curseur revient à `a`, et ne peut par construction rien dire de l'état de
l'image après un échec partiel.

**Note secondaire sur le même `catch`** : le rollback restaure `cursor`,
`iterations` et `status`, mais pas `ts.consecutiveFailures`, que
`applyOutcome` (`graph.ts:84`) vient de remettre à 0, ni `ts.last`
(`graph.ts:79`) qui reste à `"completed"` alors que l'issue publiée est
`fatal:docker`. `state.json` affiche donc, après la panne, une dernière issue
`completed` sur un nœud que le curseur désigne encore comme à faire.

## `pipeExportImport` déclare l'aplatissement réussi sans savoir si l'export a réussi

**Gravité** : probable
**Où** : `src/docker.ts:239-244`

```ts
let expCode: number | null = null;
exp.on("close", (c) => (expCode = c));
imp.on("close", (c) => {
  if (c === 0 && (expCode === 0 || expCode === null)) resolve();
  else reject(new DockerError(`aplatissement a échoué :\n…`));
});
```

Le verdict est rendu sur le `close` de `docker import` seul. Les deux `close`
sont indépendants et sans ordre garanti : quand celui de `import` arrive en
premier, `expCode` vaut encore `null`, et la condition `expCode === null`
**accepte explicitement ce cas comme un succès**. Autrement dit, le code de sortie
de `docker export` n'est pris en compte que lorsqu'il se trouve être déjà connu ;
il ne l'est jamais de façon fiable, puisque rien n'attend la fermeture de `exp`.

Conséquence : un `docker export` qui meurt en cours de route (container verrouillé,
erreur de lecture du graphe, OOM-killer — le tarball d'une image de tâche pèse
plusieurs Go sur un Pi) ferme son stdout ; `docker import` voit un EOF. S'il
accepte ce flux tronqué et sort à 0, `pipeExportImport` résout, `commitTask`
continue sur `pruneTask` — qui supprime au passage les images sans tag de la
tâche — et `:latest` désigne désormais un système de fichiers amputé, présenté
comme un aplatissement normal. Aucun appelant ne peut détecter la différence :
`flattenTask` ne revérifie rien, et `layerCount` renverra bien 1.

Le correctif est mécanique : attendre les deux `close` avant de trancher, et
traiter `expCode !== 0` comme un échec (rejeter, ce qui laisse `:latest` sur
l'image non aplatie, qui est correcte). Écrire `expCode === null` revient à
inscrire la course dans la condition de succès.

À noter qu'il n'existe aucun test de ce chemin : `docker.test.ts` ne couvre que
`importChanges` et `taskImage`, et le self-test `dockerCheck.ts:92-102` n'exerce
que le cas nominal.

## Un `docker import` qui sort tôt fait tomber le démon par EPIPE non rattrapé

**Gravité** : probable
**Où** : `src/docker.ts:235`

```ts
exp.stdout.pipe(imp.stdin);
…
exp.on("error", reject);
imp.on("error", reject);
```

Les deux handlers `error` posés sont ceux des `ChildProcess` : ils couvrent
l'échec de `spawn` (ENOENT…), pas les erreurs des flux stdio. Or le seul écrivain
ici est `imp.stdin`, et `Readable.pipe()` ne propage pas les erreurs de sa
destination. Si `docker import` se termine avant d'avoir consommé tout le flux —
disque plein côté démon, démon redémarré, instruction `-c` refusée — son stdin est
fermé côté processus tandis que `exp.stdout` continue d'y écrire : `imp.stdin`
émet `EPIPE` (ou `ERR_STREAM_DESTROYED`), sans aucun écouteur `error`.

Un `'error'` sans écouteur sur un `EventEmitter` est relancé en exception non
rattrapée, et le projet n'installe aucun `process.on("uncaughtException")`
(`grep -rn "uncaughtException\|unhandledRejection" src/` ne renvoie rien ;
`cli.ts:56-57` ne pose que SIGINT/SIGTERM). Le processus `unused` meurt donc
entièrement — pas seulement la plage.

**Scénario concret et son coût.** Itération N en `completed`, `docker commit`
réussi (`:latest` avance), aplatissement déclenché, `docker import` échoue tôt
faute de place. Le démon meurt avant la ligne `iterate.ts:189`
(`await saveState(…)`) et avant `writeIterationLog` (`iterate.ts:217`). Il ne
reste donc :

- ni sauvegarde d'état : `state.json` contient toujours le curseur d'**avant**
  l'itération ;
- ni journal : aucune trace de l'itération qui vient pourtant de tourner et de
  coûter son quota ;
- mais une image `:latest` qui, elle, a avancé.

`deploy/unused.service` a `Restart=always` / `RestartSec=5` : systemd relance le
démon cinq secondes plus tard, il reprend la plage enregistrée et rejoue le même
nœud sur l'image déjà avancée — même divergence que le premier constat, en pire,
puisque cette fois il n'y a même pas de log pour la diagnostiquer. Le cycle peut
se répéter tant que le disque reste plein : chaque tour consomme une session
Claude, avance l'image d'un cran, et meurt au même endroit.

Un `imp.stdin.on("error", …)` (ou un `pipeline()` de `node:stream`) suffirait à
transformer la panne en rejet de la promesse, que `iterate.ts:172` sait déjà
traiter.

## Ce qui a été vérifié et tient

- `importChanges` (`docker.ts:199-211`) reconstruit `ENV`, `WORKDIR`,
  `ENTRYPOINT`, `CMD` et `LABEL`, et le `Dockerfile` de base ne pose ni `USER`,
  ni `VOLUME`, ni `HEALTHCHECK`, ni `EXPOSE` : rien de ce qu'il omet n'est
  utilisé par l'image de ce projet, et le `LABEL unused.task` est bien réémis,
  donc l'image aplatie reste visible pour `pruneTask`.
- La rotation `:prev` supporte une répétition sans perte : deux échecs de commit
  successifs re-taguent `:prev` sur la même image, la génération devenue sans tag
  est récupérée par `pruneTask`.
- `pruneTask` et `docker rm` passent par `docker()`, qui ne lève pas : ces deux
  dernières étapes de `commitTask` ne peuvent pas invalider un commit réussi.
- `ensureTaskState` renvoie bien la référence stockée dans `state.tasks`, donc les
  mutations du rollback de `iterate.ts` portent réellement sur l'état sauvegardé —
  le problème est ce qu'il ne restaure pas, pas un effet perdu.
- `saveState` (`state.ts:78-83`) écrit par fichier temporaire puis `rename` :
  l'écriture de `state.json` est, elle, atomique.
- Chemin nominal de `flattenTask` vérifié de bout en bout par
  `dockerCheck.ts:92-102`, y compris la conservation d'ENV/WORKDIR/PATH et le
  retour à une seule couche.
