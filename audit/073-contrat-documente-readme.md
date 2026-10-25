# 073 — Le contrat documenté : installation manuelle du README et règle « rejoué tant que DONE »

**Fichiers examinés** : `README.md:26-45,70-81,113-128`, `src/scaffold.ts:5-14,16-42,44-86,88-103`,
`deploy/install.sh:19-62` (ce que le README refait à la main), `deploy/unused.service:11-23`,
`src/graph.ts:64-111`, `src/iterate.ts:80-112,151-190`, `src/api.ts:14-16,144-155`,
`src/state.ts:61-84`, `src/task.ts:28-67,85-106`, `src/claude.ts:15-18`, `package.json:7-9`,
`.gitignore`.
Vérifications faites dans ce container : `bind()` d'un socket Unix dans un
répertoire absent (ENOENT) et dans un répertoire non inscriptible (EACCES),
par `perl`/`setpriv` — aucun interpréteur node n'est disponible ici.

**Verdict** : 3 constats (3 sûrs)

## 1. La séquence d'installation du README ne produit jamais la commande `unused` dont elle se sert deux lignes plus loin

**Gravité** : sûr
**Où** : `README.md:28-45` et `README.md:113-120`, contre `deploy/install.sh:52-59`

Le README décrit une installation manuelle complète, et elle s'arrête au build :

```
git clone … /opt/unused && cd /opt/unused
npm install && npm run build
claude setup-token
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…" > .env
```

puis, immédiatement après l'installation du service (`README.md:43-45`) :

> Puis, une seule fois : `unused docker build` (l'image de base…) et
> `unused docker check`…

et toute la section « Piloter » (`README.md:115-120`) : `unused start --for 8h`,
`unused status`, `unused stop`, `unused tasks list | reset | activate`.

Rien dans cette séquence ne met `unused` sur le `PATH`. `package.json:7-9`
déclare bien `"bin": {"unused": "./dist/cli.js"}`, mais un `npm install` lancé
*dans* le paquet ne lie que les `bin` de ses **dépendances** dans
`node_modules/.bin` ; le `bin` du paquet racine n'est installé que par
`npm link` ou `npm install -g`, et le README ne fait ni l'un ni l'autre.
`node_modules/.bin` n'est de toute façon pas dans le `PATH` d'un shell.

Le seul endroit du dépôt qui crée cette commande est `deploy/install.sh:54-59` :

```sh
rm -f /usr/local/bin/unused  # un ancien lien symbolique écrirait dans dist/
cat > /usr/local/bin/unused <<WRAPPER
#!/bin/sh
exec node "$DIR/dist/cli.js" "\$@"
WRAPPER
chmod 755 /usr/local/bin/unused
```

…et `README.md` ne mentionne `deploy/install.sh` **nulle part**
(`grep -n "install.sh" README.md` : rien). Le script qui fait le travail existe,
est documenté dans son propre en-tête (`install.sh:1-8`), et le mode d'emploi
officiel conduit à côté.

**Scénario concret.** Opérateur qui suit `README.md:28-41` à la lettre sur un Pi :
clone, `npm install && npm run build`, `.env`, `useradd`, `cp deploy/unused.service`,
`systemctl enable --now unused`. Il enchaîne sur la ligne 43 :

```
$ unused docker build
bash: unused: command not found
```

Attendu : l'image de base est construite une fois pour toutes. Obtenu : aucune
des commandes du README n'est exécutable. Et comme `unused docker build` est
précisément l'étape qui crée `unused-base`, l'image de départ de toute
itération (`src/docker.ts:100-105` : `resolveTaskImage` retombe sur
`cfg.docker.baseImage`), le démon — lui, bien lancé par systemd — part en
plage, lance `docker run unused-base`, n'obtient aucune sortie JSON, classe
l'itération en `failure: unreadable_output` (`src/iterate.ts:150-159`,
`src/graph.ts:52`), rejoue trois fois (`maxConsecutiveFailures: 3`) et sort la
tâche de la file en `failed` (`src/graph.ts:96-102`). Le diagnostic réel
(« l'image de base n'a jamais été construite ») n'apparaît nulle part, et le
contournement — `node dist/cli.js docker build` depuis `/opt/unused` — n'est
documenté qu'à la ligne 35, pour le démon seulement.

Noter aussi que le contournement « naturel » que l'opérateur tentera, un lien
symbolique `/usr/local/bin/unused → /opt/unused/dist/cli.js`, est précisément
celui que `install.sh:52-54` écarte en commentaire (« tsc ne pose pas le bit
exécutable » ; et `chmod +x` sur le lien modifierait `dist/`).

## 2. Le README crée l'utilisateur du service mais ne lui donne aucun droit d'écriture : le démon qu'il fait démarrer ne peut rien écrire

**Gravité** : sûr
**Où** : `README.md:37-41`, contre `deploy/install.sh:36-44`

```
sudo useradd -r -G docker -d /opt/unused unused
sudo cp deploy/unused.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now unused
```

