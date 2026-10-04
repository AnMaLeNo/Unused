# 030 — Débordement de la dernière itération après la fin de plage

**Fichiers examinés** : `src/scheduler.ts:56-156`, `src/iterate.ts:112-190`,
`src/daemon.ts:116-226`, `src/calendar.ts:60-68`, `src/graph.ts:81-103`,
`src/duration.ts`, `src/scheduler.test.ts:29-37`
**Verdict** : 2 constats (2 sûrs)

## La condition de sortie de boucle compare deux lectures successives de l'horloge : elle peut relancer une itération complète hors plage

**Gravité** : sûr
**Où** : `src/scheduler.ts:83` avec `src/daemon.ts:116-121`

La boucle de plage teste :

```ts
// src/scheduler.ts:83
while (!signal.aborted && deps.now() < until()) {
```

`until` est, dans le seul usage réel, la fonction passée par le démon
(`daemon.ts:195`) :

```ts
// src/daemon.ts:116-121
private deadline(manualUntil: Date | null): Date {
  const now = this.deps.now();
  const calendar = this.calendarEnd(now);
  const ends = [manualUntil, calendar].filter((d): d is Date => d !== null).map((d) => d.getTime());
  return ends.length > 0 ? new Date(Math.max(...ends)) : now;
}
```

Pour une plage **purement calendrier** (`run.manualUntil === null`), une fois la
couverture terminée `calendarEnd()` renvoie null (`coverageEnd` ne trouve plus
d'occurrence contenant `now`, `calendar.ts:60-68`), `ends` est vide et
`deadline()` retourne **`now`, échantillonné à l'intérieur de l'appel**.

La comparaison devient donc `now_1 < now_2` où les deux dates proviennent de
deux appels distincts à `new Date()`. JavaScript évalue l'opérande gauche avant
l'opérande droit : `deps.now()` est lu en premier (`now_1`), puis `until()` est
appelé et lit l'horloge (`now_2`), avec `now_2 ≥ now_1`. **Dès qu'une
milliseconde s'écoule entre les deux lectures, la condition est vraie et la
boucle repart**, alors que la plage est finie.

Entre les deux lectures il y a du travail réel : l'appel de la closure,
`this.deadline`, `calendarEnd` (lecture de `pausedUntil`), puis `coverageEnd` →
`occurrences`, qui construit et trie les occurrences des 9 jours de J-1 à J+7
pour chaque spec (`calendar.ts:39-54`). C'est quelques dizaines de
microsecondes : la frontière de milliseconde est franchie dans un petit
pourcentage des tours — davantage sur une machine chargée ou si une pause GC
tombe là.

Scénario concret. Config livrée (`unused.config.json`) : une plage automatique
lundi 00:00 → 13:00, `claude.timeoutMinutes` 180.

1. 12 h 40 : une itération démarre (`deps.now() < until()` = 13:00, légitime).
2. 14 h 10 : la session rend la main. Haut de boucle : `deps.now()` lit
   14:10:00.000 ; `until()` traverse `occurrences`/`coverageEnd`, ne trouve
   aucune couverture, et retourne sa propre lecture — 14:10:00.001 si le
   compteur a tourné.
3. `14:10:00.000 < 14:10:00.001` → **vrai**. `pickNext` rend une tâche éligible,
   `runIteration` part pour une itération entière, hors de toute plage. Le
   démon n'a aucun minuteur sur la fin de plage (le seul `setTimeout` du démon
   est celui de `idle()`, `daemon.ts:165`, armé uniquement hors plage), et
   `signal` n'est levé que par `stop --now` ou l'arrêt du service
   (`daemon.ts:139-142`, `daemon.ts:320`).
4. Le tour suivant rejoue le même tirage : l'enchaînement n'a pas de borne de
   principe.

Attendu : la plage s'arrête à 13:00, le débordement se limite à l'itération
déjà commencée. Obtenu : une itération supplémentaire, complète (jusqu'à 3 h,
constat suivant), démarrée après la fermeture — et le résumé l'impute à la
plage avec `endedBecause: "window"` (`scheduler.ts:75`, jamais réécrit sur ce
chemin), donc rien dans le journal ne dit qu'elle a tourné hors plage.

Deux remarques sur la portée :

- `deps.shouldStop()` ne protège pas : il est consulté **dans** le corps
  (`scheduler.ts:84-87`), donc après la décision de rentrer dans le tour. Il ne
  sauve la mise que si un `stop` a été demandé.
- Une plage **manuelle** est immunisée : `manualUntil` est non-null (même
  passé), donc `ends` n'est pas vide et `deadline()` retourne un instant fixe —
  la comparaison redevient un vrai test.

La suite de tests ne peut pas voir ce défaut : son horloge simulée est figée
entre deux appels, elle n'avance que sur `tick()`/`sleep()`.

```ts
// src/scheduler.test.ts:29-37
function clock(start: number, iterMs: number) {
  let t = start;
  return { now: () => new Date(t), tick: () => (t += iterMs), sleep: async (ms) => void (t += ms) };
}
```

`now_1 === now_2` y est garanti, donc la condition est toujours fausse en fin
de plage. Le rapport 003 (`audit/003-quota-backoff.md:43`) suppose d'ailleurs
qu'avec `until()` valant `now` « la boucle sortira de toute façon au premier
tour » : c'est vrai dans les tests, pas sur l'horloge réelle.

