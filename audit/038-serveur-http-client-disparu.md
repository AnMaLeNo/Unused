# 038 — Serveur HTTP : client disparu pendant une route streamée, corps non borné, nom percent-encodé invalide

**Fichiers examinés** : `src/api.ts` en entier (27-37 `readJson`, 39-42
`sendJson`, 44-48 `streamText`, 54-125 `createApi`, 128-155 `probe`/`listen`),
`src/client.ts:21-53` (`call`) et `src/client.ts:56-76` (`stream`),
`src/cli.ts:67-75` (`start`), `src/cli.ts:134-162` (`tasks new`/`reset`/
`activate`), `src/cli.ts:163-181` (`docker build`/`check`, handler d'erreur
global), `src/duration.ts:4-17`, `src/scaffold.ts:89-103`, `src/task.ts:10`,
`src/daemon.ts:389-418` (`findTask`, `resetTask`, `setActive`),
`src/docker.ts:82-93` (`buildBase`), `src/dockerCheck.ts:36-60`.

**Verdict** : 4 constats (3 sûrs, 1 probable). L'hypothèse « client disparu
pendant une route streamée » ne donne pas de plantage — le détail est en
dernière section — mais la même absence de prise en compte de l'état du flux
produit le constat n°1, qui est le plus lourd.

## 1. Un build ou un check Docker qui échoue est annoncé en HTTP 200 : la CLI sort avec le code 0

**Gravité** : sûr
**Où** : `src/api.ts:46` et `src/api.ts:97-111`, `src/api.ts:114-118`,
`src/client.ts:67-71`, `src/cli.ts:168` et `src/cli.ts:175`

`streamText` écrit l'en-tête **avant** que le travail ne commence, donc avant
de savoir s'il réussira :

```ts
// src/api.ts:45-48
function streamText(res: http.ServerResponse): (line: string) => void {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "transfer-encoding": "chunked" });
  return (line) => res.write(line + "\n");
}

// src/api.ts:97-101
if (route === "POST /docker/build") {
  const print = streamText(res);     // ← 200 posé ici
  await buildBase(cfg, print);       // ← l'échec arrive après
  return res.end();
}
```

Quand `buildBase` jette, le `catch` final voit `res.headersSent === true` et
ne peut plus que pousser une ligne dans le corps — le statut, lui, reste 200 :

```ts
// src/api.ts:114-118
if (res.headersSent) {
  res.write(`ERREUR ${(err as Error).message}\n`);
  return res.end();
}
```

En face, le client ne décide qu'au vu du statut :

```ts
// src/client.ts:67-71
res.on("end", () => {
  if (buf) onLine(buf);
  if ((res.statusCode ?? 500) >= 300) return reject(new ApiError(...));
  resolve();                        // ← 200 ⇒ succès
});
```

Et l'action CLI se contente de rendre cette promesse (`src/cli.ts:168`), donc
`parseAsync()` ne voit aucune erreur, `process.exitCode` n'est jamais touché,
et `src/cli.ts:178-181` n'est pas atteint.

Scénario concret : un `docker/Dockerfile` cassé (un `RUN` qui sort en 1).

- Obtenu : `unused docker build` affiche le log, puis la ligne
  `ERREUR build de l'image de base : …`, et **sort avec le code 0**.
- Attendu : code de sortie non nul.

`POST /docker/check` est touché de la même façon, en pire : il avale
lui-même l'exception pour l'imprimer (`src/api.ts:107-109`) et finit sur
`res.end()` — un check dont le cycle run → commit → run est cassé répond donc
200 et sort en 0. C'est précisément la commande dont le rôle est de servir de
garde-fou avant de lancer une plage : `unused docker check && unused start
--for 8h` démarre la plage alors que le check vient d'échouer.

Les routes JSON, elles, sont correctes : `sendJson` n'est appelé qu'après le
travail, donc le statut est juste.

## 2. Une durée mal tapée dans `unused start --for` répond 500 et empile une trace dans le journal du démon

