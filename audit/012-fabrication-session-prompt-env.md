# 012 — Fabrication de la session : prompt, arguments `claude`, environnement

**Fichiers examinés** : `src/claude.ts:1-38` (`renderArguments`, `buildPrompt`,
`buildCommand`), `src/task.ts:27-67` (schémas `env`/`params`/nœuds),
`src/task.ts:85-106` (`resolveEnv`), `src/task.ts:147-160`,
`src/iterate.ts:84-147` (fabrication et lancement), `src/docker.ts:28-60` et
`src/docker.ts:107-150` (`runInTask`), `src/graph.ts:34-53` (`classify`),
`src/config.ts:12-21`, `src/cli.ts:17-23` (`.env` du démon), `src/state.ts:42-59`,
`unused.config.json`, `docker/Dockerfile`, `src/claude.test.ts`, `src/task.test.ts`,
`README.md:105-111`.

Vérifications faites contre le vrai binaire (`claude 2.1.272`, celui
qu'installe `docker/Dockerfile`) : existence des flags de `sessionArgs`, forme du
message `result` en cas d'auth impossible, traitement d'un argument positionnel
avec `-p`.

**Verdict** : 3 constats (1 probable, 2 à vérifier)

## Un token blanc mais non vide contourne la panne d'auth : la tâche est sortie de la file au lieu d'arrêter la plage

**Gravité** : probable
**Où** : `src/iterate.ts:99-102`, puis `src/graph.ts:49-52`

La seule validation du token est sa présence :

```ts
// src/iterate.ts:99-102
const token = deps.env[TOKEN_ENV];
if (!token) {
  return finishFatal("auth", `${TOKEN_ENV} absent : lance \`claude setup-token\` …`);
}
```

`!token` n'attrape que `undefined` et `""`. Une valeur blanche (`"   "`, un
`.env` où la ligne a été vidée : `CLAUDE_CODE_OAUTH_TOKEN= ` — Node conserve
l'espace) passe le test, est transmise au container
(`src/iterate.ts:125`, `src/docker.ts:145`), et `claude` la considère comme
« pas de token du tout ». Vérifié dans ce container :

```
$ echo hi | env CLAUDE_CODE_OAUTH_TOKEN="   " claude -p --output-format stream-json --verbose
"terminal_reason":"api_error"
"api_error_status":null
"result":"Not logged in · Please run /login"
```

`api_error_status` est **null**, pas 401 — la reconnaissance de panne d'auth
exige explicitement un statut numérique :

```ts
// src/graph.ts:49-52
if (r?.api_error_status !== undefined && r.api_error_status !== null && AUTH_STATUSES.has(r.api_error_status)) {
  return { kind: "fatal", reason: "auth", … };
}
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

L'issue devient donc `failure: "api_error"`, c'est-à-dire un échec ordinaire.

**Scénario concret.** Le token est régénéré et le `.env` est réécrit à la main
en laissant `CLAUDE_CODE_OAUTH_TOKEN=` suivi d'un espace. Plage suivante, trois
tâches actives. Attendu (README:109-111) : « le token refusé … arrête la plage
au lieu d'épuiser les tâches en échecs », `status` affiche `PANNE auth`. Obtenu :
chaque tâche enchaîne 3 sessions qui échouent en ~2 s (`retry`, `retry`, puis
`maxConsecutiveFailures` atteint → `task-failed`, `status: failed` dans
`state.json`), les trois tâches sortent de la file, la plage se termine en
`nothing-eligible` et les plages automatiques sont mises en pause
(`daemon.ts:208-212`). Aucune panne n'est signalée, et remettre le bon token ne
suffit plus : il faut `unused tasks reset` sur chaque tâche pour effacer le
`status: failed`. Un `!token.trim()` au même endroit suffirait à retomber sur la
panne fatale.

À noter que le token mal formé mais présent, lui, est bien traité : même test
avec `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-GARBAGE…` donne
`"api_error_status":401` / `"Failed to authenticate. API Error: 401 OAuth access
token is invalid."` → `fatal: auth`, conforme. Le trou ne concerne que la valeur
blanche, celle qui n'atteint jamais l'API.

