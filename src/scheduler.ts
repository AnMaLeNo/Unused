import type { Config } from "./config.js";
import { formatDuration } from "./duration.js";
import { pickNext } from "./graph.js";
import { iterate, type IterateResult } from "./iterate.js";
import { ensureTaskState, saveState, type RunnerState } from "./state.js";
import type { Task } from "./task.js";

export interface WindowSummary {
  iterations: number;
  completed: number;
  backoffs: number;
  failures: number;
  costUsd: number;
  endedBecause: "window" | "nothing-eligible" | "stopped";
}

export type SchedulerEvent =
  | { type: "iteration-start"; task: string; node: string; at: string }
  | { type: "iteration-end"; task: string; node: string; result: IterateResult }
  | { type: "backoff"; ms: number }
  | { type: "end"; summary: WindowSummary };

export interface SchedulerDeps {
  runIteration: (task: Task, state: RunnerState, signal: AbortSignal) => Promise<IterateResult>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  print: (line: string) => void;
  // Arrêt gracieux : vrai → on finit l'itération en cours et on s'arrête là.
  shouldStop: () => boolean;
  onEvent: (event: SchedulerEvent) => void;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/**
 * Fait tourner les tâches actives jusqu'à `until`, en round-robin, une
 * itération à la fois. Une itération commencée avant la fin de la plage va
 * jusqu'au bout. Sur quota saturé, tout le monde attend `backoffMinutes`.
 * Les tâches sont rechargées avant chaque itération si un chargeur est donné :
 * modifier un task.json ou un skill pendant la plage est pris en compte.
 */
export async function runWindow(
  cfg: Config,
  tasks: Task[] | (() => Promise<Task[]>),
  state: RunnerState,
  until: Date,
  signal: AbortSignal,
  partial: Partial<SchedulerDeps> = {},
): Promise<WindowSummary> {
  const deps: SchedulerDeps = {
    runIteration: (task, st, sig) => iterate(cfg, task, st, { print: (l) => deps.print(`  ${l}`), signal: sig }),
    sleep,
    now: () => new Date(),
    print: () => {},
    shouldStop: () => false,
    onEvent: () => {},
    ...partial,
  };
  const loadTasks = typeof tasks === "function" ? tasks : async () => tasks;
  const summary: WindowSummary = { iterations: 0, completed: 0, backoffs: 0, failures: 0, costUsd: 0, endedBecause: "window" };

  const startedAt = deps.now();
  state.window = { startedAt: startedAt.toISOString(), until: until.toISOString() };
  await saveState(cfg.dataDir, state);
  deps.print(`plage jusqu'à ${until.toISOString()} (${formatDuration(until.getTime() - startedAt.getTime())})`);

  let stopped = false;
  while (!signal.aborted && deps.now() < until) {
    if (deps.shouldStop()) {
      stopped = true;
      break;
    }
    const task = pickNext(await loadTasks(), state);
    if (!task) {
      summary.endedBecause = "nothing-eligible";
      deps.print("plus aucune tâche éligible");
      break;
    }
    const node = ensureTaskState(state, task).cursor;
    const at = deps.now().toISOString();
    deps.print(`\n[${at}] itération ${summary.iterations + 1} — ${task.name}`);
    deps.onEvent({ type: "iteration-start", task: task.name, node, at });
    const r = await deps.runIteration(task, state, signal);
    deps.onEvent({ type: "iteration-end", task: task.name, node, result: r });
    if (r.outcome.kind === "failure" && r.outcome.reason === "aborted") break;
    summary.iterations += 1;
    summary.costUsd += r.costUsd ?? 0;

    switch (r.decision) {
      case "next-task":
      case "task-done":
        summary.completed += 1;
        break;
      case "backoff": {
        summary.backoffs += 1;
        const remaining = until.getTime() - deps.now().getTime();
        const wait = Math.min(cfg.scheduler.backoffMinutes * 60_000, remaining);
        if (wait <= 0) break;
        deps.print(`  quota saturé, attente ${formatDuration(wait)}`);
        deps.onEvent({ type: "backoff", ms: wait });
        await deps.sleep(wait, signal);
        break;
      }
      case "retry":
      case "task-failed": {
        summary.failures += 1;
        if (r.decision === "task-failed") deps.print(`  ${task.name} sortie de la file après ${cfg.scheduler.maxConsecutiveFailures} échecs consécutifs`);
        const wait = Math.min(cfg.scheduler.retrySeconds * 1000, until.getTime() - deps.now().getTime());
        if (wait > 0) await deps.sleep(wait, signal);
        break;
      }
    }
  }

  if (signal.aborted) {
    summary.endedBecause = "stopped";
    // La plage reste enregistrée : le démon la reprendra au prochain démarrage.
  } else {
    if (stopped) summary.endedBecause = "stopped";
    state.window = null;
    await saveState(cfg.dataDir, state);
  }
  deps.onEvent({ type: "end", summary });
  deps.print(
    `\nfin de plage (${summary.endedBecause}) : ${summary.iterations} itérations, ${summary.completed} completed, ` +
      `${summary.failures} échecs, ${summary.backoffs} attentes quota, $${summary.costUsd.toFixed(2)}`,
  );
  return summary;
}
