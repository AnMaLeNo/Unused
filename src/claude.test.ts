import { describe, expect, it } from "vitest";
import { buildCommand, buildPrompt, parseStream, quotaRejection, quotaSnapshot, renderArguments } from "./claude.js";
import type { Config } from "./config.js";
import type { TaskNode } from "./task.js";

const node = (over: Partial<TaskNode> = {}): TaskNode => ({ skill: "do", params: {}, args: [], next: "do", ...over });
const cfg = (sessionArgs: string[]): Config =>
  ({ claude: { sessionArgs, timeoutMinutes: 180 } }) as unknown as Config;

describe("renderArguments / buildPrompt", () => {
  it("cle=valeur, avec guillemets seulement si nécessaire", () => {
    expect(renderArguments({ repo: "https://github.com/a/b", note: "deux mots" })).toBe(
      'repo=https://github.com/a/b note="deux mots"',
    );
  });
  it("skill seul sans params", () => {
    expect(buildPrompt(node(), {})).toBe("/do");
  });
  it("les params du nœud écrasent ceux de la tâche", () => {
    expect(buildPrompt(node({ params: { mode: "fast" } }), { repo: "x", mode: "slow" })).toBe("/do repo=x mode=fast");
  });
});

describe("buildCommand", () => {
  it("sessionArgs puis node.args, et stream-json --verbose imposés en dernier", () => {
    expect(buildCommand(cfg(["--dangerously-skip-permissions"]), node({ args: ["--model", "opus"] }))).toEqual([
      "claude", "-p", "--dangerously-skip-permissions", "--model", "opus", "--output-format", "stream-json", "--verbose",
    ]);
  });
  it("remplace un --output-format / --verbose fournis, sous toutes les formes", () => {
    expect(buildCommand(cfg(["--output-format", "text", "--verbose"]), node({ args: ["--output-format=json"] }))).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose",
    ]);
  });
});

const ndjson = [
  '{"type":"system","subtype":"init","model":"claude-sonnet-5","session_id":"s"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":100,"unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":100},"seven_day":{"utilization":0.05,"resetsAt":900}}}}',
  '{"type":"assistant","message":{}}',
  '{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":100}}',
  '{"type":"result","terminal_reason":"api_error","api_error_status":429,"total_cost_usd":0.01,"num_turns":1}',
].join("\n");

describe("parseStream", () => {
  it("résultat, événements de quota, init, retries", () => {
    const s = parseStream(ndjson + "\n");
    expect(s.lines).toBe(6);
    expect(s.result?.terminal_reason).toBe("api_error");
    expect(s.init?.model).toBe("claude-sonnet-5");
    expect(s.rateLimits).toHaveLength(2);
    expect(s.apiRetries).toEqual([{ type: "system", subtype: "api_retry", error: "rate_limit", error_status: 429 }]);
  });
  it("ignore le bruit et tolère une sortie vide", () => {
    expect(parseStream("Warning: x\npas du json\n").result).toBeNull();
    expect(parseStream("").lines).toBe(0);
  });
  it("quotaSnapshot lit les deux fenêtres, ou la forme minimale", () => {
    const s = parseStream(ndjson);
    expect(quotaSnapshot(s.rateLimits[0])).toEqual({ five_hour: { utilization: 0.1, resetsAt: 100 }, seven_day: { utilization: 0.05, resetsAt: 900 } });
    expect(quotaSnapshot({ status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt: 7 })).toEqual({ seven_day: { utilization: 0.4, resetsAt: 7 } });
    expect(quotaSnapshot({ status: "allowed" })).toBeNull();
    expect(quotaSnapshot(undefined)).toBeNull();
  });
  it("quotaRejection prend le dernier rejected", () => {
    expect(quotaRejection(parseStream(ndjson).rateLimits)).toEqual({ rateLimitType: "five_hour", resetsAt: 100 });
    expect(quotaRejection([{ status: "allowed" }])).toBeNull();
  });
});
