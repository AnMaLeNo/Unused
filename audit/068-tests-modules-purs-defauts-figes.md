# 068 — Tests des modules purs : ce que les fixtures figent, ce qu'elles évitent

**Fichiers examinés** : `src/graph.test.ts` (entier), `src/calendar.test.ts`
(entier), `src/claude.test.ts` (entier), `src/state.test.ts` (entier),
`src/task.test.ts` (entier), `src/docker.test.ts` (entier), confrontés à
`src/graph.ts` (entier), `src/calendar.ts:25-78`, `src/claude.ts:8-136`,
`src/state.ts:38-84`, `src/task.ts:27-201`, `src/docker.ts:126-211` ;
`tsconfig.json` (entier), `package.json:13-18`, `deploy/install.sh:31-34`,
`src/scaffold.ts:5-14`, `src/iterate.ts:150-190`.

**Verdict** : 2 constats (2 sûrs)

Angle : le rapport 025 a instruit les trois fichiers de test à doublures
(`iterate`, `scheduler`, `daemon`). Celui-ci prend les six fichiers sans
doublure — ceux qui exercent des fonctions pures, où une assertion est
exactement le contrat du produit, ni plus ni moins.

Ni `node` ni `node_modules` dans ce container : aucun test n'a été rejoué,
tout ce qui suit est établi par lecture du code et des fichiers de
configuration, et les déroulés sont faits à la main.

## 1. Aucun outil du dépôt ne type-vérifie la suite de tests, et la fixture de graphe en profite déjà : elle ne compile pas

**Gravité** : sûr
**Où** : `tsconfig.json:18-19`, `package.json:14-17`, `src/graph.test.ts:6-24`

Le seul `tsconfig.json` du dépôt exclut explicitement les tests du programme :

```json
  "include": [
    "src"
  ],
  "exclude": [
    "src/**/*.test.ts"
  ]
```

Les deux scripts qui appellent le compilateur partent de ce fichier :

```json
"build": "tsc",
"typecheck": "tsc --noEmit",
"test": "vitest run"
```

Il n'y a aucun second `tsconfig` (un seul à la racine, `ls` du dépôt), aucun
`vitest.config.*` — donc pas de `typecheck.enabled`, et `vitest` transpile par
esbuild sans jamais lire les types —, aucun workflow d'intégration (pas de
`.github/`), et `deploy/install.sh:31-34` enchaîne `npm ci`, `npm run build`,
`npm prune` sans jamais lancer ni les tests ni le typecheck. Résultat :
**1 131 lignes de test (les dix `src/*.test.ts`) ne sont relues par aucun
vérificateur de types**, alors que `npm run typecheck` annonce que le projet
type-vérifie.

Ce n'est pas une inquiétude de principe : la fixture partagée par tous les
tests de `graph.test.ts` est déjà hors contrat.

```ts
// src/graph.test.ts:6-24
function makeTask(name: string, def: Partial<TaskFile> = {}): Task {
  return {
    name,
    dir: `/tasks/${name}`,
    skillsDir: `/tasks/${name}/skills`,
    exchangeDir: `/tasks/${name}/exchange`,
    def: {
      active: true,
      start: "find",
      params: {},
      nodes: { setup: {…}, find: {…}, do: {…} },
      ...def,
    },
  };
}
```

`def` est contextuellement typé `TaskFile`, c'est-à-dire la *sortie* du schéma
zod, où `env` est requis :

```ts
// src/task.ts:46
env: z.array(z.string().regex(ENV_ENTRY_RE, …)).default([]),
```

`.default([])` rend la clé facultative à l'entrée mais **requise à la sortie**
(`z.infer<typeof TaskFileSchema>` → `env: string[]`). L'objet littéral de la
fixture ne la mentionne pas, et le seul apport possible est le spread
`...def` de type `Partial<TaskFile>` : la propriété reste donc *facultative*
dans le type du littéral (règle du spread : une propriété facultative de la
source reste facultative dans le résultat), et une propriété facultative n'est
pas assignable à une propriété requise en mode `strict`. Le fichier serait
donc refusé par `tsc` ; il ne lui est simplement jamais soumis.

