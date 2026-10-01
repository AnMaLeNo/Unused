import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { runWindow } from "./scheduler.js";
import { emptyState, ensureTaskState } from "./state.js";
import type { Task } from "./task.js";

const task: Task = {
  name: "a",
  dir: "/t/a",
  skillsDir: "/t/a/skills",
  exchangeDir: "/t/a/exchange",
  def: { active: true, start: "a", params: {}, env: [], nodes: { a: { skill: "a", params: {}, args: [], next: "a" } } },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-unread-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("tâche momentanément illisible", () => {
  it("la plage continue et la tâche est reprise une fois le fichier réparé", async () => {
    const cfg = { dataDir: root, scheduler: { backoffMinutes: 15, retrySeconds: 60, maxConsecutiveFailures: 3 } } as unknown as Config;
    const T0 = Date.parse("2026-09-14T00:30:00Z");
    let t = T0;
    let loads = 0;
    const ran: string[] = [];
    const s = await runWindow(
      cfg,
      // Deux lectures ratées (task.json en cours d'édition), puis la tâche revient.
      async () => (++loads <= 2 ? [] : [task]),
      emptyState(),
      new Date(T0 + 3_600_000),
      new AbortController().signal,
      {
        now: () => new Date(t),
        sleep: async (ms) => void (t += ms),
        tasksUnreadable: () => loads <= 2,
        runIteration: async (tk, st) => {
          ran.push(tk.name);
          ensureTaskState(st, tk).status = "done";
          t += 10 * 60_000;
          return { node: "a", outcome: { kind: "completed", done: true }, decision: "task-done", logFile: null };
        },
      },
    );
    expect(ran).toEqual(["a"]);
    expect(s.endedBecause).toBe("nothing-eligible"); // fin normale : la tâche a fini son travail
  });

  it("le démon signale au scheduler les tâches qu'il n'a pas pu lire", async () => {
    const cfg: Config = {
      rootDir: root,
      tasksDir: path.join(root, "tasks"),
      dataDir: path.join(root, "data"),
      docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
      windows: [],
      claude: { sessionArgs: [], timeoutMinutes: 60 },
      scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
    };
    await mkdir(path.join(cfg.tasksDir, "t1"), { recursive: true });
    await writeFile(path.join(cfg.tasksDir, "t1", "task.json"), '{ "start": "a", "nodes": {'); // en cours d'édition
    let seen: boolean | undefined;
    let done!: () => void;
    const checked = new Promise<void>((res) => (done = res));
    const daemon = new Daemon(cfg, {
      imageExists: async () => true,
      dockerVersion: async () => "x",
      runWindow: async (_c, tasks, _s, _d, _sig, deps) => {
        if (typeof tasks === "function") await tasks();
        seen = deps?.tasksUnreadable?.();
        done();
        return { iterations: 0, completed: 0, backoffs: 0, failures: 0, costUsd: 0, endedBecause: "stopped" };
      },
    });
    await daemon.init();
    const ac = new AbortController();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(3_600_000);
    await checked;
    expect(seen).toBe(true);
    ac.abort();
    await loop;
  });
});
