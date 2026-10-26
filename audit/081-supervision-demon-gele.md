# 081 — Supervision : un démon gelé ou en boucle de redémarrage n'a aucun moyen d'être signalé

**Fichiers examinés** : `deploy/unused.service:1-26` (intégralité, relu sous le
seul angle de la détection de panne), `deploy/install.sh:64-78`,
`src/cli.ts:35-64` (l'action `daemon`, l'ordre `init`/`listen`/gestionnaires de
signaux) et `:178-181`, `src/api.ts:54-59,128-155` (`GET /status`, `probe`,
`listen`), `src/daemon.ts:15-38` (`DaemonStatus`), `:96-175` (`init`, `deadline`,
`run`, `idle`), `:177-250` (`execute`, `pauseUntil`), `:328-373` (`status`),
`src/scheduler.ts:56-156`, `src/iterate.ts:116-143` (armement/désarmement du
timer de session), `src/docker.ts:28-59`, `src/duration.ts:19-27`,
`unused.config.json`, `package.json`. Recherche d'un battement de cœur côté
code : `grep -rn "NOTIFY_SOCKET\|sd_notify\|notify" src/ package.json` ne rend
rien. Rapports antérieurs relus avant d'écrire : 001, 004, 010, 017, 023, 024,
029, 047, 055, 059, 063, 065, 066, 070, 071.

