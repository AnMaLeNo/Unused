# 071 — Cycle de vie du service systemd : l'arrêt de Docker emporte le démon, rien ne le rend

**Fichiers examinés** : `deploy/unused.service:1-26` (intégralité),
`deploy/install.sh:64-78`, `src/cli.ts:35-64` (action `daemon`) et `:178-181`,
`src/daemon.ts:96-158` (`init`, `run`, `idle`), `src/daemon.ts:284-301`
(`startWindow`), `src/scheduler.ts:33-44` (`sleep`) et `:76-156` (`runWindow`),
`src/iterate.ts:28,110-147,184-189`, `src/api.ts:144-155` (`listen`),
`src/client.ts:13-18`, `README.md:35-45,111,126`.
Vérification par lecture et par la documentation systemd : ce conteneur n'a ni
`systemd` ni `node` (`which systemctl` et `node --version` : rien), aucun
scénario n'a pu être exécuté.

**Verdict** : 1 constat (sûr). Les autres angles de l'aspect — `EnvironmentFile`
sans `-`, boucle de redémarrage sur panne de démarrage, rejet de `run()`,
containers survivant au SIGKILL, requêtes streamées coupées à l'arrêt — sont
déjà rapportés (024, 017, 070, 027, 010) ; rien de neuf n'a été trouvé dessus,
voir la dernière section.

## Un `systemctl stop docker` emporte `unused.service`, et personne ne le relance

**Gravité** : sûr
**Où** : `deploy/unused.service:9`

```ini
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
```

`Requires=` est une dépendance à sens unique avec propagation d'arrêt :
systemd documente que l'unité « sera arrêtée si l'une des autres unités est
explicitement arrêtée ». Trois propriétés se combinent ici, et aucune des trois
n'est contredite par le reste de l'unité :

1. `systemctl stop docker` (ou `stop docker.socket docker.service`) arrête
   `unused.service` par propagation. L'unité passe en `inactive (dead)`,
   **pas** en `failed` : c'est un job d'arrêt, pas une sortie anormale.
2. `Restart=always` / `RestartSec=5` (`:18-19`) ne s'applique pas : `Restart=`
   ne rejoue le processus que lorsqu'il s'arrête de lui-même, jamais lorsque
   l'unité a été arrêtée par un job d'arrêt.
3. `systemctl start docker` ne remonte rien : la dépendance est portée par
   `unused.service` vers `docker.service`, pas l'inverse. Démarrer `unused`
   démarre Docker ; démarrer Docker ne démarre pas `unused`.

Et rien d'autre dans le produit ne relance l'unité : `install.sh` fait
`systemctl enable` + `start` une seule fois (`install.sh:66-73`), et
`WantedBy=multi-user.target` (`:26`) ne joue qu'au démarrage machine. Le seul
retour possible est un `reboot` ou un `systemctl start unused` tapé à la main.

**Scénario concret.** Calendrier livré : une plage par semaine, lundi
00:00–13:00 (`unused.config.json`). Dimanche soir, l'opérateur libère de la
place sur la carte SD du Pi — la séquence usuelle, et celle que la lignée
d'images de tâches (036) rend nécessaire :

```
sudo systemctl stop docker          # ← unused.service s'arrête ici, par propagation
sudo rm -rf /var/lib/docker/tmp    # ou docker system prune après redémarrage, peu importe
sudo systemctl start docker         # Docker revient. unused, non.
```

1. `unused.service` : `inactive (dead)`, aucune ligne d'erreur dans le journal
   (« Stopping unused… », « Deactivated successfully »), `systemctl is-enabled`
   répond toujours `enabled`.
2. Lundi 00:00 : personne n'ouvre la plage. `data/state.json` n'est pas touché,
   les tâches ne bougent pas, aucun fichier dans `data/logs/` — le produit est
   silencieux, exactement comme une semaine sans plage prévue.
3. Toute commande cliente répond « le démon n'est pas lancé (socket …) :
   `systemctl start unused` ou `unused daemon` » (`src/client.ts:13-16`). Le
   message est juste, mais il faut aller le chercher : rien ne le pousse, et
   l'unité n'étant pas `failed`, un `OnFailure=` ou une supervision branchée sur
   l'échec d'unité ne verra jamais rien.

Résultat obtenu : une commande d'administration Docker de routine éteint
définitivement le seul processus qui consomme le quota, pour une durée bornée
seulement par le prochain redémarrage du Pi — soit, sur une machine dédiée qui
ne redémarre jamais, indéfiniment. Résultat attendu : le démon survit à une
indisponibilité de Docker, ou revient quand Docker revient.

