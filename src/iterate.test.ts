import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { DockerError, type RunResult } from "./docker.js";
import { iterate, type IterateDeps } from "./iterate.js";
import { emptyState, loadState, type RunnerState } from "./state.js";
import type { Task } from "./task.js";

let root: string;
let cfg: Config;
let task: Task;
let state: RunnerState;
let calls: string[];

const line = (o: object) => JSON.stringify(o);
const ok = (extra: object = {}) =>
  [
    line({ type: "system", subtype: "init", model: "claude-sonnet-5" }),
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 }, seven_day: { utilization: 0.05, resetsAt: 9 } } } }),
    line({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1 }, seven_day: { utilization: 0.05, resetsAt: 9 } } } }),
    line({ type: "result", terminal_reason: "completed", total_cost_usd: 0.05, num_turns: 3, ...extra }),
  ].join("\n") + "\n";

/** Un `runInTask` factice : `script` reçoit les options et rend stdout/stderr/code, et peut poser DONE. */
function deps(
  script: (opts: Parameters<IterateDeps["runInTask"]>[2]) => Promise<Partial<RunResult>> | Partial<RunResult>,
  over: Partial<IterateDeps> = {},
): Partial<IterateDeps> {
  return {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    runInTask: async (_cfg, _name, opts) => {
      calls.push("run");
      opts.onStart?.("ctn");
      const r = await script(opts);
      return { code: 0, stdout: "", stderr: "", container: "ctn", image: "img", ...r };
    },
    commitTask: async () => void calls.push("commit"),
    discardContainer: async () => void calls.push("discard"),
    killContainer: () => void calls.push("kill"),
    ...over,
  };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-it-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: ["--x"], timeoutMinutes: 60 },
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
      start: "a",
      params: { repo: "r" },
      env: [],
      nodes: { a: { skill: "a", params: {}, args: [], next: "b" }, b: { skill: "b", params: {}, args: [], next: "a" } },
    },
  };
  await mkdir(task.exchangeDir, { recursive: true });
  state = emptyState();
  calls = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("iterate", () => {
  it("completed : commit, curseur avancé, état sauvé, log avec quota et modèle", async () => {
    const r = await iterate(cfg, task, state, { deps: deps(() => ({ stdout: ok() })) });
    expect(r).toMatchObject({ node: "a", decision: "next-task", costUsd: 0.05 });
    expect(r.quotaAfter?.five_hour?.utilization).toBe(0.12);
    expect(calls).toEqual(["run", "commit"]);
    expect(state.tasks.t).toMatchObject({ cursor: "b", iterations: 1, consecutiveFailures: 0 });
    expect((await loadState(cfg.dataDir)).tasks.t?.cursor).toBe("b");
    const rec = JSON.parse(await readFile(r.logFile!, "utf8"));
    expect(rec).toMatchObject({ model: "claude-sonnet-5", committed: true, quota: { before: { five_hour: { utilization: 0.1 } }, after: { five_hour: { utilization: 0.12 } } } });
    expect(rec.command).toEqual(["claude", "-p", "--x", "--output-format", "stream-json", "--verbose"]);
    expect(rec.prompt).toBe("/a repo=r");
  });

  it("completed + DONE : task-done, commit", async () => {
    const r = await iterate(cfg, task, state, {
      deps: deps(async (o) => {
        await writeFile(path.join(o.exchangeDir, "DONE"), "");
        return { stdout: ok() };
      }),
    });
    expect(r.decision).toBe("task-done");
    expect(calls).toEqual(["run", "commit"]);
    expect(state.tasks.t?.status).toBe("done");
  });

  it("échec : jeté, DONE retiré, même nœud, un échec compté", async () => {
    const r = await iterate(cfg, task, state, {
      deps: deps(async (o) => {
        await writeFile(path.join(o.exchangeDir, "DONE"), "");
        return { code: 1, stdout: ok({ terminal_reason: "api_error", api_error_status: 500 }) };
      }),
    });
    expect(r).toMatchObject({ outcome: { kind: "failure", reason: "api_error" }, decision: "retry" });
    expect(calls).toEqual(["run", "discard"]);
    expect(await exists(path.join(task.exchangeDir, "DONE"))).toBe(false);
    expect(state.tasks.t).toMatchObject({ cursor: "a", consecutiveFailures: 1 });
  });

  it("quota rejected : backoff avec resetsAt, jeté", async () => {
    const stdout =
      ok() + line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 123 } }) + "\n";
    const r = await iterate(cfg, task, state, { deps: deps(() => ({ code: 1, stdout })) });
    expect(r).toMatchObject({ outcome: { kind: "quota", reason: "five_hour", resetsAt: 123 }, decision: "backoff" });
    expect(calls).toEqual(["run", "discard"]);
    expect(state.tasks.t).toMatchObject({ cursor: "a", consecutiveFailures: 0 });
  });

  it("401 : panne globale, stop-window, tâche intacte", async () => {
    const r = await iterate(cfg, task, state, {
      deps: deps(() => ({ code: 1, stdout: ok({ terminal_reason: "api_error", api_error_status: 401, result: "invalid" }) })),
    });
    expect(r).toMatchObject({ outcome: { kind: "fatal", reason: "auth" }, decision: "stop-window" });
    expect(calls).toEqual(["run", "discard"]);
    expect(state.tasks.t).toMatchObject({ cursor: "a", consecutiveFailures: 0, iterations: 0 });
  });

  it("Docker injoignable au lancement : panne docker", async () => {
    const r = await iterate(cfg, task, state, {
      deps: deps(() => ({ code: 125, stdout: "", stderr: "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock" })),
    });
    expect(r.outcome).toMatchObject({ kind: "fatal", reason: "docker" });
    const r2 = await iterate(cfg, task, state, {
      deps: deps(() => { throw new DockerError("docker introuvable"); }),
    });
    expect(r2.outcome).toMatchObject({ kind: "fatal", reason: "docker", detail: "docker introuvable" });
    expect(r2.logFile).toBeNull();
  });

  it("commit impossible : le travail n'est pas compté, panne docker", async () => {
    const r = await iterate(cfg, task, state, {
      deps: deps(() => ({ stdout: ok() }), { commitTask: async () => { throw new DockerError("commit a échoué"); } }),
    });
    expect(r).toMatchObject({ outcome: { kind: "fatal", reason: "docker" }, decision: "stop-window" });
    expect(calls).toEqual(["run", "discard"]);
    expect(state.tasks.t).toMatchObject({ cursor: "a", iterations: 0, status: "running" });
    expect(state.currentTask).toBe("t");
  });

  it("timeout : container tué, échec timeout", async () => {
    cfg.claude.timeoutMinutes = 0.0005; // 30 ms
    const r = await iterate(cfg, task, state, {
      deps: deps(() => new Promise((res) => setTimeout(() => res({ code: 137, stdout: "" }), 80))),
    });
    expect(r.outcome).toEqual({ kind: "failure", reason: "timeout" });
    expect(calls).toEqual(["run", "kill", "discard"]);
  });

  it("arrêt demandé : tué, jeté, état ni modifié ni sauvé", async () => {
    const ac = new AbortController();
    const r = await iterate(cfg, task, state, {
      signal: ac.signal,
      deps: deps(() => {
        ac.abort();
        return new Promise((res) => setTimeout(() => res({ code: 137, stdout: "" }), 20));
      }),
    });
    expect(r.outcome).toEqual({ kind: "failure", reason: "aborted" });
    expect(calls).toEqual(["run", "kill", "discard"]);
    expect(state.tasks.t?.last).toBeUndefined();
    expect(await exists(path.join(cfg.dataDir, "state.json"))).toBe(false);
  });

  it("env de la tâche : transmis depuis l'hôte ou littéral, token toujours présent", async () => {
    task.def.env = ["GH_TOKEN", "GIT_AUTHOR_NAME=bot"];
    let seen: Record<string, string> | undefined;
    await iterate(cfg, task, state, {
      deps: deps((o) => {
        seen = o.env;
        return { stdout: ok() };
      }, { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok", GH_TOKEN: "gh" } }),
    });
    expect(seen).toEqual({ GH_TOKEN: "gh", GIT_AUTHOR_NAME: "bot", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  });

  it("env manquante ou token absent : panne auth sans rien lancer", async () => {
    task.def.env = ["GH_TOKEN"];
    const r = await iterate(cfg, task, state, { deps: deps(() => ({ stdout: ok() })) });
    expect(r.outcome).toMatchObject({ kind: "fatal", reason: "auth", detail: /GH_TOKEN/ });
    const r2 = await iterate(cfg, task, state, { deps: deps(() => ({ stdout: ok() }), { env: {} }) });
    expect(r2.outcome).toMatchObject({ kind: "fatal", reason: "auth", detail: /CLAUDE_CODE_OAUTH_TOKEN/ });
    expect(calls).toEqual([]);
  });

  it("dry-run : ne lance rien", async () => {
    const lines: string[] = [];
    const r = await iterate(cfg, task, state, { dryRun: true, print: (l) => lines.push(l), deps: deps(() => ({ stdout: ok() })) });
    expect(r.outcome).toEqual({ kind: "failure", reason: "dry_run" });
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.startsWith("prompt   /a repo=r"))).toBe(true);
  });
});
