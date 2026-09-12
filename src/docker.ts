import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { Config } from "./config.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class DockerError extends Error {
  constructor(
    message: string,
    public readonly result?: ExecResult,
  ) {
    super(message);
  }
}

interface DockerOpts {
  stdin?: string;
  env?: Record<string, string>;
  // "inherit" affiche la sortie en direct (build) ; "pipe" la capture.
  stdio?: "pipe" | "inherit";
}

/** Lance `docker <args>`. Ne lève pas sur code ≠ 0 : c'est l'appelant qui décide. */
export function docker(args: string[], opts: DockerOpts = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const inherit = opts.stdio === "inherit";
    const child = spawn("docker", args, {
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(
        new DockerError(
          e.code === "ENOENT" ? "docker introuvable : est-il installé et dans le PATH ?" : e.message,
        ),
      );
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  });
}

async function mustSucceed(args: string[], what: string, opts?: DockerOpts): Promise<ExecResult> {
  const r = await docker(args, opts);
  if (r.code !== 0) {
    throw new DockerError(`${what} a échoué (docker ${args[0]}, code ${r.code}) :\n${r.stderr.trim()}`, r);
  }
  return r;
}

export async function dockerVersion(): Promise<string> {
  const r = await mustSucceed(
    ["version", "--format", "{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})"],
    "docker version",
  );
  return r.stdout.trim();
}

export async function imageExists(image: string): Promise<boolean> {
  return (await docker(["image", "inspect", image])).code === 0;
}

export async function buildBase(cfg: Config): Promise<void> {
  await mustSucceed(["build", "-t", cfg.docker.baseImage, cfg.docker.dockerfileDir], "build de l'image de base", {
    stdio: "inherit",
  });
}

export const LABEL = "unused.task";

export function taskImage(taskName: string): string {
  return `unused-task-${taskName}`;
}

/** L'image de départ d'une itération : le dernier commit de la tâche, sinon l'image de base. */
export async function resolveTaskImage(cfg: Config, taskName: string): Promise<string> {
  const latest = `${taskImage(taskName)}:latest`;
  return (await imageExists(latest)) ? latest : cfg.docker.baseImage;
}

export interface RunOptions {
  cmd: string[];
  exchangeDir: string;
  stdin?: string;
  // Variables transmises au container. Elles passent par l'environnement du
  // processus docker (`-e NOM` sans valeur), pas par la ligne de commande,
  // pour qu'un token n'apparaisse jamais dans `ps`.
  env?: Record<string, string>;
}

export interface RunResult extends ExecResult {
  container: string;
  image: string;
}

/**
 * Exécute une commande dans un container neuf issu de l'image de la tâche.
 * Le container n'est PAS supprimé : l'appelant le commite (succès) ou le jette.
 */
export async function runInTask(cfg: Config, taskName: string, opts: RunOptions): Promise<RunResult> {
  const image = await resolveTaskImage(cfg, taskName);
  const container = `unused-${taskName}-${Date.now()}`;
  await mkdir(opts.exchangeDir, { recursive: true });
  const args = [
    "run",
    "--name",
    container,
    "--label",
    `${LABEL}=${taskName}`,
    "-v",
    `${opts.exchangeDir}:/exchange`,
  ];
  if (opts.stdin !== undefined) args.push("-i");
  for (const name of Object.keys(opts.env ?? {})) args.push("-e", name);
  args.push(image, ...opts.cmd);
  const r = await docker(args, { stdin: opts.stdin, env: opts.env });
  return { ...r, container, image };
}

export async function discardContainer(container: string): Promise<void> {
  await docker(["rm", "-f", container]);
}

export async function layerCount(image: string): Promise<number> {
  const r = await mustSucceed(["image", "inspect", "--format", "{{len .RootFS.Layers}}", image], "inspect");
  return Number(r.stdout.trim());
}

/**
 * Commite le container comme nouvel état de la tâche, garde l'état précédent
 * sous :prev, supprime le container, aplatit si la pile de couches est trop
 * haute, puis nettoie les images orphelines de cette tâche.
 */
