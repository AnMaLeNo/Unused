# Documentation

- [Vue d'ensemble](vue-d-ensemble.md) — à quoi sert l'outil et comment ses pièces s'emboîtent (démon, CLI, tâches, Docker)
- [Le modèle de tâche](modele-de-tache.md) — graphe de skills, task.json, curseur
- [Le cycle d'une itération](cycle-d-iteration.md) — session `claude -p`, classification de l'issue, commit ou rejet
- [Le container comme état persistant](container-etat-persistant.md) — commit, rotation `:prev`, aplatissement
- [Le parsing de la sortie Claude](parsing-sortie-claude.md) — stream-json, terminal_reason, quota
- [Le scheduler](scheduler.md) — round-robin, attente sur quota saturé, fin de plage
- [Le démon](le-demon.md) — boucle principale, plages manuelles/auto cumulées, pannes globales, reprise après redémarrage
- [Les plages automatiques](plages-automatiques.md) — calcul de couverture et prochain départ
- [L'API HTTP et la CLI cliente](api-et-cli.md) — routes du démon, socket Unix, streaming, `unused` en ligne de commande
- [La configuration du démon](configuration-du-demon.md) — schéma `unused.config.json`, résolution des chemins, chargement du `.env`
- [Les logs d'itération](logs-d-iteration.md) — `IterationRecord`, fichier par itération et `index.jsonl`, rapprochement coût/quota
- [Écrire et créer une tâche](creer-une-tache.md) — structure de dossier, `unused tasks new`, scaffold, exemple
