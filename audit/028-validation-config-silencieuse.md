# 028 — `loadConfig` : clés inconnues avalées par les sous-objets, config figée pour la vie du démon

**Fichiers examinés** : `src/config.ts:1-78`, `src/calendar.ts:11-17`,
`src/cli.ts:14-31`, `src/cli.ts:35-46`, `src/api.ts:15`, `src/daemon.ts:85-135`,
`src/daemon.ts:277-281`, `src/scheduler.ts:47-80`, `src/iterate.ts:128-136`,
`src/claude.ts:25-37`, `src/client.ts:12-18`, `deploy/install.sh:50-62`,
`deploy/unused.service`, `README.md:84-134`, `unused.config.json`,
`src/claude.test.ts:7-8`, `src/scheduler.test.ts:26`
**Verdict** : 3 constats (1 sûr, 2 probables)

Le schéma annonce une intention nette : `.strict()` à la racine
(`config.ts:44`) et `.strict()` sur `WindowSpecSchema` (`calendar.ts:17`) —
une clé mal orthographiée doit faire échouer le démarrage plutôt que passer
inaperçue. Cette promesse ne tient que pour 3 des 11 feuilles de la config.

## 1. `.strict()` ne descend pas dans `claude`, `docker` et `scheduler` : 8 clés sur 11 acceptent silencieusement les fautes de frappe

**Gravité** : sûr
**Où** : `src/config.ts:12-44` (le `.strict()` de la ligne 44)

En zod 3, `unknownKeys` est une propriété de **l'instance** `ZodObject` sur
laquelle `.strict()` est appelé ; les schémas imbriqués de la `shape` sont
d'autres instances, qui gardent leur mode par défaut `"strip"` (suppression
silencieuse). Ici `.strict()` est appelé sur l'objet racine uniquement :

```ts
    claude: z
      .object({
        sessionArgs: z.array(z.string()).default([]),
        timeoutMinutes: z.number().positive().default(180),
      })
      .default({}),          // ← mode "strip", pas "strict"
    …
  })
  .strict();                 // ← ne protège que tasksDir / dataDir / claude / docker / windows / scheduler
```

Sont protégées : `tasksDir`, `dataDir`, `windows` (plus les noms des trois
sous-objets eux-mêmes, et l'intérieur de chaque `windows[]` via
`WindowSpecSchema.strict()`). **Ne le sont pas** : `claude.sessionArgs`,
`claude.timeoutMinutes`, `docker.baseImage`, `docker.dockerfileDir`,
`docker.flattenAfterLayers`, `scheduler.backoffMinutes`,
`scheduler.retrySeconds`, `scheduler.maxConsecutiveFailures`.

Scénario concret. L'utilisateur part de `unused.config.json` du dépôt et
réduit le timeout, en écrivant `timeoutMinute` au singulier :

```json
"claude": { "sessionArgs": ["--dangerously-skip-permissions"], "timeoutMinute": 30 }
```

`safeParse` réussit. La clé est supprimée, `timeoutMinutes` reçoit son défaut
`180`, et `iterate.ts:132` arme `setTimeout(…, 180 * 60_000)`. Attendu : une
session tuée au bout de 30 min. Obtenu : 3 h par session, soit un quota brûlé
par des sessions parties en vrille — sans une ligne d'avertissement nulle part.

Variante plus coûteuse, sur la clé la plus facile à mal orthographier
(pluriel interne) :

```json
"claude": { "sessionsArgs": ["--dangerously-skip-permissions"], "timeoutMinutes": 180 }
```

`sessionArgs` vaut alors `[]`, et `buildCommand` (`claude.ts:26-36`) produit
`claude -p --output-format stream-json --verbose` : **plus aucun** des
arguments voulus, y compris `--dangerously-skip-permissions`, pour toutes les
itérations de toutes les tâches.

Rien ne rattrape l'erreur en aval :

