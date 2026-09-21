# 011 — Écriture du journal d'itération

**Fichiers examinés** : `src/log.ts` (entier), `src/iterate.ts:148-237`,
`src/scheduler.ts:88-139`, `src/daemon.ts:177-226`, `src/task.ts:27-67`
(schéma des nœuds), `src/task.ts:108-127` (`TASK_NAME_RE`), `src/state.ts:42-84`,
`src/claude.ts:114-127` (`quotaSnapshot`), `src/iterate.test.ts`, `README.md:100-130`.

**Verdict** : 2 constats (1 sûr, 1 probable)

## Un échec d'écriture du journal détruit la plage et efface l'itération qu'il devait décrire

**Gravité** : sûr
**Où** : `src/iterate.ts:217`, puis `src/scheduler.ts:98` et `src/daemon.ts:213-217`

`writeIterationLog` est appelé sans protection, tout à la fin d'`iterate`, alors
que tout le reste est déjà acquis :

```ts
// src/iterate.ts:168-189 — le container est commité, l'état est écrit sur disque
if (outcome.kind === "completed") {
  try { await deps.commitTask(cfg, task.name, r.container); committed = true; }
  catch (err) { … }
}
…
if (!aborted) await saveState(cfg.dataDir, state);
…
// src/iterate.ts:217 — aucun try/catch
const logFile = await writeIterationLog(cfg, rec);
```

Le `commitTask` a son `catch`, le `saveState` et le `writeIterationLog` n'en ont
aucun. Et rien ne rattrape plus haut : `scheduler.ts:98`
(`const r = await deps.runIteration(task, state, signal);`) est nu dans la
boucle `while`, si bien que le rejet remonte jusqu'à `daemon.ts:213`, le seul
`catch` de la chaîne — celui qui traite une exception comme « la plage est
morte ».

**Scénario concret.** Le disque du Pi se remplit (les images de tâche pèsent
plusieurs Go, cf. 005). Itération N :

1. la session Claude tourne quinze minutes et se termine en `completed` ;
2. `commitTask` réussit, `:latest` avance ;
3. `applyOutcome` a avancé le curseur de `a` à `b`, `saveState` l'écrit ;
4. `writeFile(file, JSON.stringify(rec, null, 2))` (`log.ts:47`) rejette avec
   `ENOSPC` ;
5. l'exception traverse `iterate` puis `runWindow` et atterrit dans
   `daemon.ts:213`.

Résultat, ligne par ligne :

- **`log.ts:66` n'est jamais atteint** : pas de fichier d'itération, pas de ligne
  dans `index.jsonl`. Le coût en dollars, le `num_turns`, les fenêtres de quota,
  le `stderr` de cette session sont perdus définitivement — or c'est exactement
  ce que le README (`README.md:106`) promet de retrouver dans
  `data/logs/index.jsonl` ;
- **`scheduler.ts:99-102` n'est jamais atteint** : `onEvent({type:
  "iteration-end"})` n'est pas émis et `summary.iterations` /
  `summary.costUsd` n'intègrent pas cette itération. Les compteurs live du démon
  (`daemon.ts:258-267`) l'ignorent aussi ;
- **`daemon.ts:192` n'assigne jamais `this.lastWindow`** : après la panne,
  `unused status` continue de publier le résumé de la plage *précédente* comme
  `lastWindow`, et `this.fatal` reste `null` — le démon se déclare en bonne
  santé ;
- la plage en cours est arrêtée net et mise en pause (`pauseUntil(…, "erreur")`).

Autrement dit : une itération a réellement tourné, a réellement consommé du
quota, a réellement avancé l'image et le curseur — et n'existe nulle part sauf
dans l'image Docker. Un effet de bord purement *observationnel* (écrire un
fichier de trace) a le pouvoir d'arrêter la plage et d'effacer sa propre
itération. C'est l'inverse de ce qu'on attend d'un journal.

Le même raisonnement vaut pour `saveState` (`iterate.ts:189`), lui aussi nu :
un `ENOSPC` à cet endroit produit la divergence « image avancée / état ancien »
décrite en 005, avec en prime le journal jamais écrit puisqu'il vient après.

La distinction utile est : un échec *avant* le commit peut légitimement avorter
la plage (rien n'est acquis, on rejoue) ; un échec *après* le commit ne le peut
plus, parce qu'à ce stade la seule chose à faire est d'enregistrer ce qui s'est
passé. Un `try/catch` autour de `writeIterationLog` qui se contente de
`print`er l'erreur et de renvoyer `logFile: null` (valeur déjà prévue par le
type `IterateResult`, `iterate.ts:45`, et déjà produite par `finishFatal`)
suffirait à ce que l'itération soit comptée, facturée et rendue à
l'ordonnanceur même si sa trace n'a pas pu être écrite.

## Les noms de nœuds ne sont pas validés et servent de nom de fichier

**Gravité** : probable
**Où** : `src/log.ts:43-47`, schéma permissif en `src/task.ts:47`

```ts
// src/log.ts:43-47
const dir = path.join(logsDir(cfg), rec.task);
await mkdir(dir, { recursive: true });              // ← crée logs/<tâche> et rien d'autre
const stamp = rec.startedAt.replace(/[:.]/g, "-");
const file = path.join(dir, `${stamp}-${rec.node}.json`);
await writeFile(file, …);
```

`rec.node` est `ts.cursor`, c'est-à-dire une clé de `task.def.nodes`. Le nom de
la *tâche* est verrouillé par `TASK_NAME_RE` (`task.ts:10`, vérifié à
`task.ts:123`) parce qu'il sert de nom d'image Docker ; le nom du *nœud*, lui,
ne subit aucun contrôle : `nodes: z.record(NodeSchema)` (`task.ts:47`) accepte
n'importe quelle chaîne en clé, et le `superRefine` (`task.ts:50-67`) ne vérifie
que l'existence de `start` et des `next`. Un nœud n'est jamais rapproché du
système de fichiers ailleurs : `buildPrompt` utilise `node.skill`, pas le nom du
nœud, et `skillFile` (`task.ts:108`) joint `node.skill`. Le seul endroit où le
nom du nœud devient un chemin est `log.ts:46`.

**Scénario concret.** Un `task.json` parfaitement valide au regard du schéma :

```json
{ "start": "audit/choose",
  "nodes": { "audit/choose": { "skill": "choose", "next": "audit/analyze" },
             "audit/analyze": { "skill": "analyze", "next": "audit/choose" } } }
