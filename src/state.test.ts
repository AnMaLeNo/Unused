import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyState, loadState, saveState, STATE_FILE } from "./state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "unused-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state", () => {
  it("état vide si le fichier n'existe pas", async () => {
    expect(await loadState(dir)).toEqual(emptyState());
  });

  it("aller-retour, avec création du dossier", async () => {
    const sub = path.join(dir, "data");
    const state = emptyState();
    state.window = { startedAt: "2026-09-12T22:00:00Z", until: "2026-09-13T06:00:00Z" };
    state.currentTask = "a";
    state.tasks.a = { cursor: "do", status: "running", iterations: 3, consecutiveFailures: 1 };
    await saveState(sub, state);
    expect(await loadState(sub)).toEqual(state);
    expect(await readFile(path.join(sub, STATE_FILE), "utf8")).toContain('"version": 1');
  });

  it("refuse un fichier corrompu avec un message clair", async () => {
    await writeFile(path.join(dir, STATE_FILE), '{"version": 2}');
    await expect(loadState(dir)).rejects.toThrow(/state\.json invalide/);
  });
});
