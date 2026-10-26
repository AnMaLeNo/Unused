# 077 — Fidélité de la config réémise par l'aplatissement

**Fichiers examinés** : `src/docker.ts:187-193` (`ImageConfig`),
`src/docker.ts:195-211` (`importChanges`), `src/docker.ts:213-226`
(`flattenTask`), `src/docker.ts:228-248` (`pipeExportImport`),
`src/docker.ts:161-185` (`commitTask`, `pruneTask`), `src/docker.ts:107-150`
(`RunOptions`, `runInTask`), `src/docker.test.ts:1-34`, `src/task.ts:27-46`
(`ENV_ENTRY_RE`, schéma `env`), `src/task.ts:85-106` (`resolveEnv`),
`src/iterate.ts:99-130` (construction de l'`env` d'itération),
`src/iterate.ts:166-187` (traitement d'un échec de `commitTask`),
`src/config.ts:22-29` (`docker.dockerfileDir`), `src/dockerCheck.ts:92-102`
(contrôle d'après aplatissement), `docker/Dockerfile:1-22`, `README.md:129-135`.

**Verdict** : 3 constats (1 sûr, 1 probable, 1 à vérifier)

Note de méthode : ce container n'a ni `docker` ni `node`. Les chaînes produites
par `importChanges` ont été reproduites à l'identique avec `jq` (même sémantique
d'échappement JSON que `JSON.stringify` sur les cas cités) ; le comportement du
consommateur — le parseur Dockerfile derrière `docker import -c` — est tiré de
la référence Dockerfile, qui range `ENV`, `LABEL` et `WORKDIR` parmi les
instructions soumises à la substitution de variables. C'est la seule hypothèse
non exécutée de ce rapport ; elle est explicite dans le constat 1.

## `JSON.stringify` n'est pas un quoteur Dockerfile : toute valeur contenant `$` est réécrite à l'import

**Gravité** : sûr
**Où** : `src/docker.ts:200-206`

`importChanges` sérialise les valeurs avec `JSON.stringify`, puis les donne à
un parseur Dockerfile. Les deux langages ne s'accordent ni sur `$` ni sur les
séquences `\x` :

```ts
// src/docker.ts:200-206
const q = (s: string) => JSON.stringify(s);
for (const kv of config.Env ?? []) {
  const i = kv.indexOf("=");
  changes.push(`ENV ${kv.slice(0, i)}=${q(kv.slice(i + 1))}`);
}
if (config.WorkingDir) changes.push(`WORKDIR ${config.WorkingDir}`);
```

`JSON.stringify` protège `"` et `\`, et rien d'autre : le `$` sort tel quel.
Côté `docker import -c`, chaque chaîne est parsée comme une ligne de
Dockerfile, et `ENV` fait la substitution de variables. La valeur n'est donc
pas transportée, elle est **réévaluée**.

Le chemin complet, vérifiable dans le dépôt :

1. Une tâche déclare `"env": ["DB_PASS=s3cr3t$vault"]`. Le schéma l'accepte :
   `ENV_ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/` (`task.ts:27`) ne contraint
   que le nom, la valeur est un `.*` libre. Même chose pour la forme `"NOM"`,
   dont la valeur vient de l'environnement du démon et n'est contrainte par rien.
2. `iterate.ts:125` la transmet à `runInTask`, qui émet `-e DB_PASS`
   (`docker.ts:145`) : `Config.Env` du container contient
   `DB_PASS=s3cr3t$vault`.
3. `commitTask` (`docker.ts:171-174`) scelle cette `Env` dans
   `unused-task-<t>:latest` — fait déjà établi par 019 (constat 1).
4. Au 31ᵉ commit (`flattenAfterLayers: 30`), `commitTask` appelle `flattenTask`,
   qui relit `{{json .Config}}` et repasse par `importChanges`.

La chaîne produite, reproduite à l'identique :

```
ENV DB_PASS="s3cr3t$vault"
```

`$vault` n'est défini nulle part dans la liste de changements, donc le parseur
le remplace par la chaîne vide. L'image aplatie porte `DB_PASS=s3cr3t`.
Attendu : `s3cr3t$vault`. Obtenu : `s3cr3t`.

Ce qui rend le défaut coûteux, ce n'est pas la troncature mais l'endroit où
elle se voit. Rien ne relit la config après l'import pour vérifier
l'aller-retour ; `flattenTask` réécrit `:latest` en place et rend la main sans
diagnostic. La tâche continue, et c'est l'itération suivante qui échoue, dans
le container, sur une authentification — classée comme un échec de la tâche par
`classify`, à des heures et des dizaines de couches de la cause. La valeur
d'origine, elle, n'existe plus nulle part : `:prev` date de l'avant-dernier
commit et sera écrasé au commit suivant (`docker.ts:168-170`).

Trois variantes du même défaut d'échappement, toutes sur ces mêmes lignes :

- **`${…}` non terminé** (`TPL=cout ${PRIX`) : la substitution échoue, `docker
  import` sort en erreur, `pipeExportImport` rejette un `DockerError`
  (`docker.ts:243`) et `flattenTask` remonte l'exception **depuis l'intérieur de
  `commitTask`**, après le commit de `:latest` et la suppression du container.
  `iterate.ts:171-181` l'attrape, décrète que l'itération « n'a jamais eu lieu »,
  recule `ts.cursor` et `ts.iterations`, et ferme la plage — alors que le travail
  est bel et bien commité. Un `$` mal placé dans une valeur suffit donc à
  bloquer la tâche à chaque aplatissement. (Le caractère destructeur de cet
  enchaînement est le constat de 036 ; ici c'est l'entrée qui le déclenche.)
- **Valeur contenant un saut de ligne** (possible par la forme `"NOM"`, qui lit
  l'environnement du démon) : `JSON.stringify` produit `ENV MULTI="ligne1\nligne2"`.
  Dans une chaîne entre guillemets d'un Dockerfile, `\` n'échappe qu'un jeu
  restreint de caractères ; `\n` ressort soit comme les deux caractères
  littéraux `\` et `n`, soit amputé de son antislash. Dans les deux cas la
  valeur réécrite n'est plus celle de départ.
- **`WorkingDir` n'est pas quoté du tout** (`docker.ts:206`), contrairement à
  `Env` et `Labels`. Un `WorkingDir` de `/opt/mon projet` donne
  `WORKDIR /opt/mon projet`, soit deux arguments pour une instruction qui en
  exige exactement un : l'import échoue, avec les conséquences du point
  précédent. Et comme `WORKDIR` subit lui aussi la substitution, un `$` dans le
  chemin est réévalué.

Le test existant ne peut pas attraper cela : `docker.test.ts:5-23` compare la
sortie de `importChanges` à une liste de chaînes attendues, c'est-à-dire qu'il
fige le quotage JSON comme étant le bon. Il n'existe aucun test, ni aucune
étape de `dockerCheck`, qui relise la valeur **après** le passage par `docker
import` — seul endroit où le désaccord entre les deux grammaires se manifeste.

## La config réémise est un sous-ensemble de ce que `docker import -c` accepte : `USER`, `VOLUME`, `EXPOSE`, `HEALTHCHECK`, `SHELL`, `STOPSIGNAL` disparaissent

**Gravité** : probable
**Où** : `src/docker.ts:187-193` et `src/docker.ts:199-211`

`ImageConfig` ne déclare que cinq champs, et `importChanges` n'en réémet que
cinq :

```ts
// src/docker.ts:187-193
interface ImageConfig {
  Env?: string[] | null;
  WorkingDir?: string;
  Entrypoint?: string[] | null;
  Cmd?: string[] | null;
  Labels?: Record<string, string> | null;
}
```

Or `docker import -c` accepte aussi `USER`, `EXPOSE`, `VOLUME`, `HEALTHCHECK`,
`SHELL`, `STOPSIGNAL` et `ONBUILD`. Ce n'est donc pas une limite de l'outil mais
une omission : tout ce qui n'est pas dans cette liste de cinq est perdu au
premier aplatissement, définitivement et sans un mot. Le commentaire de
`docker.ts:195-198` annonce d'ailleurs le contrat inverse — « on la
reconstruit », sans réserve.

Avec le `docker/Dockerfile` livré, l'omission est sans effet : il ne pose que
des `ENV`, des `RUN` et un `WORKDIR` (`Dockerfile:6-22`). Mais
`docker.dockerfileDir` est un paramètre de configuration (`config.ts:25`), et le
README présente « l'image Docker » comme configurable (`README.md:135`) : le
socle est explicitement remplaçable.

Le cas qui fait mal est `USER`. Un utilisateur qui durcit son image de base —
réaction naturelle à un container où Claude est root et tourne en
`--dangerously-skip-permissions` — y met un `USER unused`. Les 30 premières
itérations tournent bien sous cet utilisateur ; au 31ᵉ commit, `flattenTask`
réécrit `:latest` sans réémettre `USER`, et l'image repasse à l'utilisateur par
défaut, root. Toutes les itérations suivantes tournent en root. Attendu : le
confinement tient. Obtenu : il saute, silencieusement, à un moment qui ne
dépend ni d'un déploiement ni d'une modification du Dockerfile, et aucune sortie
ne le signale. `dockerCheck` ne le verrait pas non plus : son contrôle d'après
aplatissement (`dockerCheck.ts:96-101`) vérifie le marqueur, `$IS_SANDBOX`,
`pwd` et `claude --version`, jamais `id`.

Dans la même veine, et à vérifier faute de docker ici : un socle déclarant
`VOLUME /work` ferait pire que perdre la déclaration. `docker create`
(`docker.ts:220`) instancie les volumes anonymes d'une image, et `docker export`
n'inclut pas le contenu des points de montage — le rootfs exporté aurait un
`/work` vide, c'est-à-dire la perte de tout le travail de la tâche, une seule
fois, à l'aplatissement. Je ne le compte pas comme constat séparé : je n'ai pas
pu l'exécuter, et il suppose un socle que le dépôt ne fournit pas.

## Une entrée `Env` sans `=` perd la dernière lettre de son nom et prend l'entrée entière pour valeur

**Gravité** : à vérifier
**Où** : `src/docker.ts:203-204`

```ts
const i = kv.indexOf("=");
changes.push(`ENV ${kv.slice(0, i)}=${q(kv.slice(i + 1))}`);
```

Si `kv` ne contient pas `=`, `indexOf` renvoie `-1` : `slice(0, -1)` coupe le
dernier caractère du nom et `slice(0)` rend la chaîne entière. Sortie obtenue
pour `"ORPHELIN"`, reproduite :

```
ENV ORPHELI="ORPHELIN"
```

Une variable inventée, de nom tronqué, avec son propre nom pour valeur. Le cas
symétrique `"=vide"` (`i === 0`) produit `ENV ="vide"`, un nom vide que le
parseur rejette — et donc un aplatissement en échec, avec le recul d'itération
décrit au constat 1.

Pourquoi « à vérifier » et pas davantage : la fonction est pure, son
comportement sur cette entrée est certain, mais je n'ai pas trouvé de chemin qui
la produise. Les deux sources d'`Env` de l'image sont le `ENV` du Dockerfile
(toujours `NOM=valeur`) et les `-e NOM` de `runInTask`, dont les valeurs sont
des `string` non optionnelles (`RunOptions.env`, `docker.ts:114`) présentes dans
l'environnement du processus `docker` (`docker.ts:31`) — le client n'émet donc
jamais d'entrée nue. Le défaut est réel dans le code et trivial à neutraliser
(`if (i <= 0) continue;` ou traiter l'entrée comme un nom à valeur vide) ; sa
portée dépend d'un producteur que je n'ai pas exhibé.

## Ce qui a été vérifié et tient

- **Antislashs** : `C:\Users\x` donne `ENV WINPATH="C:\\Users\\x"`, et `\\` est
  une des séquences que le parseur Dockerfile déséchappe correctement entre
  guillemets. L'aller-retour est fidèle — c'est `$` et les séquences non
  reconnues qui ne le sont pas, pas le `\` lui-même.
- **`Entrypoint` et `Cmd`** (`docker.ts:207-208`) : émis en forme JSON exec,
  donc insensibles au découpage en mots et à la substitution. `?.length` traite
  `null` et `[]` de la même façon, ce qui est correct (une liste vide et
  l'absence donnent le même résultat à l'import). Rien à redire.
- **`LABEL unused.task=<tâche>`** survit à l'aplatissement (`docker.ts:209`), ce
  dont dépend `pruneTask` ; déjà vérifié en 036. Les noms de tâches sont
  contraints par `TASK_NAME_RE` (`task.ts:10`) à `[a-z0-9._-]`, donc cette
  valeur-là ne peut pas déclencher le constat 1.
- **Ordre des `ENV`** : les variables sont réémises dans l'ordre de
  `config.Env`, et une valeur qui référence une variable précédente de la même
  liste se réévalue à la même chose. L'ordre n'ajoute pas de défaut propre.
- **`PATH` de l'image livrée** : `Dockerfile:14` écrit `ENV PATH="/root/.local/bin:${PATH}"`,
  mais la substitution a lieu au `build` — la valeur stockée dans l'image ne
  contient plus de `$`. Le socle fourni traverse donc l'aplatissement intact,
  ce que `dockerCheck` confirme sur `IS_SANDBOX` et `pwd`
  (`dockerCheck.ts:96-101`) et ce que 051 avait déjà noté.
- **`WorkingDir` vide** : `if (config.WorkingDir)` saute l'instruction, et
  l'import retombe sur `/`, qui est exactement ce qu'aurait donné un
  `WORKDIR /`. Pas de perte.
- **Exposition du token dans l'argv de `docker import`** : c'est le constat 2 de
  019, non repris ici. Ce rapport ne traite que de l'altération des valeurs, pas
  de leur visibilité.
