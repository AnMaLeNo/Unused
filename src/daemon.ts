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
  // Plage manuelle posée (`start --for`), qu'elle soit en cours d'exécution ou non.
  manual: null | { until: string };
  // Plages automatiques : `stop --auto` / `resume`. `coveringUntil` : fin de la plage du calendrier en cours, s'il y en a une.
  auto: { enabled: boolean; windows: number; coveringUntil: string | null; nextStart: string | null };
  // Veille : plus rien à faire (ou erreur), on ne relance pas avant cet instant.
  idleUntil: string | null;
  // Panne globale : plus rien ne tourne tant qu'un `start` ou un `resume` ne relance pas.
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

type WindowSource = NonNullable<DaemonStatus["window"]>["source"];

export interface StopResult {
  // La plage retirée couvrait jusqu'à cet instant.
  until: string | null;
  // L'autre source couvre encore : le travail continue jusque-là.
  continuing: string | null;
  // Plus rien ne couvre : arrêt tout de suite (`now`, ou rien ne tournait) ou après l'itération en cours.
  stopping: "now" | "after-iteration" | null;
  // Une itération a été tuée.
  killed: boolean;
}

interface Running {
  startedAt: Date;
  ac: AbortController;
  stopRequested: boolean;
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
 * Le processus qui vit. Seul propriétaire de state.json. Deux sources de
 * plages indépendantes — la plage manuelle (`start` / `stop`) et le calendrier
 * (`stop --auto` / `resume`) — et il travaille tant qu'au moins l'une des deux
 * couvre l'instant. La plage manuelle survit à un redémarrage du service.
 */
export class Daemon {
  private state!: RunnerState;
  // Plage manuelle posée ; `resumed` : retrouvée dans state.json au démarrage.
  private manual: { until: Date; resumed: boolean } | null = null;
  // Plus rien à faire (ou erreur) : on ne relance pas avant cet instant. Levé par start, resume, tasks reset/activate.
  private idleUntil: Date | null = null;
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
        this.deps.print(`plage manuelle interrompue trouvée, reprise jusqu'à ${until.toISOString()}`);
      } else {
        this.deps.print("plage manuelle enregistrée expirée, oubliée");
        this.state.window = null;
        await saveState(this.cfg.dataDir, this.state);
      }
    }
    if (this.cfg.windows.length > 0) {
      const next = this.nextCalendarStart();
      const detail = !this.state.autoEnabled ? " (désactivées : `unused resume`)" : next ? `, prochaine le ${next.toISOString()}` : "";
      this.deps.print(`${this.cfg.windows.length} plage(s) automatique(s)${detail}`);
    }
  }

  /** Plage manuelle encore valable, ou null. */
  private manualUntil(now: Date): Date | null {
    return this.manual && this.manual.until.getTime() > now.getTime() ? this.manual.until : null;
  }

  /** Fin de la couverture actuelle : le plus tard entre la plage manuelle et le calendrier ; `now` si rien ne couvre (ou panne). */
  private deadline(): Date {
    const now = this.deps.now();
    if (this.fatal) return now;
    const ends = [this.manualUntil(now), this.calendarEnd(now)].filter((d): d is Date => d !== null).map((d) => d.getTime());
    return ends.length > 0 ? new Date(Math.max(...ends)) : now;
  }

  private calendarEnd(now: Date): Date | null {
    if (this.fatal || !this.state.autoEnabled) return null;
    return coverageEnd(this.cfg.windows, now);
  }

  private nextCalendarStart(): Date | null {
    if (this.fatal || !this.state.autoEnabled) return null;
    return nextStart(this.cfg.windows, this.deps.now());
  }

  private sleeping(now: Date): boolean {
    return this.idleUntil !== null && this.idleUntil.getTime() > now.getTime();
  }

  private async setManual(manual: { until: Date; resumed: boolean } | null): Promise<void> {
    this.manual = manual;
    this.state.window = manual ? { startedAt: this.deps.now().toISOString(), until: manual.until.toISOString() } : null;
    await saveState(this.cfg.dataDir, this.state);
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
        const now = this.deps.now();
        if (this.manual && this.manualUntil(now) === null) await this.setManual(null);
        if (this.deadline().getTime() > now.getTime() && !this.sleeping(now)) {
          await this.execute();
          continue;
        }
        await this.idle(signal);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Attend un réveil de l'API, la fin de la veille ou la prochaine plage automatique. */
  private idle(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const now = this.deps.now();
      const next = this.sleeping(now) ? this.idleUntil : this.nextCalendarStart();
      const ms = next ? Math.max(0, next.getTime() - now.getTime()) : null;
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

  private async execute(): Promise<void> {
    const run: Running = {
      startedAt: this.deps.now(),
      ac: new AbortController(),
      stopRequested: false,
      live: { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0 },
      current: null,
      waitingQuotaUntil: null,
    };
    this.running = run;
    const resumed = this.manual?.resumed ?? false;
    if (this.manual) this.manual.resumed = false;
    this.deps.print(`${resumed ? "reprise de la" : "nouvelle"} plage (${this.source()}) jusqu'à ${this.deadline().toISOString()}`);
    try {
      this.lastWindow = await this.deps.runWindow(
        this.cfg,
        () => this.loadTasks(),
        this.state,
        () => this.deadline(),
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
        this.deps.print(`PANNE ${this.fatal.reason} : ${this.fatal.detail.split("\n")[0]} — plus rien ne tourne jusqu'à un \`unused resume\` (ou un redémarrage du service) une fois réparé`);
      } else if (this.lastWindow.endedBecause === "nothing-eligible") {
        this.sleep("plus rien à faire");
      }
    } catch (err) {
      this.deps.print(`plage interrompue par une erreur : ${(err as Error).message}`);
      this.sleep("erreur");
    } finally {
      this.running = null;
    }
  }

  /** Inutile de relancer tant que la couverture actuelle dure ; start, resume, tasks reset/activate réveillent. */
  private sleep(why: string): void {
    const until = this.deadline();
    if (until.getTime() <= this.deps.now().getTime()) return;
    this.idleUntil = until;
    this.deps.print(`veille jusqu'à ${until.toISOString()} (${why})`);
  }

  private wakeUp(): void {
    this.idleUntil = null;
    this.wake?.();
  }

  private source(): WindowSource {
    const now = this.deps.now();
    const manual = this.manualUntil(now) !== null;
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

  /** Pose une plage manuelle. Le calendrier n'est pas touché : si une plage automatique est en cours, la couverture s'étend. */
  async startWindow(forMs: number): Promise<{ until: Date; coveredUntil: Date }> {
    const now = this.deps.now();
    if (this.manualUntil(now)) throw new ConflictError(`une plage manuelle est déjà en cours jusqu'à ${this.manual!.until.toISOString()}`);
    try {
      await this.deps.dockerVersion();
    } catch (err) {
      throw new ConflictError(`Docker ne répond pas : ${(err as Error).message.split("\n")[0]}`);
    }
    if (!(await this.deps.imageExists(this.cfg.docker.baseImage))) {
      throw new ConflictError(`image de base ${this.cfg.docker.baseImage} absente : lance \`unused docker build\``);
    }
    this.fatal = null;
    await this.setManual({ until: new Date(this.deps.now().getTime() + forMs), resumed: false });
    this.wakeUp();
    return { until: this.manual!.until, coveredUntil: this.deadline() };
  }

  /** Retire la plage manuelle. Si le calendrier couvre encore, le travail continue. */
  async stopWindow(now: boolean): Promise<StopResult> {
    const until = this.manualUntil(this.deps.now());
    if (!until) throw new ConflictError("aucune plage manuelle en cours");
    await this.setManual(null);
    return this.afterRemoval(until, now);
  }

  /** Coupe le calendrier jusqu'à `resume`. Si une plage manuelle couvre encore, le travail continue. */
  async disableAuto(now: boolean): Promise<StopResult> {
    const until = this.calendarEnd(this.deps.now());
    this.state.autoEnabled = false;
    await saveState(this.cfg.dataDir, this.state);
    return this.afterRemoval(until, now);
  }

  /** Rallume le calendrier (et efface une panne). */
  async enableAuto(): Promise<{ coveringUntil: Date | null; nextStart: Date | null }> {
    this.state.autoEnabled = true;
    this.fatal = null;
    await saveState(this.cfg.dataDir, this.state);
    this.wakeUp();
    return { coveringUntil: this.calendarEnd(this.deps.now()), nextStart: this.nextCalendarStart() };
  }

  /** Une source vient d'être retirée : l'autre couvre-t-elle encore ? Sinon, on arrête (tout de suite si `now`). */
  private afterRemoval(until: Date | null, now: boolean): StopResult {
    const deadline = this.deadline();
    const continuing = deadline.getTime() > this.deps.now().getTime() ? deadline : null;
    // La veille ne doit pas dépasser la couverture restante.
    if (this.idleUntil && this.idleUntil.getTime() > deadline.getTime()) this.idleUntil = deadline;
    const run = this.running;
    const r: StopResult = { until: until?.toISOString() ?? null, continuing: continuing?.toISOString() ?? null, stopping: null, killed: false };
    if (continuing) {
      // La fin de plage est réévaluée à chaque tour par le scheduler : rien à faire.
      this.wake?.();
      return r;
    }
    if (!run) {
      r.stopping = "now";
      this.wake?.();
      return r;
    }
    if (now) {
      run.ac.abort();
      r.killed = run.current !== null;
      r.stopping = "now";
    } else {
      run.stopRequested = true;
      r.stopping = "after-iteration";
    }
    return r;
  }

  async status(): Promise<DaemonStatus> {
    const { tasks, errors } = await loadTasks(this.cfg.tasksDir);
    const run = this.running;
    const now = this.deps.now();
    const nowMs = now.getTime();
    let window: DaemonStatus["window"] = null;
    if (run) {
      const until = this.deadline();
      window = {
        startedAt: run.startedAt.toISOString(),
        until: until.toISOString(),
        remainingMs: Math.max(0, until.getTime() - nowMs),
        source: this.source(),
        stopping: run.stopRequested,
        ...run.live,
        current: run.current,
        waitingQuotaUntil: run.waitingQuotaUntil?.toISOString() ?? null,
      };
    }
    const manualUntil = this.manualUntil(now);
    return {
      daemon: { pid: process.pid, startedAt: this.startedAt.toISOString() },
      window,
      manual: manualUntil ? { until: manualUntil.toISOString() } : null,
      auto: {
        enabled: this.state.autoEnabled,
        windows: this.cfg.windows.length,
        coveringUntil: this.calendarEnd(now)?.toISOString() ?? null,
        nextStart: this.nextCalendarStart()?.toISOString() ?? null,
      },
      idleUntil: this.sleeping(now) ? this.idleUntil!.toISOString() : null,
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
    this.wakeUp();
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
    if (active) this.wakeUp();
  }

  describeWindow(): string {
    if (!this.running) return "aucune plage en cours";
    return `plage en cours, ${formatDuration(this.deadline().getTime() - this.deps.now().getTime())} restantes`;
  }
}
