import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { ClaudeResult, QuotaSnapshot, RateLimitInfo } from "./claude.js";
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
  model: string | null;
  // Les fenêtres de quota (5 h / 7 j) au premier et au dernier événement de la
  // session : c'est ce qui permet de rapprocher un coût en $ d'un % de quota.
  quota: { before: QuotaSnapshot | null; after: QuotaSnapshot | null };
  // Le message `result` final, tel quel.
  result: ClaudeResult | null;
  rateLimits: RateLimitInfo[];
  apiRetries: { error?: string; error_status?: number | null }[];
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
  // Le nom du nœud est libre dans task.json : un « / » en ferait un chemin.
  const file = path.join(dir, `${stamp}-${rec.node.replace(/[^\w.-]/g, "_")}.json`);
  await writeFile(file, JSON.stringify(rec, null, 2) + "\n", "utf8");

  const line = {
    at: rec.startedAt,
    task: rec.task,
    node: rec.node,
    outcome: rec.outcome.kind === "completed" ? "completed" : rec.outcome.kind === "fatal" ? `fatal:${rec.outcome.reason}` : rec.outcome.reason,
    done: rec.done,
    decision: rec.decision,
    durationMs: rec.durationMs,
    costUsd: rec.result?.total_cost_usd ?? null,
    turns: rec.result?.num_turns ?? null,
    model: rec.model,
    fiveHourBefore: rec.quota.before?.five_hour?.utilization ?? null,
    fiveHourAfter: rec.quota.after?.five_hour?.utilization ?? null,
    sevenDayBefore: rec.quota.before?.seven_day?.utilization ?? null,
    sevenDayAfter: rec.quota.after?.seven_day?.utilization ?? null,
    file: path.relative(cfg.dataDir, file),
  };
  await appendFile(path.join(logsDir(cfg), "index.jsonl"), JSON.stringify(line) + "\n", "utf8");
  return file;
}
