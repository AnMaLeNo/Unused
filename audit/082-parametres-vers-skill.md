# 082 — Les paramètres jusqu'au skill : placeholder du squelette, clé inconnue, `$ARGUMENTS` absent

**Fichiers examinés** : `src/claude.ts:1-18` (`renderArguments`, `buildPrompt`),
`src/task.ts:27-49` (`NodeSchema.params`, `TaskFileSchema.params`),
`src/task.ts:108-110` (`skillFile`), `src/task.ts:121-161` (`loadTask`, la seule
validation côté skill), `src/scaffold.ts:5-14` (`TASK_JSON`), `:16-42` (README
généré), `:44-86` (skills `setup` et `work` générés), `:88-103` (`scaffoldTask`),
`src/iterate.ts:84-93` et `:120-127` (prompt sur stdin, montage des skills),
`src/docker.ts:107-150` (`runInTask`, `-i`, `child.stdin.end(prompt)`),
`src/graph.ts:40-53` (`classify`), `src/daemon.ts:410-418` (`setActive`),
`src/api.ts:72-80`, `src/claude.test.ts:10-22`, `docker/Dockerfile`,
`README.md:56-73`.

Trois sondes neuves ont été passées contre le binaire réellement installé par
`docker/Dockerfile` — `claude 2.1.272`, toujours la version présente dans ce
container —, en reproduisant le dispositif du runner : skills dans
`<cwd>/.claude/skills/<nom>/SKILL.md` avec `disable-model-invocation: true`,
prompt sur stdin, `-p --output-format stream-json --verbose
--dangerously-skip-permissions`. Aucun token n'est exposé dans le container
(`CLAUDE_CODE_OAUTH_TOKEN` n'est pas dans l'environnement de la session) : les
sondes s'arrêtent sur `Not logged in · Please run /login`, donc **sans consommer
de quota**, ce qui suffit ici puisque tout ce qui se joue — résolution de la
commande, substitution des arguments, injection du corps du SKILL.md — se
produit avant l'appel API et reste lisible dans le transcript
(`/root/.claude/projects/-tmp-p1/`, `-tmp-p2/`).

**Verdict** : rien trouvé. Les trois soupçons de l'aspect ont été instruits un
par un : deux sont des défauts déjà consignés (constats 012 et 054), le
troisième — « `$ARGUMENTS` absent du SKILL.md : perte silencieuse » — est
**faux**, et je le démontre ci-dessous plutôt que de le laisser traîner. Ce
rapport n'ajoute donc pas de constat ; il ajoute des preuves et ferme l'aspect.

## Ce qui a été vérifié et tient

### 1. `$ARGUMENTS` absent du SKILL.md : rien ne se perd (sonde)

Le soupçon était qu'un skill écrit à la main sans `$ARGUMENTS` fasse disparaître
les params sans un mot. La CLI ne laisse pas ce trou. Deux skills identiques à
un détail près, tous deux `disable-model-invocation: true` comme ceux que génère
`scaffold.ts` :

```
$ cd /tmp/p1 && printf '/u repo=a/b mode=fast\n' | claude -p --output-format stream-json --verbose --dangerously-skip-permissions
$ grep -o 'MARQUEUR-U[^"]*' /root/.claude/projects/-tmp-p1/36d10cc8*.jsonl
MARQUEUR-U sans placeholder.\n\n\nARGUMENTS: repo=a/b mode=fast
```

Le corps dépourvu de placeholder se voit **ajouter** une ligne
`ARGUMENTS: repo=a/b mode=fast`. Et en amont, le cadre de commande porte de
toute façon les arguments une seconde fois, indépendamment du corps :

```
"role":"user","content":"<command-message>t</command-message>\n<command-name>/t</command-name>\n<command-args>repo= note=\"deux mots\" branch name=audit</command-args>"
```

Donc, avec ou sans `$ARGUMENTS`, la chaîne produite par `renderArguments` arrive
dans le message utilisateur. Le `disable-model-invocation: true` du squelette ne
change rien à ce passage. (Confirme et élargit le dernier point du constat 034,
qui ne testait pas le cas `disable-model-invocation`.)

### 2. Un prompt sans saut de ligne final résout bien la commande (sonde)

Point jamais vérifié et dont dépend *chaque* itération : `iterate.ts:123` passe
`stdin: prompt` et `docker.ts:58` fait `child.stdin.end(opts.stdin)` — le flux
se termine donc sur `b"` ou sur un chiffre, **sans `\n`**, puisque `buildPrompt`
n'en ajoute pas (`claude.ts:17`). Si la CLI avait exigé une ligne complète pour
reconnaître une commande, toutes les sessions du projet tourneraient sur du
texte brut. Ce n'est pas le cas :

```
$ printf '/t repo=a/b note="deux mots"' | claude -p … # pas de \n final
$ grep -o 'Base directory for this skill[^"]*' /root/.claude/projects/-tmp-p2/*.jsonl
Base directory for this skill: /tmp/p2/.claude/skills/t\n\nParametres : repo=a/b note=\"deux mots\"
```

Commande résolue, corps injecté, arguments substitués. Rien à signaler.

