# 058 — Surplace : le seul plafond de coût atteignable est classé en échec, donc il détruit le travail qu'il interrompt

**Fichiers examinés** : `src/graph.ts:15-32` (`Outcome`, `Decision`),
`src/graph.ts:41-53` (`classify`), `src/graph.ts:64-105` (`applyOutcome`),
`src/graph.ts:107-133` (`isEligible`, `pickNext`), `src/graph.ts:139-153`
(`applyDecision`), `src/scheduler.ts:83-139` (la boucle de plage et ses
compteurs), `src/scheduler.ts:141-155` (fin de plage), `src/log.ts:7-35`
(`IterationRecord`), `src/log.ts:42-67` (`writeIterationLog`, `index.jsonl`),
`src/iterate.ts:150-190` (classement, rejet du container, rollback de commit),
`src/iterate.ts:219-230` (affichage), `src/claude.ts:25-38` (`buildCommand`),
`src/claude.ts:40-52` (`ClaudeResult`), `src/config.ts:12-42` (les seuls
réglages), `src/state.ts:9-20` (ce qui est persisté par tâche),
`src/task.ts:28-39` (`NodeSchema`, dont `args`), `src/daemon.ts:375-407`
(`taskInfo`, `resetTask`), `src/cli.ts:88-123` (surfaces de l'opérateur),
`unused.config.json`, `docker/Dockerfile`, `README.md:1-24,100-128`,
`src/graph.test.ts`, `src/scheduler.test.ts`.

Sondes faites contre le binaire réellement installé par `docker/Dockerfile`
(l'installeur n'épingle rien, la version du jour est `claude 2.1.272`,
`/root/.local/share/claude/versions/2.1.272`) : options de ligne de commande,
construction du cadre `result` final, raison de fin de boucle sur plafond de
tours. Détails dans le constat. Pas d'exécution possible du dépôt lui-même :
`node` et `node_modules` sont absents de ce container, donc ni `vitest` ni
`tsx` — le reste est établi ligne à ligne.

**Verdict** : 1 constat (sûr)

Cadrage. L'absence de garde-fou côté runner — ni plafond d'itérations, ni
plafond de coût, ni détection de stagnation, et un `completed` vide qui remet
`consecutiveFailures` à zéro — est déjà instruite en **054 §1**, avec le
scénario du nœud `work → work` qui boucle à vie en affichant « 57 itérations,
dernier work → completed ». La comptabilité de la plage (itération fantôme
comptée, coût perdu quand il n'y a pas de cadre `result`, contradiction avec le
compteur de la tâche) est instruite en **021** ; la sortie définitive de la file
en **018** ; le `README.md:3-6` assume par ailleurs explicitement les tâches
infinies « jusqu'à taper la limite », c'est-à-dire le quota comme unique
frein (**046**). Ce rapport ne les redit pas. Il examine la question d'après :
l'opérateur qui veut poser lui-même un plafond par tâche a-t-il un moyen, et
que fait le runner quand ce plafond se déclenche ?

## Le plafond de coût ou de tours posé par l'opérateur produit un `failure` : la session est payée, son travail est détruit, et trois déclenchements sortent la tâche de la file

**Gravité** : sûr
**Où** : `src/graph.ts:52` (classement), `src/iterate.ts:184-187` (destruction),
`src/graph.ts:96-103` (compteur d'échecs), avec `src/claude.ts:25-38`
(le passe-plat) et `src/task.ts:36` (`args` du nœud)

Le runner n'offre aucun réglage de plafond (`ConfigFileSchema.scheduler` :
`backoffMinutes`, `retrySeconds`, `maxConsecutiveFailures`, `src/config.ts:33-42`).
Le seul levier réellement à disposition de l'opérateur est donc celui de la
CLI, et il passe : `buildCommand` ne filtre que `--output-format` (avec sa
valeur) et `--verbose`, tout le reste de `cfg.claude.sessionArgs` et de
`node.args` est recopié tel quel :

```ts
// src/claude.ts:28-37
for (let i = 0; i < src.length; i++) {
  const a = src[i]!;
  if (a === "--output-format") { i++; continue; }
  if (a.startsWith("--output-format=") || a === "--verbose") continue;
  args.push(a);
}
return ["claude", "-p", ...args, "--output-format", "stream-json", "--verbose"];
```

et `NodeSchema` invite à s'en servir (`src/task.ts:36` : « Arguments `claude`
propres à ce nœud (ex. `["--model", "opus"]`) »). Les deux options existent bien
dans le binaire installé :

```
--max-turns <turns>        Maximum number of agentic turns in non-interactive
                           mode. This will early exit the conversation after
                           the specified number of turns. (only works with --print)
--max-budget-usd <amount>  Maximum dollar amount to spend on API calls
```

Ce que la CLI émet quand l'une d'elles se déclenche, lu dans le constructeur du
cadre `result` final (même binaire ; `Io` est la partie commune du cadre, `Mr`
la raison de fin de boucle) :

