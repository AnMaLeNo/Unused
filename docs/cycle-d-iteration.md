# Le cycle d'une itération

Une **itération** est le grain d'exécution du runner : une session `claude -p`
sur le nœud courant d'une tâche, dans son container. C'est `iterate()`
(`src/iterate.ts`) qui l'orchestre, et `src/graph.ts` qui décide, à partir de
la façon dont la session s'est terminée, ce que ça signifie pour la tâche.

## Vue d'ensemble

```
iterate(cfg, task, state)
  1. lit le curseur (ts.cursor) → le nœud à exécuter
  2. construit le prompt et la commande claude
  3. lance runInTask (container, timeout, arrêt possible via AbortSignal)
  4. parse la sortie stream-json → classify() → Outcome
  5. applyOutcome() → met à jour TaskState, retourne une Decision
  6. completed → commitTask ; sinon → discardContainer + DONE retiré
  7. écrit le log d'itération, retourne un IterateResult
```

## De la session à l'`Outcome`

`iterate()` ne lit jamais ce que Claude a produit — seulement comment la
session s'est terminée, et si le skill a déposé `/exchange/DONE`. Ce jugement
est fait par `classify()` dans `src/graph.ts` :

```ts
export function classify(
  session: { result: ClaudeResult | null; rateLimits: RateLimitInfo[] },
  done: boolean,
): Outcome {
  const rejected = quotaRejection(session.rateLimits);
  if (rejected) return { kind: "quota", reason: rejected.rateLimitType, resetsAt: rejected.resetsAt };
  const r = session.result;
  if (r?.terminal_reason === "completed") return { kind: "completed", done };
  if (r?.api_error_status !== undefined && r.api_error_status !== null && AUTH_STATUSES.has(r.api_error_status)) {
    return { kind: "fatal", reason: "auth", detail: `HTTP ${r.api_error_status} : ${r.result ?? "authentification refusée"}` };
  }
  return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
}
```

Le quota est détecté via les événements `rate_limit_event` (`quotaRejection`,
`src/claude.ts`), pas via `terminal_reason` : `blocking_limit` y désigne une
fenêtre de contexte pleine, pas un quota épuisé. `iterate()` ajoute deux cas
que `classify` ne voit pas, détectés avant même d'atteindre le parsing :

```ts
if (aborted) outcome = { kind: "failure", reason: "aborted" };
else if (timedOut) outcome = { kind: "failure", reason: "timeout" };
else if (session.lines === 0 && isDockerDown(r.stderr)) outcome = { kind: "fatal", reason: "docker", detail: r.stderr.trim() };
else outcome = classify(session, done);
```

`Outcome` (`src/graph.ts`) a quatre formes :

- `completed` — la session s'est terminée proprement ; `done` dit si le skill
  a créé `/exchange/DONE`.
- `quota` — quota saturé (`rejected`) ; ni la tâche ni le nœud ne bougent,
  tout le monde attend, éventuellement jusqu'à `resetsAt`.
- `failure` — tout le reste : erreur API, crash, sortie illisible, timeout,
  contexte plein, arrêt demandé.
- `fatal` — panne globale (`auth` ou `docker`) : rien ne peut réussir tant que
  ce n'est pas réparé.

## De l'`Outcome` à la `Decision`

`applyOutcome()` traduit l'issue en mise à jour de `TaskState` et en
`Decision` pour le runner :

```ts
switch (outcome.kind) {
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
  case "quota":
    return "backoff";
  case "fatal":
    return "stop-window";
  case "failure": {
    ts.consecutiveFailures += 1;
    if (ts.consecutiveFailures >= opts.maxConsecutiveFailures) {
      ts.status = "failed";
      return "task-failed";
    }
    return "retry";
  }
}
```

