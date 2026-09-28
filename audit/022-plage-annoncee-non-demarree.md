# 022 — Plage annoncée mais pas encore démarrée : `start` concurrent (TOCTOU), `stop` sans pause ni effacement de `state.window`

**Fichiers examinés** : `src/daemon.ts:284-326` (`startWindow`/`stopWindow`), `src/daemon.ts:137-226`
(boucle `run`/`idle`/`execute`), `src/daemon.ts:328-361` (`status`), `src/api.ts:54-124`,
`src/cli.ts:34-83,178-181`, `src/scheduler.ts:56-80,141-149`, `src/docker.ts:27-80`, `src/duration.ts`
**Verdict** : 4 constats (3 sûrs, 1 probable)

## La garde de `startWindow` n'est pas tenue pendant ses deux appels Docker : deux `start` simultanés passent, et l'un des deux clients reçoit une fin de plage fictive

**Gravité** : sûr
**Où** : `src/daemon.ts:285-295`

`startWindow` teste l'exclusivité puis rend la main deux fois avant de poser sa
marque :

```ts
async startWindow(forMs: number): Promise<{ until: Date }> {
  if (this.running || this.manual) throw new ConflictError("une plage est déjà en cours"); // 285
  try {
    await this.deps.dockerVersion();                                                       // 287
  } catch (err) { ... }
  if (!(await this.deps.imageExists(this.cfg.docker.baseImage))) { ... }                    // 291
  const until = new Date(this.deps.now().getTime() + forMs);
  this.manual = { until, resumed: false };                                                  // 295
```

Entre la ligne 285 et la ligne 295 il n'y a aucun verrou, aucun drapeau
« démarrage en cours », et deux `await` sur du vrai I/O : `dockerVersion()` et
`imageExists()` lancent chacun un sous-processus `docker` (`src/docker.ts:28-33`,
`70-80`), soit deux allers-retours de plusieurs dizaines à plusieurs centaines de
millisecondes. `createApi` installe un handler `async` (`src/api.ts:55`) et la CLI
ouvre une connexion neuve par appel (`src/client.ts:24`) : deux requêtes sont donc
servies en parallèle, et rien ne les sérialise.

Scénario concret. Deux `POST /window` partent presque ensemble, A avec
`{"for":"8h"}`, B avec `{"for":"30m"}` (deux terminaux, ou un script qui relance
`unused start` sans attendre) :

1. A passe la garde (`running` et `manual` nuls), entre dans `dockerVersion()`.
2. B passe **la même** garde — `this.manual` est toujours nul — et entre dans
   `dockerVersion()`.
3. B ressort le premier, pose `this.manual = { until: +30m }`, réveille la boucle.
   `execute()` capture `manualUntil` dans `run.manualUntil` (`daemon.ts:146,180`) et
   `runWindow` fige sa fin sur `() => this.deadline(run.manualUntil)`
   (`daemon.ts:196`). B reçoit `200 { until: +30m }`.
4. A ressort, écrase `this.manual = { until: +8h }`, remet `fatal = null` et
   `pausedUntil = null`, et reçoit lui aussi `200 { until: +8h }`. La CLI affiche
   « plage démarrée jusqu'à \<+8h\> » (`src/cli.ts:73-74`).

Résultat obtenu : la plage s'arrête à +30m. À cet instant `execute()` passe dans son
`finally` et exécute inconditionnellement `this.manual = null` (`daemon.ts:223`,
`run.ac.signal.aborted` est faux) : la demande de 8 h de A est jetée sans une ligne
de journal. Entre-temps `status()` n'a jamais montré +8h non plus, puisque la
branche `if (run)` lit `this.deadline(run.manualUntil)` (`daemon.ts:335`) et ignore
`this.manual`. Résultat attendu : A reçoit un `409 « une plage est déjà en cours »`,
ou obtient réellement ses 8 heures.

Dans l'ordre inverse (A d'abord) le dégât est symétrique : la plage tourne 8 h, et
les 30 minutes annoncées à B ne sont honorées par rien — la réponse `200` est de la
pure fiction. Dans les deux cas le contrat documenté (`409` sur double `start`,
vérifié par `src/daemon.test.ts:105`) ne tient que parce que le test attend un
`await tick()` entre les deux appels.

## Un `stop` qui arrive pendant les vérifications Docker d'un `start` est refusé, et la plage démarre quand même

**Gravité** : sûr
**Où** : `src/daemon.ts:309-315` face à `src/daemon.ts:285-295`

Même trou, autre symptôme. Tant que `startWindow` est bloqué dans ses deux `docker`
(lignes 287 et 291), `this.running` **et** `this.manual` sont nuls. Un
`DELETE /window` servi pendant cet intervalle tombe donc sur :

