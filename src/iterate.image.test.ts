import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { iterate } from "./iterate.js";
import { emptyState } from "./state.js";
import type { Task } from "./task.js";

let root: string;
let cfg: Config;
let task: Task;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-img-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "unused-base", dockerfileDir: root, flattenAfterLayers: 30 },
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
    def: { active: true, start: "a", params: {}, env: [], nodes: { a: { skill: "a", params: {}, args: [], next: "a" } } },
  };
  await mkdir(task.exchangeDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("image absente", () => {
  it("panne globale docker : la plage s'arrête, la tâche n'accumule pas d'échecs", async () => {
    const state = emptyState();
    const stderr =
      "Unable to find image 'unused-base:latest' locally\n" +
      "docker: Error response from daemon: pull access denied for unused-base, repository does not exist or may require 'docker login'.\n";
    for (let i = 0; i < 3; i++) {
      const r = await iterate(cfg, task, state, {
        deps: {
          env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
          runInTask: async () => ({ code: 125, stdout: "", stderr, container: "c", image: "unused-base" }),
          discardContainer: async () => {},
        },
      });
      expect(r).toMatchObject({ outcome: { kind: "fatal", reason: "docker" }, decision: "stop-window" });
    }
    expect(state.tasks.t).toMatchObject({ status: "running", consecutiveFailures: 0 });
  });
});