## `--output-format` sans valeur fait avaler le flag suivant et transforme sa valeur en prompt positionnel

**Gravité** : à vérifier
**Où** : `src/claude.ts:28-37`

Le filtre saute aveuglément le jeton qui suit `--output-format`, sans vérifier
que c'en est bien la valeur :

```ts
// src/claude.ts:28-36
for (let i = 0; i < src.length; i++) {
  const a = src[i]!;
  if (a === "--output-format") {
    i++;            // ← saute le suivant, quoi qu'il soit
    continue;
  }
  if (a.startsWith("--output-format=") || a === "--verbose") continue;
  args.push(a);
}
```

Avec `sessionArgs: ["--output-format"]` (valeur oubliée ou supprimée — le
commentaire de `config.ts:15-17` dit justement que « le runner s'assure par
ailleurs que `--output-format json` y figure », ce qui invite à retirer la
valeur) et un nœud portant `args: ["--model", "opus"]`, `src` vaut
`["--output-format", "--model", "opus"]` : `--model` est mangé comme s'il était
la valeur, et il reste `opus` seul. La commande produite est

```
claude -p opus --output-format stream-json --verbose
```

`opus` n'est plus un flag : c'est l'argument positionnel `[prompt]` de l'usage
`claude [options] [command] [prompt]`. Vérifié ici que `-p` ne dispatche pas de
sous-commande et prend bien ce jeton comme prompt :
`claude -p doctor --output-format stream-json --verbose` n'exécute pas
`claude doctor`, il ouvre une session dont le prompt est `doctor`
(`"model":"nonexistent-model-xyz-123"` dans le `system/init`, puis un tour
d'assistant).

Le prompt du skill, lui, arrive par stdin (`iterate.ts:122-125`,
`docker.ts:58`). Le même symptôme se produit avec `--verbose` : le filtre
l'enlève par égalité exacte, où qu'il soit, y compris si c'est la *valeur* d'une
option précédente.

**Ce qui reste à vérifier** : je n'ai pas pu observer comment `claude -p`
combine un prompt positionnel et un stdin non vide (l'auth échoue avant le
traitement du prompt dans ce container, et je n'ai pas voulu consommer du quota
pour le savoir). Deux issues possibles, toutes deux fausses : le positionnel
remplace le stdin (le skill ne tourne jamais), ou il s'y ajoute (le skill tourne
avec un jeton parasite en tête). Dans les deux cas, si la session finit en
`completed`, `iterate` commite le container et avance le curseur
(`iterate.ts:168-170`, `graph.ts:89`) en journalisant `prompt: "/work repo=…"`
(`iterate.ts:202`) : le journal décrit une itération du skill qui n'a pas eu
lieu. La précondition est une `sessionArgs`/`args` mal formée, ce qui limite la
portée — mais c'est précisément le cas que le filtre prétend couvrir
(« Toute autre valeur donnée est remplacée », `claude.ts:23`).

## Les valeurs des params sont échappées, les clés ne le sont pas du tout

**Gravité** : à vérifier
**Où** : `src/claude.ts:8-12`, schéma `src/task.ts:33` et `src/task.ts:46`

```ts
// src/claude.ts:9-11
.map(([k, v]) => (/^[\w./:@+-]*$/.test(v) ? `${k}=${v}` : `${k}=${JSON.stringify(v)}`))
.join(" ")
```

La valeur est traitée avec soin : le jeu de caractères accepté nu exclut
l'espace, le guillemet et le `=`, tout le reste passe par `JSON.stringify`. La
clé, elle, est reprise telle quelle, et rien ne la contraint en amont :
`params: z.record(z.string())` n'impose aucune forme aux clés (à comparer avec
`env`, où `ENV_ENTRY_RE` (`task.ts:27`) valide chaque entrée, et avec
`TASK_NAME_RE` pour le nom de tâche).

Conséquence, `params: { "repo=x mode": "fast" }` produit le prompt
`/work repo=x mode=fast` : deux paramètres là où le fichier en déclarait un, et
un `repo` que la tâche n'a jamais demandé. Une clé vide (`"": "v"`) produit un
`=v` orphelin.

