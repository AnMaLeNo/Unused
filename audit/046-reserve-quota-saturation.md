# 046 — Politique de consommation : la saturation pour seul capteur, et ses lectures divergentes

**Fichiers examinés** : `src/claude.ts:54-73` (`QuotaWindow`, `RateLimitInfo`),
`src/claude.ts:85-112` (`parseStream`), `src/claude.ts:114-136`
(`quotaSnapshot`, `quotaRejection`), `src/graph.ts:15-53` (`Outcome`,
`classify`, `AUTH_STATUSES`), `src/graph.ts:64-105` (`applyOutcome`),
`src/graph.ts:107-133` (`isEligible`, `pickNext`), `src/config.ts:12-42`
(`claude`, `scheduler`), `src/iterate.ts:150-189` (classement et rejet du
container), `src/iterate.ts:239-243` (`describeQuota`),
`src/scheduler.ts:104-137` (branches `backoff` / `retry`), `src/state.ts:9-20`
(`TaskStateSchema`), `src/daemon.ts:397-407` (`resetTask`),
`src/docker.ts:250-254` (`removeTaskImages`), `src/log.ts:49-66`,
`README.md:1-24` et `100-112`, `unused.config.json`, tests
`src/graph.test.ts:30-56`, `src/iterate.test.ts:108-125`,
`src/scheduler.test.ts:92-105`.

**Verdict** : 3 constats (1 sûr, 2 probables)

Deux points de départ factuels, l'un et l'autre vérifiables d'un `grep`.

`allowed_warning` n'existe **qu'une seule fois** dans tout le dépôt : dans
l'union de types, sans un seul lecteur.

```ts
// src/claude.ts:67
status: "allowed" | "allowed_warning" | "rejected";
```

`utilization` est parsé, puis n'atteint que deux surfaces inertes : la ligne
imprimée (`src/iterate.ts:241`) et quatre colonnes de `index.jsonl`
(`src/log.ts:60-63`). Aucune comparaison, aucun seuil ; `src/config.ts` n'offre
aucune clé de réserve.

**Ce n'est pas en soi le défaut.** Le README revendique la saturation comme la
fin recherchée — « jusqu'à taper la limite » (`README.md:6`, `README.md:116`) —
et une réserve non implémentée n'est donc pas une promesse trahie. Les trois
constats portent sur la conséquence de ce choix : puisque rien n'anticipe la
limite, **la seule façon dont le runner apprend qu'il y est, c'est en y
jetant une itération entière.** Ce capteur est destructif (le container est
rejeté, `src/iterate.ts:184-186`), il est unique, et il repose sur un seul
événement facultatif. Les trois constats sont trois façons de le voir se
tromper.

Le code hérite d'ailleurs d'un invariant explicite du README, auquel les
constats 1 et 2 se mesurent :

> Deux pannes sont globales et arrêtent la plage **au lieu d'épuiser les tâches
> en échecs** : le token refusé (401/403) et Docker injoignable.
> (`README.md:109-111`)

Le quota saturé est exactement de cette famille — une condition globale dont
aucune tâche n'est responsable — et il est bien traité ainsi, mais par un seul
chemin.

## Une rejection périmée par la suite de la session jette une itération réussie

**Gravité** : probable
**Où** : `src/claude.ts:130-135`, `src/graph.ts:45-46`

`quotaRejection` parcourt les événements à rebours et rend le premier
`rejected` rencontré. Il ne regarde jamais ce qui vient **après** :

```ts
// src/claude.ts:130-135
export function quotaRejection(events: RateLimitInfo[]): { rateLimitType: string; resetsAt?: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.status === "rejected") return { rateLimitType: e.rateLimitType ?? "unknown", resetsAt: e.resetsAt };
  }
  return null;
}
```

Un `allowed` postérieur ne l'annule pas. Et `classify` donne à cette rejection
la priorité sur tout le reste, y compris sur un `completed` — comportement
délibéré, le dépôt le teste (`src/graph.test.ts:50-52`, « le quota prime sur
tout, même un completed tardif ») :

```ts
// src/graph.ts:45-48
const rejected = quotaRejection(session.rateLimits);
if (rejected) return { kind: "quota", reason: rejected.rateLimitType, resetsAt: rejected.resetsAt };
const r = session.result;
if (r?.terminal_reason === "completed") return { kind: "completed", done };
```

Or la politique de saturation rend la péremption d'une rejection *routinière* :
`claude.timeoutMinutes` vaut 180 par défaut (`unused.config.json`), la fenêtre
5 h glisse en continu, et le propre du code est de travailler au bord de la
limite. Une session longue qui chevauche un reset est le cas normal, pas le cas
limite.

