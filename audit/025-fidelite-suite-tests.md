# 025 — Fidélité de la suite de tests : doublures qui ne peuvent pas échouer, chemins d'échec et de concurrence jamais exercés

**Fichiers examinés** : `src/iterate.test.ts:1-210` (entier), `src/scheduler.test.ts:1-208`
(entier), `src/daemon.test.ts:1-263` (entier), confrontés à `src/iterate.ts:72-237`,
`src/scheduler.ts:56-155`, `src/daemon.ts:177-274,328-373`, `src/graph.ts:64-153`,
`src/docker.ts:26-60,130-180`, `src/claude.ts:86-136`, `src/cli.ts:96-112` ;
pour vérification croisée `src/calendar.ts:60-68`, `src/claude.test.ts`, `src/calendar.test.ts`
**Verdict** : 3 constats (2 sûrs, 1 probable)

Note d'environnement : ni `node` ni `npm` ne sont présents dans ce container, la
suite n'a donc **pas** pu être exécutée. Les deux constats « sûrs » sont des
propriétés statiques de la suite (une ligne de `src/` qu'aucun test ne peut
atteindre), vérifiables par lecture ; le constat « probable » repose sur la
sémantique de `subsetEquality` dans `@vitest/expect`, que je n'ai pas pu lire sur
place — sa vérification est une édition d'une ligne, décrite plus bas.

## Quatre assertions ne vérifient rien : un `RegExp` passé à `toMatchObject` est toujours satisfait

**Gravité** : probable
**Où** : `src/iterate.test.ts:197`, `src/iterate.test.ts:199`, `src/daemon.test.ts:158`, `src/daemon.test.ts:164`

```ts
// src/iterate.test.ts:194-201
it("env manquante ou token absent : panne auth sans rien lancer", async () => {
  task.def.env = ["GH_TOKEN"];
  const r = await iterate(cfg, task, state, { deps: deps(() => ({ stdout: ok() })) });
  expect(r.outcome).toMatchObject({ kind: "fatal", reason: "auth", detail: /GH_TOKEN/ });
  const r2 = await iterate(cfg, task, state, { deps: deps(() => ({ stdout: ok() }), { env: {} }) });
  expect(r2.outcome).toMatchObject({ kind: "fatal", reason: "auth", detail: /CLAUDE_CODE_OAUTH_TOKEN/ });
```

`toMatchObject` compare via `equals(reçu, attendu, [… , subsetEquality])`.
`subsetEquality` commence par `if (!isObjectWithKeys(subset)) return undefined`, et
`isObjectWithKeys` n'exclut que `null`, `Error`, `Array` et `Date` : un `RegExp`
est donc traité comme un objet à comparer clé par clé. Or ses clés énumérables
propres sont l'ensemble vide (`lastIndex` est non énumérable), et le test se
réduit à `[].every(…)` → `true`. Le testeur est consulté **avant** la comparaison
de classes (`'[object String]'` vs `'[object RegExp]'`, qui échouerait) : la
sous-assertion est donc vraie quel que soit le contenu de la chaîne reçue. Seule
la *présence* de la clé est vérifiée (`hasPropertyInObject(object, key)`).

Ce que ça coûte ici précisément : les deux issues comparées sont identiques sur
tout le reste (`kind: "fatal"`, `reason: "auth"`) ; `detail` est le **seul**
élément qui distingue « variable d'environnement de la tâche absente »
(`iterate.ts:105`) de « token absent » (`iterate.ts:101`). Le test porte donc sur
deux causes d'échec distinctes sans en vérifier aucune.

