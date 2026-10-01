import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { runWindow } from "./scheduler.js";
import { emptyState } from "./state.js";
import type { Task } from "./task.js";

const task: Task = {
  name: "a",
  dir: "/t/a",
  skillsDir: "/t/a/skills",
  exchangeDir: "/t/a/exchange",
  def: { active: true, start: "a", params: {}, env: [], nodes: { a: { skill: "a", params: {}, args: [], next: "a" } } },
};

let dataDir: string;
let cfg: Config;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "unused-quota-"));
  cfg = { dataDir, scheduler: { backoffMinutes: 15, retrySeconds: 60, maxConsecutiveFailures: 3 } } as unknown as Config;
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

describe("attente quota qui dépasse la fin de plage", () => {
  it("n'annonce pas de reprise, et l'attente affichée va jusqu'au vrai reset", async () => {
    const T0 = Date.parse("2026-09-14T07:30:00Z");
    const reset = Date.parse("2026-09-14T11:00:00Z");
    let t = T0;
    const lines: string[] = [];
    const events: string[] = [];
    await runWindow(cfg, [task], emptyState(), new Date(Date.parse("2026-09-14T08:00:00Z")), new AbortController().signal, {
      now: () => new Date(t),
      sleep: async (ms) => void (t += ms),
      print: (l) => lines.push(l),
      onEvent: (e) => e.type === "backoff" && events.push(e.until),
      runIteration: async () => ({
        node: "a",
        outcome: { kind: "quota", reason: "five_hour", resetsAt: reset / 1000 },
        decision: "backoff",
        logFile: null,
      }),
    });
    const quotaLine = lines.find((l) => l.includes("saturé"))!;
    expect(quotaLine).not.toContain("reprise");
    expect(quotaLine).toContain("2026-09-14T11:00:30.000Z");
    expect(quotaLine).toContain("la plage se termine avant, à 2026-09-14T08:00:00.000Z");
    expect(events).toEqual(["2026-09-14T11:00:30.000Z"]);
  });
});
