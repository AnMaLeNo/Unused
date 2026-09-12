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
  // Quota saturé : ni la tâche ni le nœud ne bougent, tout le monde attend.
  | { kind: "quota"; reason: string }
  // Tout le reste : erreur API, crash, sortie illisible, coupure par budget/tours…
  | { kind: "failure"; reason: string };

export type Decision =
  | "next-task" // completed → curseur avancé, on passe à la tâche suivante
  | "task-done" // completed + DONE → tâche terminée, sortie de la file
  | "backoff" // quota → attente globale, puis même tâche, même nœud
  | "retry" // échec → même tâche, même nœud
  | "task-failed"; // trop d'échecs consécutifs → tâche sortie de la file

const QUOTA_REASONS = new Set(["blocking_limit", "rapid_refill_breaker"]);

/** Traduit le `terminal_reason` du JSON de `claude -p` (absent si la sortie était illisible). */
export function classify(terminalReason: string | undefined, done: boolean): Outcome {
  if (terminalReason === "completed") return { kind: "completed", done };
  if (terminalReason !== undefined && QUOTA_REASONS.has(terminalReason)) {
    return { kind: "quota", reason: terminalReason };
  }
  return { kind: "failure", reason: terminalReason ?? "unreadable_output" };
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
    outcome.kind === "completed" ? (outcome.done ? "completed+DONE" : "completed") : outcome.reason;
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
      state.currentTask = task.name;
      return;
  }
}