Scénario concret. Session démarrée à T, nœud `a` d'une tâche dont le skill
dépose `DONE` quand il a fini.

1. T+20 min : la fenêtre 5 h sature. Le flux reçoit
   `{"status":"rejected","rateLimitType":"five_hour","resetsAt":<T+40min>}`.
   Claude Code retente (le `api_retry` / `rate_limit` / 429 que `parseStream`
   collecte déjà, `src/claude.ts:107`, fixture `src/claude.test.ts:41`).
2. T+40 min : le reset tombe. L'information de quota change, donc un nouvel
   événement est émis — c'est la règle que le dépôt écrit lui-même
   (`src/claude.ts:65`, « émis quand l'info de quota change ») :
   `{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.05,"resetsAt":…}}}`.
3. La session repart, travaille 2 h, écrit `/exchange/DONE`, et finit sur
   `terminal_reason: "completed"`.

Ce que le runner en fait :

- `classify` → `{ kind: "quota", reason: "five_hour", resetsAt: T+40min }` ;
- `applyOutcome` → `"backoff"` : curseur inchangé, `iterations` **non**
  incrémenté (`src/graph.ts:92-93`) ;
- `src/iterate.ts:184-186` : `outcome.kind !== "completed"` → container
  **jeté**, `DONE` **supprimé** ;
- `src/scheduler.ts:114-116` : `target = (T+40min)*1000 + 30_000 − now`, avec
  `now ≈ T+180min` → **négatif** ; `wait = Math.min(Math.max(négatif, 60_000), …)`
  = **60 s**.

Résultat obtenu : 60 s de sommeil, puis le même nœud rejoué depuis l'image
d'avant, alors que le quota est à 5 %. Résultat attendu :
`completed + DONE` → `task-done`, tâche terminée, container commité. La ligne
`quota 5h 100% / 7j ? → 5h 5% / 7j ?` imprimée juste avant
(`src/iterate.ts:225`) dit elle-même que la limite n'est plus là. Et la valeur
`60_000` est la preuve dans le code que la branche sait que le reset est passé :
elle corrige un `target` négatif au lieu d'en conclure que la rejection est
périmée.

Le coût n'est pas un simple rejeu : **un `DONE` est effacé**. Pour une tâche
infinie, c'est la seule sortie prévue (`README.md:13-15`) qui disparaît — la
tâche continue indéfiniment alors que son skill s'était déclaré fini.

Pourquoi « probable » et pas « sûr » : la propriété du code est certaine
(aucune comparaison d'ordre entre `rejected` et les `allowed` suivants, aucune
borne de fraîcheur sur `resetsAt`), et la conséquence est mécanique dès que le
flux a cette forme. Ce que je ne peux pas établir depuis ce dépôt, c'est que
Claude Code poursuive effectivement une session après un `rejected` plutôt que
d'en sortir. Les fixtures ne montrent que des rejections terminales
(`src/claude.test.ts:42`, `src/iterate.test.ts:119`). Mais le test
`src/graph.test.ts:50-52` prouve que les auteurs tenaient le « completed
tardif » pour possible : ils l'ont modélisé, et ont tranché contre lui.

## Toute saturation qui n'émet pas de `rejected` est comptée en échec, et trois d'affilée retirent la tâche pour de bon

**Gravité** : probable
**Où** : `src/iterate.ts:156-159`, `src/graph.ts:34,49-52`

Le classement du quota tient à un seul test : la présence d'un événement
`rejected`. Deux chemins certains le contournent.

**a) `timedOut` passe avant `classify`.**

```ts
// src/iterate.ts:156-159
if (aborted) outcome = { kind: "failure", reason: "aborted" };
else if (timedOut) outcome = { kind: "failure", reason: "timeout" };
else if (session.lines === 0 && isDockerDown(r.stderr)) outcome = { kind: "fatal", reason: "docker", detail: r.stderr.trim() };
else outcome = classify(session, done);
```

Une session qui sature puis attend son reset est tuée à
`timeoutMinutes` (`src/iterate.ts:129-132`) et devient
`{ kind: "failure", reason: "timeout" }` — alors que le `rejected` est dans
`r.stdout`, parsé, et écrit tel quel dans le fichier d'itération
(`src/iterate.ts:208`). La raison de ne pas travailler est sur le disque ; la
décision l'ignore.

**b) `classify` ne connaît pas 429.** `429` est absent de tout `src/` hors
fixture, et le seul statut HTTP traité est l'authentification :

```ts
// src/graph.ts:34,49-52
const AUTH_STATUSES = new Set([401, 403]);
…
if (r?.api_error_status !== undefined && r.api_error_status !== null && AUTH_STATUSES.has(r.api_error_status)) {
  return { kind: "fatal", reason: "auth", … };
}
return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
```

