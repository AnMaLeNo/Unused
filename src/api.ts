import { unlink } from "node:fs/promises";
import { chmodSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Config } from "./config.js";
import { ConflictError, NotFoundError, type Daemon } from "./daemon.js";
import { buildBase } from "./docker.js";
import { dockerCheck } from "./dockerCheck.js";
import { parseDuration } from "./duration.js";
import { scaffoldTask } from "./scaffold.js";

export const SOCKET_FILE = "unused.sock";

export function socketPath(cfg: Pick<Config, "dataDir">): string {
  return path.join(cfg.dataDir, SOCKET_FILE);
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "corps JSON invalide");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Réponse texte streamée ligne par ligne (build et check Docker). */
function streamText(res: http.ServerResponse): (line: string) => void {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "transfer-encoding": "chunked" });
  return (line) => res.write(line + "\n");
}

/**
 * L'API du démon : HTTP + JSON sur socket Unix. La CLI en est le seul
 * client aujourd'hui ; un front pourra parler aux mêmes routes demain.
 */
export function createApi(cfg: Config, daemon: Daemon): http.Server {
  // build ou check en cours : un seul à la fois, ils travaillent sur les mêmes images.
  let dockerBusy: "build" | "check" | null = null;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://unused");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /status") return sendJson(res, 200, await daemon.status());

      if (route === "POST /window") {
        const body = await readJson(req);
        if (typeof body.for !== "string") throw new HttpError(400, "champ `for` attendu (ex. \"8h\")");
        const { until } = await daemon.startWindow(parseDuration(body.for));
        return sendJson(res, 200, { until: until.toISOString() });
      }

      if (route === "DELETE /window") {
        return sendJson(res, 200, await daemon.stopWindow(url.searchParams.get("now") === "1"));
      }

      if (route === "POST /tasks") {
        const body = await readJson(req);
        if (typeof body.name !== "string") throw new HttpError(400, "champ `name` attendu");
        try {
          return sendJson(res, 200, { dir: await scaffoldTask(cfg.tasksDir, body.name) });
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      }

      if (route === "GET /tasks") {
        const s = await daemon.status();
        return sendJson(res, 200, { tasks: s.tasks, errors: s.taskErrors });
      }

      const task = /^POST \/tasks\/([^/]+)\/(reset|active)$/.exec(route);
      if (task) {
        const name = decodeURIComponent(task[1]!);
        if (task[2] === "reset") return sendJson(res, 200, await daemon.resetTask(name));
        const body = await readJson(req);
        if (typeof body.active !== "boolean") throw new HttpError(400, "champ booléen `active` attendu");
        await daemon.setActive(name, body.active);
        return sendJson(res, 200, { name, active: body.active });
      }

      if (route === "POST /docker/build" || route === "POST /docker/check") {
        const what = route === "POST /docker/build" ? "build" : "check";
        if (dockerBusy) {
          streamText(res)(`ERREUR docker ${dockerBusy} déjà en cours (lancé plus tôt, il continue même si sa commande a été interrompue)`);
          return res.end();
        }
        dockerBusy = what;
        try {
          // Le check reconstruit, lance et aplatit des images : pas sous une plage.
          if (what === "check" && (await daemon.status()).window) {
            streamText(res)("ERREUR une plage est en cours : relance le check une fois qu'elle est finie (ou après `unused stop`)");
            return res.end();
          }
          const print = streamText(res);
          if (what === "build") {
            await buildBase(cfg, print);
          } else {
            try {
              await dockerCheck(cfg, { rebuild: url.searchParams.get("rebuild") === "1" }, print);
            } catch (err) {
              print(`ERREUR ${(err as Error).message}`);
            }
          }
          return res.end();
        } finally {
          dockerBusy = null;
        }
      }

      throw new HttpError(404, `route inconnue : ${route}`);
    } catch (err) {
      if (res.headersSent) {
        res.write(`ERREUR ${(err as Error).message}\n`);
        return res.end();
      }
      const status =
        err instanceof HttpError ? err.status : err instanceof ConflictError ? 409 : err instanceof NotFoundError ? 404 : 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: (err as Error).message });
    }
  });
}

/** Un démon écoute-t-il déjà sur ce socket ? */
export function probe(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, path: "/status", method: "GET", timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Écoute sur le socket, après avoir écarté un socket périmé (ou refusé si un démon répond). */
export async function listen(server: http.Server, sock: string): Promise<void> {
  if (await probe(sock)) throw new Error(`un démon répond déjà sur ${sock}`);
  await unlink(sock).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(sock, 0o660);
}
