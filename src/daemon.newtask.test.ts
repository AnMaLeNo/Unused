import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { emptyState, saveState } from "./state.js";

let root: string;
let cfg: Config;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-new-"));
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

describe("unused tasks new sur un nom déjà utilisé", () => {
  it("la tâche neuve n'hérite ni de l'état ni de l'image de l'ancienne", async () => {
    // L'ancienne tâche « audit » : dossier supprimé à la main, état et image restés.
    const st = emptyState();
    st.tasks.audit = { cursor: "work", status: "done", iterations: 120, consecutiveFailures: 0 };
    st.currentTask = "audit";
    await saveState(cfg.dataDir, st);
    const removed: string[] = [];
    const daemon = new Daemon(cfg, { imageExists: async () => true, removeTaskImages: async (n) => void removed.push(n) });
    await daemon.init();

    await daemon.newTask("audit");
    expect(removed).toEqual(["audit"]);
    const t = (await daemon.status()).tasks.find((x) => x.name === "audit")!;
    expect(t).toMatchObject({ status: "running", iterations: 0, cursor: "setup" });
    const saved = JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8"));
    expect(saved.tasks.audit).toBeUndefined();
    expect(saved.currentTask).toBeNull();
  });

  it("un dossier existant n'est jamais écrasé ni nettoyé", async () => {
    const removed: string[] = [];
    const daemon = new Daemon(cfg, { imageExists: async () => true, removeTaskImages: async (n) => void removed.push(n) });
    await daemon.init();
    await daemon.newTask("audit");
    removed.length = 0;
    await expect(daemon.newTask("audit")).rejects.toThrow(/existe déjà/);
    expect(removed).toEqual([]);
    expect((await stat(path.join(cfg.tasksDir, "audit", "task.json"))).isFile()).toBe(true);
  });
});