**Ce que `Requires=` achète en échange : rien.** Le code est écrit pour tourner
sans Docker et pour le dire :

- `Daemon.init()` (`daemon.ts:96-113`) ne touche jamais à Docker ;
- `startWindow` vérifie `dockerVersion()` et refuse en 409 avec « Docker ne
  répond pas : … » (`daemon.ts:286-293`) ;
- une plage déjà ouverte tombe en `fatal: docker`, affiché en tête de `status`
  (`iterate.ts:158`, `daemon.ts:205-207`, `cli.ts:94`).

Un démon vivant avec Docker éteint est donc strictement plus utile qu'un démon
arrêté : son API répond et nomme la panne. Et le remplacement est sans perte
fonctionnelle, `Wants=` tirant l'unité au démarrage tout comme `Requires=` :

```ini
After=network-online.target docker.service
Wants=network-online.target docker.service
```

À noter pour la session suivante : le cas du `systemctl restart docker` (mise à
jour du paquet) est *un autre cas*, que je n'ai pas tranché. La page de manuel
de systemd parle d'arrêt « ou redémarrage » propagé, ce qui laisserait entendre
que `unused` serait redémarré — donc sauvé — et je ne peux pas l'exécuter ici.
Le cas de la mort *non* explicite de `docker.service` (plantage, OOM), lui, ne
propage rien (il faudrait `BindsTo=`) et dégénère en panne globale définitive :
c'est le constat 1 de 023.

## Ce qui a été vérifié et tient

- **Chemin d'arrêt propre, hors fenêtres déjà rapportées** : SIGTERM →
  `onSignal` → `ac.abort()` (`cli.ts:48-57`) → `run()` relaie l'abort à
  `running.ac` **et** réveille `idle()` (`daemon.ts:139-142`), la boucle sort
  sur `!signal.aborted`, le `finally` ferme le serveur. `sleep`
  (`scheduler.ts:33-44`) écoute l'abort : un arrêt pendant un backoff quota de
  plusieurs heures rend la main tout de suite, il ne consomme pas les 60 s de
  `TimeoutStopSec`. `KillMode=mixed` est le bon choix et le commentaire des
  lignes 20-21 décrit fidèlement le comportement.
- **Non-reprise volontaire de l'itération** : sur abort, `runWindow` laisse
  `state.window` en place sans réécrire l'état (`scheduler.ts:139-141`) et
  `iterate` saute son `saveState` (`iterate.ts:189`, `if (!aborted)`) ; `init()`
  reprend la plage au démarrage suivant (`daemon.ts:98-102`). Le message
  « l'itération en cours est jetée, la plage sera reprise au prochain
  démarrage » (`cli.ts:53`) est exact. Les décalages de *contenu* de cette
  reprise sont l'objet de 004 et 043.
- **Socket entre deux vies du service** : `listen()` sonde puis `unlink`
  (`api.ts:144-146`), donc un socket laissé par un SIGKILL ne bloque pas le
  démarrage suivant ; libuv retire le fichier à la fermeture propre.
- **Rejet de `run()` après l'ouverture du socket** : seul chemin trouvé, un
  `saveState` qui échoue dans `execute` (`daemon.ts:211,216,221`) ; il remonte
  au `catch` global (`cli.ts:178-181`), message sur stderr et `exit(1)`, puis
  `Restart=always`. Pas de rejet avalé, pas d'état incohérent publié — le
  « démon arrêté » du `finally` affiché avant le message d'erreur est trompeur
  mais sans conséquence. Les rejets *avant* le socket (config, `state.json`)
  sont couverts par 066, 017 et 070.
- **Angles déjà rapportés, revérifiés sans rien de neuf** :
  `EnvironmentFile=/opt/unused/.env` sans `-` bloquant alors que
  `cli.ts:20-21` + `iterate.ts:99-102` savent se passer du fichier (024,
  constat 1) ; boucle de redémarrage de 5 s sur toute panne de démarrage
  déterministe (017, constat final ; 066) ; container qui survit au SIGKILL de
  `TimeoutStopSec` et DONE croisé, sans aucun balayage au démarrage (027,
  constats 1-2 et 5) ; `server.close()` qui ne coupe pas un `docker build`
  streamé et annonce quand même « démon arrêté » (010) ; `init()` qui écrit
  `state.json` avant que `listen()` ait écarté un second démon (070).
