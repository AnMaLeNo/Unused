# `dockerCheck` : vérifier le cycle Docker sans consommer de quota

`src/dockerCheck.ts` fait rejouer, sur une fausse tâche jetable, tout le
cycle de vie qu'une vraie tâche traverse à chaque itération — lancer un
container, y lire/écrire, le commiter, repartir du commit, jeter une
itération ratée, aplatir la pile de couches — mais avec des commandes shell
triviales (`cat`, `echo`) à la place d'une session `claude -p`. Ça permet de
vérifier que Docker est correctement installé et configuré sur une machine
donnée (droits, storage driver, image de base) **avant** de laisser le
démon tourner pour de vrai et brûler du quota Claude sur un problème
d'infrastructure. Pour le détail de chaque primitive Docker citée ici
(`runInTask`, `commitTask`, `flattenTask`...), voir
[Le container comme état persistant](container-etat-persistant.md).

## Comment le lancer

```
unused docker check           # vérifie sans reconstruire l'image
unused docker check --rebuild # force la reconstruction de l'image de base d'abord
```

(`src/cli.ts:170-176`). Côté démon, la commande passe par la route
`POST /docker/check` (`?rebuild=1` pour l'option), qui streame la sortie
ligne par ligne (voir [L'API HTTP et la CLI cliente](api-et-cli.md)) :

```ts
// src/api.ts:103-111
if (route === "POST /docker/check") {
  const print = streamText(res);
  try {
    await dockerCheck(cfg, { rebuild: url.searchParams.get("rebuild") === "1" }, print);
  } catch (err) {
    print(`ERREUR ${(err as Error).message}`);
  }
  return res.end();
}
```

## La tâche jetable

Tout tourne sous un nom de tâche fixe, `CHECK_TASK = "docker-check-internal"`
(`src/dockerCheck.ts:20`) : un nom valide pour une image Docker mais
improbable pour une vraie tâche, choisi pour qu'il n'entre jamais en
collision avec le travail réel du démon. Avant de commencer, `dockerCheck()`
nettoie tout résidu d'un run précédent (`removeTaskImages(CHECK_TASK)`,
suppression du dossier d'échange) et prépare un dossier `/exchange` de test
contenant un seul fichier, `ping` → `pong\n` (`src/dockerCheck.ts:49-53`), qui
sert à vérifier que le montage `/exchange` fonctionne.

## Les étapes vérifiées

Chaque étape imprime son résultat via un callback `print` (le `Print` passé
en troisième argument), avec `step()` pour un titre et `ok()` pour une ligne
de succès — c'est ce flux de lignes que la CLI affiche au fur et à mesure :

1. **Docker et l'image de base** — `dockerVersion()` confirme que le
   client `docker` répond ; l'image `cfg.docker.baseImage` est construite
   si absente ou si `--rebuild` est passé (`buildBase()`), puis son nombre
   de couches est affiché.

2. **Claude Code dans l'image de base** — lance `claude --version` dans un
   container tout neuf, vérifie le code de sortie, jette le container
   (`discardContainer`). Confirme que le binaire `claude` est bien présent
   et exécutable dans l'image, en root, avec `IS_SANDBOX=1`.

3. **Itération 1 : lecture de `/exchange`, écriture, commit.**

   ```ts
   // src/dockerCheck.ts:63-70
   const r1 = await runInTask(cfg, CHECK_TASK, {
     cmd: ["sh", "-c", "cat /exchange/ping && echo persisted > /work/marker"],
     exchangeDir,
   });
   expectOutput(r1, "pong", "lecture de /exchange/ping");
   if (r1.image !== cfg.docker.baseImage) throw new Error(`image de départ inattendue : ${r1.image}`);
   await commitTask(cfg, CHECK_TASK, r1.container);
   ```

   Vérifie que `/exchange/ping` est bien monté et lisible (`cat` retourne
   `pong`), que le container est bien parti de l'image de base (aucune
   tâche `docker-check-internal` n'existe encore), et que le commit
   réussit.

4. **Itération 2 : l'état persiste, la rotation `:prev` a lieu.** Un
   nouveau container repart cette fois de l'image commitée à l'étape
   précédente (`taskImage(CHECK_TASK):latest`) ; il lit `/work/marker` et
   doit y retrouver `persisted`, preuve que `docker commit` a bien
   conservé le filesystem. Un second commit déclenche la rotation, et le
   test vérifie que `:prev` existe désormais.

5. **Itération jetée : l'état ne bouge pas.** Un container écrit
   `oops` dans `/work/marker` puis est jeté avec `discardContainer()` au
   lieu d'être commité. Un container suivant relit `/work/marker` : il
   doit encore valoir `persisted`, pas `oops` — la preuve que jeter un
   container (au lieu de le commiter) laisse bien l'image inchangée,
   exactement comme `iterate()` le fait pour une itération en échec.

6. **Aplatissement.** `flattenTask(CHECK_TASK)` est appelé explicitement
   (indépendamment du seuil `flattenAfterLayers`), puis un `layerCount()`
   doit retourner `1`. Un dernier container vérifie que tout ce qui compte
   a survécu à l'export/import : le marqueur (`persisted`), la variable
   d'environnement `IS_SANDBOX`, le `WORKDIR` (`pwd` → `/work`), et que
   `claude --version` fonctionne toujours (`PATH` préservé).

Chaque étape utilise `expectOutput()` (`src/dockerCheck.ts:24-30`), un petit
assert qui compare le code de sortie et le stdout exact attendus, et lève
une `Error` détaillée (code, stdout, stderr) au premier écart — le check
s'arrête dès la première anomalie plutôt que d'essayer de continuer.

## Nettoyage garanti

Toutes les étapes après la préparation du dossier d'échange sont dans un
`try`/`finally` (`src/dockerCheck.ts:55-111`) : que le check réussisse,
échoue sur une assertion, ou lève une erreur Docker, le bloc `finally`
supprime systématiquement les images de `docker-check-internal`
(`removeTaskImages`), les containers restants (`docker container prune`
filtré sur le label `unused.task=docker-check-internal`), et le dossier
d'échange temporaire. Le check ne laisse donc jamais de residu, même après
un échec.