**Gravité** : sûr
**Où** : `src/api.ts:64`, avec `src/duration.ts:13-15` et `src/api.ts:119-122`

`parseDuration` jette un `Error` nu :

```ts
// src/duration.ts:13-15
if (last !== s.length || total <= 0) {
  throw new Error(`durée invalide "${text}" (attendu par ex. 8h, 90m, 1d12h)`);
}
```

L'appel est dans le `try` de la route, après la seule validation faite sur le
corps (« `for` est-il une chaîne ? ») :

```ts
// src/api.ts:62-65
const body = await readJson(req);
if (typeof body.for !== "string") throw new HttpError(400, "champ `for` attendu (ex. \"8h\")");
const { until } = await daemon.startWindow(parseDuration(body.for));
```

Le classement d'erreur ne connaît que `HttpError`, `ConflictError` et
`NotFoundError` ; tout le reste tombe en 500 avec journalisation :

```ts
// src/api.ts:119-122
const status = err instanceof HttpError ? err.status : … : 500;
if (status === 500) console.error(err);
```

Scénario concret : `unused start --for 8x` (ou `--for 0h`, `--for ""`).

- Obtenu : HTTP 500, et `console.error(err)` écrit la pile complète dans le
  journal systemd du démon — une faute de frappe de l'utilisateur ressemble
  dans les logs à une panne du serveur.
- Attendu : HTTP 400, rien dans le journal.

La chaîne de message, elle, remonte bien jusqu'à l'utilisateur
(`src/client.ts:43`), donc le symptôme visible côté terminal est correct ; le
défaut est le statut et le bruit de journal. À noter que `--for` est marqué
`requiredOption` mais sans aucune validation côté CLI : la route est donc
atteignable par le chemin nominal, pas seulement par un `curl`.

## 3. Un échappement `%` invalide dans un nom de tâche fait sortir un `URIError` en 500

**Gravité** : sûr
**Où** : `src/api.ts:87-89`

```ts
const task = /^POST \/tasks\/([^/]+)\/(reset|active)$/.exec(route);
if (task) {
  const name = decodeURIComponent(task[1]!);
```

`new URL("/tasks/%/reset", "http://unused").pathname` vaut `/tasks/%/reset` :
l'analyseur d'URL ne valide pas les séquences `%` d'un chemin et ne réencode
pas le `%` isolé. Le groupe `([^/]+)` capture donc `%`, et
`decodeURIComponent("%")` jette `URIError: URI malformed`. Comme au constat
n°2, `URIError` n'est dans aucune des trois classes reconnues :

- Obtenu : HTTP 500, `{"error":"URI malformed"}`, et une pile dans le journal
  du démon.
- Attendu : HTTP 400 (requête mal formée).

Mêmes résultats pour `%zz`, `%e0%a4`, ou tout nom se terminant par `%`.

La CLI passe systématiquement par `encodeURIComponent` (`src/cli.ts:146`,
`158`), donc elle ne déclenche pas ce chemin. Il reste atteignable par tout
autre client — ce que le commentaire de `createApi` annonce explicitement :
« un front pourra parler aux mêmes routes demain » (`src/api.ts:52`).

## 4. Aucune borne mémoire, ni sur le corps reçu ni sur le flux émis

**Gravité** : probable
**Où** : `src/api.ts:27-30` et `src/api.ts:47`

À l'entrée, `readJson` accumule tout ce qui arrive sans jamais regarder
`content-length` ni plafonner le total :

```ts
const chunks: Buffer[] = [];
for await (const c of req) chunks.push(c as Buffer);
const text = Buffer.concat(chunks).toString("utf8").trim();
```

Un `POST /window` d'un gigaoctet fait donc croître la RSS du démon du double
(les `chunks` plus la chaîne) avant la moindre validation. Le démon n'est pas
un simple serveur sans état : le tuer par OOM perd la plage en cours et
l'itération en vol. Au-delà de ~512 Mo la conversion `toString("utf8")` jette
avant l'OOM (limite de longueur de chaîne de V8), ce qui donne un 500 — mais
le pic mémoire a déjà eu lieu.

