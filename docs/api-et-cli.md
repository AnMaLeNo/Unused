# L'API HTTP et la CLI cliente

Le démon expose son état et ses actions via une petite API HTTP/JSON sur un
socket Unix ; la commande `unused` (`src/cli.ts`) est aujourd'hui la seule
cliente de cette API, mais rien n'empêche un autre front de parler aux mêmes
routes plus tard (`src/api.ts:52`).

## Le socket

Pas de port TCP : le démon écoute sur un fichier socket Unix,
`<dataDir>/unused.sock` (`socketPath()`, `src/api.ts:14-16`). Deux protections
à l'ouverture (`listen()`, `src/api.ts:144-155`) :

- si un démon répond déjà sur ce socket (`probe()` interroge `GET /status`),
  `listen()` refuse de démarrer plutôt que d'écraser un démon vivant ;
- sinon, un socket périmé laissé par un démon tué est supprimé
  (`unlink(sock).catch(() => {})`) avant de réécouter, et les permissions sont
  resserrées à `0o660` (`chmodSync`).

La CLI trouve ce socket dans cet ordre (`sock()`, `src/cli.ts:26-31`) :
1. l'option `--socket`,
2. la variable d'environnement `UNUSED_SOCKET`,
3. sinon déduit de la config (`--config`, défaut `CONFIG_FILE`) via
   `socketPath()`.

## Les routes

`createApi(cfg, daemon)` (`src/api.ts:54`) construit un `http.Server` qui
route à la main sur `` `${method} ${pathname}` `` :

| Route | Rôle |
|---|---|
| `GET /status` | `daemon.status()` — état complet (voir [le démon](le-demon.md)) |
| `POST /window` | `{ for: "8h" }` → démarre une plage manuelle (`daemon.startWindow`) |
| `DELETE /window[?now=1]` | arrête la plage courante, tout de suite ou après l'itération en cours |
| `POST /tasks` | `{ name }` → `scaffoldTask()` (`src/scaffold.ts`) |
| `GET /tasks` | liste des tâches et de leurs erreurs de chargement |
| `POST /tasks/:name/reset` | `daemon.resetTask(name)` |
| `POST /tasks/:name/active` | `{ active: boolean }` → `daemon.setActive()` |
| `POST /docker/build` | reconstruit l'image de base, réponse **streamée** |
| `POST /docker/check` | `dockerCheck()` de bout en bout, réponse **streamée** |

Les corps de requête sont lus intégralement puis parsés en JSON
(`readJson()`, `src/api.ts:27-37`) ; un corps vide donne `{}`, un JSON
invalide lève une `HttpError(400)`.

## Les deux formats de réponse

La plupart des routes répondent en une fois avec `sendJson()`
(`src/api.ts:39-42`) : `content-type: application/json`, corps sérialisé.

`POST /docker/build` et `POST /docker/check` répondent différemment, car ce
sont des opérations longues dont on veut voir la progression :
`streamText()` (`src/api.ts:44-48`) ouvre une réponse
`text/plain; charset=utf-8` en *chunked transfer encoding* et retourne une
fonction `(line: string) => void` qui écrit une ligne à la fois. Le handler
passe cette fonction comme callback de progression à `buildBase()` ou
`dockerCheck()` :

```ts
if (route === "POST /docker/build") {
  const print = streamText(res);
  await buildBase(cfg, print);
  return res.end();
}
```

Pour `docker/check`, une erreur survenant après le premier octet écrit ne
peut plus changer le code de statut HTTP (déjà envoyé à 200) : elle est donc
injectée comme une ligne de plus, préfixée `ERREUR ` (`src/api.ts:106-109`),
et c'est au lecteur du flux de la reconnaître.

## Gestion des erreurs

Toute erreur levée dans un handler remonte au `try/catch` englobant
(`src/api.ts:114-123`), qui choisit le code HTTP selon le type :

```ts
const status =
  err instanceof HttpError ? err.status
  : err instanceof ConflictError ? 409
  : err instanceof NotFoundError ? 404
  : 500;
if (status === 500) console.error(err);
return sendJson(res, status, { error: (err as Error).message });
```

`ConflictError` et `NotFoundError` viennent de `src/daemon.ts` (par exemple
démarrer une plage alors qu'une autre tourne déjà, ou référencer une tâche
inconnue) : l'API n'a pas besoin de les connaître en détail, seulement de les
reconnaître pour mapper le bon code. Si la réponse a déjà commencé (cas du
streaming), impossible de changer le statut : l'erreur est écrite comme ligne
`ERREUR ...` puis la réponse est close.

## Le client (`src/client.ts`)

Deux fonctions bas niveau, utilisées par tous les handlers de `cli.ts` :

- **`call<T>(sock, method, path, body?)`** — un aller-retour JSON classique :
  sérialise `body`, parse la réponse, rejette avec une `ApiError(status,
  message)` si le code est ≥ 300 (message tiré du champ `error` renvoyé par
  l'API).
- **`stream(sock, method, path, onLine)`** — relaie une réponse texte ligne
  par ligne au fur et à mesure qu'elle arrive (bufferise jusqu'au prochain
  `\n`), utilisé pour `docker build`/`docker check`.

Les deux traduisent une erreur réseau (`ECONNREFUSED`/`ENOENT`, démon
éteint) en `DaemonUnreachable` avec un message actionnable
(`unreachable()`, `src/client.ts:13-18`) :

```ts
if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
  return new DaemonUnreachable(
    `le démon n'est pas lancé (socket ${sock}) : \`systemctl start unused\` ou \`unused daemon\``,
  );
}
```

## La CLI (`src/cli.ts`)

Construite avec [Commander](https://github.com/tj/commander.js). Une
commande fait figure à part : `unused daemon` ne parle pas au socket, elle
*est* le démon — elle charge la config (`daemonSetup()`, qui charge aussi un
`.env` local pour le token, sans écraser l'environnement existant), construit
`Daemon`, l'API, appelle `listen()`, puis lance `daemon.run(signal)`. Un
`SIGINT`/`SIGTERM` déclenche un arrêt propre (`ac.abort()`) ; un second signal
force `process.exit(130)`.

Toutes les autres commandes sont de simples clientes qui résolvent le socket
via `sock()` puis appellent `call()` ou `stream()` :

```ts
program
  .command("start")
  .requiredOption("--for <duration>", "durée, ex. 8h, 90m, 1d12h")
  .action(async (opts: { for: string }) => {
    const r = await call<{ until: string }>(await sock(), "POST", "/window", { for: opts.for });
    console.log(`plage démarrée jusqu'à ${r.until}`);
  });
```

Elles couvrent une commande par route : `start`/`stop`/`status`,
`tasks list`/`new`/`reset`/`activate`/`deactivate`, `docker build`/`check`.
`status` met en forme le `DaemonStatus` renvoyé par l'API (plage en cours,
tâches, panne éventuelle) ou l'imprime tel quel avec `--json`.

## Sortie et codes de retour

Le point d'entrée termine par un `.catch()` global
(`src/cli.ts:178-181`) :

```ts
program.parseAsync().catch((err: Error) => {
  console.error(err instanceof DaemonUnreachable || err instanceof ApiError ? err.message : err.message);
  process.exit(err instanceof ApiError && err.status === 409 ? 3 : 1);
});
```

Un conflit (`ApiError` avec `status === 409`, par exemple démarrer une plage
alors qu'une autre est déjà en cours) sort avec le code **3** — distinct des
autres erreurs (code 1) — pour qu'un script appelant puisse distinguer
« refusé proprement » d'un échec quelconque.
