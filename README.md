# unused

Un abonnement Claude Code a des limites glissantes (5 h) et hebdomadaires. Ce que
tu ne consommes pas est perdu. `unused` fait tourner, pendant les plages où tu
ne travailles pas, des **tâches infinies** — des skills Claude Code conçus pour
être rejoués sans fin — dans des containers Docker, jusqu'à taper la limite.

Il passe par `claude -p` avec ton abonnement (jamais par l'API), tourne sur un
Raspberry Pi ou un Mac, et se pilote par une CLI qui parle à un démon.

## Principe

- **Une tâche = un graphe de skills.** Chaque nœud lance un skill et désigne
  son successeur ; la boucle est infinie par construction. La seule sortie :
  le skill crée `/exchange/DONE` quand il juge la tâche terminée.
- **On donne un container à Claude.** Il y est root, il installe ce qu'il veut.
  Après chaque itération réussie, le container est commité : l'itération
  suivante repart exactement de là. Une itération qui échoue (erreur, quota,
  timeout) est réputée n'avoir jamais eu lieu : container jeté, même nœud.
- **Le runner ne lit jamais ce que Claude produit**, seulement comment la
  session s'est terminée (`terminal_reason`) et si `DONE` est là. Le skill
  gère son état lui-même, dans son container.
- **Une file, pas de parallélisme** (le quota est partagé) : une itération de
  la tâche A, une de B, une de C… Sur quota saturé, tout le monde attend.

## Installation

```
git clone … /opt/unused && cd /opt/unused
npm install && npm run build
claude setup-token          # sur une machine où tu es connecté
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…" > .env
```

Le démon : `node dist/cli.js daemon` à la main, ou via systemd :

```
sudo useradd -r -G docker -d /opt/unused unused
sudo cp deploy/unused.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now unused
```

Puis, une seule fois : `unused docker build` (l'image de base, Debian + Claude
Code natif arm64) et `unused docker check` (vérifie tout le cycle Docker sans
consommer de quota).

## Écrire une tâche

```
tasks/review-monprojet/
  task.json
  skills/
    find-next/SKILL.md
    do-review/SKILL.md
  exchange/            ← monté sur /exchange dans le container (DONE, rapports…)
```

```json
{
  "active": true,
  "start": "find-next",
  "params": { "repo": "https://github.com/moi/monprojet" },
  "nodes": {
    "find-next": { "skill": "find-next", "next": "do-review" },
    "do-review": { "skill": "do-review", "args": ["--model", "opus"], "next": "find-next" }
  }
}
```

Le nom du dossier est le nom de la tâche (et de son image Docker :
minuscules, chiffres, `.`, `_`, `-`). Un skill est un `SKILL.md` ordinaire avec
`disable-model-invocation: true` ; il reçoit les params via `$ARGUMENTS`
(`repo=https://… cle="valeur"`). Les skills sont montés en lecture seule dans
le container : tu peux les modifier entre deux itérations.

La règle, en une phrase : **un skill est rejoué tant qu'il n'a pas créé
`/exchange/DONE`.** Pour que ça ne tourne pas en rond, chaque skill lit ce que
les itérations précédentes ont laissé dans le container, avance d'une unité
de travail *courte* (une session, une décision), et note ce qu'il a fait.
Découper en deux nœuds — « chercher quoi faire » puis « le faire » — rend
chaque session petite et la perte d'une itération indolore.

## Piloter

```
unused start --for 8h        # démarre une plage (jusqu'à taper la limite)
unused status                # plage, itération en cours, tâches
unused stop                  # après l'itération en cours ; --now pour tuer
unused tasks list | reset <t> | activate <t> | deactivate <t>
```

La CLI trouve le démon par `--socket`, sinon `$UNUSED_SOCKET`, sinon
`<dataDir>/unused.sock` déduit de `unused.config.json`. Elle ne lit jamais
`.env` : le token ne sert qu'au démon.

Le démon reprend une plage interrompue par un redémarrage. Les logs de chaque
itération (le JSON complet rendu par Claude) sont dans `data/logs/<tâche>/`,
avec un index dans `data/logs/index.jsonl`.

## Configuration

`unused.config.json` : les arguments ajoutés à chaque session
(`claude.sessionArgs`), le timeout par session, l'attente sur quota saturé,
la pause après un échec, le nombre d'échecs consécutifs avant de sortir une
tâche de la file, l'image Docker et le seuil d'aplatissement.
