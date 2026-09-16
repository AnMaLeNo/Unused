import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { WindowSpecSchema } from "./calendar.js";

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
        // Au-delà, la session est tuée et l'itération comptée en échec.
        timeoutMinutes: z.number().positive().default(180),
      })
      .default({}),
    docker: z
      .object({
        baseImage: z.string().default("unused-base"),
        dockerfileDir: z.string().default("./docker"),
        // Au-delà de ce nombre de couches, l'image de la tâche est aplatie.
        flattenAfterLayers: z.number().int().positive().default(30),
      })
      .default({}),
    // Plages automatiques (heure locale de la machine) : le démon travaille dès
    // qu'une plage, manuelle ou automatique, le dit. Elles se cumulent.
    windows: z.array(WindowSpecSchema).default([]),
    scheduler: z
      .object({
        // Attente globale après un `blocking_limit` (quota saturé).
        backoffMinutes: z.number().int().positive().default(15),
        // Pause après un échec (hors quota) avant de rejouer le même nœud.
        retrySeconds: z.number().nonnegative().default(60),
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
    docker: { ...cfg.docker, dockerfileDir: path.resolve(rootDir, cfg.docker.dockerfileDir) },
  };
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`)
    .join("\n");
}
