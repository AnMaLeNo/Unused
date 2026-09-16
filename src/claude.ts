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
 * `claude -p <sessionArgs> <node.args>`. Le runner impose `--output-format
 * stream-json --verbose` : il y lit le résultat final (terminal_reason) et les
 * événements de quota (rate_limit_event). Toute autre valeur donnée est remplacée.
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
    if (a.startsWith("--output-format=") || a === "--verbose") continue;
    args.push(a);
  }
  return ["claude", "-p", ...args, "--output-format", "stream-json", "--verbose"];
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
  modelUsage?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Une fenêtre de quota : `utilization` de 0 à 1 (×100 = le % de /usage), `resetsAt` en secondes epoch. */
export interface QuotaWindow {
  utilization: number;
  resetsAt: number;
}

export interface QuotaSnapshot {
  five_hour?: QuotaWindow;
  seven_day?: QuotaWindow;
}

/** Le `rate_limit_info` d'un `rate_limit_event`, émis quand l'info de quota change. */
export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Partial<Record<"five_hour" | "seven_day", QuotaWindow>>;
  [key: string]: unknown;
}

export interface SessionStream {
  // Le message `result` final, ou null si la sortie était illisible / tronquée.
  result: ClaudeResult | null;
  rateLimits: RateLimitInfo[];
  // Le `system/init` : modèle, outils, etc.
  init: Record<string, unknown> | null;
  apiRetries: { error?: string; error_status?: number | null }[];
  lines: number;
}

/** Lit la sortie NDJSON de `claude -p --output-format stream-json`. */
export function parseStream(stdout: string): SessionStream {
  const s: SessionStream = { result: null, rateLimits: [], init: null, apiRetries: [], lines: 0 };
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    s.lines += 1;
    switch (d.type) {
      case "result":
        s.result = d as ClaudeResult;
        break;
      case "rate_limit_event":
        if (d.rate_limit_info && typeof d.rate_limit_info === "object") s.rateLimits.push(d.rate_limit_info as RateLimitInfo);
        break;
      case "system":
        if (d.subtype === "init") s.init = d;
        else if (d.subtype === "api_retry") s.apiRetries.push(d as SessionStream["apiRetries"][number]);
        break;
    }
  }
  return s;
}

/** Les fenêtres 5 h / 7 jours d'un événement, ou null s'il n'en porte aucune. */
export function quotaSnapshot(info: RateLimitInfo | undefined): QuotaSnapshot | null {
  if (!info) return null;
  const snap: QuotaSnapshot = {};
  const w = info.unifiedWindows ?? {};
  if (w.five_hour) snap.five_hour = { ...w.five_hour };
  if (w.seven_day) snap.seven_day = { ...w.seven_day };
  if (!snap.five_hour && !snap.seven_day && info.utilization !== undefined && info.resetsAt !== undefined) {
    // Forme minimale : une seule fenêtre, celle de `rateLimitType`.
    const key = info.rateLimitType === "seven_day" ? "seven_day" : "five_hour";
    snap[key] = { utilization: info.utilization, resetsAt: info.resetsAt };
  }
  return snap.five_hour || snap.seven_day ? snap : null;
}

/** Le dernier événement `rejected` de la session : quota saturé. */
export function quotaRejection(events: RateLimitInfo[]): { rateLimitType: string; resetsAt?: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.status === "rejected") return { rateLimitType: e.rateLimitType ?? "unknown", resetsAt: e.resetsAt };
  }
  return null;
}
