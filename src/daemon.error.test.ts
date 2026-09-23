import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import type { runWindow } from "./scheduler.js";
import { saveState } from "./state.js";

let root: string;
let cfg: Config;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-err-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("plage interrompue par une erreur", () => {
  it("sans plage automatique, elle est oubliée sur disque aussi : pas de reprise au redémarrage", async () => {
    let failed!: () => void;
    const done = new Promise<void>((res) => (failed = res));
    // Comme le vrai scheduler : la plage est enregistrée au départ, puis une erreur survient.
    const crashingRun: typeof runWindow = async (_c, _t, state, deadline) => {
      const until = typeof deadline === "function" ? deadline() : deadline;
      state.window = { startedAt: new Date().toISOString(), until: until.toISOString() };
      await saveState(cfg.dataDir, state);
      setTimeout(failed, 0);
      throw new Error("EACCES: permission denied");
    };
    const daemon = new Daemon(cfg, { runWindow: crashingRun, imageExists: async () => true, dockerVersion: async () => "x" });
    await daemon.init();
    const ac = new AbortController();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(8 * 3_600_000);
    await done;
    await new Promise((r) => setTimeout(r, 20));

    const saved = JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8"));
    expect(saved.window).toBeNull();
    ac.abort();
    await loop;
  });
});