```js
let Io = { duration_api_ms:aC(), stop_reason:Cr, session_id:oo,
           total_cost_usd:Su(), usage:Ui(), modelUsage:ik(),
           permission_denials:co, terminal_reason:Mr, … },
    Jr = Mr === "budget_exhausted"
          ? {...$W({common:{...Io, is_error:!0, …},
                    variant:{subtype:"error_max_budget_usd", …}}), …}
       : Kn===null && Er===void 0 && sr
          ? {...$W({common:{...Io, is_error:!0, …},
                    variant:{subtype:"error_max_turns", …}}), …}
```

`terminal_reason` vaut donc `Mr` tel quel : `"budget_exhausted"` sur plafond de
dollars (la branche le teste littéralement), et `"max_turns"` sur plafond de
tours — c'est la valeur que rend la boucle quand elle s'arrête là :

```js
yield cn({type:"max_turns_reached", maxTurns:U, turnCount:Iu}, Ue),
…, { reason:"max_turns", turnCount:Iu }
```

Ni l'une ni l'autre n'est `"completed"`, et `classify` ne reconnaît que cette
chaîne-là :

```ts
// src/graph.ts:48-52
if (r?.terminal_reason === "completed") return { kind: "completed", done };
…
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

C'est d'ailleurs assumé par le commentaire du type : « Tout le reste : erreur
API, crash, sortie illisible, contexte plein (`blocking_limit`), coupure par
budget/tours… » (`src/graph.ts:20-22`). Ce qui ne l'est pas, c'est la suite.
Un `failure` fait exécuter la branche de rejet :

```ts
// src/iterate.ts:184-187
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

et incrémente le budget d'échecs :

```ts
// src/graph.ts:96-103
case "failure": {
  ts.consecutiveFailures += 1;
  if (ts.consecutiveFailures >= opts.maxConsecutiveFailures) {
    ts.status = "failed";
    return "task-failed";
  }
  return "retry";
}
```

**Scénario concret**, avec le dépôt tel qu'il est livré (`unused.config.json` :
`maxConsecutiveFailures: 3`, `retrySeconds: 60`, plage automatique lundi
00:00→13:00). L'opérateur constate le surplace décrit en 054 §1 et veut borner
la dépense de cette tâche : il ajoute `"args": ["--max-budget-usd", "5"]` au
nœud dans `task.json`. Attendu : chaque itération s'arrête à 5 $ et conserve ce
qu'elle a produit. Obtenu, trois fois de suite :

1. la session travaille réellement dans le container (fichiers écrits, paquets
   installés, dépôt cloné), atteint 5 $, et la CLI émet
   `{subtype:"error_max_budget_usd", is_error:true,
   terminal_reason:"budget_exhausted", total_cost_usd:≈5}` ;
2. `classify` → `{kind:"failure", reason:"budget_exhausted"}`
   (`src/graph.ts:52`) ;
3. `src/iterate.ts:185-186` : `docker rm -f` du container — les 5 $ de travail
   sont détruits — et `rm` de `/exchange/DONE`. Si le skill avait justement
   déposé `DONE` avant d'être coupé, le signal de fin est détruit avec le
   reste ;
4. `applyOutcome` → `consecutiveFailures = 1`, curseur inchangé, `"retry"` ;
   le scheduler attend `retrySeconds` (60 s, `src/scheduler.ts:133-134`) et
   rejoue le même nœud, qui repartira de l'image d'avant ;
5. au troisième déclenchement : `consecutiveFailures >= 3` → `ts.status =
   "failed"`, `"task-failed"`, `isEligible` est faux pour toujours
   (`src/graph.ts:107-110`). La seule remise en file est `unused tasks reset`,
   qui appelle `removeTaskImages` (`src/daemon.ts:400-404`) : tout l'historique
   de la tâche est détruit avec elle (déjà noté en 054 §2).

Bilan : 15 $ dépensés — et correctement comptés, cette fois, le cadre `result`
étant bien émis (`src/scheduler.ts:102`, `src/log.ts:57`) —, rien conservé, la
tâche sortie de la file. Sans le plafond, la même tâche tournait en rond
indéfiniment mais **commitait** chaque itération. Poser le plafond est donc
strictement pire que ne pas le poser : il ne borne pas la dépense (il la
multiplie par `maxConsecutiveFailures` avant de rendre la main), et il convertit
un surplace en perte sèche.

Le mécanisme n'a rien de spécifique au plafond de coût : il vaut pour toute
coupure propre décidée *pendant* que le travail avance. Ce qui le rend
particulier, c'est qu'ici la coupure est celle que l'opérateur a demandée, et
que c'est le seul outil qu'on lui laisse pour répondre au problème de 054 §1.

