// Guards 10-18 05:2x-05:45Z: after the moved chats' files left the Mac, the Mac daemon still listed 23 of their subagents, so the chat catalog
// read them from the Mac's relay, which answered 404, and the job wake read that as a 502 and retried them 786 times. A relay 404 now carries
// its status, so the thread reads as gone (404) and is not woken again.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Host, readHostFile } from "../src/hosts.ts";

test("a file the relay does not have reads as a 404 error, and another refusal keeps its own status", async () => {
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://127.0.0.1").searchParams.get("path");
    if (req.headers.authorization !== "Bearer secret") { res.writeHead(401); res.end(); return; }
    res.writeHead(path?.endsWith("gone.jsonl") ? 404 : path?.endsWith("busy.jsonl") ? 503 : 200, { "Content-Type": "application/json" });
    res.end(path?.endsWith("gone.jsonl") ? JSON.stringify({ error: "no such file" }) : "{}\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const dir = await mkdtemp(join(tmpdir(), "relay-gone-"));
  await writeFile(join(dir, "token"), "secret\n");
  const mac: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (server.address() as { port: number }).port, token: `file:${join(dir, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };
  try {
    await assert.rejects(readHostFile(mac, "/Users/sieunpark/.prime/agent/session-artifacts/01a1164b/sub-200ed0b7/gone.jsonl"),
      (error: Error & { status?: number }) => error.status === 404 && /no such file/.test(error.message));
    await assert.rejects(readHostFile(mac, "/x/busy.jsonl"), (error: Error & { status?: number }) => error.status === 503);
    assert.equal((await readHostFile(mac, "/x/ok.jsonl")).bytes.toString(), "{}\n");
  } finally { server.close(); }
});
