# 040 — Mesure du quota par itération : un « après » qui s'efface, un « avant » qui n'en est pas un

**Fichiers examinés** : `src/claude.ts:54-73` (`QuotaWindow`, `QuotaSnapshot`,
`RateLimitInfo`), `src/claude.ts:85-112` (`parseStream`),
`src/claude.ts:114-127` (`quotaSnapshot`), `src/claude.ts:129-136`
(`quotaRejection`), `src/iterate.ts:150-153` (`quotaBefore` / `quotaAfter`),
`src/iterate.ts:192-216` (`IterationRecord`), `src/iterate.ts:225`
(impression), `src/iterate.ts:230` (`IterateResult`), `src/iterate.ts:239-243`
(`describeQuota`), `src/log.ts:20-35` et `49-66` (`index.jsonl`),
`src/graph.ts:37-50` (`classify`), `src/scheduler.ts:96-120`,
`src/daemon.ts:15-60` et `253-270` (`DaemonStatus`, `onEvent`),
`src/claude.test.ts:37-68`, `src/iterate.test.ts:18-24` et `80-123`,
`README.md:100-107`.

**Verdict** : 3 constats (2 sûrs, 1 à vérifier)

Le but affiché de la mesure est écrit deux fois, dans le code et dans le
README :

```ts
// src/log.ts:21-23
// Les fenêtres de quota (5 h / 7 j) au premier et au dernier événement de la
// session : c'est ce qui permet de rapprocher un coût en $ d'un % de quota.
quota: { before: QuotaSnapshot | null; after: QuotaSnapshot | null };
```

> Les pourcentages des fenêtres 5 h et 7 jours avant et après chaque
> itération, le coût et le modèle sont dans `data/logs/index.jsonl` : de quoi
> rapprocher un coût en dollars d'un pourcentage de quota. (`README.md:103-107`)

Autrement dit, la grandeur utile n'est ni `before` ni `after` prise seule :
c'est leur différence. Les trois constats portent sur cette différence.

Tout repose sur deux lignes :

```ts
// src/iterate.ts:152-153
const quotaBefore = quotaSnapshot(session.rateLimits[0]);
const quotaAfter = quotaSnapshot(session.rateLimits[session.rateLimits.length - 1]);
```

## Le dernier événement de quota n'en porte souvent aucun chiffre, et il efface la mesure

**Gravité** : sûr
**Où** : `src/iterate.ts:153`, `src/claude.ts:115-127`

`quotaAfter` prend le *dernier* événement, quel qu'il soit, sans vérifier
qu'il transporte une fenêtre. Or `quotaSnapshot` rend `null` dès que
l'événement n'a ni `unifiedWindows` ni le couple complet
`utilization` + `resetsAt` :

```ts
// src/claude.ts:117-126
const snap: QuotaSnapshot = {};
const w = info.unifiedWindows ?? {};
if (w.five_hour) snap.five_hour = { ...w.five_hour };
if (w.seven_day) snap.seven_day = { ...w.seven_day };
if (!snap.five_hour && !snap.seven_day && info.utilization !== undefined && info.resetsAt !== undefined) {
  const key = info.rateLimitType === "seven_day" ? "seven_day" : "five_hour";
  snap[key] = { utilization: info.utilization, resetsAt: info.resetsAt };
}
return snap.five_hour || snap.seven_day ? snap : null;
```

