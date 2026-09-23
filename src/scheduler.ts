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
  endedBecause: "window" | "nothing-eligible" | "stopped" | "fatal";
  fatal?: { reason: "auth" | "docker"; detail: string };
}

export type SchedulerEvent =
  | { type: "iteration-start"; task: string; node: string; at: string }
  | { type: "iteration-end"; task: string; node: string; result: IterateResult }
  | { type: "backoff"; ms: number; until: string }
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
 * Fait tourner les tâches actives jusqu'à `deadline()`, en round-robin, une
 * itération à la fois. Une itération commencée avant la fin de la plage va
 * jusqu'au bout. Sur quota saturé, tout le monde dort jusqu'au reset annoncé
 * (sinon `backoffMinutes`). La fin de plage est réévaluée à chaque tour : une
 * plage automatique qui s'ouvre pendant une plage manuelle la prolonge.
 * Les tâches sont rechargées avant chaque itération si un chargeur est donné :
 * modifier un task.json ou un skill pendant la plage est pris en compte.
 */
export async function runWindow(
  cfg: Config,
  tasks: Task[] | (() => Promise<Task[]>),
  state: RunnerState,
  deadline: Date | (() => Date),
  signal: AbortSignal,
  partial: Partial<SchedulerDeps> = {},
): Promise<WindowSummary> {
  const until = typeof deadline === "function" ? deadline : () => deadline;
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
  state.window = { startedAt: startedAt.toISOString(), until: until().toISOString() };
  await saveState(cfg.dataDir, state);
  deps.print(`plage jusqu'à ${until().toISOString()} (${formatDuration(until().getTime() - startedAt.getTime())})`);

  let stopped = false;
  while (!signal.aborted && deps.now() < until()) {
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
        const nowMs = deps.now().getTime();
        const resetsAt = r.outcome.kind === "quota" ? r.outcome.resetsAt : undefined;
        // Jusqu'au reset annoncé (plus une marge), sinon l'attente aveugle.
        const target = resetsAt !== undefined ? resetsAt * 1000 + 30_000 - nowMs : cfg.scheduler.backoffMinutes * 60_000;
        const full = Math.max(target, 60_000);
        const wait = Math.min(full, until().getTime() - nowMs);
        if (wait <= 0) break;
        const untilIso = new Date(nowMs + wait).toISOString();
        const resetIso = new Date(nowMs + full).toISOString();
        const quota = `quota ${r.outcome.kind === "quota" ? r.outcome.reason : ""}`;
        // Reset après la fin de plage : rien ne reprendra, on ne l'annonce pas.
        if (wait < full) deps.print(`  ${quota} saturé jusqu'à ${resetIso} : la plage se termine avant, à ${untilIso}`);
        else deps.print(`  ${quota} saturé, reprise à ${untilIso} (${formatDuration(wait)})`);
        deps.onEvent({ type: "backoff", ms: wait, until: resetIso });
        await deps.sleep(wait, signal);
        break;
      }
      case "stop-window": {
        summary.endedBecause = "fatal";
        if (r.outcome.kind === "fatal") summary.fatal = { reason: r.outcome.reason, detail: r.outcome.detail };
        deps.print(`  panne globale (${summary.fatal?.reason ?? "?"}) : la plage s'arrête`);
        break;
      }
      case "retry":
      case "task-failed": {
        summary.failures += 1;
        if (r.decision === "task-failed") deps.print(`  ${task.name} sortie de la file après ${cfg.scheduler.maxConsecutiveFailures} échecs consécutifs`);
        const wait = Math.min(cfg.scheduler.retrySeconds * 1000, until().getTime() - deps.now().getTime());
        if (wait > 0) await deps.sleep(wait, signal);
        break;
      }
    }
    if (summary.endedBecause === "fatal") break;
  }

  if (signal.aborted) {
    summary.endedBecause = "stopped";
    // La plage reste enregistrée : le démon la reprendra au prochain démarrage.
  } else {
    if (stopped) summary.endedBecause = "stopped";
    // Une panne globale garde la plage : réparée, le démon la reprendra.
    if (summary.endedBecause !== "fatal") state.window = null;
    await saveState(cfg.dataDir, state);
  }
  deps.onEvent({ type: "end", summary });
  deps.print(
    `\nfin de plage (${summary.endedBecause}${summary.fatal ? ` ${summary.fatal.reason}` : ""}) : ${summary.iterations} itérations, ${summary.completed} completed, ` +
      `${summary.failures} échecs, ${summary.backoffs} attentes quota, $${summary.costUsd.toFixed(2)}`,
  );
  return summary;
}
