# 034 — Résolution du skill dans le container : nom non validé, dossier vs frontmatter, commande inconnue

**Fichiers examinés** : `src/task.ts:27-31` (`NodeSchema.skill`), `src/task.ts:105-109`
(`skillFile`), `src/task.ts:140-155` (`loadTask`, vérification des skills),
`src/claude.ts:14-18` (`buildPrompt`), `src/claude.ts:86-110` (`parseStream`,
capture de `system/init`), `src/iterate.ts:84-88`, `src/iterate.ts:120-127`
(montage `/work/.claude/skills`), `src/iterate.ts:155-195`, `src/graph.ts:40-53`
(`classify`), `src/graph.ts:64-105` (`applyOutcome`), `src/log.ts:7-33`
(`IterationRecord`), `src/scaffold.ts:5-11` et `:43-99`, `docker/Dockerfile`,
`README.md:45-75`, `unused.config.json`.

Toutes les affirmations sur le comportement de la CLI ont été vérifiées contre
le binaire réellement installé par `docker/Dockerfile` — `claude 2.1.272` —, en
reproduisant le dispositif du runner (skills dans `<cwd>/.claude/skills/<nom>/SKILL.md`,
prompt sur stdin, `-p --output-format stream-json --verbose --dangerously-skip-permissions`).
Les sondes lisent la liste `skills`/`slash_commands` du cadre `system/init`, le
cadre `result`, et le transcript de session (`~/.claude/projects/<slug>/*.jsonl`),
qui montre si le corps du SKILL.md a bien été injecté. Pas de token dans ce
container : les sessions qui atteignent l'API s'arrêtent sur
`Not logged in` — ce qui suffit ici, puisque le point à trancher est
*avant* l'appel (commande résolue, texte brut, ou commande inconnue).

**Verdict** : 2 constats (1 sûr, 1 probable)

Racine commune : `skill` est le seul identifiant du système qui franchisse la
frontière hôte → container, et il n'est contraint ni par un motif ni par une
confrontation à la CLI. Côté hôte il sert de **segment de chemin**
(`path.join(skillsDir, skill, "SKILL.md")`, `task.ts:109`), côté container de
**nom de commande slash** (`` `/${node.skill}` ``, `claude.ts:17`). Les deux
grammaires ne coïncident pas : un chemin accepte `/` et l'espace, une commande
non. Tout nom qui existe comme dossier mais n'est pas une commande passe la
validation et échoue dans le container — de deux façons opposées, selon le
caractère fautif.

## 1. Un nom de skill contenant `/` n'est jamais une commande : la session tourne sur du texte brut, sans skill, et est commitée comme un succès

**Gravité** : probable
**Où** : `src/task.ts:31` et `src/task.ts:109`, puis `src/claude.ts:17` et `src/graph.ts:48`

`loadTask` ne vérifie qu'une chose du skill : que le fichier soit là.

```ts
// src/task.ts:108-109
export function skillFile(task: Pick<Task, "skillsDir">, skill: string): string {
  return path.join(task.skillsDir, skill, "SKILL.md");
}
// src/task.ts:149
if (!(await exists(skillFile(task, node.skill)))) missing.push(node.skill);
```

`path.join` absorbe les séparateurs : `"audit/choose"` désigne
`skills/audit/choose/SKILL.md`. Ranger les skills d'un graphe à deux niveaux
dans des sous-dossiers est une organisation naturelle — c'est exactement la
façon dont le README nomme les étapes (« chercher quoi faire » puis « le
faire », `README.md:76-80`), et le constat 026 relevait déjà `audit/choose`
comme nom d'étape plausible. Rien, ni dans `NodeSchema` (`skill: z.string().min(1)`),
ni dans le README (`README.md:69-73`, qui ne dit rien de la forme du nom), ne
l'interdit.

Or la CLI ne découvre les skills que sur **un seul niveau** sous
`.claude/skills/`. Sonde — six dossiers de skill, dont `ns/sub` :

