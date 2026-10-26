# 079 — Sauvegarde et restauration : deux magasins disjoints, rien ne les lie ni ne les exporte

**Fichiers examinés** : `src/state.ts` (entier : schéma persistant,
`emptyState`, `initialTaskState`, `ensureTaskState`, `loadState`, `saveState`),
`src/docker.ts:95-105` (`LABEL`, `taskImage`, `resolveTaskImage`),
`src/docker.ts:161-185` (`commitTask`, `pruneTask`), `src/docker.ts:250-254`
(`removeTaskImages`), `src/docker.ts:195-226` (`importChanges`, `flattenTask`),
`src/daemon.ts:96-113` (`init`), `src/daemon.ts:284-301` (`startWindow`),
`src/daemon.ts:328-407` (`status`, `taskInfo`, `findTask`, `resetTask`),
`src/daemon.ts:409-418` (`setActive`, seul écrivain de `task.json`),
`src/graph.ts:64-111` (`applyOutcome`, `isEligible`), `src/iterate.ts:108-110`
(effacement de `DONE`), `src/iterate.ts:166-190` (commit puis `saveState`),
`src/log.ts:7-35,41-68` (`IterationRecord`, `index.jsonl`),
`src/scheduler.ts:77-79,141-149` (les deux `saveState` de la plage),
`src/scaffold.ts:5-14,42-64,66-86` (`task.json` livré, skills `setup` et
`work`), `src/config.ts:51-72`, `src/docker.test.ts`, `deploy/install.sh:1-50`,
`deploy/unused.service`, `.gitignore`, `README.md:26-45,113-128`,
`unused.config.json`.

**Verdict** : 2 constats (1 sûr, 1 probable)

Note de méthode : ce container n'a ni `node`, ni `npm`, ni `docker`, ni
`node_modules` (`which node docker npm` ne rend rien, `ls node_modules` échoue).
Tout ce qui suit est établi par lecture, en suivant les valeurs d'un appel à
l'autre. Les numéros de ligne sont ceux de la branche `audit`.

Le cadre de l'angle, et ce qui est déjà couvert. L'état d'une tâche est bien
réparti sur deux magasins qu'aucun code ne rapproche : `data/state.json`
(curseur, compteurs, `status`, file) et l'image `unused-task-<nom>:latest` (le
travail lui-même). Les mécanismes de divergence *en fonctionnement* sont déjà
rapportés et ne sont pas repris ici : image avancée pendant que le curseur
recule (005, constat 1), `:latest` absent traité comme « tâche neuve » (036,
constat 1), nom de tâche recyclé et dossier supprimé (032, constats 1 et 3),
`reset` qui annonce « image supprimée » sans vérifier (006 et 027, constat 3),
`state.json` corrompu sans chemin de réparation (017, constat 2), journaux non
réconciliés avec l'état (064, 047 constat 2). Ce rapport traite la moitié non
examinée : ce qui se passe quand l'un des deux magasins est **perdu ou restauré
sans l'autre**, c'est-à-dire le cycle de vie normal d'un déploiement.

## 1. Perdre `data/state.json` est indistinguable d'un premier démarrage, alors que l'image, elle, est intacte : une tâche terminée reprend du travail sur son résultat livré

**Gravité** : sûr
**Où** : `src/state.ts:67` et `src/state.ts:38-44`, `src/daemon.ts:96-113`,
`src/graph.ts:108-111`, `src/docker.ts:102-105`, `src/iterate.ts:110`

Deux faits, vérifiés séparément, se combinent mal.

**a) L'absence du fichier d'état est silencieuse et signifie « rien n'a jamais
tourné ».**

```ts
// state.ts:61-69
export async function loadState(dataDir: string): Promise<RunnerState> {
  const file = path.join(dataDir, STATE_FILE);
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
```

`init()` (`daemon.ts:96-113`) n'imprime rien dans ce cas : ses deux seules
lignes concernent la plage enregistrée et le calendrier. Un démon qui démarre
sur `emptyState()` est, dans le journal, identique à un démon qui reprend un
état complet.