```

`loadTask` l'accepte (les deux skills existent, `start` est dans `nodes`), la
tâche est éligible, l'itération tourne, le container est commité, le curseur
avance… puis `path.join("data/logs/t", "2026-09-21T10-00-00-000Z-audit/choose.json")`
donne `data/logs/t/2026-09-21T10-00-00-000Z-audit/choose.json`, dont le dossier
parent `…-audit/` n'a jamais été créé par le `mkdir` de la ligne 44. `writeFile`
rejette avec `ENOENT`, et on retombe *exactement* sur le premier constat — mais
de façon déterministe, à chaque itération `completed`, jusqu'à ce que
l'utilisateur renomme ses nœuds. La plage meurt après le premier `completed`,
sans qu'aucun journal n'explique pourquoi, et le message affiché
(`plage interrompue par une erreur : ENOENT … .json`) ne pointe pas vers la
cause (le nom du nœud).

Accessoirement, `path.join` normalise les segments `..` : un nœud nommé
`x/../../../evil` écrit son fichier hors de `logs/<tâche>`, dans `data/`. Ce
n'est pas un vecteur d'attaque (le `task.json` est écrit par l'opérateur), mais
c'est la même cause : un identifiant libre concaténé dans un chemin.

Deux corrections possibles et indépendantes : valider les clés de `nodes` dans
`TaskFileSchema` au même titre que le nom de tâche, et/ou assainir `rec.node`
dans `log.ts` (remplacer tout ce qui n'est pas `[A-Za-z0-9._-]`) — le nom exact
du nœud reste de toute façon dans le corps JSON du fichier (`rec.node`) et dans
la ligne d'index.

## Ce qui a été vérifié et tient

- **Collision de noms de fichiers** : `${stamp}-${node}.json` où `stamp` porte la
  milliseconde (`startedAt.toISOString()` avec `:` et `.` remplacés par `-`).
  Pour collisionner il faudrait deux itérations de la même tâche sur le même
  nœud démarrées dans la même milliseconde ; `runWindow` (`scheduler.ts:83-139`)
  n'en lance qu'une à la fois et une session Claude dure des minutes. Aucun
  chemin de production n'injecte un `now()` figé (`scheduler.ts:66` appelle
  `iterate` sans `deps`) — seuls les tests le font. Rien à signaler.
- **`index.jsonl`** : le fichier n'est relu par aucun code (`grep` : seuls
  `log.ts:66` et deux mentions du README) ; une ligne manquante ou malformée n'a
  donc pas d'effet à l'exécution, seulement sur la lecture humaine. Le
  `mkdir(logs/<tâche>, {recursive:true})` de la ligne 44 crée `logs/` au
  passage, donc l'`appendFile` de la ligne 66 ne peut pas échouer faute de
  parent. Un seul processus écrit (le démon, propriétaire de `state.json`), et
  `appendFile` ouvre en `O_APPEND` : pas d'entrelacement de lignes à craindre.
  `path.relative(cfg.dataDir, file)` (ligne 64) est correct, `logsDir` étant
  toujours sous `dataDir` (`log.ts:38`).
- **Cohérence du contenu en cas d'échec de commit** : `outcome` est bien
  réaffecté en `fatal:docker` et `committed` laissé à `false` (`iterate.ts:176`)
  *avant* la construction de `rec` (ligne 192), et `finalDecision` (ligne 188)
  recalcule `stop-window`. Le journal ne revendique donc jamais un commit qui
  n'a pas eu lieu. Les trous de rollback résiduels sur `ts.last` et
  `ts.consecutiveFailures` sont déjà consignés en 005 et ne sont pas repris ici.
- **Chemins `fatal` précoces** : `finishFatal` (`iterate.ts:232`) renvoie
  `logFile: null` sans rien écrire pour un token absent, une variable
  d'environnement manquante ou un `DockerError` au lancement. C'est cohérent —
  aucune session n'a tourné, il n'y a rien à journaliser — et
  `iterate.test.ts:145` le fige explicitement.
- **`quotaSnapshot`** (`claude.ts:115-127`) rend `null` quand l'événement ne
  porte aucune fenêtre, et `iterate.ts:152-153` gère un tableau vide
  (`rateLimits[0]` vaut `undefined`, accepté par la signature). Les colonnes
  `fiveHourBefore`/`After` de l'index tombent alors à `null` plutôt que de
  planter.
