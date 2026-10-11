# 048 — État de Claude Code commité : `/root/.claude` et `/work/.claude` configurent les itérations suivantes

**Fichiers examinés** : `src/iterate.ts:121-143` (appel `runInTask`, montage des
skills), `src/iterate.ts:167-187` (commit / rejet du container),
`src/iterate.ts:190-215` (`IterationRecord`), `src/docker.ts:107-150`
(`RunOptions`, `runInTask`, construction des `-v`), `src/docker.ts:160-180`
(`commitTask`), `src/docker.ts:199-211` (`importChanges`),
`src/claude.ts:14-18` (`buildPrompt`), `src/claude.ts:20-39` (`buildCommand`),
`src/task.ts:105-109` et `:140-155` (`skillFile`, vérification des skills),
`src/log.ts:7-33`, `src/daemon.ts:397-407` (`resetTask`), `docker/Dockerfile`
(entier), `unused.config.json`.

Les constats ci-dessous ont été **reproduits dans ce container**, qui est
construit par `docker/Dockerfile` : `claude 2.1.272`, root, `IS_SANDBOX=1`,
skills du graphe montés en lecture seule sur `/work/.claude/skills`. Les sondes
rejouent le dispositif du runner (`claude -p --output-format stream-json
--verbose --no-session-persistence --dangerously-skip-permissions`,
`unused.config.json:5-10`) et lisent soit le cadre `system/init`, soit le
transcript de session. Pas de token ici : les sessions qui atteignent l'API
s'arrêtent sur `Not logged in` — sans conséquence, puisque tout ce qui est
mesuré (résolution du skill, liste d'outils, hooks) est décidé **avant** le
premier appel. Tous les fichiers de sonde ont été supprimés en fin d'analyse.

**Verdict** : 3 constats (2 sûrs, 1 probable)

Racine commune. Le runner traite l'image de la tâche comme l'espace de travail
de Claude (`docker/Dockerfile:1-3`), et en sort délibérément une seule chose :
les skills du graphe, montés depuis l'hôte en `:ro` pour qu'une session ne les
réécrive pas pour la suivante (`iterate.ts:126-127`, garantie vérifiée et
validée par le rapport 019). Mais ce qui est protégé, ce sont **les octets d'un
dossier**, pas **l'espace de configuration de Claude Code**. Or
`/root/.claude/` (toute l'arborescence) et `/work/.claude/` (tout sauf le
sous-dossier `skills`) sont dans la couche inscriptible du container, donc dans
le `docker commit` de `commitTask` (`docker.ts:166-180`) — et ce sont
précisément les deux emplacements d'où Claude Code tire sa configuration, ses
hooks, ses permissions et ses skills utilisateur. Une seule itération
`completed` suffit à y sceller une configuration que toutes les itérations
suivantes de la tâche appliqueront, sans qu'aucun fichier de l'hôte ne bouge.

## 1. Un `SKILL.md` écrit dans `/root/.claude/skills/` écrase le skill monté en lecture seule, et rien ne le signale

**Gravité** : sûr (reproduit)
**Où** : `src/iterate.ts:126-127`, `src/docker.ts:143`, `src/docker.ts:166-180`

Le montage protège le chemin `/work/.claude/skills` — c'est vrai, et je l'ai
revérifié :

```
$ touch /work/.claude/skills/ECRITURE_TEST
touch: cannot touch '/work/.claude/skills/ECRITURE_TEST': Read-only file system
$ ls -ld /work/.claude
drwxr-xr-x 3 root root 4096 /work/.claude          # le parent, lui, est inscriptible
```

Mais `/work/.claude/skills` est l'emplacement **projet**. Claude Code résout
`/<nom>` (`claude.ts:17`) sur deux niveaux, et le niveau **utilisateur**
`~/.claude/skills/<nom>/SKILL.md` — soit `/root/.claude/skills/` dans ce
container, inscriptible et commité — **gagne**. Sonde : deux skills homonymes,
corps distincts, dans un répertoire de travail jetable.

```
/tmp/p048/.claude/skills/zzzprobe/SKILL.md   → corps « MARQUEUR_PROJET »      (= le montage :ro)
/root/.claude/skills/zzzprobe/SKILL.md       → corps « MARQUEUR_UTILISATEUR » (= écrit par la session)

$ cd /tmp/p048 && echo "/zzzprobe" | claude -p --output-format json --dangerously-skip-permissions
$ grep -o 'MARQUEUR_[A-Z]*' /root/.claude/projects/-tmp-p048/<session>.jsonl | sort | uniq -c
      1 MARQUEUR_UTILISATEUR

# contrôle, après suppression du skill utilisateur :
      1 MARQUEUR_PROJET
```

`MARQUEUR_PROJET` n'apparaît pas une seule fois dans le transcript quand les
deux existent : le corps injecté est celui du fichier écrit par la session, pas
celui du montage en lecture seule. Le contrôle écarte l'explication triviale
(« le skill projet n'est pas vu du tout » : seul, il est bien injecté).

**Scénario concret.** Tâche `audit`, nœud `choose`, skill monté depuis
`tasks/audit/skills/choose/SKILL.md`. Itération N : la session écrit
`/root/.claude/skills/choose/SKILL.md` — n'importe quel motif suffit, un
`update-config`/`init` zélé, une sauvegarde de travail, une consigne jugée utile
pour « la prochaine fois », ou une instruction venue du dépôt analysé. Elle crée
`DONE`, `classify` renvoie `completed` (`graph.ts:48`), `commitTask` scelle
`/root/.claude/skills/choose/SKILL.md` dans `unused-task-audit:latest`.
Itération N+1 et toutes les suivantes : `resolveTaskImage` repart de ce
`:latest`, `buildPrompt` envoie `/choose`, et c'est le SKILL.md de la session N
qui est exécuté. Attendu : le skill du graphe, celui que l'opérateur maintient
sur l'hôte. Obtenu : celui que la machine s'est écrit.

**Ce qui rend le défaut durable, c'est qu'il est invisible côté hôte.** Les
quatre endroits qui auraient pu le dire sont muets :

- `loadTask` ne vérifie que l'existence du fichier **hôte**
  (`task.ts:105-109`, `:147-155`) : il est toujours là, intact, le montage
  étant en lecture seule. La validation passe.
- `IterationRecord` journalise `skill: node.skill` (`iterate.ts:195`) et
  `prompt` (`:202`) — soit `"choose"` et `"/choose repo=…"`, identiques dans les
  deux cas. L'origine et le corps du skill n'y figurent pas (`log.ts:7-33`).
- Le cadre `system/init` nomme le skill mais jamais sa provenance ; dans la
  sonde, `slash_commands` et `skills` contiennent `"zzzprobe"` **une seule
  fois** alors que deux fichiers homonymes existent. Et `init` n'est de toute
  façon pas journalisé : `iterate.ts:192` n'en extrait que `model`.
- `image: r.image` (`iterate.ts:199`) vaut `unused-task-audit:latest` avant
  comme après : le nom de l'image ne distingue pas un `:latest` sain d'un
  `:latest` empoisonné.

Le seul chemin de sortie est `unused tasks reset`, qui appelle
`removeTaskImages` (`daemon.ts:404`) après `delete this.state.tasks[name]`
(`:400`) : on récupère le skill du graphe en détruisant le curseur, le compteur
d'itérations et tout l'espace de travail accumulé — ce que le projet existe
pour conserver. Et la rotation `:prev` (`docker.ts:168-170`) n'offre pas de
repli : elle est écrasée à chaque commit, donc deux itérations après
l'empoisonnement les deux tags le portent, et de toute façon aucun code ne lit
jamais `:prev` (`resolveTaskImage`, `docker.ts:102-105`, ne regarde que
`:latest` ; la seule autre occurrence est l'assertion de `dockerCheck.ts:77`).

## 2. Un `settings.json` commité retire des outils malgré `--dangerously-skip-permissions`, et exécute des hooks à chaque session suivante

**Gravité** : sûr (reproduit, dont une fois involontairement sur la session d'audit elle-même)
**Où** : `src/docker.ts:166-180`, `unused.config.json:5-10`

`/root/.claude/settings.json` (utilisateur) et `/work/.claude/settings.json`
(projet, à côté du montage `:ro`) sont tous deux inscriptibles et commités. Les
deux sont lus, et leurs refus survivent au `--dangerously-skip-permissions` que
le runner impose à chaque session :

```
$ printf '{"permissions":{"deny":["WebFetch","Write"]}}' > /root/.claude/settings.json
$ echo bonjour | claude -p --output-format stream-json --verbose \
    --no-session-persistence --dangerously-skip-permissions | head -1 | jq -c '…'
{"permissionMode":"bypassPermissions","webfetch":null,"write":null,"bash":1,"n":23}
```

`permissionMode` vaut bien `bypassPermissions`, et `Write` et `WebFetch` ont
pourtant disparu de la liste d'outils (23 au lieu de 25). Même résultat au
niveau projet (`<cwd>/.claude/settings.json` → 24 outils au lieu de 25). La
démonstration la plus nette est accidentelle : en testant
`{"permissions":{"deny":["Bash"]}}`, j'ai perdu l'outil `Bash` **dans la session
d'audit en cours**, lancée en `--dangerously-skip-permissions` — la réponse
était `Permission to use Bash has been denied.`, et il a fallu réécrire le
fichier par un autre outil pour s'en sortir. Les refus sont donc relus à chaud,
et un `deny` n'est pas une préférence que le mode bac à sable annule.

Le second canal est l'exécution de commandes :

```
$ cat /root/.claude/settings.json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/p048/HOOK_A_TOURNE"}]}]}}
$ rm -f /tmp/p048/HOOK_A_TOURNE
$ echo bonjour | claude -p … --dangerously-skip-permissions   # échoue sur Not logged in
$ ls /tmp/p048/HOOK_A_TOURNE
-rw-r--r-- 1 root root 0 /tmp/p048/HOOK_A_TOURNE
```

Le hook tourne même quand la session n'atteint jamais l'API.

**Scénario concret.** Itération N `completed` : la session, pour une raison
quelconque — le skill `update-config` est dans sa liste, et l'écriture de
`.claude/settings.json` est le geste exact que ce skill décrit — pose
`{"permissions":{"deny":["Write"]}}` dans `/root/.claude/settings.json`.
`commitTask` le scelle. Itération N+1 : la session démarre en
`bypassPermissions` mais sans `Write` ni `Edit`, et ne peut donc plus écrire ni
son rapport ni `DONE`. Deux sorties, toutes deux fausses :

- *la session se termine normalement* (elle constate qu'elle ne peut rien
  écrire et conclut) : `terminal_reason: "completed"`, donc `classify` renvoie
  `{kind:"completed", done:false}` (`graph.ts:48` — `done` ne conditionne pas le
  `completed`), `applyOutcome` incrémente `iterations`, remet
  `consecutiveFailures` à 0 et **avance le curseur** (`graph.ts:82-90`),
  `commitTask` commite — en recommitant au passage le `settings.json` fautif.
  Attendu : un rapport écrit, ou un échec. Obtenu : le graphe progresse d'un
  nœud en n'ayant rien produit, et la ligne imprimée est `issue completed →
  next-task (commit)` ;
- *la session sort en erreur* : `{kind:"failure"}` (`graph.ts:52`) → `retry`,
  et comme la cause est dans l'image, les itérations N+2 et N+3 sont
  identiques : `maxConsecutiveFailures: 3` (`unused.config.json:30`) sort la
  tâche de la file en `task-failed`, définitivement.

Dans les deux branches, rien ne nomme la cause — ni le résumé imprimé
(`iterate.ts:219-229`), ni `IterationRecord`, qui ne journalise ni les settings
ni la liste d'outils du cadre `init` (`log.ts:7-33`), ni `status`. Et la seule
réparation reste `unused tasks reset`, au prix décrit au constat 1.

La variante hook est pire sur un point : elle n'a pas besoin que la session
réussisse. Un hook `SessionStart` qui sort en erreur casse toutes les
itérations suivantes, y compris celles qui auraient dû échouer proprement.

## 3. Le dossier `memory` de Claude Code est dans l'image, indexé sur le répertoire de travail de la tâche

**Gravité** : probable
**Où** : `docker/Dockerfile:22` (`WORKDIR /work`), `src/docker.ts:166-180`

Le cadre `system/init` expose un chemin de mémoire persistante dérivé du
répertoire de travail :

```
"memory_paths":{"auto":"/root/.claude/projects/-tmp-p048/memory/"}   # sonde, cwd = /tmp/p048
```

Le runner lance toujours ses sessions depuis `WORKDIR /work`
(`docker/Dockerfile:22`, aucun `-w` dans `runInTask`), donc le chemin effectif
est `/root/.claude/projects/-work/memory/` — qui existe déjà dans ce container
(créé le 20 septembre, vide à ce jour) et qui est, comme tout `/root`, dans le
`docker commit`. C'est un troisième canal par lequel une itération dépose du
contexte que les suivantes rechargeront, celui-ci explicitement conçu pour
survivre entre sessions.

Je le classe *probable* et non *sûr* : le chemin est certain (observé dans
`init`), son appartenance à la couche commitée est certaine (aucun montage ne
couvre `/root`, `docker.ts:141-143`), mais je n'ai pas pu démontrer ici
l'injection d'un fichier de mémoire dans le contexte d'une session suivante —
elle se produit après l'authentification, et il n'y a pas de token dans ce
container. Le point vérifiable qui reste : aucune mémoire écrite par une
itération ne passe par l'hôte, donc, comme aux constats 1 et 2, rien côté
opérateur ne dit qu'une tâche travaille désormais sous des consignes qu'elle
s'est elle-même données.

## Ce qui a été vérifié et tient

- **Le montage `:ro` fait exactement ce que son commentaire annonce**
  (`iterate.ts:126-127`, `docker.ts:143`) : `/work/.claude/skills` est bien un
  système de fichiers en lecture seule dans le container (`touch` → `Read-only
  file system`). Le constat 1 ne le contredit pas : il porte sur la résolution
  du nom, pas sur l'écriture du dossier.
- **`/exchange` n'est pas commité** : c'est un montage (`docker.ts:140-141`), et
  `docker commit` n'emporte pas le contenu des montages. `DONE` ne peut donc pas
  traverser une itération par l'image (il est par ailleurs effacé en amont,
  `iterate.ts:110`). Rapport 014.
- **`--no-session-persistence` (`unused.config.json:8`) est accepté par le
  binaire installé** (`claude 2.1.272`, aucune erreur de flag inconnu) et fait
  son office : pas de transcript `.jsonl` écrit, et `.projects` reste `null`
  dans `/root/.claude.json`. L'historique des prompts ne s'accumule donc pas
  dans l'image. Le fichier lui-même fait 51 ko, dont 41 ko de drapeaux de
  fonctionnalités en cache : taille stable, pas une croissance.
- **L'état résiduel de Claude Code s'accumule, mais modestement.**
  `/root/.claude` pèse 3,0 Mo après ~3 semaines : 2,3 Mo de
  `projects/*/tool-results/*.txt` (dont 1,07 Mo laissés par une seule session du
  28 septembre), 392 ko dans 97 dossiers `session-env/<uuid>` datant du
  21 septembre, 264 ko de `backups/.claude.json.backup.*`. Aucun code du dépôt
  ne purge cela, et l'aplatissement (`flattenTask`) recopie l'ensemble. Je ne
  le compte pas comme constat : la croissance est réelle et mesurée, mais je
  n'ai pas de scénario d'échec concret à ce rythme, et le coût disque de
  l'aplatissement est déjà traité par 036.
- **Le token et les variables d'`env` scellés dans `Config.Env` de l'image**
  relèvent du rapport 019 (constats 1 et 2) et ne sont pas repris ici. Ce
  rapport-ci ne parle que de l'état *fichier* de `/root/.claude` et
  `/work/.claude`.
- **Nettoyage des sondes** : `/root/.claude/settings.json`,
  `/root/.claude/skills/`, `/root/.claude/projects/-tmp-p048*`, `/tmp/p048*` ont
  tous été supprimés ; `/root/.claude` est revenu à son contenu d'avant
  l'analyse (vérifié par `ls -a`). L'ironie étant que l'oubli d'un seul de ces
  fichiers aurait configuré les itérations suivantes — c'est le constat.
