# 037 — Issue `aborted` : collision entre l'arrêt demandé et la fin de session

**Fichiers examinés** : `src/graph.ts:34-53` (`classify`) et `src/graph.ts:64-105`
(`applyOutcome`), `src/iterate.ts:112-190` et `src/iterate.ts:230` (pose du
drapeau `aborted`, issue, valeur de retour), `src/scheduler.ts:83-139`
(`runWindow`, filtre d'abandon ligne 100) et `src/scheduler.ts:141-149` (sortie
de plage), `src/daemon.ts:177-226` (`execute`, `finally`) et
`src/daemon.ts:253-275` (`onEvent`), `src/claude.ts:40-52` (`ClaudeResult`) et
`src/claude.ts:86-112` (`parseStream`), `src/docker.ts:130-150` (`runInTask`),
`src/log.ts:41-68`, `docker/Dockerfile:13`.

Vérifications faites contre le vrai binaire `claude 2.1.272`
(`/root/.local/share/claude/versions/2.1.272`) : liste interne des valeurs de
`terminal_reason`, recherche exhaustive des affectations du champ, prédicat
interne « cette raison est-elle un abandon ».

**Verdict** : 1 constat (probable) — **l'hypothèse de départ, elle, ne tient
pas** : la CLI n'émet jamais `terminal_reason: "aborted"`, la collision de
chaînes n'est pas atteignable aujourd'hui (détail dans la dernière section).

## Le coût d'une itération abandonnée est perdu des deux comptabilités, alors qu'il est connu

**Gravité** : probable
**Où** : `src/scheduler.ts:100-102`, `src/daemon.ts:260-263`

Le filtre d'abandon est placé **avant** l'addition du coût :

```ts
// src/scheduler.ts:100-102
if (r.outcome.kind === "failure" && r.outcome.reason === "aborted") break;
summary.iterations += 1;
summary.costUsd += r.costUsd ?? 0;
```

```ts
// src/daemon.ts:260-263
if (!(e.result.outcome.kind === "failure" && e.result.outcome.reason === "aborted")) {
  run.live.iterations += 1;
  run.live.costUsd += e.result.costUsd ?? 0;
```

Ne pas compter l'itération est voulu (`iterate.ts:161` : « un arrêt demandé ne
compte ni comme échec ni comme quoi que ce soit ») et cohérent avec le fait que
l'état n'est pas sauvé (`iterate.ts:189`) : le travail est jeté, le curseur ne
bouge pas. Mais le coût, lui, n'est pas jeté par l'abandon : il a été facturé.
Et `iterate` le remonte quand même, sans regarder le drapeau :

```ts
// src/iterate.ts:230
return { node: nodeName, outcome, decision: finalDecision, logFile, costUsd: session.result?.total_cost_usd, quotaAfter };
```

Il suffit donc qu'un cadre `result` soit présent dans la sortie d'une session
abandonnée pour que `r.costUsd` soit un vrai nombre que personne n'additionne.
C'est le cas dès que le container n'a pas été tué, et ce chemin existe : à
`docker.ts:147`, `onStart` est appelé **avant** le `docker run` de la ligne 148,
donc un abandon déjà levé à cet instant (`iterate.ts:137`) lance
`docker kill unused-<tâche>-<ts>` sur un container qui n'existe pas encore ;
l'échec est avalé (`killContainer` est un `void docker([...])`, `iterate.ts:28`)
et aucun écouteur n'est posé ensuite (`iterate.ts:138` est dans le `else`).
La session tourne alors jusqu'au bout — jusqu'à `timeoutMinutes`, 180 min dans
`unused.config.json` — et rend une sortie complète. Cette fenêtre de course est
instruite en 001 et 027 ; ici elle sert seulement de déclencheur.

