# L'image Docker de base et la sécurité du token

Deux sujets liés : l'image dans laquelle chaque tâche démarre
(`docker/Dockerfile`), et la façon dont `CLAUDE_CODE_OAUTH_TOKEN` — la clé qui
permet de lancer des sessions Claude — circule du `.env` du démon jusqu'au
container, sans jamais apparaître en clair sur la ligne de commande.

## L'image de base

```dockerfile
# docker/Dockerfile
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git zstd procps less \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

ENV IS_SANDBOX=1
ENV DISABLE_AUTOUPDATER=1

WORKDIR /work
```

Le commentaire en tête du fichier résume l'intention : c'est « un PC pour
Claude ». Un Debian minimal, l'installeur officiel de Claude Code (binaire
natif, posé dans `/root/.local/bin`), et rien d'autre d'imposé — la tâche est
libre d'installer ce qu'elle veut par la suite (un compilateur, un autre
runtime…), et ce qu'elle installe survit d'itération en itération puisque
c'est le container commité qui sert d'état persistant (voir
[Le container comme état persistant](container-etat-persistant.md)).

Deux variables d'environnement méritent d'être notées :

- `IS_SANDBOX=1` : Claude Code refuse `--dangerously-skip-permissions` tant
  qu'il tourne en root sans ce signal — c'est la façon de dire « oui, c'est
  fait exprès, on est dans un bac à sable ». `buildCommand()`
  (`src/claude.ts:25`) construit justement une commande `claude -p ...` sans
  demander de confirmation interactive.
- `DISABLE_AUTOUPDATER=1` : le démon peut tourner sans supervision pendant des
  heures (plages automatiques, voir [Les plages automatiques](plages-automatiques.md)) ;
  une mise à jour spontanée de Claude Code en plein milieu d'une session
  n'est pas souhaitable.

L'image se construit avec `unused docker build`, qui appelle `buildBase()` :

```ts
// src/docker.ts:82
export async function buildBase(cfg: Config, print: (line: string) => void): Promise<void> {
  let buf = "";
  await mustSucceed(["build", "-t", cfg.docker.baseImage, cfg.docker.dockerfileDir], "build de l'image de base", {
```

`cfg.docker.baseImage` (défaut `unused-base`) et `cfg.docker.dockerfileDir`
(défaut `./docker`) viennent du schéma de config (`src/config.ts:22-27`) —
voir [La configuration du démon](configuration-du-demon.md). Une fois l'image
construite, une tâche sans historique en repart : `resolveTaskImage()`
(`src/docker.ts:102`) retombe sur `cfg.docker.baseImage` tant qu'aucune image
`unused-task-<nom>:latest` n'existe encore.

## D'où vient le token

Le démon ne lit `CLAUDE_CODE_OAUTH_TOKEN` que depuis son propre `.env`, jamais
depuis la CLI cliente :

```ts
// src/cli.ts:17
async function daemonSetup(): Promise<Config> {
  const cfg = await loadConfig(program.opts().config);
  const envFile = path.join(cfg.rootDir, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return cfg;
}
```

Ce `.env` est celui que `install.sh` protège en `chmod 600` et dont il fait
le propriétaire l'utilisateur système `unused` (voir
[Déploiement](deploiement.md)) ; en usage manuel, c'est le `.env` à côté du
dépôt. Si le token est absent, une itération ne démarre même pas :

```ts
// src/iterate.ts:99
const token = deps.env[TOKEN_ENV];
if (!token) {
  return finishFatal("auth", `${TOKEN_ENV} absent : lance \`claude setup-token\` et mets le token dans .env`);
}
```

C'est une panne `fatal` de raison `"auth"` : la tâche sort de la file (décision
`stop-window`, voir [Le cycle d'une itération](cycle-d-iteration.md)) plutôt
que d'être retentée en boucle sans espoir.

## Du process `docker` au container, sans passer par `ps`

Une fois le token en main, `iterate()` le fusionne à l'environnement propre à
la tâche et le passe à `runInTask()` :

```ts
// src/iterate.ts:125
env: { ...taskEnv.env, [TOKEN_ENV]: token },
```

`task.ts` documente la sémantique attendue, calquée sur `docker run -e` :
« `env` : les variables d'environnement à donner au container, avec la
sémantique de `docker run -e` — "NOM" transmet la valeur de l'hôte (le `.env`
du démon), "NOM=valeur" la fixe. Le token Claude est toujours transmis. »
(`src/task.ts:23-25`).

Le point important est *comment* ce nom passe à `docker run` :

```ts
// src/docker.ts:145
for (const name of Object.keys(opts.env ?? {})) args.push("-e", name);
```

Seul le *nom* de la variable atterrit dans les arguments de la commande
`docker` — jamais `NOM=valeur`. C'est `docker()` (`src/docker.ts:28`) qui,
en spawnant le binaire `docker`, lui fournit l'environnement où cette valeur
existe déjà :

```ts
// src/docker.ts:30
const child = spawn("docker", args, {
  env: { ...process.env, ...opts.env },
```

Avec `-e NOM` seul, Docker va chercher la valeur dans l'environnement du
process `docker` lui-même et la transmet au container par un canal qui ne
passe jamais par la ligne de commande. Concrètement, un `ps aux` sur l'hôte
pendant qu'une itération tourne ne montre jamais le token en clair — seul
`docker run ... -e CLAUDE_CODE_OAUTH_TOKEN ...` apparaît, sans valeur.

## Ce que le commit du container en fait

Une itération réussie est commitée telle quelle (`commitTask()`,
`src/docker.ts:166`) : c'est le mécanisme qui fait de l'image de la tâche un
état persistant. Rien dans `commitTask()` ne retire les variables
d'environnement du container avant de le figer — et `docker commit` préserve
la config du container (dont son `Env` runtime) dans la nouvelle image. Le
code le montre lui-même ailleurs : quand `flattenTask()` réécrit l'image à
plat, il relit `.Config.Env` de l'image existante et le réinjecte tel quel
via `importChanges()` (`src/docker.ts:199-211`), précisément parce que ces
variables font partie de la config persistée de l'image, pas seulement de
l'exécution du moment.

En pratique, `CLAUDE_CODE_OAUTH_TOKEN` finit donc dans la config de l'image
`unused-task-<nom>:latest` de chaque tâche qui a eu au moins une itération
réussie, consultable avec `docker image inspect`. Ce n'est pas un canal
supplémentaire vers l'extérieur : rien dans le code ne pousse ces images vers
un registre (aucun `docker push`, aucune configuration de registre dans
`src/docker.ts` ou `src/config.ts`), et accéder au démon Docker de l'hôte
équivaut déjà à un accès root sur la machine — c'est explicitement le
compromis assumé par `install.sh` (le compte `unused` est membre du groupe
`docker`, « équivalent root sur l'hôte — acceptable sur une machine dédiée, à
savoir », `deploy/install.sh:11-13`). La protection réelle contre la fuite du
token reste donc en amont : le `.env` en `chmod 600`, et le fait que la
machine soit dédiée à cet usage.

## Voir aussi

- [Le container comme état persistant](container-etat-persistant.md) — le
  mécanisme général de commit / rotation `:prev` / aplatissement.
- [Déploiement](deploiement.md) — permissions du `.env`, utilisateur système,
  groupe `docker`.
- [Le cycle d'une itération](cycle-d-iteration.md) — où se place la
  vérification du token dans une itération.
