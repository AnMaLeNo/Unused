import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formatZodError } from "./config.js";
import type { Task } from "./task.js";

export const STATE_FILE = "state.json";

const TaskStateSchema = z.object({
  // Nœud courant : celui que la prochaine itération exécute.
  cursor: z.string(),
  status: z.enum(["running", "done", "failed"]),
  // Itérations terminées par un `completed`.
  iterations: z.number().int().nonnegative(),
  // Échecs consécutifs hors quota ; remis à zéro par un `completed`.
  consecutiveFailures: z.number().int().nonnegative(),
  last: z
    .object({ at: z.string(), node: z.string(), outcome: z.string() })
    .optional(),
});

const RunnerStateSchema = z.object({
  version: z.literal(1),
  // Plage en cours (`run --for`), conservée pour reprendre après un redémarrage.
  window: z.object({ startedAt: z.string(), until: z.string() }).nullable(),
  // Tâche « collante » : on y reste tant qu'elle n'a pas produit un `completed`.
  currentTask: z.string().nullable(),
  // Dernière tâche à avoir rendu la main proprement ; point de départ du round-robin.
  lastTask: z.string().nullable(),
  // Après un `stop`, les plages automatiques sont ignorées jusqu'à cet instant.
  pausedUntil: z.string().nullable().default(null),
  tasks: z.record(TaskStateSchema),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
export type RunnerState = z.infer<typeof RunnerStateSchema>;

export function emptyState(): RunnerState {
  return { version: 1, window: null, currentTask: null, lastTask: null, pausedUntil: null, tasks: {} };
}

export function initialTaskState(task: Task): TaskState {
  return { cursor: task.def.start, status: "running", iterations: 0, consecutiveFailures: 0 };
}

/**
 * Garantit une entrée d'état pour la tâche. Si task.json a changé et que le
 * curseur pointe sur un nœud disparu, on repart de `start` plutôt que de bloquer.
 */
export function ensureTaskState(state: RunnerState, task: Task): TaskState {
  let ts = state.tasks[task.name];
  if (!ts) {
    ts = initialTaskState(task);
    state.tasks[task.name] = ts;
  } else if (!(ts.cursor in task.def.nodes)) {
    ts.cursor = task.def.start;
  }
  return ts;
}

export async function loadState(dataDir: string): Promise<RunnerState> {
  const file = path.join(dataDir, STATE_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new Error(`Impossible de lire ${file} : ${(err as Error).message}`);
  }
  const parsed = RunnerStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file} invalide :\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

/** Écriture atomique : fichier temporaire puis rename, pour survivre à une coupure. */
export async function saveState(dataDir: string, state: RunnerState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, STATE_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
