import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, listen, socketPath } from "./api.js";
import { ApiError, call } from "./client.js";
import type { Config } from "./config.js";
import { Daemon, type DaemonStatus } from "./daemon.js";
import type { runWindow, SchedulerDeps, WindowSummary } from "./scheduler.js";
import { emptyState, saveState, type RunnerState } from "./state.js";

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
const fakeRunWindow: typeof runWindow = async (_cfg, _tasks, state, deadline, signal, deps = {}) => {
  const until = typeof deadline === "function" ? deadline() : deadline;
  seen.push({ until, deps });
  // Une itération tourne : un stop gracieux attend sa fin.
  deps.onEvent?.({ type: "iteration-start", task: "t1", node: "a", at: new Date().toISOString() });
  state.window = { startedAt: new Date().toISOString(), until: until.toISOString() };
  await saveState(cfg.dataDir, state);
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
  if (!signal.aborted) {
    state.window = null;
    await saveState(cfg.dataDir, state);
  }
  return summary;
};

async function boot(initial?: RunnerState): Promise<void> {
  if (initial) await saveState(cfg.dataDir, initial);
  daemon = new Daemon(cfg, { runWindow: fakeRunWindow, imageExists: async () => true, removeTaskImages: async () => {}, dockerVersion: async () => "x" });
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

    const st = await call<{ stopping: string }>(sock, "DELETE", "/window");
    expect(st.stopping).toBe("after-iteration");
    await tick();
    expect((await status()).window).toBeNull();
    expect(JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8")).window).toBeNull();
    await expect(call(sock, "DELETE", "/window")).rejects.toMatchObject({ status: 409 });
    await shutdown();
  });

  it("stop --now : abort, et la plage n'est pas reprise au redémarrage", async () => {
    await boot();
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    expect((await call<{ stopping: string }>(sock, "DELETE", "/window?now=1")).stopping).toBe("now");
    await tick();
    expect((await status()).window).toBeNull();
    expect(JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8")).window).toBeNull();
    await shutdown();
  });

  it("arrêt du service (SIGTERM) : la plage reste enregistrée et est reprise au démarrage suivant", async () => {
    await boot();
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    await shutdown();
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

  it("plage automatique : démarre seule, stop la met en pause jusqu'à sa fin", async () => {
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const start = new Date(now.getTime() - 60_000);
    const end = new Date(now.getTime() + 2 * 3_600_000);
    cfg.windows = [{ days: [days[start.getDay()]!], from: hhmm(start), to: hhmm(end) }];
    await boot();
    await tick();
    const s1 = await status();
    expect(s1.window?.source).toBe("calendar");
    expect(seen).toHaveLength(1);
    expect(Math.abs(seen[0]!.until.getTime() - end.getTime())).toBeLessThan(60_000);

    await call(sock, "DELETE", "/window");
    await tick();
    const s2 = await status();
    expect(s2.window).toBeNull();
    expect(s2.pausedUntil).not.toBeNull();
    expect(seen).toHaveLength(1);
    // Un start manuel lève la pause.
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    expect((await status()).window?.source).toBe("manual+calendar");
    await shutdown();
  });

  it("plage automatique sans rien à faire : pause, levée par un reset", async () => {
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const start = new Date(now.getTime() - 60_000);
    const end = new Date(now.getTime() + 2 * 3_600_000);
    cfg.windows = [{ days: [days[start.getDay()]!], from: hhmm(start), to: hhmm(end) }];
    let calls = 0;
    const idleRun: typeof runWindow = async (_c, _t, state) => {
      calls += 1;
      state.window = null;
      return { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0, endedBecause: "nothing-eligible" };
    };
    daemon = new Daemon(cfg, { runWindow: idleRun, imageExists: async () => true, removeTaskImages: async () => {}, dockerVersion: async () => "x" });
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    ac = new AbortController();
    loop = daemon.run(ac.signal);
    await tick();
    expect(calls).toBe(1);
    expect((await status()).pausedUntil).not.toBeNull();
    await call(sock, "POST", "/tasks/t1/reset");
    await tick();
    expect(calls).toBe(2);
    await shutdown();
  });

  it("panne globale : plus rien ne tourne jusqu'à un start", async () => {
    const fatalRun: typeof runWindow = async (_c, _t, state, _d, _s, _deps) => {
      state.window = { startedAt: "x", until: new Date(Date.now() + 3_600_000).toISOString() };
      return { iterations: 0, completed: 0, failures: 0, backoffs: 0, costUsd: 0, endedBecause: "fatal", fatal: { reason: "auth", detail: "401" } };
    };
    daemon = new Daemon(cfg, { runWindow: fatalRun, imageExists: async () => true, dockerVersion: async () => "x" });
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    ac = new AbortController();
    loop = daemon.run(ac.signal);
    await call(sock, "POST", "/window", { for: "1h" });
    await tick();
    const s = await status();
    expect(s.fatal).toMatchObject({ reason: "auth" });
    expect(s.window).toBeNull();
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
});
