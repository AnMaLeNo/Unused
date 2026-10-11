# 050 — Flux NDJSON casté sans validation : un champ null ou non numérique casse l'itération puis la plage

**Fichiers examinés** : `src/claude.ts:40-73` (types du flux), `src/claude.ts:86-112`
(`parseStream`), `src/claude.ts:114-127` (`quotaSnapshot`), `src/claude.ts:129-136`
(`quotaRejection`), `src/graph.ts:41-53` (`classify`), `src/iterate.ts:150-153`
(instantanés de quota), `src/iterate.ts:188-230` (journal, affichage, valeur de
retour), `src/iterate.ts:239-243` (`describeQuota`), `src/scheduler.ts:104-137`
(décisions `backoff` / `retry`), `src/scheduler.ts:151-154` (résumé),
`src/log.ts:42-67` (`writeIterationLog`), `src/daemon.ts:192-216` (ce qui
rattrape une exception de `runWindow`), `src/daemon.ts:255-266`
(`onEvent`, cumul du coût), `src/cli.ts:96-110` (affichage du coût),
`src/config.ts:14-40` (validation zod de la config, par contraste),
`src/claude.test.ts:36-69`, `src/iterate.test.ts:18-25` et `:118-123`,
`src/scheduler.test.ts:40-70` (ce que les tests couvrent).

**Verdict** : 4 constats (3 probables, 1 à vérifier)

Tous partent du même point : `parseStream` est la seule frontière entre la
sortie d'un sous-processus et le cœur du runner, et elle ne valide rien. Les
lignes NDJSON sont castées en bloc (`d as ClaudeResult`, `d.rate_limit_info as
RateLimitInfo`), puis les champs ainsi « typés » `number` partent directement
dans de l'arithmétique (`resetsAt * 1000`), dans `new Date(...)` et dans
`.toFixed()`. La config, elle, est validée par zod (`src/config.ts:19`,
`:36-38`) : l'asymétrie est nette, c'est la donnée la moins fiable des deux qui
n'est pas contrôlée. Les trois gardes existantes testent `!== undefined`
(`src/claude.ts:121`, `src/scheduler.ts:114`, `src/iterate.ts:222`), ce qui
laisse passer `null` — et `null` est précisément ce que le flux émet pour
« inconnu » ailleurs, les types du fichier l'admettent explicitement
(`api_error_status?: number | null` en `src/claude.ts:43`,
`error_status?: number | null` en `:81`).

Les tests ne couvrent que des charges utiles bien formées : `resetsAt: 100`,
`utilization: 0.1`, `total_cost_usd: 0.05`. Aucun test n'envoie `null` ni une
chaîne dans ces champs.

## `resetsAt: null` ramène l'attente de quota de 15 min à 60 s et met le runner en boucle sur un quota saturé

**Gravité** : probable
**Où** : `src/scheduler.ts:112-120`, via `src/claude.ts:133` et `src/graph.ts:46`

`quotaRejection` recopie `e.resetsAt` tel quel depuis l'événement
`rate_limit_event`, `classify` le place dans l'issue `quota`, et le scheduler
le consomme ici :

```ts
const resetsAt = r.outcome.kind === "quota" ? r.outcome.resetsAt : undefined;
// Jusqu'au reset annoncé (plus une marge), sinon l'attente aveugle.
const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
```

Scénario : un `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
"rateLimitType":"five_hour","resetsAt":null}}` — soit la forme JSON habituelle
pour « reset non communiqué ». Alors :

- `null !== undefined` est vrai, donc la branche « reset annoncé » est prise et
  l'attente aveugle `backoffMinutes` (15 min dans `unused.config.json:28`) n'est
  jamais atteinte ;
- `null * 1000` vaut `0` (ToNumber(null) = 0), donc
  `target = 30_000 - nowMs`, un nombre très négatif (≈ −1,8 × 10¹²) ;
- `Math.max(target, 60_000)` le relève à `60_000`.

