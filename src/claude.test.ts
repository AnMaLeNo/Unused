import { describe, expect, it } from "vitest";
import { buildCommand, buildPrompt, parseResult, renderArguments } from "./claude.js";
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
  it("sessionArgs puis node.args, et --output-format json imposé en dernier", () => {
    expect(buildCommand(cfg(["--dangerously-skip-permissions"]), node({ args: ["--model", "opus"] }))).toEqual([
      "claude", "-p", "--dangerously-skip-permissions", "--model", "opus", "--output-format", "json",
    ]);
  });
  it("remplace un --output-format fourni, sous les deux formes", () => {
    expect(buildCommand(cfg(["--output-format", "text", "--verbose"]), node({ args: ["--output-format=stream-json"] }))).toEqual([
      "claude", "-p", "--verbose", "--output-format", "json",
    ]);
  });
});

describe("parseResult", () => {
  const ok = '{"type":"result","terminal_reason":"completed","total_cost_usd":0.01,"num_turns":3}';
  it("JSON propre", () => {
    expect(parseResult(ok + "\n")?.terminal_reason).toBe("completed");
  });
  it("JSON précédé de bruit sur stdout", () => {
    expect(parseResult("Warning: blabla\n" + ok)?.num_turns).toBe(3);
  });
  it("null si illisible ou pas un result", () => {
    expect(parseResult("")).toBeNull();
    expect(parseResult("pas du json")).toBeNull();
    expect(parseResult('{"type":"assistant"}')).toBeNull();
  });
});
