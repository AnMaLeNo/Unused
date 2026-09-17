import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTask, resolveEnv } from "./task.js";

describe("resolveEnv", () => {
  it("transmet depuis la source, fixe les littéraux, liste les absents", () => {
    expect(resolveEnv(["A", "B=x=y", "C"], { A: "1" })).toEqual({ env: { A: "1", B: "x=y" }, missing: ["C"] });
    expect(resolveEnv([], {})).toEqual({ env: {}, missing: [] });
  });
});

describe("loadTask › env", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(await mkdtemp(path.join(os.tmpdir(), "unused-task-")), "t1");
    await mkdir(path.join(dir, "skills", "a"), { recursive: true });
    await writeFile(path.join(dir, "skills", "a", "SKILL.md"), "x");
  });
  afterEach(() => rm(path.dirname(dir), { recursive: true, force: true }));

  const write = (env: unknown) =>
    writeFile(path.join(dir, "task.json"), JSON.stringify({ start: "a", env, nodes: { a: { skill: "a", next: "a" } } }));

  it("refuse une variable absente du démon, accepte les littéraux", async () => {
    await write(["UNUSED_TEST_MISSING_VAR"]);
    await expect(loadTask(dir)).rejects.toThrow(/UNUSED_TEST_MISSING_VAR/);
    await write(["GIT_AUTHOR_NAME=bot"]);
    expect((await loadTask(dir)).def.env).toEqual(["GIT_AUTHOR_NAME=bot"]);
  });

  it("refuse un nom invalide", async () => {
    await write(["1BAD"]);
    await expect(loadTask(dir)).rejects.toThrow(/NOM/);
  });
});