Résultat obtenu : 60 s d'attente. Résultat attendu : 15 min. Le runner relance
alors une itération complète — création de container, montage, session
`claude -p` — qui se fait rejeter immédiatement par le même quota, et
recommence toutes les 60 s. Rien n'arrête la boucle : une issue `quota` ne
touche pas `consecutiveFailures` (`src/graph.ts:92-93`), donc le garde-fou
`maxConsecutiveFailures` ne joue pas, et la tâche reste collante
(`applyDecision`, `src/graph.ts:147-151`). La plage se termine donc en
alternant attente de 60 s et session rejetée, chacune journalisée comme une
itération et un `backoff` (`src/scheduler.ts:110`), jusqu'à `until()`.

À noter que le commentaire du code annonce exactement le comportement voulu
(« sinon l'attente aveugle ») : c'est bien le test `!== undefined` qui le
trahit, `typeof resetsAt === "number"` suffirait.

## Un `resetsAt` non numérique fait exploser le scheduler sur `new Date(NaN)` et tue la plage

**Gravité** : probable
**Où** : `src/scheduler.ts:114-119`

Même chemin, mais avec une valeur non convertible en nombre — par exemple un
horodatage ISO (`"resetsAt":"2026-10-11T12:00:00Z"`) au lieu des secondes epoch
que le commentaire de `src/claude.ts:54` suppose :

- `"2026-10-11T12:00:00Z" * 1000` vaut `NaN` ;
- `Math.max(NaN, 60_000)` vaut `NaN`, `Math.min(NaN, …)` vaut `NaN` (la spec
  propage `NaN`), donc `wait = NaN` ;
- le garde-fou `if (wait <= 0) break` ne déclenche pas : `NaN <= 0` est faux ;
- `new Date(nowMs + NaN).toISOString()` en ligne 117 lève
  `RangeError: Invalid time value`.

```ts
const wait = Math.min(Math.max(target, 60_000), until().getTime() - nowMs);
if (wait <= 0) break;
const untilIso = new Date(nowMs + wait).toISOString();   // RangeError
```

`runWindow` n'a aucun `try`, l'exception traverse donc toute la plage et atterrit
dans `src/daemon.ts:213-216` : message « plage interrompue par une erreur »,
`state.window` remis à `null`, puis `pauseUntil(deadline, "erreur")` qui met les
plages automatiques en pause jusqu'à la fin de la plage courante. Résultat : une
seule valeur de champ mal typée dans un événement de quota et tout le reste de
la plage est perdu, alors que la seule chose dont le programme avait besoin
était de décider une durée d'attente. Résultat attendu : traiter un `resetsAt`
illisible comme un `resetsAt` absent, c'est-à-dire l'attente aveugle.

Même sans exception, la propagation silencieuse est visible en amont : l'issue
`quota` est journalisée telle quelle dans `index.jsonl` et dans le fichier
d'itération (`src/log.ts:47-66`), avec un `resetsAt` que le type déclare
`number` et qui n'en est pas un.

## `total_cost_usd` non numérique : `.toFixed()` jette sur une ligne d'affichage, après que l'itération a été commitée et l'état sauvé

**Gravité** : probable
**Où** : `src/iterate.ts:222-224`

```ts
if (session.result?.total_cost_usd !== undefined) {
  print(`coût     $${session.result.total_cost_usd.toFixed(4)}, …`);
}
```

Scénario : le message final est
`{"type":"result","terminal_reason":"completed","total_cost_usd":null,…}`
(ou `"0.05"`, ou tout autre type que `number`). `null !== undefined` est vrai,
et `null.toFixed` lève `TypeError: Cannot read properties of null`. Pour une
chaîne, `"0.05".toFixed is not a function`. L'exception est levée à
l'évaluation du gabarit, avant l'appel à `print` : aucune implémentation de
`print` ne peut l'éviter.

Ce qui rend ce point coûteux, c'est l'endroit où il tombe. À la ligne 222, tout
le travail réel est déjà fait et persisté :

- le container a été commité (`src/iterate.ts:170`) ;
- le curseur a avancé et `saveState` a écrit l'état (`:165`, `:189`) ;
- le journal d'itération et `index.jsonl` sont écrits (`:217`).

L'exception empêche seulement le `return` de la ligne 230. Donc : l'itération a
bien eu lieu et est acquise sur disque, mais `runWindow` ne la voit jamais
(`src/scheduler.ts:98`), son coût et sa décision n'entrent pas dans le résumé,
et l'exception remonte au `catch` de `src/daemon.ts:213` qui met fin à la plage
et met les plages automatiques en pause. Résultat obtenu : une plage tuée et un
résumé faux (`iterations`, `costUsd`, `completed` amputés d'une itération
réussie) à cause d'une ligne de trace. Résultat attendu : au pire, ne pas
afficher le coût.

À l'inverse, la propagation d'un `costUsd` de type chaîne vers
`summary.costUsd += r.costUsd ?? 0` (`src/scheduler.ts:102`) et
`run.live.costUsd += …` (`src/daemon.ts:262`) — qui transformerait le cumul en
concaténation de chaînes puis ferait échouer `w.costUsd.toFixed(2)` dans
`src/cli.ts:100` — n'est **pas** atteignable : la ligne 223 jette avant le
`return`, pour toute valeur définie non numérique. Le risque existe dans les
types, pas dans l'exécution.

## Un `utilization` null ou absent est affiché comme « 0 % » ou « NaN % » de quota consommé

**Gravité** : à vérifier
**Où** : `src/iterate.ts:241`, `src/claude.ts:119-125`

```ts
const pct = (w?: { utilization: number }) => (w ? `${Math.round(w.utilization * 1000) / 10}%` : "?");
```

`quotaSnapshot` ne teste que la présence de la fenêtre (`if (w.five_hour)`) et
recopie son contenu sans regarder `utilization` ; la forme minimale
(`src/claude.ts:121`) n'exige là encore qu'un `!== undefined`. Avec
`unifiedWindows: {"five_hour": {"utilization": null, "resetsAt": 1789596600}}`,
l'objet est vérité, `null * 1000` vaut `0`, et la trace d'itération affiche
`quota    5h 0% / 7j ?` — soit « quota intact » là où la valeur est en réalité
inconnue. Avec un `utilization` simplement absent, la même ligne affiche
`NaN%`. Le `?` prévu pour l'inconnu n'est atteint que si la fenêtre entière
manque.

L'effet reste limité à la ligne affichée (journal du démon) : `index.jsonl`
enregistre `utilization ?? null` (`src/log.ts:60-63`) et reste donc honnête, et
aucune décision du scheduler ne dépend de `utilization`. D'où la gravité basse
— mais c'est bien une valeur inventée présentée comme un fait à l'opérateur qui
surveille la consommation de son quota.

## Ce qui a été vérifié et tient

- `parseStream` lui-même est robuste sur la *forme* : lignes non-JSON ignorées,
  `JSON.parse` sous `try/catch`, `rate_limit_info` testé `typeof === "object"`
  avant d'être poussé (`src/claude.ts:88-103`). Le défaut est le non-contrôle
  des *types de champs*, pas le parsing.
- `src/iterate.ts:191` lit le modèle avec un vrai garde
  (`typeof session.init?.model === "string"`) : c'est le seul champ du flux
  correctement validé, et il tient.
- `classify` (`src/graph.ts:41-53`) ne fait que des comparaisons d'égalité
  stricte et un `Set.has` sur `api_error_status` déjà testé contre `null` : un
  champ de type inattendu y donne une issue `failure`, jamais une exception.
- `num_turns` non numérique (`src/iterate.ts:223`, `src/log.ts:58`) est
  seulement interpolé ou journalisé tel quel : affichage sale, pas de panne.
- `quotaRejection` (`src/claude.ts:129-136`) et `renderArguments`/`buildCommand`
  (`:8-38`) ont été relus sans rien trouver sur cet aspect.
- Le cas `resetsAt` exprimé en millisecondes (nombre valide mais mauvaise unité)
  ne provoque ni exception ni boucle : `wait` est borné par
  `until().getTime() - nowMs` (`src/scheduler.ts:115`), le runner dort jusqu'à
  la fin de la plage. Ce n'est pas un défaut de typage, et ce n'est pas rapporté
  ici.
