import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { coverageEnd, nextStart } from "./calendar.js";
import type { Config } from "./config.js";
import { formatDuration } from "./duration.js";
import { dockerVersion, imageExists, removeTaskImages } from "./docker.js";
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
    source: "manual" | "calendar" | "manual+calendar";
    stopping: boolean;
    iterations: number;
    completed: number;
    failures: number;
    backoffs: number;
    costUsd: number;
    current: null | { task: string; node: string; at: string };
    waitingQuotaUntil: string | null;
  };
  nextCalendarStart: string | null;
  pausedUntil: string | null;
  // Panne globale : plus rien ne tourne tant qu'un `start` ne relance pas.
  fatal: null | { reason: "auth" | "docker"; detail: string; at: string };
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

interface Running {
  startedAt: Date;
  manualUntil: Date | null;
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
  dockerVersion: typeof dockerVersion;
  now: () => Date;
  print: (line: string) => void;
}

/**
 * Le processus qui vit. Seul propriétaire de state.json. Il travaille dès
 * qu'une plage le dit — manuelle (`start`) ou automatique (config `windows`),
 * les deux se cumulent — et reprend au démarrage une plage manuelle
 * interrompue par un arrêt du service.
 */
export class Daemon {
  private state!: RunnerState;
  // Plage manuelle demandée (ou reprise), pas encore ou en cours d'exécution.
  private manual: { until: Date; resumed: boolean } | null = null;
  private running: Running | null = null;
  private lastWindow: WindowSummary | null = null;
  private fatal: DaemonStatus["fatal"] = null;
  private wake: (() => void) | null = null;
  private readonly startedAt: Date;
  private readonly deps: DaemonDeps;

