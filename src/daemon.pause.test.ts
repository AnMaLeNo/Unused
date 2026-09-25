import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { emptyState, saveState } from "./state.js";

let root: string;
let cfg: Config;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-pause-"));
  cfg = {
    rootDir: root,
    tasksDir: path.join(root, "tasks"),
    dataDir: path.join(root, "data"),
    docker: { baseImage: "base", dockerfileDir: root, flattenAfterLayers: 30 },
    // Le lundi, de 00:00 à 13:00 (heure locale).
    windows: [{ days: ["mon"], from: "00:00", to: "13:00" }],
    claude: { sessionArgs: [], timeoutMinutes: 60 },
    scheduler: { backoffMinutes: 15, retrySeconds: 0, maxConsecutiveFailures: 3 },
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function statusAt(now: Date, pausedUntil: Date | null) {
  const st = emptyState();
  st.pausedUntil = pausedUntil?.toISOString() ?? null;
  await saveState(cfg.dataDir, st);
  const daemon = new Daemon(cfg, { now: () => now });
  await daemon.init();
  return daemon.status();
}

describe("pause qui se termine pendant une plage automatique", () => {
  const sunday22 = new Date(2026, 8, 27, 22, 0); // dimanche 27/09/2026 22:00
  const monday07 = new Date(2026, 8, 28, 7, 0);

  it("le démon reprend à la fin de la pause, pas le lundi suivant", async () => {
    const s = await statusAt(sunday22, monday07);
    expect(s.nextCalendarStart).toBe(monday07.toISOString());
  });

  it("une pause qui finit hors plage mène toujours à la plage suivante", async () => {
    const monday14 = new Date(2026, 8, 28, 14, 0);
    const s = await statusAt(sunday22, monday14);
    expect(s.nextCalendarStart).toBe(new Date(2026, 9, 5, 0, 0).toISOString());
  });

  it("sans pause : prochain début de plage", async () => {
    const s = await statusAt(sunday22, null);
    expect(s.nextCalendarStart).toBe(new Date(2026, 8, 28, 0, 0).toISOString());
  });
});