À la sortie, `print` jette la valeur de retour de `res.write` :

```ts
return (line) => res.write(line + "\n");
```

`res.write` renvoie `false` quand le tampon du socket est plein, et rien ici
n'attend `drain` : `buildBase` continue de pousser des lignes au rythme de
`docker build`. Scénario concret : `unused docker build | less` sans défiler.
Le lecteur est bloqué, le socket se remplit, et tout le log de build
s'accumule dans le tampon d'écriture du démon.

La portée reste limitée par les permissions : `listen` pose le socket en
`0o660` (`src/api.ts:154`), donc il faut déjà être local et dans le bon
groupe. D'où la gravité « probable » et non « sûr » : le défaut est réel et le
chemin de code est certain, mais il ne vient pas d'un client distant.

## Ce qui a été vérifié et tient

**Client qui disparaît pendant une route streamée — pas de plantage.**
C'était l'hypothèse de départ ; elle ne donne rien de visible. Quand la CLI
est interrompue (Ctrl-C) pendant `docker build`, le socket est détruit, et
`res.write` prend la sortie courte de `_writeRaw` (« `conn` existe et est
détruit ⇒ renvoyer `false` ») : la ligne est jetée, rien n'est mis en tampon.
Aucun `'error'` n'est émis sur `res` non plus, parce que `write_` remplace un
callback absent par un no-op avant de signaler l'erreur — donc pas
d'exception non interceptée, malgré l'absence de tout listener `'error'` sur
`res` et `req` dans `createApi`. Le `docker build` se poursuit jusqu'au bout
et `res.end()` passe sans bruit. Conclusion tirée par lecture (Node n'est pas
installé dans ce container, je n'ai pas pu l'exécuter) ; l'absence de
backpressure qui en découle est en revanche indépendante de ce détail et est
rapportée au constat n°4.

**Pas de traversée de chemin par le nom de tâche.** `%2F` survit à
`url.pathname`, donc `POST /tasks/..%2F..%2Fetc/reset` fait bien arriver
`../../etc` dans `name` après `decodeURIComponent`. Mais `findTask`
(`src/daemon.ts:389-395`) compare ce nom aux tâches réellement découvertes au
lieu de construire un chemin avec lui, et répond `NotFoundError` ⇒ 404. Même
chose pour `setActive`, qui part du `task.dir` trouvé. Côté création,
`scaffoldTask` valide d'abord contre `TASK_NAME_RE`
(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, `src/task.ts:10`), qui exclut `/`, `.` et
`%`.

**Corps non consommé sur `POST /tasks/<name>/reset`.** La route répond sans
lire `req` (`src/api.ts:90`). Pas de fuite en keep-alive : Node appelle
`req._dump()` à la fin de la réponse. Et la CLI n'envoie de toute façon aucun
corps sur `reset` (`call` n'ajoute `content-length` que si `body !== undefined`,
`src/client.ts:23-29`).

**`listen` / `probe`.** L'ordre tient : `probe` d'abord, `unlink` du socket
périmé ensuite, et le `server.once("error", reject)` est bien retiré après
succès (`src/api.ts:147-153`), donc une erreur de socket ultérieure n'atterrit
pas sur une promesse déjà résolue. `probe` traite le timeout et l'erreur, et
`res.resume()` évite de laisser la réponse en suspens.

**Classement des erreurs de `scaffoldTask` (examiné, non retenu comme
constat).** `src/api.ts:75-79` enveloppe *toute* exception de `scaffoldTask`
en `HttpError(409)` — y compris un nom invalide (qui mériterait 400) et une
erreur disque EACCES/ENOSPC (qui mériterait 500). La CLI traduit alors 409 en
code de sortie 3 (`src/cli.ts:180`), le même code que le vrai conflit
« tâche en cours d'itération ». C'est une imprécision réelle de statut, mais
le message exact remonte à l'utilisateur et aucun comportement de la CLI ne
se branche sur ce 3 aujourd'hui : je la signale ici plutôt que de la compter
comme un défaut.