C'est tout ce que le README dit des droits. Or le dépôt a été cloné par le
compte qui administre (`git clone … /opt/unused`, ligne 29 — avec `sudo` pour
écrire dans `/opt`, donc `root:root`, `umask` 0022), tandis que l'unité fait
tourner le démon en `unused:docker` (`deploy/unused.service:13-14`). Le démon a
besoin d'écrire dans deux arborescences :

- `<dataDir>` = `/opt/unused/data` : le socket (`src/api.ts:14-16,149`),
  `state.json` (`src/state.ts:78-83`), les journaux (`src/log.ts:42-66`) ;
- `<tasksDir>` = `/opt/unused/tasks` : le squelette de `tasks new`
  (`src/scaffold.ts:95-101`) et `exchange/` (`src/docker.ts:133`).

`install.sh` est le seul à les ouvrir, et il le dit explicitement
(lignes 36-44) :

```sh
# Le code appartient au compte qui déploie (git pull sans sudo) ; le service ne
# peut que le lire. Seuls data/ et tasks/ lui sont ouverts en écriture.
OWNER=$(stat -c %U "$DIR/package.json")
mkdir -p data tasks
chown -R "$OWNER:$GROUP_NAME" "$DIR"
chmod -R g+rX,o-rwx "$DIR"
chown -R "$USER_NAME:$GROUP_NAME" data tasks
chmod 770 data tasks
```

Le README ne reprend ni le `mkdir -p`, ni les deux `chown`, ni le `chmod 770`.

**Scénario concret.** Le cas « répertoire absent » (`data/` est gitignoré,
`.gitignore:3`) est déjà rapporté en **010** : `bind()` échoue en `ENOENT` et
l'unité boucle. Le constat ici est celui d'après : l'opérateur, face au message
`listen ENOENT /opt/unused/data/unused.sock`, fait le geste évident —
`sudo mkdir /opt/unused/data` — et reste bloqué, parce que le répertoire
appartient à `root` en 0755 :

```
$ setpriv --reuid=65534 --regid=65534 --clear-groups perl -e '… bind(…, "/tmp/rootdir/unused.sock") …'
bind failed: Permission denied
$ setpriv --reuid=65534 --regid=65534 --clear-groups sh -c 'echo x > /tmp/rootdir/state.json'
sh: 1: cannot create /tmp/rootdir/state.json: Permission denied
```

(`/tmp/rootdir` : `root:root 0755`, exactement la situation produite par les
commandes du README.) Le démon meurt alors sur `listen EACCES`, relancé toutes
les 5 secondes par `Restart=always` (`unused.service:18-19`). Même en passant
l'étape du socket (par exemple via `-s`), `saveState` (`src/state.ts:79-83`) et
`writeIterationLog` (`src/log.ts:44-47`) échoueraient à la première itération,
et `unused tasks new` échouerait dans `scaffoldTask` (`src/scaffold.ts:95`) —
remonté au client en `409` « conflit » par `src/api.ts:76-80`, ce qui désigne
une cause fausse.

Attendu d'une section « Installation » qui va jusqu'à `systemctl enable --now` :
un service qui démarre. Obtenu : un service en boucle de redémarrage dont la
cause (propriétaire de `data/` et `tasks/`) n'est écrite que dans un script que
le README ne nomme pas.

## 3. « Un skill est rejoué tant qu'il n'a pas créé `/exchange/DONE` » : le curseur avance à chaque session réussie, et DONE termine la tâche entière

**Gravité** : sûr
**Où** : `README.md:76-77` et `src/scaffold.ts:32-37`, contre `src/graph.ts:81-91`

La règle est donnée en une phrase, deux fois — dans le README et, mot pour mot,
dans le `README.md` que `tasks new` dépose dans chaque tâche :

```
La règle, en une phrase : **un skill est rejoué tant qu'il n'a pas créé
`/exchange/DONE`.**                                      (README.md:76-77)

Un skill est rejoué tant qu'il n'a pas créé \`/exchange/DONE\`. (scaffold.ts:34)
```

Le code ne connaît pas cette règle. Une session qui se termine en `completed`
fait avancer le curseur sans condition, et DONE ne « rejoue » rien du tout : il
sort la tâche de la file :

```ts
// src/graph.ts:82-91
case "completed": {
  ts.iterations += 1;
  ts.consecutiveFailures = 0;
  if (outcome.done) {
    ts.status = "done";
    return "task-done";
  }
  ts.cursor = task.def.nodes[node]!.next;
  return "next-task";
}
```

Les deux moitiés de la phrase sont fausses :

- **l'unité de rejeu n'est pas le skill, c'est l'arête du graphe.** Un skill
  n'est rejoué que si le `next` de son nœud le ramène sur lui-même, ou quand le
  cycle y revient. Le seul rejeu « sur place » qu'implémente le code est celui
  des issues `retry`, `backoff` et `stop-window` (`src/graph.ts:92-103`) —
  c'est-à-dire exactement les cas où l'itération est *réputée n'avoir jamais eu
  lieu*. Un skill n'a aucun moyen de demander à être rejoué : rien de ce qu'il
  écrit n'est lu par le runner, sauf DONE (`README.md:20-22`, respecté par
  `src/iterate.ts:151`) ;
