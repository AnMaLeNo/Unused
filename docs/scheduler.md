# Le scheduler

`runWindow()` (`src/scheduler.ts`) fait tourner les tâches actives en
round-robin, une itération à la fois, jusqu'à une date de fin (`deadline`).
C'est la boucle appelée par le démon pendant une plage de travail (manuelle ou
automatique) ; elle ne connaît rien des plages elle-même, seulement une
`deadline` qu'on lui donne (fixe ou recalculée à chaque tour).

## Vue d'ensemble

```
runWindow(cfg, tasks, state, deadline, signal, deps)
  tant que la deadline n'est pas atteinte et qu'on ne doit pas s'arrêter :
    1. pickNext(tasks, state) → la tâche à jouer (round-robin + collante)
    2. runIteration(task, state, signal) → un IterateResult (iterate())
    3. selon r.decision : next-task/task-done, backoff, stop-window, retry/task-failed
    4. met à jour le résumé de plage, dort si besoin, boucle
  sauvegarde l'état, retourne un WindowSummary
```

`tasks` peut être un tableau fixe ou une fonction `() => Promise<Task[]>` :
dans ce dernier cas, les tâches sont rechargées à chaque itération, donc
modifier un `task.json` ou un skill pendant la plage est pris en compte
immédiatement (voir `loadTasks` dans `src/scheduler.ts:74`).

## Round-robin et tâche collante

Le choix de la prochaine tâche est délégué à `pickNext()` (`src/graph.ts:118`) :

```ts
export function pickNext(tasks: Task[], state: RunnerState): Task | null {
  const eligible = tasks.filter((t) => isEligible(t, state));
  if (eligible.length === 0) return null;

  if (state.currentTask !== null) {
    const sticky = eligible.find((t) => t.name === state.currentTask);
    if (sticky) return sticky;
  }

  const lastIdx = tasks.findIndex((t) => t.name === state.lastTask);
  for (let i = 1; i <= tasks.length; i++) {
    const candidate = tasks[(lastIdx + i) % tasks.length]!;
    if (eligible.includes(candidate)) return candidate;
  }
  return eligible[0]!;
}
```

Une tâche est éligible si elle est `active` dans son `task.json` et pas déjà
`done`/`failed` (`isEligible`, `src/graph.ts:108`). Deux règles priment :

