import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import {
  buildBase,
  commitTask,
  discardContainer,
  docker,
  dockerVersion,
  flattenTask,
  imageExists,
  layerCount,
  removeTaskImages,
  runInTask,
  taskImage,
  type RunResult,
} from "./docker.js";

const CHECK_TASK = "_check";

function step(label: string): void {
  console.log(`\n▶ ${label}`);
}
function ok(msg: string): void {
  console.log(`  ✔ ${msg}`);
}

function expectOutput(r: RunResult, expected: string, what: string): void {
  if (r.code !== 0 || r.stdout.trim() !== expected) {
    throw new Error(
      `${what} : attendu ${JSON.stringify(expected)}, obtenu code ${r.code}, stdout ${JSON.stringify(r.stdout.trim())}, stderr ${JSON.stringify(r.stderr.trim())}`,
    );
  }
}

/**
 * Vérifie de bout en bout la mécanique Docker sans Claude ni quota :
 * image de base, cycle run → commit → run, rotation :prev, aplatissement.
 */
export async function dockerCheck(cfg: Config, opts: { rebuild: boolean }): Promise<void> {
  step("Docker");
  ok(`docker ${await dockerVersion()}`);

  step(`Image de base ${cfg.docker.baseImage}`);
  if (opts.rebuild || !(await imageExists(cfg.docker.baseImage))) {
    console.log(`  build depuis ${cfg.docker.dockerfileDir}…`);
    await buildBase(cfg);
  }
  ok(`image présente (${await layerCount(cfg.docker.baseImage)} couches)`);

  const exchangeDir = path.join(cfg.dataDir, `${CHECK_TASK}-exchange`);
  await removeTaskImages(CHECK_TASK);
  await rm(exchangeDir, { recursive: true, force: true });
  await mkdir(exchangeDir, { recursive: true });
  await writeFile(path.join(exchangeDir, "ping"), "pong\n");

  try {
    step("Claude Code dans l'image de base");
    const v = await runInTask(cfg, CHECK_TASK, { cmd: ["claude", "--version"], exchangeDir });
    await discardContainer(v.container);
    if (v.code !== 0) throw new Error(`claude --version a échoué : ${v.stderr.trim()}`);
    ok(`claude ${v.stdout.trim()} (root, IS_SANDBOX=1)`);

    step("Itération 1 : lit /exchange, écrit dans le container, commit");
    const r1 = await runInTask(cfg, CHECK_TASK, {
      cmd: ["sh", "-c", "cat /exchange/ping && echo persisted > /work/marker"],
      exchangeDir,
    });
    expectOutput(r1, "pong", "lecture de /exchange/ping");
    if (r1.image !== cfg.docker.baseImage) throw new Error(`image de départ inattendue : ${r1.image}`);
    await commitTask(cfg, CHECK_TASK, r1.container);
    ok(`commit → ${taskImage(CHECK_TASK)}:latest`);

    step("Itération 2 : repart du commit, retrouve l'état, commit à nouveau");
    const r2 = await runInTask(cfg, CHECK_TASK, { cmd: ["cat", "/work/marker"], exchangeDir });
    expectOutput(r2, "persisted", "lecture de /work/marker");
    if (r2.image !== `${taskImage(CHECK_TASK)}:latest`) throw new Error(`image de départ inattendue : ${r2.image}`);
    await commitTask(cfg, CHECK_TASK, r2.container);
    if (!(await imageExists(`${taskImage(CHECK_TASK)}:prev`))) throw new Error(":prev absent après la rotation");
    const before = await layerCount(`${taskImage(CHECK_TASK)}:latest`);
    ok(`état conservé, :prev présent, ${before} couches`);

    step("Itération jetée : pas de commit, l'état ne bouge pas");
    const r3 = await runInTask(cfg, CHECK_TASK, {
      cmd: ["sh", "-c", "echo oops > /work/marker"],
      exchangeDir,
    });
    await discardContainer(r3.container);
    const r3b = await runInTask(cfg, CHECK_TASK, { cmd: ["cat", "/work/marker"], exchangeDir });
    expectOutput(r3b, "persisted", "état après itération jetée");
    await discardContainer(r3b.container);
    ok("le marqueur vaut toujours « persisted »");

    step("Aplatissement");
    await flattenTask(CHECK_TASK);
    const after = await layerCount(`${taskImage(CHECK_TASK)}:latest`);
    if (after !== 1) throw new Error(`attendu 1 couche après aplatissement, obtenu ${after}`);
    const r4 = await runInTask(cfg, CHECK_TASK, {
      cmd: ["sh", "-c", "cat /work/marker; echo $IS_SANDBOX; pwd; claude --version >/dev/null && echo claude-ok"],
      exchangeDir,
    });
    await discardContainer(r4.container);
    expectOutput(r4, "persisted\n1\n/work\nclaude-ok", "état et config après aplatissement");
    ok(`${before} → ${after} couche, ENV/WORKDIR/PATH conservés`);

    console.log("\nTout est en ordre.");
  } finally {
    step("Nettoyage");
    await removeTaskImages(CHECK_TASK);
    await docker(["container", "prune", "-f", "--filter", `label=unused.task=${CHECK_TASK}`]);
    await rm(exchangeDir, { recursive: true, force: true });
    ok("images et containers de _check supprimés");
  }
}
