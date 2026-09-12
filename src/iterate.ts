import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { buildCommand, buildPrompt, parseResult } from "./claude.js";
import type { Config } from "./config.js";
import { commitTask, discardContainer, docker, runInTask } from "./docker.js";
import { applyDecision, applyOutcome, classify, type Decision, type Outcome } from "./graph.js";
import { writeIterationLog, type IterationRecord } from "./log.js";
import { ensureTaskState, saveState, type RunnerState } from "./state.js";
import type { Task } from "./task.js";

export const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const DONE_FILE = "DONE";

export interface IterateOptions {
  dryRun?: boolean;
  print?: (line: string) => void;
}

export interface IterateResult {
  node: string;
  outcome: Outcome;
  decision: Decision;
  logFile: string | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Une itération = une session `claude -p` sur le nœud courant de la tâche,
 * dans son container. Réussie (`completed`), elle est commitée et le curseur
 * avance ; sinon elle est réputée n'avoir jamais eu lieu : container jeté,
 * DONE retiré, même nœud.
 */
export async function iterate(
  cfg: Config,
  task: Task,
  state: RunnerState,
  opts: IterateOptions = {},
): Promise<IterateResult> {
  const print = opts.print ?? (() => {});
  const ts = ensureTaskState(state, task);
  if (ts.status !== "running") {
    throw new Error(`la tâche ${task.name} est ${ts.status === "done" ? "terminée" : "en échec"} ; rien à itérer`);
  }
  const nodeName = ts.cursor;
  const node = task.def.nodes[nodeName]!;
  const prompt = buildPrompt(node, task.def.params);
  const command = buildCommand(cfg, node);
  const donePath = path.join(task.exchangeDir, DONE_FILE);

  print(`tâche    ${task.name}`);
  print(`nœud     ${nodeName} (skill /${node.skill})`);
  print(`prompt   ${prompt}`);
  print(`commande ${command.join(" ")}`);

  if (opts.dryRun) {
    return { node: nodeName, outcome: { kind: "failure", reason: "dry_run" }, decision: "retry", logFile: null };
  }

  const token = process.env[TOKEN_ENV];
  if (!token) {
    throw new Error(`${TOKEN_ENV} absent : lance \`claude setup-token\` et mets le token dans .env ou l'environnement`);
  }

  // Un DONE qui traîne d'une itération précédente ne doit pas être pris pour
  // celui de cette session.
  await rm(donePath, { force: true });

  const startedAt = new Date();
  print(`départ   ${startedAt.toISOString()}`);

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const run = runInTask(cfg, task.name, {
    cmd: command,
    stdin: prompt,
    exchangeDir: task.exchangeDir,
    env: { [TOKEN_ENV]: token },
    // Les skills du graphe, lus depuis l'hôte : jamais copiés, jamais commités.
    mounts: [{ host: task.skillsDir, container: "/work/.claude/skills", readonly: true }],
    onStart: (container) => {
      timer = setTimeout(() => {
        timedOut = true;
        void docker(["kill", container]);
      }, cfg.claude.timeoutMinutes * 60_000);
    },
  });
  const r = await run.finally(() => clearTimeout(timer));
  const endedAt = new Date();

  const result = parseResult(r.stdout);
  const done = await exists(donePath);
  const outcome = timedOut ? ({ kind: "failure", reason: "timeout" } as const) : classify(result?.terminal_reason, done);
  const decision = applyOutcome(task, ts, outcome, { maxConsecutiveFailures: cfg.scheduler.maxConsecutiveFailures });
  applyDecision(state, task, decision);

  let committed = false;
  if (outcome.kind === "completed") {
    await commitTask(cfg, task.name, r.container);
    committed = true;
  } else {
    await discardContainer(r.container);
    await rm(donePath, { force: true });
  }
  await saveState(cfg.dataDir, state);

  const rec: IterationRecord = {
    task: task.name,
    node: nodeName,
    skill: node.skill,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    image: r.image,
    container: r.container,
    command,
    prompt,
    exitCode: r.code,
    timedOut,
    result,
    ...(result === null ? { rawStdout: r.stdout } : {}),
    stderr: r.stderr,
    done,
    outcome,
    decision,
    committed,
  };
  const logFile = await writeIterationLog(cfg, rec);

  const label = outcome.kind === "completed" ? "completed" : outcome.reason;
  print(`fin      ${endedAt.toISOString()} (${Math.round(rec.durationMs / 1000)}s, code ${r.code})`);
  print(`issue    ${label}${done ? " + DONE" : ""} → ${decision}${committed ? " (commit)" : " (jeté)"}`);
  if (result?.total_cost_usd !== undefined) print(`coût     $${result.total_cost_usd.toFixed(4)}, ${result.num_turns ?? "?"} tours`);
  if (result === null) print(`stderr   ${r.stderr.trim().split("\n").slice(-3).join("\n         ")}`);
  print(`curseur  ${ts.cursor}`);
  print(`log      ${logFile}`);
  return { node: nodeName, outcome, decision, logFile };
}
