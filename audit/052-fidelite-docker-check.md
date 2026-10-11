# 052 — Ce que « Tout est en ordre » ne dit pas : le filet de sécurité ne touche ni l'écriture container → `/exchange`, ni `DONE`, ni `-e`, ni stdin, ni le kill

**Fichiers examinés** : `src/dockerCheck.ts` (entier, 1-112, en particulier les
six appels à `runInTask` lignes 57, 63, 73, 82, 87, 96 et le verdict ligne 104),
`src/docker.ts:107-150` (`RunOptions`, `runInTask` : `stdin`, `env`, `mounts`,
`onStart`), `src/docker.ts:250-254` (`removeTaskImages`),
`src/iterate.ts:11-31` (`DONE_FILE`, `killContainer`),
`src/iterate.ts:99-159` (ce qu'une vraie itération utilise : token, `env`,
stdin, montage des skills, `onStart`, timer, `exists(donePath)`),
`src/graph.ts:41-53` (`classify`) et `src/graph.ts:80-90` (`applyOutcome`, cas
`completed`), `src/task.ts:8-27` (`TASK_NAME_RE`, rôle de `DONE`),
`src/scaffold.ts:88-103` (`scaffoldTask`, validation du nom) et
`src/scaffold.ts:83-85` (le skill livré crée `/exchange/DONE`),
`src/config.ts:12-28`, `src/api.ts:97-111`, `src/cli.ts:163-176`,
`src/iterate.test.ts:26-115` (comment `DONE` est simulé dans les tests),
`src/docker.test.ts` (entier), `deploy/unused.service`,
`deploy/install.sh:11-50`, `README.md:43-45`.

**Verdict** : 2 constats (1 sûr, 1 sûr au mécanisme mais à déclencheur étroit)

Ni `node` ni `docker` ne sont installés ici : tout est établi par lecture.
Ce rapport ne reprend pas ce qui est déjà constaté ailleurs sur cette commande
— sortie 0 en cas d'échec, exécutions concurrentes, absence de garde pendant
une plage, nettoyage annoncé sans vérification (rapport 009, constats 1 à 4),
ordre `image prune` / `container prune` (rapport 027, constat 4). Il traite le
seul angle restant : la *couverture* du verdict.

## Le verdict porte sur trois mécanismes et en couvre zéro des quatre dont dépend une itération réelle

**Gravité** : sûr
**Où** : `src/dockerCheck.ts:32-35` (le contrat annoncé), `src/dockerCheck.ts:57,63,73,82,87,96` (les six `runInTask`), `src/dockerCheck.ts:104` (le verdict)

Le contrat que la fonction s'écrit à elle-même, et que le README reprend :

```ts
// dockerCheck.ts:32-35
/**
 * Vérifie de bout en bout la mécanique Docker sans Claude ni quota :
 * image de base, cycle run → commit → run, rotation :prev, aplatissement.
 */
```

```
README.md:43-45 — « unused docker check (vérifie tout le cycle Docker sans
consommer de quota) »
```

Les quatre mécanismes énumérés *sont* vérifiés. Mais `runInTask` expose cinq
options (`src/docker.ts:107-119`) et une vraie itération en utilise quatre
(`src/iterate.ts:121-139`) ; les six appels de `dockerCheck` n'en passent
aucune :

| mécanisme d'une itération réelle | où il sert | exercé par `docker check` |
|---|---|---|
| le container **écrit** dans `/exchange` | `iterate.ts:151` lit `exists(donePath)` | **non** — seule la lecture est testée (`dockerCheck.ts:53` écrit `ping` depuis l'hôte, `:64` le lit depuis le container) |
| `DONE`, la condition de sortie | `iterate.ts:12,110,151`, `graph.ts:84-86` | **non** |
| `env` → `-e NOM` (le token) | `iterate.ts:125`, `docker.ts:145,148` | **non** (aucun `env:`) |
| `stdin` → `-i` (le prompt) | `iterate.ts:123`, `docker.ts:144,148` | **non** (aucun `stdin:`) |
| `mounts` (skills en lecture seule) | `iterate.ts:127`, `docker.ts:143` | **non** (aucun `mounts:`) |
| `onStart` → timer + `killContainer` | `iterate.ts:128-139`, `iterate.ts:28` | **non** (aucun `onStart:`) |

Ce n'est pas une remarque sur la couverture de tests : c'est le seul contrôle
avant mise en service que le projet propose (`README.md:43-45`), il est
présenté comme allant « de bout en bout », et il imprime `Tout est en ordre.`
(`dockerCheck.ts:104`) après n'avoir exercé que le trajet hôte → container.
Les quatre lignes « non » du tableau sont exactement les sites où les rapports
précédents ont démontré des défauts : `killContainer` qui part avant que le
container existe et dont le rejet non capturé tue le démon (001, 027),
le `-e` qui reconfigure le client `docker` de l'hôte et peut écraser le `PATH`
de l'image (033), stdin et l'EPIPE (041), le `SKILL.md` écrit par-dessus le
montage (048). Un `unused docker check` vert ne dit rien d'aucun d'entre eux.

Le trou le plus net est l'écriture container → hôte. C'est la **seule**
condition de sortie du système :

```
// task.ts:13-15
 * Chaque nœud lance un skill et désigne son successeur. La seule condition de
 * sortie est le fichier DONE créé par le skill dans /exchange ; sinon on suit
 * `next` indéfiniment.
```

Et elle n'est exercée nulle part dans le projet : pas par le check (le
container ne fait que `cat /exchange/ping`), pas par les tests — `iterate.test.ts`
remplace `runInTask` par un double et écrit `DONE` **depuis l'hôte**
(`iterate.test.ts:96`, `:108`), ce qui valide la lecture côté hôte, jamais
l'écriture côté container.