- **DONE ne termine pas le skill, il termine la tâche.** `ts.status = "done"`
  la rend définitivement inéligible (`src/graph.ts:107-111` : `isEligible`
  n'accepte que `running`) ; il faut un `unused tasks reset` pour la ressortir.

**Scénario concret, avec la tâche que `tasks new` livre.** `scaffold.ts:5-14`
écrit ce graphe :

```js
nodes: {
  setup: { skill: "setup", next: "work" },
  work:  { skill: "work",  next: "work" },
}
```

et `scaffold.ts:44-63` écrit un skill `setup` qui a trois choses à faire —
installer les paquets manquants, cloner le dépôt, rédiger `/work/PLAN.md` — et
à qui il est **interdit** de créer DONE :

> Ne crée pas /exchange/DONE : la tâche ne fait que commencer.

Lu avec la règle de la ligne 34 du même dossier (« rejoué tant qu'il n'a pas
créé DONE »), cela décrit un skill qui sera rejoué jusqu'à ce qu'il ait fini.
Ce que fait le code : `setup` est exécuté dans **exactement une** itération de
toute la vie de la tâche ; dès qu'elle rend `completed`, le curseur passe à
`work`, dont le `next` est `work` — `setup` ne reviendra jamais. Si cette
session unique s'est terminée normalement sans avoir écrit `/work/PLAN.md`
(elle a cloné, installé, et jugé avoir fini), la session suivante exécute un
skill `work` dont la première instruction est « Lis /work/PLAN.md et prends la
première case non cochée » (`scaffold.ts:77`) sur un fichier absent, et cela
pour toutes les itérations suivantes.

Symétriquement, l'opérateur qui lit la phrase à l'envers — « pour que `setup`
cesse d'être rejoué et qu'on passe à `work`, il crée DONE » — obtient une tâche
en `status: "done"` après sa première session, sortie de la file, affichée par
`unused status` comme terminée avec succès alors qu'elle venait de commencer.

Le README se contredit d'ailleurs lui-même à vingt lignes d'écart : la ligne 15
énonce la règle juste (« La seule sortie : le skill crée `/exchange/DONE`
**quand il juge la tâche terminée** »), la ligne 76 la résume faux. Ni le
README ni le squelette ne disent nulle part la seule phrase qui compte :
*une session réussie fait passer le curseur au nœud `next`.*

## Ce qui a été vérifié et tient

- **`data/` absent au premier démarrage** (`bind` → ENOENT, boucle
  `Restart=always`) : déjà rapporté en **010**, sous le même angle README. Le
  constat 2 ci-dessus ne le redouble pas : il porte sur les droits, c'est-à-dire
  sur ce qui reste cassé *après* avoir créé le répertoire.
- **`deploy/install.sh` lui-même** (version de node, `EnvironmentFile`,
  `UNUSED_SOCKET` et `/etc/profile.d`, `dataDir` non standard) : couvert par
  **024** ; droits du squelette de tâche par **016** ; `unused.config.json`
  versionné par **066**. Rien ajouté ici.
- **DONE qui traîne** : `src/iterate.ts:108-110` supprime
  `<exchange>/DONE` avant chaque session, et les chemins d'échec le
  re-suppriment (`:181,186`). Un `tasks reset` sur une tâche qui avait créé DONE
  ne peut donc pas la refaire terminer immédiatement. Le cycle de vie du
  sentinelle est par ailleurs traité en **014**.
- **Droits du socket** vus du README : l'unité pose `Group=docker`
  (`unused.service:14`), donc le groupe primaire du démon est `docker` et le
  `chmodSync(sock, 0o660)` de `src/api.ts:154` suffit à rendre le socket
  connectable aux comptes humains du groupe. Le `useradd -r -G docker` du README
  (groupe supplémentaire) ne change rien à cela. Pas de défaut de ce côté.
- **Le reste du `README.md` déposé par `tasks new`** (`scaffold.ts:16-42`) est
  fidèle au schéma : `active`/`start`/`params`/`env`/`nodes` existent avec ces
  noms et ces valeurs par défaut (`src/task.ts:41-48`), la sémantique `"NOM"` /
  `"NOM=valeur"` est bien celle de `resolveEnv` (`src/task.ts:89-106`), le token
  Claude est bien toujours ajouté (`src/iterate.ts:125`), les `params` de nœud
  sont bien fusionnés par-dessus ceux de la tâche (`src/claude.ts:16`), et les
  skills sont bien montés en lecture seule (`src/iterate.ts:127`), ce qui rend
  vraie l'affirmation « tu peux les modifier entre deux itérations »
  (`README.md:73-74`).
- Deux inexactitudes mineures relevées mais non retenues comme constats, faute
  de conséquence démontrable : `README.md:115-120` ne liste pas `unused tasks
  new`, alors que le squelette qu'il produit s'annonce « Créée par `unused
  tasks new` » (`scaffold.ts:18`) ; et le commentaire de
  `src/config.ts:14-16` promet `--output-format json` là où `buildCommand`
  impose `stream-json --verbose` (`src/claude.ts:20-23`).
