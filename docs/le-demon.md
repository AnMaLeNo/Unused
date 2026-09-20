# Le démon

`Daemon` (`src/daemon.ts`) est le processus longue durée lancé par
`unused daemon` (généralement via systemd, voir `deploy/`). C'est le seul
propriétaire de `state.json` (`src/state.ts`) : il décide *quand* une plage de
travail tourne, délègue le travail lui-même au [scheduler](scheduler.md), et
sert l'état courant à l'API HTTP (`src/api.ts`) consommée par la CLI cliente.

## Deux sources de plages, cumulées

Une plage peut venir de deux endroits, et le démon ne fait pas vraiment de
différence entre elles une fois qu'elles se recouvrent :

- **manuelle** : `unused start --for <durée>` → `startWindow()` pose
  `this.manual = { until, resumed: false }`.
- **automatique** : les `windows` du fichier de config (voir
  `src/calendar.ts`), dont la couverture à un instant donné est calculée par
  `coverageEnd()`.

La méthode `deadline()` prend la fin de plage effective comme le **plus tard**
entre les deux :

```ts
private deadline(manualUntil: Date | null): Date {
  const now = this.deps.now();
  const calendar = this.calendarEnd(now);
  const ends = [manualUntil, calendar].filter((d): d is Date => d !== null).map((d) => d.getTime());
  return ends.length > 0 ? new Date(Math.max(...ends)) : now;
}
```

Concrètement : si une plage automatique commence pendant qu'une plage
manuelle est en cours, elle ne l'interrompt pas — elle la prolonge jusqu'à sa
propre fin si celle-ci est plus tardive. C'est visible dans le statut exposé
par l'API : `window.source` vaut `"manual"`, `"calendar"` ou
`"manual+calendar"` selon ce qui est actif au moment de l'appel
(`source()`, `src/daemon.ts:245`).

## La boucle principale

```ts
async run(signal: AbortSignal): Promise<void> {
  ...
  while (!signal.aborted) {
    const manualUntil = this.manual?.until ?? null;
    if (this.deadline(manualUntil).getTime() > this.deps.now().getTime()) {
      const resumed = this.manual?.resumed ?? false;
      await this.execute(manualUntil, resumed);
      continue;
    }
    this.manual = null;
    await this.idle(signal);
  }
}
```

À chaque tour : s'il y a une plage en cours (deadline dans le futur),
`execute()` délègue au scheduler jusqu'à cette deadline ; sinon `idle()`
attend soit un réveil explicite (`this.wake`, posé par `startWindow()` ou
`unpause()`), soit l'heure de la prochaine plage automatique
(`nextCalendarStart()`), la première échéance qui arrive.

`execute()` appelle `runWindow()` (voir [le scheduler](scheduler.md)) avec une
`deadline` passée en **fonction**, pas en valeur figée :
`() => this.deadline(run.manualUntil)`. Le scheduler la réévalue à chaque
itération, ce qui est ce qui permet à une plage automatique de prolonger une
plage manuelle en cours sans que le scheduler ait besoin de rien savoir sur
les plages elles-mêmes.

## Panne globale (`fatal`)

