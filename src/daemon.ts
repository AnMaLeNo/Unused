import { watch, type FSWatcher } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { coverageEnd, nextStart } from "./calendar.js";
import type { Config } from "./config.js";
import { dockerVersion, imageExists, removeTaskImages } from "./docker.js";
import { formatDuration } from "./duration.js";
import { pickNext } from "./graph.js";
import { DONE_FILE, TOKEN_ENV } from "./iterate.js";
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
  // Une plage couvre mais aucune tâche n'est à faire : rien ne tourne, on attend un changement dans tasks/.
  idle: boolean;
  // Plage interrompue par une erreur inattendue : nouvel essai à `nextAt` (null pendant qu'une plage tourne).
  retry: null | { attempts: number; error: string; nextAt: string };
  // Panne globale : plus rien ne tourne tant qu'un `reset-error` ne l'efface pas (ou un redémarrage du service).
  // `error` : une erreur inattendue qui a épuisé ses essais.
  fatal: null | { reason: "auth" | "docker" | "error"; detail: string; at: string };
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
  // L'autre source couvre encore jusque-là.
  continuing: string | null;
  // Tâche dont une itération tournait à l'instant du stop.
  iteration: string | null;
  // Une plage couvre mais aucune tâche n'était à faire : rien ne tournait.
  idle: boolean;
  // Plus rien ne couvre : arrêt tout de suite (`now`, ou rien ne tournait) ou après l'itération en cours.
  stopping: "now" | "after-iteration" | null;
  // L'itération en cours a été tuée.
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

/**
 * Un changement dans tasks/ qui peut rendre une tâche éligible : un dossier de
 * tâche ajouté ou retiré, ou un task.json modifié. Le reste (exchange/, skills)
 * est ignoré : les containers y écrivent pendant chaque itération.
 */
export function isTaskChange(filename: string | null): boolean {
  if (filename === null) return true;
  const parts = filename.split(path.sep);
  return parts.length === 1 || (parts.length === 2 && parts[1] === TASK_FILE);
}

/** Après une erreur inattendue : 1 s, 2 s, 4 s… ; si le délai suivant dépasse `maxMs`, c'est une panne. */
export const ERROR_RETRY = { firstMs: 1_000, maxMs: 15 * 60_000 };

export interface DaemonDeps {
  runWindow: typeof runWindow;
  imageExists: typeof imageExists;
  removeTaskImages: typeof removeTaskImages;
  dockerVersion: typeof dockerVersion;
  env: Record<string, string | undefined>;
  errorRetry: typeof ERROR_RETRY;
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
  // Une plage couvre mais aucune tâche n'est à faire.
  private nothingToDo = false;
  // Surveillance de tasks/ (et l'inode surveillé, pour voir un dossier supprimé puis recréé).
  private watcher: FSWatcher | null = null;
  private watchedIno: number | null = null;
  private watchProblem: string | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private running: Running | null = null;
  private lastWindow: WindowSummary | null = null;
  private fatal: DaemonStatus["fatal"] = null;
  // Erreurs inattendues d'affilée ; remis à zéro par une plage qui se termine sans erreur.
  private retry: { attempts: number; error: string; nextAt: Date } | null = null;
  private wake: (() => void) | null = null;
  private readonly startedAt: Date;
  private readonly deps: DaemonDeps;

