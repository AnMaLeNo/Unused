# 055 — Phase post-session : ni interruptible, ni bornée, face à `stop --now` et au SIGKILL à 60 s

**Fichiers examinés** : `src/iterate.ts:116-143` (l'armement du timer et de
`onAbort`, et leur désarmement), `src/iterate.ts:148-219` (toute la phase
post-session : `parseStream`, `commitTask`, `saveState`, `writeIterationLog`),
`src/docker.ts:28-68` (`docker`, `mustSucceed`), `src/docker.ts:152-197`
(`discardContainer`, `layerCount`, `commitTask`, `pruneTask`),
`src/docker.ts:214-248` (`flattenTask`, `pipeExportImport`),
`src/cli.ts:34-62` (le démon et son gestionnaire de signaux),
`src/cli.ts:77-83` (`stop --now`), `src/daemon.ts:137-158` (`run`, `onAbort`),
`src/daemon.ts:177-228` (`execute`), `src/daemon.ts:308-324` (`stopWindow`),
`src/scheduler.ts:55-150` (`runWindow`, la boucle et sa sortie),
`src/log.ts:42-67`, `deploy/unused.service` (entier),
`deploy/install.sh:60-75`, `unused.config.json:11,16`.

**Verdict** : 2 constats (1 sûr, 1 probable)

Angle de ce rapport : ce qui se passe **après** que `runInTask` a rendu la main,
quand un arrêt est demandé pendant cette phase. Les échecs *propres* de
`commitTask` (une `DockerError` levée et rattrapée) sont le sujet de 005 ; la
taille et le coût de l'aplatissement, celui de 036 ; le non-ramassage des
containers orphelins, celui de 001. Ici il s'agit d'une seule chose : la phase
post-session n'écoute aucun signal, n'a aucune borne de durée, et le système qui
l'héberge la tue sans sommation au bout de 60 secondes.

## Dès que `runInTask` a rendu la main, plus aucun arrêt n'atteint l'itération — et c'est précisément là que systemd envoie SIGKILL

**Gravité** : sûr
**Où** : `src/iterate.ts:140-143` (désarmement), `src/iterate.ts:148-219` (la
phase qui suit), `deploy/unused.service:22-23`, `src/cli.ts:49-57`

Toute la protection temporelle et toute l'écoute du signal d'arrêt vivent dans
le `.finally()` de la promesse `runInTask` — donc elles **meurent avec elle** :

```ts
// src/iterate.ts:140-143
}).finally(() => {
  clearTimeout(timer);                                            // la seule borne de durée
  if (onAbort) opts.signal?.removeEventListener("abort", onAbort); // la seule écoute de l'arrêt
});
```

À partir de cette ligne, `grep -n "signal\|aborted" src/iterate.ts` ne ramène
plus que des lectures de la variable `aborted` déjà figée (`:156`, `:162`,
`:165`, `:189`) : aucune des 70 lignes suivantes ne consulte `opts.signal`.
Et `docker()` n'accepte ni `timeout` ni `AbortSignal` (`src/docker.ts:28-33` :
`spawn` nu ; `grep -n "timeout\|signal" src/docker.ts` ne ramène qu'un
commentaire sur les montages). La phase post-session est donc, par
construction, ininterruptible :

| étape | ligne | durée |
|---|---|---|
| `parseStream(r.stdout)` | `:150` | proportionnelle au flux de la session |
| `tag :latest → :prev` | `docker.ts:168-170` | courte |
| `commit → :latest` | `docker.ts:171-175` | **l'image avance ici** |
| `layerCount` + éventuel `flattenTask` | `docker.ts:176-179` | `export \| import` du rootfs entier |
| `pruneTask` | `docker.ts:180` | variable |
| `saveState` | `:189` | courte |
| `writeIterationLog` | `:217` | courte |

Côté hôte, l'arrêt est pourtant sous contrainte dure :

```ini
# deploy/unused.service:21-23
KillMode=mixed
TimeoutStopSec=60
```

`KillMode=mixed` envoie SIGTERM au seul processus principal, puis, à
l'expiration de `TimeoutStopSec`, **SIGKILL à tout le cgroup** — y compris les
`docker commit` / `docker export` / `docker import` lancés par `spawn`. Or le
démon ne peut pas rendre la main avant la fin de la phase : `cli.ts:59` attend
`daemon.run`, qui attend `execute` (`daemon.ts:196-204`), qui attend `runWindow`,
qui attend `deps.runIteration` (`scheduler.ts:98`). `onAbort`
(`daemon.ts:139-142`) ne fait qu'`abort()` un `AbortController` que personne ne
regarde plus. Le démon a 60 secondes, et rien ne garantit qu'il les respecte.

