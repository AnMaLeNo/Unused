import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, listen, socketPath } from "./api.js";
import { ApiError, call } from "./client.js";
import type { Config } from "./config.js";
import { Daemon, isTaskChange, type DaemonStatus, type StopResult } from "./daemon.js";
import type { runWindow, SchedulerDeps, WindowSummary } from "./scheduler.js";
import { emptyState, saveState, type RunnerState } from "./state.js";
import type { WindowSpec } from "./calendar.js";

let root: string;
let cfg: Config;
let sock: string;
let daemon: Daemon;
let server: ReturnType<typeof createApi>;
let ac: AbortController;
let loop: Promise<void>;

// Scheduler factice : tourne jusqu'à abort, shouldStop, ou `until` simulé par `finish()`.
let finish: (() => void) | null = null;
let seen: { until: Date; deps: Partial<SchedulerDeps> }[] = [];
const fakeRunWindow: typeof runWindow = async (_cfg, _tasks, _state, deadline, signal, deps = {}) => {
  const until = typeof deadline === "function" ? deadline() : deadline;
  seen.push({ until, deps });
  deps.onEvent?.({ type: "iteration-start", task: "t1", node: "a", at: new Date().toISOString() });
  await new Promise<void>((resolve) => {
    finish = resolve;
    signal.addEventListener("abort", () => resolve());
    const poll = setInterval(() => {
      if (deps.shouldStop?.()) {
        clearInterval(poll);
        resolve();
      }
    }, 5);
    signal.addEventListener("abort", () => clearInterval(poll));
  });
  const summary: WindowSummary = { iterations: 1, completed: 1, failures: 0, backoffs: 0, costUsd: 0.1, endedBecause: signal.aborted ? "stopped" : "window" };
  return summary;
};

/** Une plage automatique qui couvre l'instant : commencée il y a une minute, finit dans `hours` heures. */
function coveringWindow(hours: number): { spec: WindowSpec; end: Date } {
  const now = new Date();
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + hours * 3_600_000);
  return { spec: { days: [days[start.getDay()]!], from: hhmm(start), to: hhmm(end) }, end };
}

const near = (iso: string | null | undefined, d: Date) => Math.abs(new Date(iso ?? 0).getTime() - d.getTime()) < 60_000;
const savedState = async () => JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8")) as RunnerState;

async function boot(initial?: RunnerState, print: (line: string) => void = () => {}): Promise<void> {
  if (initial) await saveState(cfg.dataDir, initial);
  daemon = new Daemon(cfg, { runWindow: fakeRunWindow, imageExists: async () => true, removeTaskImages: async () => {}, dockerVersion: async () => "x", print });
  await daemon.init();
  server = createApi(cfg, daemon);
  await listen(server, sock);
  ac = new AbortController();
  loop = daemon.run(ac.signal);
}

async function shutdown(): Promise<void> {
  ac.abort();
  await loop;
  server.close();
}

const status = () => call<DaemonStatus>(sock, "GET", "/status");
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-d-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 1 },
    scheduler: { backoffMinutes: 1, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
  await mkdir(path.join(root, "tasks", "t1", "skills", "a"), { recursive: true });
  await writeFile(path.join(root, "tasks", "t1", "skills", "a", "SKILL.md"), "x");
  await writeFile(path.join(root, "tasks", "t1", "task.json"), JSON.stringify({ start: "a", nodes: { a: { skill: "a", next: "a" } } }));
  await mkdir(cfg.dataDir, { recursive: true });
  sock = socketPath(cfg);
  seen = [];
  finish = null;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isTaskChange", () => {
  it("réveille pour un dossier de tâche ou un task.json, pas pour exchange/ ni les skills", () => {
    expect(isTaskChange("t2")).toBe(true);
    expect(isTaskChange(path.join("t1", "task.json"))).toBe(true);
    expect(isTaskChange(null)).toBe(true);
    expect(isTaskChange(path.join("t1", "exchange"))).toBe(false);
    expect(isTaskChange(path.join("t1", "exchange", "DONE"))).toBe(false);
    expect(isTaskChange(path.join("t1", "skills", "a", "SKILL.md"))).toBe(false);
  });
});

