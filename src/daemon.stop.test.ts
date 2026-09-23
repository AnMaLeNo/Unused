import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import type { IterateResult } from "./iterate.js";
import { runWindow } from "./scheduler.js";

let root: string;
let cfg: Config;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-stop-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
  await mkdir(path.join(cfg.tasksDir, "t1", "skills", "a"), { recursive: true });
  await writeFile(path.join(cfg.tasksDir, "t1", "skills", "a", "SKILL.md"), "x");
  await writeFile(path.join(cfg.tasksDir, "t1", "task.json"), JSON.stringify({ start: "a", nodes: { a: { skill: "a", next: "a" } } }));
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Plage automatique en cours : commencée il y a une minute, finit dans deux heures. */
function calendarNow(): void {
  const start = new Date(Date.now() - 60_000);
  const end = new Date(Date.now() + 2 * 3_600_000);
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  cfg.windows = [{ days: [days[start.getDay()]!], from: hhmm(start), to: hhmm(end) }];
}

/** Le vrai scheduler, avec des itérations factices : chacune attend `release()` puis rend `result`. */
function boot(result: () => Omit<IterateResult, "node" | "logFile">) {
  let release!: () => void;
  let started!: () => void;
  const iterationStarted = new Promise<void>((res) => (started = res));
  const daemon = new Daemon(cfg, {
    imageExists: async () => true,
    dockerVersion: async () => "x",
    runWindow: (c, t, s, d, sig, deps) =>
      runWindow(c, t, s, d, sig, {
        ...deps,
        runIteration: async () => {
          started();
          await new Promise<void>((res) => (release = res));
          return { node: "a", logFile: null, ...result() };
        },
      }),
  });
  const ac = new AbortController();
  return { daemon, ac, iterationStarted, release: () => release() };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const saved = async () => JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8"));

describe("unused stop", () => {
  it("plage automatique : pendant la dernière itération, la plage garde sa source et sa fin", async () => {
    calendarNow();
    const { daemon, ac, iterationStarted, release } = boot(() => ({ outcome: { kind: "completed", done: false }, decision: "next-task" }));
    await daemon.init();
    const loop = daemon.run(ac.signal);
    await iterationStarted;

    expect(await daemon.stopWindow(false)).toEqual({ stopping: "after-iteration" });
    const s = await daemon.status();
    expect(s.window).toMatchObject({ source: "calendar", stopping: true });
    expect(s.window!.remainingMs).toBeGreaterThan(3_600_000);

    release();
    await tick();
    expect((await daemon.status()).lastWindow?.endedBecause).toBe("stopped");
    ac.abort();
    await loop;
  });

  it("la plage arrêtée est oubliée tout de suite : un arrêt brutal ne la relancerait pas", async () => {
    const { daemon, ac, iterationStarted, release } = boot(() => ({ outcome: { kind: "completed", done: false }, decision: "next-task" }));
    await daemon.init();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(3_600_000);
    await iterationStarted;
    expect((await saved()).window).not.toBeNull();

    await daemon.stopWindow(false);
    // L'itération tourne encore : c'est l'état qu'un redémarrage relirait.
    expect((await saved()).window).toBeNull();
    release();
    ac.abort();
    await loop;
  });

  it("pendant une attente quota, le stop est immédiat", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    const { daemon, ac, iterationStarted, release } = boot(() => ({
      outcome: { kind: "quota", reason: "five_hour", resetsAt },
      decision: "backoff",
    }));
    await daemon.init();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(8 * 3_600_000);
    await iterationStarted;
    release();
    await tick();
    expect((await daemon.status()).window?.waitingQuotaUntil).not.toBeNull();

    expect(await daemon.stopWindow(false)).toEqual({ stopping: "now" });
    await tick();
    const s = await daemon.status();
    expect(s.window).toBeNull();
    expect(s.lastWindow?.endedBecause).toBe("stopped");
    ac.abort();
    await loop;
  });

  it("sans plage automatique, un stop ne pose aucune pause", async () => {
    const { daemon, ac, iterationStarted, release } = boot(() => ({ outcome: { kind: "completed", done: false }, decision: "next-task" }));
    await daemon.init();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(3_600_000);
    await iterationStarted;
    await daemon.stopWindow(false);
    release();
    await tick();
    expect((await daemon.status()).pausedUntil).toBeNull();
    expect((await saved()).pausedUntil).toBeNull();
    ac.abort();
    await loop;
  });
});
