import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { formatDuration } from "./duration.js";
import { imageExists, removeTaskImages } from "./docker.js";
import { DONE_FILE } from "./iterate.js";
import { runWindow, type SchedulerEvent, type WindowSummary } from "./scheduler.js";
import { ensureTaskState, loadState, saveState, type RunnerState, type TaskState } from "./state.js";
import { loadTasks, TASK_FILE, type Task, type TaskLoadError } from "./task.js";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface DaemonStatus {
  daemon: { pid: number; startedAt: string };
  window: null | {
    startedAt: string;
    until: string;
    remainingMs: number;
    stopping: boolean;
    iterations: number;
    completed: number;
    failures: number;
    backoffs: number;
    costUsd: number;
    current: null | { task: string; node: string; at: string };
    waitingQuotaUntil: string | null;
  };
  lastWindow: WindowSummary | null;
  tasks: TaskInfo[];
  taskErrors: TaskLoadError[];
}

export interface TaskInfo {
  name: string;
  active: boolean;
  start: string;
  cursor: string;
  status: TaskState["status"];
  iterations: number;
  consecutiveFailures: number;
  last: TaskState["last"] | null;
}

interface Pending {
  until: Date;
  resumed: boolean;
}

interface Running {
  startedAt: Date;
  until: Date;
  ac: AbortController;
  stopRequested: boolean;
  explicitStop: boolean;
  live: { iterations: number; completed: number; failures: number; backoffs: number; costUsd: number };
  current: { task: string; node: string; at: string } | null;
  waitingQuotaUntil: Date | null;
}

export interface DaemonDeps {
  runWindow: typeof runWindow;
  imageExists: typeof imageExists;
  removeTaskImages: typeof removeTaskImages;
  now: () => Date;
  print: (line: string) => void;
}

/**
 * Le processus qui vit. Seul propriétaire de state.json : il exécute les
 * plages qu'on lui demande (via l'API) et reprend au démarrage une plage
 * interrompue par un arrêt du service.
 */
export class Daemon {
  private state!: RunnerState;
  private pending: Pending | null = null;
  private running: Running | null = null;
  private lastWindow: WindowSummary | null = null;
  private wake: (() => void) | null = null;
  private readonly startedAt: Date;
  private readonly deps: DaemonDeps;

  constructor(
    private readonly cfg: Config,
    deps: Partial<DaemonDeps> = {},
  ) {
    this.deps = { runWindow, imageExists, removeTaskImages, now: () => new Date(), print: () => {}, ...deps };
    this.startedAt = this.deps.now();
  }

  async init(): Promise<void> {
    this.state = await loadState(this.cfg.dataDir);
    if (this.state.window) {
      const until = new Date(this.state.window.until);
      if (until.getTime() > this.deps.now().getTime()) {
        this.pending = { until, resumed: true };
        this.deps.print(`plage interrompue trouvée, reprise jusqu'à ${until.toISOString()}`);
      } else {
        this.deps.print("plage enregistrée expirée, oubliée");
        this.state.window = null;
        await saveState(this.cfg.dataDir, this.state);
      }
    }
  }

