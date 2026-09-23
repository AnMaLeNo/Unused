import http from "node:http";

export class DaemonUnreachable extends Error {}
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function unreachable(sock: string, err: NodeJS.ErrnoException): DaemonUnreachable {
  if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
    return new DaemonUnreachable(`le démon n'est pas lancé (socket ${sock}) : \`systemctl start unused\` ou \`unused daemon\``);
  }
  return new DaemonUnreachable(`démon injoignable : ${err.message}`);
}

/** Un appel JSON. Une réponse non-2xx devient une ApiError portant le message du démon. */
export function call<T = unknown>(sock: string, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: sock,
        method,
        path,
        headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            return reject(new ApiError(res.statusCode ?? 0, `réponse illisible : ${text.slice(0, 200)}`));
          }
          if ((res.statusCode ?? 500) >= 300) {
            const msg = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.statusCode}`;
            return reject(new ApiError(res.statusCode ?? 0, msg));
          }
          resolve(parsed as T);
        });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => reject(unreachable(sock, e)));
    req.end(data);
  });
}

/** Un appel dont la réponse est du texte streamé, relayé ligne par ligne. */
export function stream(sock: string, method: string, path: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, method, path }, (res) => {
      let buf = "";
      // Une route streamée a déjà répondu 200 quand elle échoue : l'échec arrive
      // en fin de flux, à partir d'une ligne « ERREUR … ».
      let failure: string[] | null = null;
      const line = (l: string): void => {
        if (failure === null && l.startsWith("ERREUR ")) failure = [l.slice("ERREUR ".length)];
        else if (failure !== null) failure.push(l);
        else onLine(l);
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) line(l);
      });
      res.on("end", () => {
        if (buf) line(buf);
        if ((res.statusCode ?? 500) >= 300) return reject(new ApiError(res.statusCode ?? 0, buf || `HTTP ${res.statusCode}`));
        if (failure !== null) return reject(new ApiError(500, failure.join("\n").trim()));
        resolve();
      });
    });
    req.on("error", (e: NodeJS.ErrnoException) => reject(unreachable(sock, e)));
    req.end();
  });
}
