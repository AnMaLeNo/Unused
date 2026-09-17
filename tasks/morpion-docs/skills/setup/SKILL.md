---
name: setup
description: Prépare le container — clone du dépôt, branche de travail, plan des aspects à documenter.
disable-model-invocation: true
---

Paramètres : $ARGUMENTS

Tu es dans un container qui te sert d'espace de travail pour toute la durée
de la tâche ; il est conservé d'une session à l'autre. Cette session prépare
le terrain, une seule fois. Ne fais rien d'autre que ce qui suit.

1. Clone le dépôt `repo` (au format owner/nom) dans /work/repo, en HTTPS avec
   le token de la variable d'environnement GH_TOKEN :
   `git clone https://x-access-token:$GH_TOKEN@github.com/<repo>.git /work/repo`
   Ne recopie jamais le token dans un fichier.
2. Dans /work/repo, crée la branche `branch` depuis la branche par défaut
   (`git switch -c <branch>`). Le nom et l'e-mail git sont dans l'environnement.
3. Lis le code pour comprendre le projet, puis écris /work/PLAN.md : une liste
   à cocher de **trois** aspects à documenter, pas plus, chacun en une ligne,
   du plus général au plus particulier. Exemple de forme :
   - [ ] règles et plateau — `morpion/board.py`
   - [ ] …

C'est tout. Ne documente rien, ne pousse rien, ne crée pas /exchange/DONE :
la tâche ne fait que commencer.
