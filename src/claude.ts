import type { Config } from "./config.js";
import type { TaskNode } from "./task.js";

/**
 * Les paramètres arrivent au skill via $ARGUMENTS, sous la forme
 * `cle=valeur cle2="valeur avec espaces"`, après le nom du skill.
 */
export function renderArguments(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => (/^[\w./:@+-]*$/.test(v) ? `${k}=${v}` : `${k}=${JSON.stringify(v)}`))
    .join(" ");
}

/** `/<skill> cle=valeur …` — les params du nœud écrasent ceux de la tâche. */
export function buildPrompt(node: TaskNode, taskParams: Record<string, string>): string {
  const args = renderArguments({ ...taskParams, ...node.params });
  return args ? `/${node.skill} ${args}` : `/${node.skill}`;
}

/**
 * `claude -p <sessionArgs> <node.args>`. Le runner impose `--output-format json`
 * (il lit terminal_reason dedans) : toute autre valeur donnée est remplacée.
 */
export function buildCommand(cfg: Config, node: TaskNode): string[] {
  const args: string[] = [];
  const src = [...cfg.claude.sessionArgs, ...node.args];
  for (let i = 0; i < src.length; i++) {
    const a = src[i]!;
    if (a === "--output-format") {
      i++;
      continue;
    }
    if (a.startsWith("--output-format=")) continue;
    args.push(a);
  }
  return ["claude", "-p", ...args, "--output-format", "json"];
}

export interface ClaudeResult {
  terminal_reason?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  result?: string;
  usage?: unknown;
  modelUsage?: unknown;
  [key: string]: unknown;
}

/** Le JSON de `claude -p --output-format json`, ou null si la sortie est illisible. */
export function parseResult(stdout: string): ClaudeResult | null {
  const text = stdout.trim();
  const candidates = [text, text.slice(text.lastIndexOf("\n") + 1)];
  for (const c of candidates) {
    if (!c.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === "object" && "type" in parsed && (parsed as { type: unknown }).type === "result") {
        return parsed as ClaudeResult;
      }
    } catch {
      /* on tente le candidat suivant */
    }
  }
  return null;
}