Scénario concret, celui qui s'est déjà produit : `env` est ajouté à
`TaskFileSchema`, les sources sont corrigées, `npm run typecheck` est vert,
`npm run build` est vert, `vitest run` est vert — et les dix-neuf tests de
`graph.test.ts` continuent de travailler sur un `task.def` que `loadTask` ne
peut pas produire (`env: undefined` au lieu de `[]`). Obtenu : trois commandes
vertes et un fichier de test qui ne compile pas. Attendu : soit les tests dans
le programme type-vérifié (un `tsconfig.test.json` que `typecheck` inclut, ou
`typecheck.enabled` côté vitest), soit l'aveu que la suite n'est pas
type-vérifiée.

L'enjeu dépasse `env`, qui est inoffensif ici (aucune fonction de `graph.ts` ne
lit `def.env`) : toute la valeur d'un test de fonction pure tient à ce que sa
fixture *soit* la donnée du produit. C'est précisément ce que personne ne
vérifie, ni ici ni dans les deux autres fixtures qui s'échappent par un cast
(`claude.test.ts:8` et `scheduler.test.ts:26`, `as unknown as Config` — déjà
relevé en 028). Le diagnostic exact de `tsc` n'a pas pu être exécuté dans ce
container ; l'exclusion, elle, se lit directement dans `tsconfig.json`.

Le rapport 066 a regardé cette même ligne `exclude` sous l'angle du
*déploiement* et l'a jugée cohérente (`dist/` ne doit pas référencer vitest) —
ce qui reste vrai. L'angle couverture est l'autre moitié : correcte pour
l'empaquetage, cette exclusion laisse la suite sans filet.

## 2. La suite ratifie la classification que 058 a établie comme destructrice, et les fixtures de `classify` s'arrêtent pile où les défauts connus commencent

**Gravité** : sûr
**Où** : `src/graph.test.ts:60-64`, avec `src/graph.test.ts:53-55` et
`src/claude.test.ts:37-44`

```ts
// src/graph.test.ts:60-64
it("tout le reste est un échec, y compris une sortie illisible", () => {
  expect(classify(res({ terminal_reason: "api_error", api_error_status: 500 }), false)).toEqual({ kind: "failure", reason: "api_error" });
  expect(classify(res({ terminal_reason: "max_turns" }), false).kind).toBe("failure");
  expect(classify(noQuota, false)).toEqual({ kind: "failure", reason: "unreadable_output" });
});
```

La deuxième assertion n'est pas un cas de crash parmi d'autres. `"max_turns"`
est, d'après le rapport 058 (constat unique, **sûr**, vérifié dans le binaire
installé), la `terminal_reason` que la CLI émet quand `--max-turns` se
déclenche — avec `is_error: true` et `subtype: "error_max_turns"` —, c'est-à-dire
le seul plafond de travail qu'un opérateur puisse réellement poser (aucun
réglage de plafond n'existe côté runner, `src/config.ts:33-42`). Classée
`failure`, elle entraîne, dans l'ordre :

