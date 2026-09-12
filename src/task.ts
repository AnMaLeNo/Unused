import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formatZodError } from "./config.js";

export const TASK_FILE = "task.json";

/**
 * Une tâche = un graphe de nœuds. Chaque nœud lance un skill et désigne son
 * successeur. La seule condition de sortie est le fichier DONE créé par le
 * skill dans /exchange ; sinon on suit `next` indéfiniment.
 *
 * Côté hôte, la tâche est décrite par un dossier `tasks/<nom>/` :
 *   task.json              — ce fichier
 *   skills/<skill>/SKILL.md — les skills du graphe, copiés dans le container
 *   exchange/              — monté sur /exchange dans le container (DONE, …)
 * Le container, lui, est l'espace de travail de Claude : il y fait ce qu'il veut.
 */
const NodeSchema = z
  .object({
    // Nom du skill, invoqué par `/<skill>` ; doit exister dans skills/<skill>/SKILL.md.
    skill: z.string().min(1),
    // Paramètres propres au nœud, fusionnés par-dessus ceux de la tâche.
    params: z.record(z.string()).default({}),
    // Arguments `claude` propres à ce nœud (ex. ["--model", "opus"]).
    args: z.array(z.string()).default([]),
    // Nœud suivant après un `completed`.
    next: z.string().min(1),
  })
  .strict();

const TaskFileSchema = z
  .object({
    active: z.boolean().default(true),
    start: z.string().min(1),
    params: z.record(z.string()).default({}),
    nodes: z.record(NodeSchema),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!(t.start in t.nodes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["start"],
        message: `nœud "${t.start}" introuvable dans nodes`,
      });
    }
    for (const [name, node] of Object.entries(t.nodes)) {
      if (!(node.next in t.nodes)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", name, "next"],
          message: `nœud "${node.next}" introuvable dans nodes`,
        });
      }
    }
  });

export type TaskNode = z.infer<typeof NodeSchema>;
export type TaskFile = z.infer<typeof TaskFileSchema>;

export interface Task {
  name: string;
  dir: string;
  skillsDir: string;
  exchangeDir: string;
  def: TaskFile;
}

export interface TaskLoadError {
  name: string;
  message: string;
}

export function skillFile(task: Pick<Task, "skillsDir">, skill: string): string {
  return path.join(task.skillsDir, skill, "SKILL.md");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadTask(dir: string): Promise<Task> {
  const name = path.basename(dir);
  const file = path.join(dir, TASK_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`impossible de lire ${TASK_FILE} : ${(err as Error).message}`);
  }
  const parsed = TaskFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${TASK_FILE} invalide :\n${formatZodError(parsed.error)}`);
  }
  const task: Task = {
    name,
    dir,
    skillsDir: path.join(dir, "skills"),
    exchangeDir: path.join(dir, "exchange"),
    def: parsed.data,
  };

  const missing: string[] = [];
  for (const node of Object.values(task.def.nodes)) {
    if (!(await exists(skillFile(task, node.skill)))) missing.push(node.skill);
  }
  if (missing.length > 0) {
    throw new Error(
      `skills introuvables (attendus dans skills/<nom>/SKILL.md) : ${[...new Set(missing)].join(", ")}`,
    );
  }
  return task;
}

/** Charge chaque sous-dossier de tasksDir contenant un task.json. */
export async function loadTasks(
  tasksDir: string,
): Promise<{ tasks: Task[]; errors: TaskLoadError[] }> {
  const tasks: Task[] = [];
  const errors: TaskLoadError[] = [];
  let entries: string[];
  try {
    entries = (await readdir(tasksDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return { tasks, errors: [{ name: tasksDir, message: "dossier des tâches introuvable" }] };
  }
  for (const name of entries) {
    const dir = path.join(tasksDir, name);
    if (!(await exists(path.join(dir, TASK_FILE)))) continue;
    try {
      tasks.push(await loadTask(dir));
    } catch (err) {
      errors.push({ name, message: (err as Error).message });
    }
  }
  return { tasks, errors };
}

/** "setup → find → do → find (boucle)" — le chemin depuis start jusqu'au premier retour. */
export function describeGraph(def: TaskFile): string {
  const seen = new Set<string>();
  const chain: string[] = [];
  let cur = def.start;
  while (!seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = def.nodes[cur]!.next;
  }
  return `${chain.join(" → ")} → ${cur} (boucle)`;
}
