import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TASK_FILE, TASK_NAME_RE } from "./task.js";

const TASK_JSON = {
  active: false,
  start: "setup",
  params: { repo: "owner/projet" },
  env: [],
  nodes: {
    setup: { skill: "setup", next: "work" },
    work: { skill: "work", next: "work" },
  },
};

const README = `# Tâche <name>

Créée par \`unused tasks new\`. À adapter, puis \`unused tasks activate <name>\`.

## task.json

- \`active\` : false tant que la tâche n'est pas prête ; \`unused tasks activate\` la met dans la file.
- \`start\` : le premier nœud exécuté.
- \`params\` : passés à chaque skill via \`$ARGUMENTS\` (\`repo=owner/projet …\`).
- \`env\` : variables données au container, comme \`docker run -e\` — \`"GH_TOKEN"\`
  transmet la valeur du \`.env\` du démon, \`"GIT_AUTHOR_NAME=bot"\` la fixe. Le
  token Claude est toujours transmis.
- \`nodes\` : chaque nœud lance un skill (\`skills/<skill>/SKILL.md\`) et désigne
  son successeur. Un nœud peut avoir ses propres \`params\` et \`args\`
  (arguments \`claude\`, ex. \`["--model", "opus"]\`).

## La règle

Un skill est rejoué tant qu'il n'a pas créé \`/exchange/DONE\`. Chaque session
doit avancer d'une unité de travail *courte*, lire ce que les précédentes ont
laissé dans le container, et noter ce qu'elle a fait. Une session qui échoue
est réputée n'avoir jamais eu lieu : le container revient à l'état d'avant.

Le container est conservé d'une itération à l'autre (commit Docker) ; tout ce
que Claude y installe ou y écrit reste. \`/exchange/\` est ce dossier-ci,
monté dans le container : DONE, rapports, ce que tu veux lire depuis l'hôte.
`;

const SETUP = `---
name: setup
description: Prépare le container pour la tâche (une seule fois, au premier nœud).
disable-model-invocation: true
---

Paramètres : $ARGUMENTS

Tu es dans un container qui te sert d'espace de travail pour toute la durée
de la tâche ; il est conservé d'une session à l'autre. Cette session prépare
le terrain, une seule fois :

1. Installe ce qui manque (apt, outils) et clone le dépôt \`repo\` dans /work/repo.
   Pour un dépôt privé, un token est disponible dans la variable d'environnement
   GH_TOKEN si la tâche le transmet.
2. Configure git (nom et e-mail sont dans l'environnement si la tâche les fournit).
3. Établis le plan de travail : un fichier /work/PLAN.md, une liste à cocher des
   unités de travail que les sessions suivantes traiteront une par une.

Ne fais rien d'autre. Ne crée pas /exchange/DONE : la tâche ne fait que commencer.
`;

const WORK = `---
name: work
description: Avance d'une unité de travail, puis rend la main.
disable-model-invocation: true
---

Paramètres : $ARGUMENTS

Tu reprends un container préparé par le skill setup ; le dépôt est dans
/work/repo et le plan dans /work/PLAN.md. Une session = une unité de travail :

1. Lis /work/PLAN.md et prends la première case non cochée.
2. Réalise cette seule unité. Reste court : si tu vois que c'est trop gros,
   découpe-la dans le plan et fais la première partie.
3. Coche la case, note en une ligne ce que tu as fait dans /work/JOURNAL.md.
4. Commite dans le dépôt si c'est pertinent.

S'il ne reste aucune case à cocher, crée le fichier /exchange/DONE : la tâche
est terminée et ne sera plus relancée. Sinon, rends simplement la main : une
autre session prendra la suite.
`;

/** Crée `tasks/<name>/` : task.json inactif, README, deux skills (setup, work), exchange/. */
export async function scaffoldTask(tasksDir: string, name: string): Promise<string> {
  if (!TASK_NAME_RE.test(name)) {
    throw new Error(`nom de tâche invalide "${name}" : minuscules, chiffres, et un seul . _ ou - entre deux groupes`);
  }
  const dir = path.join(tasksDir, name);
  if (await stat(dir).then(() => true, () => false)) throw new Error(`${dir} existe déjà`);
  await mkdir(path.join(dir, "skills", "setup"), { recursive: true });
  await mkdir(path.join(dir, "skills", "work"), { recursive: true });
  await mkdir(path.join(dir, "exchange"), { recursive: true });
  await writeFile(path.join(dir, TASK_FILE), JSON.stringify(TASK_JSON, null, 2) + "\n");
  await writeFile(path.join(dir, "README.md"), README.replaceAll("<name>", name));
  await writeFile(path.join(dir, "skills", "setup", "SKILL.md"), SETUP);
  await writeFile(path.join(dir, "skills", "work", "SKILL.md"), WORK);
  return dir;
}