Le dépôt sait pourtant que la saturation arrive accompagnée d'un 429 — c'est sa
propre fixture de référence qui l'écrit :

```ts
// src/graph.test.ts:36-48
result: { terminal_reason: "api_error", api_error_status: 429 },
rateLimits: [ …, { status: "rejected", rateLimitType: "five_hour", resetsAt: 1789596600 } ],
```

Deux corroborations sont donc déjà parsées et disponibles —
`api_error_status: 429` et `apiRetries` porteur de
`{ error: "rate_limit", error_status: 429 }` (`src/claude.ts:107`) — et aucune
des deux n'est consultée. Retirez le `rejected` de cette fixture (flux tronqué,
sortie coupée par le `kill`, événement non émis) et la même saturation
physique, avec le même 429, devient `{ kind: "failure", reason: "api_error" }`.

**La conséquence n'est pas symétrique.** `quota` ne touche à rien
(`src/graph.ts:92-93`). `failure` incrémente un compteur dont le seuil est
définitif :

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

Scénario concret, avec la configuration livrée (`maxConsecutiveFailures: 3`,
`retrySeconds: 60`) et des sessions qui échouent vite sur 429 sans émettre de
`rejected` :

1. Itération n : saturation → `failure/api_error` → `retry`,
   `consecutiveFailures = 1`. `src/scheduler.ts:133-134` dort 60 s.
2. `applyDecision("retry")` a remis `state.currentTask = task.name`
   (`src/graph.ts:147-151`), donc `pickNext` **rend la même tâche**
   (`src/graph.ts:122-125`). Le quota est toujours saturé : `consecutiveFailures = 2`.
3. Troisième tour, 60 s plus tard : `ts.status = "failed"`, `"task-failed"`.

En **moins de trois minutes** la tâche est retirée de la file. `isEligible`
l'exclut définitivement (`src/graph.ts:108-110`), `saveState`
(`src/iterate.ts:189`) écrit `failed` sur le disque, et rien ne le lève : le
seul remise à zéro de `consecutiveFailures` est un `completed`
(`src/graph.ts:84`, unique écriture à 0 hors `initialTaskState`), qui ne peut
plus arriver. Puis `applyDecision` rend la main (`currentTask = null`), le
round-robin désigne la tâche suivante, et la boucle lui fait subir les mêmes
trois tours. La plage se termine en `"nothing-eligible"`
(`src/scheduler.ts:89-92`) avec **toutes les tâches marquées `failed` dans
`state.json`**.

C'est mot pour mot ce que le README exclut : « épuiser les tâches en échecs »
au lieu d'arrêter. Et le seul remède est destructeur —
`resetTask` supprime l'entrée d'état *et* appelle `removeTaskImages`
(`src/daemon.ts:400-405`), qui fait `docker rmi -f <image>:latest <image>:prev`
plus un `pruneTask` (`src/docker.ts:250-254`). Réparer un quota mal lu coûte
donc toute la lignée d'images de la tâche, c'est-à-dire tout le travail
accumulé par les itérations précédentes ; la CLI l'annonce sans détour
(« image supprimée », `src/cli.ts:147`).

Pourquoi « probable » : les propriétés de code sont certaines et vérifiables
ligne à ligne (précédence de `timedOut`, absence de 429, asymétrie des
compteurs, collant du `retry`, persistance de `failed`). Ce que je ne peux pas
démontrer depuis le dépôt, c'est la fréquence à laquelle une saturation
échappe au `rejected`. À noter honnêtement : **l'enchaînement de trois tours
n'est réaliste que pour la variante b)** (échec rapide, 60 s d'attente entre
deux tours). Pour la variante a), trois timeouts font 9 h, au-delà d'un reset
5 h : la chaîne se brise en pratique, et il n'y reste que la mauvaise
imputation d'un échec. De même, un cumul sur plusieurs plages est improbable —
la première itération `completed` de la plage suivante remet le compteur à
zéro.

## `backoffMinutes` est documenté sur un événement qui ne l'utilise pas

**Gravité** : sûr
**Où** : `src/config.ts:35`

Le seul réglage de quota de la configuration est commenté comme ceci :

```ts
// src/config.ts:35-36
// Attente globale après un `blocking_limit` (quota saturé).
backoffMinutes: z.number().int().positive().default(15),
```

Le code dit l'inverse, deux fois. `graph.ts` prévient explicitement contre
cette lecture :

```ts
// src/graph.ts:37-39
 * Traduit la fin d'une session. Le quota se lit dans les événements
 * rate_limit_event (un `rejected`), pas dans terminal_reason : `blocking_limit`
 * y désigne la fenêtre de contexte pleine, pas le quota.
```