```
$ ls -d .claude/skills/*            # My_Skill, "my skill", my.skill, a_b, ns/sub, UPPER, accentué
$ claude -p --output-format stream-json --verbose … <<< 'hi' | head -1
"skills":["a_b","accentué","my skill","My_Skill","my.skill","UPPER", …]
```

`ns/sub` est absent : il n'est ni un skill, ni une commande. Et un prompt dont
le nom de commande contient un `/` n'est pas traité comme une commande
inconnue — il n'est pas traité comme une commande du tout :

```
$ claude -p … <<< '/ns/sub'
{"terminal_reason":"api_error","is_error":true,"num_turns":1,
 "result":"Not logged in · Please run /login", …}      ← la boucle a démarré, appel API tenté
$ grep '"role":"user"' ~/.claude/projects/-tmp-t2/*.jsonl
"role":"user","content":"/ns/sub\n"                      ← texte brut, pas de <command-name>
```

À comparer avec le cas résolu, où le transcript porte le cadre de commande et
le corps du SKILL.md injecté :

```
"role":"user","content":"<command-message>work</command-message>\n<command-name>/work</command-name>\n<command-args>repo=a/b</command-args>"
"role":"user","content":[{"type":"text","text":"Base directory for this skill: /tmp/t3/.claude/skills/work\n\nDis bonjour.\n\n\nARGUMENTS: repo=a/b"}]
```

Même résultat avec `/analyze/x` alors que le skill `analyze` existe : dès qu'il
y a un `/`, c'est du texte.

**Scénario concret.** Une tâche range ses skills en sous-dossiers :
`skills/audit/choose/SKILL.md` et `skills/audit/analyze/SKILL.md`, avec
`"nodes": { "choose": { "skill": "audit/choose", "next": "analyze" }, "analyze": { "skill": "audit/analyze", "next": "choose" } }`.

1. `loadTask` : les deux `SKILL.md` existent → **tâche chargée sans la moindre
   réserve**, `unused tasks list` la montre normale.
2. `iterate` monte `skillsDir` sur `/work/.claude/skills` (`iterate.ts:127`) et
   envoie le prompt `/audit/choose repo=… branch=…` (`claude.ts:17`).
3. La CLI n'y voit pas une commande : le modèle reçoit cette ligne comme prompt
   ordinaire, sans une ligne des instructions du skill. Il fait ce qu'il peut
   d'une ligne qui ressemble à un chemin — en pratique, un tour court qui
   n'exécute pas le travail et ne crée pas `/exchange/DONE`.
4. Le tour se termine normalement, donc `terminal_reason: "completed"` →
   `classify` renvoie `{kind:"completed", done:false}` (`graph.ts:48`) →
   `commitTask` scelle le container (`iterate.ts:170`), `iterations += 1`,
   `consecutiveFailures = 0`, le curseur passe à `analyze` (`graph.ts:89`).
5. Le nœud suivant fait de même. La tâche parcourt son graphe indéfiniment,
   une itération « réussie » après l'autre, sans qu'aucun skill n'ait jamais
   été lu — et comme rien n'échoue, `maxConsecutiveFailures` ne la sortira
   jamais de la file : elle consomme toutes les plages et tout le quota.

Obtenu : `issue completed → next-task (commit)`, `unused status` affiche
`dernier choose → completed`, le journal porte `outcome.kind: "completed"` et
`committed: true`. Attendu : soit un refus au chargement (`skill "audit/choose"
n'est pas un nom de commande`), soit un échec d'itération.

