// job-steer.ts on us-metal02 failed with ENOENT on browser-chat/instance.json while the chat service restarted (10-18 06:50Z), so check-ins
// could not steer jobs through the chat server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

type Seen = { route: string; token: string | undefined; body: unknown };

function chatStub(seen: Seen[]): Server {
  return createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      seen.push({ route: request.url ?? "", token: request.headers["x-chat-token"] as string | undefined, body: JSON.parse(body) as unknown });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ act: "steer", session: "job-session" }));
    });
  });
}
const listen = (server: Server, port: number) => new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
async function freePort(): Promise<number> {
  const probe = createServer();
  await listen(probe, 0);
  const { port } = probe.address() as AddressInfo;
  await close(probe);
  return port;
}
function steer(data: string, root: string) {
  return promisify(execFile)(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/job-steer.ts"), "chat-1", "worker", "check the run"],
    { env: { ...process.env, AGENT_CHAT_DATA_DIR: data, SIEUN_PI_HOSTS: join(root, "no-hosts.json") }, timeout: 90_000 });
}

test("job-steer finds the chat service with no instance.json, from configuration.json", async () => {
  const seen: Seen[] = [];
  const server = chatStub(seen);
  await listen(server, 0);
  const root = mkdtempSync(join(tmpdir(), "job-steer-"));
  try {
    writeFileSync(join(root, "configuration.json"), JSON.stringify({ port: (server.address() as AddressInfo).port, capability: "cap", csrfToken: "t0k" }));
    const { stdout } = await steer(root, root);
    assert.match(stdout, /steered worker \(session job-session\)/);
    assert.deepEqual(seen, [{ route: "/cap/api/threads/chat-1/job-steer", token: "t0k", body: { job: "worker", message: "check the run" } }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await close(server);
  }
});

test("job-steer waits through a chat service restart instead of failing", async () => {
  const seen: Seen[] = [];
  const server = chatStub(seen);
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "job-steer-"));
  try {
    writeFileSync(join(root, "configuration.json"), JSON.stringify({ port, capability: "cap", csrfToken: "t0k" }));
    const steering = steer(root, root);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await listen(server, port);
    const { stdout } = await steering;
    assert.match(stdout, /steered worker/);
    assert.equal(seen.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await close(server);
  }
});
