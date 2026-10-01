import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, listen, socketPath } from "./api.js";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";

let root: string;
let cfg: Config;
let sock: string;
let server: http.Server;
let savedPath: string | undefined;

/** POST brut : le corps complet de la réponse. */
function post(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method: "POST", path: p }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-chk-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
  await mkdir(cfg.dataDir, { recursive: true });
  sock = socketPath(cfg);
  // Faux docker : `docker version` prend une seconde puis échoue (le check s'arrête là).
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "docker"), "#!/bin/sh\nsleep 1\nexit 1\n");
  await chmod(path.join(bin, "docker"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  server?.close();
  await rm(root, { recursive: true, force: true });
});

describe("docker check", () => {
  it("deux check en même temps : le second est refusé au lieu de détruire le premier", async () => {
    const daemon = new Daemon(cfg);
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    const first = post("/docker/check");
    await new Promise((r) => setTimeout(r, 100));
    expect(await post("/docker/check")).toMatch(/^ERREUR docker check déjà en cours/);
    await first;
    // Une fois le premier fini, on peut relancer.
    expect(await post("/docker/check")).not.toMatch(/déjà en cours/);
  }, 20_000);

  it("refusé pendant une plage", async () => {
    let release!: () => void;
    const daemon = new Daemon(cfg, {
      imageExists: async () => true,
      dockerVersion: async () => "x",
      runWindow: async () => {
        await new Promise<void>((res) => (release = res));
        return { iterations: 0, completed: 0, backoffs: 0, failures: 0, costUsd: 0, endedBecause: "window" };
      },
    });
    await daemon.init();
    server = createApi(cfg, daemon);
    await listen(server, sock);
    const ac = new AbortController();
    const loop = daemon.run(ac.signal);
    await daemon.startWindow(3_600_000);
    expect(await post("/docker/check")).toMatch(/^ERREUR une plage est en cours/);
    release();
    ac.abort();
    await loop;
  }, 20_000);
});
