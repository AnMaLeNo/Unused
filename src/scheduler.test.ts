import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { Decision } from "./graph.js";
import type { IterateResult } from "./iterate.js";
import { runWindow } from "./scheduler.js";
import { emptyState, ensureTaskState, loadState, type RunnerState } from "./state.js";
import type { Task } from "./task.js";

function makeTask(name: string): Task {
  return {
    name,
    dir: `/t/${name}`,
    skillsDir: `/t/${name}/skills`,
    exchangeDir: `/t/${name}/exchange`,
    def: { active: true, start: "a", params: {}, nodes: { a: { skill: "a", params: {}, args: [], next: "a" } } },
  };
}

let dataDir: string;
let cfg: Config;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "unused-sched-"));
  cfg = { dataDir, scheduler: { backoffMinutes: 15, retrySeconds: 60, maxConsecutiveFailures: 3 } } as unknown as Config;
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

/** Horloge simulée : chaque itération dure `iterMs`, sleep avance le temps. */
function clock(start: number, iterMs: number) {
  let t = start;
  return {
    now: () => new Date(t),
    tick: () => (t += iterMs),
    sleep: async (ms: number) => void (t += ms),
  };
}

/** Itération factice : applique la décision voulue à l'état, comme iterate() le ferait. */
function fakeIteration(
  script: (task: Task, n: number) => Decision,
  ck: ReturnType<typeof clock>,
  log: string[],
) {
  let n = 0;
  return async (task: Task, state: RunnerState): Promise<IterateResult> => {
    const decision = script(task, n++);
    const ts = ensureTaskState(state, task);
    ck.tick();
    log.push(`${task.name}:${decision}`);
    if (decision === "task-done") ts.status = "done";
    if (decision === "task-failed") ts.status = "failed";
    if (decision === "backoff" || decision === "retry") state.currentTask = task.name;
    else {
      state.currentTask = null;
      state.lastTask = task.name;
    }
    const kind = decision === "next-task" || decision === "task-done" ? "completed" : decision === "backoff" ? "quota" : "failure";
    return {
      node: "a",
      outcome: kind === "completed" ? { kind, done: decision === "task-done" } : { kind, reason: "x" },
      decision,
      logFile: null,
      costUsd: 0.5,
    };
  };
}

const T0 = Date.parse("2026-09-13T22:00:00Z");
const MIN = 60_000;

describe("runWindow", () => {
  it("round-robin jusqu'à la fin de la plage, l'itération en cours va au bout", async () => {
    const ck = clock(T0, 10 * MIN);
    const log: string[] = [];
    const state = emptyState();
    const s = await runWindow(cfg, [makeTask("a"), makeTask("b")], state, new Date(T0 + 35 * MIN), new AbortController().signal, {
      now: ck.now,
      sleep: ck.sleep,
      runIteration: fakeIteration(() => "next-task", ck, log),
    });
    // 0, 10, 20, 30 min : 4 départs ; le 4e finit à 40 > 35, mais va au bout.
    expect(log).toEqual(["a:next-task", "b:next-task", "a:next-task", "b:next-task"]);
    expect(s).toMatchObject({ iterations: 4, completed: 4, endedBecause: "window", costUsd: 2 });
    expect(state.window).toBeNull();
    expect((await loadState(dataDir)).window).toBeNull();
  });

  it("quota : attente globale puis même tâche", async () => {
    const ck = clock(T0, MIN);
    const log: string[] = [];
    const s = await runWindow(cfg, [makeTask("a"), makeTask("b")], emptyState(), new Date(T0 + 40 * MIN), new AbortController().signal, {
      now: ck.now,
      sleep: ck.sleep,
      runIteration: fakeIteration((_t, n) => (n === 1 ? "backoff" : "next-task"), ck, log),
    });
    // a(1min) b:backoff(1min) + 15min d'attente → b reprend à 17min
    expect(log.slice(0, 4)).toEqual(["a:next-task", "b:backoff", "b:next-task", "a:next-task"]);
    expect(s.backoffs).toBe(1);
  });

  it("l'attente quota ne dépasse pas la fin de plage", async () => {
    const ck = clock(T0, MIN);
    const log: string[] = [];
    const s = await runWindow(cfg, [makeTask("a")], emptyState(), new Date(T0 + 5 * MIN), new AbortController().signal, {
      now: ck.now,
      sleep: ck.sleep,
      runIteration: fakeIteration(() => "backoff", ck, log),
    });
    expect(log).toEqual(["a:backoff"]);
    expect(ck.now().getTime()).toBe(T0 + 5 * MIN);
    expect(s.endedBecause).toBe("window");
  });

  it("s'arrête quand plus rien n'est éligible", async () => {
    const ck = clock(T0, MIN);
    const log: string[] = [];
    const s = await runWindow(cfg, [makeTask("a"), makeTask("b")], emptyState(), new Date(T0 + 60 * MIN), new AbortController().signal, {
      now: ck.now,
      sleep: ck.sleep,
      runIteration: fakeIteration(() => "task-done", ck, log),
    });
    expect(log).toEqual(["a:task-done", "b:task-done"]);
    expect(s.endedBecause).toBe("nothing-eligible");
  });

  it("échec : pause retrySeconds puis même tâche ; task-failed libère la file", async () => {
    const ck = clock(T0, MIN);
    const log: string[] = [];
    await runWindow(cfg, [makeTask("a"), makeTask("b")], emptyState(), new Date(T0 + 10 * MIN), new AbortController().signal, {
      now: ck.now,
      sleep: ck.sleep,
      runIteration: fakeIteration((_t, n) => (n === 0 ? "retry" : n === 1 ? "task-failed" : "next-task"), ck, log),
    });
    expect(log.slice(0, 3)).toEqual(["a:retry", "a:task-failed", "b:next-task"]);
    expect(log.every((l, i) => i < 2 || l.startsWith("b:"))).toBe(true);
  });

  it("arrêt demandé : l'itération abandonnée ne compte pas, la plage reste enregistrée", async () => {
    const ck = clock(T0, MIN);
    const log: string[] = [];
    const ac = new AbortController();
    const state = emptyState();
    const s = await runWindow(cfg, [makeTask("a")], state, new Date(T0 + 60 * MIN), ac.signal, {
      now: ck.now,
      sleep: ck.sleep,
      runIteration: async (task, st) => {
        if (log.length === 1) {
          ac.abort();
          return { node: "a", outcome: { kind: "failure", reason: "aborted" }, decision: "retry", logFile: null };
        }
        return fakeIteration(() => "next-task", ck, log)(task, st);
      },
    });
    expect(log).toEqual(["a:next-task"]);
    expect(s).toMatchObject({ iterations: 1, endedBecause: "stopped" });
    expect(state.window?.until).toBe(new Date(T0 + 60 * MIN).toISOString());
  });
});
