# 059 — angle multi-instance : espace de noms Docker global, second démon sans garde ni pilotage

**Fichiers examinés** : `src/docker.ts:95-107,160-186,250-254`, `src/api.ts:128-155`,
`src/cli.ts:14-46`, `src/dockerCheck.ts:20-23,48-110`, `src/config.ts:9-40`,
`deploy/install.sh:11-67`, `deploy/unused.service`, `src/state.ts:62-84`, `src/daemon.ts`
**Verdict** : 5 constats (3 sûrs, 2 probables)

Le fil conducteur : la configuration donne l'illusion qu'une instance est
isolée — `tasksDir`, `dataDir`, `docker.baseImage` sont tous paramétrables, le
socket se déduit de `dataDir` — mais l'espace de noms où vit réellement le
travail (les images de tâche) est codé en dur et global au démon Docker de
l'hôte, et le déploiement est écrit pour un seul chemin.

## L'image d'une tâche n'est nommée que d'après la tâche : deux instances se marchent dessus

**Gravité** : sûr
**Où** : `src/docker.ts:97-99` (et `:103-107`, `:160-186`, `:250-254`)

```ts
export function taskImage(taskName: string): string {
  return `unused-task-${taskName}`;
}
```

Aucun qualifiant d'instance (ni `rootDir`, ni `dataDir`, ni un préfixe
configurable) n'entre dans le nom. Or tout l'état d'une tâche vit dans cette
image : `resolveTaskImage` (`:103-107`) repart de `unused-task-<nom>:latest`
s'il existe, et `commitTask` (`:166-180`) y écrit le résultat de l'itération.
Seul `/exchange` est propre à l'instance (`src/task.ts:143` :
`<tasksDir>/<tâche>/exchange`) — c'est-à-dire la partie accessoire.

Scénario : deux copies du dépôt, `/opt/a` et `/opt/b`, chacune avec son
`unused.config.json`, son `dataDir`, son `tasksDir`, et même un `baseImage`
distinct pour bien les séparer. Les deux ont une tâche nommée `audit` (le nom
vient du répertoire sous `tasksDir`, rien n'impose qu'il soit unique sur la
machine).

1. A termine une itération : `commitTask` → `unused-task-audit:latest` contient
   le dépôt de A, à son commit, avec son `ANALYZED.md`.
2. B lance son itération suivante : `resolveTaskImage` trouve
   `unused-task-audit:latest` → B travaille dans le système de fichiers de A,
   avec le `/exchange` de B monté par-dessus. La session écrit son rapport sur
   la copie de travail de A, lit le registre de A pour choisir, et pousse sur
   la branche configurée dans le dépôt de A.
3. B commite : `unused-task-audit:prev` ← l'état de A, `:latest` ← le mélange.
   L'itération suivante de A repart de là.

Rien ne signale l'anomalie : les deux `state.json` sont séparés, donc chaque
démon croit suivre son propre curseur (`src/daemon.ts:375-386` ne lit que son
état), `status` affiche des compteurs cohérents de part et d'autre, et les
deux tâches progressent « normalement » sur un dépôt qui n'est plus celui
qu'elles pensent. Le `baseImage` distinct, seule séparation que la config
permette, n'est consulté que pour la toute première itération.

Deux conséquences destructrices du même nommage :

- `removeTaskImages(name)` (`:250-254`), déclenché par `unused tasks reset
  <tâche>` sur l'instance A (`src/daemon.ts:397-407`), fait
  `rmi -f unused-task-audit:latest unused-task-audit:prev` : la remise à zéro
  d'une tâche de A supprime l'historique de la tâche homonyme de B. L'échec
  éventuel du `rmi` est ignoré (`docker()` ne lève pas sur code ≠ 0), et B
  n'apprend rien : au `commitTask` suivant, `imageExists(:latest)` est faux,
  la rotation est sautée sans bruit, `:prev` de B a disparu.
- `pruneTask` (`:183-185`) filtre sur `label=unused.task=<tâche>`, label posé
  identiquement par les deux instances (`:95`, `:135-136`, `:174`) : un prune
  de A balaie aussi les images sans tag de B portant ce label.

## `UNUSED_SOCKET`, posé globalement par l'installeur, prend le pas sur un `-c` explicite

**Gravité** : sûr
**Où** : `src/cli.ts:26-31`, `deploy/install.sh:60-62`