  constructor(
    private readonly cfg: Config,
    deps: Partial<DaemonDeps> = {},
  ) {
    this.deps = { runWindow, imageExists, removeTaskImages, dockerVersion, env: process.env, errorRetry: ERROR_RETRY, now: () => new Date(), print: () => {}, ...deps };
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

  private async setManual(manual: { until: Date; resumed: boolean } | null): Promise<void> {
    this.manual = manual;
    this.state.window = manual ? { startedAt: this.deps.now().toISOString(), until: manual.until.toISOString() } : null;
    await saveState(this.cfg.dataDir, this.state);
  }

  /** Boucle principale : travaille quand une plage le dit, attend sinon. Sort quand `signal` est levé. */
  async run(signal: AbortSignal): Promise<void> {
    const onAbort = (): void => {
      const cur = this.running?.current;
      if (cur) this.deps.print(`itération de ${cur.task} jetée`);
      const manual = this.manualUntil(this.deps.now());
      if (manual) this.deps.print(`plage manuelle jusqu'à ${manual.toISOString()} : reprise au prochain démarrage`);
      this.running?.ac.abort();
      this.wake?.();
    };
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted) {
        await this.watchTasks();
        const now = this.deps.now();
        if (this.manual && this.manualUntil(now) === null) await this.setManual(null);
        const deadline = this.deadline();
        if (deadline.getTime() > now.getTime()) {
          // Une plage couvre : s'il y a une tâche à faire, on la fait ; sinon on attend
          // qu'une tâche change dans tasks/ (ou qu'une commande réveille), au plus jusqu'à la fin de la plage.
          if (this.retry && this.retry.nextAt.getTime() > now.getTime()) {
            await this.idle(signal, new Date(Math.min(this.retry.nextAt.getTime(), deadline.getTime())));
            continue;
          }
          if (await this.hasWork()) {
            this.setNothingToDo(false);
            const error = await this.execute();
            if (error === null) {
              this.retry = null;
            } else {
              this.onError(error);
            }
            continue;
          }
          this.setNothingToDo(true);
          await this.idle(signal, deadline);
          continue;
        }
        this.setNothingToDo(false);
        await this.idle(signal, this.nextCalendarStart());
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.unwatchTasks();
    }
  }

  /** Au moins une tâche à faire ? Relu sur disque à chaque fois. Une erreur de lecture sera dite par la plage. */
  private async hasWork(): Promise<boolean> {
    try {
      const { tasks } = await loadTasks(this.cfg.tasksDir);
      return pickNext(tasks, this.state) !== null;
    } catch {
      return true;
    }
  }

  private setNothingToDo(value: boolean): void {
    if (value && !this.nothingToDo) {
      this.deps.print("aucune tâche à faire : rien ne tourne, en attente d'un changement dans les tâches");
    }
    this.nothingToDo = value;
  }

