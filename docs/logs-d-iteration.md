# Les logs d'itération et le rapprochement coût/quota

`src/log.ts` écrit, à la fin de chaque itération, une trace complète de ce qui
vient de se passer — commande lancée, sortie de `claude`, coût, quota avant et
après. C'est `iterate()` (`src/iterate.ts`) qui construit cet enregistrement
et appelle `writeIterationLog` juste avant de rendre la main à l'appelant
(démon ou CLI, voir [le cycle d'une itération](cycle-d-iteration.md)).

## `IterationRecord`

Toute l'information d'une itération tient dans une seule interface :

```ts
export interface IterationRecord {
  task: string;
  node: string;
  skill: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  image: string;
  container: string;
  command: string[];
  prompt: string;
  exitCode: number;
  timedOut: boolean;
  model: string | null;
  // Les fenêtres de quota (5 h / 7 j) au premier et au dernier événement de la
  // session : c'est ce qui permet de rapprocher un coût en $ d'un % de quota.
  quota: { before: QuotaSnapshot | null; after: QuotaSnapshot | null };
  // Le message `result` final, tel quel.
  result: ClaudeResult | null;
  rateLimits: RateLimitInfo[];
  apiRetries: { error?: string; error_status?: number | null }[];
  // Sortie brute si le JSON était illisible, pour comprendre pourquoi.
  rawStdout?: string;
  stderr: string;
  done: boolean;
  outcome: Outcome;
  decision: Decision;
  committed: boolean;
}
```

`quota`, `result` et `rateLimits` viennent tels quels du parsing de la sortie
`claude` décrit dans [le parsing de la sortie Claude](parsing-sortie-claude.md) ;
`outcome` et `decision` viennent de la classification décrite dans
[le cycle d'une itération](cycle-d-iteration.md). `log.ts` ne fait que les
assembler et les persister — il ne recalcule rien.

Dans `iterate.ts`, l'enregistrement est construit à partir de la session et de
l'issue déjà déterminées :

```ts
const rec: IterationRecord = {
  task: task.name,
  node: nodeName,
  skill: node.skill,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  durationMs: endedAt.getTime() - startedAt.getTime(),
  image: r.image,
  container: r.container,
  command,
  prompt,
  exitCode: r.code,
  timedOut,
  model: model ?? null,
  quota: { before: quotaBefore, after: quotaAfter },
  result: session.result,
  rateLimits: session.rateLimits,
  apiRetries: session.apiRetries,
  ...(session.result === null ? { rawStdout: r.stdout } : {}),
  stderr: r.stderr,
  done,
  outcome,
  decision: finalDecision,
  committed,
};
const logFile = await writeIterationLog(cfg, rec);
```

`rawStdout` n'est ajouté que si `session.result` est `null`, c'est-à-dire si
`parseStream` n'a trouvé aucune ligne `result` exploitable — le seul cas où
relire la sortie brute sert à quelque chose.

## Deux écritures par itération

`writeIterationLog` écrit à deux endroits, avec deux niveaux de détail :

```ts
export function logsDir(cfg: Config): string {
  return path.join(cfg.dataDir, "logs");
}

/** Un fichier par itération, plus une ligne compacte dans index.jsonl. */
export async function writeIterationLog(cfg: Config, rec: IterationRecord): Promise<string> {
  const dir = path.join(logsDir(cfg), rec.task);
  await mkdir(dir, { recursive: true });
  const stamp = rec.startedAt.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${rec.node}.json`);
  await writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
  ...
```

- **Un fichier JSON complet par itération**, sous
  `<dataDir>/logs/<task>/<startedAt>-<node>.json` (l'horodatage est celui de
  `startedAt`, avec `:` et `.` remplacés par `-` pour rester un nom de fichier
  valide sur tous les systèmes). Il contient l'`IterationRecord` intégral,
  y compris `prompt`, `stderr`, `result` et tous les `rateLimits` — de quoi
  rejouer ou déboguer une itération précise sans rien reconstruire.
- **Une ligne compacte** ajoutée à `<dataDir>/logs/index.jsonl`, un résumé
  pensé pour être parcouru ou agrégé sans charger chaque fichier :

```ts
const line = {
  at: rec.startedAt,
  task: rec.task,
  node: rec.node,
  outcome: rec.outcome.kind === "completed" ? "completed" : rec.outcome.kind === "fatal" ? `fatal:${rec.outcome.reason}` : rec.outcome.reason,
  done: rec.done,
  decision: rec.decision,
  durationMs: rec.durationMs,
  costUsd: rec.result?.total_cost_usd ?? null,
  turns: rec.result?.num_turns ?? null,
  model: rec.model,
  fiveHourBefore: rec.quota.before?.five_hour?.utilization ?? null,
  fiveHourAfter: rec.quota.after?.five_hour?.utilization ?? null,
  sevenDayBefore: rec.quota.before?.seven_day?.utilization ?? null,
  sevenDayAfter: rec.quota.after?.seven_day?.utilization ?? null,
  file: path.relative(cfg.dataDir, file),
};
await appendFile(path.join(logsDir(cfg), "index.jsonl"), JSON.stringify(line) + "\n", "utf8");
```

`file` pointe, en chemin relatif à `dataDir`, vers le fichier complet
correspondant — `index.jsonl` sert de sommaire, pas de substitut.

## Le rapprochement coût/quota

L'intérêt central de `index.jsonl` est de mettre côte à côte, pour la même
itération, ce que `claude` a coûté en dollars (`costUsd`, `turns`, `model`,
tirés de `rec.result`) et où en était le quota par abonnement (`fiveHourBefore`
→ `fiveHourAfter`, `sevenDayBefore` → `sevenDayAfter`, tirés de `rec.quota`).
Les deux mesurent la même session sous deux angles différents : `total_cost_usd`
est calculé par `claude` lui-même à partir des tokens consommés, tandis que
`utilization` reflète la part du quota d'abonnement (fenêtres glissantes 5 h et
7 j) déjà utilisée. En les alignant ligne par ligne, on peut par exemple
repérer combien de `%` de quota correspond en moyenne à un coût donné, ou
repérer qu'une itération chère n'a presque pas fait bouger le quota (signe
qu'elle a été payée hors abonnement).

`iterate.ts` affiche d'ailleurs les deux à la fin de chaque itération, dans le
même esprit :

```ts
if (session.result?.total_cost_usd !== undefined) {
  print(`coût     $${session.result.total_cost_usd.toFixed(4)}, ${session.result.num_turns ?? "?"} tours${model ? `, ${model}` : ""}`);
}
if (quotaAfter) print(`quota    ${describeQuota(quotaBefore)} → ${describeQuota(quotaAfter)}`);
```

`describeQuota` formate un `QuotaSnapshot` en pourcentages lisibles :

```ts
export function describeQuota(q: QuotaSnapshot | null): string {
  if (!q) return "?";
  const pct = (w?: { utilization: number }) => (w ? `${Math.round(w.utilization * 1000) / 10}%` : "?");
  return `5h ${pct(q.five_hour)} / 7j ${pct(q.seven_day)}`;
}
```

## Ce qui n'est volontairement pas fait

`log.ts` n'expose aucune lecture — pas de fonction pour relire `index.jsonl`
ou reconstruire un historique, ni de route API ou de sous-commande CLI dédiée
(voir [l'API HTTP et la CLI cliente](api-et-cli.md), qui n'en a pas). Les
fichiers sont des artefacts sur disque, faits pour être parcourus directement
(`jq`, `grep`, un script ad hoc) ou récupérés depuis `<dataDir>/logs`,
elle-même sous le `dataDir` de configuration (voir
[la configuration du démon](configuration-du-demon.md)). C'est délibérément le
niveau de détail le plus bas de l'outil : tout le reste (état des tâches,
curseur, décisions) est dérivé ou recalculable, alors que le contenu exact
d'une session `claude` — prompt, sortie, coût, quota — ne l'est pas et doit
être conservé tel quel.
