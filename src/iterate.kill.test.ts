import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { iterate, type IterateDeps } from "./iterate.js";
import { emptyState } from "./state.js";
import type { Task } from "./task.js";

let root: string;
let cfg: Config;
let task: Task;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-kill-"));
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
    def: { active: true, start: "a", params: {}, env: [], nodes: { a: { skill: "a", params: {}, args: [], next: "a" } } },
  };
  await mkdir(task.exchangeDir, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("arrêt du container", () => {
  it("arrêt demandé avant la création du container : runInTask ne le démarre pas", async () => {
    const ac = new AbortController();
    const seen: boolean[] = [];
    const deps: Partial<IterateDeps> = {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      runInTask: async (_cfg, _name, opts) => {
        opts.onStart?.("ctn");
        seen.push(opts.cancelled?.() ?? false); // container créé, pas d'arrêt
        ac.abort(); // le kill part pendant la création : il ne trouve rien
        seen.push(opts.cancelled?.() ?? false); // container créé, arrêt demandé
        return { code: -1, stdout: "", stderr: "", container: "ctn", image: "img" };
      },
      discardContainer: async () => {},
      killContainer: () => {},
    };
    const r = await iterate(cfg, task, emptyState(), { signal: ac.signal, deps });
    expect(seen).toEqual([false, true]);
    expect(r.outcome).toEqual({ kind: "failure", reason: "aborted" });
  });

  it("un kill qui ne peut pas être lancé ne fait pas tomber le démon", async () => {
    const ac = new AbortController();
    const r = await iterate(cfg, task, emptyState(), {
      signal: ac.signal,
      deps: {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
        runInTask: async (_cfg, _name, opts) => {
          opts.onStart?.("unused-test-container-inexistant");
          ac.abort(); // killContainer par défaut : docker absent ou container inconnu
          await new Promise((res) => setTimeout(res, 50));
          return { code: 137, stdout: "", stderr: "", container: "unused-test-container-inexistant", image: "img" };
        },
        discardContainer: async () => {},
      },
    });
    expect(r.outcome).toEqual({ kind: "failure", reason: "aborted" });
  });
});