Si `runWindow()` renvoie un résumé avec `fatal` renseigné (panne `auth` ou
`docker`, voir [le cycle d'une itération](cycle-d-iteration.md)), le démon
bascule dans un état arrêté :

```ts
if (this.lastWindow.fatal) {
  this.fatal = { ...this.lastWindow.fatal, at: this.deps.now().toISOString() };
  this.deps.print(`PANNE ${this.fatal.reason} : ... — plus rien ne tourne jusqu'à un \`unused start\` ...`);
}
```

Tant que `this.fatal` est non nul : `calendarEnd()` renvoie toujours `null`
(donc aucune plage automatique ne redémarre) et `nextCalendarStart()` aussi.
Seul un `unused start` explicite (`startWindow()` remet `this.fatal = null`)
ou un redémarrage complet du service en sort. C'est une panne globale au sens
où elle bloque toutes les tâches, pas seulement celle qui l'a déclenchée.

## Reprise après redémarrage

`state.window` (juste `{ startedAt, until }`) est écrit dès qu'une plage
démarre (`runWindow()`, `src/scheduler.ts:78`) et effacé à sa fin normale —
sauf en cas de panne (`src/scheduler.ts:147`, voir
[le scheduler](scheduler.md)). Au démarrage du démon, `init()` regarde s'il en
reste un :

```ts
async init(): Promise<void> {
  this.state = await loadState(this.cfg.dataDir);
  if (this.state.window) {
    const until = new Date(this.state.window.until);
    if (until.getTime() > this.deps.now().getTime()) {
      this.manual = { until, resumed: true };
      this.deps.print(`plage interrompue trouvée, reprise jusqu'à ${until.toISOString()}`);
    } else {
      this.deps.print("plage enregistrée expirée, oubliée");
      this.state.window = null;
      await saveState(this.cfg.dataDir, this.state);
    }
  }
  ...
}
```

Si le service a été coupé (redémarrage système, `systemctl restart`, panne)
pendant une plage encore valide, elle repart comme une plage manuelle
(`resumed: true`) jusqu'à la même échéance ; si son terme est déjà dans le
passé, elle est simplement oubliée. C'est pour ça que `SIGINT`/`SIGTERM` dans
`src/cli.ts` n'essaient pas de finir proprement : ils abandonnent
l'itération en cours (`ac.abort()`) en sachant que la plage sera reprise au
prochain démarrage.

Un arrêt **explicite** (`unused stop`) est différent : `stopWindow()` marque
`run.explicitStop = true`, et `execute()` efface alors `state.window` dans son
`finally` — cette plage-là ne doit pas revenir toute seule après un
redémarrage.

## Pause des plages automatiques (`pausedUntil`)

`state.pausedUntil` sert à empêcher une plage automatique de repartir aussitôt
dans deux cas :

- **rien à faire** : le scheduler finit avec `endedBecause === "nothing-eligible"`
  (toutes les tâches actives sont `done`/`failed`) → `pauseUntil()` met en
  pause jusqu'à la fin de la couverture calendaire actuelle. Inutile de
  relancer un container toutes les X minutes si aucune tâche n'est éligible.
- **arrêt explicite** (`unused stop`) : même chose, sans quoi le calendrier
  relancerait une plage automatique immédiatement après l'avoir arrêtée.

`resetTask()` et `setActive(name, true)` appellent `unpause()`, qui efface
`pausedUntil` et réveille la boucle (`this.wake?.()`) : réactiver une tâche ou
la remettre à zéro lève la pause tout de suite plutôt que d'attendre la
prochaine couverture.

Notez la garde dans `pauseUntil()` :

```ts
private async pauseUntil(until: Date, why: string): Promise<void> {
  if (this.cfg.windows.length === 0) return;
  ...
}
```

Sans plage automatique configurée, la pause n'a pas de sens (une plage
manuelle ne revient jamais seule) : elle est donc silencieusement ignorée.

## Ce que le démon expose

`status()` construit un `DaemonStatus` complet à partir de l'état en mémoire
(`this.running`, `this.manual`, `this.fatal`) et de l'état disque
(`state.tasks`, `state.pausedUntil`) : fenêtre en cours avec ses compteurs
live (`iterations`, `completed`, `failures`, `backoffs`, `costUsd`, tâche
courante), prochaine plage automatique, pause en cours, panne éventuelle, et
la liste des tâches avec leur curseur et leur statut. C'est ce que
`unused status` affiche côté CLI, via `src/api.ts` et `src/client.ts`.

Les commandes `startWindow`, `stopWindow`, `resetTask` et `setActive` sont les
seules à modifier l'état du démon depuis l'extérieur ; toutes passent par
l'API HTTP, jamais directement par le fichier `state.json`.
