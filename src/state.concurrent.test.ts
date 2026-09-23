import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState, loadState, saveState } from "./state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "unused-save-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("saveState concurrents", () => {
  it("deux sauvegardes simultanées ne corrompent pas state.json et ne se font pas échouer", async () => {
    for (let i = 0; i < 100; i++) {
      const long = emptyState();
      long.pausedUntil = new Date().toISOString();
      long.tasks = { t: { cursor: "x".repeat(200), status: "running", iterations: i, consecutiveFailures: 0 } };
      const short = emptyState();
      await Promise.all([saveState(dir, long), saveState(dir, short)]);
      // La dernière demandée gagne, et le fichier est lisible.
      expect(await loadState(dir)).toEqual(short);
    }
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("la dernière version de l'état est écrite, même modifiée pendant la file d'attente", async () => {
    const st = emptyState();
    const first = saveState(dir, st);
    st.currentTask = "t";
    await Promise.all([first, saveState(dir, st)]);
    expect((await loadState(dir)).currentTask).toBe("t");
  });
});