Et le dépôt le teste : `blocking_limit` donne
`{ kind: "failure", reason: "blocking_limit" }` (`src/graph.test.ts:53-55`),
donc la décision `retry`, donc la branche `src/scheduler.ts:129-136`, qui dort
`retrySeconds`. `backoffMinutes` n'est lu qu'en un seul endroit, la branche
`backoff`, atteignable seulement depuis `{ kind: "quota" }` :

```ts
// src/scheduler.ts:114
const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
```

Conséquence concrète pour l'opérateur. Des sessions coupées par un contexte
plein ; il lit le commentaire, porte `backoffMinutes` de 15 à 60 et attend que
le runner se calme. Rien ne change : ce chemin dort `retrySeconds` (60 s par
défaut). Et l'unique consommateur réel de `backoffMinutes` est lui-même presque
mort, puisque c'est le repli du cas `resetsAt === undefined` alors que toutes
les rejections modélisées dans le dépôt portent leur `resetsAt`
(`src/claude.test.ts:42`, `src/graph.test.ts:43`, `src/iterate.test.ts:119`,
`src/scheduler.test.ts:92-105`). Le seul bouton de politique de consommation
offert est donc documenté sur le mauvais événement et sans effet sur le bon.

Défaut de documentation, non de calcul : aucune exécution ne produit un
résultat faux à cause de cette ligne. Il est rangé ici parce que l'aspect porte
sur `src/config.ts` et que c'est la seule surface par laquelle un opérateur
croit pouvoir régler la consommation.

## Ce qui a été vérifié et tient

- **Le calcul du réveil sur reset annoncé est juste**, hors le cas du constat 1.
  `resetsAt * 1000 + 30_000` convertit bien des secondes epoch en
  millisecondes, la marge de 30 s est intentionnelle, le plancher de 60 s évite
  le rejeu immédiat et le plafond `until() − now` empêche de dormir au-delà de
  la plage (`src/scheduler.ts:111-120`, testé en `src/scheduler.test.ts:92-105`).
- **Le quota ne compte pas d'échec et ne fait pas avancer le curseur** :
  `applyOutcome` rend `"backoff"` sans toucher à `iterations`,
  `consecutiveFailures` ni `cursor` (`src/graph.ts:92-93`, testé en
  `src/graph.test.ts:92-96`), et `applyDecision` garde la tâche collante
  (`src/graph.ts:147-151`). Sur ce chemin — le chemin nominal — la politique
  fait exactement ce que le README annonce.
- **Une itération non `completed` est bien intégralement annulée** : container
  jeté, `DONE` retiré, curseur conservé (`src/iterate.ts:184-186`), y compris
  quand le commit échoue après un `completed` (`src/iterate.ts:168-183`). Le
  rejeu repart d'un état propre ; la perte décrite aux constats 1 et 2 est
  celle du *travail* de la session, pas celle de la cohérence de l'état.
- **401/403 arrêtent bien la plage** au lieu d'épuiser les compteurs
  (`src/graph.ts:34,49-51` → `"stop-window"`, `src/scheduler.ts:123-128`),
  conformément à `README.md:109-111`. C'est le modèle dont les constats 1 et 2
  montrent que le quota ne bénéficie qu'à moitié.
- **`parseStream` et `quotaSnapshot` sont fidèles à leur entrée** : ordre des
  événements préservé, lignes non-JSON ignorées sans bruit, aucun arrondi
  fautif (`src/claude.ts:85-127`). Les défauts d'*observabilité* de ces
  fonctions — `quotaAfter` qui s'efface, `quotaBefore` qui n'en est pas un,
  fenêtre inconnue rangée sous `five_hour` — sont établis par le rapport 040 ;
  je ne les reprends pas.
- **La non-persistance du reset** (plage suivante et redémarrage relancent une
  session rejetée) est établie par le rapport 043. Le constat 2 ci-dessus en
  est distinct : il porte sur une saturation *mal classée*, pas sur une
  saturation correctement classée puis oubliée.
- **Aucune réserve nulle part, et c'est cohérent de bout en bout** : pas de clé
  de seuil dans `src/config.ts:12-42`, pas de comparaison sur `utilization`,
  pas de lecteur de `allowed_warning`, et `IterateResult.quotaAfter` qui meurt
  dans `Daemon.onEvent` (déjà relevé en 040). La boucle est sans mémoire de
  quota d'une itération à la suivante. Ce n'est pas un bug à rapporter — le
  README assume la saturation — mais c'est ce qui rend le capteur destructif
  inévitable, et donc ce qui donne leur portée aux constats 1 et 2.
