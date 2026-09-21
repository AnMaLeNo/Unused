# 009 — Routes streamées `docker build` / `docker check`

**Fichiers examinés** : `src/api.ts:44-48,97-125`, `src/client.ts:55-76`,
`src/cli.ts:163-181`, `src/dockerCheck.ts` (entier), `src/docker.ts:28-60,82-93,130-159,250-254`,
`src/daemon.ts:284-326,397-418` (recherche d'une garde plage/itération),
`src/config.ts:20-28`, `README.md:43-45`
**Verdict** : 4 constats (2 sûrs, 2 probables)

Ni `node` ni `docker` ne sont installés dans ce conteneur : tout ce qui suit est
établi par lecture, sans exécution.

## `unused docker build` et `unused docker check` sortent en 0 quand ils échouent

**Gravité** : sûr
**Où** : `src/api.ts:44-48`, `src/api.ts:97-111`, `src/api.ts:114-118`, `src/client.ts:67-71`, `src/cli.ts:165-181`

Les deux routes écrivent leurs en-têtes *avant* de travailler :

```ts
// api.ts:45-48
function streamText(res: http.ServerResponse): (line: string) => void {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "transfer-encoding": "chunked" });
  return (line) => res.write(line + "\n");
}

// api.ts:97-111
if (route === "POST /docker/build") {
  const print = streamText(res);          // ← 200 déjà parti
  await buildBase(cfg, print);            // ← peut lever
  return res.end();
}
if (route === "POST /docker/check") {
  const print = streamText(res);
  try { await dockerCheck(cfg, { rebuild: … }, print); }
  catch (err) { print(`ERREUR ${(err as Error).message}`); }   // ← l'échec devient du corps
  return res.end();
}
```

Un échec de `buildBase` tombe dans le `catch` global, qui voit
`res.headersSent` et se contente lui aussi d'écrire une ligne dans le corps
(`api.ts:115-118`). Le statut reste 200 dans les deux cas. Côté client :

```ts
// client.ts:67-71
res.on("end", () => {
  if (buf) onLine(buf);
  if ((res.statusCode ?? 500) >= 300) return reject(new ApiError(…));
  resolve();                                   // ← 200 ⇒ succès
});
```

`stream()` résout, l'action commander résout, `program.parseAsync()` ne rejette
pas, et `cli.ts:178-181` n'est jamais appelé : **code de sortie 0**. Pire, la
ligne `ERREUR …` part sur *stdout* (`stream(await sock(), …, console.log)`,
`cli.ts:168` et `175`), pas sur stderr.

Scénario concret : la machine n'a plus de réseau, donc le
`curl -fsSL https://claude.ai/install.sh` du `docker/Dockerfile` échoue.

```
$ unused docker check --rebuild >/dev/null; echo $?
0
```

Rien à l'écran, rien sur stderr, sortie 0 — alors que la vérification s'est
arrêtée à la deuxième étape. Même chose pour `unused docker build 2>/dev/null`.
Un `unused docker check || alerte` en cron ou en CI n'alerte jamais ; un
`unused docker build && unused start --for 8h` enchaîne sur un `start` qui
échouera plus loin (`daemon.ts:291-293`) avec un message sans rapport
(« image de base absente »). C'est exactement l'inverse de ce que le README
promet de `check` (« vérifie tout le cycle Docker ») : sa valeur tient dans son
verdict, et le verdict est toujours « tout va bien ».

## Deux `docker check` qui se chevauchent se détruisent mutuellement et accusent Docker

**Gravité** : sûr
**Où** : `src/api.ts:103-111`, `src/dockerCheck.ts:20,49-53,105-111`

`dockerCheck` travaille sur des noms fixes — image `unused-task-docker-check-internal`,
répertoire `<dataDir>/docker-check-internal-exchange` — et commence par faire
table rase :

```ts
// dockerCheck.ts:49-53
const exchangeDir = path.join(cfg.dataDir, `${CHECK_TASK}-exchange`);
await removeTaskImages(CHECK_TASK);
await rm(exchangeDir, { recursive: true, force: true });
await mkdir(exchangeDir, { recursive: true });
await writeFile(path.join(exchangeDir, "ping"), "pong\n");
```

Rien ne sérialise ces exécutions : le serveur HTTP traite les requêtes en
parallèle, la route n'acquiert aucun verrou et ne consulte pas le démon (à
comparer aux commandes d'état, qui lèvent une `ConflictError` —
`daemon.ts:285`, `daemon.ts:399`). Interleaving concret, avec A en cours et B
lancé quelques secondes plus tard :

1. A : ligne 50 nettoie, itération 1 (r1 part bien de `unused-base`), `commitTask`
   crée `unused-task-docker-check-internal:latest`.
2. B : ligne 50 **supprime le `:latest` que A vient de commiter**, ligne 51
   efface `exchangeDir` (le même répertoire que A a monté), ligne 53 le recrée.
3. A : étape « Itération 2 » — `resolveTaskImage` ne trouve plus `:latest` et
   repart de `unused-base`, donc `/work/marker` n'existe pas :

   ```
   ERREUR lecture de /work/marker : attendu "persisted", obtenu code 1, stdout "", stderr "cat: /work/marker: No such file or directory"
   ```

4. A : son `finally` (lignes 105-111) supprime images, containers et
   `exchangeDir` **sous B**, qui échoue à son tour (« lecture de /exchange/ping :
   attendu "pong" »).

