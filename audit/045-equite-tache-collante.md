# 045 — Équité : la tâche collante monopolise la plage, les autres jamais servies

**Fichiers examinés** : `src/graph.ts:41-53` (`classify`), `src/graph.ts:64-105`
(`applyOutcome`), `src/graph.ts:107-152` (`isEligible`, `pickNext`,
`applyDecision`), `src/scheduler.ts:47-139` (`runWindow`, branche `backoff`
109-122), `src/iterate.ts:155-189`, `src/claude.ts:65-73,129-135`
(`RateLimitInfo`, `quotaRejection`), `src/task.ts:28-38` (`NodeSchema.args`),
`src/config.ts:33-42`, `src/state.ts:22-39`, `unused.config.json`,
`src/graph.test.ts:145-193` (`pickNext`), `src/scheduler.test.ts:92-105`
(backoff avec reset annoncé).

Ni `node` ni `node_modules` dans ce conteneur : tout ce qui suit est établi par
lecture, et par inspection du binaire réel `claude 2.1.272`
(`/root/.local/share/claude/versions/2.1.272`) pour le vocabulaire des
événements de quota.

**Verdict** : 1 constat (sûr)

## Un quota saturé *par modèle* (`seven_day_opus` / `seven_day_sonnet`) est traité comme global : la plage entière part dormir et les tâches qui ont encore du quota ne tournent pas

**Gravité** : sûr
**Où** : `src/graph.ts:45-46`, `src/graph.ts:92-93`, `src/graph.ts:147-151`,
`src/scheduler.ts:109-121`

Toute la mécanique du backoff repose sur une hypothèse écrite noir sur blanc en
tête du scheduler :

```ts
// src/scheduler.ts:49-50
 * itération à la fois. Une itération commencée avant la fin de la plage va
 * jusqu'au bout. Sur quota saturé, tout le monde dort jusqu'au reset annoncé
```

« Tout le monde dort » n'est légitime que si le quota est une ressource de
compte, indivisible. Le code y croit sans réserve : `classify` range **tout**
`rejected`, quel que soit son type, dans la même issue…

```ts
// src/graph.ts:45-46
const rejected = quotaRejection(session.rateLimits);
if (rejected) return { kind: "quota", reason: rejected.rateLimitType, resetsAt: rejected.resetsAt };
```

…`applyOutcome` n'en tire aucun comptage (le `case "quota"` ne touche ni
`consecutiveFailures`, ni le curseur, ni le statut — `graph.ts:92-93`), et
`applyDecision` épingle la tâche :

```ts
// src/graph.ts:147-151
case "backoff":
case "retry":
case "stop-window":
  state.currentTask = task.name;
```

`iterate` persiste les deux (`iterate.ts:165` puis `189`), et `pickNext` sert la
collante **avant** tout round-robin :

```ts
// src/graph.ts:122-125
if (state.currentTask !== null) {
  const sticky = eligible.find((t) => t.name === state.currentTask);
  if (sticky) return sticky;
}
```

Or l'hypothèse est fausse. Le type du rejet est un champ libre côté runner
(`rateLimitType?: string`, `claude.ts:69`), et côté CLI c'est une énumération
fermée qui contient des limites **propres à un modèle**. Schéma zod de
`rate_limit_info` dans `claude 2.1.272` :

```js
rateLimitType: G(["five_hour","seven_day","seven_day_opus",
                  "seven_day_sonnet","seven_day_overage_included","overage"]).optional(),
utilization: v().optional(),
unifiedWindows: c({five_hour: c({utilization:v(),resetsAt:v().int()}).optional(), …
```

Ce ne sont pas des étiquettes décoratives : le binaire les traite comme des
fenêtres distinctes, avec un horizon de reset hebdomadaire…

```js
if (["seven_day_opus","seven_day_sonnet"].includes(n)) { let h =
  Math.floor(Date.now()/1000) + 604800 }
```

…les pose bien en `rejected` sur le flux…

```js
[{ … rateLimitType:"seven_day_opus", resetsAt:r }],
  this.updateRepresentativeClaim(),
  this.headers["anthropic-ratelimit-unified-status"] = "rejected"
```

…et discriminent explicitement selon le modèle demandé
(`…!=="seven_day_opus"&&e!=="seven_day_sonnet")return!1`,
`…"seven_day_opus"&&o==="opus")return!1`). Autrement dit : l'allocation Opus
hebdomadaire peut être à sec pendant que celle de Sonnet est à 15 %.

