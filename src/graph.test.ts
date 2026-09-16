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

const noQuota = { result: null, rateLimits: [] };
const res = (r: Record<string, unknown>) => ({ result: r, rateLimits: [] });

describe("classify", () => {
  it("completed sans / avec DONE", () => {
    expect(classify(res({ terminal_reason: "completed" }), false)).toEqual({ kind: "completed", done: false });
    expect(classify(res({ terminal_reason: "completed" }), true)).toEqual({ kind: "completed", done: true });
  });
  it("quota : un rate_limit_event rejected, avec son reset", () => {
    expect(
      classify(
        {
          result: { terminal_reason: "api_error", api_error_status: 429 },
          rateLimits: [
            { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1 } } },
            { status: "rejected", rateLimitType: "five_hour", resetsAt: 1789596600 },
          ],
        },
        false,
      ),
    ).toEqual({ kind: "quota", reason: "five_hour", resetsAt: 1789596600 });
  });
  it("le quota prime sur tout, même un completed tardif", () => {
    expect(classify({ result: { terminal_reason: "completed" }, rateLimits: [{ status: "rejected" }] }, true).kind).toBe("quota");
  });
  it("blocking_limit est un échec (contexte plein), pas le quota", () => {
    expect(classify(res({ terminal_reason: "blocking_limit" }), false)).toEqual({ kind: "failure", reason: "blocking_limit" });
  });
  it("401 / 403 : panne globale d'authentification", () => {
    const o = classify(res({ terminal_reason: "api_error", api_error_status: 401, result: "OAuth token is invalid" }), false);
    expect(o).toMatchObject({ kind: "fatal", reason: "auth" });
  });
  it("tout le reste est un échec, y compris une sortie illisible", () => {
    expect(classify(res({ terminal_reason: "api_error", api_error_status: 500 }), false)).toEqual({ kind: "failure", reason: "api_error" });
    expect(classify(res({ terminal_reason: "max_turns" }), false).kind).toBe("failure");
    expect(classify(noQuota, false)).toEqual({ kind: "failure", reason: "unreadable_output" });
  });
  it("DONE ne compte que sur un completed", () => {
    expect(classify(res({ terminal_reason: "api_error" }), true).kind).toBe("failure");
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
    expect(applyOutcome(task, ts, { kind: "quota", reason: "five_hour", resetsAt: 1 }, opts)).toBe("backoff");
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

describe("applyOutcome › fatal", () => {
  it("stop-window : rien ne bouge, la tâche reste collante", () => {
    const task = makeTask("a");
    const state = emptyState();
    const ts = ensureTaskState(state, task);
    ts.consecutiveFailures = 1;
    const d = applyOutcome(task, ts, { kind: "fatal", reason: "auth", detail: "401" }, opts);
    expect(d).toBe("stop-window");
    expect(ts).toMatchObject({ cursor: "find", status: "running", consecutiveFailures: 1 });
    expect(ts.last?.outcome).toBe("fatal:auth");
    applyDecision(state, task, d);
    expect(state.currentTask).toBe("a");
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