- `loadConfig` ne journalise pas la config effective ; `Daemon.init()`
  (`daemon.ts:96-113`) n'imprime que la plage reprise et le nombre de plages
  automatiques ; `GET /status` (`daemon.ts` → `DaemonStatus`) ne renvoie aucun
  champ de config. Aucune commande ne permet de relire ce que le démon a
  réellement retenu.
- Aucun test n'exerce le schéma : il n'existe pas de `config.test.ts`, et les
  fixtures des autres tests fabriquent la config à la main
  (`claude.test.ts:8`, `scheduler.test.ts:26` : `as unknown as Config`), ce qui
  court-circuite entièrement `ConfigFileSchema`.

Le correctif tient en un mot-clé par sous-objet (`.strict()` sur `claude`,
`docker`, `scheduler`), ou en `z.strictObject`.

## 2. La config n'est lue qu'au démarrage du processus, alors que tout le reste est rechargé à chaud — et rien ne le dit

**Gravité** : probable (mécanisme certain ; c'est le silence qui en fait un défaut)
**Où** : `src/cli.ts:18-23` et `src/cli.ts:38-45` (unique appel à `loadConfig` côté démon)

`loadConfig` n'est appelé qu'une fois, dans `daemonSetup()`, et l'objet `cfg`
est ensuite passé par référence au `Daemon` (`cli.ts:41`) et à l'API
(`cli.ts:43`). Aucune route ne le relit : `grep -n "loadConfig" src/*.ts` ne
donne que `cli.ts:19` et `cli.ts:30`, et l'API (`api.ts:54-115`) n'expose
ni `reload` ni équivalent.

C'est exactement l'inverse du reste du système, qui est explicitement conçu
pour être modifiable à chaud :

```ts
/** … Les tâches sont rechargées avant chaque itération si un chargeur est donné :
 *  modifier un task.json ou un skill pendant la plage est pris en compte. */   // scheduler.ts:53-54
```

`daemon.loadTasks()` (`daemon.ts:277-281`) relit le disque à chaque itération,
à chaque `status` et à chaque `tasks list`. Le README documente la même chose
pour les skills (« tu peux les modifier entre deux itérations »).

Scénario concret. Le service tourne depuis des semaines (`Restart=always`,
`unused.service:18`). L'utilisateur ajoute une plage automatique dans
`unused.config.json` :

```json
"windows": [ { "days": ["sat"], "from": "22:00", "to": "08:00" } ]
```

Attendu, d'après le README (« Plages automatiques — dans `unused.config.json` »,
`README.md:85`, qui ne mentionne aucun redémarrage) : le samedi soir, le démon
se met au travail. Obtenu : `this.cfg.windows` vaut toujours l'ancienne liste,
`calendarEnd()` (`daemon.ts:121-128`) et `nextCalendarStart()`
(`daemon.ts:130-135`) continuent de la consulter, aucune plage ne s'ouvre, et
`unused status` affiche la ligne « prochaine plage automatique » calculée sur
l'ancienne config — donc **confirme** un état qui contredit le fichier que
l'utilisateur vient d'éditer. Le seul moyen de s'en rendre compte est
d'attendre samedi soir et de constater que rien n'a tourné.

Même chose, moins visible, pour `scheduler.retrySeconds`,
`scheduler.backoffMinutes`, `claude.timeoutMinutes` ou `docker.baseImage` :
`deploy/install.sh` fait bien un `systemctl restart` (`install.sh:66-71`), mais
il est présenté comme le script de **mise à jour du code**, pas comme l'étape
obligatoire après un changement de config, et il relance `npm ci` + `npm run
build` au passage.

Un `systemctl restart unused` documenté à côté de la section Configuration, ou
une relecture du fichier au début de chaque plage, suffirait.

## 3. Côté client, `loadConfig` résout `unused.config.json` depuis le CWD : « le démon n'est pas lancé » alors qu'il tourne

