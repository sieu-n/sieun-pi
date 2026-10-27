// Guards the 10-27 hello fix: the catalog's link to this box's daemon waited 1.5 s for the hello and failed while the supervisor's hello came
// after 3 to 7 s (~/work/prime-under-load/LOGS.md), so every service command that went through the link failed with it.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const HELLO = `${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, appVersion: "fixture", serverCapabilities: ["agent_roster"] })}\n`;

/** A daemon that greets each connection `helloMs` after it accepts it and answers every command with success. */
async function slowDaemon(t: TestContext, helloMs: number): Promise<{ path: string; commands: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "catalog-slow-hello-"));
  const path = join(dir, "daemon.sock");
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.write(HELLO), helloMs);
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { type: string; id: string; command?: { type: string } };
        buffer = buffer.slice(end + 1);
        const type = line.command?.type ?? line.type;
        if (type === "ack_result") continue;
        commands.push(type);
        socket.write(`${JSON.stringify({ type: "response", id: line.id, command: type, success: true, data: { sessions: [] } })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, commands };
}

test("the catalog connects to a daemon whose hello comes after 2.5 s", async (t: TestContext) => {
  const daemon = await slowDaemon(t, 2500);
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog(daemon.path, reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  await catalog.connect();
  assert.ok(daemon.commands.includes("roster_subscribe"), daemon.commands.join(", "));
});