L'événement `rejected` tel que le dépôt lui-même le modélise est exactement de
cette forme — statut, type, reset, et rien d'autre :

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":100}}
```
(`src/claude.test.ts:42` ; même forme en `src/graph.test.ts:43` et
`src/iterate.test.ts:120`)

Scénario concret. Une session consomme le reste du quota 5 h et se fait
refuser. Le flux porte deux événements : d'abord
`{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.9,"resetsAt":100},"seven_day":{"utilization":0.3,"resetsAt":900}}}`,
puis le `rejected` minimal ci-dessus.

- `quotaBefore` = `{ five_hour: 0.9, seven_day: 0.3 }` ;
- `quotaAfter` = `quotaSnapshot(rejected minimal)` → `unifiedWindows` absent,
  `utilization` absent → **`null`**.

Conséquences en chaîne, toutes vérifiables sur ces deux lignes :

```ts
// src/iterate.ts:225
if (quotaAfter) print(`quota    ${describeQuota(quotaBefore)} → ${describeQuota(quotaAfter)}`);
```
La ligne `quota` n'est **pas imprimée du tout** — précisément dans le cas
(saturation) où l'opérateur la cherche. Elle l'aurait été pour une itération
banale.

```ts
// src/log.ts:61-63
fiveHourAfter: rec.quota.after?.five_hour?.utilization ?? null,
sevenDayAfter: rec.quota.after?.seven_day?.utilization ?? null,
```
Dans `index.jsonl`, la ligne de l'itération la plus chère de la plage porte
`fiveHourBefore: 0.9`, `fiveHourAfter: null`, `sevenDayAfter: null`. Le
rapprochement $ ↔ % annoncé par le README est impossible sur cette itération
alors que l'information existait : l'événement `allowed` d'avant le refus
était dans le flux, et le passage à 100 % est implicite dans le `rejected`.

Attendu : `quotaAfter` devrait être le dernier événement *porteur de fenêtres*
(parcours à rebours), le `rejected` n'apportant qu'une borne supplémentaire.
Obtenu : la seule présence d'un événement final sans chiffres annule la mesure
de fin.

Le cas n'est couvert par aucun test : `src/iterate.test.ts:118-123` (« quota
rejected ») ne vérifie que `outcome` et `decision`, jamais `rec.quota`.

Atténuation réelle : le fichier d'itération complet garde `rateLimits` brut
(`src/iterate.ts:208`), donc l'information reste reconstituable à la main. La
perte est sur `index.jsonl` et sur la console, c'est-à-dire sur les deux
surfaces que le README désigne comme celles de l'analyse.

## Un seul événement de quota ⇒ `before` et `after` sortent du même événement, et la consommation lue vaut zéro

**Gravité** : sûr
**Où** : `src/iterate.ts:152-153`

Quand la session n'émet qu'un seul `rate_limit_event`,
`session.rateLimits[0]` et `session.rateLimits[session.rateLimits.length - 1]`
désignent **le même objet**. `quotaBefore` et `quotaAfter` sont alors deux
instantanés identiques, par construction.

Scénario concret. Une itération longue (`total_cost_usd: 1.9`, 40 tours) dont
le flux contient un unique événement
`{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.42,"resetsAt":100}}}`.
La ligne écrite dans `index.jsonl` est :

```json
{"costUsd":1.9,"fiveHourBefore":0.42,"fiveHourAfter":0.42, …}
```

et la console imprime `quota 5h 42% / 7j ? → 5h 42% / 7j ?`. Lu comme le
README invite à le lire, cela dit : « 1,90 $ dépensés, 0 % de quota
consommé ». Delta attendu : strictement positif ; delta obtenu : exactement 0.
Ce n'est pas une imprécision, c'est une impossibilité arithmétique — un seul
point de mesure ne peut pas donner une variation.

Le défaut est structurel au-delà de ce cas limite : un `rate_limit_event`
n'est émis *qu'une fois l'information de quota changée*
(`src/claude.ts:65`), donc le premier événement reflète déjà la consommation
du début de session. `before` n'est jamais l'état d'avant l'itération, c'est
l'état après son premier palier. La mesure est donc systématiquement
sous-estimée, et le biais est total (100 % de la consommation perdue) dans le
cas à un seul événement, qui est celui des itérations courtes ou des paliers
de quota grossiers.

Un état d'« avant » fiable ne peut pas venir de la session elle-même : il
faudrait reporter le `after` de l'itération précédente, ou lire le quota avant
de lancer le container.

## La forme minimale range sous « 5 h » tout type de fenêtre non nommé `seven_day`

**Gravité** : à vérifier
**Où** : `src/claude.ts:123`

```ts
const key = info.rateLimitType === "seven_day" ? "seven_day" : "five_hour";
```

Le type est déclaré libre et facultatif (`rateLimitType?: string`,
`src/claude.ts:69`), et le code lui-même admet qu'il peut manquer :
`quotaRejection` prévoit un repli `"unknown"` (`src/claude.ts:133`), et
`src/graph.test.ts:51` construit un événement sans `rateLimitType`. Toute
valeur autre que la chaîne exacte `seven_day` — absente, `"weekly"`,
`"seven_day_opus"`, une graphie future — est donc rangée dans `five_hour`,
sans marqueur d'incertitude.

Scénario concret. Un événement
`{"status":"allowed_warning","rateLimitType":"weekly_opus","utilization":0.77,"resetsAt":1789596600}`
produit `{ five_hour: { utilization: 0.77, resetsAt: 1789596600 } }`. La
console affiche `5h 77% / 7j ?`, `index.jsonl` reçoit `fiveHourAfter: 0.77` et
`sevenDayAfter: null`, et le `resetsAt` stocké dans la fenêtre « 5 h » est en
réalité un reset hebdomadaire — un horodatage qui peut se situer à six jours.
Attendu : la fenêtre inconnue n'est pas attribuée, ou elle est attribuée à la
bonne clé. Obtenu : une fenêtre longue lue comme une fenêtre courte.

Pourquoi « à vérifier » et pas « sûr » : le comportement du code est certain
(le ternaire ne laisse aucune autre issue), mais je n'ai pas pu établir depuis
ce dépôt que Claude Code émette effectivement un `rateLimitType` hors
{`five_hour`, `seven_day`}, ni qu'il émette la forme minimale avec
`utilization`. Les seuls exemples disponibles sont les fixtures de tests, qui
n'utilisent la forme minimale que dans des événements `rejected` dépourvus
d'`utilization` — lesquels tombent dans le constat précédent avant d'atteindre
cette ligne. Le constat tient donc comme fragilité démontrée du classement,
pas comme erreur observée en production.

Note de même famille, non comptée comme constat : le repli exige `utilization`
**et** `resetsAt`. Un événement ne portant que `utilization` (avertissement
sans reset annoncé) rend `null` et disparaît de la mesure, alors que le
pourcentage — la seule grandeur dont `index.jsonl` se sert — était présent.

## Ce qui a été vérifié et tient

- **Les décisions du planificateur ne dépendent pas de ces instantanés.**
  `classify` (`src/graph.ts:45-46`) passe par `quotaRejection`, qui lit
  `status` / `rateLimitType` / `resetsAt` directement sur les événements bruts,
  sans jamais appeler `quotaSnapshot`. Le `backoff` et son calcul de réveil
  (`src/scheduler.ts:112-116`) sont donc corrects même quand `quotaAfter` est
  `null`. Les trois constats ci-dessus sont des défauts d'observabilité, pas
  d'ordonnancement.
- **`quotaRejection`** parcourt bien à rebours et rend le dernier `rejected`
  (`src/claude.ts:130-135`) ; `parseStream` collecte tous les
  `rate_limit_event` dans l'ordre et ignore proprement les lignes non-JSON
  (`src/claude.ts:88-96`).
- **`IterateResult.quotaAfter` n'est lu nulle part.** Il est produit
  (`src/iterate.ts:230`), traverse `SchedulerEvent`
  (`src/scheduler.ts:20`) et meurt dans `Daemon.onEvent`, qui ne retient que
  `costUsd`, `decision` et `outcome` (`src/daemon.ts:258-267`) ;
  `DaemonStatus` n'a aucun champ de quota (`src/daemon.ts:15-35`), et `status`
  n'en affiche pas. Champ inerte, donc : ni mensonge ni perte de données,
  simplement une mesure qui n'atteint jamais `status`. Inutile d'y chercher un
  bug — mais c'est là qu'il faudrait brancher l'affichage du quota courant si
  on le voulait.
- **`describeQuota`** (`src/iterate.ts:239-243`) et l'écriture de
  `index.jsonl` (`src/log.ts:49-66`) sont fidèles à ce qu'on leur donne : ils
  propagent `?` / `null` sans inventer. Aucun arrondi fautif (`0.425` → `42.5%`).
- **`buildCommand`** impose bien `--output-format stream-json --verbose` et
  neutralise les trois formes concurrentes (`--output-format X`,
  `--output-format=X`, `--verbose`) — sans cela aucun événement de quota ne
  serait lisible (`src/claude.ts:25-38`, testé en `src/claude.test.ts:24-35`).