Le déclencheur est une clé écrite par l'opérateur dans `task.json`, qui pourrait
tout aussi bien écrire les deux paramètres directement : il n'y a pas de source
hostile ici, et c'est pourquoi je ne classe pas ce constat plus haut. Ce qui le
rend gênant, c'est le silence : la clé n'est refusée ni au chargement ni au
lancement, et le prompt journalisé est identique au prompt réellement envoyé —
seul le modèle voit la différence.

## Ce qui a été vérifié et tient

- **`resolveEnv` (`task.ts:89-106`)** : découpe sur le *premier* `=`
  (`"B=x=y"` → `B` = `x=y`), `"NOM="` donne bien une valeur vide, une entrée
  répétée est écrasée par la dernière, les noms introuvables sont retournés dans
  `missing` — et refusés deux fois : au chargement contre `process.env`
  (`task.ts:156-159`, la tâche apparaît dans `taskErrors`) et à chaque itération
  contre `deps.env` (`iterate.ts:103-106`, `fatal: auth`). Un `.env` amputé
  entre deux itérations est donc rattrapé.
- **Aucune valeur d'environnement ne passe par la ligne de commande** :
  `runInTask` n'émet que `-e NOM` (`docker.ts:145`) et fournit les valeurs via
  l'environnement du processus `docker` (`docker.ts:31`,
  `{ ...process.env, ...opts.env }`). Le token n'apparaît donc pas dans `ps`,
  et comme `opts.env` contient une valeur explicite pour *chaque* clé, la
  résolution ne dépend pas de ce que le démon a hérité.
- **Le token écrase une entrée `env` de même nom** (`iterate.ts:125`,
  `{ ...taskEnv.env, [TOKEN_ENV]: token }`) : une tâche ne peut pas utiliser un
  autre compte. C'est le comportement documenté (« Le token Claude est toujours
  transmis », `task.ts:25` et `scaffold.ts:26-27`), pas un défaut.
- **`buildCommand` face à la config réelle du dépôt** : `sessionArgs` vaut
  `["--output-format", "json", "--no-session-persistence",
  "--dangerously-skip-permissions"]` ; la paire `--output-format json` est bien
  retirée en entier, la forme `--output-format=json` et `--verbose` aussi
  (couvert par `claude.test.ts:30-34`), et `-p` reste en tête. Les trois flags
  conservés existent dans `claude 2.1.272` (`--help` : `--no-session-persistence`,
  `--dangerously-skip-permissions`, `--output-format`, `--verbose`), et
  `--output-format stream-json` exige `--verbose`, qui est bien imposé.
- **Pas d'injection de paramètre par une *valeur*** : une valeur rendue nue ne
  peut contenir ni espace, ni `=`, ni guillemet (le jeu `[\w./:@+-]` les exclut,
  et `\w` est ASCII, donc tout accent déclenche la mise entre guillemets) ;
  sinon `JSON.stringify` échappe guillemets et sauts de ligne, et le prompt
  reste sur une seule ligne. `{...taskParams, ...node.params}` fait bien gagner
  le nœud en conservant la position d'origine de la clé.
- **Curseur périmé** : `iterate.ts:85` déréférence `task.def.nodes[nodeName]!`
  avec une assertion non nulle, mais `ensureTaskState` (`state.ts:50-59`) est
  appelé juste avant (`iterate.ts:80`) et ramène le curseur sur `start` si le
  nœud a disparu de `task.json`. Pas de `TypeError` à attendre de ce côté.
- **`.env` du démon** (`cli.ts:17-23`) : chargé avant `Daemon.init()`, donc avant
  le premier `loadTask`, et uniquement dans le processus démon.
- Remarque sans gravité : `IterateOptions.dryRun` (`iterate.ts:34`, `95-97`)
  n'est utilisé par aucun appelant — ni la CLI ni l'API n'exposent de mode
  « montre-moi le prompt ». `scheduler.ts:66` est le seul appel d'`iterate`.