**Gravité** : probable (dépend de l'environnement du shell, mais le chemin de code est certain)
**Où** : `src/config.ts:52` (`path.resolve(file)`) via `src/cli.ts:26-31`

```ts
const absFile = path.resolve(file);      // config.ts:52 — relatif au CWD du processus
…
if (process.env.UNUSED_SOCKET) return path.resolve(process.env.UNUSED_SOCKET);
return socketPath(await loadConfig(opts.config));   // cli.ts:29-30
```

Le défaut de `--config` est la chaîne relative `"unused.config.json"`
(`cli.ts:14`, `CONFIG_FILE`). Le déploiement masque le problème en exportant
`UNUSED_SOCKET` depuis `/etc/profile.d/unused.sh` (`install.sh:59-62`) — mais
`/etc/profile.d` n'est lu ni par un shell non interactif non-login, ni par
`sudo` (env_reset).

Scénario concret : depuis un poste, `ssh pi unused status`. Le shell distant est
non interactif, `UNUSED_SOCKET` est vide, le CWD est `$HOME`. Deux issues,
toutes deux fausses :

- pas de `unused.config.json` dans `$HOME` → `Impossible de lire
  /home/u/unused.config.json : ENOENT…` (`config.ts:58`), sortie 1. L'erreur
  parle d'un fichier de config alors que la commande ne demandait qu'un état.
- une copie du dépôt dans `$HOME` (cas courant : le dépôt est cloné chez
  l'utilisateur *et* déployé dans `/opt/unused`) → la config du clone est lue,
  son `dataDir` relatif est résolu sur `$HOME`, `socketPath` pointe sur
  `/home/u/data/unused.sock`, qui n'existe pas → `unreachable()`
  (`client.ts:14-16`) répond **« le démon n'est pas lancé (socket …) :
  `systemctl start unused` »**. Le démon tourne, la plage tourne, et la CLI
  affirme le contraire ; suivre le conseil ne change rien.

## Ce qui a été vérifié et tient

- `.default({})` sur les sous-objets : correct. `ZodDefault` repasse la valeur
  par défaut dans le type interne, donc `{}` est parsé par l'objet et produit
  bien toutes les valeurs par défaut des feuilles (`sessionArgs: []`,
  `timeoutMinutes: 180`, etc.). Une config `{}` est valide et complète.
- La racine `.strict()` fonctionne et donne un message lisible via
  `formatZodError` : une faute sur `sheduler` ou `windwos` échoue au démarrage,
  avec la clé citée (chemin vide → `(racine)`).
- `WindowSpecSchema` est bien `.strict()` (`calendar.ts:17`) : une clé parasite
  dans un élément de `windows` est refusée.
- La résolution de `tasksDir`, `dataDir` et `docker.dockerfileDir` se fait bien
  par rapport au **répertoire du fichier de config** (`config.ts:53,68-70`), pas
  au CWD ; côté démon, `WorkingDirectory=/opt/unused` rend le défaut relatif
  correct.
- Les erreurs de lecture/parse JSON sont capturées et re-jetées avec le chemin
  absolu (`config.ts:55-59`) ; une racine `null`, un tableau ou un nombre sont
  rejetés par `z.object`.
- Non repris ici car déjà couverts : le regex `HH:MM` qui accepte `99:99`
  (rapports 007 et 013) et `claude.timeoutMinutes` non borné par le haut
  (rapport 013).
- `buildCommand` (`claude.ts:25-37`) neutralise `--output-format` / `--verbose`
  venus de `sessionArgs`, malgré le commentaire périmé de `config.ts:14-16` qui
  parle encore de `--output-format json` (le runner impose `stream-json`) :
  commentaire faux, comportement correct. Réserve, hors aspect et non instruite
  ici : des `sessionArgs` se terminant par un `--output-format` orphelin
  feraient sauter `node.args[0]`, le `i++` de `claude.ts:30` s'appliquant à la
  concaténation des deux listes.