**Scénario concret.** Plage automatique en cours, `unused stop --now` tapé
pendant que `iterate` est entre `resolveTaskImage` et la création effective du
container. `run.ac.abort()` (`daemon.ts:321`) → `aborted = true`, kill dans le
vide → la session part quand même et se termine normalement 40 min plus tard sur
`{"type":"result","terminal_reason":"completed","total_cost_usd":1.37,…}`.
`iterate` rend `{ outcome: failure/aborted, costUsd: 1.37 }`, jette le container
et écrit son journal. Attendu : la plage avoue 1,37 $ consommés (le travail est
perdu, l'argent pas). Obtenu : `break` à `scheduler.ts:100` → `summary.costUsd`
reste à 0 et `run.live.costUsd` aussi, donc :

```
fin de plage (stopped) : 0 itérations, 0 completed, 0 échecs, 0 attentes quota, $0.00
```

La donnée existe pourtant sur le disque à côté : `log.ts:57` écrit
`costUsd: 1.37` dans `index.jsonl` pour cette même itération, et `quotaAfter`
(remonté lui aussi par `iterate.ts:230`) porte la consommation de quota
réellement faite. Seuls `lastWindow` et `status` mentent.

À noter : ce cas contredit la ligne de partage posée en 021 (« les itérations
qui rendent un `result` … comptent leur coût correctement ; celles qui tournent
jusqu'à la limite de temps comptent zéro »). Une itération abandonnée peut
rendre un `result` **et** compter zéro.

## Ce qui a été vérifié et tient

- **L'hypothèse de la collision de chaînes ne tient pas.** `classify` recopie
  `terminal_reason` tel quel dans `reason` (`graph.ts:52`), et `iterate` utilise
  la même chaîne `"aborted"` comme marqueur d'arrêt demandé (`iterate.ts:156`) :
  les deux valeurs partagent bien le même espace de noms, et deux consommateurs
  lisent le marqueur par égalité de chaîne (`scheduler.ts:100`,
  `daemon.ts:260`). Mais la valeur `"aborted"` n'est pas dans le vocabulaire de
  la CLI. Liste interne de `claude 2.1.272`, celle qui alimente le schéma zod
  du champ (`OU = [...Boe, ...Hoe]`) :

  ```js
  Boe=["blocking_limit","rapid_refill_breaker","prompt_too_long","image_error",
  "model_error","api_error","malformed_tool_use_exhausted","aborted_streaming",
  "aborted_tools","stop_hook_prevented","hook_stopped","tool_deferred","max_turns",
  "background_requested","completed"]
  Hoe=["budget_exhausted","structured_output_retry_exhausted",
  "tool_deferred_unavailable","turn_setup_failed"]
  function Vx(e){return e==="aborted_streaming"||e==="aborted_tools"}
  ```

  L'abandon s'y nomme `aborted_streaming` ou `aborted_tools` — jamais `aborted`
  tout court, et `Vx` (le prédicat « est-ce un abandon ») ne connaît que ces
  deux-là. Recherche des affectations du champ dans le binaire : les seules
  littérales sont `terminal_reason:"aborted_tools"`,
  `"structured_output_retry_exhausted"`, `"tool_deferred_unavailable"`,
  `"turn_setup_failed"` ; `grep -ac 'terminal_reason:"aborted"'` donne **0**.
  Aucune des quatre raisons fabriquées par le runner (`aborted`, `timeout`,
  `dry_run`, `unreadable_output`) ne recoupe les 19 valeurs de la liste.
  **Fragilité restante, non démontrable** : `docker/Dockerfile:13` installe la
  CLI par `curl … install.sh`, sans version épinglée, et `parseStream` ne valide
  rien (`claude.ts:100` : cast direct). Le jour où une version émettrait un
  `aborted` nu, le scénario du registre deviendrait réel — d'où l'intérêt de
  savoir ce qu'il coûterait, ci-dessous.
- **Un drapeau `aborted` implique toujours `signal.aborted`.** `aborted` n'est
  posé que dans `onAbort` (`iterate.ts:133-136`), `onAbort` n'est branché que sur
  `opts.signal` (lignes 137-138), un `AbortSignal` passe `aborted` à vrai avant
  d'appeler ses écouteurs, et `runWindow` passe son propre `signal` à
  `runIteration` (`scheduler.ts:66`, `scheduler.ts:98`) — seul `daemon.ts:192`
  appelle `runWindow` en production, sans remplacer `runIteration`. Donc le
  `break` de la ligne 100 n'est jamais pris avec `signal.aborted` faux, et la
  conséquence que redoutait le registre est aujourd'hui inatteignable : il
  faudrait ce cas pour que `scheduler.ts:141-149` garde `endedBecause: "window"`,
  efface `state.window` (plage non reprise au redémarrage) et laisse
  `daemon.ts:223` remettre `this.manual` à nul — une plage manuelle perdue en
  silence au premier tour. Rien à corriger, mais c'est bien ce qui est en jeu
  derrière l'égalité de chaîne.
- **Les deux filtres d'abandon sont identiques et au bon endroit.**
  `scheduler.ts:100` et `daemon.ts:260` testent la même condition ; sur abandon,
  `applyOutcome`/`applyDecision` ne sont pas appelés (`iterate.ts:162-165`),
  `ts.last` et `consecutiveFailures` ne bougent pas, l'état n'est pas sauvé
  (`iterate.ts:189`) et le container est jeté (`iterate.ts:185`) : l'itération
  est réellement « réputée n'avoir jamais eu lieu », conformément au commentaire
  de `graph.ts:10-13`. Le seul écart est le coût, ci-dessus.
- **`aborted_streaming` / `aborted_tools` sont traités en échecs ordinaires**
  (`graph.ts:52` → `applyOutcome` → `retry`, puis `task-failed` au bout de
  `maxConsecutiveFailures`), ce qui est le bon traitement : la session s'est
  arrêtée au milieu de son unité de travail, l'itération doit être rejouée. Pas
  de confusion possible avec le marqueur du runner, les chaînes diffèrent.