  constructor(
    private readonly cfg: Config,
    deps: Partial<DaemonDeps> = {},
  ) {
    this.deps = { runWindow, imageExists, removeTaskImages, dockerVersion, now: () => new Date(), print: () => {}, ...deps };
    this.startedAt = this.deps.now();
  }

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
    if (this.cfg.windows.length > 0) {
      const next = this.nextCalendarStart();
      this.deps.print(`${this.cfg.windows.length} plage(s) automatique(s)${next ? `, prochaine le ${next.toISOString()}` : ""}`);
    }
  }

  /** Fin de la plage en cours : le plus tard entre la plage manuelle et la couverture du calendrier. */
  private deadline(manualUntil: Date | null): Date {
    const now = this.deps.now();
    const calendar = this.calendarEnd(now);
    const ends = [manualUntil, calendar].filter((d): d is Date => d !== null).map((d) => d.getTime());
    return ends.length > 0 ? new Date(Math.max(...ends)) : now;
  }

  private calendarEnd(now: Date): Date | null {
    if (this.fatal) return null;
    const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
    if (paused && paused.getTime() > now.getTime()) return null;
    return coverageEnd(this.cfg.windows, now);
  }

  private nextCalendarStart(): Date | null {
    const now = this.deps.now();
    const paused = this.state.pausedUntil ? new Date(this.state.pausedUntil) : null;
    const from = paused && paused.getTime() > now.getTime() ? paused : now;
    return nextStart(this.cfg.windows, from);
  }

  /** Boucle principale : travaille quand une plage le dit, attend sinon. Sort quand `signal` est levé. */
  async run(signal: AbortSignal): Promise<void> {
    const onAbort = (): void => {
      this.running?.ac.abort();
      this.wake?.();
    };
    signal.addEventListener("abort", onAbort);
    try {
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
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Attend un réveil de l'API ou la prochaine plage automatique. */
  private idle(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const next = this.fatal ? null : this.nextCalendarStart();
      const ms = next ? Math.max(0, next.getTime() - this.deps.now().getTime()) : null;
      const timer = ms !== null ? setTimeout(done, Math.min(ms, 2_147_000_000)) : null;
      function done(): void {
        if (timer) clearTimeout(timer);
        resolve();
      }
      this.wake = done;
      if (signal.aborted) done();
    }).finally(() => {
      this.wake = null;
    });
  }

  private async execute(manualUntil: Date | null, resumed: boolean): Promise<void> {
    const run: Running = {
      startedAt: this.deps.now(),
      manualUntil,
      ac: new AbortController(),
      stopRequested: false,
      explicitStop: false,
      live: { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0 },
      current: null,
      waitingQuotaUntil: null,
    };
    this.running = run;
    const source = this.source(run);
    this.deps.print(`${resumed ? "reprise de la" : "nouvelle"} plage (${source}) jusqu'à ${this.deadline(manualUntil).toISOString()}`);
    try {
      this.lastWindow = await this.deps.runWindow(
        this.cfg,
        () => this.loadTasks(),
        this.state,
        () => this.deadline(run.manualUntil),
        run.ac.signal,
        {
          print: this.deps.print,
          now: this.deps.now,
          shouldStop: () => run.stopRequested,
          onEvent: (e) => this.onEvent(run, e),
        },
      );
      if (this.lastWindow.fatal) {
        this.fatal = { ...this.lastWindow.fatal, at: this.deps.now().toISOString() };
        this.deps.print(`PANNE ${this.fatal.reason} : ${this.fatal.detail.split("\n")[0]} — plus rien ne tourne jusqu'à un \`unused start\` (ou un redémarrage du service une fois réparé)`);
      } else if (this.lastWindow.endedBecause === "nothing-eligible") {
        // Rien à faire : inutile de relancer tant que la couverture dure. Un
        // start, un reset ou un activate lèvent la pause.
        await this.pauseUntil(this.deadline(run.manualUntil), "plus rien à faire");
      }
    } catch (err) {
      this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
      this.state.window = null;
      await this.pauseUntil(this.deadline(run.manualUntil), "erreur");
    } finally {
      if (run.explicitStop && this.state.window) {
        // Arrêt explicite : on ne reprendra pas cette plage au prochain démarrage.
        this.state.window = null;
        await saveState(this.cfg.dataDir, this.state);
      }
      if (!run.ac.signal.aborted || run.explicitStop) this.manual = null;
      this.running = null;
    }
  }

  private async pauseUntil(until: Date, why: string): Promise<void> {
    // Sans calendrier, il n'y a rien à mettre en pause : seules les plages
    // automatiques sont concernées, une plage manuelle ne revient pas seule.
    if (this.cfg.windows.length === 0) return;
    if (until.getTime() <= this.deps.now().getTime()) return;
    this.state.pausedUntil = until.toISOString();
    await saveState(this.cfg.dataDir, this.state);
    this.deps.print(`plages automatiques en pause jusqu'à ${until.toISOString()} (${why})`);
  }

  private async unpause(): Promise<void> {
    if (this.state.pausedUntil === null) return;
    this.state.pausedUntil = null;
    await saveState(this.cfg.dataDir, this.state);
    this.wake?.();
  }

  private source(run: Running): DaemonStatus["window"] extends infer W ? (W extends { source: infer S } ? S : never) : never {
    const now = this.deps.now();
    const manual = run.manualUntil !== null && run.manualUntil.getTime() > now.getTime();
    const calendar = this.calendarEnd(now) !== null;
    return manual && calendar ? "manual+calendar" : calendar ? "calendar" : "manual";
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
          else if (e.result.decision !== "stop-window") run.live.failures += 1;
        }
        break;
      case "backoff":
        run.waitingQuotaUntil = new Date(e.until);
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
    if (this.running || this.manual) throw new ConflictError("une plage est déjà en cours");
    try {
      await this.deps.dockerVersion();
    } catch (err) {
      throw new ConflictError(`Docker ne répond pas : ${(err as Error).message.split("\n")[0]}`);
    }
    if (!(await this.deps.imageExists(this.cfg.docker.baseImage))) {
      throw new ConflictError(`image de base ${this.cfg.docker.baseImage} absente : lance \`unused docker build\``);
    }
    const until = new Date(this.deps.now().getTime() + forMs);
    this.manual = { until, resumed: false };
    this.fatal = null;
    this.state.pausedUntil = null;
    await saveState(this.cfg.dataDir, this.state);
    this.wake?.();
    return { until };
  }

  /**
   * Arrête la plage en cours. Les plages automatiques sont mises en pause
   * jusqu'à la fin de la couverture actuelle, sinon le calendrier relancerait
   * aussitôt.
   */
  async stopWindow(now: boolean): Promise<{ stopping: "after-iteration" | "now" }> {
    if (!this.running) {
      if (this.manual) {
        this.manual = null;
        return { stopping: "now" };
      }
      throw new ConflictError("aucune plage en cours");
    }
    const run = this.running;
    this.state.pausedUntil = this.deadline(run.manualUntil).toISOString();
    await saveState(this.cfg.dataDir, this.state);
    run.explicitStop = true;
    if (now) {
      run.ac.abort();
      return { stopping: "now" };
    }
    run.stopRequested = true;
    return { stopping: "after-iteration" };
  }

  async status(): Promise<DaemonStatus> {
    const { tasks, errors } = await loadTasks(this.cfg.tasksDir);
    const run = this.running;
    const now = this.deps.now();
    const nowMs = now.getTime();
    let window: DaemonStatus["window"] = null;
    if (run) {
      const until = this.deadline(run.manualUntil);
      window = {
        startedAt: run.startedAt.toISOString(),
        until: until.toISOString(),
        remainingMs: Math.max(0, until.getTime() - nowMs),
        source: this.source(run),
        stopping: run.stopRequested,
        ...run.live,
        current: run.current,
        waitingQuotaUntil: run.waitingQuotaUntil?.toISOString() ?? null,
      };
    } else if (this.manual) {
      window = {
        startedAt: now.toISOString(),
        until: this.manual.until.toISOString(),
        remainingMs: Math.max(0, this.manual.until.getTime() - nowMs),
        source: "manual",
        stopping: false,
        iterations: 0,
        completed: 0,
        failures: 0,
        backoffs: 0,
        costUsd: 0,
        current: null,
        waitingQuotaUntil: null,
      };
    }
    const paused = this.state.pausedUntil && new Date(this.state.pausedUntil).getTime() > nowMs ? this.state.pausedUntil : null;
    return {
      daemon: { pid: process.pid, startedAt: this.startedAt.toISOString() },
      window,
      nextCalendarStart: this.fatal ? null : (this.nextCalendarStart()?.toISOString() ?? null),
      pausedUntil: paused,
      fatal: this.fatal,
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
    await this.unpause();
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
    if (active) await this.unpause();
  }

  describeWindow(): string {
    const r = this.running;
    if (!r) return "aucune plage en cours";
    return `plage en cours, ${formatDuration(this.deadline(r.manualUntil).getTime() - this.deps.now().getTime())} restantes`;
  }
}