**Scénario concret.** Configuration livrée : `flattenAfterLayers: 30`
(`unused.config.json:16`), donc vers la 28ᵉ itération d'une tâche
l'aplatissement se déclenche (compte établi en 036). L'opérateur déploie une
nouvelle version pendant la plage de nuit :

```sh
# deploy/install.sh:67-69 — aucun test d'itération en cours
if systemctl is-active --quiet unused; then
  systemctl restart unused
```

1. `t+0` : le nœud `analyze` se termine en `completed`. `applyOutcome` avance
   `ts.cursor` **en mémoire** (`:164-165`). Sur le disque, `state.json` désigne
   encore `analyze`.
2. `t+2 s` : `commitTask` rote `:prev`, commite `:latest` — l'image contient
   maintenant le rapport écrit par le nœud — puis entre dans `flattenTask` :
   `docker export | docker import` de tout le rootfs, sur la carte SD d'un Pi.
3. `t+10 s` : `systemctl restart`. SIGTERM. Le démon journalise
   `« arrêt (l'itération en cours est jetée, la plage sera reprise au prochain
   démarrage) »` (`cli.ts:53`) et `abort()` (`cli.ts:54`). L'aplatissement
   continue, imperturbable.
4. `t+70 s` : SIGKILL sur le cgroup. `saveState` (`:189`) n'a jamais été appelé,
   `writeIterationLog` (`:217`) non plus.

État résultant :

| | vu par le runner au redémarrage | réel |
|---|---|---|
| `state.json` → `cursor` | `analyze` (à faire) | le travail de `analyze` est dans `:latest` |
| `state.json` → `iterations` | N | N+1 itérations ont eu lieu |
| `logs/<tâche>/` et `logs/index.jsonl` | aucune trace | une session a tourné et consommé du quota |
| `:prev` | état d'avant `analyze` | idem, mais jamais relu (005) |

Au redémarrage (immédiat, `systemctl restart` relance le service ; la plage est
reprise par `daemon.init` puisque `state.window` est toujours là),
`resolveTaskImage` (`docker.ts:102-105`) renvoie `:latest` — l'image avancée — et
le runner relance `analyze` dessus. Pour ce dépôt : le skill relit
`tail -n 1 /work/ANALYZED.md`, y trouve la ligne 055 déjà inscrite, et réécrit
un second rapport 055 par-dessus le premier. L'invariant de `graph.ts:10-13`
(« une itération qui ne se termine pas en `completed` est réputée n'avoir jamais
eu lieu ») est violé — mais, contrairement au cas de 005, le code ne l'apprend
jamais : il n'y a ni exception, ni rollback, ni journal ; rien, au démarrage, ne
compare l'image à l'état (`daemon.init` ne regarde que `state.window`).

Deux aggravations méritent d'être nommées :

- **La fenêtre d'exposition est maximale exactement là où elle est la plus
  longue.** L'image avance à `docker.ts:175`, l'état n'est persisté qu'à
  `iterate.ts:189`. Entre les deux se trouve l'opération la plus lente du
  projet, l'aplatissement intégral du rootfs. Les minutes pendant lesquelles un
  SIGKILL produit cette incohérence sont précisément les minutes de
  l'aplatissement.
- **Les deux messages d'arrêt sont faux.** `cli.ts:53` affirme que
  « l'itération en cours est jetée » : elle est en train d'être commitée.
  `stopWindow` (`daemon.ts:308-322`) répond `{ stopping: "now" }` dès l'`abort()`, et
  `cli.ts:81` imprime « plage arrêtée » — alors que le démon peut encore
  aplatir pendant plusieurs minutes. Si le SIGKILL n'arrive pas (cas d'un
  `stop --now` sans arrêt de service), l'itération va jusqu'au bout, est
  commitée, comptée (`scheduler.ts:101`) et persistée (`iterate.ts:189`) après
  l'annonce de son abandon.

Le correctif demande deux choses absentes : plumber `opts.signal` (et un
timeout) jusqu'à `docker()` pour que la phase soit interruptible, et surtout
rendre le couple (image, état) récupérable — persister une intention *avant* le
commit, ou faire de l'avancée de l'état la dernière opération atomique. Aucun
`TimeoutStopSec` raisonnable ne suffira : l'aplatissement n'a pas de durée
bornée.

Le test le plus proche, `iterate.test.ts:167-175`, lève le signal **pendant** la
session : le faux `runInTask` appelle `opts.onStart("ctn")`
(`iterate.test.ts:34`) puis le script `abort()` avant de résoudre, ce qui
exerce le chemin `:138` puis `:133-136`. Aucun test ne lève le signal après que
`runInTask` a résolu — ce qui est cohérent : le listener est déjà retiré.

