# 051 — Intégrité de l'image de base : un installeur en pipe qui échoue sans le dire, un build déclaré réussi sans `claude`, et aucun retour arrière

**Fichiers examinés** : `docker/Dockerfile:1-22` (toutes les instructions),
`src/docker.ts:82-93` (`buildBase`), `src/docker.ts:78-80` (`imageExists`),
`src/docker.ts:101-105` (`resolveTaskImage`), `src/docker.ts:166-180`
(`commitTask`, par contraste : rotation `:prev`), `src/docker.ts:183-185`
(`pruneTask`), `src/dockerCheck.ts:36-60` (build puis vérification de `claude`),
`src/dockerCheck.ts:92-102` (re-vérification après aplatissement),
`src/api.ts:97-110` (routes `POST /docker/build` et `/docker/check`),
`src/cli.ts:163-175` (commandes `unused docker build` / `check --rebuild`),
`src/daemon.ts:286-299` (`startWindow`, garde `imageExists`),
`src/daemon.ts:136-157` et `:176-200` (boucle `run` → `execute`, plages
automatiques : aucune garde), `src/iterate.ts:59-64` (`isDockerDown`),
`src/iterate.ts:119-159` (classement de l'issue), `src/claude.ts:86-112`
(`parseStream`), `src/graph.ts:41-53` (`classify`), `src/graph.ts:66-101`
(`applyOutcome`), `src/config.ts:22-28` (config `docker`),
`README.md:43-44` (procédure d'installation annoncée),
`src/docker.test.ts` (ce que les tests couvrent : `importChanges`, `taskImage`).

**Verdict** : 3 constats (3 sûrs)

Les trois se chaînent : l'installeur peut ne rien installer sans faire échouer
le build (1), le build cassé est ensuite mis en cache donc le remède annoncé ne
répare rien et l'image valide précédente est déjà perdue (2), et une image sans
`claude` ne produit pas une panne mais un échec imputé aux tâches, qui finissent
sorties de la file (3).

## `curl … | bash` sous `/bin/sh` : l'échec du téléchargement n'échoue pas le `RUN`

**Gravité** : sûr
**Où** : `docker/Dockerfile:13`

```dockerfile
RUN curl -fsSL https://claude.ai/install.sh | bash
```

Aucune instruction `SHELL` n'est déclarée, donc ce `RUN` est exécuté par le
`/bin/sh` de `debian:bookworm-slim`, c'est-à-dire **dash**. Dans un shell POSIX,
le code de sortie d'un pipeline est celui de sa **dernière** commande : ici
`bash`. Si `curl` échoue, il n'écrit rien sur stdout, `bash` lit un script vide,
se termine avec 0 — et le `RUN` est réputé réussi. `set -o pipefail`, qui
corrigerait le problème, n'existe pas dans dash.

Vérifié dans ce container, avec le même `/bin/sh -> dash` que l'image :

```
$ /bin/sh -c 'curl -fsSL https://claude.invalid.example/install.sh | bash'; echo "exit=$?"
curl: (6) Could not resolve host: claude.invalid.example
exit=0
$ /bin/sh -c 'curl -fsSL https://raw.githubusercontent.com/does/not/exist-xyz.sh | bash'; echo "exit=$?"
curl: (22) The requested URL returned error: 404
exit=0
$ /bin/sh -c 'set -o pipefail; echo supported'
/bin/sh: 1: set: Illegal option -o pipefail
```

Les deux cas sont réalistes sur un Pi : DNS pas encore prêt au moment du build,
coupure réseau, portail captif, ou simplement un `claude.ai/install.sh` qui
renvoie 5xx ou 404 le jour d'un changement d'URL. `-f` fait bien rejeter les
erreurs HTTP à curl, mais ce rejet n'est transmis à personne.

S'ajoute un cas plus sournois : une coupure **en cours** de transfert. `bash`
lit son script au fil de l'eau depuis le pipe et a déjà exécuté la partie reçue ;
`curl` sort en 18/56, et le code de sortie observé reste celui de `bash`, qui
vaut 0 si la dernière commande tronquée a réussi. On obtient alors une
installation partielle, sans aucun signal.

Et rien ne rattrape ça ensuite : le Dockerfile ne contient aucune vérification
du type `RUN claude --version` ou `RUN command -v claude`, et `buildBase`
(`src/docker.ts:82-93`) ne regarde que le code de sortie de `docker build` via
`mustSucceed`. Donc `unused docker build` (`src/cli.ts:165-168` →
`src/api.ts:97-100`) affiche la sortie du build, ne lève pas, et l'appelant en
conclut que l'image est prête. Le seul endroit qui vérifie réellement la
présence de `claude` est `dockerCheck` (`src/dockerCheck.ts:57-60`), une
commande **séparée** — le README demande bien de lancer les deux
(`README.md:43-44`), mais la route de build ne dépend pas de cela.

Résultat concret : `unused docker build` se termine sans erreur, et
`src/dockerCheck.ts:47` imprime même `✔ image présente (N couches)` juste après
le build, pour une image où `claude` n'existe pas.

## Le `RUN` cassé est mis en cache, et l'image valide précédente a déjà disparu

**Gravité** : sûr
**Où** : `src/docker.ts:84`

```ts
await mustSucceed(["build", "-t", cfg.docker.baseImage, cfg.docker.dockerfileDir], …);
```

Deux conséquences, les deux dans cette unique ligne.

**Le cache rend la panne persistante.** Les arguments ne comportent ni
`--no-cache` ni `--pull`. La clé de cache d'un `RUN` est le texte de
l'instruction ; celui de la ligne 13 ne change pas. Donc une fois la couche
« curl a échoué, rien n'est installé » produite et mise en cache, **tout** build
ultérieur la réutilise et réussit instantanément, y compris après le retour du
réseau. Scénario : build de nuit pendant une coupure DNS → image sans `claude` ;
le matin, l'utilisateur voit `unused docker check` échouer sur
`claude --version a échoué`, applique le remède évident et documenté
(`unused docker build`, ou `unused docker check --rebuild`, qui appelle le même
`buildBase` en `src/dockerCheck.ts:43-45`) ; le build affiche `CACHED` sur la
ligne de l'installeur, se déclare réussi, et l'image est toujours cassée.
Attendu : le rebuild réinstalle `claude`. Obtenu : rien n'est retéléchargé et
aucune commande exposée par la CLI ne permet d'invalider ce cache.

**Il n'y a pas de retour arrière.** Le build écrit directement sur le tag de
production (`-t unused-base`). Si l'image produite est cassée, Docker déplace le
tag vers la nouvelle image et l'ancienne — celle qui marchait — devient
*dangling*, joignable uniquement par son ID via `docker images -a`. Aucun moyen
de revenir en arrière n'est offert, et le contraste interne est net :
`commitTask` prend soin de faire tourner l'état précédent sous `:prev`
(`src/docker.ts:168-170`) et `dockerCheck` vérifie même cette rotation
(`src/dockerCheck.ts:77`) ; l'image de base, elle, n'a pas d'équivalent. Le
seul filet est que les deux `image prune` du dépôt sont filtrés par label
(`src/docker.ts:184`, `src/dockerCheck.ts:108`) et que l'image de base ne porte
pas de `unused.task`, donc l'ancienne image n'est pas activement supprimée — un
`docker system prune` de l'hôte, lui, l'emportera.

## Une image sans `claude` n'est pas une panne : elle fait sortir toutes les tâches de la file

**Gravité** : sûr
**Où** : `src/iterate.ts:158-159`, `src/graph.ts:52`, `src/graph.ts:93-100`

Soit l'image de base présente mais sans `claude` (constat 1), soit absente et
non *pullable*. `runInTask` lance `docker run … <image> claude -p …`. Docker
échoue à exécuter le binaire (code 127 documenté pour « contained command not
found » ; 125 pour une image introuvable), écrit son erreur OCI sur **stderr** et
laisse stdout **vide**. `docker()` ne lève pas sur code ≠ 0
(`src/docker.ts:27-28`), donc `iterate` poursuit avec `r.code = 127` et
`r.stdout = ""`.

La suite est mécanique :

- `parseStream("")` → `{ result: null, lines: 0 }` (`src/claude.ts:87-111`) ;
- `isDockerDown(r.stderr)` est faux : l'expression ne connaît que les messages
  de socket du démon (`src/iterate.ts:59`), pas `executable file not found` ni
  `Unable to find image` ;
- la garde `fatal:docker` de `src/iterate.ts:158` ne s'applique donc pas ;
- `classify` tombe sur sa dernière ligne : `{ kind: "failure", reason:
  r?.terminal_reason ?? "unreadable_output" }` (`src/graph.ts:52`) ;
- `applyOutcome` incrémente `consecutiveFailures` et, à
  `maxConsecutiveFailures` (défaut **3**, `src/config.ts:39`), pose
  `ts.status = "failed"` et renvoie `task-failed` (`src/graph.ts:95-99`).

Avec `retrySeconds` à 60 par défaut, **chaque tâche de la file est marquée
`failed` en trois itérations, soit quelques minutes**, et sort de la file de
façon persistante : `isEligible` l'exclut tant que `status !== "running"`
(`src/graph.ts:107-110`) et il faut un `unused task reset` explicite pour
revenir. Attendu : une issue `fatal` → `stop-window`, la plage s'arrête, les
curseurs et les compteurs ne bougent pas, et le message désigne l'image.
Obtenu : un problème d'environnement entièrement réparable est inscrit dans
`data/state.json` comme un échec **des tâches**, sous le motif
`unreadable_output` qui n'évoque rien de l'image.

Le même chemin ne passe par aucune garde préalable dans le cas d'une plage
**automatique** : `startWindow` vérifie bien `imageExists(baseImage)` et refuse
en 409 (`src/daemon.ts:291-293`), mais c'est la seule occurrence. La boucle
`run` → `execute` → `runWindow` (`src/daemon.ts:136-157`, `:176-200`), par
laquelle passent les plages du calendrier, n'appelle jamais `imageExists`. Une
nuit automatique avec une image absente ou cassée consomme donc sa file
entière en échecs au lieu de s'arrêter net.

À noter, à sa décharge : l'information n'est pas perdue. `rec.stderr` est
journalisé (`src/iterate.ts:211`) et les trois dernières lignes sont imprimées
(`src/iterate.ts:227`), donc l'erreur OCI est lisible dans le log de
l'itération. C'est la **décision** qui est fausse, pas la trace.

## Ce qui a été vérifié et tient

- `dockerCheck` couvre réellement le socle : `claude --version` après le build
  (`src/dockerCheck.ts:57-60`) et à nouveau après aplatissement, en même temps
  que `IS_SANDBOX`, `pwd` et le PATH (`src/dockerCheck.ts:96-101`). Son `finally`
  nettoie images, containers et répertoire d'échange même en cas d'échec
  (`:105-111`). C'est le seul garde-fou du socle, mais il fait bien son travail.
- `buildBase` ne perd pas de sortie : le tampon de lignes partielles est vidé
  après l'attente (`src/docker.ts:92`), et `mustSucceed` joint `r.stderr` au
  message d'erreur (`src/docker.ts:65`).
- Les deux `image prune` sont bien filtrés par label de tâche
  (`src/docker.ts:184`, `src/dockerCheck.ts:108`) : aucun n'est susceptible de
  supprimer l'image de base ni l'image *dangling* qui la précédait.
- `resolveTaskImage` ne retombe sur l'image de base que si `<tâche>:latest`
  n'existe pas (`src/docker.ts:102-105`) : une tâche déjà commitée n'est pas
  affectée par un rebuild du socle, cassé ou non.
- Les `ENV IS_SANDBOX=1` et `DISABLE_AUTOUPDATER=1` du Dockerfile
  (`docker/Dockerfile:18-20`) sont bien reconduits à travers l'aplatissement par
  `importChanges` (`src/docker.ts:199-211`), et `src/docker.test.ts:4-29` le
  couvre.
- `ENV PATH="/root/.local/bin:${PATH}"` (`docker/Dockerfile:14`) n'a pas pu être
  confronté au contenu réel de `claude.ai/install.sh` (pas de réseau ni de
  docker ici) : non vérifié, donc non rapporté.