```ts
// src/iterate.ts:184-187
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

le container de l'itération est jeté — donc le travail d'une session **payée**
est détruit —, et `applyOutcome` compte un échec consécutif
(`src/graph.ts:96-103`), si bien que trois déclenchements du plafond sortent la
tâche de la file (`status: "failed"`).

Ce que fait le test, c'est inscrire ce comportement comme le résultat attendu,
sous un titre qui le présente en fourre-tout légitime (« tout le reste est un
échec »). Trois conséquences, toutes vérifiables :

- le seul signal automatisé qui existe sur ce chemin est **vert**, et un
  relecteur qui lit la suite pour comprendre le contrat y voit une décision
  délibérée, pas un défaut ;
- toute correction de 058 (une issue distincte qui conserve le container, ou qui
  au moins ne nourrit pas le compteur d'échecs) doit commencer par contredire la
  ligne 62 : le test devient l'obstacle à la correction, pas le filet ;
- `"budget_exhausted"` — l'autre plafond, celui de `--max-budget-usd`, établi
  par 058 sur la même branche du constructeur de cadre `result` — n'apparaît
  dans **aucune** fixture du dépôt (`grep -rn "budget_exhausted" src/` : rien).
  La suite ne dit donc rien du tout du plafond en dollars.

Même forme pour la ligne 53-55 (`blocking_limit` → `failure`, le contexte plein
qui détruit lui aussi l'itération et compte un échec) : assertion posée, défaut
figé.

Le pendant de ce figeage, c'est l'évitement. Les fixtures de `classify`
couvrent neuf formes de session (`completed`, `completed`+DONE, `rejected`+429,
`rejected`+`completed`, `blocking_limit`, 401, 500, `max_turns`,
`result: null`) ; les trois formes qui distinguent les défauts déjà instruits
sont absentes, et ce sont exactement celles-là :

1. **un cadre `result` présent mais sans `terminal_reason`** (`res({})`).
   `classify` rend alors `reason: "unreadable_output"` via le `??`
   (`src/graph.ts:52`) — la confusion que 020 (constat 2, **sûr**) a démontrée
   entre « aucun cadre » et « un cadre parfaitement lisible ». Le test, lui,
   n'éprouve `unreadable_output` que sur `result: null` (`noQuota`,
   `graph.test.ts:28`), c'est-à-dire la seule des deux entrées où le nom ne
   mente pas.
2. **`{ terminal_reason: "completed", is_error: true }`**. `is_error` n'apparaît
   dans aucun fichier de test du dépôt (`grep -rn is_error src/*.test.ts` :
   aucune ligne), alors que c'est le
   champ documenté du contrat que 020 (constat 3) montre ignoré : une session
   que la CLI qualifie elle-même d'erreur est commitée comme un succès.
3. **un `rateLimitType` autre que `five_hour` / `seven_day`**.
   `graph.test.ts:43` emploie `"five_hour"`, `claude.test.ts:62` `"seven_day"` ;
   les quatre autres valeurs de l'énumération fermée de la CLI relevées par 045
   (`seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`,
   `overage`) ne sont jamais passées — ni à `quotaRejection`, dont le
   `?? "unknown"` et la globalité du `backoff` sont le constat **sûr** de 045,
   ni à `quotaSnapshot`, dont le ternaire les range toutes dans `five_hour`
   (040).

Autrement dit : la suite éprouve les entrées pour lesquelles `classify` a
raison, et aucune de celles pour lesquelles il a été démontré qu'il a tort. Ce
n'est pas un oubli isolé mais le même geste répété neuf fois, et c'est ce qui
permet à `vitest run` d'être vert sur un module dont quatre rapports ont
instruit les erreurs de classement.

## Ce qui a été vérifié et tient

- **`calendar.test.ts:33-42`, déroulé à la main** : `occurrences` triées donnent
  mer 22:00→jeu 01:00 (`inside`, `end` = jeu 01:00), jeu 00:30→04:00 (`extends_`,
  04:00), jeu 04:00→06:00 (`extends_`, 06:00), jeu 09:00→10:00 (ignorée) → jeu
  06:00, la valeur attendue. Chaque étape **augmente** `end` : la branche sans
  garde de `coverageEnd` (`calendar.ts:65`) n'est jamais exercée. C'est le
  constat 1 de 007 (**sûr**, plage imbriquée qui tronque la couverture), qui
  relève déjà ce trou de test ; non recompté ici.
- **Les autres tests de `calendar.test.ts` pinglent de vrais contrats** : début
  inclus / fin exclue (`:28-31`), traversée de minuit (`:22-26`), absence de
  nuit le samedi (`:44-48`), listes vides (`:50-53`) — tous rejoués à la main
  contre `occurrences`/`coverageEnd`/`nextStart`, tous corrects. Le fuseau non
  épinglé pour les tests est instruit en 061.
- **`graph.test.ts` › `pickNext` (`:146-193`)** : les quatre séquences
  (`["a","b","c","a","b"]`, la collante `b`, le saut des inactives/terminées, la
  collante inéligible qui libère la file) reproduisent exactement
  `pickNext`/`applyDecision` ; elles figent la priorité de la tâche collante,
  ce que 045 a déjà relevé en ces termes. Rien d'autre à en dire.
- **`graph.test.ts:137-144` (`ensureTaskState`)** : 044 note déjà que le test
  n'observe que la valeur rendue (ni persistance, ni trace, ni `ts.last`).
  S'y ajoute que la fixture rend la réparation inoffensive par construction :
  `start` vaut `"find"`, un nœud de boucle, et le nœud `setup` qu'elle déclare
  est détaché de `start`. Aucun test du dépôt n'emploie la forme
  amorce→boucle que `unused tasks new` produit (`scaffold.ts:5-14`,
  `start: "setup"`, `setup → work → work`), la seule où le repli silencieux
  rejoue l'amorce. Le défaut est celui de 044 ; la fixture explique seulement
  pourquoi la suite ne le voit pas.
- **`claude.test.ts` › `parseStream` (`:46-58`)** : les six lignes NDJSON de la
  fixture correspondent une à une à ce que lit `parseStream` (`lines` = 6
  compté à la main, `rate_limit_info` imbriqué, `system/init` et
  `system/api_retry` distingués) ; le test du bruit et de la sortie vide couvre
  bien les deux rejets (`!t.startsWith("{")` et `JSON.parse` qui jette). Cette
  fixture ne peut pas passer à vide.
- **`state.test.ts` (les trois tests)** : conformes à `loadState`/`saveState` —
  `ENOENT` → `emptyState()`, aller-retour avec création du dossier et `version`
  écrite, `{"version": 2}` refusé avec un message qui nomme le fichier (choix
  délibéré, instruit en 017). Non couverts : le défaut `pausedUntil: null` sur
  un état ancien, et le couple fichier temporaire/`rename`. Lecture faite, ces
  deux chemins sont corrects ; rien à signaler au-delà de 017.
- **`task.test.ts:7-11` (`resolveEnv`)** : assertions exactes contre
  `task.ts:95-105` — `"B=x=y"` coupé au *premier* `=`, nom absent listé dans
  `missing`, listes vides. `loadTasks` et `describeGraph` restent sans aucun
  test (déjà dit en 035 et 044).
- **`docker.test.ts` (les trois tests)** : conformes à `importChanges`
  (`docker.ts:195-211`), y compris le cas qui compte vraiment, une valeur
  d'`ENV` contenant un espace et un `=` (`"X=a b=c"` → `ENV X="a b=c"`), et la
  tolérance aux champs `null`. Le cas non couvert — une entrée `Env` sans `=`,
  qui produirait `ENV FO="FOO"` par `indexOf` à -1 — n'est pas rapporté comme
  défaut : tous les producteurs de cette config écrivent `NOM=valeur`
  (`docker commit` puis `docker image inspect`), et `runInTask` ne passe
  `-e NOM` que pour des noms définis dans l'environnement du client
  (`docker.ts:145`). Je n'ai pas trouvé d'entrée nue atteignable.
- **Déjà instruits ailleurs, non recomptés** : la troncature de couverture et
  son trou de test (007), le succès lu dans un champ facultatif (020), le
  mauvais rangement de `seven_day_opus` dans `five_hour` (040), le repli muet du
  curseur (044), la globalité du quota et l'équité de la tâche collante (045),
  les plafonds de coût et de tours (058), `loadTasks` sans test (035),
  `docker.test.ts` qui ne couvre que deux fonctions (005, 051), le refus d'un
  `state.json` corrompu (017), les casts `as unknown as Config` (028), le fuseau
  non épinglé (061), l'`exclude` jugé du point de vue de l'empaquetage (066).
