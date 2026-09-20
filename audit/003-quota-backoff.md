# 003 — Détection du quota `rejected` et durée du backoff jusqu'au reset

**Fichiers examinés** : `src/claude.ts:114-136`, `src/graph.ts:34-105`,
`src/scheduler.ts:34-45,83-139`, `src/iterate.ts:150-165`,
`src/daemon.ts:252-270,303-326`, `src/cli.ts:92-104`, `src/config.ts:33-42`,
tests `claude.test.ts`, `graph.test.ts`, `scheduler.test.ts`, `iterate.test.ts`
**Verdict** : 4 constats (2 sûrs, 2 probables)

## L'arrêt gracieux n'est pas honoré pendant l'attente quota : le démon dort jusqu'au reset

**Gravité** : sûr
**Où** : `src/scheduler.ts:120` (et `src/scheduler.ts:83-87`, `src/daemon.ts:324`)

`shouldStop()` n'est consulté qu'en tête de boucle. L'attente quota, elle, est
un `setTimeout` fixe qui ne se réveille que sur `signal` :

```ts
// scheduler.ts:83-87
while (!signal.aborted && deps.now() < until()) {
  if (deps.shouldStop()) { stopped = true; break; }
// scheduler.ts:120
      await deps.sleep(wait, signal);
```

```ts
// sleep(), scheduler.ts:34-45 — ni shouldStop ni réévaluation de until()
const t = setTimeout(done, ms);
signal.addEventListener("abort", done);
```

Or `stopWindow(false)` ne lève pas `ac` : il pose `run.stopRequested = true` et
répond `after-iteration` (`daemon.ts:317-325`).

Scénario : plage automatique 00 h–08 h, quota `five_hour` saturé à 00 h 20 avec
`resetsAt` à 04 h 00. Le scheduler dort 3 h 40 (`scheduler.ts:114-120`). À
00 h 25 l'utilisateur tape `unused stop`. La CLI répond « arrêt après
l'itération en cours », `state.pausedUntil` est écrit, `status` affiche
`plage … — arrêt demandé` / `en cours attente quota jusqu'à 04:00:30`
(`cli.ts:99-102`). Attendu : l'arrêt est immédiat, aucune itération n'étant en
cours — il n'y a rien à finir, le démon dort. Obtenu : le démon reste éveillé
et bloqué jusqu'à 04 h 00 avant de constater la sortie de boucle. Pire, le
`stop` a posé `pausedUntil`, donc `calendarEnd()` renvoie désormais null et
`until()` vaut `now` (`daemon.ts:116-127`) : la boucle sortira de toute façon
au premier tour — le programme attend 3 h 35 pour rien. Seul `stop --now`
(qui abort) reprend la main, mais lui tue aussi une itération réelle quand il y
en a une.

Le même trou fait que la fin de plage n'est plus réévaluée pendant le sommeil,
alors que c'est la règle annoncée en tête de `runWindow` (« la fin de plage est
réévaluée à chaque tour »).

## Une attente tronquée par la fin de plage est annoncée comme une reprise

**Gravité** : sûr
**Où** : `src/scheduler.ts:115-119`

```ts
const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
if (wait <= 0) break;
const untilIso = new Date(nowMs + wait).toISOString();
deps.print(`  quota … saturé, reprise à ${untilIso} (${formatDuration(wait)})`);
deps.onEvent({ type: "backoff", ms: wait, until: untilIso });
```

Quand le reset tombe après la fin de plage, `wait` est rogné et `untilIso`
devient la fin de plage — mais il est publié tel quel comme l'heure de reprise,
à l'écran et dans l'événement `backoff`, que le démon recopie dans
`waitingQuotaUntil` (`daemon.ts:268-269`) et que `unused status` affiche
« en cours attente quota jusqu'à X » (`cli.ts:102`).

Scénario : plage 00 h–08 h, quota saturé à 07 h 30, `resetsAt` à 11 h 00. La
ligne affichée est `quota five_hour saturé, reprise à 08:00:00Z (30 min)` et
`status` annonce une attente quota jusqu'à 08 h 00. Attendu : « quota saturé
jusqu'à 11 h 00, la plage s'arrête avant ». Obtenu : une heure de reprise à
laquelle rien ne reprend — à 08 h 00 la plage se termine (`endedBecause:
"window"`, `state.window = null`), et le vrai reset (11 h 00) n'est écrit nulle
part : ni dans `state`, ni dans `pausedUntil`. La plage suivante qui s'ouvrirait
à 09 h relancerait aussitôt un container pour une session immédiatement
rejetée, faute d'avoir mémorisé le reset connu.

## Un `rejected` qui ne porte son reset que dans `unifiedWindows` retombe sur l'attente aveugle

**Gravité** : probable
**Où** : `src/claude.ts:130-135`

```ts
export function quotaRejection(events: RateLimitInfo[]) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.status === "rejected") return { rateLimitType: e.rateLimitType ?? "unknown", resetsAt: e.resetsAt };
  }
```

