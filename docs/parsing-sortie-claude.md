# Le parsing de la sortie Claude

`src/claude.ts` est la couche qui parle au binaire `claude` : elle construit
la commande et le prompt à lui passer, puis relit sa sortie NDJSON pour en
extraire ce qui compte — le résultat final et les événements de quota. C'est
sur ces structures que `classify()` (`src/graph.ts`, voir
[le cycle d'une itération](cycle-d-iteration.md)) s'appuie pour décider si une
itération a réussi, doit être retentée, ou doit attendre un quota.

## Construire la commande

`buildPrompt` transforme les paramètres du nœud courant en une ligne de skill
`/skill cle=valeur …` :

```ts
export function buildPrompt(node: TaskNode, taskParams: Record<string, string>): string {
  const args = renderArguments({ ...taskParams, ...node.params });
  return args ? `/${node.skill} ${args}` : `/${node.skill}`;
}
```

Les paramètres du nœud écrasent ceux de la tâche (`{ ...taskParams,
...node.params }`). `renderArguments` ne cite une valeur que si elle contient
autre chose que `[\w./:@+-]` (espaces, guillemets…) :

```ts
export function renderArguments(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => (/^[\w./:@+-]*$/.test(v) ? `${k}=${v}` : `${k}=${JSON.stringify(v)}`))
    .join(" ");
}
```

`buildCommand` assemble ensuite la commande `claude` : `cfg.claude.sessionArgs`
(config globale, ex. `--dangerously-skip-permissions`) suivis de `node.args`
(propres au nœud), en filtrant tout `--output-format`/`--verbose` fourni pour
les imposer en dernier :

```ts
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
```

`--output-format stream-json --verbose` est non négociable : c'est le format
que `parseStream` sait lire. Le prompt, lui, n'est pas passé en argument mais
sur `stdin` — voir `stdin: prompt` dans l'appel à `runInTask` (`src/iterate.ts`).

## Lire la sortie NDJSON

`claude -p --output-format stream-json` produit une ligne JSON par événement.
`parseStream` les parcourt, ignore tout ce qui n'est pas un objet JSON valide
(bannières, bruit de terminal), et retient trois types :

```ts
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
```

- **`result`** (`ClaudeResult`) — le message final de la session : notamment
  `terminal_reason` (`"completed"`, `"api_error"`, `"blocking_limit"`,
  `"max_turns"`…), `api_error_status`, `total_cost_usd`, `num_turns`,
  `result` (texte). S'il n'y a pas de ligne `result` exploitable, `s.result`
  reste `null` — `classify()` traite ça comme `unreadable_output`.
- **`rate_limit_event`** — accumulés dans `s.rateLimits`, un par changement de
  quota pendant la session (voir plus bas).
- **`system/init`** — capturé dans `s.init` (modèle, outils…) ; `iterate()`
  s'en sert pour renseigner `model` dans le log si `session.result?.modelUsage`
  ne le donne pas.
- **`system/api_retry`** — les tentatives de retry HTTP internes à `claude`,
  accumulées dans `s.apiRetries` pour le log, sans influencer `classify()`.

`s.lines` compte les lignes JSON reconnues ; `iterate()` s'en sert (avec
`isDockerDown(r.stderr)`) pour distinguer une sortie vide parce que Docker est
en panne d'une sortie vide parce que `claude` n'a simplement rien dit.

## Le quota : `rate_limit_event`

Le quota n'est **pas** lu dans `terminal_reason` — `blocking_limit` y désigne
une fenêtre de contexte pleine, pas un quota épuisé. Il se lit dans les
`rate_limit_event`, dont chacun porte un `rate_limit_info` :

```ts
export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Partial<Record<"five_hour" | "seven_day", QuotaWindow>>;
  [key: string]: unknown;
}
```

`quotaSnapshot` normalise un événement en deux fenêtres au plus (`five_hour`,
`seven_day`), chacune avec une `utilization` de 0 à 1 et un `resetsAt` en
secondes epoch. Il gère aussi une forme minimale, où l'événement ne porte
qu'un seul `utilization`/`resetsAt` sans `unifiedWindows` :

```ts
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
```

`iterate()` prend un snapshot avant (`session.rateLimits[0]`) et après
(`session.rateLimits[session.rateLimits.length - 1]`) la session, pour que le
log montre l'évolution du quota sur l'itération.

`quotaRejection` cherche le dernier événement `status === "rejected"` en
partant de la fin — c'est celui qui fait foi si le quota a été saturé puis
éventuellement retesté dans la même session :

```ts
export function quotaRejection(events: RateLimitInfo[]): { rateLimitType: string; resetsAt?: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.status === "rejected") return { rateLimitType: e.rateLimitType ?? "unknown", resetsAt: e.resetsAt };
  }
  return null;
}
```

C'est ce que `classify()` appelle en premier, avant même de regarder
`terminal_reason` : un quota rejeté prime sur tout le reste et donne un
`Outcome` `quota` (attente, ni la tâche ni le nœud ne bougent).

## Exemple concret

Le test `src/claude.test.ts` rejoue une session où le quota `five_hour` est
d'abord `allowed` puis `rejected` après un retry HTTP 429 :

```
{"type":"system","subtype":"init","model":"claude-sonnet-5","session_id":"s"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":100,"unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":100},"seven_day":{"utilization":0.05,"resetsAt":900}}}}
{"type":"assistant","message":{}}
{"type":"system","subtype":"api_retry","error":"rate_limit","error_status":429}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":100}}
{"type":"result","terminal_reason":"api_error","api_error_status":429,"total_cost_usd":0.01,"num_turns":1}
```

`parseStream` en tire `s.lines === 6`, `s.result.terminal_reason ===
"api_error"`, `s.init.model === "claude-sonnet-5"`, deux `rateLimits` et un
`apiRetries`. `quotaSnapshot(s.rateLimits[0])` donne les deux fenêtres
complètes ; le second événement, minimal (pas d'`unifiedWindows`), est celui
que `quotaRejection` retient — d'où un `Outcome` `quota` plutôt que `failure`
malgré le `terminal_reason: "api_error"`.