```ts
async function sock(): Promise<string> {
  const opts = program.opts<{ socket?: string; config: string }>();
  if (opts.socket) return path.resolve(opts.socket);
  if (process.env.UNUSED_SOCKET) return path.resolve(process.env.UNUSED_SOCKET);
  return socketPath(await loadConfig(opts.config));
}
```

L'installeur écrit pour *tous* les comptes et tous les shells :

```sh
cat > /etc/profile.d/unused.sh <<'PROFILE'
export UNUSED_SOCKET=/opt/unused/data/unused.sock
PROFILE
```

`-c <fichier>` est annoncé comme servant aussi « à déduire le socket »
(`src/cli.ts:14`), mais la variable d'environnement est consultée *avant* lui.
Comme `config` porte une valeur par défaut, la CLI ne peut même pas distinguer
un `-c` tapé par l'utilisateur du défaut : l'intention explicite perd toujours.

Scénario : deux instances, celle d'`/opt/unused` installée par
`install.sh`, une seconde dans `/opt/unused2` lancée à la main. L'opérateur
tape, depuis un shell de connexion :

```
unused -c /opt/unused2/unused.config.json tasks reset audit
```

La commande part sur le socket d'`/opt/unused`. Résultat obtenu : la tâche
`audit` de la *première* instance est remise à zéro — état supprimé, `DONE`
retiré, images `unused-task-audit:latest` et `:prev` détruites — et la CLI
affiche `audit remise à zéro (curseur sur …, image supprimée)`, message
indistinguable du succès attendu. Résultat attendu : agir sur l'instance
désignée par `-c`, ou refuser. Même inversion pour `start --for 8h`, `stop`,
`deactivate`.

## `install.sh` ne sait déployer que `/opt/unused`, quel que soit le dépôt depuis lequel on le lance

**Gravité** : sûr
**Où** : `deploy/install.sh:11-17,33-67`

```sh
DIR=/opt/unused
…
[ -f "$DIR/package.json" ] || { echo "$DIR ne contient pas le dépôt" >&2; exit 1; }
…
cd "$DIR"
npm ci --no-audit --no-fund
npm run build
…
cp deploy/unused.service "$UNIT"
```

Le script ne se repère jamais par rapport à lui-même : `DIR` est codé en dur,
il y entre avec `cd "$DIR"`, et tout ce qui suit (y compris
`cp deploy/unused.service`, devenu relatif à `/opt/unused`) opère sur cet
arbre. `UNIT`, le wrapper `/usr/local/bin/unused`, le `profile.d` et le nom de
l'unité sont tout aussi fixes, et `deploy/unused.service` fixe
`WorkingDirectory=/opt/unused` et `User=unused`.

Scénario : seconde instance dans `/opt/unused2`, à jour, avec sa config et son
`.env`. L'opérateur lance `sudo /opt/unused2/deploy/install.sh`. Le garde-fou
de la ligne 14 passe (puisque `/opt/unused` existe : c'est précisément le cas
« seconde instance »). Le script compile `/opt/unused`, y rejoue `npm ci`,
réécrit ses permissions, recopie *son* unité, redémarre le service
`/opt/unused`, puis affiche `service redémarré` et le `systemctl status` vert.
Rien dans la sortie ne nomme `/opt/unused2`. Résultat obtenu : la première
instance est redéployée (et le code de `/opt/unused2` jamais construit, donc
`dist/` y reste périmé ou absent) ; résultat attendu : déployer `/opt/unused2`,
ou dire que ce n'est pas supporté.

## La garde du socket n'est pas atomique, et un démon vivant mais lent est déclaré absent

**Gravité** : probable
**Où** : `src/api.ts:128-155`

```ts
export async function listen(server: http.Server, sock: string): Promise<void> {
  if (await probe(sock)) throw new Error(`un démon répond déjà sur ${sock}`);
  await unlink(sock).catch(() => {});
  …
}
```

`probe` répond `false` sur toute erreur et sur l'expiration du `timeout: 2000`
(`:136-140` : `req.destroy(); resolve(false)`). Il n'existe aucun verrou
(ni `flock`, ni fichier de pid) sur `dataDir` : la seule protection est cette
séquence sonder → délier → écouter, non atomique, et le `unlink` est
inconditionnel. Deux chemins y mènent :