Et le projet encourage précisément le mélange des modèles entre tâches, nœud par
nœud — c'est l'exemple du schéma lui-même :

```ts
// src/task.ts:34-35
// Arguments `claude` propres à ce nœud (ex. ["--model", "opus"]).
args: z.array(z.string()).default([]),
```

(`buildCommand` les laisse passer avec la config livrée : `src` vaut
`["--output-format","json","--no-session-persistence","--dangerously-skip-permissions","--model","opus"]`,
seul le couple `--output-format json` est mangé, `--model opus` arrive bien
jusqu'à la commande.)

### Scénario concret

Config livrée telle quelle (`unused.config.json` : une seule plage
automatique `mon 00:00 → 13:00`, `backoffMinutes: 15`). Deux tâches :
`audit`, dont les nœuds portent `args: ["--model","opus"]`, et `blog`, qui
laisse le modèle par défaut. État vierge. L'opérateur a utilisé Claude Code à la
main le dimanche et épuisé son allocation Opus de la semaine ; la fenêtre
Sonnet, elle, est à 15 %.

1. **Lun 00:00** — la plage s'ouvre. `pickNext` : `currentTask = null`,
   `lastTask = null` → `lastIdx = -1` → `tasks[0]`, soit `audit`.
2. **00:00–00:40** — la session d'`audit` démarre, le premier appel API est
   refusé, le flux porte
   `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day_opus","resetsAt":<jeu 09:00>}}`,
   la session se termine.
3. `quotaRejection` rend le dernier `rejected` (`claude.ts:130-135`) →
   `classify` → `{kind:"quota", reason:"seven_day_opus", resetsAt: jeu 09:00}`
   → `applyOutcome` rend `backoff` **sans rien compter** → `applyDecision` pose
   `state.currentTask = "audit"` → `saveState`.
4. `runWindow`, branche `backoff` :

   ```ts
   // src/scheduler.ts:111-120
   const nowMs = deps.now().getTime();                       // lun 00:40
   const resetsAt = r.outcome.kind === "quota" ? r.outcome.resetsAt : undefined;
   const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs   // ≈ 3,35 jours
                                         : cfg.scheduler.backoffMinutes * 60_000;
   const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs); // → 12 h 20
   …
   await deps.sleep(wait, signal);
   ```

   La boucle `while` est **la seule** ; il n'y a pas d'autre fil d'élection.
   Pendant ces 12 h 20, `pickNext` n'est pas rappelé une seule fois.
5. **13:00** — réveil, `deps.now() < until()` est faux, la plage se termine en
   `endedBecause: "window"`, `state.window = null`, `currentTask = "audit"`
   persisté (`scheduler.ts:147-148`).

**Obtenu** : la seule plage de la semaine a produit 1 itération, 0 `completed`,
1 attente quota, et `blog` — active, éligible, `status: "running"`, avec du
quota Sonnet disponible et aucune dépendance sur Opus — n'a **pas tourné une
seule fois**. Le journal du démon dit
`fin de plage (window) : 1 itérations, 0 completed, 0 échecs, 1 attentes quota`,
c'est-à-dire rien d'anormal. **Attendu** : la saturation d'une fenêtre Opus sort
`audit` de la rotation jusqu'au reset annoncé, et `blog` récupère les 12 h 20.

Le piège se referme ensuite, parce que l'épinglage survit à la plage. Le
dimanche suivant, l'opérateur tape `unused start --for 8h` : `startWindow` ne
remet à nul que `manual`, `fatal` et `pausedUntil` (`daemon.ts:294-299`) ;
`currentTask` vaut toujours `"audit"`, `pickNext` le sert avant le
round-robin, le refus `seven_day_opus` retombe (le reset est jeudi), et les 8 h
repartent en sommeil. `blog` reste à zéro itération tant que la fenêtre Opus ne
s'est pas rouverte — jusqu'à 7 jours (`604800`). Rien ne peut casser le cycle
par lui-même : la branche `quota` n'incrémente pas `consecutiveFailures`, donc
`maxConsecutiveFailures` n'est jamais atteint et `task-failed` — le seul chemin
qui rendrait la main (`graph.ts:98-100`, `graph.ts:141-146`) — est hors
d'atteinte. Le seul recours de l'opérateur est `unused tasks deactivate audit`,
ou `unused tasks reset audit` qui détruit au passage l'image de la tâche
(`daemon.ts:404`).

Les deux moitiés du défaut sont indépendantes et s'additionnent :
`scheduler.ts:115` fait dormir *la plage* pour un reset qui ne concerne qu'un
modèle, et `graph.ts:147-151` fait que c'est toujours la même tâche qui
rouvrira les yeux. Il suffirait que `classify` distingue un rejet à portée de
compte (`five_hour`, `seven_day`, `overage`) d'un rejet à portée de modèle pour
que le second cas se traite comme une indisponibilité de *la tâche* — ce que
`pickNext` sait déjà faire, puisqu'il saute les inéligibles
(`graph.test.ts:186-192`).

Gravité « sûr » et non « probable » : les cinq faits de code sont certains
(collage, non-comptage, priorité de la collante, boucle unique, `wait` borné
par la fin de plage), les six valeurs de `rateLimitType` viennent du schéma du
binaire livré, et le mélange de modèles entre tâches est la fonctionnalité
documentée du champ `args`. Rien d'environnemental n'est requis au-delà d'un
compte dont l'allocation Opus hebdomadaire est épuisée — l'état normal d'un
abonnement Max en fin de semaine.

## Ce qui a été vérifié et tient

- **Le round-robin lui-même est équitable.** `pickNext` repart de `lastTask` par
  son nom (`graph.ts:127`), la boucle `for (let i = 1; i <= tasks.length; i++)`
  visite tous les indices y compris avec `lastIdx = -1`, et `applyDecision`
  avance `lastTask` sur les trois décisions qui rendent la main
  (`graph.ts:141-146`). Les séquences vérifiées à la main — `a,b,c,a,b` tout en
  `next-task` ; `a` puis `b` collée sur `backoff`/`retry` puis `b`,`c` — sont
  exactement celles que `graph.test.ts:150-168` fige. Une tâche sautée parce
  qu'inéligible ne décale personne.
- **L'épinglage sur `retry` est borné.** `case "failure"` incrémente puis compare
  en `>=` (`graph.ts:96-101`) : au `maxConsecutiveFailures`-ième échec la tâche
  passe `failed` et `applyDecision` rend la main. Une tâche qui échoue, même en
  boucle, libère la file ; le temps qu'elle consomme avant cela
  (`timeoutMinutes` × `maxConsecutiveFailures`, soit 9 h avec les valeurs
  livrées) relève de la politique de retry, pas d'un défaut d'équité — et le
  plafond d'itération ignorant la plage est déjà instruit en 030.
- **Une itération abandonnée ne déséquilibre pas la file.** Sur `aborted`,
  `iterate` n'appelle ni `applyOutcome` ni `applyDecision` et ne sauve pas
  (`iterate.ts:162-165,189`) : `currentTask` et `lastTask` gardent la valeur de
  l'itération précédente, qui est cohérente avec ce qui a réellement tourné.
- **`backoff` et `retry` n'écrasent pas `lastTask`** (`graph.ts:147-151`) : une
  tâche collante qui finit par rendre la main reprend sa place normale dans la
  rotation, elle ne se retrouve pas deux fois de suite en tête.
- **Un `resetsAt` déjà passé ne provoque pas de boucle serrée** : `target`
  devient négatif, le plancher `Math.max(target, 60_000)` impose une minute
  (`scheduler.ts:115`).
- **Déjà rapporté ailleurs, non repris ici** : l'épinglage sur `stop-window` et
  la famine qui s'ensuit quand la panne est propre à une tâche (023) ; le reset
  connu mais non mémorisé d'une plage à l'autre, qui relance une session
  immédiatement rejetée (043) ; l'heure de reprise annoncée à la fin de plage
  alors que le reset est plus tard (003) ; le rangement de tout
  `rateLimitType` non nommé `seven_day` dans la fenêtre « 5 h » de
  `quotaSnapshot` (040, qui laissait l'existence d'un type hors
  `five_hour`/`seven_day` « à vérifier » — le schéma du binaire ci-dessus la
  tranche) ; la tâche collante orpheline qui ne bloque pas la file (008).
- **Ce que je n'ai pas pu démontrer, et que je ne rapporte donc pas** : un
  nœud portant `--fallback-model` pourrait voir sa session émettre un `rejected`
  `seven_day_opus` *puis* se terminer en `completed` sur le modèle de repli —
  `classify` donnerait alors la priorité au rejet (`graph.ts:45-48`) et jetterait
  une itération réussie en plus d'endormir la plage. Le binaire contient bien le
  chemin (`tengu_api_opus_fallback_triggered`, gardé par
  `r.fallbackModel && r.fallbackModel !== r.model`), mais je n'ai pas établi
  qu'un `rate_limit_event` `rejected` et un `result` `completed` coexistent dans
  le même flux.