Seul un `completed` fait avancer le curseur (`ts.cursor = node.next`) ou
termine la tâche (`done` → `status = "done"`). Un `failure` incrémente
`consecutiveFailures` et fait échouer la tâche (`status = "failed"`) une fois
`maxConsecutiveFailures` (config du scheduler) atteint ; sinon on retente le
même nœud. `quota` et `fatal` ne touchent ni le curseur ni les compteurs
d'échec : ce n'est pas la tâche qui a un problème.

`applyDecision()` répercute la `Decision` sur la file d'attente du runner
(`RunnerState.currentTask`/`lastTask`, voir `src/scheduler.ts`) : une tâche
reste "collante" (`currentTask`) tant qu'elle n'a pas rendu la main proprement
(`backoff`, `retry`, `stop-window`) ; elle libère la place (`currentTask =
null`) sur `next-task`, `task-done` ou `task-failed`.

## Commit ou rejet : le container comme vérité

La règle centrale, rappelée en commentaire en tête de `src/graph.ts` : **une
itération qui ne se termine pas en `completed` est réputée n'avoir jamais eu
lieu.** `iterate()` l'applique après `applyOutcome` :

```ts
let committed = false;
if (outcome.kind === "completed") {
  try {
    await deps.commitTask(cfg, task.name, r.container);
    committed = true;
  } catch (err) {
    if (!(err instanceof DockerError)) throw err;
    // Le travail est fait mais l'état ne peut pas être conservé : on ne
    // ment pas au curseur, l'itération est réputée n'avoir jamais eu lieu.
    outcome = { kind: "fatal", reason: "docker", detail: err.message };
    ts.cursor = nodeName;
    ts.iterations -= 1;
    ts.status = "running";
    await deps.discardContainer(r.container);
    await rm(donePath, { force: true });
    applyDecision(state, task, "stop-window");
  }
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

- `completed` réussi → `commitTask` (`src/docker.ts`) fige le container comme
  nouvel état persistant de la tâche.
- `completed` mais dont le commit Docker échoue → tout est annulé après coup :
  curseur remis à `nodeName`, `iterations` décrémenté, statut remis à
  `running`, container jeté, `DONE` retiré, et la décision est forcée à
  `stop-window` — le travail a bien eu lieu dans le container, mais comme
  l'état ne peut pas être conservé, on ne l'enregistre pas plutôt que de
  mentir sur le curseur.
- tout le reste (`quota`, `failure`, `fatal` immédiat) → `discardContainer` et
  suppression d'un `DONE` qui aurait pu être laissé par le skill, pour que le
  rejeu reparte exactement de l'état d'avant l'itération.

Un `DONE` qui traînerait d'une itération précédente est aussi purgé *avant*
le lancement (`await rm(donePath, { force: true })` en haut de `iterate()`),
pour ne jamais l'attribuer par erreur à la session en cours.

## Pannes et arrêt

Deux pannes sont détectées avant même de lancer le container : le token
`CLAUDE_CODE_OAUTH_TOKEN` absent, ou une variable requise par `task.def.env`
manquante dans l'environnement du démon (`resolveEnv`, voir
[le modèle de tâche](modele-de-tache.md)). Les deux sont des `fatal` immédiats
(`finishFatal`), sans même essayer `runInTask`.

Un arrêt demandé en cours de session (`opts.signal`) tue le container
(`onAbort`) mais ne compte ni comme échec ni comme quoi que ce soit :
`applyDecision` n'est pas appelée, l'état n'est pas sauvegardé, et la
décision retournée est simplement `retry` — la prochaine itération repart du
même nœud, comme si celle-ci n'avait pas existé. Un timeout
(`cfg.claude.timeoutMinutes`), lui, est un `failure` classé normalement (donc
compté dans `consecutiveFailures`).

## Le log d'itération

Chaque appel à `iterate()` — sauf `dryRun` — écrit un enregistrement complet
(`IterationRecord`) via `writeIterationLog` (`src/log.ts`) : commande,
prompt, code de sortie, coût, quota avant/après, `Outcome`, `Decision` finale
et si le commit a eu lieu. C'est le sujet de la page sur les logs
d'itération.
