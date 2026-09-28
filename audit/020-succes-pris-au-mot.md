# 020 — Succès pris au mot : `is_error` et `subtype` ignorés, tout repose sur `terminal_reason`

**Fichiers examinés** : `src/graph.ts:34-53` (`classify`), `src/claude.ts:40-51`
(`ClaudeResult`) et `src/claude.ts:86-110` (`parseStream`),
`src/iterate.ts:150-231` (usage de l'issue, journal, affichage),
`src/task.ts:119-160` (`loadTask`, vérification des skills), `src/scaffold.ts`,
`src/config.ts:12-21`, `src/cli.ts:119`, `docker/Dockerfile`,
`src/graph.test.ts:28-67`, `src/claude.test.ts:37-70`.

Vérifications faites contre le vrai binaire — `claude 2.1.272`, exactement
celui qu'installe `docker/Dockerfile` (`/root/.local/share/claude/versions/2.1.272`) :
forme réelle du cadre `result` dans plusieurs cas, schéma zod du message
`result` et documentation embarquée du champ `terminal_reason`, liste interne
des valeurs de `terminal_reason`, précédence skill de tâche / commande locale.

**Verdict** : 3 constats (1 sûr, 1 probable, 1 à vérifier)

## Le succès est lu dans un champ que la CLI déclare facultatif, alors que les deux champs documentés du contrat sont sous la main et ignorés

**Gravité** : probable
**Où** : `src/graph.ts:48` et `src/graph.ts:52`

Le seul signal de succès du runner est une égalité de chaîne sur
`terminal_reason` :

```ts
// src/graph.ts:47-52
const r = session.result;
if (r?.terminal_reason === "completed") return { kind: "completed", done };
…
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

`ClaudeResult` déclare pourtant `is_error` (`src/claude.ts:42`), le journal le
recopie (`src/iterate.ts:207`), et personne ne le lit : `grep -rn "is_error"
src/` ne donne que la déclaration. Idem pour le `subtype` du cadre `result` :
`parseStream` ne le regarde que sur les messages `system` (`src/claude.ts:106`),
jamais sur `result` (`src/claude.ts:99-101`).

Or `terminal_reason` n'est pas le champ qui dit si le tour a réussi. Dans le
schéma zod du binaire installé, c'est un champ **facultatif**, et sa
documentation embarquée dit exactement quand il manque :

```js
// claude 2.1.272, schéma du message result
oz = p(() => G(OU).describe(
  "Why the query loop terminated. Unset when the loop was bypassed (local slash command)."))
…
terminal_reason: oz().optional(),
```

Le contrat public, lui, est porté par `subtype` et `is_error` — c'est la
description du message `result` dans ce même schéma :

> The outcome of a turn. The CLI emits exactly one result message per turn […]
> subtype "success" carries the final assistant text in result — or, with
> is_error true, the error text when the turn ended on an API error; the error
> subtypes say why the turn stopped early.

Et un cadre de succès **sans** `terminal_reason` n'est pas une hypothèse : le
binaire en émet un aujourd'hui. Le prompt du runner est toujours une commande
slash (`buildPrompt` : `/<skill> …`, `src/claude.ts:15-18`) ; quand elle est
résolue par la CLI elle-même, la boucle est court-circuitée :

```
$ echo '/cost' | claude -p --output-format stream-json --verbose --dangerously-skip-permissions
{"is_error":false,…,"num_turns":0,…,"subtype":"success",
 "result":"Total cost: …","local_command":"cost","type":"result","duration_ms":108,…}
$ echo $?
0
```

Aucun `terminal_reason`. `subtype:"success"`, `is_error:false`, code de sortie
0 — trois signaux de succès, et `classify` renvoie
`{ kind: "failure", reason: "unreadable_output" }`.

**Scénario concret.** L'image de base est reconstruite : le Dockerfile
n'épingle rien (`RUN curl -fsSL https://claude.ai/install.sh | bash`), donc la
version est celle du jour, et `DISABLE_AUTOUPDATER=1` ne protège que
l'intérieur d'une session. Il suffit qu'une version émette son cadre de succès
sans `terminal_reason` (champ facultatif dès aujourd'hui), ou renomme
`completed`, pour que la nuit se déroule ainsi, sur **chaque** tâche : session
de 40 minutes qui réussit → `failure: "unreadable_output"` →
`discardContainer` (`src/iterate.ts:185`), le `docker commit` n'a pas lieu, le
travail de la session est détruit, `DONE` est effacé, le curseur ne bouge pas ;
trois fois de suite → `consecutiveFailures >= 3` → `status: "failed"`, la tâche
sort définitivement de la file (constat 018), et quand toutes y sont passées la
plage finit en `nothing-eligible`, ce qui met les plages automatiques en pause
(`src/daemon.ts:208-212`). Attendu : trois itérations commitées. Obtenu : trois
containers jetés, trois tâches retirées, aucune panne signalée — alors que le
cadre lu contenait `subtype:"success"` et `is_error:false`.

Le même raisonnement tenu à l'envers (`!r.is_error && r.subtype === "success"`)
aurait survécu à ce changement, et aurait par ailleurs continué de rejeter les
cas d'échec (voir la dernière section : `is_error` est mis à `true` sur
l'échec d'authentification, sur `error_max_turns`, sur `error_during_execution`).

Ce qui limite aujourd'hui l'exposition — et qui n'est pas un garde-fou, juste
un fait de la version 2.1.272 : `loadTask` exige `skills/<skill>/SKILL.md`
(`src/task.ts:147-155`), donc la commande slash envoyée existe toujours, et un
skill de tâche gagne contre la commande locale de même nom (vérifié : un
`skills/compact/SKILL.md` monté dans `.claude/skills/` fait bien passer
`/compact` par la boucle, `num_turns:1`). Le chemin « commande locale » n'est
donc pas atteignable depuis un `task.json` valide — seule une évolution de la
CLI déclenche le constat.

## `unreadable_output` confond « aucun cadre result » et « un cadre result parfaitement lisible », et c'est dans le second cas que la sortie brute n'est pas jointe au journal

**Gravité** : sûr
**Où** : `src/graph.ts:52`, `src/iterate.ts:210`

Deux situations très différentes tombent sur la même étiquette :

```ts
// src/graph.ts:52
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

- `session.result === null` : la sortie était illisible ou tronquée — c'est le
  sens annoncé par `SessionStream.result` (`src/claude.ts:76`) et par le
  commentaire de `Outcome` (`src/graph.ts:20`).
- `session.result !== null` mais sans `terminal_reason` : la sortie était
  intégralement lisible, et le cadre `result` porte l'explication dans son
  propre champ `result`.

Et le journal traite ces deux cas exactement à l'envers de ce qu'il faudrait :

```ts
// src/iterate.ts:210
...(session.result === null ? { rawStdout: r.stdout } : {}),
```

La sortie brute n'est conservée que dans le premier cas. Dans le second,
l'opérateur voit `issue    unreadable_output → retry` (`src/iterate.ts:221`),
puis dans `unused status` : `dernier work → unreadable_output`
(`src/cli.ts:119`) — une étiquette qui l'envoie chercher une sortie tronquée
ou un container tué, c'est-à-dire du côté de Docker et du timeout, alors que la
CLI a répondu en 122 ms et a dit pourquoi. Démonstration avec le binaire
installé :

```
$ echo '/analyze repo=a/b branch=audit' | claude -p --output-format stream-json --verbose …
{"is_error":false,"num_turns":0,"subtype":"success",
 "result":"Unknown command: /analyze","type":"result","duration_ms":122,…}
```

`classify` sur ce cadre : pas de `rejected`, `terminal_reason` absent,
`api_error_status` absent → `failure: "unreadable_output"`. Le journal garde
bien l'objet `result` (`src/iterate.ts:207`), donc l'information n'est pas
perdue — elle est seulement absente de toutes les surfaces que l'opérateur
regarde d'abord, et l'étiquette dit le contraire de la vérité. Une seule
distinction (`result === null ? "unreadable_output" : "unknown_terminal_reason"`,
plus `rawStdout` dans les deux cas) suffirait.

## Un tour que la CLI qualifie elle-même d'erreur est commité comme un succès si sa raison de fin est `completed`

**Gravité** : à vérifier
**Où** : `src/graph.ts:48`, puis `src/iterate.ts:167-172`

`classify` accepte `completed` sans regarder ni `is_error` ni `subtype` ; en
face, le constructeur du cadre `result` de la CLI ne recale pas
`terminal_reason` quand il passe en `error_during_execution`. Branche par
branche (claude 2.1.272, fonction qui produit le cadre final ; `Mr` est la
raison de fin de boucle, `an` la liste d'erreurs d'exécution) :

```js
Jr = Mr === "budget_exhausted"
      ? {common:{...Io, is_error:!0, …}, variant:{subtype:"error_max_budget_usd", …}}
   : (Kn===null && Er===void 0 && sr)
      ? {common:{...Io, is_error:!0, …}, variant:{subtype:"error_max_turns", …}}
   : an !== null
      ? {common:{...Io, is_error:!0, …}, variant:{subtype:"error_during_execution", errors:an, …}}
      : {common:{...Io, is_error:Cn, …}, variant:{subtype:"success", …}}
// Io contient terminal_reason:Mr — tel quel, dans les quatre branches.
```

`an` est non nul quand le tour s'est terminé sur un dernier message qui ne
ressemble pas à une fin de tour légitime (ni texte/thinking assistant, ni
`tool_result`, ni `stop_reason: "end_turn"`) : la CLI émet alors un
`[ede_diagnostic] result_type=… last_content_type=… stop_reason=…`. Rien dans
cette branche ne remplace `Mr` : si la boucle s'est terminée en `completed`, le
cadre vaut `{subtype:"error_during_execution", is_error:true,
terminal_reason:"completed"}`.

Que la CLI considère `is_error` — et pas `terminal_reason` — comme l'autorité
se lit dans son propre moteur :

```js
if (Ye.is_error) { let it = Ye.subtype==="success" ? Ye.result : Ye.errors.join("; ");
  t(`[engine] turn ended in error: ${it}`, …) }
```

Elle tient d'ailleurs deux notions distinctes : la liste interne des raisons
(`blocking_limit`, `rapid_refill_breaker`, `prompt_too_long`, `image_error`,
`model_error`, `api_error`, `malformed_tool_use_exhausted`, `aborted_streaming`,
`aborted_tools`, `stop_hook_prevented`, `hook_stopped`, `tool_deferred`,
`max_turns`, `background_requested`, `completed`, `budget_exhausted`,
`structured_output_retry_exhausted`, `tool_deferred_unavailable`,
`turn_setup_failed`) et une fonction qui dit lesquelles valent erreur — huit
d'entre elles n'en sont pas, dont `max_turns` et `stop_hook_prevented`.

**Scénario concret.** Un nœud dont la session se termine sur un tour dégradé
(dernier message un bloc `tool_use` non exécuté, `stop_reason: "tool_use"`)
alors que la boucle s'arrête sans erreur : cadre
`{subtype:"error_during_execution", is_error:true, terminal_reason:"completed",
errors:["[ede_diagnostic] …"]}`. Attendu : itération jetée et rejouée, le skill
n'ayant pas fini son unité de travail. Obtenu : `classify` renvoie
`{kind:"completed"}`, `commitTask` scelle le container (`src/iterate.ts:170`),
`iterations += 1`, `consecutiveFailures = 0`, le curseur passe à `next`
(`src/graph.ts:89`), et le journal écrit `outcome: completed` à côté d'un
`result.is_error: true` que personne ne lira. Le nœud suivant démarre sur un
travail interrompu au milieu.

**Ce qui reste à vérifier** : que la boucle puisse effectivement rendre
`completed` dans cette branche (je n'ai pas pu produire de session réelle,
faute de token dans ce container — les sondes ci-dessus sont toutes des cas
sans appel API). Rien dans le code du constructeur ne l'interdit, et c'est la
seule combinaison dangereuse restante : les autres raisons non-erreur
(`max_turns`, `stop_hook_prevented`, `hook_stopped`, `tool_deferred`,
`background_requested`, `aborted_*`) sont déjà rejetées par la stricte égalité
à `completed`. Le test sur des journaux réels :
`jq 'select(.result.is_error == true and .outcome.kind == "completed")' data/logs/**/*.json`.

## Ce qui a été vérifié et tient

- **L'ordre de `classify` est bon.** Le `rejected` de quota est testé avant
  `completed` (`src/graph.ts:45-46`), donc une session qui se termine en
  `completed` après un `rate_limit_event` `rejected` part bien en `quota` et
  non en succès — `src/graph.test.ts:51` le couvre. La CLI documente bien
  `rate_limit_event` comme « emitted when rate limit info changes », cohérent
  avec le commentaire de `graph.ts:37-39` : `blocking_limit` est la fenêtre de
  contexte, pas le quota (la liste interne des raisons le confirme).
- **La panne d'auth n'est pas masquée par le chemin succès** : `api_error_status`
  n'est consulté qu'après le rejet de `completed`, et l'échec d'authentification
  réel donne `terminal_reason: "api_error"` + `api_error_status: 401` (vérifié
  en 012, et re-vérifié ici avec un token blanc : `subtype:"success"`,
  `is_error:true`, `result:"Not logged in · Please run /login"`).
- **Le cadre « zéroté »** que la CLI construit quand il n'y a pas d'issue de
  tour (`{subtype:"success", is_error:false, num_turns:0, result:""}`, sans
  `terminal_reason`) est rejeté par `classify` — par accident, mais dans le bon
  sens : un tour qui n'a rien fait ne doit pas être commité. C'est le
  contre-argument à un passage naïf à `is_error === false`, qui accepterait à
  la fois ce cadre et le `"Unknown command: /x"` du deuxième constat : il faut
  les deux conditions (`subtype === "success" && !is_error`) **et** garder le
  refus des `num_turns: 0`.
- **`parseStream` garde le dernier cadre `result`** (`src/claude.ts:100`) : en
  mode prompt unique la CLI en émet exactement un (« The CLI emits exactly one
  result message per turn […] In single-prompt (non-streaming-input) mode the
  process exits after the turn », et `result_index: 0` observé sur toutes les
  sondes), donc aucun écrasement à craindre ici ; le schéma du message `result` ne
  porte pas de `parent_tool_use_id`, contrairement aux messages `assistant` et
  `user`, ce qui va dans le sens d'un seul cadre par session même avec des
  sous-agents.
- **`loadTask` vérifie l'existence de `skills/<skill>/SKILL.md`**
  (`src/task.ts:147-155`), et la CLI enregistre le skill même avec un
  frontmatter absent, incomplet ou mal formé (quatre variantes testées : dans
  les quatre cas la boucle démarre). Le chemin « commande inconnue » n'est donc
  pas atteignable par une faute de frappe dans `task.json`, ni par un SKILL.md
  mal écrit : inutile de le rechercher de ce côté.
- **La stricte égalité à `completed` est du bon côté** pour les terminaisons
  non-erreur autres que `completed` : `stop_hook_prevented`, `hook_stopped`,
  `tool_deferred`, `background_requested` finissent en `failure` → container
  jeté, même nœud rejoué. Elles consomment le budget d'échecs, mais elles ne
  produisent pas de faux succès.