- **Collante** : si `state.currentTask` est renseignée (une itération
  précédente n'a pas rendu la main proprement — `backoff`, `retry` ou
  `stop-window`), c'est elle qui rejoue, tant qu'elle reste éligible. C'est
  `applyDecision()` (`src/graph.ts:139`) qui pose et lève ce flag ; voir
  [le cycle d'une itération](cycle-d-iteration.md).
- **Round-robin** sinon : la tâche suivante après `state.lastTask` dans
  l'ordre du tableau `tasks`, en bouclant. Si aucune tâche collante ni
  `lastTask` connue, on part de la première éligible.

Résultat observable (`src/scheduler.test.ts:76`) : avec deux tâches actives
`a` et `b`, une plage qui ne rencontre que des `next-task` alterne
strictement `a, b, a, b, ...`.

## Une itération à la fois, jusqu'au bout

La boucle relit `deps.now() < until()` **avant** de démarrer une itération,
jamais pendant : une itération commencée avant la fin de la plage va jusqu'au
bout même si elle la dépasse (`src/scheduler.ts:83`). `until` peut être une
fonction plutôt qu'une `Date` fixe — la fin de plage est donc réévaluée à
chaque tour, ce qui permet à une plage automatique qui s'ouvre pendant une
plage manuelle de la prolonger sans interrompre la boucle en cours
(`src/scheduler.test.ts:122`).

## Attente sur quota saturé (`backoff`)

Quand `iterate()` renvoie la décision `backoff` (quota épuisé, voir
[le cycle d'une itération](cycle-d-iteration.md)), tout le monde attend — ce
n'est pas la tâche qui a un problème, c'est le compte Claude :

```ts
case "backoff": {
  summary.backoffs += 1;
  const nowMs = deps.now().getTime();
  const resetsAt = r.outcome.kind === "quota" ? r.outcome.resetsAt : undefined;
  const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
  const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
  if (wait <= 0) break;
  const untilIso = new Date(nowMs + wait).toISOString();
  deps.print(`  quota ${...} saturé, reprise à ${untilIso} (${formatDuration(wait)})`);
  deps.onEvent({ type: "backoff", ms: wait, until: untilIso });
  await deps.sleep(wait, signal);
  break;
}
```

- Si l'API a annoncé un `resetsAt` (horodatage Unix), on dort jusque-là plus
  une marge de 30 s ; sinon on retombe sur l'attente aveugle
  `cfg.scheduler.backoffMinutes` (par défaut 15 min, config dans
  `src/config.ts`).
- L'attente est bornée à au moins 60 s (`Math.max(target, 60_000)`) et ne
  dépasse jamais la fin de plage (`Math.min(..., until().getTime() - nowMs)`) :
  si la plage se termine avant le reset, on n'attend pas plus, la boucle
  sortira ensuite naturellement (`src/scheduler.test.ts:151`).
- La tâche reste collante (`applyDecision` sur `backoff`) : après l'attente,
  c'est elle — pas la suivante en round-robin — qui rejoue
  (`src/scheduler.test.ts:138`, « quota : attente globale puis même tâche »).

## Échecs (`retry` / `task-failed`)

Sur `retry`, on dort `cfg.scheduler.retrySeconds` (borné par la fin de plage)
puis on rejoue la même tâche (elle est restée collante). Après
`cfg.scheduler.maxConsecutiveFailures` échecs consécutifs, `iterate()` renvoie
`task-failed` : la tâche sort de la file (`applyDecision` la rend non
collante et met à jour `lastTask`), le round-robin passe à la suivante
(`src/scheduler.test.ts:176`).

## Panne globale (`stop-window`)

Sur `stop-window` (panne `auth` ou `docker`, voir
[le cycle d'une itération](cycle-d-iteration.md)), la plage s'arrête tout de
suite (`summary.endedBecause = "fatal"`), sans attendre la deadline. L'état de
plage (`state.window`) **n'est pas effacé** : une fois le problème réparé, le
démon la reprendra au prochain démarrage (`src/scheduler.ts:146`,
`src/scheduler.test.ts:108`).

## Fin de plage et `WindowSummary`

`runWindow()` retourne un résumé (`iterations`, `completed`, `backoffs`,
`failures`, `costUsd`, `endedBecause`) :

- `"window"` — la deadline est atteinte normalement.
- `"nothing-eligible"` — plus aucune tâche active éligible (toutes `done` ou
  `failed`), la boucle s'arrête avant la deadline.
- `"stopped"` — arrêt gracieux demandé via `deps.shouldStop()`, ou le
  `signal` a été annoncé pendant la boucle. L'itération en cours au moment de
  l'arrêt ne compte pas dans le résumé si elle a été abandonnée
  (`outcome.reason === "aborted"`, `src/scheduler.test.ts:188`).
- `"fatal"` — panne globale, voir ci-dessus.

Dans tous les cas sauf `"fatal"`, `state.window` est remis à `null` et l'état
sauvegardé (`saveState`) ; sur `"fatal"` ou arrêt via `signal`, la plage reste
enregistrée pour être reprise plus tard.

## Dépendances injectables (`SchedulerDeps`)

`runWindow()` prend un objet `partial: Partial<SchedulerDeps>` qui permet de
remplacer `runIteration`, `sleep`, `now`, `print`, `shouldStop` et `onEvent` —
c'est ce que `src/scheduler.test.ts` utilise pour simuler une horloge et des
itérations factices sans jamais lancer de vrai container. En production
(`partial` vide), `runIteration` appelle `iterate()` (`src/iterate.ts`) et
`now`/`sleep` sont l'horloge et le minuteur réels.
