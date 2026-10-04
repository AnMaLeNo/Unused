# 036 — Lignée des images de tâche (`resolveTaskImage`, `flattenTask`, le socle)

**Fichiers examinés** : `src/docker.ts:78-80` (`imageExists`), `src/docker.ts:82-93`
(`buildBase`), `src/docker.ts:95-105` (`taskImage`, `resolveTaskImage`),
`src/docker.ts:126-150` (`runInTask`), `src/docker.ts:156-185` (`layerCount`,
`commitTask`, `pruneTask`), `src/docker.ts:195-248` (`importChanges`,
`flattenTask`, `pipeExportImport`), `src/docker.ts:250-254`
(`removeTaskImages`), `src/iterate.ts:168-199`, `src/daemon.ts:285-297,
395-407`, `src/dockerCheck.ts:36-111`, `src/cli.ts:162-178`, `src/api.ts:97-110`,
`src/config.ts:22-29`, `unused.config.json:12-17`, `docker/Dockerfile`,
`deploy/install.sh`, `deploy/unused.service`, `src/docker.test.ts`, `README.md:43,70,135`.

**Verdict** : 3 constats (0 sûr, 3 probables)

Le fil conducteur : la lignée d'une tâche est un graphe de tags sans aucune
métadonnée. Deux tags (`:latest`, `:prev`), un label, et une seule question
posée à Docker avant chaque itération — « est-ce que `:latest` répond ? »
(`docker.ts:104`). Personne ne sait de quel socle une image descend, personne ne
compare, et la réponse « non » est traitée comme « cette tâche est neuve ».

## Un `:latest` qui ne répond pas fait repartir la tâche du socle, puis le commit et le `prune` effacent l'original

**Gravité** : probable
**Où** : `src/docker.ts:78-80` et `src/docker.ts:102-105`, puis
`src/docker.ts:166-185`

`imageExists` réduit n'importe quel code de sortie non nul à « absente » :

```ts
// src/docker.ts:78-80
export async function imageExists(image: string): Promise<boolean> {
  return (await docker(["image", "inspect", image])).code === 0;
}

// src/docker.ts:102-105
export async function resolveTaskImage(cfg: Config, taskName: string): Promise<string> {
  const latest = `${taskImage(taskName)}:latest`;
  return (await imageExists(latest)) ? latest : cfg.docker.baseImage;
}
```

`docker image inspect` sort en 1 pour une image absente, mais aussi pour un
démon injoignable, un client mal configuré, ou une image présente mais que le
démon n'arrive pas à lire (métadonnées `overlay2` incohérentes après une
coupure de courant — la cible du projet est un Pi, `docker/Dockerfile:12`). Dans
tous ces cas, `runInTask` démarre sur `cfg.docker.baseImage` : container vierge,
sans `/work/repo`, sans l'historique accumulé.

Le plus grave n'est pas le repli, c'est la suite. Si la session se termine
quand même en `completed` (`iterate.ts:168`), `commitTask` s'exécute :

```ts
// src/docker.ts:166-180
if (await imageExists(`${name}:latest`)) {                                    // → false
  await mustSucceed(["tag", `${name}:latest`, `${name}:prev`], "rotation…");   // ← SAUTÉE
}
await mustSucceed(["commit", …, container, `${name}:latest`], "commit…");      // le tag change d'image
await docker(["rm", container]);
…
await pruneTask(taskName);                                                     // image prune --filter label=…
```

La garde de la ligne 168 utilise la **même** fonction défaillante : la rotation
de sauvegarde est donc sautée exactement dans le cas où elle servirait. Le
`commit` déplace alors `:latest` vers l'image issue du socle, et la génération
réelle devient sans tag. `pruneTask` (`docker.ts:183-185`) supprime les images
sans tag portant `label=unused.task=<nom>` — ce que la génération réelle porte,
puisqu'elle a été produite par un `commit --change "LABEL unused.task=…"`. Elle
est **détruite**, pas seulement ignorée.

**Scénario concret.** Tâche `audit`, 40 itérations, `:latest` = génération 40,
`:prev` = génération 39. Coupure de courant sur le Pi ; au redémarrage le démon
Docker tourne mais ne sait plus lire la génération 40.

1. `resolveTaskImage` → `unused-base` ;
2. le nœud tourne dans un container vierge. Le skill `analyze` lit
   `tail -n 1 /work/ANALYZED.md`, fichier absent : selon le skill, sortie vide
   traitée comme un cas limite ou session en erreur. Rien n'oblige l'issue à
   être un échec — un nœud qui se contente d'écrire et de pousser se termine en
   `completed` ;
3. `commitTask` : pas de rotation, `:latest` = l'image vierge + le travail du
   nœud, génération 40 détaguée puis **prunée** ;
4. il reste `:prev` = génération 39, soit un sursis d'exactement une itération.
   Aucun code ne relit `:prev` (`grep -rn "prev" src/` : l'écriture
   `docker.ts:169`, le `rmi` `docker.ts:252`, une assertion de self-test
   `dockerCheck.ts:77` — déjà relevé en 005). L'itération suivante rote `:prev`
   sur l'image vierge, la génération 39 devient sans tag, le `prune` la
   supprime. Perte définitive.

