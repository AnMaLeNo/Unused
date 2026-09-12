import { describe, expect, it } from "vitest";
import { applyDecision, applyOutcome, classify, pickNext } from "./graph.js";
import { emptyState, ensureTaskState, type RunnerState } from "./state.js";
import type { Task, TaskFile } from "./task.js";

function makeTask(name: string, def: Partial<TaskFile> = {}): Task {
  return {
    name,
    dir: `/tasks/${name}`,
    skillsDir: `/tasks/${name}/skills`,
    exchangeDir: `/tasks/${name}/exchange`,
    def: {
      active: true,
      start: "find",
      params: {},
      nodes: {
        setup: { skill: "setup", params: {}, args: [], next: "find" },
        find: { skill: "find", params: {}, args: [], next: "do" },
        do: { skill: "do", params: {}, args: [], next: "find" },
      },
      ...def,
    },
  };
}

const opts = { maxConsecutiveFailures: 3, now: () => new Date("2026-09-12T00:00:00Z") };

describe("classify", () => {
  it("completed sans DONE", () => {
    expect(classify("completed", false)).toEqual({ kind: "completed", done: false });
  });
  it("completed avec DONE", () => {
    expect(classify("completed", true)).toEqual({ kind: "completed", done: true });
  });
  it("quota", () => {
    expect(classify("blocking_limit", false)).toEqual({ kind: "quota", reason: "blocking_limit" });
    expect(classify("rapid_refill_breaker", false).kind).toBe("quota");
  });
  it("tout le reste est un échec, y compris une sortie illisible", () => {
    expect(classify("api_error", false)).toEqual({ kind: "failure", reason: "api_error" });
    expect(classify("max_turns", false).kind).toBe("failure");
    expect(classify(undefined, false)).toEqual({ kind: "failure", reason: "unreadable_output" });
  });
  it("DONE ne compte que sur un completed", () => {
    expect(classify("api_error", true).kind).toBe("failure");
  });
});

describe("applyOutcome", () => {
  it("completed avance le curseur et suit le cycle", () => {
    const task = makeTask("a");
    const ts = ensureTaskState(emptyState(), task);
    expect(ts.cursor).toBe("find");
    expect(applyOutcome(task, ts, { kind: "completed", done: false }, opts)).toBe("next-task");
    expect(ts.cursor).toBe("do");
    expect(applyOutcome(task, ts, { kind: "completed", done: false }, opts)).toBe("next-task");
    expect(ts.cursor).toBe("find");
    expect(ts.iterations).toBe(2);
    expect(ts.last).toEqual({ at: "2026-09-12T00:00:00.000Z", node: "do", outcome: "completed" });
  });

  it("completed + DONE termine la tâche sans bouger le curseur", () => {
    const task = makeTask("a");
    const ts = ensureTaskState(emptyState(), task);
    expect(applyOutcome(task, ts, { kind: "completed", done: true }, opts)).toBe("task-done");
    expect(ts.status).toBe("done");
    expect(ts.cursor).toBe("find");
    expect(ts.last?.outcome).toBe("completed+DONE");
  });

  it("quota ne change rien : même nœud, pas d'échec compté", () => {
    const task = makeTask("a");
    const ts = ensureTaskState(emptyState(), task);
    ts.consecutiveFailures = 2;
    expect(applyOutcome(task, ts, { kind: "quota", reason: "blocking_limit" }, opts)).toBe("backoff");
    expect(ts.cursor).toBe("find");
    expect(ts.consecutiveFailures).toBe(2);
    expect(ts.status).toBe("running");
  });

  it("échec : même nœud, puis sortie de la file au N-ième", () => {
    const task = makeTask("a");
    const ts = ensureTaskState(emptyState(), task);
    const fail = { kind: "failure", reason: "api_error" } as const;
    expect(applyOutcome(task, ts, fail, opts)).toBe("retry");
    expect(applyOutcome(task, ts, fail, opts)).toBe("retry");
    expect(ts.cursor).toBe("find");
    expect(applyOutcome(task, ts, fail, opts)).toBe("task-failed");
    expect(ts.status).toBe("failed");
  });

  it("un completed remet le compteur d'échecs à zéro", () => {
    const task = makeTask("a");
    const ts = ensureTaskState(emptyState(), task);
    applyOutcome(task, ts, { kind: "failure", reason: "api_error" }, opts);
    applyOutcome(task, ts, { kind: "completed", done: false }, opts);
    expect(ts.consecutiveFailures).toBe(0);
  });
});

describe("ensureTaskState", () => {
  it("repart de start si le curseur pointe sur un nœud disparu", () => {
    const task = makeTask("a");
    const state = emptyState();
    state.tasks.a = { cursor: "vanished", status: "running", iterations: 4, consecutiveFailures: 0 };
    expect(ensureTaskState(state, task).cursor).toBe("find");
  });
});

describe("pickNext", () => {
  const tasks = [makeTask("a"), makeTask("b"), makeTask("c")];

  function runOnce(state: RunnerState, decision: Parameters<typeof applyDecision>[2]): string {
    const t = pickNext(tasks, state)!;
    applyDecision(state, t, decision);
    return t.name;
  }

  it("round-robin quand tout le monde rend la main", () => {
    const state = emptyState();
    const order = Array.from({ length: 5 }, () => runOnce(state, "next-task"));
    expect(order).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("reste collé à la même tâche tant qu'elle ne rend pas la main", () => {
    const state = emptyState();
    expect(runOnce(state, "next-task")).toBe("a");
    expect(runOnce(state, "backoff")).toBe("b");
    expect(runOnce(state, "retry")).toBe("b");
    expect(runOnce(state, "next-task")).toBe("b");
    expect(runOnce(state, "next-task")).toBe("c");
  });

  it("saute les tâches inactives, terminées ou en échec", () => {
    const state = emptyState();
    const mixed = [makeTask("a", { active: false }), makeTask("b"), makeTask("c"), makeTask("d")];
    state.tasks.c = { cursor: "find", status: "done", iterations: 1, consecutiveFailures: 0 };
    state.tasks.d = { cursor: "find", status: "failed", iterations: 0, consecutiveFailures: 3 };
    expect(pickNext(mixed, state)?.name).toBe("b");
    applyDecision(state, mixed[1]!, "next-task");
    expect(pickNext(mixed, state)?.name).toBe("b");
  });

  it("null quand plus rien n'est éligible", () => {
    const state = emptyState();
    state.tasks.a = { cursor: "find", status: "done", iterations: 1, consecutiveFailures: 0 };
    expect(pickNext([makeTask("a")], state)).toBeNull();
  });

  it("une tâche collante devenue inéligible libère la file", () => {
    const state = emptyState();
    state.currentTask = "b";
    state.lastTask = "a";
    state.tasks.b = { cursor: "find", status: "failed", iterations: 0, consecutiveFailures: 3 };
    expect(pickNext(tasks, state)?.name).toBe("c");
  });
});
