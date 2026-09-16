import { quotaRejection, type ClaudeResult, type RateLimitInfo } from "./claude.js";
import type { TaskState, RunnerState } from "./state.js";
import type { Task } from "./task.js";

/**
 * Issue d'une itération, vue du runner. Il ne lit jamais ce que Claude a
 * produit : seulement comment la session s'est terminée, et si le skill a
 * déposé DONE dans /exchange.
 *
 * Règle : une itération qui ne se termine pas en `completed` est réputée
 * n'avoir jamais eu lieu. Le container n'est pas commité, et un DONE laissé
 * dans /exchange est retiré, pour que le rejeu reparte de l'état exact
 * d'avant l'itération. C'est l'exécuteur (étape 3) qui applique ça.
 */
export type Outcome =
  | { kind: "completed"; done: boolean }
  // Quota saturé (rate_limit_event rejected) : ni la tâche ni le nœud ne
  // bougent, tout le monde attend — jusqu'à `resetsAt` (epoch s) si connu.
  | { kind: "quota"; reason: string; resetsAt?: number }
  // Tout le reste : erreur API, crash, sortie illisible, contexte plein
  // (blocking_limit), coupure par budget/tours…
  | { kind: "failure"; reason: string }
  // Panne globale : rien ne peut réussir tant que ce n'est pas réparé.
  | { kind: "fatal"; reason: "auth" | "docker"; detail: string };

export type Decision =
  | "next-task" // completed → curseur avancé, on passe à la tâche suivante
  | "task-done" // completed + DONE → tâche terminée, sortie de la file
  | "backoff" // quota → attente globale, puis même tâche, même nœud
  | "retry" // échec → même tâche, même nœud
  | "task-failed" // trop d'échecs consécutifs → tâche sortie de la file
  | "stop-window"; // panne globale → la plage s'arrête, même tâche, même nœud au retour

const AUTH_STATUSES = new Set([401, 403]);

/**
 * Traduit la fin d'une session. Le quota se lit dans les événements
 * rate_limit_event (un `rejected`), pas dans terminal_reason : `blocking_limit`
 * y désigne la fenêtre de contexte pleine, pas le quota.
 */
export function classify(
  session: { result: ClaudeResult | null; rateLimits: RateLimitInfo[] },
  done: boolean,
): Outcome {
  const rejected = quotaRejection(session.rateLimits);
  if (rejected) return { kind: "quota", reason: rejected.rateLimitType, resetsAt: rejected.resetsAt };
  const r = session.result;
  if (r?.terminal_reason === "completed") return { kind: "completed", done };
  if (r?.api_error_status !== undefined && r.api_error_status !== null && AUTH_STATUSES.has(r.api_error_status)) {
    return { kind: "fatal", reason: "auth", detail: `HTTP ${r.api_error_status} : ${r.result ?? "authentification refusée"}` };
  }
  return { kind: "failure", reason: r?.terminal_reason ?? "unreadable_output" };
}

export interface ApplyOptions {
  maxConsecutiveFailures: number;
  now?: () => Date;
}

/**
 * Applique l'issue d'une itération à l'état de la tâche et dit au runner quoi
 * faire ensuite. Seul un `completed` fait avancer le curseur.
 */
export function applyOutcome(
  task: Task,
  ts: TaskState,
  outcome: Outcome,
  opts: ApplyOptions,
): Decision {
  const node = ts.cursor;
  const label =
    outcome.kind === "completed"
      ? outcome.done
        ? "completed+DONE"
        : "completed"
      : outcome.kind === "fatal"
        ? `fatal:${outcome.reason}`
        : outcome.reason;
  ts.last = { at: (opts.now ?? (() => new Date()))().toISOString(), node, outcome: label };

  switch (outcome.kind) {
    case "completed": {
      ts.iterations += 1;
      ts.consecutiveFailures = 0;
      if (outcome.done) {
        ts.status = "done";
        return "task-done";
      }
      ts.cursor = task.def.nodes[node]!.next;
      return "next-task";
    }
    case "quota":
      return "backoff";
    case "fatal":
      return "stop-window";
    case "failure": {
      ts.consecutiveFailures += 1;
      if (ts.consecutiveFailures >= opts.maxConsecutiveFailures) {
        ts.status = "failed";
        return "task-failed";
      }
      return "retry";
    }
  }
}

/** Une tâche est éligible si elle est active dans task.json et pas terminée/en échec. */
export function isEligible(task: Task, state: RunnerState): boolean {
  const ts = state.tasks[task.name];
  return task.def.active && (ts === undefined || ts.status === "running");
}

/**
 * Choisit la tâche de la prochaine itération : la tâche collante si elle est
 * toujours éligible, sinon la suivante après `lastTask` dans l'ordre donné
 * (round-robin). Retourne null si plus rien n'est éligible.
 */
export function pickNext(tasks: Task[], state: RunnerState): Task | null {
  const eligible = tasks.filter((t) => isEligible(t, state));
  if (eligible.length === 0) return null;

  if (state.currentTask !== null) {
    const sticky = eligible.find((t) => t.name === state.currentTask);
    if (sticky) return sticky;
  }

  const lastIdx = tasks.findIndex((t) => t.name === state.lastTask);
  for (let i = 1; i <= tasks.length; i++) {
    const candidate = tasks[(lastIdx + i) % tasks.length]!;
    if (eligible.includes(candidate)) return candidate;
  }
  return eligible[0]!;
}

/**
 * Met à jour la partie « file d'attente » de l'état après une décision.
 * La tâche reste collante tant qu'elle n'a pas rendu la main proprement.
 */
export function applyDecision(state: RunnerState, task: Task, decision: Decision): void {
  switch (decision) {
    case "next-task":
    case "task-done":
    case "task-failed":
      state.currentTask = null;
      state.lastTask = task.name;
      return;
    case "backoff":
    case "retry":
    case "stop-window":
      state.currentTask = task.name;
      return;
  }
}