**b) Le seul endroit où est écrit qu'une tâche est terminée, c'est ce
fichier.** `applyOutcome` pose `ts.status = "done"` (`graph.ts:85-88`) dans
`state.tasks`. Rien ne le reporte dans `task.json` : le seul écrivain de ce
fichier est `setActive` (`daemon.ts:410-418`, confirmé par
`grep -rn "writeFile" src/*.ts`), appelé uniquement par
`POST /tasks/<n>/active`. Une tâche qui a produit `DONE` garde donc
`"active": true` sur le disque pour toujours. Et `isEligible` ne connaît que
l'état :

```ts
// graph.ts:108-111
export function isEligible(task: Task, state: RunnerState): boolean {
  const ts = state.tasks[task.name];
  return task.def.active && (ts === undefined || ts.status === "running");
}
```

`ts === undefined` → **éligible**. Côté Docker, rien n'a bougé :
`resolveTaskImage` (`docker.ts:102-105`) répond `unused-task-<nom>:latest`,
soit la génération finale de la tâche terminée.

**Déclencheurs, tous déterministes.** Aucun n'est hypothétique, et aucun ne
demande de corruption :

1. La réparation d'un `state.json` invalide. C'est le remède que décrit 017
   (constat 2) : supprimer le fichier à la main, faute de toute autre porte de
   sortie — les onze commandes de la CLI passent par le socket, qui n'est pas
   créé.
