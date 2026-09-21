# Déploiement : `install.sh`, service systemd, utilisateur et permissions

`deploy/` contient tout ce qu'il faut pour faire tourner `unused` en démon
système sur une machine dédiée (typiquement un Raspberry Pi) : un script
d'installation idempotent (`install.sh`) et une unité systemd
(`unused.service`). Le principe : le code appartient au compte humain qui l'a
cloné et le met à jour (`git pull` sans sudo), le démon tourne sous un compte
système dédié qui ne peut que le lire.

## Lancer l'installation

```
sudo deploy/install.sh
```

Prérequis vérifiés en tête de script (`deploy/install.sh:19-22`) : lancé en
root, exécuté depuis une copie du dépôt dans `/opt/unused` (présence de
`package.json`), `node` ≥ 22 et `docker` installés. Le script est **relançable
sans risque** après chaque mise à jour du code — il ne touche jamais à
`.env`, `data/` ni `tasks/` en dehors de leurs permissions.

## L'utilisateur `unused`

Créé une seule fois, s'il n'existe pas déjà (`deploy/install.sh:26-29`) :

```bash
useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin --groups "$GROUP_NAME" "$USER_NAME"
```

Un compte système (`--system`), sans shell interactif
(`/usr/sbin/nologin`), membre du groupe `docker`. Ce dernier point est
volontaire et documenté en commentaire (`deploy/install.sh:13-15`) : être
dans le groupe `docker` équivaut déjà à root sur l'hôte (on peut monter
`/` dans un container et y écrire), donc l'ajout à ce groupe n'ouvre rien de
plus que ce que `docker` accorde déjà. C'est aussi par ce même groupe que les
comptes humains autorisés à piloter le démon accèdent au socket Unix — un
seul groupe sert donc les deux usages : donner au démon l'accès à Docker, et
donner aux opérateurs l'accès au démon.

## Build et permissions du code

Après avoir vérifié l'utilisateur, le script build le projet avec les outils
de dev puis élague :

```bash
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
```

Puis répartit les permissions selon qui doit écrire quoi
(`deploy/install.sh:38-50`) :

- Le code (`$DIR` dans son ensemble) reste **possédé par le compte qui
  déploie** (celui qui a fait `git clone`/`git pull`), retrouvé dynamiquement
  via `stat -c %U "$DIR/package.json"` — pas de nom en dur. Le groupe
  `docker` (donc `unused`) n'y a que lecture/traversée
  (`chmod -R g+rX,o-rwx`) : le démon peut lire son propre code compilé mais
  pas le modifier.
- `data/` et `tasks/` sont explicitement rendus possédés par
  `unused:docker`, en `770` : c'est là que vivent le socket Unix
  (`data/unused.sock`) et l'état des tâches, donc le démon doit pouvoir y
  écrire, et le groupe `docker` doit pouvoir y **entrer** pour atteindre le
  socket.
- `.env` (le fichier contenant `CLAUDE_CODE_OAUTH_TOKEN`), s'il existe déjà,
  passe en `600` possédé par `unused:docker` — lisible seulement par le
  compte du démon. S'il n'existe pas encore, le script se contente d'un
  avertissement : le démon refusera de travailler sans token, mais
  l'installation n'échoue pas pour autant.

## La CLI cliente et le socket

Comme `tsc` ne pose pas de bit exécutable sur le JS compilé, le script pose
un petit wrapper dans le `PATH` (`deploy/install.sh:54-59`) :

```bash
rm -f /usr/local/bin/unused  # un ancien lien symbolique écrirait dans dist/
cat > /usr/local/bin/unused <<WRAPPER
#!/bin/sh
exec node "$DIR/dist/cli.js" "\$@"
WRAPPER
chmod 755 /usr/local/bin/unused
```

Le commentaire sur le `rm -f` préalable est important : une version plus
ancienne du script posait un lien symbolique direct vers `dist/cli.js`, ce
qui aurait fait écrire n'importe quel compte exécutant `unused` dans le
dossier de build du démon si le lien n'était pas nettoyé avant remplacement.

Le script écrit aussi une variable d'environnement globale pour que tous les
comptes du groupe `docker` trouvent le socket sans argument :

```bash
cat > /etc/profile.d/unused.sh <<'PROFILE'
export UNUSED_SOCKET=/opt/unused/data/unused.sock
PROFILE
```

(voir [L'API HTTP et la CLI cliente](api-et-cli.md) pour l'ordre de
résolution `--socket` / `$UNUSED_SOCKET` / config).

## L'unité systemd

`deploy/unused.service` est copiée telle quelle vers
`/etc/systemd/system/unused.service`, puis le script fait
`daemon-reload`, `enable`, et démarre ou redémarre le service selon qu'il
tournait déjà (`deploy/install.sh:64-73`).

```ini
[Service]
Type=simple
User=unused
Group=docker
WorkingDirectory=/opt/unused
EnvironmentFile=/opt/unused/.env
ExecStart=/usr/bin/node /opt/unused/dist/cli.js daemon
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=60
```

Points notables :

- `EnvironmentFile=/opt/unused/.env` : c'est comme ça que
  `CLAUDE_CODE_OAUTH_TOKEN` arrive dans l'environnement du démon, sans
  jamais passer par la CLI cliente (qui, elle, ne lit jamais `.env`).
- `Requires=docker.service` / `After=... docker.service` : systemd s'assure
  que Docker est démarré avant le démon.
- `Restart=always` avec `RestartSec=5` : le démon relève un crash tout seul.
  Combiné à la reprise de plage après redémarrage (voir
  [Le démon](le-demon.md)), une plage en cours survit à un crash du process.
- `KillMode=mixed` avec `TimeoutStopSec=60` : au `stop`/`restart` du service,
  seul le processus principal reçoit `SIGTERM` (pas tout le cgroup) — c'est
  le démon qui est responsable de tuer proprement le container en cours
  avant de sortir. Le reste du cgroup n'est frappé (`SIGKILL`) que si le
  démon n'a pas fini dans les 60 secondes.

## Une fois installé

Le message final du script rappelle ce qu'il faut pour piloter le démon
depuis un compte humain : y ajouter le compte au groupe `docker`
(`sudo usermod -aG docker $USER`, puis se reconnecter pour que le nouveau
groupe soit pris en compte), puis utiliser la CLI (`unused status`,
`unused docker build`, `unused tasks list`...). Le `README.md` documente en
plus les deux étapes qui suivent une première installation : construire
l'image de base (`unused docker build`) et vérifier tout le cycle Docker
sans consommer de quota (`unused docker check`, voir
[`dockerCheck`](verification-docker.md)).