Résultat obtenu : 41 itérations au compteur, curseur avancé, `unused status`
inchangé, et un espace de travail vide. Résultat attendu : une tâche dont
l'image existe mais est illisible est une panne (`fatal: docker`), pas une tâche
neuve — `iterate.ts:145` sait déjà traiter ce cas si `imageExists` levait au
lieu de répondre « non ».

Rien ne le signale non plus *a posteriori* : l'image réellement utilisée n'est
écrite que dans le JSON de l'itération (`iterate.ts:199`, `log.ts:14`) ; aucune
ligne de `print` ne la mentionne (`grep -n "image" src/iterate.ts src/scheduler.ts`),
donc ni `journalctl` ni `unused status` ne montrent qu'une tâche vient de
repartir du socle. Un `r.image !== attendu` suffirait à le dire.

Trigger déterministe connexe : avec une entrée `env` qui déplace la cible du
client (`DOCKER_HOST`), `resolveTaskImage` interroge un autre démon et répond
toujours « absente » — chemin décrit en 033, mais là le `commit` échoue aussi,
donc la chaîne destructrice ci-dessus ne se déclenche pas. C'est la raison du
« probable » : le chemin de code est certain, les déclencheurs d'un
`inspect` en échec avec un `run` qui réussit sont plausibles (image illisible,
client déplacé, démon qui revient entre les deux appels, à ~50 ms d'écart) mais
je n'en ai pas exhibé un reproductible à coup sûr.

## Un socle reconstruit n'atteint jamais une tâche déjà commitée, et les deux commandes qui l'annoncent affirment le contraire

**Gravité** : probable
**Où** : `src/docker.ts:104`, `src/cli.ts:164-178`, `src/dockerCheck.ts:42-50`

`resolveTaskImage` ne regarde le socle que si `:latest` est absent. Dès le
premier commit d'une tâche, `cfg.docker.baseImage` n'est plus jamais consulté
pour elle — pour toujours. Aucune comparaison d'ascendance n'existe dans `src/`
(rien ne lit `.RootFS.Layers` ni l'histoire d'une image en dehors de
`layerCount`, `docker.ts:156-159`), donc personne ne peut savoir qu'une image de
tâche descend d'un socle périmé.

Or le produit expose explicitement la reconstruction :

```
// src/cli.ts:164-172
const dockerCmd = program.command("docker").description("gérer l'image de base");
dockerCmd.command("build").description("(re)construit l'image de base")
dockerCmd.command("check").option("--rebuild", "reconstruit l'image de base même si elle existe", false)
```

`buildBase` (`docker.ts:84`) fait un `build -t <baseImage>` : le tag bascule sur
la nouvelle image, les tâches existantes continuent sur l'ancienne (qui reste
sur le disque, épinglée par leurs couches). La commande sort en succès et
n'évoque rien.

**Scénario concret.** Un skill échoue parce que `jq` manque dans le container.
L'opérateur ajoute `jq` à `docker/Dockerfile:9`, lance `unused docker build` :
le build défile, sort en 0. Il lance `unused docker check` : le self-test
supprime d'abord les images de sa tâche jetable (`dockerCheck.ts:50`), reconstruit
donc une lignée neuve **à partir du socle neuf**, valide run → commit → run →
rotation → aplatissement et imprime « Tout est en ordre » (`dockerCheck.ts:104`).
Résultat obtenu : les deux commandes disent oui, et l'itération suivante de la
vraie tâche échoue à l'identique, `jq` toujours absent. Résultat attendu : soit
`check` vérifie la lignée réellement utilisée par les tâches, soit `build`
prévient que les tâches existantes gardent l'ancien socle.

Aggravants vérifiés :
- la seule sortie est `unused tasks reset <nom>` (`daemon.ts:395-407`), qui
  appelle `removeTaskImages` : le socle neuf est bien adopté, au prix de la
  destruction de tout l'espace de travail et du curseur. Il n'existe aucune
  commande de rebase ;
- `deploy/install.sh` est annoncé « idempotent, relançable après chaque mise à
  jour du code » et ne reconstruit pas le socle : une mise à jour du dépôt qui
  touche `docker/Dockerfile` n'a aucun effet, même après redéploiement ;
- le socle est le seul endroit où le binaire Claude Code est installé
  (`Dockerfile:13`) et l'auto-update est coupé dans l'image
  (`Dockerfile:20`, `DISABLE_AUTOUPDATER=1`) : une tâche de longue durée reste
  figée sur la version installée le jour de son premier commit ;
- `startWindow` exige la présence du socle (`daemon.ts:291-293`) alors
  qu'aucune tâche déjà commitée ne l'utilisera : la seule garde liée aux images
  porte sur l'objet qui ne sert plus, et aucune ne porte sur les images qui
  servent.

## L'aplatissement détache la tâche du socle : copie intégrale du rootfs, au pire moment, sans aucune garde de disque

**Gravité** : probable
**Où** : `src/docker.ts:176-178` et `src/docker.ts:214-248`