## Aucun des appels docker de la phase post-session n'a de timeout : un `dockerd` qui ne répond pas gèle l'itération, la plage et les deux formes de `stop`

**Gravité** : probable
**Où** : `src/docker.ts:28-33`, `src/iterate.ts:141`, `src/scheduler.ts:83-85`,
`src/daemon.ts:139-142`

Le seul garde-fou temporel de l'itération est le timer de session :

```ts
// src/iterate.ts:129-132
timer = setTimeout(() => {
  timedOut = true;
  deps.killContainer(container);
}, cfg.claude.timeoutMinutes * 60_000);
```

Il est `clearTimeout`é à `:141`, et il ne visait de toute façon que le container
(`killContainer` = `docker kill <container>`, `iterate.ts:28`) : il n'aurait rien
pu faire contre un `docker commit` qui ne rend pas la main. Après `:141`, aucune
borne : `docker()` fait un `spawn` et ne résout que sur `close`
(`docker.ts:51-57`), sans `timeout`, sans `AbortSignal`, sans `kill`.

Conséquence en chaîne si un appel de la phase post-session reste suspendu
(`dockerd` figé après un OOM, I/O de carte SD bloquée — le matériel cible est un
Pi, `docker/Dockerfile:12`) :

- `iterate` ne retourne pas → `scheduler.ts:98` attend indéfiniment ;
- la boucle `while (!signal.aborted && deps.now() < until())`
  (`scheduler.ts:83`) ne réévalue jamais sa condition : **la fin de plage est
  ignorée** ;
- `deps.shouldStop()` (`scheduler.ts:84`) n'est testé qu'en tête de boucle :
  `unused stop` (sans `--now`) répond « arrêt demandé : la plage s'arrêtera
  après l'itération en cours » et n'arrivera jamais ;
- `unused stop --now` répond « plage arrêtée » (`daemon.ts:318-321`, `cli.ts:81`) après un `abort()` que plus personne n'écoute : rien ne s'arrête ;
- `unused status` continue d'afficher `en cours <tâche>/<nœud> depuis <date>`
  (`cli.ts:101`) — `run.current` n'est effacé qu'à l'événement
  `iteration-end`, émis après le retour de `runIteration` (`scheduler.ts:99`) —
  avec une plage dont le `until` est depuis longtemps dépassé et un
  `remainingMs` négatif.

Le démon reste donc vivant, se déclare occupé, refuse de s'arrêter, et ne fait
rien. Seul `systemctl stop/restart` en sort — par le SIGKILL du constat
précédent, avec les mêmes dégâts.

Je classe en « probable » et non « sûr » : l'absence totale de borne est
vérifiée dans le code (aucun `timeout` ni signal de `docker.ts:28` à
`docker.ts:68`, aucune réévaluation de la deadline pendant une itération), mais
le déclencheur est un blocage de `dockerd` que je ne peux pas reproduire ici
(`which docker` → absent de ce container).

## Ce qui a été vérifié et tient

- **Le chemin d'arrêt pendant la session est correct.** Un `abort()` reçu
  pendant `runInTask` passe par `onAbort` (`:133-136`), tue le container,
  produit `outcome = failure/aborted` (`:156`), ne touche ni au curseur
  (`:162-165`) ni à `state.json` (`:189`), jette le container et le `DONE`
  (`:184-187`), et `runWindow` sort sans effacer `state.window`
  (`scheduler.ts:141-143`) pour que la plage soit reprise. L'itération est bien
  « réputée n'avoir jamais eu lieu ».
- **Le double signal est géré** : un second SIGINT/SIGTERM force la sortie
  (`cli.ts:51-52`, `process.exit(130)`), ce qui est le seul moyen offert à
  l'opérateur d'écourter la phase post-session — au prix exact du constat 1.
- **Pas de double sauvegarde incohérente après un abort tardif** : si l'abort
  tombe pendant la phase post-session, `iterate` persiste l'état (`:189`), et le
  `saveState` final de `runWindow` est volontairement sauté
  (`scheduler.ts:141-149`) ; `execute` efface ensuite `state.window` pour un
  arrêt explicite (`daemon.ts:219-223`). Les trois écritures ne se contredisent
  pas.
- **Les containers laissés par un SIGKILL** (le container de session non encore
  `rm`, le `unused-flatten-<tâche>-<ts>` dont le `finally` de
  `docker.ts:221-225` n'a pas tourné) ne sont ramassés par rien au démarrage —
  constat déjà porté par 001 ; je ne le recompte pas ici.
- `writeIterationLog` (`log.ts:42-67`) écrit le fichier d'itération puis appende
  `index.jsonl` : non atomique entre les deux, mais sur ce chemin un SIGKILL ne
  produit qu'une absence de ligne d'index, pas une ligne fausse.
