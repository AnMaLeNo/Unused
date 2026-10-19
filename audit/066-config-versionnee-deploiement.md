# 066 — `unused.config.json` versionné : ce que devient le réglage d'une machine à chaque mise à jour

**Fichiers examinés** : `unused.config.json` (entier, et son historique :
`git log -- unused.config.json`), `.gitignore:1-7`, `deploy/install.sh:1-78`
(entier, relu sous le seul angle de la *mise à jour* — l'installation initiale
est déjà couverte par 024), `tsconfig.json` (entier),
`deploy/unused.service:12-21`, `src/config.ts:6-72` (`CONFIG_FILE`,
`ConfigFileSchema`, `loadConfig`), `src/calendar.ts:11-17`
(`WindowSpecSchema`), `src/daemon.ts:95-135` (`init`, `calendarEnd`,
`nextCalendarStart`), `src/daemon.ts:229-236` (`pauseUntil`),
`src/cli.ts:14-30` (`daemonSetup`, `sock`), `README.md:26-45` (installation),
`README.md:84-99` (plages), `README.md:130-135` (configuration),
`package.json`. Aucune CI (`.github/` n'existe pas).

**Verdict** : 3 constats (2 sûrs, 1 probable)

Ni `node` ni `npm` ni `node_modules` ne sont présents dans ce container
(`which node npm` ne rend rien) : rien de ce qui suit n'a pu être exécuté côté
TypeScript. En revanche `git` est disponible, et les trois scénarios du premier
constat sont **rejoués pour de vrai** ci-dessous dans des dépôts jetables de
`/tmp`, avec le `unused.config.json` du dépôt comme état de départ. Les numéros
de ligne sont ceux de la branche `audit`.

Le point de départ de l'angle. `.gitignore` met soigneusement hors du dépôt
tout ce qui appartient à la machine — `data/`, `tasks/`, `.env`, `dist/`,
`node_modules/` — et le commentaire des lignes 5-6 explicite la règle (« Les
tâches sont personnelles […] rien de tout cela n'est versionné »). Une seule
chose échappe à cette règle : `unused.config.json`, qui est **suivi par git**
(`git ls-files` le rend) alors qu'il est le seul endroit où l'opérateur règle
sa machine — ses plages, son timeout de session, son backoff, son image Docker
(`src/config.ts:8-44`, `README.md:84-99` et `130-135`). `install.sh` annonce en
en-tête « Ne touche pas à `.env`, `data/` ni `tasks/` » : la liste est celle du
`.gitignore`, et `unused.config.json` en est absent des deux côtés.

Le script sait pourtant que la mise à jour se fait par git — il le dit
lui-même, ligne 36 : « Le code appartient au compte qui déploie (`git pull`
sans sudo) ».

## `git pull` ne peut pas laisser passer à la fois le code et le réglage de la machine

**Gravité** : sûr
**Où** : `.gitignore:1-7` (l'absence de `unused.config.json`),
`deploy/install.sh:36`, `deploy/install.sh:31-33`

La mise à jour documentée est `git pull` puis `sudo deploy/install.sh`
(en-tête du script : « Idempotent : relançable après chaque mise à jour du
code »). Comme le fichier de réglage est versionné *et* modifié sur place, les
trois issues possibles sont mauvaises, et aucune n'est signalée par
`install.sh`, qui ne lit jamais la config (aucune ligne du script n'ouvre
`unused.config.json` ; il code `data`/`tasks` en dur, cf. 024).

**A. Réglage non commité — la mise à jour n'a pas lieu, et le script dit
qu'elle a eu lieu.** Rejoué, en partant du `unused.config.json` du dépôt ;
l'opérateur veut travailler le samedi 00:00→08:00, l'amont publie un fichier
source *et* retouche au passage sa propre plage :

```
$ git pull --no-rebase
From /tmp/g3/up
   478b436..a6d33c8  master     -> origin/master
error: Your local changes to the following files would be overwritten by merge:
	unused.config.json
Please commit your changes or stash them before you merge.
Aborting
Updating 478b436..a6d33c8
-> src/b.ts récupéré ? NON
```

Le pull est **entièrement** annulé : pas une ligne de code n'est mise à jour.
L'opérateur enchaîne malgré tout sur `sudo deploy/install.sh`, qui ne peut pas
savoir qu'il n'y a rien de neuf : il rebuilde l'ancien code, repose les droits,
redémarre le service et affiche « service redémarré » (ligne 69) avant de
sortir 0 — le `|| true` de la ligne 75 neutralisant le `set -e` de la ligne 9.
Le déploiement est resté à la version précédente et l'a annoncé comme une mise
à jour réussie. (Le même message trompeur est déjà signalé en 024 par une autre
cause, le `.env` manquant ; ici il n'y a même pas d'erreur systemd pour mettre
la puce à l'oreille, le service tourne parfaitement — sur l'ancien code.)

**B. Le réflexe pour débloquer le pull efface le réglage de la machine.** Face
au message ci-dessus, `git checkout -- unused.config.json` (ou `git stash`, ou
`git reset --hard`) est la manœuvre évidente, et elle est silencieuse :

```
$ git checkout -- unused.config.json && git pull --no-rebase -q
$ sed -n '18,26p' unused.config.json
  "windows": [
    {
      "days": [
        "mon"
      ],
      "from": "01:00",
      "to": "13:00"
    }
  ],
```

La plage samedi 00:00→08:00 de l'opérateur est remplacée par la plage de
l'amont, lundi 01:00→13:00, ainsi que tout `timeoutMinutes`, `backoffMinutes`
ou `maxConsecutiveFailures` qu'il avait ajustés. Rien ne le lui dit :
`install.sh` ne compare pas, et `daemon.init()` se contente d'annoncer
« 1 plage(s) automatique(s), prochaine le … » (`src/daemon.ts:109-111`) — une
ligne qu'il affichait déjà avant, avec l'autre plage. Le démon se mettra à
consommer du quota un lundi matin au lieu du samedi, sans que personne n'ait
rien demandé.

**C. Réglage commité localement — le démon ne peut plus démarrer.** Si
l'opérateur commite sa config pour éviter B, le pull suivant tente une fusion
textuelle. Les champs d'une plage tenant sur des lignes voisines, le conflit
est systématique dès que les deux côtés touchent la même plage :

```
$ git pull --no-rebase
Auto-merging unused.config.json
CONFLICT (content): Merge conflict in unused.config.json
Automatic merge failed; fix conflicts and then commit the result.

$ sed -n '/windows/,/^  \]/p' unused.config.json
  "windows": [
    {
      "days": [
        "sat"
      ],
<<<<<<< HEAD
      "from": "00:00",
      "to": "08:00"
=======
      "from": "01:00",
      "to": "13:00"
>>>>>>> 4916e6a…
    }
  ],
```

Les fichiers de `src/` ont été fusionnés et écrits, eux : `npm run build`
réussit, et `install.sh` va jusqu'au redémarrage. Au démarrage,
`daemonSetup()` appelle `loadConfig` (`src/cli.ts:19`), dont le
`JSON.parse` (`src/config.ts:56`) bute sur `<<<<<<< HEAD` et lève
`Impossible de lire /opt/unused/unused.config.json : …` (ligne 58). Le démon
meurt avant d'ouvrir son socket (`src/api.ts:144-154`), `Restart=always` /
`RestartSec=5` le relance jusqu'à ce que systemd le déclare `failed`. `Type=simple`
(`unused.service:11`) fait rendre 0 à `systemctl restart` dès l'`exec`, donc
« service redémarré » s'affiche quand même ; seules les 3 lignes de
`systemctl status` de la ligne 75 — dont le code de retour est jeté — portent
l'information.

Attendu : que le fichier de réglage de la machine suive le sort des quatre
autres choses locales, c'est-à-dire sorte du dépôt (`unused.config.json` dans
`.gitignore`, et un `unused.config.example.json` versionné que l'installation
copie s'il n'y a rien) ; ou, à défaut, que `install.sh` valide la config avant
de redémarrer — il a node sous la main, `node dist/cli.js --help` ne suffit pas
mais un `loadConfig` échouerait franchement, à l'endroit et au moment où
l'opérateur regarde encore l'écran. Obtenu : trois chemins de mise à jour sur
trois qui perdent soit le code, soit le réglage, soit le démon, chacun sous un
message de succès.

## La plage livrée par le dépôt est une plage personnelle, active dès la première installation

**Gravité** : sûr
**Où** : `unused.config.json:18-26`, `src/config.ts:32`

Le schéma est explicite sur l'intention : `windows: z.array(WindowSpecSchema).default([])`
(`src/config.ts:32`) — sans plage déclarée, le démon ne travaille que sur
`unused start`. Le fichier versionné contredit ce défaut :

```json
  "windows": [
    { "days": ["mon"], "from": "00:00", "to": "13:00" }
  ],
```

Treize heures, tous les lundis. `git log --oneline -- unused.config.json`
montre qu'elle arrive avec le commit « Quota exact, pannes globales, plages
automatiques » : c'est la plage de travail de l'auteur, pas un gabarit neutre.

Rien dans le code ne la neutralise : `calendarEnd` la lit telle quelle
(`src/daemon.ts:123-129`), et une plage calendaire suffit à faire tourner des
itérations — `deadline()` ne réclame aucune plage manuelle
(`src/daemon.ts:116-122`). Rien non plus ne la signale à l'installation :
`install.sh` avertit pour un `.env` manquant (ligne 49) mais jamais pour une
plage active, et le README présente les plages comme quelque chose qu'on
ajoute (`README.md:84-87` : « Dans `unused.config.json`, en heure locale de la
machine », suivi d'un exemple *différent* de ce que le fichier contient
réellement — nuits de semaine + dimanche).

**Scénario concret.** Quelqu'un suit `README.md:26-45` un mercredi :
`git clone`, `npm run build`, `.env`, `unused docker build`, service activé. Il
n'a lancé aucun `start` et ne compte pas en lancer avant d'avoir écrit une
première tâche. Le lundi suivant à 00:00, le démon ouvre une plage de 13 h tout
seul et commence à lancer des containers `claude -p
--dangerously-skip-permissions` (`unused.config.json:5-9`) sur son abonnement,
jusqu'à 13:00 ou jusqu'au quota. Attendu : `"windows": []` dans le fichier
livré, conformément au défaut du schéma, la plage de l'auteur restant dans le
README comme exemple. Obtenu : une plage héritée, que B du constat précédent
réimpose en prime à chaque fois qu'on remet le fichier à l'état du dépôt pour
débloquer un `git pull`.

## Un build qui échoue laisse `dist/` écrasé mais le service en vie : la bascule sur le code cassé est différée au prochain incident

**Gravité** : probable
**Où** : `deploy/install.sh:32-33`, `tsconfig.json` (absence de
`noEmitOnError`), `deploy/unused.service:18-19`

```sh
# deploy/install.sh:31-34
cd "$DIR"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
```

`npm run build` est `tsc` (`package.json`), et `tsconfig.json` ne pose pas
`noEmitOnError` — dont la valeur par défaut est `false`. `tsc` écrit donc ses
`.js` dans `dist/` **puis** sort en code 2 sur erreur de types. Rien n'efface
`dist/` au préalable (aucun `rm -rf dist` dans le script, et `dist/` est
`.gitignore`d donc git ne le restaure jamais) : les fichiers compilables sont
remplacés par la nouvelle version, ceux qui ne le sont pas restent dans leur
état précédent. `dist/` devient un mélange des deux versions.

`set -euo pipefail` (ligne 9) fait alors sortir le script à la ligne 33 —
**avant** `systemctl restart` (ligne 68). C'est exactement l'inverse de ce que
l'opérateur en conclut : il voit l'erreur de `tsc`, le script s'arrêter, et
`systemctl status unused` lui montre un service `active (running)` depuis des
heures. Il en déduit, raisonnablement, que la mise à jour n'a pas pris et que
la machine tourne toujours sur l'ancienne version. C'est vrai du processus —
tous les modules sont chargés au démarrage, 024 l'a vérifié (`grep 'import('`
sur `src/*.ts` ne rend aucun import dynamique) — mais plus du disque.

**Scénario concret.** Il n'y a aucune CI dans ce dépôt (`.github/` n'existe
pas) : rien ne garantit qu'un commit poussé passe `tsc`. L'amont pousse un
commit qui ne compile pas ; sur le Pi, `git pull && sudo deploy/install.sh`
s'arrête sur l'erreur `tsc`. L'opérateur remet la correction à plus tard et ne
touche à rien. Le service continue de tourner normalement. Puis, à un moment
quelconque — coupure de courant, `reboot` après un `apt upgrade`, ou n'importe
lequel des redémarrages automatiques que `Restart=always` / `RestartSec=5`
provoque (`unused.service:18-19`) — systemd relance
`/usr/bin/node /opt/unused/dist/cli.js daemon` sur le `dist/` mi-ancien
mi-nouveau. Au mieux il meurt tout de suite en boucle, au pire il démarre et
exécute un mélange de deux versions sur l'état `data/state.json` ; le wrapper
`/usr/local/bin/unused` (ligne 57) fait courir le même risque à la CLI. Le
délai entre l'échec visible et la panne peut se compter en semaines, ce qui
détruit le lien de cause à effet.

Attendu : `noEmitOnError: true` dans `tsconfig.json`, ou une compilation dans
un répertoire temporaire permutée seulement en cas de succès, pour que
« `install.sh` s'est arrêté » veuille dire « rien n'a bougé ». Gravité
« probable » et non « sûre » parce que je n'ai pas pu exécuter `tsc` ici pour
observer l'émission sur erreur : le constat repose sur la valeur par défaut
documentée de `noEmitOnError` et sur la lecture du script.

## Ce qui a été vérifié et tient

- **`chmod -R g+rX,o-rwx "$DIR"` (ligne 41) et le droit d'écriture du démon sur
  `data/`.** J'ai d'abord cru à une fenêtre, pendant la récursion sur
  `node_modules`, où le démon encore vivant perdrait l'écriture sur `data/`
  (`saveState`, `src/state.ts:78-84`). C'est faux : `g+rX` est **additif** et ne
  retire pas le `w` du groupe, que `chmod 770 data tasks` (ligne 44) avait posé
  à l'installation précédente. Même conclusion que 024 ; il n'y a pas de course
  ici.
- **Le socket pendant la mise à jour.** `listen` fait `unlink` puis
  `chmodSync(sock, 0o660)` à chaque démarrage (`src/api.ts:146-154`) : quoi que
  `install.sh` fasse au fichier de socket existant, il est recréé proprement au
  redémarrage de la ligne 68. Rien à signaler.
- **`npm ci` + `npm prune` sous un démon vivant** (lignes 32-34) : sans danger
  pour le processus en cours, déjà établi en 024 (aucun import dynamique). Le
  constat 3 ci-dessus porte sur une autre question — l'état laissé *sur le
  disque* après un échec, pas la survie du processus.
- **`package-lock.json` est versionné** et `npm ci` s'y tient : les plages `^`
  de `package.json` ne peuvent pas faire remonter une version de `typescript`
  ou de `@types/node` à l'improviste pendant une mise à jour. Ce n'est donc pas
  une cause plausible d'échec de build ; le constat 3 n'en a pas besoin.
- **Fichiers orphelins dans `dist/`.** `tsc` ne supprime pas la sortie d'un
  `src/*.ts` disparu, et `install.sh` ne nettoie jamais `dist/`. Mais en
  `module: NodeNext` tous les imports sont explicites et statiques : un
  `dist/vieux.js` orphelin n'est référencé par personne. Pas de défaut
  démontrable, seulement de l'encombrement.
- **`exclude: ["src/**/*.test.ts"]`** (`tsconfig.json`) est cohérent avec
  `npm prune --omit=dev` : les tests ne sont pas compilés, donc `dist/` ne
  référence pas `vitest`, retiré juste après. Pas de module manquant à
  l'exécution de ce fait.
- **`rootDir: "src"` / `bin: "./dist/cli.js"`** concordent : `src/cli.ts` sort
  bien en `dist/cli.js`, le chemin que l'unité (`unused.service:17`) et le
  wrapper (`install.sh:57`) codent en dur.
- Le reste de `deploy/install.sh` sous l'angle de l'*installation* (`.env` et
  `EnvironmentFile`, version de node et `/usr/bin/node`, `UNUSED_SOCKET` et les
  shells non-login, `dataDir` non standard) est déjà traité en 024 et n'est pas
  repris ici. La validation du schéma de config (clés inconnues avalées, config
  figée pour la vie du démon) est traitée en 028.