Ce container n'a ni `systemd`, ni `node`, ni `docker` (`which systemctl node
npm docker` ne rend rien) : aucun scénario n'a pu être exécuté. Le constat
ci-dessous repose sur le fichier d'unité, sur la sémantique documentée de
systemd et sur une arithmétique élémentaire.

**Verdict** : 1 constat (sûr). Les deux moitiés de l'angle — le démon *gelé* et
la *boucle de redémarrage* — sont, en tant que défauts du code, déjà rapportées
(055 et 001 pour le gel, 047, 024, 066, 010 et 017 pour la boucle). Ce qui
n'avait jamais été examiné, et qui est l'objet de ce rapport, est l'étage
au-dessus : ce que le système d'exploitation fait de ces deux états. La réponse
est : rien, et il ne *peut* rien faire, par construction du fichier d'unité et
par absence de tout battement de cœur dans le code. La dernière section fait la
carte de ce qui est déjà écrit ailleurs.

## `Restart=always` + `RestartSec=5` : l'unité ne peut jamais devenir `failed`, et aucun autre canal ne peut signaler la panne

**Gravité** : sûr
**Où** : `deploy/unused.service:11-23`

```ini
[Service]
Type=simple
…
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=60
```

Quatre absences dans ce bloc, dont la combinaison est le constat :
`WatchdogSec=` (aucune détection de gel), `Type=notify` (aucun battement de
cœur possible), `OnFailure=` (aucune action sur panne) et `StartLimitBurst=` /
`StartLimitIntervalSec=` en `[Unit]` (aucun garde-fou explicite sur la boucle).

**1. La boucle de redémarrage n'a pas de fin, parce que `RestartSec=5` désarme
le seul compteur qui aurait pu l'arrêter.**

systemd limite les démarrages par `StartLimitIntervalSec` / `StartLimitBurst`,
qui valent par défaut `DefaultStartLimitIntervalSec=10s` et
`DefaultStartLimitBurst=5` (`systemd-system.conf`) ; l'unité ne les redéfinit
pas. La règle est « plus de *burst* démarrages dans l'intervalle ⇒ l'unité
passe `failed` (`start request repeated too quickly`) ». Avec `RestartSec=5` et
un échec quasi instantané, les démarrages tombent à t, t+5, t+10, t+15… :
**trois au plus dans n'importe quelle fenêtre de 10 s**, pour un seuil de cinq.
Le plafond n'est jamais atteint — il faudrait un intervalle inférieur à 2,5 s
entre deux démarrages, soit `RestartSec` ≤ 2. Le défaut de systemd,
`RestartSec=100ms`, aurait fait tomber l'unité en `failed` en une demi-seconde ;
la valeur explicite choisie ici, plus douce, supprime l'arrêt automatique.

Conséquence : une panne de démarrage déterministe — carte SD passée en lecture
seule (047), `.env` absent (024, l'unité n'atteint même pas `ExecStart`),
`unused.config.json` avec des marqueurs de conflit (066), `data/` inexistant
(010) — produit **12 démarrages par minute, 720 par heure, 17 280 par jour,
indéfiniment**, et l'unité reste dans le cycle `activating (auto-restart)` →
`active (running)` → `auto-restart`. `Type=simple` (`:12`) la déclare `active`
dès le `fork`, avant `init()` et avant `listen()` : pendant la plus grande part
de chaque cycle de 5 s, `systemctl status unused` affiche
**`active (running)`**.

Il n'existe alors aucun canal pour l'apprendre :

- l'unité n'étant jamais `failed`, `systemctl is-failed unused`,
  `systemctl --failed`, un `OnFailure=` (absent de toute façon) et toute
  supervision branchée sur l'état d'unité (`node_exporter`
  `node_systemd_unit_state{state="failed"}`, `check_systemd`…) ne voient rien,
  jamais ;
- `install.sh:67-75` ne voit rien non plus : `systemctl start`/`restart` rendent
  0 dès l'`exec` avec `Type=simple`, le script annonce « service démarré » et le
  code de retour du `systemctl status` final est jeté par `|| true` (déjà
  relevé en 024 et 066 pour l'installation ; ici c'est le même aveuglement qui
  dure ensuite indéfiniment) ;
- `unused status` dit la vérité (« le démon n'est pas lancé », `client.ts:13-16`)
  mais c'est précisément le canal qui exige qu'un humain le tape, et le socket
  n'existe de toute façon que la fraction de seconde qui sépare `listen` du
  rejet (047) ;
- la seule trace est le `Scheduled restart job, restart counter is at N` de
  journald, sur la carte SD qui est justement la cause probable.

**Obtenu** : un service qui redémarre 17 280 fois par jour est rapporté par le
système comme un service en bonne santé, pour une durée bornée seulement par la
curiosité de l'opérateur. **Attendu** : au bout de N tentatives, l'unité passe
`failed` et le reste — c'est exactement ce que 066 lui prête
(« `Restart=always` / `RestartSec=5` le relance jusqu'à ce que systemd le
déclare `failed` », 066, troisième constat) et ce qui est faux avec ces
réglages. `StartLimitBurst=5` / `StartLimitIntervalSec=120` en `[Unit]`
rendraient cette phrase vraie.

Le seul chemin par lequel cette unité peut atteindre `failed` est extérieur au
démon : l'échec du *job* de démarrage, c'est-à-dire `Requires=docker.service`
(`:9`) qui ne démarre pas — `Restart=` ne s'applique pas à un job de démarrage
échoué. L'unité peut donc être `failed` pour une raison Docker, mais jamais
pour une défaillance du démon lui-même.

**2. Le gel, lui, n'est pas détectable du tout — et pas seulement à cause de
l'unité.**

`Restart=` ne réagit qu'à la *sortie* du processus. Un démon gelé ne sort pas :
le gel du `docker commit`/`docker export` de la phase post-session (055,
deuxième constat) et celui du `docker image inspect` de `resolveTaskImage` (001,
premier constat) laissent le processus vivant, l'event loop libre, l'API
répondante, et `runWindow` bloqué sur un `await` sans borne. `Restart=always`
ne jouera jamais. Le seul mécanisme systemd qui verrait cet état est
`WatchdogSec=`, et il exige `Type=notify` plus un `sd_notify(WATCHDOG=1)`
périodique **dans le code** : `grep -rn "NOTIFY_SOCKET\|sd_notify" src/
package.json` ne rend rien, et `package.json` ne dépend d'aucune bibliothèque
sd-notify. Ajouter `WatchdogSec=` au fichier d'unité tel quel ne ferait donc
pas détecter le gel, cela tuerait le démon sain au premier intervalle : le
défaut n'est pas réparable dans `deploy/` seul.

Le produit n'offre pas davantage de quoi bâtir une sonde externe.
`DaemonStatus` (`daemon.ts:15-38`) ne porte que `daemon: { pid, startedAt }` :
aucun instant de dernier tour de boucle, aucun « dernière itération terminée
à », aucun compteur de redémarrages. Les deux seuls indices sont indirects et
muets :

- `window.current.at` (`daemon.ts:255`) n'est effacé qu'à l'événement
  `iteration-end`, émis après le retour de `runIteration`
  (`scheduler.ts:98-99`) : pendant un gel, `status` affiche indéfiniment
  `en cours <tâche>/<nœud> depuis <date>` (`cli.ts:101`). Avec le
  `timeoutMinutes: 180` livré (`unused.config.json:12`), une itération vieille
  de trois heures est un cas **normal** : une sonde qui alerterait au-delà d'un
  seuil crédible devrait attendre plus de 3 h, et au-delà de 3 h le chemin
  nominal n'arrange rien, le `docker kill` du timer étant tiré sans accusé de
  réception (001, troisième constat) ;
- `window.remainingMs` est écrêté à zéro (`daemon.ts:339`,
  `Math.max(0, until - now)`) et `formatDuration(0)` rend `"0s"`
  (`duration.ts:19-26`) : la ligne de `status` finit par afficher
  `plage calendar, jusqu'à … (0s restantes)` avec `stopping: false`. C'est le
  signal de gel le plus net que le produit émette, et il demande un humain pour
  le lire.

