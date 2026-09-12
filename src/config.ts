import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILE = "unused.config.json";

const ConfigFileSchema = z
  .object({
    tasksDir: z.string().default("./tasks"),
    dataDir: z.string().default("./data"),
    claude: z
      .object({
        // Arguments ajoutés à CHAQUE session `claude -p`, quel que soit le nœud.
        // Le runner s'assure par ailleurs que `--output-format json` y figure,
        // il en a besoin pour lire `terminal_reason`.
        sessionArgs: z.array(z.string()).default([]),
      })
      .default({}),
    scheduler: z
      .object({
        // Attente globale après un `blocking_limit` (quota saturé).
        backoffMinutes: z.number().int().positive().default(15),
        // Échecs consécutifs (hors quota) avant de sortir une tâche de la file.
        maxConsecutiveFailures: z.number().int().positive().default(3),
      })
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigFileSchema> & {
  // Répertoire du fichier de config ; tasksDir et dataDir y sont résolus.
  rootDir: string;
};

export async function loadConfig(file: string = CONFIG_FILE): Promise<Config> {
  const absFile = path.resolve(file);
  const rootDir = path.dirname(absFile);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(absFile, "utf8"));
  } catch (err) {
    throw new Error(`Impossible de lire ${absFile} : ${(err as Error).message}`);
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${absFile} invalide :\n${formatZodError(parsed.error)}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    rootDir,
    tasksDir: path.resolve(rootDir, cfg.tasksDir),
    dataDir: path.resolve(rootDir, cfg.dataDir),
  };
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`)
    .join("\n");
}
