#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createApi, listen, socketPath } from "./api.js";
import { ApiError, call, DaemonUnreachable, stream } from "./client.js";
import { CONFIG_FILE, loadConfig, type Config } from "./config.js";
import { Daemon, type DaemonStatus, type StopResult } from "./daemon.js";
import { removeOrphanContainers } from "./docker.js";
import { formatDuration } from "./duration.js";

const program = new Command()
  .name("unused")
  .description("Fait tourner des tâches infinies sur le quota inutilisé d'un abonnement Claude Code.")
  .option("-c, --config <file>", "fichier de configuration (démon, ou pour déduire le socket)", CONFIG_FILE)
  .option("-s, --socket <path>", "socket du démon (défaut : $UNUSED_SOCKET, sinon <dataDir>/unused.sock)");

/** Démon uniquement : la config, puis un éventuel .env à côté (token) sans écraser l'environnement. */
async function daemonSetup(): Promise<Config> {
  const cfg = await loadConfig(program.opts().config);
  const envFile = path.join(cfg.rootDir, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return cfg;
}

/** Client : où est le démon ? Flag, variable d'environnement, sinon déduit de la config. Jamais .env. */
async function sock(): Promise<string> {
  const opts = program.opts<{ socket?: string; config: string }>();
  if (opts.socket) return path.resolve(opts.socket);
  if (process.env.UNUSED_SOCKET) return path.resolve(process.env.UNUSED_SOCKET);
  return socketPath(await loadConfig(opts.config));
}

// ---------------------------------------------------------------- le démon

program
  .command("daemon")
  .description("le processus qui vit : exécute les plages, sert l'API sur data/unused.sock (lancé par systemd)")
  .action(async () => {
    const cfg = await daemonSetup();
    const log = (line: string): void => console.log(line);
    const daemon = new Daemon(cfg, { print: log });
    await daemon.init();
    const server = createApi(cfg, daemon);
    const sock = socketPath(cfg);
    await listen(server, sock);
    // Seul démon sur ce socket (listen l'a vérifié), et on n'en fait tourner
    // qu'un par hôte Docker : un container encore là vient donc d'un démon tué
    // en pleine itération, il consommerait le quota pour rien.
    const orphans = await removeOrphanContainers().catch(() => 0);
    if (orphans > 0) log(`${orphans} container(s) laissé(s) par un arrêt brutal, supprimé(s)`);
    log(`démon prêt, socket ${sock}`);

    const ac = new AbortController();
    let signals = 0;
    const onSignal = (sig: string): void => {
      signals += 1;
      if (signals > 1) process.exit(130);
      log(`${sig} reçu : arrêt`);
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

program
  .command("start")
  .description("pose une plage manuelle : les tâches actives tournent jusqu'à son terme (s'ajoute aux plages automatiques)")
  .requiredOption("--for <duration>", "durée, ex. 8h, 90m, 1d12h")
  .action(async (opts: { for: string }) => {
    const r = await call<{ until: string; coveredUntil: string }>(await sock(), "POST", "/window", { for: opts.for });
    const more = r.coveredUntil > r.until ? ` (une plage automatique prolonge jusqu'à ${r.coveredUntil})` : "";
    console.log(`plage manuelle posée jusqu'à ${r.until}${more}`);
  });

/** Suite du message d'un stop : l'autre source couvre-t-elle encore, ce qui tourne vraiment, et sinon quand ça s'arrête. */
function stopOutcome(r: StopResult, other: string): string {
  if (r.continuing) {
    const doing = r.iteration
      ? `le travail continue (itération de ${r.iteration} en cours)`
      : r.idle
        ? "mais le démon est en veille (plus rien à faire)"
        : "le démon reste en plage";
    return ` ; ${other} couvre jusqu'à ${r.continuing}, ${doing}`;
  }
  if (r.stopping === "after-iteration") {
    return r.iteration
      ? ` ; plus rien ne couvre, le travail s'arrête après l'itération de ${r.iteration} en cours`
      : " ; plus rien ne couvre, le travail s'arrête au prochain tour (aucune itération en cours)";
  }
  if (r.killed) return ` ; plus rien ne couvre, itération de ${r.iteration} jetée`;
  return " ; plus rien ne couvre (aucune itération en cours)";
}

program
  .command("stop")
  .description("retire la plage manuelle (--auto : coupe les plages automatiques jusqu'à `resume`) ; le travail continue si l'autre source couvre encore")
  .option("--auto", "coupe les plages automatiques au lieu de la plage manuelle", false)
  .option("--now", "si plus rien ne couvre, tue l'itération en cours (s'il y en a une) au lieu d'attendre sa fin", false)
  .action(async (opts: { auto: boolean; now: boolean }) => {
    const q = opts.now ? "?now=1" : "";
    if (opts.auto) {
      const r = await call<StopResult>(await sock(), "DELETE", `/auto${q}`);
      console.log(`plages automatiques coupées jusqu'à \`unused resume\`${stopOutcome(r, "la plage manuelle")}`);
    } else {
      const r = await call<StopResult>(await sock(), "DELETE", `/window${q}`);
      console.log(`plage manuelle retirée (courait jusqu'à ${r.until})${stopOutcome(r, "une plage automatique")}`);
    }
  });

program
  .command("resume")
  .description("rallume les plages automatiques coupées par `stop --auto` (refusé pendant une panne : `reset-error`)")
  .action(async () => {
    const r = await call<{ coveringUntil: string | null; nextStart: string | null }>(await sock(), "POST", "/auto");
    const detail = r.coveringUntil ? `, plage automatique en cours jusqu'à ${r.coveringUntil}` : r.nextStart ? `, prochaine le ${r.nextStart}` : "";
    console.log(`plages automatiques rallumées${detail}`);
  });

program
  .command("reset-error")
  .description("efface une panne une fois réparée (vérifie Docker, l'image et le token) ; retire la plage manuelle, seules les plages automatiques relancent")
  .action(async () => {
    const r = await call<{ manualDropped: string | null; coveringUntil: string | null; nextStart: string | null }>(await sock(), "DELETE", "/fatal");
    const manual = r.manualDropped ? ` ; plage manuelle retirée (courait jusqu'à ${r.manualDropped})` : "";
    const next = r.coveringUntil
      ? ` ; plage automatique en cours jusqu'à ${r.coveringUntil}, le démon relance`
      : r.nextStart
        ? ` ; prochaine plage automatique le ${r.nextStart}`
        : " ; rien ne couvre : `start --for` pour relancer";
    console.log(`panne effacée${manual}${next}`);
  });

program
  .command("status")
  .description("état du démon, de la plage en cours et des tâches")
  .option("--json", "sortie JSON brute", false)
  .action(async (opts: { json: boolean }) => {
    const s = await call<DaemonStatus>(await sock(), "GET", "/status");
    if (opts.json) return console.log(JSON.stringify(s, null, 2));
    console.log(`démon    pid ${s.daemon.pid}, démarré ${s.daemon.startedAt}`);
    if (s.fatal) console.log(`PANNE    ${s.fatal.reason} depuis ${s.fatal.at} : ${s.fatal.detail.split("\n")[0]}\n         plus rien ne tourne — répare, puis \`unused reset-error\` (ou redémarre le service)`);
    const w = s.window;
    if (!w) {
      console.log("travail  aucun (rien ne tourne)");
    } else {
      console.log(`travail  plage ${w.source}, jusqu'à ${w.until} (${formatDuration(w.remainingMs)} restantes)${w.stopping ? " — arrêt demandé" : ""}`);
      console.log(`         ${w.iterations} itérations, ${w.completed} completed, ${w.failures} échecs, ${w.backoffs} attentes quota, $${w.costUsd.toFixed(2)}`);
      if (w.current) console.log(`en cours itération de ${w.current.task} / ${w.current.node} depuis ${w.current.at}`);
      else if (w.waitingQuotaUntil) console.log(`en cours attente quota jusqu'à ${w.waitingQuotaUntil} (aucune itération)`);
      else console.log("en cours entre deux itérations");
    }
    if (s.manual) console.log(`manuelle plage jusqu'à ${s.manual.until}`);
    else console.log("manuelle aucune plage");
    const a = s.auto;
    if (a.windows === 0) console.log("auto     aucune plage configurée");
    else if (!a.enabled) console.log(`auto     ${a.windows} plage(s), coupées (\`unused resume\`)`);
    else console.log(`auto     ${a.windows} plage(s)${a.coveringUntil ? `, en cours jusqu'à ${a.coveringUntil}` : ""}${a.nextStart ? `, prochaine le ${a.nextStart}` : ""}`);
    if (s.idleUntil) console.log(`veille   jusqu'à ${s.idleUntil} (plus rien à faire — tasks reset/activate, start ou resume réveillent)`);
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
  .command("new <task>")
  .description("crée le squelette d'une tâche (task.json inactif, README, skills setup et work)")
  .action(async (name: string) => {
    const r = await call<{ dir: string }>(await sock(), "POST", "/tasks", { name });
    console.log(`${r.dir} créé — adapte task.json et les skills, puis \`unused tasks activate ${name}\``);
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