```ts
if (!this.running) {
  if (this.manual) { ... }
  throw new ConflictError("aucune plage en cours");   // 314
}
```

Scénario concret : un script (ou un opérateur) enchaîne `unused start --for 8h` puis
`unused stop` sans attendre la fin du premier. Le `stop` reçoit `409 « aucune plage
en cours »` et sort en code 3 (`src/cli.ts:180`) — code que l'appelant lit comme
« il n'y avait rien à arrêter ». Puis `startWindow` termine, pose `this.manual`,
réveille la boucle, et la plage de 8 h tourne. Résultat obtenu : une plage de 8 h
alors que l'arrêt a été demandé *et* qu'on a répondu à l'appelant qu'il n'y avait
rien en cours. Résultat attendu : soit le `stop` annule la plage en cours de
démarrage, soit il attend que le `start` ait abouti — dans tous les cas il ne doit
pas affirmer qu'aucune plage n'existe alors qu'une est déjà acceptée.

## La branche « plage annoncée, pas encore démarrée » de `stopWindow` ne pose aucune pause, n'efface pas `state.window` et n'écrit rien sur disque

**Gravité** : probable
**Où** : `src/daemon.ts:308-315`

Le commentaire de `stopWindow` annonce la règle : « Les plages automatiques sont
mises en pause jusqu'à la fin de la couverture actuelle, sinon le calendrier
relancerait aussitôt » (`daemon.ts:303-307`). La branche qui traite la plage
annoncée mais pas encore démarrée fait exactement l'inverse :

```ts
if (!this.running) {
  if (this.manual) {
    this.manual = null;
    return { stopping: "now" };   // 312 — ni pausedUntil, ni state.window, ni saveState
  }
```

Elle saute les trois gestes de la branche normale (`daemon.ts:317-319` +
`daemon.ts:218-222`) : pas de `this.state.pausedUntil`, pas de
`this.state.window = null`, pas de `saveState`. Elle répond quand même
`stopping: "now"`, et la CLI imprime « plage arrêtée » (`src/cli.ts:82-83`).

Atteignabilité — j'ai tracé la boucle pour vérifier que l'état
`running === null && manual !== null` est bien observable par un handler HTTP :

- dans `idle()`, `this.manual` vient d'être remis à nul juste avant
  (`daemon.ts:152-153`) : jamais observable ;
- dans `execute()`, `this.running` est posé synchronement à l'entrée (ligne 188) et
  remis à nul en dernier dans le `finally` (ligne 224), sans `await` entre 224 et le
  tour de boucle suivant — la reprise de `await this.execute(...)` est une
  microtâche, qui passe avant tout callback d'I/O : jamais observable ;
- **reste `startWindow`** : `this.manual` est posé ligne 295, puis `await saveState(...)`
  ligne 298 fait du vrai I/O (`mkdir` + `writeFile` + `rename`, `src/state.ts:78-83`)
  et laisse donc passer une requête HTTP en attente, `this.running` encore nul.

Scénario concret, avec un calendrier configuré et une couverture ouverte
(`windows: [{ days:["mon"], from:"09:00", to:"18:00" }]`, il est 10 h), après un
`stop` qui a posé `pausedUntil = 18:00` :

1. `POST /window {"for":"8h"}` ; la requête atteint le `saveState` de la ligne 298,
   qui vient de remettre `pausedUntil` à nul (ligne 297).
2. `DELETE /window` est servi pendant ce `saveState` → branche ligne 310 →
   `this.manual = null`, réponse `200 {stopping:"now"}`, la CLI affiche « plage
   arrêtée ». Aucune pause n'est posée.