Scénario concret : échanger les deux expressions entre la ligne 197 et la ligne
199, ou remplacer `iterate.ts:105` par `finishFatal("auth", "variables absentes")`
(sans les noms manquants, la seule information exploitable pour l'utilisateur).
Attendu : le test échoue. Obtenu : `vitest run` reste vert. Même chose pour
`src/daemon.test.ts:153-166`, où seul le `status: 409` est réellement contrôlé :
le test « start refuse sans image de base, **ou sans Docker** » passerait si les
deux branches de `startWindow` (`daemon.ts:287-293`) renvoyaient le même message,
ou le message de l'autre cause.

Vérification (30 s, dès qu'un `node` est disponible) : remplacer `/GH_TOKEN/` par
`/CE_TEXTE_N_EXISTE_NULLE_PART/` et relancer `npm test`. Si le test reste vert, le
constat est établi ; la correction est `expect.stringMatching(/GH_TOKEN/)`, forme
asymétrique qui, elle, est honorée.

## L'arrêt gracieux n'est vérifié que contre une doublure qui l'implémente elle-même

**Gravité** : sûr
**Où** : `src/daemon.test.ts:23-45` et `:98-114`, contre `src/scheduler.ts:84-87` et `:145`

`shouldStop` n'apparaît dans aucun test à part la doublure de `runWindow` :

```ts
// src/daemon.test.ts:28-38 — la doublure fait elle-même le travail testé
await new Promise<void>((resolve) => {
  finish = resolve;
  signal.addEventListener("abort", () => resolve());
  const poll = setInterval(() => {
    if (deps.shouldStop?.()) { clearInterval(poll); resolve(); }
  }, 5);
  …
});
const summary: WindowSummary = { …, endedBecause: signal.aborted ? "stopped" : "window" };
if (!signal.aborted) { state.window = null; await saveState(cfg.dataDir, state); }
```

`src/scheduler.test.ts` ne passe jamais `shouldStop` (le défaut `() => false`
s'applique, `scheduler.ts:70`). Conséquence vérifiable par lecture : les deux
instructions

```ts
// src/scheduler.ts:84-87
if (deps.shouldStop()) { stopped = true; break; }
// src/scheduler.ts:145
if (stopped) summary.endedBecause = "stopped";
```

sont **inatteignables dans toute la suite**. On peut les supprimer : aucun test ne
tombe. Le test qui semble les couvrir, `start → … ; stop gracieux → repos, plage
oubliée` (`daemon.test.ts:98-114`), n'observe que la doublure : le réveil sur
`shouldStop` (polling 5 ms, que `runWindow` ne fait pas — il ne consulte le drapeau
qu'en tête de boucle), l'effacement de `state.window` et le `saveState` sont écrits
dans la doublure, pas empruntés au produit. Les trois assertions du test
(`status().window` nul, `state.json.window` nul, second `DELETE` en 409) sont donc
produites par le test lui-même.

La doublure va plus loin qu'une simplification : elle renvoie un résumé que le
vrai `runWindow` ne renverrait pas dans ce scénario. Plage manuelle (`for: "1h"`,
`cfg.windows` vide), `DELETE /window` sans `now` → `stopWindow(false)` pose
`stopRequested` sans lever `ac` (`daemon.ts:324`) ; le vrai `runWindow` sort donc
par `shouldStop` avec `endedBecause: "stopped"`, la doublure rend
`endedBecause: "window"` (ligne 39, `signal.aborted` est faux). Ce champ est
conservé dans `this.lastWindow` (`daemon.ts:192`) et affiché à l'utilisateur
(`cli.ts:107-110`, `dernière … (window)`). Aucun test n'assertant `lastWindow`
(vérifié : le mot n'apparaît nulle part dans `daemon.test.ts`), la divergence est
invisible.

Ce n'est pas un angle mort théorique : les deux défauts déjà instruits dans cette
branche — l'arrêt gracieux non honoré pendant l'attente quota (003) et
`endedBecause` qui reste `"window"` quand `pausedUntil` fait sortir la boucle par
la condition de fin de plage (002) — vivent exactement dans les lignes qu'aucun
test n'exécute, alors qu'un test vert nommé « stop gracieux » donne le contraire
à lire. Symptôme associé, vérifiable d'un `grep` : `finish` (`daemon.test.ts:21`)
est affecté (`:29`) et remis à null (`:83`) mais **jamais appelé** — aucun test du
démon ne laisse donc une plage atteindre son terme ; toutes s'arrêtent par `stop`,
par `abort`, ou rendent la main immédiatement (`idleRun`, `fatalRun`).

## Tout l'affichage d'avancement de `status` n'est exercé par aucun test : aucune doublure n'émet d'événement

**Gravité** : sûr
**Où** : `src/daemon.ts:252-274` (`onEvent`) et `:334-345`, contre `src/daemon.test.ts:23-45,203-207,224-227`

Les trois doublures de `runWindow` du fichier (`fakeRunWindow`, `idleRun`,
`fatalRun`) n'appellent jamais `deps.onEvent`. Le vrai `runWindow` en émet quatre
sortes (`scheduler.ts:97,99,119,150`), et c'est la seule source de l'avancement
affiché : `Daemon.onEvent` alimente `run.live` et `run.current`, que `status()`
recopie (`daemon.ts:342-344`) et que la CLI imprime en clair
(`cli.ts:100-103` : `N itérations, N completed, N échecs, N attentes quota, $X`,
puis `en cours <tâche>/<nœud>` ou `en cours attente quota jusqu'à …`).

Conséquence : dans chaque test, `status().window` porte des compteurs à zéro, un
`current: null` et un `waitingQuotaUntil: null`, et aucun test ne les regarde
(vérifié : `iterations`, `completed`, `failures`, `backoffs`, `costUsd`,
`current`, `waitingQuotaUntil` n'apparaissent dans `daemon.test.ts` qu'à
l'intérieur des résumés que les doublures fabriquent, lignes 39, 206 et 226). Les
23 lignes de `onEvent` sont du code mort pour la suite : inverser `completed` et
`failures`, supprimer l'exclusion des itérations abandonnées
(`daemon.ts:260`) ou ne jamais remettre `current` à `null` laisse `vitest run`
vert, alors que `unused status` est le seul moyen qu'a l'utilisateur de voir ce
que sa plage est en train de faire.

Je n'ai pas trouvé de défaut dans la comptabilité elle-même : `onEvent` a été
recalculé à la main contre `scheduler.ts:101-137` pour les six décisions et pour
l'itération abandonnée, et les deux comptages coïncident, `costUsd` inclus
(l'écart connu sur une plage reprise est instruit en 021). Le constat porte donc
sur la couverture, pas sur un calcul faux — mais il porte sur la totalité d'une
surface visible par l'utilisateur, dans le fichier de test qui est censé couvrir
« daemon + api ».

## Ce qui a été vérifié et tient

- **Arithmétique de `scheduler.test.ts`** : les quatre tests à horloge simulée ont
  été rejoués à la main tour par tour (`round-robin` 4 itérations à 0/10/20/30 min
  pour une plage de 35 min ; prolongation à 5 ; `backoff` de 15 min puis reprise
  de la tâche collante ; attente tronquée à 4 min qui termine pile à la fin de
  plage). Les nombres attendus sont les bons, et ils sont bien produits par le
  vrai `runWindow` — `clock`/`fakeIteration` ne font que l'horloge et l'état.
- **`fakeIteration` est fidèle sur la file d'attente** : ses mises à jour de
  `state.currentTask`/`lastTask`/`status` reproduisent exactement `applyDecision`
  (`graph.ts:139-152`) pour les six décisions ; le round-robin et la tâche
  collante testés ici sont donc ceux du produit. Elle ne reproduit ni
  `iterations` ni `consecutiveFailures`, mais aucun test de ce fichier ne s'appuie
  dessus (ils sont couverts par `graph.test.ts`).
- **Chemin d'abandon (`abort`) couvert aux deux étages, et cohérent** :
  `iterate.test.ts:167-180` (tué, jeté, ni `applyOutcome` ni `saveState` — vérifié
  par l'absence de `state.json`) et `scheduler.test.ts:188-207` (itération non
  comptée, `endedBecause: "stopped"`, plage conservée). Les deux correspondent à
  `iterate.ts:156-189` et `scheduler.ts:100,141-143`.
- **Persistance de `state.window` par `runWindow`** : réellement vérifiée, mais
  dans `scheduler.test.ts` (`:88-89`, `:119`, `:206`), pas dans `daemon.test.ts`
  où la doublure l'écrit elle-même. Le contrat est donc couvert une fois.
- **Fixtures `claude`** : `ok()` (`iterate.test.ts:18-24`) produit bien la forme
  que `parseStream` lit (`rate_limit_event.rate_limit_info`, `unifiedWindows`) et
  le test du quota vérifie une valeur réelle (`quotaAfter.five_hour.utilization`
  → 0.12), donc le double ne peut pas passer avec un flux vide.
- **Non repris ici, déjà instruits ailleurs** : l'effacement du `DONE`
  d'avant-session sans test (014), l'exception de `discardContainer`/`rm` qui
  traverse `iterate` sans journal ni `saveState` (014), le `signal` déjà levé à
  l'entrée de `onStart` que la doublure ne peut pas produire (001), l'arrêt
  gracieux pendant l'attente quota (003), la reprise de plage repartant à zéro
  (021). Ce rapport ne les recompte pas.
- **Pas d'autre assertion vide trouvée** : tous les autres `toMatchObject` de la
  suite ne portent que des valeurs scalaires ou des objets simples, les `expect`
  placés dans des rappels (`onEvent`, `script`) sont accompagnés d'une assertion
  finale sur le tableau collecté, et chaque promesse rejetée attendue passe par
  `await expect(...).rejects`.
