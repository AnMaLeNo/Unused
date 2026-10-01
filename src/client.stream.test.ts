import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, stream } from "./client.js";

let dir: string;
let sock: string;
let server: http.Server;
async function serve(body: string): Promise<void> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((res) => server.listen(sock, res));
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "unused-cli-"));
  sock = path.join(dir, "s.sock");
});
afterEach(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("docker build / docker check", () => {
  it("un échec en fin de flux fait échouer la commande (code de sortie ≠ 0), sur stderr", async () => {
    await serve("▶ Docker\n  ✔ docker 27\nERREUR build de l'image de base a échoué (docker build, code 1) :\ncurl: (6) Could not resolve host\n");
    const out: string[] = [];
    const err = await stream(sock, "POST", "/docker/check", (l) => out.push(l)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("build de l'image de base a échoué (docker build, code 1) :\ncurl: (6) Could not resolve host");
    expect(out).toEqual(["▶ Docker", "  ✔ docker 27"]);
  });

  it("un flux sans erreur réussit", async () => {
    await serve("▶ Docker\n  ✔ docker 27\n\nTout est en ordre.\n");
    await expect(stream(sock, "POST", "/docker/check", () => {})).resolves.toBeUndefined();
  });
});
