#!/usr/bin/env node
import { Command } from "commander";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { describeGraph, loadTasks } from "./task.js";

const program = new Command()
  .name("unused")
  .description("Fait tourner des tâches infinies sur le quota inutilisé d'un abonnement Claude Code.")
  .option("-c, --config <file>", "fichier de configuration", CONFIG_FILE);

function notYet(step: number): () => never {
  return () => {
    console.error(`pas encore implémenté (étape ${step})`);
    process.exit(2);
  };
}

const tasks = program.command("tasks").description("gérer les tâches");

tasks
  .command("list")
  .description("liste les tâches et signale celles qui sont mal définies")
  .action(async () => {
    const cfg = await loadConfig(program.opts().config);
    const { tasks, errors } = await loadTasks(cfg.tasksDir);
    if (tasks.length === 0 && errors.length === 0) {
      console.log(`aucune tâche dans ${cfg.tasksDir}`);
    }
    for (const t of tasks) {
      const flag = t.def.active ? "active  " : "inactive";
      console.log(`${flag}  ${t.name}`);
      console.log(`          ${describeGraph(t.def)}`);
    }
    for (const e of errors) {
      console.error(`\nERREUR   ${e.name}\n          ${e.message.replace(/\n/g, "\n          ")}`);
    }
    if (errors.length > 0) process.exitCode = 1;
  });

program
  .command("iterate <task>")
  .description("exécute une seule itération d'une tâche (nœud courant)")
  .action(notYet(3));

program
  .command("run")
  .description("fait tourner les tâches actives pendant une durée donnée")
  .requiredOption("--for <duration>", "durée de la plage, ex. 8h, 90m")
  .action(notYet(4));

program
  .command("status")
  .description("état des tâches et de la plage en cours")
  .action(notYet(5));

program
  .command("docker")
  .description("gérer l'image et les containers")
  .command("check")
  .description("construit l'image de base et vérifie le cycle run → commit → run")
  .action(notYet(2));

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
