# 024 — `deploy/install.sh` + `deploy/unused.service` : installation et mise à jour

**Fichiers examinés** : `deploy/install.sh:1-78` (intégralité), `deploy/unused.service:1-26`
(intégralité), `src/cli.ts:17-30` (`daemonSetup`, `sock`) et `:178-181` (gestionnaire
d'erreur), `src/config.ts:51-72` (`loadConfig`), `src/api.ts:14-16,144-155`
(`socketPath`, `listen`), `src/iterate.ts:99-106`, `src/scaffold.ts:95-101`,
`src/docker.ts:130-181`, `README.md:26-45,113-124`, `package.json`.
Aucun test ne couvre `deploy/` (`grep -rl deploy src/*.test.ts` : rien).

**Verdict** : 4 constats (3 sûrs, 1 probable)

## `.env` absent : l'unité ne démarre pas du tout, alors que `install.sh` n'émet qu'un avertissement — et qu'il décrit un autre symptôme

**Gravité** : sûr
**Où** : `deploy/unused.service:16`, `deploy/install.sh:45-50`

```sh
# deploy/install.sh:45-50
if [ -f .env ]; then
  chown "$USER_NAME:$GROUP_NAME" .env
  chmod 600 .env
else
  echo "ATTENTION : pas de .env — le démon refusera de travailler sans CLAUDE_CODE_OAUTH_TOKEN" >&2
fi
```

```ini
# deploy/unused.service:16
EnvironmentFile=/opt/unused/.env
```

`EnvironmentFile=` **sans préfixe `-`** est bloquant : systemd documente que seul
le préfixe `-` fait ignorer les erreurs, « y compris un fichier inexistant ». Sans
`.env`, le chargement de l'environnement échoue avant même le `fork` de
`ExecStart` (`Failed to load environment files: No such file or directory`) et
l'unité n'atteint jamais l'état actif.

Or le code, lui, est écrit pour tourner sans `.env` et pour le dire proprement :

```ts
// src/cli.ts:19-22
const envFile = path.join(cfg.rootDir, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
```

```ts
// src/iterate.ts:99-102
const token = deps.env[TOKEN_ENV];
if (!token) {
  return finishFatal("auth", `${TOKEN_ENV} absent : lance \`claude setup-token\` et mets le token dans .env`);
}
```

`existsSync` rend le fichier optionnel, et l'absence de token produit un
`fatal: auth` lisible — c'est exactement le comportement que l'avertissement de
`install.sh` promet (« le démon refusera de *travailler* », donc un démon qui
tourne et refuse les itérations). L'unité interdit ce comportement.

**Scénario concret.** Le token est révoqué et l'opérateur déplace
`/opt/unused/.env` le temps d'en régénérer un (ou le `.env` n'a jamais été créé :
il ne figure ni dans les prérequis de l'en-tête, `install.sh:8`, qui n'exige que
node et docker, ni dans la séquence `install.sh` du README — `README.md:32` le
crée à la main dans un autre flux). Puis `sudo deploy/install.sh` :

1. lignes 31-44 : build et droits posés ;
2. ligne 49 : l'avertissement s'affiche ;
3. lignes 55-66 : le wrapper, `/etc/profile.d/unused.sh`, l'unité sont installés,
   et l'unité est **enable** — donc réessayée à chaque démarrage machine ;
4. ligne 71 : `systemctl start unused` sur une unité qui ne peut pas démarrer.
   Le script tourne sous `set -euo pipefail` (ligne 9) et l'appel n'est pas dans
   une condition : soit `systemctl` rend un code non nul et le script s'arrête
   là, sur une erreur systemd qui ne parle pas de token, sans jamais atteindre
   le message d'aide des lignes 77-78 ; soit `systemctl` considère le travail
   terminé (l'unité étant passée en redémarrage automatique, `Restart=always`
   / `RestartSec=5`, `unused.service:18-19`) et le script affiche « service
   démarré » (ligne 72) — un mensonge, que seul le `status` de la ligne 75
   contredit trois lignes plus bas.

Attendu : soit `EnvironmentFile=-/opt/unused/.env` (le code sait déjà gérer le
token manquant et le signaler comme panne `auth`), soit un échec franc de
`install.sh` à la ligne 49 (`exit 1`) puisque l'installation est de toute façon
condamnée. Obtenu : un avertissement qui décrit un symptôme impossible, une
installation qui va jusqu'au bout, et un service `enable` qui échoue à chaque
démarrage pour une raison sans rapport apparent avec le message lu.

## Le contrôle de `node` ne vérifie ni la version qu'il annonce, ni l'interpréteur que l'unité utilisera

**Gravité** : sûr
**Où** : `deploy/install.sh:21`, `deploy/unused.service:17`

```sh
# deploy/install.sh:21
command -v node >/dev/null || { echo "node introuvable (≥ 22 requis)" >&2; exit 1; }
```

Ce contrôle est le seul garde-fou de l'installation sur l'environnement Node, et
il vérifie deux choses de moins que ce qu'il laisse croire :

1. **la version n'est jamais lue.** `package.json` déclare `"engines": {"node": ">=22"}`
   mais npm n'en fait qu'un avertissement (sans `engine-strict`), et `tsc` ne
   contrôle rien à l'exécution : `npm ci` / `npm run build` (lignes 32-33)
   réussissent sous Node 18, qui est la version de `nodejs` des dépôts Debian 12
   (Raspberry Pi OS). La première utilisation d'une API trop récente est
   `process.loadEnvFile` (`src/cli.ts:21`, ajoutée en v20.12/v21.7) : le démon
   meurt au démarrage sur `TypeError: process.loadEnvFile is not a function`,
   **et seulement si `.env` existe**, donc uniquement en production, jamais au
   build ni au typecheck (`@types/node` 22 connaît la méthode, le typecheck
   passe).
2. **le chemin testé n'est pas le chemin exécuté.** `command -v node` interroge
   le `PATH` de root, alors que l'unité code en dur
   `ExecStart=/usr/bin/node /opt/unused/dist/cli.js daemon`
   (`unused.service:17`). Le commentaire de l'unité prévoit le cas — « Adapter
   User, WorkingDirectory et le chemin de node si besoin »
   (`unused.service:4`) — mais `install.sh:64` la copie telle quelle et n'adapte
   rien, et ne vérifie jamais l'existence de `/usr/bin/node`.

**Scénario concret.** Sur un Pi arm64, la façon usuelle d'obtenir Node ≥ 22 (le
dépôt Debian s'arrêtant à 18) est l'archive officielle dépliée dans
`/usr/local` : le binaire est alors `/usr/local/bin/node`. `install.sh:21`
passe (le `PATH` de root contient `/usr/local/bin`), `npm ci`, le build et tous
les droits se déroulent normalement, le wrapper `/usr/local/bin/unused`
fonctionne (il appelle `node` via le `PATH`, ligne 57) — et le service, lui,
échoue avec `status=203/EXEC`, en boucle toutes les 5 secondes. Le seul
diagnostic offert est les trois lignes de `systemctl status` de la ligne 75.
Attendu d'un contrôle qui affiche « ≥ 22 requis » : refuser l'installation quand
`node --version` est inférieur à 22, et poser dans l'unité le chemin réellement
trouvé (`NODE=$(command -v node)` puis substitution dans le `cp` de la ligne 64)
— ou au minimum vérifier `/usr/bin/node`.

## La CLI installée ne trouve le démon que depuis un shell de login : `ssh hôte 'unused …'` et `sudo unused …` échouent

**Gravité** : sûr
**Où** : `deploy/install.sh:52-62`, `src/cli.ts:25-30`

```sh
# deploy/install.sh:52-62
# La CLI pour tous : un wrapper (tsc ne pose pas le bit exécutable), et le
# socket via UNUSED_SOCKET, sans lire la config.
…
cat > /usr/local/bin/unused <<WRAPPER
#!/bin/sh
exec node "$DIR/dist/cli.js" "\$@"
WRAPPER
chmod 755 /usr/local/bin/unused
cat > /etc/profile.d/unused.sh <<'PROFILE'
export UNUSED_SOCKET=/opt/unused/data/unused.sock
PROFILE
```

Le commentaire dit que le socket arrive « via `UNUSED_SOCKET`, sans lire la
config », mais le wrapper ne transmet ni `--socket` ni `UNUSED_SOCKET` : il
délègue entièrement à `/etc/profile.d/`, qui n'est lu que par les shells de
**login**. Dès que la variable manque, la CLI retombe sur la config, résolue
relativement au répertoire courant de l'appelant :

```ts
// src/cli.ts:26-30
const opts = program.opts<{ socket?: string; config: string }>();
if (opts.socket) return path.resolve(opts.socket);
if (process.env.UNUSED_SOCKET) return path.resolve(process.env.UNUSED_SOCKET);
return socketPath(await loadConfig(opts.config));
```

`opts.config` vaut `"unused.config.json"` (`src/cli.ts:14`), et
`loadConfig` fait `path.resolve(file)` (`src/config.ts:52`), donc `$PWD/unused.config.json`.

**Scénarios concrets**, sur une machine où tout est sain et le démon en pleine
plage :

- `ssh pi@rpi 'unused status'` — un `ssh` avec commande donne un shell non
  interactif et non-login : ni `/etc/profile` ni `/etc/profile.d/*` ne sont lus.
  Résultat : `Impossible de lire /home/pi/unused.config.json : ENOENT…`,
  code 1 (`src/config.ts:58`, `src/cli.ts:178-181`). C'est le mode de pilotage
  naturel d'un Pi sans écran, et le message oriente vers un fichier de config
  qui n'a aucune raison d'exister dans `$HOME`.
- `sudo unused stop --now` — `sudo` en configuration par défaut (`env_reset`)
  supprime `UNUSED_SOCKET`, qui n'est pas dans `env_keep`, et n'exécute pas de
  shell de login. Même échec. Or `sudo` est précisément le réflexe de
  l'opérateur, puisque l'arborescence appartient à `unused` (voir 016).
- idem pour `cron`, `systemd-run`, un script `#!/bin/sh` ou un `docker exec`.

Depuis un shell de login la commande marche, ce qui rend le défaut d'autant plus
déroutant : la même commande fonctionne ou non selon la façon d'ouvrir la
session. Attendu : que le wrapper porte le chemin qu'il connaît déjà
(`exec node "$DIR/dist/cli.js" --socket "$DIR/data/unused.sock" "$@"`, un
`--socket` explicite de l'utilisateur restant prioritaire car traité après), ou
qu'il exporte lui-même `UNUSED_SOCKET`. `/etc/profile.d/` ne devrait être qu'un
confort pour les invocations directes de `node dist/cli.js`.

## Un `dataDir`/`tasksDir` non standard : `install.sh` prépare les mauvais répertoires et pointe la CLI sur un socket qui n'existera jamais

**Gravité** : probable
**Où** : `deploy/install.sh:39-44,61`

```sh
mkdir -p data tasks
chown -R "$OWNER:$GROUP_NAME" "$DIR"
chmod -R g+rX,o-rwx "$DIR"
chown -R "$USER_NAME:$GROUP_NAME" data tasks
chmod 770 data tasks
…
export UNUSED_SOCKET=/opt/unused/data/unused.sock
```

Les deux répertoires de travail sont des options de configuration à part entière
(`src/config.ts:10-11`, schéma `.strict()`, valeurs par défaut `./tasks` et
`./data`, résolues contre `rootDir`), et le chemin du socket en découle
mécaniquement (`src/api.ts:14-16` : `path.join(cfg.dataDir, SOCKET_FILE)`).
`install.sh` ignore la config et code en dur `data`/`tasks` aux lignes 39, 43 et
44, puis re-code en dur le socket complet à la ligne 61.

**Scénario concret.** `unused.config.json` porte `"dataDir": "./var"` (par
exemple pour séparer l'état d'un `data/` déjà utilisé, ou parce que `/opt/unused/data`
est monté ailleurs). `sudo deploy/install.sh` :

- crée et ouvre `data/` et `tasks/` — dont `data/` ne servira à rien ;
- laisse `var/` avec le traitement générique des lignes 40-41 : propriétaire
  `$OWNER` (le compte qui déploie, souvent `root`), groupe `docker`, et `g+rX`
  **sans `w`**. Le démon tourne en `unused:docker` (`unused.service:13-14`) : il
  n'est ni propriétaire ni capable d'écrire. `state.ts:79` (`mkdir` récursif)
  ou le `bind` du socket (`src/api.ts:149`) échouent en `EACCES`, le démon meurt
  au démarrage et `Restart=always` le relance toutes les 5 secondes ;
- écrit dans `/etc/profile.d/unused.sh` un `UNUSED_SOCKET` qui désigne un
  fichier qui n'existera jamais : même si le démon parvenait à tourner, toute
  commande cliente répondrait « le démon n'est pas lancé (socket
  /opt/unused/data/unused.sock) » (`src/client.ts:13-16`) alors qu'il écoute
  sur `/opt/unused/var/unused.sock`.

Attendu : lire `dataDir`/`tasksDir` depuis `unused.config.json` (le script a
node sous la main) ou, à défaut, refuser une config qui s'écarte des valeurs
par défaut au lieu de préparer silencieusement les mauvais chemins. Gravité
« probable » et non « sûre » seulement parce que le README ne met pas ces deux
options en avant (`README.md:130-135` n’en parle pas) : rien dans le code ne les
restreint.

## Ce qui a été vérifié et tient

- **Droits du socket** : `listen` termine par `chmodSync(sock, 0o660)`
  (`src/api.ts:154`) et le démon a `Group=docker` comme groupe primaire
  (`unused.service:14`) : le socket est `unused:docker 660`, donc *connectable*
  par le groupe (`connect()` exige le droit d'écriture). Le `chmod -R g+rX,o-rwx`
  de la ligne 41 ne retire pas le `w` du groupe, et le service est de toute façon
  redémarré ensuite, ce qui recrée le fichier. Cohérent avec le discours des
  lignes 13-16 et 77.
- **`.env`** : `chown unused:docker` + `chmod 600` (lignes 46-47) est lisible par
  les deux lecteurs — systemd lit `EnvironmentFile` en tant que root avant de
  changer d'utilisateur, et le démon tourne en `unused`, propriétaire. Pas de
  problème de droits ici.
- **Double lecture de `.env`** (systemd `EnvironmentFile`, puis
  `process.loadEnvFile` dans `src/cli.ts:21`) : sous systemd les deux lisent le
  même fichier, `WorkingDirectory=/opt/unused` faisant coïncider
  `cfg.rootDir` avec le chemin codé en dur de l'unité — même contenu, donc pas
  de divergence de valeur observable, indépendamment de l'ordre de précédence.
  Une divergence de *parsing* entre les deux implémentations resterait
  théoriquement possible (valeur contenant `#`, guillemets, `export`) mais je
  n'ai pas pu l'établir : aucun interpréteur node n'est disponible dans ce
  container (`node: command not found`), et je ne rapporte pas ce que je n'ai pas
  pu démontrer.
- **Mise à jour sous un démon vivant** : `npm ci` détruit et réinstalle
  `node_modules`, puis `npm prune --omit=dev` retire les dépendances de
  développement (lignes 32-34), tout cela *avant* le redémarrage de la ligne 68.
  C'est sans danger pour le processus en vie : `grep 'import('` sur `src/*.ts`
  ne rend aucun import dynamique, tous les modules sont chargés au démarrage, et
  l'itération ne lance que le binaire `docker` (`src/docker.ts:28-68`). Le
  script est bien idempotent sur ce point.
- **Redémarrage au milieu d'une itération** (`install.sh:68`, `KillMode=mixed`,
  `TimeoutStopSec=60`) : le chemin d'abandon est propre côté code
  (`src/iterate.ts:133-136` tue le container, puis `discardContainer` est
  attendu), mais les cas où 60 s ne suffisent pas — `commitTask` +
  `flattenTask`, `docker check` — sont déjà couverts, sous l'angle de leur
  non-atomicité, par 001, 004, 005 et 010 ; rien à ajouter ici.
- **Droits du squelette de tâche** (`umask` 0022 du service contre `chmod 770`
  sur `tasks/`) : déjà rapporté en 016. À noter seulement que `chown -R`
  (ligne 43) déplace aussi vers `unused` les fichiers qu'un opérateur a écrits
  à la main, en `0644` : après chaque mise à jour il perd le droit d'écriture
  sur ses propres `task.json`. C'est la même cause que 016, pas un constat
  distinct.
- `rm -f /usr/local/bin/unused` avant réécriture (ligne 54) est correct : sans
  lui, `cat >` suivrait un ancien lien symbolique vers `dist/cli.js`. Les
  documents `<<WRAPPER` (non quoté, `$DIR` interpolé, `\$@` protégé) et
  `<<'PROFILE'` (quoté) sont conformes à leur intention. La création de
  l'utilisateur (lignes 26-29) est bien conditionnée à son absence.