2. Un redéploiement par clone neuf. `README.md:29` installe le produit par
   `git clone … /opt/unused`, et `.gitignore:1-7` met `data/` hors du dépôt :
   un clone ne contient *jamais* l'état. `install.sh:39` fait `mkdir -p data
   tasks` puis démarre le service (`install.sh:64-73`), donc le démon repart sur
   un `data/` vide sans qu'une seule ligne le signale. Les images, elles, sont
   dans `/var/lib/docker` : un redéploiement du code ne les touche pas.
3. La restauration d'une sauvegarde de `data/` plus ancienne que les images —
   le cas ordinaire, puisque `state.json` n'est **nommé nulle part** dans la
   documentation (`grep -rn "state.json" README.md deploy/` → 0 occurrence) :
   l'opérateur ne peut pas savoir qu'il faut le prendre, ni le prendre en même
   temps que l'image (constat 2).

Et la reprise n'attend pas l'opérateur : `unused.config.json` est versionné
(déjà noté en 066) et livre une plage automatique (`windows`, lundi 00:00→13:00),
donc après un redéploiement le démon se remet au travail tout seul.

**Scénario concret.** Tâche `revue` bâtie sur le squelette livré
(`scaffold.ts:5-14` : `start: "setup"`, `setup → work → work`), 40 itérations,
terminée la semaine dernière par un `DONE` : `state.tasks.revue = {cursor:
"work", status: "done", iterations: 40}`, `tasks/revue/task.json` toujours
`"active": true`, `unused-task-revue:latest` = le dépôt cloné, `/work/PLAN.md`
toutes cases cochées, `/work/JOURNAL.md` de 40 sessions.

L'opérateur migre le service sur une nouvelle carte SD (ou redéploie par clone,
ou répare un `state.json` corrompu). Il restaure `tasks/` — la seule chose dont
il sait qu'elle lui appartient (`.gitignore:5-8` : « Les tâches sont
personnelles ») — et relance `install.sh`. Les images sont restées (ou ont été
restaurées par `docker load`, c'est le même résultat). Puis :

1. `loadState` → `emptyState()`, sans un mot (`state.ts:67`, `daemon.ts:97`) ;
2. la plage automatique du dépôt s'ouvre, `pickNext` retient `revue`
   (`active: true`, `ts === undefined`, `graph.ts:110`) ;
3. `ensureTaskState` crée `{cursor: "setup", status: "running", iterations: 0,
   consecutiveFailures: 0}` (`state.ts:42-44,50-54`) ;
4. `iterate` efface le `DONE` resté dans `tasks/revue/exchange/`
   (`iterate.ts:110`) — c'était la dernière trace de la terminaison côté hôte ;
5. `resolveTaskImage` rend `unused-task-revue:latest` (`docker.ts:104`) : le
   nœud `setup` s'exécute **dans le container de la génération 40**.

Le skill `setup` livré est écrit pour un container vierge et pour ne tourner
qu'une fois (`scaffold.ts:42-64` : « Prépare le container pour la tâche (une
seule fois, au premier nœud) », « clone le dépôt `repo` dans /work/repo »,
« Établis le plan de travail : un fichier /work/PLAN.md, une liste à cocher »).
Rejoué sur la génération 40, il réécrit `PLAN.md` avec des cases **vides** ;
`work` (`scaffold.ts:66-86`) prend alors « la première case non cochée » et
refait, une session après l'autre, un travail déjà commité — en poussant à
nouveau dans le dépôt, puisque c'est ce que le skill demande (« Commite dans le
dépôt si c'est pertinent »). La condition d'arrêt du produit (« crée
/exchange/DONE s'il ne reste aucune case ») ne peut plus se déclencher : le
plan a été remis à zéro par `setup`.

Résultat obtenu : une tâche terminée consomme le quota des nuits suivantes pour
refaire son propre travail par-dessus son résultat livré, `unused tasks list`
l'affiche `active` avec `0 itérations` et `curseur setup`
(`daemon.ts:381-386` : `status: ts?.status ?? "running"`, `cli.ts:118`), et le
commit de fin d'itération (`iterate.ts:170`) fige ce mélange comme nouvel état
« de la tâche ». Résultat attendu, au minimum : qu'un état vide trouvé en face
d'images de tâche existantes soit dit (une ligne de `init`, un refus de
`startWindow`, un `status` qui le montre) plutôt que traité comme une
installation neuve — les deux faits nécessaires sont déjà à portée de main,
`imageExists` est importé par `daemon.ts:6` et déjà appelé par `startWindow`
(`daemon.ts:291`), mais seulement sur l'image de base.

À noter que la symétrie inverse — `state.json` conservé, images perdues
(nouvelle machine, `docker image prune -a`) — mène au mécanisme déjà décrit en
036 (constat 1) : `resolveTaskImage` se replie en silence sur l'image de base et
la session reprend au nœud `work` dans un container vierge, avec un compteur
qui continue de monter. 036 classait ce mécanisme « probable » faute d'un
déclencheur sûr ; la restauration partielle en est un, déterministe. Je ne le
recompte pas comme constat.

## 2. L'image ne porte aucune marque de la génération d'état à laquelle elle correspond : une sauvegarde des deux magasins ne peut pas être vérifiée, ni même prise de façon cohérente

**Gravité** : probable
**Où** : `src/docker.ts:171-174` (le seul label posé), `src/log.ts:14` (ce que
le journal retient), `src/iterate.ts:170-189` (les deux écritures)

Le commit de fin d'itération n'écrit qu'une seule métadonnée, et c'est le nom
de la tâche — une information que le tag portait déjà :

```ts
// docker.ts:171-174
await mustSucceed(
  ["commit", "--change", `LABEL ${LABEL}=${taskName}`, container, `${name}:latest`],
  "commit du container",
);
```

Ni le curseur, ni le compteur d'itérations, ni la date, ni un identifiant de
plage. `LABEL` est la seule clé (`docker.ts:95`), et le `Dockerfile` n'en pose
aucune (`grep -rn LABEL src/*.ts docker/Dockerfile`). Le mécanisme pour porter
le lien existe pourtant déjà et survit même à l'aplatissement : `importChanges`
réémet tous les labels de la config (`docker.ts:209`), ce que
`docker.test.ts:12,21` couvre explicitement.

Le journal d'itération, seul endroit qui note une image, n'aide pas : il
enregistre `r.image` (`iterate.ts:199` → `log.ts:14`), c'est-à-dire la chaîne
`unused-task-<t>:latest` — un tag mutable, **identique pour les 40 générations**
de la tâche. Il distingue l'image de base de l'image de tâche (c'est l'usage
qu'en fait 036) mais ne désigne aucune génération : aucun appel ne lit un
`Id`/digest d'image dans tout `src/` (`docker.ts` n'utilise `image inspect` que
pour l'existence, `{{json .Config}}` et `{{len .RootFS.Layers}}`).

Conséquence sur la prise de sauvegarde. Les deux écritures d'une itération sont
séparées et dans cet ordre fixe :

```ts
// iterate.ts:170   → l'image avance
await deps.commitTask(cfg, task.name, r.container);
// …
// iterate.ts:189   → l'état avance
if (!aborted) await saveState(cfg.dataDir, state);
```

Entre les deux il n'y a aucun verrou, aucune commande ne met le démon en
cohérence pour une copie (`stop` est le seul point calme, et rien ne le
documente comme tel), et aucune commande n'exporte quoi que ce soit : à part le
`docker export` interne de l'aplatissement (`docker.ts:230`), il n'y a ni
`docker save`, ni `load`, ni export dans `src/` ni dans `deploy/` (deux fichiers
seulement : `install.sh`, `unused.service` — ni cron, ni timer systemd).

**Scénario concret.** L'opérateur écrit le script de sauvegarde que le produit
ne fournit pas : `docker save unused-task-revue:latest > revue.tar` puis `cp -r
data/ backup/`. Il le lance pendant une plage (c'est la seule période où l'état
bouge, et le `docker save` d'une image aplatie de plusieurs Go dure des
minutes). Une itération se termine pendant la copie : l'archive contient la
génération 21, `backup/state.json` le curseur de l'itération 20 — ou l'inverse
selon l'instant exact. Six mois plus tard, restauration : le démon reprend au
nœud que l'image a déjà exécuté, le skill rejoue une unité de travail déjà
commitée, et `commitTask` fige le résultat. C'est la divergence du constat 1 de
005, mais arrivée par la porte de la restauration : personne ne l'a provoquée,
rien ne l'a signalée, et — c'est le point de ce constat — **rien ne permet de la
constater après coup**, puisque ni l'archive ni le journal ne disent de quelle
génération l'image vient. Résultat attendu : que l'image porte sa génération
(un `LABEL unused.cursor` / `unused.iterations` au commit coûte une chaîne de
plus à la ligne 172, et traverse l'aplatissement), de sorte qu'un démarrage
puisse comparer ce que l'image dit d'elle-même à ce que l'état prétend.

Je classe en « probable » et non « sûr » : les trois faits de code (label
unique, tag mutable dans le journal, deux écritures non atomiques sans point de
cohérence documenté) sont certains, mais le déclenchement dépend d'une procédure
de sauvegarde que le produit ne définit nulle part — c'est précisément ce qui le
rend difficile à borner.

## Ce qui a été vérifié et tient

- `saveState` est bien atomique pour un lecteur (`writeFile` d'un `.tmp` puis
  `rename`, `state.ts:78-84`) ; ses défauts propres — deux `saveState`
  concurrents sur un nom de `.tmp` fixe, et le fichier invalide sans chemin de
  réparation — sont le sujet de 017 et ne sont pas repris.
- Le schéma persistant est stable et explicite (`version: z.literal(1)`,
  `state.ts:23`) : aucun champ n'est optionnel par accident, `pausedUntil` a un
  `.default(null)` qui permet de relire un état écrit avant son ajout
  (`state.ts:31`). Un état restauré d'une version antérieure du produit est donc
  relu sans perte.
- `resetTask` purge bien les deux magasins **dans le même sens** quand le
  dossier existe (entrée d'état, `currentTask`, `DONE`, puis les images,
  `daemon.ts:397-407`) : l'ordre état-puis-images n'ouvre qu'une fenêtre de deux
  instructions, et le silence du `rmi` est déjà traité (006, 027 constat 3). Le
  cas du dossier disparu — où plus aucune commande ne peut purger ni l'état ni
  les images — est 032 constat 3.
- `ensureTaskState` répare le curseur d'un état restauré face à un graphe
  différent (`state.ts:50-59`, couvert par `graph.test.ts:137-144`), et
  `taskInfo` applique le même repli à l'affichage (`daemon.ts:381`) : un état
  restauré ne peut pas bloquer le démon sur un nœud inexistant. La dérive
  graphe/curseur elle-même est 044.
- `importChanges` conserve les labels à travers l'aplatissement
  (`docker.ts:209`, `docker.test.ts:12,21`) : la métadonnée qui manque au
  constat 2 survivrait au cycle complet si elle était posée.
- `.gitignore` est cohérent avec son intention (`data/`, `tasks/`, `.env`,
  `dist/` hors du dépôt) et `install.sh` ne détruit ni ne réécrit ces répertoires
  quand ils existent (`mkdir -p`, puis `chown`/`chmod`, `install.sh:38-50`) : le
  problème du constat 1 n'est pas que l'installation efface l'état, c'est qu'un
  état absent n'est pas distingué d'un état neuf. Le versionnement de
  `unused.config.json` est le sujet de 066.
