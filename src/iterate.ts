import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { buildCommand, buildPrompt, parseStream, quotaSnapshot, type QuotaSnapshot } from "./claude.js";
import type { Config } from "./config.js";
import { commitTask, discardContainer, docker, DockerError, runInTask } from "./docker.js";
import { applyDecision, applyOutcome, classify, type Decision, type Outcome } from "./graph.js";
import { writeIterationLog, type IterationRecord } from "./log.js";
import { ensureTaskState, saveState, type RunnerState } from "./state.js";
import { resolveEnv, type Task } from "./task.js";

export const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const DONE_FILE = "DONE";

/** Les effets de bord d'une itération, remplaçables dans les tests. */
export interface IterateDeps {
  runInTask: typeof runInTask;
  commitTask: typeof commitTask;
  discardContainer: typeof discardContainer;
  killContainer: (container: string) => void;
  env: Record<string, string | undefined>;
  now: () => Date;
}

const defaultDeps: IterateDeps = {
  runInTask,
  commitTask,
  discardContainer,
  killContainer: (c) => void docker(["kill", c]),
  env: process.env,
  now: () => new Date(),
};

export interface IterateOptions {
  dryRun?: boolean;
  print?: (line: string) => void;
  // Arrêt demandé : le container est tué, l'itération est jetée sans toucher à l'état.
  signal?: AbortSignal;
  deps?: Partial<IterateDeps>;
}

export interface IterateResult {
  node: string;
  outcome: Outcome;
  decision: Decision;
  logFile: string | null;
  costUsd?: number;
  quotaAfter?: QuotaSnapshot | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const DOCKER_DOWN = /Cannot connect to the Docker daemon|docker daemon is not running|error during connect|permission denied while trying to connect to the Docker daemon/i;
// Image absente (base jamais construite, `docker image prune -a`, nouvelle
// machine) : aucune tâche ne peut tourner non plus, ce n'est pas leur faute.
const IMAGE_MISSING = /Unable to find image|pull access denied|No such image/i;

/** Docker est-il inutilisable (démon injoignable, image absente), d'après ce que `docker run` a dit ? */
export function isDockerDown(stderr: string): boolean {
  return DOCKER_DOWN.test(stderr) || IMAGE_MISSING.test(stderr);
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
  const deps: IterateDeps = { ...defaultDeps, ...opts.deps };
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

  const token = deps.env[TOKEN_ENV];
  if (!token) {
    return finishFatal("auth", `${TOKEN_ENV} absent : lance \`claude setup-token\` et mets le token dans .env`);
  }
  const taskEnv = resolveEnv(task.def.env, deps.env);
  if (taskEnv.missing.length > 0) {
    return finishFatal("auth", `variables absentes de l'environnement du démon : ${taskEnv.missing.join(", ")}`);
  }

  // Un DONE qui traîne d'une itération précédente ne doit pas être pris pour
  // celui de cette session.
  await rm(donePath, { force: true });

  const startedAt = deps.now();
  print(`départ   ${startedAt.toISOString()}`);

  let timedOut = false;
  let aborted = false;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let r: Awaited<ReturnType<typeof runInTask>>;
  try {
    r = await deps.runInTask(cfg, task.name, {
      cmd: command,
      stdin: prompt,
      exchangeDir: task.exchangeDir,
      env: { ...taskEnv.env, [TOKEN_ENV]: token },
      // Les skills du graphe, lus depuis l'hôte : jamais copiés, jamais commités.
      mounts: [{ host: task.skillsDir, container: "/work/.claude/skills", readonly: true }],
      onStart: (container) => {
        timer = setTimeout(() => {
          timedOut = true;
          deps.killContainer(container);
        }, cfg.claude.timeoutMinutes * 60_000);
        onAbort = () => {
          aborted = true;
          deps.killContainer(container);
        };
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener("abort", onAbort);
      },
    }).finally(() => {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    });
  } catch (err) {
    if (err instanceof DockerError) return finishFatal("docker", err.message);
    throw err;
  }
  const endedAt = deps.now();

  const session = parseStream(r.stdout);
  const done = await exists(donePath);
  const quotaBefore = quotaSnapshot(session.rateLimits[0]);
  const quotaAfter = quotaSnapshot(session.rateLimits[session.rateLimits.length - 1]);

  let outcome: Outcome;
  if (aborted) outcome = { kind: "failure", reason: "aborted" };
  else if (timedOut) outcome = { kind: "failure", reason: "timeout" };
  else if (session.lines === 0 && isDockerDown(r.stderr)) outcome = { kind: "fatal", reason: "docker", detail: r.stderr.trim() };
  else outcome = classify(session, done);

  // Un arrêt demandé ne compte ni comme échec ni comme quoi que ce soit.
  const decision: Decision = aborted
    ? "retry"
    : applyOutcome(task, ts, outcome, { maxConsecutiveFailures: cfg.scheduler.maxConsecutiveFailures });
  if (!aborted) applyDecision(state, task, decision);

  let committed = false;
  if (outcome.kind === "completed") {
    try {
      await deps.commitTask(cfg, task.name, r.container);
      committed = true;
    } catch (err) {
      if (!(err instanceof DockerError)) throw err;
      // Le travail est fait mais l'état ne peut pas être conservé : on ne
      // ment pas au curseur, l'itération est réputée n'avoir jamais eu lieu.
      outcome = { kind: "fatal", reason: "docker", detail: err.message };
      ts.cursor = nodeName;
      ts.iterations -= 1;
      ts.status = "running";
      await deps.discardContainer(r.container);
      await rm(donePath, { force: true });
      applyDecision(state, task, "stop-window");
    }
  } else {
    await deps.discardContainer(r.container);
    await rm(donePath, { force: true });
  }
  const finalDecision: Decision = outcome.kind === "fatal" ? "stop-window" : decision;
  if (!aborted) await saveState(cfg.dataDir, state);

  const model = typeof session.init?.model === "string" ? session.init.model : Object.keys(session.result?.modelUsage ?? {})[0];
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
    model: model ?? null,
    quota: { before: quotaBefore, after: quotaAfter },
    result: session.result,
    rateLimits: session.rateLimits,
    apiRetries: session.apiRetries,
    ...(session.result === null ? { rawStdout: r.stdout } : {}),
    stderr: r.stderr,
    done,
    outcome,
    decision: finalDecision,
    committed,
  };
  const logFile = await writeIterationLog(cfg, rec);