## Ce qui a été vérifié et tient

- **Carte de l'angle, pour ne pas y revenir.** Gel : non-interruptibilité et
  absence de borne de la phase post-session (055, constats 1 et 2), fenêtre
  d'avant `onStart` et `docker kill` sans accusé de réception (001, constats 1
  et 3), `stop`/`stop --now` qui mentent pendant un gel (055, 065 constat 2),
  attentes non interruptibles (003, 063). Boucle de redémarrage : EROFS et le
  `catch` d'`execute` (047), `.env` absent (024), config en conflit (066),
  `dataDir` absent (010), `saveState` concurrents (017), `init()` qui écrit
  avant `listen()` (004, 070). « Actif mais ne fait rien » sans gel ni boucle :
  panne globale jamais persistée et calendrier éteint (023), `systemctl stop
  docker` qui emporte l'unité sans la rendre (071), réveil calendaire figé après
  un saut d'horloge (029). Surface de `status` (065), double démon via `probe`
  (010 constat 2, 059).
- **Pas de boucle chaude dans la boucle principale** (vérifié parce qu'un « 100 %
  CPU, service actif » serait la troisième forme du même angle) : les deux
  chemins par lesquels `execute()` peut rendre la main immédiatement se
  terminent en `idle()`, jamais en `continue`. Sans calendrier
  (`windows: []`), `nothing-eligible` → `pauseUntil` sort dès sa première ligne
  (`daemon.ts:231`), le `finally` met `this.manual = null` (`:223`), et
  `deadline(null)` rend `now` → `idle()` sans minuterie, en attente de `wake`.
  Avec calendrier, `pauseUntil` écrit `pausedUntil`, `calendarEnd` rend alors
  `null` (`:125-126`) et `idle()` arme la minuterie du prochain début. Dans les
  deux cas la boucle `run()` ne tourne qu'une fois.
- **`remainingMs` n'est pas négatif** pendant un gel, contrairement à ce
  qu'indique le dernier point du deuxième constat de 055 : `daemon.ts:339`
  l'écrête à 0 et `formatDuration` écrête une seconde fois
  (`duration.ts:20`). Le reste de ce constat tient tel quel.
- **Un arrêt délibéré n'est pas ressuscité par `Restart=always`** : `systemctl
  stop` est un job d'arrêt (SIGTERM une fois, puis SIGKILL à
  `TimeoutStopSec`), et `Restart=` ne rejoue pas un processus arrêté par un
  job. Le `process.exit(130)` du second signal (`cli.ts:52`) n'est donc pas
  atteignable par systemd en usage normal. Nuance relevée au passage, sans
  conséquence démontrable : `systemctl kill unused` n'est **pas** un job
  d'arrêt — le démon s'y arrête proprement, sort 0, et `Restart=always` le
  relance 5 s plus tard, qui reprend la plage enregistrée (`daemon.ts:98-102`).
  C'est le sens littéral de `always` ; je ne le compte pas en constat.
- **Les gestionnaires de signaux sont posés après `init()` et `listen()`**
  (`cli.ts:42-57`) : un SIGTERM dans cette fenêtre (jusqu'à 2 s, le `timeout`
  du `probe`, `api.ts:130`) tue le processus par la disposition par défaut,
  sans passer par `ac.abort()`. Cherché puis écarté comme constat : à cet
  instant aucune itération ne tourne, `state.json` n'est écrit que par la
  branche « plage expirée » d'`init()` (`daemon.ts:103-107`), et systemd compte
  cette mort comme un arrêt réussi. Rien de faux n'est produit ni annoncé.
- **`GET /status` ne peut pas, lui, se bloquer sur Docker** : `daemon.status()`
  (`daemon.ts:328-373`) ne lit que `loadTasks` et de l'état en mémoire, aucun
  appel `docker`. Un gel de `dockerd` laisse donc bien l'API répondante — c'est
  ce qui rend le gel silencieux plutôt que visible.