  /**
   * Surveille tasks/ : une tâche ajoutée ou modifiée à la main réveille le démon.
   * Rappelé à chaque tour : si le dossier a été supprimé ou remplacé, la surveillance est refaite.
   */
  private async watchTasks(): Promise<void> {
    const dir = this.cfg.tasksDir;
    const ino = await stat(dir).then((s) => s.ino, () => null);
    if (this.watcher && ino === this.watchedIno) return;
    this.unwatchTasks();
    if (ino === null) return this.noteWatchProblem(`${dir} absent : les tâches ajoutées ne seront pas vues avant la prochaine commande`);
    try {
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!isTaskChange(filename)) return;
        // Un éditeur écrit souvent en plusieurs fois : un seul réveil pour la rafale.
        if (this.changeTimer) clearTimeout(this.changeTimer);
        this.changeTimer = setTimeout(() => {
          this.changeTimer = null;
          this.wakeUp();
        }, 200);
      });
      this.watcher.on("error", (err) => {
        this.noteWatchProblem(`surveillance de ${dir} interrompue : ${err.message}`);
        this.unwatchTasks();
        this.wakeUp();
      });
      this.watchedIno = ino;
      this.noteWatchProblem(null);
    } catch (err) {
      this.noteWatchProblem(`surveillance de ${dir} impossible : ${(err as Error).message}`);
    }
  }

  private unwatchTasks(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watchedIno = null;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
  }

  /** Dit un problème de surveillance une seule fois, pas à chaque tour. */
  private noteWatchProblem(problem: string | null): void {
    if (problem && problem !== this.watchProblem) this.deps.print(problem);
    this.watchProblem = problem;
  }

  /** Attend un réveil (API, changement dans tasks/) ou l'instant `until`. */
  private idle(signal: AbortSignal, until: Date | null): Promise<void> {
    return new Promise<void>((resolve) => {
      const ms = until ? Math.max(0, until.getTime() - this.deps.now().getTime()) : null;
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

  /** Erreur inattendue : nouvel essai après un délai qui double, puis panne quand il dépasserait le plafond. */
  private onError(error: string): void {
    const attempts = (this.retry?.attempts ?? 0) + 1;
    const delay = this.deps.errorRetry.firstMs * 2 ** (attempts - 1);
    if (delay > this.deps.errorRetry.maxMs) {
      this.retry = null;
      this.fatal = { reason: "error", detail: error, at: this.deps.now().toISOString() };
      this.deps.print(`PANNE error après ${attempts - 1} essais : ${error.split("\n")[0]} — plus rien ne tourne jusqu'à un \`unused reset-error\` (ou un redémarrage du service) une fois réparé`);
      return;
    }
    this.retry = { attempts, error, nextAt: new Date(this.deps.now().getTime() + delay) };
    this.deps.print(`nouvel essai dans ${formatDuration(delay)} (essai ${attempts})`);
  }

  /** Fait tourner une plage ; le message de l'erreur inattendue qui l'a interrompue, ou null. */
  private async execute(): Promise<string | null> {
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
        this.deps.print(`PANNE ${this.fatal.reason} : ${this.fatal.detail.split("\n")[0]} — plus rien ne tourne jusqu'à un \`unused reset-error\` (ou un redémarrage du service) une fois réparé`);
      }
      return null;
    } catch (err) {
      const message = (err as Error).message;
      this.deps.print(`plage interrompue par une erreur : ${message}`);
      return message;
    } finally {
      this.running = null;
    }
  }

  private wakeUp(): void {
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

  /** Refuse une commande qui relancerait le travail pendant une panne. */
  private refuseIfFatal(): void {
    if (!this.fatal) return;
    throw new ConflictError(`panne ${this.fatal.reason} en cours (${this.fatal.detail.split("\n")[0]}) : répare, puis \`unused reset-error\``);
  }

  /** Docker répond et l'image de base existe, sinon ConflictError. */
  private async checkDocker(): Promise<void> {
    try {
      await this.deps.dockerVersion();
    } catch (err) {
      throw new ConflictError(`Docker ne répond pas : ${(err as Error).message.split("\n")[0]}`);
    }
    if (!(await this.deps.imageExists(this.cfg.docker.baseImage))) {
      throw new ConflictError(`image de base ${this.cfg.docker.baseImage} absente : lance \`unused docker build\``);
    }
  }

  // --- commandes de l'API ---

  /** Pose une plage manuelle. Le calendrier n'est pas touché : si une plage automatique est en cours, la couverture s'étend. */
  async startWindow(forMs: number): Promise<{ until: Date; coveredUntil: Date }> {
    this.refuseIfFatal();
    const now = this.deps.now();
    if (this.manualUntil(now)) throw new ConflictError(`une plage manuelle est déjà en cours jusqu'à ${this.manual!.until.toISOString()}`);
    await this.checkDocker();
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

  /** Rallume le calendrier. Refusé pendant une panne : c'est `reset-error` qui l'efface. */
  async enableAuto(): Promise<{ coveringUntil: Date | null; nextStart: Date | null }> {
    this.refuseIfFatal();
    this.state.autoEnabled = true;
    await saveState(this.cfg.dataDir, this.state);
    this.wakeUp();
    return { coveringUntil: this.calendarEnd(this.deps.now()), nextStart: this.nextCalendarStart() };
  }

  /**
   * Efface la panne, si elle paraît réparée : Docker répond, l'image de base
   * existe, le token est dans l'environnement du démon. La plage manuelle est
   * retirée : seul le calendrier (s'il est allumé et couvre) relance le travail.
   */
  async resetError(): Promise<{ manualDropped: Date | null; coveringUntil: Date | null; nextStart: Date | null }> {
    if (!this.fatal) throw new ConflictError("aucune panne en cours");
    await this.checkDocker();
    if (!this.deps.env[TOKEN_ENV]) {
      throw new ConflictError(`${TOKEN_ENV} absent de l'environnement du démon : mets-le dans .env et redémarre le service`);
    }
    const manualDropped = this.manualUntil(this.deps.now());
    if (this.manual) await this.setManual(null);
    this.fatal = null;
    this.retry = null;
    this.wakeUp();
    return { manualDropped, coveringUntil: this.calendarEnd(this.deps.now()), nextStart: this.nextCalendarStart() };
  }

  /** Une source vient d'être retirée : l'autre couvre-t-elle encore ? Sinon, on arrête (tout de suite si `now`). */
  private afterRemoval(until: Date | null, now: boolean): StopResult {
    const deadline = this.deadline();
    const continuing = deadline.getTime() > this.deps.now().getTime() ? deadline : null;
    const idle = this.nothingToDo;
    const run = this.running;
    const r: StopResult = {
      until: until?.toISOString() ?? null,
      continuing: continuing?.toISOString() ?? null,
      iteration: run?.current?.task ?? null,
      idle,
      stopping: null,
      killed: false,
    };
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
      idle: this.nothingToDo,
      retry: this.retry && !run ? { ...this.retry, nextAt: this.retry.nextAt.toISOString() } : null,
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

}
