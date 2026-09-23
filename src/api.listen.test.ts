import { mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listen } from "./api.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "unused-ls-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("démarrage sur une installation neuve", () => {
  it("le dossier du socket est créé s'il n'existe pas", async () => {
    const sock = path.join(root, "data", "unused.sock");
    const server = http.createServer();
    await listen(server, sock);
    expect((await stat(sock)).isSocket()).toBe(true);
    server.close();
  });
});
