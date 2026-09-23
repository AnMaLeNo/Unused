import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { DockerError } from "./docker.js";
import { iterate } from "./iterate.js";
import { emptyState } from "./state.js";
import type { Task } from "./task.js";

let root: string;
let cfg: Config;
let task: Task;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-commit-"));
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
    def: { active: true, start: "a", params: {}, env: [], nodes: { a: { skill: "a", params: {}, args: [], next: "b" }, b: { skill: "b", params: {}, args: [], next: "a" } } },
  };
  await mkdir(task.exchangeDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("commit impossible", () => {
  it("l'état de la tâche redevient exactement celui d'avant, issue fatal:docker", async () => {
    const state = emptyState();
    state.tasks.t = { cursor: "a", status: "running", iterations: 4, consecutiveFailures: 2 };
    await iterate(cfg, task, state, {
      deps: {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
        runInTask: async () => ({
          code: 0,
          stdout: JSON.stringify({ type: "result", terminal_reason: "completed" }) + "\n",
          stderr: "",
          container: "c",
          image: "i",
        }),
        commitTask: async () => {
          throw new DockerError("commit a échoué");
        },
        discardContainer: async () => {},
      },
    });
    expect(state.tasks.t).toMatchObject({ cursor: "a", status: "running", iterations: 4, consecutiveFailures: 2 });
    expect(state.tasks.t?.last?.outcome).toBe("fatal:docker");
  });
});