export async function commitTask(cfg: Config, container: string, taskName: string): Promise<void> {
  const name = taskImage(taskName);
  if (await imageExists(`${name}:latest`)) {
    await mustSucceed(["tag", `${name}:latest`, `${name}:prev`], "rotation de l'image");
  }
  await mustSucceed(
    ["commit", "--change", `LABEL ${LABEL}=${taskName}`, container, `${name}:latest`],
    "commit du container",
  );
  await docker(["rm", container]);
  if ((await layerCount(`${name}:latest`)) > cfg.docker.flattenAfterLayers) {
    await flattenTask(taskName);
  }
  await pruneTask(taskName);
}

/** Supprime les images sans tag de cette tâche (anciens :prev, chaînes aplaties). */
export async function pruneTask(taskName: string): Promise<void> {
  await docker(["image", "prune", "-f", "--filter", `label=${LABEL}=${taskName}`]);
}

interface ImageConfig {
  Env?: string[] | null;
  WorkingDir?: string;
  Entrypoint?: string[] | null;
  Cmd?: string[] | null;
  Labels?: Record<string, string> | null;
}

/**
 * `docker import` perd la config de l'image (ENV, WORKDIR…). On la reconstruit
 * en instructions Dockerfile à partir de la config de l'image aplatie.
 */
export function importChanges(config: ImageConfig): string[] {
  const q = (s: string) => JSON.stringify(s);
  const changes: string[] = [];
  for (const kv of config.Env ?? []) {
    const i = kv.indexOf("=");
    changes.push(`ENV ${kv.slice(0, i)}=${q(kv.slice(i + 1))}`);
  }
  if (config.WorkingDir) changes.push(`WORKDIR ${config.WorkingDir}`);
  if (config.Entrypoint?.length) changes.push(`ENTRYPOINT ${JSON.stringify(config.Entrypoint)}`);
  if (config.Cmd?.length) changes.push(`CMD ${JSON.stringify(config.Cmd)}`);
  for (const [k, v] of Object.entries(config.Labels ?? {})) changes.push(`LABEL ${k}=${q(v)}`);
  return changes;
}

/** Réécrit :latest en une image à une seule couche (export → import). */
export async function flattenTask(taskName: string): Promise<void> {
  const latest = `${taskImage(taskName)}:latest`;
  const inspect = await mustSucceed(["image", "inspect", "--format", "{{json .Config}}", latest], "inspect");
  const changes = importChanges(JSON.parse(inspect.stdout) as ImageConfig);

  const tmp = `unused-flatten-${taskName}-${Date.now()}`;
  await mustSucceed(["create", "--name", tmp, latest], "création du container d'export");
  try {
    await pipeExportImport(tmp, latest, changes);
  } finally {
    await docker(["rm", tmp]);
  }
}

function pipeExportImport(container: string, image: string, changes: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const exp = spawn("docker", ["export", container], { stdio: ["ignore", "pipe", "pipe"] });
    const importArgs = ["import"];
    for (const c of changes) importArgs.push("-c", c);
    importArgs.push("-", image);
    const imp = spawn("docker", importArgs, { stdio: ["pipe", "pipe", "pipe"] });
    exp.stdout.pipe(imp.stdin);
    const errs: Buffer[] = [];
    exp.stderr.on("data", (d: Buffer) => errs.push(d));
    imp.stderr.on("data", (d: Buffer) => errs.push(d));
    let expCode: number | null = null;
    exp.on("close", (c) => (expCode = c));
    imp.on("close", (c) => {
      if (c === 0 && (expCode === 0 || expCode === null)) resolve();
      else reject(new DockerError(`aplatissement a échoué :\n${Buffer.concat(errs).toString("utf8").trim()}`));
    });
    exp.on("error", reject);
    imp.on("error", reject);
  });
}

export async function removeTaskImages(taskName: string): Promise<void> {
  const name = taskImage(taskName);
  await docker(["rmi", "-f", `${name}:latest`, `${name}:prev`]);
  await pruneTask(taskName);
}
