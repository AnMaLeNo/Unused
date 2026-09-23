import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { DockerError, removeTaskImages } from "./docker.js";
import { runWindow } from "./scheduler.js";
import { emptyState, saveState } from "./state.js";

let root: string;
let cfg: Config;
let savedPath: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-reset-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
  for (const t of ["t1", "t2"]) {
    await mkdir(path.join(cfg.tasksDir, t, "skills", "a"), { recursive: true });
    await writeFile(path.join(cfg.tasksDir, t, "skills", "a", "SKILL.md"), "x");
    await writeFile(path.join(cfg.tasksDir, t, "task.json"), JSON.stringify({ start: "a", nodes: { a: { skill: "a", next: "a" } } }));
  }
  savedPath = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(root, { recursive: true, force: true });
});

/** Faux `docker rmi` : écrit `stderr` et sort en `code`. */
async function fakeRmi(stderr: string, code: number): Promise<void> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "docker"), `#!/bin/sh\nif [ "$1" = rmi ]; then printf '${stderr}' >&2; exit ${code}; fi\nexit 0\n`);
  await chmod(path.join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}

describe("removeTaskImages", () => {
  it("une image déjà absente n'est pas un échec", async () => {
    await fakeRmi("Error response from daemon: No such image: unused-task-t:prev\\n", 1);
    await expect(removeTaskImages("t")).resolves.toBeUndefined();
  });

  it("Docker injoignable : l'échec est remonté", async () => {
    await fakeRmi("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n", 1);
    await expect(removeTaskImages("t")).rejects.toBeInstanceOf(DockerError);
  });
});

describe("unused tasks reset", () => {
  it("si les images ne partent pas, l'état de la tâche est intact", async () => {
    const st = emptyState();
    st.tasks.t1 = { cursor: "a", status: "failed", iterations: 12, consecutiveFailures: 3 };
    await saveState(cfg.dataDir, st);
    const daemon = new Daemon(cfg, {
      removeTaskImages: async () => {
        throw new DockerError("images de t1 non supprimées :\nCannot connect to the Docker daemon");
      },
    });
    await daemon.init();
    await expect(daemon.resetTask("t1")).rejects.toThrow(/rien n'a été remis à zéro/);
    const saved = JSON.parse(await readFile(path.join(cfg.dataDir, "state.json"), "utf8"));
    expect(saved.tasks.t1).toMatchObject({ status: "failed", iterations: 12 });
  });

  it("pendant une plage : refusé pour une tâche encore dans la file, même entre deux itérations", async () => {
    cfg.scheduler.retrySeconds = 3600; // t1 a échoué une fois, le scheduler attend avant de la relancer
    const st = emptyState();
    st.tasks.t2 = { cursor: "a", status: "failed", iterations: 3, consecutiveFailures: 3 };
    await saveState(cfg.dataDir, st);
    let ended!: () => void;
    const firstIterationEnded = new Promise<void>((res) => (ended = res));
    const removed: string[] = [];
    const daemon = new Daemon(cfg, {
      imageExists: async () => true,
      dockerVersion: async () => "x",
      removeTaskImages: async (n) => void removed.push(n),
      runWindow: (c, t, s, d, sig, deps) =>
        runWindow(c, t, s, d, sig, {
          ...deps,
          runIteration: async () => {
            setTimeout(ended, 0);
            return { node: "a", outcome: { kind: "failure", reason: "x" }, decision: "retry", logFile: null };
          },
        }),
    });
    await daemon.init();
    const ac = new AbortController();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(3_600_000);
    await firstIterationEnded;
    expect((await daemon.status()).window?.current).toBeNull();

    // Aucune itération en cours, mais t1 repartira : un reset maintenant se ferait doubler.
    await expect(daemon.resetTask("t1")).rejects.toThrow(/file/);
    // t2 est sortie de la file (trop d'échecs) : son reset est sûr.
    await expect(daemon.resetTask("t2")).resolves.toEqual({ start: "a" });
    expect(removed).toEqual(["t2"]);
    ac.abort();
    await loop;
  });
});