Résultat : deux rapports qui accusent la mécanique Docker de l'application alors
que Docker va très bien — et, avec le constat précédent, deux sorties en 0.

Le chemin n'a rien d'exotique pour un utilisateur seul : rien côté démon ne
s'abonne à la fermeture de la connexion (`api.ts:103-111` n'installe ni
`req.on("close")` ni `AbortSignal`, et `dockerCheck` n'en accepte pas). Un
`Ctrl-C` sur `unused docker check --rebuild` (le build de base peut durer de
longues minutes sur un Pi) rend la main à l'utilisateur mais laisse la
vérification tourner jusqu'au bout côté démon ; le `unused docker check` relancé
dans la foulée déclenche précisément l'interleaving ci-dessus.

## `docker check` pendant une plage n'est bloqué par rien

**Gravité** : probable
**Où** : `src/api.ts:97-111`, `src/dockerCheck.ts:42-47`

Aucune des deux routes ne regarde l'état du démon. `unused docker check --rebuild`
pendant une plage active reconstruit `cfg.docker.baseImage` (`dockerCheck.ts:43-46`)
et enchaîne cinq `docker run`, un `commit`, un `export|import` de toute l'image,
en concurrence directe avec l'itération en cours qui, elle, finira par un
`commitTask` → `flattenTask` (`docker.ts:166-180`). Sur la machine visée (un Pi,
cf. `README.md`), la contention disque/CPU n'est pas anodine : un échec du
`commit` ou du `flatten` de la tâche est compté en échec d'itération et, à
`maxConsecutiveFailures` (défaut 3, `config.ts:38`), la tâche sort de la file.

Ce que j'ai pu établir précisément : toutes les commandes Docker de `dockerCheck`
sont bornées à `CHECK_TASK` (`rmi` sur `unused-task-docker-check-internal`,
`image prune`/`container prune` avec `--filter label=unused.task=docker-check-internal`,
`docker.ts:183-185,250-254`), et son `exchangeDir` vit sous `dataDir`, jamais
sous `tasksDir/<tâche>/exchange` (`task.ts:142-143`). La vérification ne corrompt
donc pas l'état d'une tâche réelle — d'où « probable » et non « sûr » : le risque
est la concurrence de charge et le retag de l'image de base sous une plage, pas
l'écrasement d'images. Reste qu'une commande présentée comme un diagnostic
inoffensif peut être lancée à tout moment sans le moindre garde-fou.

## Le nettoyage du check annonce sa réussite sans jamais la vérifier

**Gravité** : probable
**Où** : `src/dockerCheck.ts:105-111`, `src/docker.ts:250-254`, `src/docker.ts:28-60`

```ts
} finally {
  step("Nettoyage");
  await removeTaskImages(CHECK_TASK);
  await docker(["container", "prune", "-f", "--filter", `label=unused.task=${CHECK_TASK}`]);
  await rm(exchangeDir, { recursive: true, force: true });
  ok(`images et containers de ${CHECK_TASK} supprimés`);
}
```

`docker()` ne lève pas sur code ≠ 0 (`docker.ts:27-28`, commentaire explicite) et
`removeTaskImages` ignore le résultat de `rmi -f`. Si le `rmi` échoue — image
encore référencée par un container d'une exécution concurrente (constat
précédent), démon Docker qui vient de tomber, erreur de stockage — la ligne
`✔ images et containers de docker-check-internal supprimés` s'affiche quand
même, et rien dans la sortie ne distingue « nettoyé » de « il reste une image de
plusieurs Go sur le disque ». C'est le même mécanisme que le premier constat du
rapport 006 (`reset` qui annonce « image supprimée »), ici sur un autre site.

## Ce qui a été vérifié et tient

- `streamText` pose `transfer-encoding: chunked` à la main : Node reconnaît
  l'en-tête dans `_storeHeader` et encode bien en chunks, la réponse n'est pas
  malformée.
- Le découpage en lignes de `client.ts:61-66` et de `buildBase`
  (`docker.ts:83-92`) est correct des deux côtés : reste bufferisé jusqu'au `\n`,
  résidu vidé à la fin (`client.ts:68`, `docker.ts:92`).
- Écriture sur une réponse déjà fermée (client parti) : la route continue à
  appeler `print`, mais la réponse étant détruite, `OutgoingMessage.write` passe
  l'erreur au callback par défaut sans émettre `'error'` — le démon ne devrait
  donc pas tomber. Non exécuté faute de `node` ici ; à confirmer si quelqu'un a
  un runtime sous la main.
- Un statut ≠ 2xx sur une route streamée n'est possible que sur un chemin
  inconnu (404, `api.ts:113`) puisque `streamText` est la première instruction
  des deux routes. Dans ce cas `client.ts:68-69` imprime le corps JSON
  `{"error":…}` comme s'il s'agissait d'une ligne de build *puis* rejette avec ce
  même JSON en message : sortie redondante, mais le code de sortie (1) est juste.
- `probe`/`listen` (`api.ts:127-155`) et le routage JSON n'entrent pas dans cet
  aspect et n'ont pas été creusés.
- Aucun test ne couvre `api.ts`, `client.ts` ni `dockerCheck.ts` : il n'existe
  pas de `src/api.test.ts`.
