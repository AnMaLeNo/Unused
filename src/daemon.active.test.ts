import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { emptyState, saveState } from "./state.js";

let root: string;
let cfg: Config;
let taskFile: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-active-"));
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
  taskFile = path.join(cfg.tasksDir, "t1", "task.json");
  await writeFile(taskFile, JSON.stringify({ start: "a", params: { repo: "r" }, nodes: { a: { skill: "a", next: "a" } } }));
  await chmod(taskFile, 0o660);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("unused tasks activate / deactivate", () => {
  it("activate remet dans la file une tâche sortie sur trop d'échecs, sans perdre son avancement", async () => {
    const st = emptyState();
    st.tasks.t1 = { cursor: "a", status: "failed", iterations: 42, consecutiveFailures: 3 };
    await saveState(cfg.dataDir, st);
    const daemon = new Daemon(cfg);
    await daemon.init();
    await daemon.setActive("t1", true);
    const t = (await daemon.status()).tasks.find((x) => x.name === "t1")!;
    expect(t).toMatchObject({ status: "running", iterations: 42, consecutiveFailures: 0 });
    const saved = JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8"));
    expect(saved.tasks.t1.status).toBe("running");
  });

  it("task.json réécrit en entier, sans fichier temporaire qui traîne, droits conservés", async () => {
    const daemon = new Daemon(cfg);
    await daemon.init();
    await daemon.setActive("t1", false);
    expect(JSON.parse(await readFile(taskFile, "utf8"))).toMatchObject({ active: false, params: { repo: "r" } });
    expect((await stat(taskFile)).mode & 0o777).toBe(0o660);
    expect(await readdir(path.dirname(taskFile))).toEqual(["skills", "task.json"]);
  });
});