Scénario concret, avec les valeurs livrées. Supposons que, pour une raison
quelconque, un skill ne puisse pas créer `/exchange/DONE` dans le container
alors que la lecture du montage fonctionne :

1. La session se termine normalement, `terminal_reason: "completed"`.
2. `exists(donePath)` est faux (`iterate.ts:151`), `classify` rend
   `{ kind: "completed", done: false }` (`graph.ts:48`).
3. `applyOutcome` incrémente `iterations`, remet `consecutiveFailures` à 0, et
   avance le curseur : `ts.cursor = nodes[node].next` → `"next-task"`
   (`graph.ts:81-89`). Le graphe livré boucle (`work` → `work`,
   `scaffold.ts:12`), donc la tâche repart indéfiniment.
4. Rien ne signale l'anomalie : `status` affiche `running`, un compteur
   d'itérations qui monte, zéro échec ; le coût s'accumule nuit après nuit et
   la tâche ne se termine jamais. Le diagnostic prévu pour ce genre de doute,
   `unused docker check`, répond `Tout est en ordre.`

Attendu : un contrôle qui affirme vérifier le cycle de bout en bout fait
écrire le container dans `/exchange` et relit le fichier depuis l'hôte (deux
lignes : `touch /exchange/DONE` dans le `cmd`, un `stat` ensuite) ; obtenu : le
verdict global est rendu sans que cette direction du montage n'ait jamais été
empruntée.

Sur la cause possible du point de départ, je n'ai pas de démonstration à
partir de ce dépôt, seulement un déclencheur cohérent avec le déploiement
livré, à vérifier sur machine : `install.sh` ne configure pas le démon Docker
(`deploy/install.sh:11-50`, il se contente de mettre l'utilisateur `unused`
dans le groupe `docker`), donc le `daemon.json` de l'hôte décide. Avec
`userns-remap` activé, le root du container est mappé sur un sous-UID de
l'hôte, alors que `exchangeDir` est créé par le démon `unused`
(`docker.ts:133`, `mkdir` → 0755 `unused:docker`) : lire `ping` (0644) passe,
créer `DONE` dans un répertoire 0755 appartenant à un autre UID échoue en
EACCES. Asymétrie exactement invisible pour le check actuel. Un refus SELinux
(montage sans `:z`), lui, casserait aussi la lecture et serait donc attrapé.

## Le nom de la tâche interne du check n'est réservé par rien : une tâche qui le porte perd toute sa lignée d'images, sans un mot

**Gravité** : sûr (mécanisme) — déclencheur étroit : il faut qu'une tâche porte exactement ce nom
**Où** : `src/dockerCheck.ts:19-20`, `src/dockerCheck.ts:50`, `src/dockerCheck.ts:107`, `src/task.ts:10`, `src/scaffold.ts:90-92`

```ts
// dockerCheck.ts:19-20
// Nom valide pour une image Docker, et improbable pour une vraie tâche.
const CHECK_TASK = "docker-check-internal";
```

« Improbable » est la seule protection : rien ne réserve ce nom.
`TASK_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/` (`task.ts:10`) accepte
`docker-check-internal` — trois groupes séparés par des `-` simples — donc
`scaffoldTask` le crée sans broncher (`scaffold.ts:90-92`, seule validation du
nom) et `loadTask` le charge (`task.ts:123`). Or `taskImage` est une fonction
pure du nom (`docker.ts:97-99`) : la tâche de l'utilisateur et la tâche interne
du check désignent la même image `unused-task-docker-check-internal`, et le
même label `unused.task=docker-check-internal`.

Le check commence et finit par détruire cette image, sans condition :

```ts
// dockerCheck.ts:50
await removeTaskImages(CHECK_TASK);
// dockerCheck.ts:107-108 (finally)
await removeTaskImages(CHECK_TASK);
await docker(["container", "prune", "-f", "--filter", `label=unused.task=${CHECK_TASK}`]);
```

