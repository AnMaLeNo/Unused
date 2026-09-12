import type { Config } from "./config.js";
import { formatDuration } from "./duration.js";
import { pickNext } from "./graph.js";
import { iterate, type IterateResult } from "./iterate.js";
import { saveState, type RunnerState } from "./state.js";
import type { Task } from "./task.js";

export interface WindowSummary {
  iterations: number;
  completed: number;
  backoffs: number;
  failures: number;
  costUsd: number;
  endedBecause: "window" | "nothing-eligible" | "stopped";
}

export interface SchedulerDeps {
  runIteration: (task: Task, state: RunnerState, signal: AbortSignal) => Promise<IterateResult>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  print: (line: string) => void;
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
 */
export async function runWindow(
  cfg: Config,
  tasks: Task[],
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
    ...partial,
  };
  const summary: WindowSummary = { iterations: 0, completed: 0, backoffs: 0, failures: 0, costUsd: 0, endedBecause: "window" };

  const startedAt = deps.now();
  state.window = { startedAt: startedAt.toISOString(), until: until.toISOString() };
  await saveState(cfg.dataDir, state);
  deps.print(`plage jusqu'à ${until.toISOString()} (${formatDuration(until.getTime() - startedAt.getTime())})`);

  while (!signal.aborted && deps.now() < until) {
    const task = pickNext(tasks, state);
    if (!task) {
      summary.endedBecause = "nothing-eligible";
      deps.print("plus aucune tâche éligible");
      break;
    }
    deps.print(`\n[${deps.now().toISOString()}] itération ${summary.iterations + 1} — ${task.name}`);
    const r = await deps.runIteration(task, state, signal);
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
    // La plage reste enregistrée : `run --resume` pourra la reprendre.
  } else {
    state.window = null;
    await saveState(cfg.dataDir, state);
  }
  deps.print(
    `\nfin de plage (${summary.endedBecause}) : ${summary.iterations} itérations, ${summary.completed} completed, ` +
      `${summary.failures} échecs, ${summary.backoffs} attentes quota, $${summary.costUsd.toFixed(2)}`,
  );
  return summary;
}