Ce qui n'est pas vérifiable ici et justifie « probable » plutôt que « sûr » :
le cadre `completed` lui-même, faute de token — la sonde s'arrête sur l'erreur
d'authentification. La partie démontrée est celle qui compte, et elle est
démontrée de bout en bout : **la CLI ne signale rien, n'injecte pas le skill, et
part dans un tour normal.** Qu'un tour normal se termine en `completed` est le
cas nominal du runner (c'est sa seule condition de succès) ; il faudrait une
erreur *en plus* pour qu'il en aille autrement.

À noter : le signal qui trancherait est déjà dans le flux et déjà parsé. Le
cadre `system/init` liste les commandes et les skills effectivement chargés —
`"slash_commands":["bar", …]`, `"skills":["bar", …]` — et `parseStream` le
conserve (`claude.ts:106`). Il n'en sort qu'une chose :

```ts
// src/iterate.ts:191
const model = typeof session.init?.model === "string" ? session.init.model : …
```

`init` n'est même pas recopié dans `IterationRecord` (`log.ts:7-33`) : la preuve
que le skill n'a pas été chargé transite par le runner, est lue pour un seul
champ, puis jetée. Un `session.init.slash_commands.includes(node.skill)` à
l'endroit de `classify` suffirait à transformer ce faux succès en échec nommé.

## 2. Un nom de skill contenant une espace : « Unknown command », étiquetée `unreadable_output`, et la tâche sort définitivement de la file en trois itérations

**Gravité** : sûr
**Où** : `src/task.ts:31`, `src/claude.ts:17`, `src/graph.ts:52`, `src/graph.ts:96-101`

L'autre moitié du désaccord de grammaire : un dossier peut contenir une espace,
un nom de commande s'arrête au premier blanc. Le dossier `skills/my skill/` est
bien enregistré comme skill par la CLI (il figure dans la liste `skills`
ci-dessus), mais il est **inatteignable** par la commande que fabrique
`buildPrompt` :

```
$ claude -p --output-format stream-json --verbose … <<< '/my skill repo=a/b'
{"is_error":false,"num_turns":0,"subtype":"success",
 "result":"Unknown command: /my. Did you mean /mcp?","type":"result", …}
```

Pas de `terminal_reason` — la boucle a été court-circuitée. `classify` :
pas de `rejected`, `terminal_reason !== "completed"`, `api_error_status`
absent, donc

```ts
// src/graph.ts:52
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

**Scénario concret.** `tasks/demo/` avec `skills/my skill/SKILL.md` et
`"nodes": { "a": { "skill": "my skill", "next": "a" } }`.

1. `loadTask` accepte (`exists("skills/my skill/SKILL.md")` → vrai).
2. Itération 1 : container lancé, CLI répond en ~120 ms `Unknown command: /my`,
   `classify` → `failure: "unreadable_output"` → `consecutiveFailures = 1`,
   container jeté, `retry` après `retrySeconds` (60 s).
3. Itérations 2 et 3 : identiques. À la troisième,
   `consecutiveFailures >= maxConsecutiveFailures` (3, `unused.config.json`) →
   `ts.status = "failed"`, décision `task-failed` (`graph.ts:96-101`).

Obtenu : en trois minutes, la tâche est **sortie définitivement de la file**
(constat 018 : rien ne l'y remet sans intervention), sur l'étiquette
`unreadable_output` — qui désigne une sortie illisible ou tronquée et envoie
l'opérateur chercher du côté de Docker ou du timeout, alors que la CLI a
répondu en 120 ms, correctement, et a dit exactement ce qui n'allait pas. Pire,
la sortie brute n'est pas jointe au journal dans ce cas précis
(`iterate.ts:210` ne garde `rawStdout` que si `result === null`, cf. constat
020), et `unused status` n'affiche que l'étiquette (`cli.ts:119`, `dernier <nœud> → <issue>`). Le message
`"Unknown command: /my"` n'existe plus que dans `result.result`, au fond du
fichier de log. Attendu : un refus au chargement, nommant le skill.

Ce constat corrige au passage une conclusion du rapport 020 — « le chemin
*commande inconnue* n'est donc pas atteignable depuis un `task.json` valide,
ni par une faute de frappe, ni par un SKILL.md mal écrit ». C'est vrai d'une
faute de frappe (`loadTask` l'attrape) et d'un frontmatter défaillant, mais pas
d'un nom qui n'est pas une commande : l'existence du dossier et la validité du
nom de commande sont deux propriétés distinctes, et une seule est vérifiée.

## Ce qui a été vérifié et tient

- **Dossier contre frontmatter : c'est le dossier qui fait foi**, donc la
  vérification `skills/<skill>/SKILL.md` de `loadTask` est bien la bonne.
  Sonde : dossier `bar/`, frontmatter `name: foo` → `"skills":["bar", …]`,
  `/bar` est résolu (transcript : `Base directory for this skill:
  …/.claude/skills/bar`), `/foo` serait inconnu. Aucune raison de lire le
  frontmatter : le `name` déclaré est ignoré par la CLI 2.1.272. Combiné au
  test de 020 (frontmatter absent, incomplet ou mal formé : le skill est quand
  même enregistré), la résolution ne dépend que du chemin.
- **Majuscules, `_`, `.`, accents dans le nom de dossier** : tous enregistrés
  et tous résolus (`My_Skill`, `a_b`, `my.skill`, `UPPER`, `accentué` figurent
  dans `skills`, et `/UPPER` démarre bien la boucle). La résolution est
  sensible à la casse (`/ANALYZE` sur un skill `analyze` → `Unknown command`),
  mais le nom part du même champ `skill` des deux côtés, donc la casse ne peut
  pas diverger. Seuls `/` et l'espace cassent — d'où les deux constats
  ci-dessus, et pas un troisième.
- **Pas de résolution approchée** : `/analyz` sur un skill `analyze` donne
  `Unknown command: /analyz. Did you mean /analyze?` — la CLI suggère, elle
  n'exécute pas. Un nom voisin ne peut donc pas déclencher silencieusement le
  mauvais skill. (Et de toute façon un nom voisin est rejeté par `loadTask`.)
- **Un skill de tâche gagne contre les skills et commandes intégrés du même
  nom** : testé sur `code-review`, `run`, `debug`, `init`, `loop` — dans les
  cinq cas le transcript montre `Base directory for this skill:
  <cwd>/.claude/skills/<nom>` et le marqueur du SKILL.md de la tâche. Une tâche
  peut donc nommer ses nœuds librement sans risque d'être détournée vers un
  skill fourni par la CLI (généralise le test `/compact` de 020).
- **Un skill gagne aussi contre un chemin existant du même nom** : `/work`
  résout vers `skills/work/SKILL.md` alors que `/work` est le `WORKDIR` du
  container. Le couple par défaut de `scaffold.ts` (`setup`, `work`) est donc
  sain. (Sans skill enregistré, `/work` et `/tmp` partent en texte brut vers le
  modèle, comme les noms contenant un `/` — même branche que le constat 1.)
- **Point de montage et `WORKDIR` cohérents** : `iterate.ts:127` monte sur
  `/work/.claude/skills` et le `Dockerfile` pose `WORKDIR /work`, donc les
  skills sont bien dans le dossier projet du `cwd` de la session. La lecture
  seule du montage ne gêne pas l'enregistrement. Et l'aplatissement ne casse
  pas cette coïncidence : `importChanges` (`docker.ts:199-212`) réémet
  `WORKDIR` et `ENV` depuis la config de l'image avant le `docker import`, donc
  le `cwd` — et donc la découverte des skills — survit à un
  `flattenTask`.
- **`$ARGUMENTS` fonctionne comme le README l'annonce** : un corps contenant
  `Parametres : $ARGUMENTS` reçoit bien `repo=a/b branch="x y"` (les guillemets
  posés par `renderArguments` arrivent littéralement jusqu'au skill, à lui de
  les interpréter) ; un corps sans `$ARGUMENTS` se voit ajouter une ligne
  `ARGUMENTS: …` par la CLI. Rien ne se perd entre `buildPrompt` et le skill.
- **Noms de nœud** (les clés de `nodes`, distinctes du champ `skill`) : déjà
  traités par le constat 026 (clés héritées d'`Object.prototype`, `/` dans le
  nom de nœud qui casse l'écriture du log). Pas repris ici.