`flattenTask` passe par `docker export | docker import` (`docker.ts:222`,
`228-248`). L'image produite a une seule couche, qui est un tarball complet du
rootfs : elle **ne partage plus aucune couche** avec `cfg.docker.baseImage`. Ce
que le socle apportait gratuitement (Debian + apt + le binaire Claude Code,
`Dockerfile:4-13`) est recopié en entier, par tâche aplatie. Avant
l'aplatissement, N tâches = socle partagé + N deltas ; après, N tâches = socle
(toujours requis, `daemon.ts:291`) + N copies intégrales.

Ce n'est pas un cas limite mais le régime permanent : `layerCount`
(`docker.ts:157`) compte **aussi** les couches du socle (`FROM` + les deux `RUN`
du Dockerfile = 3 couches de `RootFS`), le seuil livré est 30
(`unused.config.json:16`) et chaque itération ajoute une couche. Le
franchissement tombe donc vers la 28ᵉ itération d'une tâche — et le projet
existe pour faire tourner des tâches *infinies* chaque nuit. Toute tâche
sérieuse finit détachée du socle.

Le moment choisi est le pire possible. L'aplatissement est appelé **dans**
`commitTask`, entre le commit et le `prune` :

```ts
// src/docker.ts:176-179
if ((await layerCount(`${name}:latest`)) > cfg.docker.flattenAfterLayers) {
  await flattenTask(taskName);
}
await pruneTask(taskName);
```

Au moment du `docker import`, le disque porte simultanément : la chaîne du
socle, les ~28 couches de la génération précédente (toujours taguée `:prev`), la
couche du commit qui vient d'avoir lieu (`:latest`), et la copie intégrale en
cours d'écriture. Aucun `rmi` ne précède l'import, la récupération n'a lieu
qu'après, via `pruneTask`. Il faut donc avoir, à cet instant précis, l'espace
libre d'un rootfs complet — et c'est l'instant où un `ENOSPC` est le plus
destructeur, puisqu'un échec d'aplatissement fait reculer le curseur sur une
image déjà avancée (constat 1 de 005).

Rien ne borne ni ne surveille cela : `grep -rn "ENOSPC\|df \|espace" src/*.ts`
ne ramène que de la prose sur l'« espace de travail » (`task.ts:21`,
`scaffold.ts:52`) : aucune garde d'espace disque, aucun appel ne mesure la taille d'une
image (`docker.ts` n'utilise `image inspect` que pour l'existence, la config et
le nombre de couches), et le seul réglage offert est un **nombre de couches**,
grandeur sans rapport avec des octets : deux tâches au même compteur peuvent
peser 300 Mo et 30 Go. Baisser `flattenAfterLayers` n'aide pas (la copie
intégrale arrive plus tôt et plus souvent) ; le monter retarde le détachement
mais fait monter la pile de couches vers la limite Docker de 125.

Je classe en « probable » et non « sûr » : le mécanisme et l'absence de garde
sont vérifiés dans le code, mais je n'ai pas pu mesurer les tailles réelles
(pas de démon Docker dans ce container : `docker version` → `command not found`),
donc le moment où le disque du Pi cède reste une estimation.

## Ce qui a été vérifié et tient

- `pruneTask` ne peut pas détruire ce qui est tagué : `image prune` sans `-a` ne
  vise que les images sans tag, et le filtre `label=unused.task=<nom>` exclut le
  socle (le `Dockerfile` ne pose aucun label). Corollaire : un socle remplacé par
  `buildBase` reste sur le disque, hors de portée de `pruneTask`, et aucun
  `prune` global n'existe dans `src/` ni dans `deploy/` (pas de cron, pas de
  timer systemd).
- L'image aplatie conserve bien `LABEL unused.task` (`importChanges`,
  `docker.ts:209`, couvert par `docker.test.ts:12,21`), donc elle reste
  récupérable par `pruneTask` et `removeTaskImages` : le détachement du socle
  ne crée pas d'image orpheline invisible.
- `removeTaskImages` (`docker.ts:250-254`) supprime les deux tags puis prune :
  après un aplatissement, il ne reste rien de la tâche. Le `-f` couvre le cas
  où `:prev` et `:latest` pointent la même image.
- Le chaînage `:prev`/`:latest` est cohérent dans le chemin nominal (une
  génération de recul, pas plus) ; c'est son absence de relecture qui pose
  problème, déjà traitée en 005.
- `resolveTaskImage` ne lève pas quand `docker` est absent du `PATH` :
  `docker()` rejette (`docker.ts:44-50`), `runInTask` propage, et
  `iterate.ts:144-147` convertit en `fatal: docker`. Seul le code de sortie non
  nul est muet (constat 1).
- Déjà couvert ailleurs, non repris ici : l'atomicité de `commitTask` et le
  rollback absent (005, constat 1), `expCode === null` traité comme un succès et
  l'EPIPE non rattrapé de `pipeExportImport` (005, constats 2 et 3), le token
  scellé dans l'image par `docker commit` (019), la lignée héritée par un nom de
  tâche recyclé (008, 032), le `rmi` concurrent d'un `reset` (006), le socle
  reconstruit par un `check` pendant une plage (009).