3. `startWindow` reprend, appelle `this.wake?.()` (ligne 299). La boucle repart avec
   `manualUntil = null`, mais `deadline(null)` vaut `calendarEnd(now)` = 18:00
   (`pausedUntil` est nul depuis l'étape 1) → `execute(null, false)` : une plage
   `calendar` démarre immédiatement.

Résultat obtenu : « plage arrêtée » puis une plage qui tourne jusqu'à 18 h, et un
`status` qui affiche `source: "calendar"`. Résultat attendu : `pausedUntil = 18:00`,
comme le fait la branche normale, donc plus rien jusqu'à 18 h.

Second dégât de la même branche, sur `state.window`. Après une panne globale,
`runWindow` conserve délibérément la plage sur disque (`src/scheduler.ts:147` :
`if (summary.endedBecause !== "fatal") state.window = null`) et `this.state.window`
reste donc non nul en mémoire. Un `stop` passé par la branche ligne 310 ne l'efface
pas et n'écrit rien : au redémarrage suivant, `init()` retrouve `state.window` avec
un `until` encore futur et **reprend la plage que l'utilisateur a explicitement
arrêtée** (`daemon.ts:98-102`). C'est le jumeau, côté « pas encore démarrée », du
même oubli que la branche normale, et il n'est couvert par aucun test : les tests de
`stop` passent tous par un `await tick()` qui garantit `this.running` non nul
(`src/daemon.test.ts:98-124`).

Gravité « probable » et non « sûr » : le défaut du code est certain (la branche saute
démonstrablement les trois gestes), mais le déclenchement demande une requête
concurrente pendant les quelques millisecondes du `saveState` de la ligne 298.

## Une durée invalide sur `POST /window` répond `500` et écrit une trace de pile dans le journal du démon

**Gravité** : sûr
**Où** : `src/api.ts:61-66` avec `src/api.ts:119-122`

La route valide le *type* de `body.for` mais pas sa forme, puis appelle
`parseDuration` hors de tout `try` :

```ts
if (typeof body.for !== "string") throw new HttpError(400, "champ `for` attendu (ex. \"8h\")");
const { until } = await daemon.startWindow(parseDuration(body.for));
```

`parseDuration` lève un `Error` nu sur tout ce qui ne colle pas au motif, y compris
une durée nulle (`total <= 0`, `src/duration.ts:13-15`). Le `catch` de `api.ts` ne
reconnaît ni `HttpError`, ni `ConflictError`, ni `NotFoundError` : il retombe sur
`status = 500` et exécute `console.error(err)` (`api.ts:119-121`).

Scénario concret : `unused start --for 8x` (ou `--for 0s`, ou un front qui envoie
`{"for":""}`). Résultat obtenu : `HTTP 500`, une trace de pile complète dans le
journal systemd du démon, et un code de sortie 1 côté CLI — indistinguable d'une
panne du démon, alors que `409` sort en 3 (`src/cli.ts:181`). Résultat attendu :
`400`, sans trace de pile, comme pour le champ `for` manquant juste au-dessus. Le
message reste correct pour l'humain (le texte de `parseDuration` remonte bien via
`{ error }`), le défaut est dans la classification et dans le bruit qu'elle produit —
important pour le « front pourra parler aux mêmes routes demain » annoncé en tête
d'`api.ts`.

## Ce qui a été vérifié et tient

- **`state.window` n'est jamais écrit par `startWindow`** : seul `runWindow` le pose
  (`src/scheduler.ts:78-79`). J'ai cherché une fenêtre où la plage acceptée serait
  perdue par un arrêt du service avant cette écriture : il n'y en a pas
  d'exploitable, car entre `this.wake?.()` (ligne 299) et `this.running = run`
  (ligne 188) il n'y a que des microtâches — la boucle entre dans `execute()` avant
  que le moindre callback d'I/O, y compris la réponse HTTP du `start`, ne s'exécute.
- **Ordre de démarrage du démon** (`src/cli.ts:41-59`) : `init()` peut poser
  `this.manual` (reprise) avant que `listen()` n'ouvre le socket, mais `daemon.run()`
  est appelé dans la même continuation synchrone que `listen()` et atteint
  `execute()` — donc `this.running = run` — sans céder la main. Aucune requête ne
  peut voir l'état « reprise annoncée, pas encore démarrée ».
- **Branche `else if (this.manual)` de `status()`** (`daemon.ts:346-360`) : elle
  annonce `startedAt: now` à chaque appel, donc un `startedAt` différent à chaque
  `status`, et `source: "manual"` même sous couverture calendaire. Même
  atteignabilité étroite que le constat 3 ; je ne le compte pas comme un constat
  distinct faute d'un dégât au-delà de l'affichage.
- **Capture de `manualUntil`** : `execute()` fige `run.manualUntil` (lignes 180, 196),
  donc une mutation ultérieure de `this.manual` ne peut pas raccourcir ni rallonger
  une plage déjà lancée. C'est ce qui rend le constat 1 silencieux plutôt que
  destructeur.
- **Gardes Docker de `startWindow`** (lignes 286-293) : les deux échecs sont bien
  convertis en `ConflictError` → `409`, message tronqué à la première ligne, et rien
  n'est écrit dans l'état avant elles — `fatal` et `pausedUntil` ne sont remis à nul
  qu'après (lignes 296-297).
- **`parseDuration`** refuse correctement `0`, le vide, les unités inconnues et les
  restes de chaîne (`last !== s.length`) : aucune plage de durée nulle ou négative ne
  peut être créée par cette route.
