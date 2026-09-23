import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { commitTask } from "./docker.js";

// Faux `docker` en tête du PATH : 31 couches (aplatissement déclenché), un
// export qui produit 3 Mo puis sort en EXPORT_CODE, un import qui peut mourir
// tout de suite (IMPORT_EARLY_FAIL=1) sans lire son entrée.
const SCRIPT = `#!/bin/sh
echo "$*" >> "$FAKE_DIR/calls"
case "$*" in
  *RootFS.Layers*) echo 31 ;;
  *"json .Config"*) echo '{"Env":["PATH=/bin"],"WorkingDir":"/work"}' ;;
  export*) head -c 3000000 /dev/zero; exit \${EXPORT_CODE:-0} ;;
  import*) if [ "$IMPORT_EARLY_FAIL" = 1 ]; then exit 1; fi; cat > /dev/null ;;
esac
exit 0
`;

let dir: string;
let savedPath: string | undefined;
const cfg = { docker: { flattenAfterLayers: 30 } } as unknown as Config;
const calls = async () => (await readFile(path.join(dir, "calls"), "utf8")).trim().split("\n");

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "unused-flat-"));
  await writeFile(path.join(dir, "docker"), SCRIPT);
  await chmod(path.join(dir, "docker"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  process.env.FAKE_DIR = dir;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  delete process.env.EXPORT_CODE;
  delete process.env.IMPORT_EARLY_FAIL;
  await rm(dir, { recursive: true, force: true });
});

describe("aplatissement au commit", () => {
  it("nominal : l'image aplatie remplace :latest", async () => {
    await commitTask(cfg, "t", "ctn");
    expect(await calls()).toContain("tag unused-task-t:flat unused-task-t:latest");
  });

  it("export interrompu : :latest n'est pas remplacé, le commit reste acquis", async () => {
    process.env.EXPORT_CODE = "1";
    await expect(commitTask(cfg, "t", "ctn")).resolves.toBeUndefined();
    const c = await calls();
    expect(c).toContain("commit --change LABEL unused.task=t ctn unused-task-t:latest");
    expect(c).not.toContain("tag unused-task-t:flat unused-task-t:latest");
    expect(c).toContain("rmi unused-task-t:flat");
  });

  it("import qui meurt tôt : pas de plantage du démon, :latest intact", async () => {
    process.env.IMPORT_EARLY_FAIL = "1";
    await expect(commitTask(cfg, "t", "ctn")).resolves.toBeUndefined();
    expect(await calls()).not.toContain("tag unused-task-t:flat unused-task-t:latest");
  }, 10_000);
});