describe("daemon + api", () => {
  it("au repos : status, tasks", async () => {
    await boot();
    const s = await status();
    expect(s.window).toBeNull();
    expect(s.tasks.map((t) => [t.name, t.cursor, t.status])).toEqual([["t1", "a", "running"]]);
    await shutdown();
  });

  it("start → plage en cours ; second start → 409 ; stop gracieux → repos, plage oubliée", async () => {
    await boot();
    const r = await call<{ until: string }>(sock, "POST", "/window", { for: "1h" });
    expect(new Date(r.until).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    await tick();
    expect((await status()).window?.until).toBe(r.until);
    expect(seen).toHaveLength(1);
    await expect(call(sock, "POST", "/window", { for: "1h" })).rejects.toMatchObject({ status: 409 } satisfies Partial<ApiError>);

    const st = await call<StopResult>(sock, "DELETE", "/window");
    expect(st).toMatchObject({ until: r.until, continuing: null, iteration: "t1", idle: false, stopping: "after-iteration", killed: false });
    await tick();
    expect((await status()).window).toBeNull();
    expect((await status()).manual).toBeNull();
    expect((await savedState()).window).toBeNull();
    await expect(call(sock, "DELETE", "/window")).rejects.toMatchObject({ status: 409 });
    await shutdown();
  });

  it("stop --now : abort, et la plage n'est pas reprise au redémarrage", async () => {
    await boot();
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    expect(await call<StopResult>(sock, "DELETE", "/window?now=1")).toMatchObject({ iteration: "t1", stopping: "now", killed: true });
    await tick();
    expect((await status()).window).toBeNull();
    expect((await savedState()).window).toBeNull();
    await shutdown();
  });

  it("arrêt du service (SIGTERM) : la plage reste enregistrée et est reprise au démarrage suivant", async () => {
    const lines: string[] = [];
    await boot(undefined, (l) => lines.push(l));
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    await shutdown();
    expect(lines.filter((l) => /jetée|reprise au prochain/.test(l))).toEqual(["itération de t1 jetée", expect.stringMatching(/^plage manuelle jusqu'à .* : reprise au prochain démarrage$/)]);
    const saved = JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8")) as RunnerState;
    expect(saved.window).not.toBeNull();

    await boot();
    await tick();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.until.toISOString()).toBe(saved.window!.until);
    expect((await status()).window?.until).toBe(saved.window!.until);
    await shutdown();
  });

  it("une plage enregistrée mais expirée est oubliée", async () => {
    const st = emptyState();
    st.window = { startedAt: "2020-01-01T00:00:00Z", until: "2020-01-01T01:00:00Z" };
    await boot(st);
    await tick();
    expect(seen).toHaveLength(0);
    expect((await status()).window).toBeNull();
    await shutdown();
  });

  it("start refuse sans image de base, ou sans Docker", async () => {
    daemon = new Daemon(cfg, { runWindow: fakeRunWindow, imageExists: async () => false, dockerVersion: async () => "x" });
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    await expect(call(sock, "POST", "/window", { for: "1h" })).rejects.toMatchObject({ status: 409, message: /image de base/ });
    server.close();
    daemon = new Daemon(cfg, { runWindow: fakeRunWindow, dockerVersion: async () => { throw new Error("Cannot connect"); } });
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    await expect(call(sock, "POST", "/window", { for: "1h" })).rejects.toMatchObject({ status: 409, message: /Docker ne répond pas/ });
    server.close();
  });

  it("plage automatique : démarre seule ; stop --auto la coupe (persisté) ; resume la rallume", async () => {
    const { spec, end } = coveringWindow(2);
    cfg.windows = [spec];
    await boot();
    await tick();
    const s1 = await status();
    expect(s1.window?.source).toBe("calendar");
    expect(s1.manual).toBeNull();
    expect(near(s1.auto.coveringUntil, end)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(near(seen[0]!.until.toISOString(), end)).toBe(true);

    const st = await call<StopResult>(sock, "DELETE", "/auto");
    expect(st).toMatchObject({ continuing: null, stopping: "after-iteration" });
    expect(near(st.until, end)).toBe(true);
    await tick();
    const s2 = await status();
    expect(s2.window).toBeNull();
    expect(s2.auto).toMatchObject({ enabled: false, windows: 1, coveringUntil: null, nextStart: null });
    expect((await savedState()).autoEnabled).toBe(false);
    expect(seen).toHaveLength(1);

    const rs = await call<{ coveringUntil: string | null; nextStart: string | null }>(sock, "POST", "/auto");
    expect(near(rs.coveringUntil, end)).toBe(true);
    await tick();
    expect((await status()).window?.source).toBe("calendar");
    expect((await savedState()).autoEnabled).toBe(true);
    expect(seen).toHaveLength(2);
    await shutdown();
  });

  it("plages automatiques coupées : le calendrier ne démarre pas, mais un start manuel travaille (source manual)", async () => {
    const { spec } = coveringWindow(2);
    cfg.windows = [spec];
    const st = emptyState();
    st.autoEnabled = false;
    await boot(st);
    await tick();
    expect(seen).toHaveLength(0);
    expect((await status()).window).toBeNull();

    const r = await call<{ until: string; coveredUntil: string }>(sock, "POST", "/window", { for: "1h" });
    expect(r.coveredUntil).toBe(r.until);
    await tick();
    const s = await status();
    expect(s.window?.source).toBe("manual");
    expect(s.window?.until).toBe(r.until);
    expect(s.auto.enabled).toBe(false);
    await shutdown();
  });

  it("chevauchement : stop de la plage manuelle pendant une plage automatique → le travail continue (calendar)", async () => {
    const { spec, end } = coveringWindow(2);
    cfg.windows = [spec];
    await boot();
    await tick();
    expect((await status()).window?.source).toBe("calendar");

    // start pendant la plage automatique : la couverture s'étend, sans nouvelle plage.
    const r = await call<{ until: string; coveredUntil: string }>(sock, "POST", "/window", { for: "3h" });
    expect(r.coveredUntil).toBe(r.until);
    await tick();
    const s1 = await status();
    expect(s1.window?.source).toBe("manual+calendar");
    expect(s1.window?.until).toBe(r.until);
    expect(s1.manual?.until).toBe(r.until);
    expect(seen).toHaveLength(1);

    const st = await call<StopResult>(sock, "DELETE", "/window?now=1");
    expect(st).toMatchObject({ until: r.until, iteration: "t1", idle: false, stopping: null, killed: false });
    expect(near(st.continuing, end)).toBe(true);
    await tick();
    const s2 = await status();
    expect(s2.window?.source).toBe("calendar");
    expect(near(s2.window?.until, end)).toBe(true);
    expect(s2.manual).toBeNull();
    expect((await savedState()).window).toBeNull();
    expect(seen).toHaveLength(1);
    await shutdown();
  });

  it("chevauchement inverse : stop --auto pendant une plage manuelle → le travail continue (manual) ; resume recolle", async () => {
    const { spec, end } = coveringWindow(2);
    cfg.windows = [spec];
    await boot();
    const r = await call<{ until: string; coveredUntil: string }>(sock, "POST", "/window", { for: "1h" });
    expect(near(r.coveredUntil, end)).toBe(true);
    await tick();
    expect((await status()).window?.source).toBe("manual+calendar");

    const st = await call<StopResult>(sock, "DELETE", "/auto");
    expect(st).toMatchObject({ continuing: r.until, stopping: null });
    await tick();
    const s = await status();
    expect(s.window?.source).toBe("manual");
    expect(s.window?.until).toBe(r.until);
    expect(s.auto.enabled).toBe(false);
    expect(seen).toHaveLength(1);

    await call(sock, "POST", "/auto");
    await tick();
    expect((await status()).window?.source).toBe("manual+calendar");
    expect(seen).toHaveLength(1);
    await shutdown();
  });

  it("stop --auto au repos : rien ne tourne, le calendrier ne réveillera pas ; stop manuel au repos → 409", async () => {
    await boot();
    const st = await call<StopResult>(sock, "DELETE", "/auto");
    expect(st).toMatchObject({ until: null, continuing: null, iteration: null, idle: false, stopping: "now", killed: false });
    expect((await status()).auto.enabled).toBe(false);
    await expect(call(sock, "DELETE", "/window")).rejects.toMatchObject({ status: 409, message: /aucune plage manuelle/ });
    await shutdown();
  });

  /** Passe `active` de t1 directement dans son task.json, sans passer par le démon. */
  async function setActiveByHand(active: boolean): Promise<void> {
    const file = path.join(cfg.tasksDir, "t1", "task.json");
    const def = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...def, active }));
  }

  async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100 && !(await cond()); i++) await tick();
  }

  it("plage sans tâche à faire : rien ne tourne ; une tâche réactivée à la main est prise pendant la plage", async () => {
    await setActiveByHand(false);
    await boot();
    const r = await call<{ until: string }>(sock, "POST", "/window", { for: "1h" });
    await tick();
    const s = await status();
    expect(seen).toHaveLength(0);
    expect(s.window).toBeNull();
    expect(s.idle).toBe(true);
    expect(s.manual?.until).toBe(r.until);

    await setActiveByHand(true);
    await until(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    const s2 = await status();
    expect(s2.idle).toBe(false);
    expect(s2.window?.source).toBe("manual");
    await shutdown();
  });

  it("plage sans tâche à faire : un dossier de tâche ajouté à la main est pris", async () => {
    await setActiveByHand(false);
    await boot();
    await call(sock, "POST", "/window", { for: "1h" });
    await until(async () => (await status()).idle);
    expect(seen).toHaveLength(0);

    // Les écritures d'un container dans exchange/ ne réveillent pas.
    await mkdir(path.join(cfg.tasksDir, "t1", "exchange"), { recursive: true });
    await writeFile(path.join(cfg.tasksDir, "t1", "exchange", "DONE"), "x");

    const t2 = path.join(cfg.tasksDir, "t2");
    await mkdir(path.join(t2, "skills", "a"), { recursive: true });
    await writeFile(path.join(t2, "skills", "a", "SKILL.md"), "x");
    await writeFile(path.join(t2, "task.json"), JSON.stringify({ start: "a", nodes: { a: { skill: "a", next: "a" } } }));
    await until(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    expect((await status()).window?.source).toBe("manual");
    await shutdown();
  });

  it("stop pendant une plage sans tâche à faire : rien ne tournait, plus rien ne couvre", async () => {
    await setActiveByHand(false);
    await boot();
    await call(sock, "POST", "/window", { for: "1h" });
    await until(async () => (await status()).idle);
    const st = await call<StopResult>(sock, "DELETE", "/window");
    expect(st).toMatchObject({ continuing: null, iteration: null, idle: true, stopping: "now", killed: false });
    await tick();
    expect((await status()).idle).toBe(false);
    expect(seen).toHaveLength(0);
    await shutdown();
  });

  /** Démon dont la première plage finit en panne, les suivantes tournent normalement. */
  async function bootFatal(opts: { env?: Record<string, string | undefined>; initial?: RunnerState } = {}) {
    const h = { calls: 0, dockerUp: true };
    const run: typeof runWindow = async (...args) => {
      h.calls += 1;
      if (h.calls === 1) return { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0, endedBecause: "fatal", fatal: { reason: "docker", detail: "down" } };
      return fakeRunWindow(...args);
    };
    if (opts.initial) await saveState(cfg.dataDir, opts.initial);
    daemon = new Daemon(cfg, {
      runWindow: run,
      imageExists: async () => true,
      removeTaskImages: async () => {},
      dockerVersion: async () => {
        if (!h.dockerUp) throw new Error("Cannot connect to the Docker daemon");
        return "x";
      },
      env: opts.env ?? { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    ac = new AbortController();
    loop = daemon.run(ac.signal);
    return h;
  }

  type ResetResult = { manualDropped: string | null; coveringUntil: string | null; nextStart: string | null };

  it("panne pendant une plage manuelle : start et resume refusés, rien ne tourne ; reset-error retire la manuelle sans relancer", async () => {
    const st = emptyState();
    st.autoEnabled = false;
    const h = await bootFatal({ initial: st });
    const r = await call<{ until: string }>(sock, "POST", "/window", { for: "1h" });
    await tick();
    const s = await status();
    expect(h.calls).toBe(1);
    expect(s.fatal).toMatchObject({ reason: "docker" });
    expect(s.window).toBeNull();
    expect(s.manual?.until).toBe(r.until);

    await expect(call(sock, "POST", "/window", { for: "1h" })).rejects.toMatchObject({ status: 409, message: /panne docker en cours/ });
    await expect(call(sock, "POST", "/auto")).rejects.toMatchObject({ status: 409, message: /reset-error/ });
    expect((await savedState()).autoEnabled).toBe(false);

    // Pas encore réparé : la panne reste.
    h.dockerUp = false;
    await expect(call(sock, "DELETE", "/fatal")).rejects.toMatchObject({ status: 409, message: /Docker ne répond pas/ });
    expect((await status()).fatal).not.toBeNull();

    h.dockerUp = true;
    const rs = await call<ResetResult>(sock, "DELETE", "/fatal");
    expect(rs).toMatchObject({ manualDropped: r.until, coveringUntil: null, nextStart: null });
    await tick();
    const s2 = await status();
    expect(s2.fatal).toBeNull();
    expect(s2.manual).toBeNull();
    expect(s2.auto.enabled).toBe(false);
    expect((await savedState()).window).toBeNull();
    expect(h.calls).toBe(1);

    // Réparé : une plage manuelle se pose de nouveau.
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    expect(h.calls).toBe(2);
    await shutdown();
  });

  it("panne pendant une plage automatique : reset-error relance le travail (calendar)", async () => {
    const { spec, end } = coveringWindow(2);
    cfg.windows = [spec];
    const h = await bootFatal();
    await tick();
    expect(h.calls).toBe(1);
    expect((await status()).fatal).toMatchObject({ reason: "docker" });

    const rs = await call<ResetResult>(sock, "DELETE", "/fatal");
    expect(rs.manualDropped).toBeNull();
    expect(near(rs.coveringUntil, end)).toBe(true);
    await tick();
    expect(h.calls).toBe(2);
    expect((await status()).window?.source).toBe("calendar");
    await shutdown();
  });

  it("reset-error : refusé sans panne, et sans token dans l'environnement du démon", async () => {
    const h = await bootFatal({ env: {} });
    await expect(call(sock, "DELETE", "/fatal")).rejects.toMatchObject({ status: 409, message: /aucune panne/ });
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    expect(h.calls).toBe(1);
    await expect(call(sock, "DELETE", "/fatal")).rejects.toMatchObject({ status: 409, message: /CLAUDE_CODE_OAUTH_TOKEN absent/ });
    expect((await status()).fatal).not.toBeNull();
    await shutdown();
  });

  it("tasks : reset et active passent par le démon", async () => {
    await boot();
    await call(sock, "POST", "/tasks/t1/active", { active: false });
    expect((await status()).tasks[0]?.active).toBe(false);
    expect(JSON.parse(await readFile(path.join(cfg.tasksDir, "t1", "task.json"), "utf8")).active).toBe(false);
    await call(sock, "POST", "/tasks/t1/active", { active: true });
    expect((await call<{ start: string }>(sock, "POST", "/tasks/t1/reset")).start).toBe("a");
    await expect(call(sock, "POST", "/tasks/nope/reset")).rejects.toMatchObject({ status: 404 });
    await shutdown();
  });

  it("un second démon est refusé, un socket périmé est nettoyé", async () => {
    await boot();
    const other = createApi(cfg, daemon);
    await expect(listen(other, sock)).rejects.toThrow(/répond déjà/);
    await shutdown();
    await writeFile(sock, "");
    await boot();
    expect((await status()).window).toBeNull();
    await shutdown();
  });

  it("premier démarrage : data/ absent est créé avec le socket", async () => {
    await rm(cfg.dataDir, { recursive: true, force: true });
    await boot();
    expect((await status()).window).toBeNull();
    await shutdown();
  });
});
