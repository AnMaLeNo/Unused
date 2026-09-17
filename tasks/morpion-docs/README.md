# morpion-docs

Tâche d'exemple : documenter, un aspect par session, le dépôt `morpion`, et
pousser le résultat sur une branche.

- `setup` (une fois) : clone le dépôt avec `GH_TOKEN`, crée la branche, écrit
  le plan des aspects à documenter (trois, pas plus).
- `document` (en boucle) : prend le premier aspect non traité, écrit sa page
  dans `docs/`, commite et pousse, coche le plan. Quand tout est coché, crée
  `/exchange/DONE`.

Avant d'activer : mettre `OWNER/morpion` dans `params.repo`, et `GH_TOKEN` dans
le `.env` du démon (un token avec droit d'écriture sur ce dépôt).
