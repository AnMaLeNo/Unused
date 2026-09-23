import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeOrphanContainers } from "./docker.js";

// Un faux binaire `docker` en tête du PATH : note ses appels, répond à `ps`.
let bin: string;
let savedPath: string | undefined;
async function fakeDocker(psOutput: string): Promise<void> {
  const script = `#!/bin/sh\necho "$*" >> "${bin}/calls"\nif [ "$1" = ps ]; then printf '${psOutput}'; fi\n`;
  await writeFile(path.join(bin, "docker"), script);
  await chmod(path.join(bin, "docker"), 0o755);
}
const calls = async () => (await readFile(path.join(bin, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

beforeEach(async () => {
  bin = await mkdtemp(path.join(os.tmpdir(), "unused-fakedocker-"));
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(bin, { recursive: true, force: true });
});

describe("removeOrphanContainers", () => {
  it("supprime les containers de tâches restés en vie", async () => {
    await fakeDocker("abc\\ndef\\n");
    expect(await removeOrphanContainers()).toBe(2);
    expect(await calls()).toEqual(["ps -aq --filter label=unused.task", "rm -f abc def"]);
  });

  it("rien à faire quand il n'en reste aucun", async () => {
    await fakeDocker("");
    expect(await removeOrphanContainers()).toBe(0);
    expect(await calls()).toEqual(["ps -aq --filter label=unused.task"]);
  });
});