Détail d'affichage, dans le même sens : `index.jsonl` enregistre
`outcome: "budget_exhausted"` et `decision: "retry"` (`src/log.ts:53-56`), et
`unused status` affiche `dernier work → budget_exhausted` (`src/cli.ts:119-120`) —
donc l'information existe, mais dans la même colonne et le même format qu'un
crash ou un `prompt_too_long`, sans rien qui distingue « coupé par le plafond
que j'ai posé » de « la session s'est cassée ».

## Ce qui a été vérifié et tient

- **Le compteur d'itérations de la tâche est cohérent.** `ts.iterations` n'est
  incrémenté que dans la branche `completed` (`src/graph.ts:83`), et le
  `ts.iterations -= 1` du rollback de commit (`src/iterate.ts:178`) ne peut
  s'exécuter qu'après cet incrément : la branche de commit exige
  `outcome.kind === "completed"` (`src/iterate.ts:168`), et le seul chemin qui
  saute `applyOutcome` est l'abandon (`aborted`), dont l'issue est un `failure`
  qui ne passe pas par là. Pas de dérive possible vers le négatif, donc pas de
  `state.json` rejeté par `TaskStateSchema` (`src/state.ts:14`) de ce côté.
- **`ts.iterations` et `WindowSummary.costUsd` ne sont lus par aucune
  décision** : `grep -rn "iterations\|costUsd" src/` ne donne que des
  incréments, des recopies (`src/daemon.ts:261-262`, `src/daemon.ts:383`) et
  des affichages (`src/cli.ts:100-120`). Aucun seuil nulle part — c'est le
  constat de 054 §1, re-vérifié, pas un constat neuf.
- **La boucle de plage n'a pas d'autre sortie que les quatre connues**
  (`src/scheduler.ts:83-139`) : fin de plage réévaluée à chaque tour,
  `shouldStop`, `nothing-eligible`, `fatal`. Le `break` du cas `backoff` quand
  `wait <= 0` (`src/scheduler.ts:116`) sort du `switch`, pas de la boucle : le
  tour suivant retombe sur la condition `deps.now() < until()` et s'arrête
  proprement. Pas de boucle chaude : chaque tour lance un container.
- **`decision === "stop-window"` implique toujours `outcome.kind === "fatal"`**
  (`src/graph.ts:94-95` et `src/iterate.ts:188`), donc `summary.fatal` est
  toujours renseigné dans cette branche et le `?? "?"` de
  `src/scheduler.ts:126` est du code mort — rien à signaler, mais inutile de le
  re-sonder.
- **`pickNext` ne peut pas boucler sur une tâche inéligible** : `eligible` et
  `candidate` viennent du même tableau (celui que rend `loadTasks()` au tour
  courant, `src/scheduler.ts:88`), donc l'`includes` par identité
  (`src/graph.ts:130`) est correct malgré le rechargement à chaque itération.
- **La traçabilité d'une itération vide existe dans `index.jsonl`** : `turns`
  et `durationMs` y sont (`src/log.ts:56-58`), donc une stagnation est
  détectable *a posteriori* (`jq 'select(.turns < 3)'`) même si aucune surface
  en direct ne la montre. C'est la nuance à apporter à 054 §1 : l'opérateur
  n'est pas aveugle, il est seulement non alerté.
- **Faits établis contre le binaire 2.1.272, pour ne pas les re-sonder** :
  `terminal_reason` est bien le champ `Mr` recopié tel quel dans les quatre
  branches du cadre `result` (confirmation directe de ce que 020 avait relevé) ;
  la raison de fin sur plafond de tours est `"max_turns"`, sur plafond de
  dollars `"budget_exhausted"` ; `total_cost_usd` fait partie de la partie
  commune `Io`, donc il est présent même sur ces coupures ; la liste interne des
  raisons est `["blocking_limit","rapid_refill_breaker","prompt_too_long",
  "image_error","model_error","api_error","malformed_tool_use_exhausted",
  "aborted_streaming","aborted_tools","stop_hook_prevented","hook_stopped",
  "tool_deferred","max_turns","background_requested","completed"]` et les
  quatre raisons supplémentaires traitées comme erreurs sont
  `["budget_exhausted","structured_output_retry_exhausted",
  "tool_deferred_unavailable","turn_setup_failed"]`. Le binaire est lisible au
  `grep` depuis ce container (`/root/.local/share/claude/versions/2.1.272`,
  217 Mio) ; `strings` n'y est pas, `tr -c '[:print:]\n' '\n'` fait le travail
  en une passe.
- **Déjà instruit, non repris ici** : surplace sans borne et `completed` vide
  (054 §1), retour impossible sur un nœud sans détruire la tâche (054 §2),
  comptabilité de la plage et coût perdu sur session tronquée (021), sortie
  définitive de la file (018), quota comme unique frein et rejection périmée qui
  jette une itération réussie (046, 043), `ts.last` qui garde l'étiquette
  `completed` d'un commit échoué (057), nœuds inatteignables (044), clés de
  `nodes` non validées (011, 026).
