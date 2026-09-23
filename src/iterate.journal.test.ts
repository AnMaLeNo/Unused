import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { iterate, type IterateDeps } from "./iterate.js";
import { emptyState, loadState } from "./state.js";
import type { Task } from "./task.js";

let root: string;
let cfg: Config;
let task: Task;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-log-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
  const dir = path.join(cfg.tasksDir, "t");
  task = {
    name: "t",
    dir,
    skillsDir: path.join(dir, "skills"),
    exchangeDir: path.join(dir, "exchange"),
    def: {
      active: true,
      start: "audit/choose",
      params: {},
      env: [],
      nodes: {
        "audit/choose": { skill: "choose", params: {}, args: [], next: "audit/analyze" },
        "audit/analyze": { skill: "analyze", params: {}, args: [], next: "audit/choose" },
      },
    },
  };
  await mkdir(task.exchangeDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const completed: Partial<IterateDeps> = {
  env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
  runInTask: async () => ({ code: 0, stdout: JSON.stringify({ type: "result", terminal_reason: "completed" }) + "\n", stderr: "", container: "c", image: "i" }),
  commitTask: async () => {},
  discardContainer: async () => {},
};

describe("journal d'itération", () => {
  it("un nom de nœud avec « / » donne un fichier de journal, pas une erreur", async () => {
    const r = await iterate(cfg, task, emptyState(), { deps: completed });
    expect(r.outcome).toEqual({ kind: "completed", done: false });
    expect(r.logFile).toMatch(/audit_choose\.json$/);
    expect((await stat(r.logFile!)).isFile()).toBe(true);
  });

  it("un journal impossible à écrire n'efface pas l'itération", async () => {
    await mkdir(cfg.dataDir, { recursive: true });
    await writeFile(path.join(cfg.dataDir, "logs"), "pas un dossier"); // logs/ inutilisable
    const lines: string[] = [];
    const state = emptyState();
    const r = await iterate(cfg, task, state, { deps: completed, print: (l) => lines.push(l) });
    expect(r).toMatchObject({ outcome: { kind: "completed" }, decision: "next-task", logFile: null });
    expect(lines.some((l) => l.startsWith("journal non écrit"))).toBe(true);
    // Le curseur a avancé et c'est enregistré.
    expect((await loadState(cfg.dataDir)).tasks.t?.cursor).toBe("audit/analyze");
  });
});
