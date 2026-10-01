import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-sd-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("arrêt du service", () => {
  it("SIGTERM pendant un docker build : le démon s'arrête vraiment", async () => {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await mkdir(path.join(root, "data"));
    // Faux docker : un build qui dure longtemps, tout le reste répond tout de suite.
    await writeFile(path.join(bin, "docker"), '#!/bin/sh\nif [ "$1" = build ]; then sleep 30; fi\nexit 0\n');
    await chmod(path.join(bin, "docker"), 0o755);
    const cfgFile = path.join(root, "unused.config.json");
    await writeFile(cfgFile, JSON.stringify({ tasksDir: "./tasks", dataDir: "./data", docker: { dockerfileDir: "." } }));

    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), "-c", cfgFile, "daemon"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    await new Promise<void>((res) => {
      const t = setInterval(() => out.includes("démon prêt") && (clearInterval(t), res()), 20);
    });

    // Un docker build en cours, streamé vers un client.
    const req = http.request({ socketPath: path.join(root, "data", "unused.sock"), method: "POST", path: "/docker/build" }, (r) => r.resume());
    req.on("error", () => {});
    req.end();
    await new Promise((r) => setTimeout(r, 300));

    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("toujours vivant"), 5000))]);
    child.kill("SIGKILL");
    expect(code).toBe(0);
    expect(out).toContain("démon arrêté");
  }, 15_000);
});