  const label = outcome.kind === "completed" ? "completed" : outcome.kind === "fatal" ? `fatal:${outcome.reason}` : outcome.reason;
  print(`fin      ${endedAt.toISOString()} (${Math.round(rec.durationMs / 1000)}s, code ${r.code})`);
  print(`issue    ${label}${done ? " + DONE" : ""} → ${finalDecision}${committed ? " (commit)" : " (jeté)"}`);
  if (session.result?.total_cost_usd !== undefined) {
    print(`coût     $${session.result.total_cost_usd.toFixed(4)}, ${session.result.num_turns ?? "?"} tours${model ? `, ${model}` : ""}`);
  }
  if (quotaAfter) print(`quota    ${describeQuota(quotaBefore)} → ${describeQuota(quotaAfter)}`);
  if (outcome.kind === "fatal") print(`panne    ${outcome.detail.split("\n")[0]}`);
  if (session.result === null && r.stderr.trim()) print(`stderr   ${r.stderr.trim().split("\n").slice(-3).join("\n         ")}`);
  print(`curseur  ${ts.cursor}`);
  print(`log      ${logFile}`);
  return { node: nodeName, outcome, decision: finalDecision, logFile, costUsd: session.result?.total_cost_usd, quotaAfter };

  function finishFatal(reason: "auth" | "docker", detail: string): IterateResult {
    const outcome: Outcome = { kind: "fatal", reason, detail };
    print(`panne    ${detail.split("\n")[0]}`);
    return { node: nodeName, outcome, decision: "stop-window", logFile: null };
  }
}

export function describeQuota(q: QuotaSnapshot | null): string {
  if (!q) return "?";
  const pct = (w?: { utilization: number }) => (w ? `${Math.round(w.utilization * 1000) / 10}%` : "?");
  return `5h ${pct(q.five_hour)} / 7j ${pct(q.seven_day)}`;
}
