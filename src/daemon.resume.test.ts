import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { runWindow } from "./scheduler.js";

let root: string;
let cfg: Config;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-resume-"));
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

function calendarNow(): void {
  const start = new Date(Date.now() - 60_000);
  const end = new Date(Date.now() + 2 * 3_600_000);
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  cfg.windows = [{ days: [days[start.getDay()]!], from: hhmm(start), to: hhmm(end) }];
}

/** Démon sur le vrai scheduler, dont l'unique itération ne finit jamais (le service va être tué). */
async function bootRunning(manualMs?: number) {
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
          return new Promise(() => {});
        },
      }),
  });
  await daemon.init();
  void daemon.run(new AbortController().signal);
  if (manualMs) await daemon.startWindow(manualMs);
  await iterationStarted;
  return JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8"));
}

describe("reprise après un arrêt brutal", () => {
  it("une plage automatique n'est pas enregistrée comme une plage manuelle", async () => {
    calendarNow();
    const saved = await bootRunning();
    expect(saved.window).toBeNull();

    // Redémarrage : le calendrier reprend seul, rien de « manuel » n'apparaît.
    const again = new Daemon(cfg, { now: () => new Date() });
    await again.init();
    expect((await again.status()).window).toBeNull();
  });

  it("si le calendrier a été retiré de la config, rien ne reprend", async () => {
    calendarNow();
    await bootRunning();
    cfg.windows = [];
    const again = new Daemon(cfg);
    await again.init();
    expect((await again.status()).window).toBeNull();
  });

  it("une plage manuelle, elle, est toujours reprise jusqu'à sa fin", async () => {
    const saved = await bootRunning(8 * 3_600_000);
    const until = new Date(saved.window.until).getTime();
    expect(Math.abs(until - (Date.now() + 8 * 3_600_000))).toBeLessThan(10_000);
  });
});