### 3. Valeur vide et valeur entre guillemets : transmises littéralement

`renderArguments` rend `repo=` pour une valeur vide (le motif
`/^[\w./:@+-]*$/` accepte la chaîne vide, d'où la branche nue) et
`note="deux mots"` sinon. Les deux formes traversent la CLI telles quelles,
guillemets compris — c'est au skill de les interpréter, comme l'annonce le
commentaire `claude.ts:4-7` et le README (`README.md:72-73`). Aucune
normalisation, aucune perte, aucun échappement supplémentaire. Vérifié dans la
sonde 1 (`Parametres : repo= note="deux mots" branch name=audit`).

### 4. Clé de param non échappée : défaut réel, déjà consigné (012)

`renderArguments` soigne la valeur (jeu nu excluant l'espace, le `=` et le
guillemet ; `JSON.stringify` sinon) mais reprend la clé telle quelle, et
`params: z.record(z.string())` (`task.ts:33` et `:45`) n'impose aucune forme aux
clés — contrairement à `env` (`ENV_ENTRY_RE`, `task.ts:27`) et au nom de tâche
(`TASK_NAME_RE`). C'est le troisième constat du rapport **012**, rien à y
ajouter sur le plan du code.

Ce que la sonde 1 apporte, c'est la fin de la chaîne, que 012 n'avait pas pu
observer : la clé fautive `branch name` arrive **verbatim** jusque dans le corps
du skill (`Parametres : repo= note="deux mots" branch name=audit`). Ni le cadre
`<command-args>`, ni la substitution, ni la ligne `ARGUMENTS:` ne recomposent ou
ne refusent la paire cassée. Le silence que 012 décrivait est donc complet et
mesuré : deux paramètres là où `task.json` en déclarait un, et aucune surface,
d'un bout à l'autre, qui le remarque.

### 5. Placeholder du squelette laissé tel quel : défaut réel, déjà consigné (054)

`TASK_JSON` livre `params: { repo: "owner/projet" }` (`scaffold.ts:8`) et
`active: false` ; `unused tasks activate` ne fait que basculer ce booléen
(`daemon.ts:410-418`) sans rien regarder d'autre. Une tâche activée sans que le
placeholder ait été remplacé n'est arrêtée par rien : le nœud `setup` échoue à
cloner, le dit en prose, rend la main → `terminal_reason: "completed"` →
`classify` renvoie `completed` (`graph.ts:48`), le container est commité, le
curseur avance. C'est exactement le scénario concret du **constat 1 du rapport
054** (qui cite d'ailleurs « je n'ai pas pu cloner owner/projet »), prolongé par
058 (absence de détection de surplace) et 032 (params changés sous un container
déjà constitué). Rien de nouveau : la racine n'est pas dans le squelette mais
dans le fait qu'aucun succès n'est jamais confronté à son effet.

### 6. Le reste du chemin des params

- **Fusion et ordre** : `{...taskParams, ...node.params}` (`claude.ts:16`) — le
  nœud gagne, la clé garde sa position d'origine ; couvert par `claude.test.ts:19-21`.
  `args` falsy uniquement si l'objet fusionné est vide, d'où le `/${skill}` nu.
- **Clé « inconnue » au sens de non consommée** : une clé que le SKILL.md
  n'exploite pas ne peut rien casser — tout part dans une seule chaîne libre, il
  n'existe aucun mécanisme de rejet côté CLI (sondes 1 et 2 : `repo=`, `mode`,
  `branch name` passent sans distinction). Il n'y a donc pas de défaut à
  chercher de ce côté : l'absence de validation d'un vocabulaire de params est
  une propriété du contrat `$ARGUMENTS`, pas un bug.
- **Types** : `z.record(z.string())` refuse un params non-string (`"count": 3`)
  et un `params: null` ; l'erreur sort au chargement et la tâche apparaît dans
  `taskErrors` (`task.ts:135-138`, `cli.ts:122`). Pas de perte muette par là.
- **Squelette valide** : les clés de `TASK_JSON` satisfont les deux schémas
  `.strict()`, `start` ∈ `nodes`, les deux `next` existent, et les dossiers
  `skills/setup` et `skills/work` correspondent aux noms de skill des nœuds —
  le squelette se charge donc sans réserve (il est le seul cas où le nom de
  dossier et le `name:` du frontmatter sont garantis cohérents, cf. 034).
- **Sans gravité** : le `repo` du squelette est un slug (`owner/projet`,
  `scaffold.ts:8`) là où le README du dépôt montre une URL complète
  (`README.md:62`) ; les deux formes ne sont que du texte pour le skill, qui
  doit de toute façon fabriquer l'URL avec `GH_TOKEN` lui-même
  (`scaffold.ts:56-58`). Divergence de documentation, pas de défaut de code.

## Note de méthode

Trois dossiers de sonde ont été laissés dans le container
(`/tmp/p1`, `/tmp/p2`, plus les transcripts sous `/root/.claude/projects/`) ;
ils ne touchent ni le dépôt ni `/exchange`. Rien d'autre n'a été modifié : cette
session n'a fait qu'observer.
