---
name: document
description: Documente un seul aspect du dépôt, commite, pousse, puis rend la main.
disable-model-invocation: true
---

Paramètres : $ARGUMENTS

Tu reprends un container préparé par le skill setup : le dépôt est dans
/work/repo sur la branche `branch`, le plan dans /work/PLAN.md. Une session =
un seul aspect. Si /work/PLAN.md n'existe pas, dis-le et rends la main.

1. Lis /work/PLAN.md et prends la première case non cochée. S'il n'y en a
   aucune, crée le fichier /exchange/DONE et arrête-toi là : la tâche est finie.
2. Documente cet aspect, et lui seul, dans /work/repo/docs/<nom-court>.md :
   à quoi il sert, comment il fonctionne, comment on s'en sert, avec des
   extraits de code réels. Une page courte et juste vaut mieux qu'une longue.
   Ajoute une ligne vers cette page dans /work/repo/docs/README.md (crée-le
   au premier passage).
3. Coche la case dans /work/PLAN.md.
4. Commite dans /work/repo (`docs: <aspect>`) et pousse la branche :
   `git push -u origin <branch>`. Le dépôt distant accepte le token déjà
   présent dans l'URL du clone.

Puis rends la main sans rien faire d'autre : une autre session prendra
l'aspect suivant.