```ts
// docker.ts:250-253
export async function removeTaskImages(taskName: string): Promise<void> {
  const name = taskImage(taskName);
  await docker(["rmi", "-f", `${name}:latest`, `${name}:prev`]);
  await pruneTask(taskName);
}
```

Scénario concret :

1. L'utilisateur crée `unused tasks new docker-check-internal` (nom accepté),
   l'active, et la tâche tourne pendant des nuits : `:latest` porte tout ce que
   Claude a installé et écrit dans `/work`, `state.json` porte un curseur à
   plusieurs dizaines d'itérations.
2. Entre deux itérations (aucun container de la tâche n'est alors en vie —
   `runInTask` est attendu puis le container est commité ou jeté,
   `iterate.ts:168-187`), l'utilisateur lance `unused docker check` pour
   diagnostiquer autre chose. Rien ne l'en empêche pendant une plage
   (rapport 009, constat 3).
3. Ligne 50 : `docker rmi -f unused-task-docker-check-internal:latest :prev`
   réussit — la lignée complète de la vraie tâche est supprimée. Le code de
   retour n'est de toute façon pas regardé (`docker()` ne lève pas,
   `docker.ts:27-28`).
4. Le check déroule ses étapes sur *ce* nom, puis le `finally` supprime à
   nouveau images et containers, et imprime
   `✔ images et containers de docker-check-internal supprimés`, précédé de
   `Tout est en ordre.`
5. Itération suivante de la vraie tâche : `resolveTaskImage` ne trouve plus
   `:latest` et repart de `unused-base` (`docker.ts:101-105`), tandis que
   `state.json` a conservé `cursor` et `iterations`. Le skill reprend au nœud
   N dans un Debian nu : dépôt absent, `/work/PLAN.md` et `/work/JOURNAL.md`
   disparus (`scaffold.ts:60-85`). Aucune trace d'erreur, aucun échec compté —
   la tâche « continue ».

Attendu : un nom réservé (refus dans `scaffoldTask`/`loadTask`, ou un préfixe
hors de `TASK_NAME_RE` comme `check--internal`, impossible à porter par une
tâche), ou au minimum un refus du check si `tasksDir` contient ce nom.
Obtenu : une commande de diagnostic annoncée comme inoffensive détruit
l'intégralité de l'état d'une tâche réelle et conclut que tout est en ordre.
C'est aussi la limite de l'assurance donnée par le rapport 009 (« toutes les
commandes Docker de `dockerCheck` sont bornées à `CHECK_TASK` […] la
vérification ne corrompt donc pas l'état d'une tâche réelle ») : elle vaut
tant que personne ne nomme une tâche comme la tâche interne, ce que rien
n'empêche.

## Ce qui a été vérifié et tient

- Les quatre mécanismes annoncés par le docstring sont réellement établis par
  le check, et les assertions sont correctes : départ depuis `baseImage` puis
  depuis `:latest` (`dockerCheck.ts:68,75`), persistance de `/work/marker`
  (`:74`), présence de `:prev` après rotation (`:77`), container jeté qui ne
  laisse rien (`:81-90`), une seule couche après aplatissement et
  `ENV`/`WORKDIR`/`PATH` conservés (`:92-102`). `expectOutput` compare bien
  code *et* stdout (`:24-30`).
- Le cas `flattenAfterLayers` bas (1 ou 2), qui déclencherait un aplatissement
  à l'intérieur de `commitTask` (`docker.ts:176-178`) au milieu du check, ne
  produit pas de faux échec : `:prev` est un tag, il survit à l'aplatissement,
  et l'assertion finale `after !== 1` reste vraie. Seul le message
  `${before} → ${after} couche` devient trivial (« 1 → 1 »).
- Un échec d'assertion avant le `try` (étapes « Docker » et « Image de base »,
  `:39-47`) n'entre pas dans le `finally` : il n'y a rien à nettoyer à ce
  stade, aucune image ni container n'ayant encore été créé.
- Un échec au milieu du bloc `try` ne laisse pas de container derrière lui :
  `docker run` est attendu, le container est donc arrêté et le
  `container prune -f --filter label=…` du `finally` l'emporte.
- `rm(exchangeDir, { recursive: true, force: true })` du `finally`
  (`:109`) ne peut pas buter sur un fichier appartenant à root : dans ce check,
  le container n'écrit jamais dans `/exchange` — ce qui est précisément le
  premier constat.
- Déjà constaté ailleurs, non repris ici : sortie 0 en cas d'échec,
  concurrence de deux checks, absence de garde pendant une plage, nettoyage
  annoncé sans vérification (009) ; ordre `image prune`/`container prune` et
  containers orphelins (027) ; `-e` et `PATH` (033) ; stdin/EPIPE (041) ;
  `killContainer` (001, 027).
