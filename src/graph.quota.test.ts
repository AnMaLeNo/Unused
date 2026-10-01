import { describe, expect, it } from "vitest";
import { applyOutcome, classify } from "./graph.js";
import { emptyState, ensureTaskState } from "./state.js";
import type { Task } from "./task.js";

const task: Task = {
  name: "t",
  dir: "/t",
  skillsDir: "/t/skills",
  exchangeDir: "/t/exchange",
  def: { active: true, start: "a", params: {}, env: [], nodes: { a: { skill: "a", params: {}, args: [], next: "a" } } },
};

describe("429 sans événement rejected", () => {
  it("est traité comme un quota saturé, pas comme un échec de la tâche", () => {
    const outcome = classify({ result: { terminal_reason: "api_error", api_error_status: 429 }, rateLimits: [] }, false);
    expect(outcome).toEqual({ kind: "quota", reason: "http_429" });

    const ts = ensureTaskState(emptyState(), task);
    for (let i = 0; i < 5; i++) {
      expect(applyOutcome(task, ts, outcome, { maxConsecutiveFailures: 3 })).toBe("backoff");
    }
    expect(ts).toMatchObject({ status: "running", consecutiveFailures: 0 });
  });

  it("les autres erreurs HTTP restent des échecs", () => {
    expect(classify({ result: { terminal_reason: "api_error", api_error_status: 529 }, rateLimits: [] }, false)).toEqual({
      kind: "failure",
      reason: "api_error",
    });
  });
});