  /** Boucle principale : exécute les plages demandées, attend sinon. Sort quand `signal` est levé. */
  async run(signal: AbortSignal): Promise<void> {
    const onAbort = (): void => {
      this.running?.ac.abort();
      this.wake?.();
    };
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted) {
        if (!this.pending) {
          await new Promise<void>((resolve) => (this.wake = resolve));
          this.wake = null;
          continue;
        }
        const { until, resumed } = this.pending;
        this.pending = null;
        await this.execute(until, resumed);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async execute(until: Date, resumed: boolean): Promise<void> {
    const run: Running = {
      startedAt: this.deps.now(),
      until,
      ac: new AbortController(),
      stopRequested: false,
      explicitStop: false,
      live: { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0 },
      current: null,
      waitingQuotaUntil: null,
    };
    this.running = run;
    this.deps.print(`${resumed ? "reprise de la" : "nouvelle"} plage jusqu'à ${until.toISOString()}`);
    try {
      this.lastWindow = await this.deps.runWindow(this.cfg, () => this.loadTasks(), this.state, until, run.ac.signal, {
        print: this.deps.print,
        now: this.deps.now,
        shouldStop: () => run.stopRequested,
        onEvent: (e) => this.onEvent(run, e),
      });
    } catch (err) {
      this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
      this.state.window = null;
      await saveState(this.cfg.dataDir, this.state);
    } finally {
      if (run.explicitStop && this.state.window) {
        // Arrêt explicite : on ne reprendra pas cette plage au prochain démarrage.
        this.state.window = null;
        await saveState(this.cfg.dataDir, this.state);
      }
      this.running = null;
    }
  }

  private onEvent(run: Running, e: SchedulerEvent): void {
    switch (e.type) {
      case "iteration-start":
        run.current = { task: e.task, node: e.node, at: e.at };
        run.waitingQuotaUntil = null;
        break;
      case "iteration-end":
        run.current = null;
        if (!(e.result.outcome.kind === "failure" && e.result.outcome.reason === "aborted")) {
          run.live.iterations += 1;
          run.live.costUsd += e.result.costUsd ?? 0;
          if (e.result.decision === "next-task" || e.result.decision === "task-done") run.live.completed += 1;
          else if (e.result.decision === "backoff") run.live.backoffs += 1;
          else run.live.failures += 1;
        }
        break;
      case "backoff":
        run.waitingQuotaUntil = new Date(this.deps.now().getTime() + e.ms);
        break;
      case "end":
        break;
    }
  }

  private async loadTasks(): Promise<Task[]> {
    const { tasks, errors } = await loadTasks(this.cfg.tasksDir);
    for (const e of errors) this.deps.print(`tâche ${e.name} ignorée : ${e.message}`);
    return tasks;
  }

  // --- commandes de l'API ---

  async startWindow(forMs: number): Promise<{ until: Date }> {
    if (this.running || this.pending) throw new ConflictError("une plage est déjà en cours");
    if (!(await this.deps.imageExists(this.cfg.docker.baseImage))) {
      throw new ConflictError(`image de base ${this.cfg.docker.baseImage} absente : lance \`unused docker build\``);
    }
    const until = new Date(this.deps.now().getTime() + forMs);
    this.pending = { until, resumed: false };
    this.wake?.();
    return { until };
  }

  stopWindow(now: boolean): { stopping: "after-iteration" | "now" } {
    if (this.pending && !this.running) {
      this.pending = null;
      return { stopping: "now" };
    }
    if (!this.running) throw new ConflictError("aucune plage en cours");
    this.running.explicitStop = true;
    if (now) {
      this.running.ac.abort();
      return { stopping: "now" };
    }
    this.running.stopRequested = true;
    return { stopping: "after-iteration" };
  }

  async status(): Promise<DaemonStatus> {
    const { tasks, errors } = await loadTasks(this.cfg.tasksDir);
    const run = this.running;
    const nowMs = this.deps.now().getTime();
    return {
      daemon: { pid: process.pid, startedAt: this.startedAt.toISOString() },
      window: run
        ? {
            startedAt: run.startedAt.toISOString(),
            until: run.until.toISOString(),
            remainingMs: Math.max(0, run.until.getTime() - nowMs),
            stopping: run.stopRequested,
            ...run.live,
            current: run.current,
            waitingQuotaUntil: run.waitingQuotaUntil?.toISOString() ?? null,
          }
        : this.pending
          ? {
              startedAt: this.deps.now().toISOString(),
              until: this.pending.until.toISOString(),
              remainingMs: Math.max(0, this.pending.until.getTime() - nowMs),
              stopping: false,
              iterations: 0,
              completed: 0,
              failures: 0,
              backoffs: 0,
              costUsd: 0,
              current: null,
              waitingQuotaUntil: null,
            }
          : null,
      lastWindow: this.lastWindow,
      tasks: tasks.map((t) => this.taskInfo(t)),
      taskErrors: errors,
    };
  }

  private taskInfo(task: Task): TaskInfo {
    const ts = this.state.tasks[task.name];
    return {
      name: task.name,
      active: task.def.active,
      start: task.def.start,
      cursor: ts && ts.cursor in task.def.nodes ? ts.cursor : task.def.start,
      status: ts?.status ?? "running",
      iterations: ts?.iterations ?? 0,
      consecutiveFailures: ts?.consecutiveFailures ?? 0,
      last: ts?.last ?? null,
    };
  }

  private async findTask(name: string): Promise<Task> {
    const { tasks, errors } = await loadTasks(this.cfg.tasksDir);
    const task = tasks.find((t) => t.name === name);
    if (task) return task;
    const bad = errors.find((e) => e.name === name);
    throw new NotFoundError(bad ? `tâche ${name} invalide : ${bad.message}` : `tâche ${name} introuvable`);
  }

  async resetTask(name: string): Promise<{ start: string }> {
    const task = await this.findTask(name);
    if (this.running?.current?.task === name) throw new ConflictError(`${name} est en cours d'itération`);
    delete this.state.tasks[name];
    if (this.state.currentTask === name) this.state.currentTask = null;
    await saveState(this.cfg.dataDir, this.state);
    await rm(path.join(task.exchangeDir, DONE_FILE), { force: true });
    await this.deps.removeTaskImages(name);
    return { start: task.def.start };
  }

  /** Réécrit `active` dans le task.json de l'utilisateur ; pris en compte à l'itération suivante. */
  async setActive(name: string, active: boolean): Promise<void> {
    const task = await this.findTask(name);
    const file = path.join(task.dir, TASK_FILE);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw.active = active;
    await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
    ensureTaskState(this.state, task);
  }

  describeWindow(): string {
    const r = this.running;
    if (!r) return "aucune plage en cours";
    return `plage en cours, ${formatDuration(r.until.getTime() - this.deps.now().getTime())} restantes`;
  }
}