- *Course* : deux `listen()` concurrents sur le même socket (le service
  systemd qui démarre pendant qu'un opérateur lance `unused daemon` à la main
  — `install.sh:43-44` met `data/` en `770 unused:docker` et invite
  explicitement les comptes humains dans le groupe `docker`, qui ont donc le
  droit d'y délier). Les deux sondent avant que l'autre n'écoute, les deux
  délient, les deux écoutent : le second `unlink` fait disparaître le socket du
  premier.
- *Démon vivant mais lent* : `GET /status` passe par `loadTasks` (lecture du
  `tasksDir`) ; au-delà de 2 s — carte SD saturée par un `docker build`, ou un
  `flattenTask` qui fait transiter tout le tar d'export par la boucle
  d'événements du démon (`src/docker.ts:228-233`) — le second processus conclut
  à l'absence de démon, délie le socket vivant et prend la place.

Dans les deux cas le premier démon reste en vie : son serveur écoute sur un
inode désormais sans nom, il continue sa plage, lance des itérations et écrit
`state.json`. Résultat obtenu : deux démons sur le même `dataDir` — alors que
`src/daemon.ts:72` affirme « Seul propriétaire de state.json » — qui
chargent chacun l'état une fois à l'`init` et le réécrivent entier
(`src/state.ts:78-84`, `writeFile` + `rename`) : le dernier à sauver écrase
l'avancement de l'autre, un nœud est rejoué ou sauté. Les deux commitent la
même image `unused-task-<nom>:latest`. Et le pilotage ne voit que le second :
`unused status` affiche `pid` du nouveau et « plage aucune » pendant que
l'ancien consomme du quota, `unused stop` ne l'atteint plus — seul un `kill`
l'arrête.

Accessoirement, `unused daemon -s /tmp/autre.sock` ignore silencieusement
`-s` : la commande `daemon` appelle `listen(server, socketPath(cfg))`
(`src/cli.ts:44-45`) sans jamais passer par `sock()`. L'opérateur qui croit
isoler un second démon par ce flag le fait atterrir sur le socket du premier.

## `docker check` partage un nom de tâche fixe et n'est pas sérialisé : échec mécanique inventé

**Gravité** : probable
**Où** : `src/dockerCheck.ts:20-23,49-85`, `src/api.ts:101-112`

```ts
const CHECK_TASK = "docker-check-internal";
…
await removeTaskImages(CHECK_TASK);
```

Le nom est constant, donc partagé par toutes les instances de l'hôte (même
cause que le premier constat), et rien ne sérialise la route : `POST
/docker/check` est traitée en parallèle de toute autre requête, sans verrou ni
vérification qu'une plage tourne.

Scénario : A exécute `unused docker check`, B lance le sien pendant ce temps
(ou, sur une seule instance, deux `unused docker check` concurrents). Le
`removeTaskImages(CHECK_TASK)` d'entrée de B (`:50`) supprime les images de A
en cours de vérification, puis le `finally` de B (`:106-108`) recommence.
Selon l'instant :

- entre les étapes 1 et 2 de A, `commitTask` ne trouve plus `:latest`, saute la
  rotation sans erreur, et A échoue sur `:prev absent après la rotation`
  (`:84`) ;
- un peu plus tôt, `resolveTaskImage` retombe sur l'image de base et A échoue
  sur `image de départ inattendue : unused-base` (`:74`).

Résultat obtenu : la route rend `ERREUR …` (`src/api.ts:108-110`) et accuse la
mécanique Docker — rotation cassée, image de départ fausse — alors qu'elle est
saine ; résultat attendu : un diagnostic exact, ou un refus de lancer deux
vérifications à la fois. Un opérateur qui suit ce verdict ira réparer un
problème inexistant.

## Ce qui a été vérifié et tient

- Les noms de containers (`unused-<tâche>-<Date.now()>`, `:132`, et
  `unused-flatten-<tâche>-<Date.now()>`, `:219`) ne collisionnent entre
  instances qu'à la milliseconde près ; aucun scénario réaliste trouvé, et un
  container résiduel ne bloque pas le suivant puisque l'horodatage change.
- `pruneTask` et le `container prune` de `dockerCheck` sont bien filtrés par
  label et ne touchent pas les ressources Docker étrangères à `unused`.
- `/exchange`, `state.json`, `data/logs/` et le `.env` sont tous résolus sous
  `rootDir` (`src/config.ts:65-71`) : ces chemins-là sont correctement
  séparés entre instances, l'écriture de `state.json` est atomique, et un
  second démon sans droit d'écriture sur `data/` échoue proprement
  (`unlink` refusé puis `EADDRINUSE` propagé par `listen`).
- `docker.baseImage` est, lui, paramétrable : une instance peut se donner sa
  propre image de base. C'est le seul maillon de l'espace de noms Docker qui
  soit isolable par configuration.
