import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, listen } from "./api.js";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { emptyState, saveState } from "./state.js";

let root: string;
let cfg: Config;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-2d-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    windows: [],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("second démon lancé par erreur", () => {
  it("un démon qui tarde à répondre garde son socket", async () => {
    await saveState(cfg.dataDir, emptyState());
    const sock = path.join(cfg.dataDir, "u.sock");
    // Le premier démon : accepte la connexion mais ne répond pas (machine saturée).
    const busy = net.createServer(() => {});
    await new Promise<void>((res) => busy.listen(sock, res));
    const second = createApi(cfg, new Daemon(cfg));
    await expect(listen(second, sock)).rejects.toThrow(/démon/);
    expect((await stat(sock)).isSocket()).toBe(true);
    busy.close();
  }, 10_000);

  it("n'écrit pas state.json avant d'avoir vérifié qu'il est seul", async () => {
    const st = emptyState();
    st.window = { startedAt: "2020-01-01T00:00:00Z", until: "2020-01-01T01:00:00Z" };
    await saveState(cfg.dataDir, st);
    const before = await readFile(path.join(cfg.dataDir, "state.json"), "utf8");
    await new Daemon(cfg).init();
    expect(await readFile(path.join(cfg.dataDir, "state.json"), "utf8")).toBe(before);
  });
});