## Une itération est démarrée sans exiger le moindre temps restant, et son plafond ignore la plage

**Gravité** : sûr
**Où** : `src/scheduler.ts:83` et `src/iterate.ts:129-132`

La seule porte avant de lancer une itération est `deps.now() < until()` : un
`<` strict, sans marge. Une milliseconde de plage restante suffit à engager une
itération. Et `iterate()` ne reçoit jamais la fin de plage — `IterateOptions`
porte `dryRun`, `print`, `signal`, `deps` et rien d'autre
(`iterate.ts:33-39`). Son unique plafond temporel est absolu :

```ts
// src/iterate.ts:129-132
timer = setTimeout(() => {
  timedOut = true;
  deps.killContainer(container);
}, cfg.claude.timeoutMinutes * 60_000);
```

`claude.timeoutMinutes` vaut 180 par défaut (`config.ts:19`) et 180 dans la
config livrée. Le débordement maximal est donc de 3 h, **indépendamment de la
longueur de la plage** : pour toute plage plus courte que `timeoutMinutes`,
l'heure de fin annoncée ne borne plus rien.

Scénario concret. `unused start --for 10m` — accepté tel quel
(`api.ts:63-64` → `parseDuration`, qui prend n'importe quelle durée positive,
`duration.ts:4-17`). Le démon appelle `runWindow` avec `deadline = now + 10m`
(`daemon.ts:192-204`), le premier tour passe la porte à t=0, et
`runIteration` part sur une session `claude -p` d'une tâche infinie — ce que ce
projet fait tourner par construction (README : « tâches infinies »). Personne
ne la raccourcit : ni le scheduler (il `await` ligne 98), ni `iterate()` (son
minuteur est à 180 min). La session est tuée à t+180 min.

Résultat : une plage de 10 minutes a occupé la machine et consommé du quota
pendant 3 h, soit 18 fois la durée demandée. Attendu : la plage demandée borne
le travail, ou au minimum le démon refuse d'engager une itération qu'il ne peut
pas finir dans la plage.

Le débordement est en outre perdu sèchement quand c'est le plafond qui tranche.
`timedOut` donne `outcome = { kind: "failure", reason: "timeout" }`
(`iterate.ts:157`), et une issue non-`completed` jette tout :

```ts
// src/iterate.ts:184-187
} else {
  await deps.discardContainer(r.container);
  await rm(donePath, { force: true });
}
```

Les 2 h 50 passées hors plage ne laissent donc ni commit ni avancée de curseur
— seulement un `consecutiveFailures += 1` (`graph.ts:97`). Trois plages courtes
de suite suffisent à atteindre `maxConsecutiveFailures` (3 dans la config
livrée) et à sortir la tâche de la file en `status: "failed"`
(`graph.ts:98-101`), alors que la seule chose qui lui a manqué est du temps que
la plage ne contenait pas.

Le docstring de `runWindow` annonce le principe (« Une itération commencée
avant la fin de la plage va jusqu'au bout », `scheduler.ts:49-50`), mais rien
dans le code ni dans la config ne borne ce dépassement relativement à la plage :
pas de marge minimale avant d'engager un tour, pas de plafond de session dérivé
du temps restant.

## Ce qui a été vérifié et tient

- **Les attentes, elles, sont bien bornées par la plage.** Le backoff quota
  (`scheduler.ts:115`) et le délai de retry (`scheduler.ts:133`) sont tous deux
  clampés par `until() - now`, et un reste négatif ou nul ne dort pas
  (`wait <= 0` / `wait > 0`). Aucune attente ne déborde la plage ; seules les
  itérations le font.
- **Pas de boucle chaude après la fermeture.** Sur le tour supplémentaire du
  constat 1, la branche backoff sort du `switch` sans dormir, mais chaque tour
  passe par une itération réelle (démarrage de container) : il n'y a pas de
  rotation sans travail.
- **Pas de plage concurrente pendant le débordement.** `run()`
  (`daemon.ts:145-154`) `await` `execute()`, et `startWindow` refuse tant que
  `this.running` est posé (`daemon.ts:285`) — l'incohérence est que `status`
  annonce 0 ms restantes pendant ce refus, ce qui est déjà couvert par
  `audit/002-pause-plages-auto.md` (source basculée en `manual`, `0s
  restantes`, `endedBecause: "window"` au lieu de `"stopped"`).
- **`state.window.until` figé** à la valeur du premier tour (`scheduler.ts:78`)
  alors que `until()` est réévalué : déjà rapporté
  (`audit/004-reprise-plage-redemarrage.md`, `audit/007-calendar-heure-locale-fusion.md`).
- **Fusion des plages calendrier** : deux occurrences qui ne se touchent pas ne
  sont pas fusionnées par `coverageEnd` (`calendar.ts:64`, `s.start <= end`),
  donc une plage 06:00-07:00 suivie d'une 08:00-09:00 reste bien deux plages ;
  si le débordement de la première traverse la seconde, celle-ci est absorbée
  sans être annoncée — conséquence des deux constats ci-dessus, pas un défaut
  distinct de `calendar.ts`.
