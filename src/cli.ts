#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createApi, listen, socketPath } from "./api.js";
import { ApiError, call, DaemonUnreachable, stream } from "./client.js";
import { CONFIG_FILE, loadConfig, type Config } from "./config.js";
import { Daemon, type DaemonStatus } from "./daemon.js";
import { formatDuration } from "./duration.js";

const program = new Command()
  .name("unused")
  .description("Fait tourner des tâches infinies sur le quota inutilisé d'un abonnement Claude Code.")
  .option("-c, --config <file>", "fichier de configuration", CONFIG_FILE);

/** Charge la config, puis un éventuel .env à côté (token, etc.) sans écraser l'environnement. */
async function setup(): Promise<Config> {
  const cfg = await loadConfig(program.opts().config);
  const envFile = path.join(cfg.rootDir, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return cfg;
}

// ---------------------------------------------------------------- le démon

program
  .command("daemon")
  .description("le processus qui vit : exécute les plages, sert l'API sur data/unused.sock (lancé par systemd)")
  .action(async () => {
    const cfg = await setup();
    const log = (line: string): void => console.log(line);
    const daemon = new Daemon(cfg, { print: log });
    await daemon.init();
    const server = createApi(cfg, daemon);
    const sock = socketPath(cfg);
    await listen(server, sock);
    log(`démon prêt, socket ${sock}`);

    const ac = new AbortController();
    let signals = 0;
    const onSignal = (sig: string): void => {
      signals += 1;
      if (signals > 1) process.exit(130);
      log(`${sig} reçu : arrêt (l'itération en cours est jetée, la plage sera reprise au prochain démarrage)`);
      ac.abort();
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    try {
      await daemon.run(ac.signal);
    } finally {
      server.close();
      log("démon arrêté");
    }
  });

// ------------------------------------------------------- la CLI, cliente

async function sock(): Promise<string> {
  return socketPath(await setup());
}

program
  .command("start")
  .description("démarre une plage : les tâches actives tournent jusqu'à son terme")
  .requiredOption("--for <duration>", "durée, ex. 8h, 90m, 1d12h")
  .action(async (opts: { for: string }) => {
    const r = await call<{ until: string }>(await sock(), "POST", "/window", { for: opts.for });
    console.log(`plage démarrée jusqu'à ${r.until}`);
  });

program
  .command("stop")
  .description("arrête la plage en cours après l'itération en cours (--now : tout de suite, itération jetée)")
  .option("--now", "tue l'itération en cours", false)
  .action(async (opts: { now: boolean }) => {
    const r = await call<{ stopping: string }>(await sock(), "DELETE", `/window${opts.now ? "?now=1" : ""}`);
    console.log(r.stopping === "now" ? "plage arrêtée" : "arrêt demandé : la plage s'arrêtera après l'itération en cours");
  });

program
  .command("status")
  .description("état du démon, de la plage en cours et des tâches")
  .option("--json", "sortie JSON brute", false)
  .action(async (opts: { json: boolean }) => {
    const s = await call<DaemonStatus>(await sock(), "GET", "/status");
    if (opts.json) return console.log(JSON.stringify(s, null, 2));
    console.log(`démon    pid ${s.daemon.pid}, démarré ${s.daemon.startedAt}`);
    const w = s.window;
    if (!w) {
      console.log("plage    aucune");
    } else {
      console.log(`plage    jusqu'à ${w.until} (${formatDuration(w.remainingMs)} restantes)${w.stopping ? " — arrêt demandé" : ""}`);
      console.log(`         ${w.iterations} itérations, ${w.completed} completed, ${w.failures} échecs, ${w.backoffs} attentes quota, $${w.costUsd.toFixed(2)}`);
      if (w.current) console.log(`en cours ${w.current.task} / ${w.current.node} depuis ${w.current.at}`);
      else if (w.waitingQuotaUntil) console.log(`en cours attente quota jusqu'à ${w.waitingQuotaUntil}`);
    }
    if (s.lastWindow && !w) {
      const l = s.lastWindow;
      console.log(`dernière ${l.iterations} itérations, ${l.completed} completed, ${l.failures} échecs, $${l.costUsd.toFixed(2)} (${l.endedBecause})`);
    }
    printTasks(s.tasks, s.taskErrors);
  });

const tasks = program.command("tasks").description("gérer les tâches");

function printTasks(list: DaemonStatus["tasks"], errors: DaemonStatus["taskErrors"]): void {
  console.log(list.length === 0 && errors.length === 0 ? "tâches   aucune" : "tâches");
  for (const t of list) {
    const flag = !t.active ? "inactive" : t.status === "running" ? "active  " : t.status === "done" ? "done    " : "failed  ";
    const last = t.last ? `, dernier ${t.last.node} → ${t.last.outcome} (${t.last.at})` : "";
    console.log(`  ${flag}  ${t.name}  curseur ${t.cursor}, ${t.iterations} itérations${last}`);
  }
  for (const e of errors) console.log(`  ERREUR    ${e.name}  ${e.message.replace(/\n/g, "\n            ")}`);
}

tasks
  .command("list")
  .description("liste les tâches, leur curseur et leur statut")
  .action(async () => {
    const r = await call<{ tasks: DaemonStatus["tasks"]; errors: DaemonStatus["taskErrors"] }>(await sock(), "GET", "/tasks");
    printTasks(r.tasks, r.errors);
    if (r.errors.length > 0) process.exitCode = 1;
  });

tasks
  .command("reset <task>")
  .description("remet une tâche à zéro : état, image Docker, DONE (les autres fichiers d'exchange sont gardés)")
  .action(async (name: string) => {
    const r = await call<{ start: string }>(await sock(), "POST", `/tasks/${encodeURIComponent(name)}/reset`);
    console.log(`${name} remise à zéro (curseur sur ${r.start}, image supprimée)`);
  });

for (const [cmd, active] of [
  ["activate", true],
  ["deactivate", false],
] as const) {
  tasks
    .command(`${cmd} <task>`)
    .description(active ? "remet une tâche dans la file" : "retire une tâche de la file (task.json : active=false)")
    .action(async (name: string) => {
      await call(await sock(), "POST", `/tasks/${encodeURIComponent(name)}/active`, { active });
      console.log(`${name} ${active ? "activée" : "désactivée"}`);
    });
}

const dockerCmd = program.command("docker").description("gérer l'image de base");

dockerCmd
  .command("build")
  .description("(re)construit l'image de base")
  .action(async () => stream(await sock(), "POST", "/docker/build", console.log));

dockerCmd
  .command("check")
  .description("vérifie le cycle run → commit → run, la rotation et l'aplatissement")
  .option("--rebuild", "reconstruit l'image de base même si elle existe", false)
  .action(async (opts: { rebuild: boolean }) =>
    stream(await sock(), "POST", `/docker/check${opts.rebuild ? "?rebuild=1" : ""}`, console.log),
  );

program.parseAsync().catch((err: Error) => {
  console.error(err instanceof DaemonUnreachable || err instanceof ApiError ? err.message : err.message);
  process.exit(err instanceof ApiError && err.status === 409 ? 3 : 1);
});
