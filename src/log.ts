import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { ClaudeResult } from "./claude.js";
import type { Decision, Outcome } from "./graph.js";

export interface IterationRecord {
  task: string;
  node: string;
  skill: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  image: string;
  container: string;
  command: string[];
  prompt: string;
  exitCode: number;
  timedOut: boolean;
  // Le JSON complet rendu par la session, tel quel.
  result: ClaudeResult | null;
  // Sortie brute si le JSON était illisible, pour comprendre pourquoi.
  rawStdout?: string;
  stderr: string;
  done: boolean;
  outcome: Outcome;
  decision: Decision;
  committed: boolean;
}

export function logsDir(cfg: Config): string {
  return path.join(cfg.dataDir, "logs");
}

/** Un fichier par itération, plus une ligne compacte dans index.jsonl. */
export async function writeIterationLog(cfg: Config, rec: IterationRecord): Promise<string> {
  const dir = path.join(logsDir(cfg), rec.task);
  await mkdir(dir, { recursive: true });
  const stamp = rec.startedAt.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${rec.node}.json`);
  await writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");

  const line = {
    at: rec.startedAt,
    task: rec.task,
    node: rec.node,
    outcome: rec.outcome.kind === "completed" ? "completed" : rec.outcome.reason,
    done: rec.done,
    decision: rec.decision,
    durationMs: rec.durationMs,
    costUsd: rec.result?.total_cost_usd ?? null,
    turns: rec.result?.num_turns ?? null,
    file: path.relative(cfg.dataDir, file),
  };
  await appendFile(path.join(logsDir(cfg), "index.jsonl"), JSON.stringify(line) + "\n", "utf8");
  return file;
}