Seul le `resetsAt` de premier niveau est lu. Or le code modélise explicitement
des événements dont l'info de quota n'est que dans `unifiedWindows` :
`quotaSnapshot` traite d'abord cette forme et ne retombe sur
`utilization`/`resetsAt` de premier niveau qu'en « forme minimale »
(`claude.ts:117-125`), et une fixture du dépôt a exactement cette forme sans
aucun champ de premier niveau (`graph.test.ts:42`). Le `?? "unknown"` sur
`rateLimitType` montre d'ailleurs qu'un événement amputé de ses champs de haut
niveau est attendu.

Scénario : événement `{ status: "rejected", unifiedWindows: { five_hour: {
utilization: 1, resetsAt: 1789596600 } } }`. `quotaRejection` renvoie
`{ rateLimitType: "unknown", resetsAt: undefined }` ; `scheduler.ts:114` prend
la branche `cfg.scheduler.backoffMinutes` (15 min par défaut) alors que le
reset est dans 4 h. Attendu : un sommeil unique jusqu'au reset. Obtenu : 16
réveils, 16 containers démarrés et jetés, 16 sessions `claude` rejetées
d'entrée, 16 itérations comptées dans `summary.iterations` et
`live.iterations`, jusqu'à la fin de plage. L'information nécessaire était dans
l'événement, elle est jetée par la lecture.

## Un throttle qui ne passe pas par un `rate_limit_event` sort la tâche de la file

**Gravité** : probable
**Où** : `src/graph.ts:34,49-52` et `src/graph.ts:96-103`

`classify` ne connaît le quota que par un `rate_limit_event rejected`. Tout le
reste devient `failure`, y compris les statuts HTTP de throttling : seuls 401 et
403 sont extraits (`AUTH_STATUSES`), un 429 dans `api_error_status` tombe donc
dans le `return { kind: "failure" … }` final. Les `system/api_retry`, qui
portent pourtant `error_status` et sont parsés et logués
(`claude.ts:107`, `log.ts:26`), ne sont jamais consultés par `classify`.

Ce que ça coûte (`graph.ts:96-103`) : `consecutiveFailures += 1`, puis à la
3ᵉ (défaut) `ts.status = "failed"`, et `isEligible` (`graph.ts:108-110`) la
sort de la file **définitivement** — il faut un `unused tasks reset` manuel.
C'est exactement ce que le README promet d'éviter (« Deux pannes sont globales
et arrêtent la plage au lieu d'épuiser les tâches en échecs »), sauf que le
quota, lui, n'a pas ce filet dès qu'il ne se présente pas en `rejected`.

L'historique montre que le filet a été retiré sans être remplacé : avant
`03c4c4c`, `QUOTA_REASONS = { "blocking_limit", "rapid_refill_breaker" }`
donnait un `quota` (`git show c9c8b63:src/graph.ts`). Le commit explique le cas
`blocking_limit` (fenêtre de contexte, redevient un échec — décision assumée)
mais ne dit rien de `rapid_refill_breaker`, qui est bien une limitation de
cadence et qui est aujourd'hui un échec ordinaire.

Scénario : trois itérations consécutives d'une même tâche se terminent en
`terminal_reason: "rapid_refill_breaker"` (ou avec `api_error_status: 429`)
sans qu'aucun `rate_limit_event rejected` ne soit émis. Attendu : `backoff`,
tâche et curseur intacts. Obtenu : trois `retry` comptés, puis `task-failed` —
la tâche quitte la file pour de bon alors que rien n'est cassé, et le curseur
de toutes les autres tâches continue de brûler du quota saturé à 60 s
d'intervalle (`retrySeconds`).

Reste à vérifier sur une session réelle : quelle forme prend exactement une
saturation de quota côté CLI (événement `rejected` seul, ou aussi
`api_error_status` 429 / `rapid_refill_breaker`). Indice interne de flottement :
`config.ts:35` décrit toujours `backoffMinutes` comme « attente globale après
un `blocking_limit` (quota saturé) », ce que `graph.ts:37-39` contredit.

## Ce qui a été vérifié et tient

- L'arithmétique du backoff quand le reset est connu et tient dans la plage :
  `resetsAt * 1000 + 30 s`, plancher à 60 s, `wait <= 0` sort de la boucle —
  les unités (epoch secondes → ms) sont cohérentes partout
  (`scheduler.ts:114-116`, couvert par `scheduler.test.ts:92-105`).
- `quotaRejection` prend bien le **dernier** `rejected` et ignore les
  `allowed` ; le fait qu'un `rejected` l'emporte sur un `completed` tardif
  (`graph.ts:45-48`) est un choix assumé, documenté et testé
  (`graph.test.ts:50-51`) — pas un défaut, même s'il jette une itération
  réussie quand le quota s'est libéré en cours de session.
- La collance de la tâche sur `backoff` (`applyDecision` → `currentTask`) et le
  non-comptage de l'échec sur quota (`applyOutcome` case `quota`) font bien
  reprendre la même tâche au même nœud après l'attente.
- Sur quota, `iterate` jette le container et efface `DONE`
  (`iterate.ts:184-187`) : l'itération est bien réputée n'avoir jamais eu lieu.
