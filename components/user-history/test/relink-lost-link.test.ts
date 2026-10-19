// Guards the red "Lost connection to the Prime Agent daemon" bar an open Mac thread showed after the chat service restart at 15:19:50Z on
// 10-19 for at least 7 min (~/work/mac-feel-check/thread-errbar.png, 15:28Z). The service's stop closed the Mac bridge's tunnels before its
// server (service.log 15:19:48.946Z "stop: 922 ms: sends 2 ms, bridges 268 ms, server 649 ms"), so each attached Mac thread's link dropped
// while its pages still listened: a probe subscribed to the thread got that status frame at 15:19:48.293Z (listener.jsonl). The hub sent it
// as "closed", the page's thread feed stops on a closed status with an error, and the bar stayed until a Retry. A dropped link now attaches
// the thread again and its pages read "reconnecting" meanwhile.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import type { ThreadEvent } from "../src/shared/types.ts";

const ID = "01a154b4-51ea-7166-ae5a-57c4936c2b80";
const ACTIVE = "90f690406554";

/** A Mac daemon behind its bridge socket: it answers attach and the reads after it, and `drop` ends every link as HostBridge.close does. */
async function macDaemon(socketPath: string, file: string, dir: string) {
  const state = { sessionId: ID, sessionFile: file, cwd: dir, model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, messageCount: 1, availableThinkingLevels: ["off"], sessionActions: { queuedCount: 0 } };
  const snapshot = { activeSessionId: ACTIVE, summary: { sessionId: ID, activeSessionId: ACTIVE, sessionFile: file, cwd: dir, messageCount: 1 }, state,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word pong" }], timestamp: 1 }],
    lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } };
  const links = new Set<Socket>();
  let attaches = 0;
  const serve = (socket: Socket) => {
    links.add(socket);
    socket.on("close", () => links.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30,
      serverCapabilities: [], appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; type: string; command?: { type: string } };
        buffer = buffer.slice(newline + 1);
        const type = (wire.type === "command" ? wire.command! : wire as { type: string }).type;
        if (type === "ack_result") continue;
        if (type === "attach") attaches++;
        const data = type === "attach" ? { activeSessionId: ACTIVE, snapshot, lastEventSequence: 1, lastEventCursor: { generation: "g1", sequence: 1 } }
          : type === "get_queue" ? { steering: [], followUp: [] } : type === "get_messages" ? { messages: [] } : type === "get_session_context" ? { context: { messages: [] } } : state;
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
      }
    });
  };
  let server: Server = createServer(serve);
  let reopen: NodeJS.Timeout | undefined;
  const listen = () => new Promise<void>(resolve => server.listen(socketPath, resolve));
  await listen();
  return {
    attaches: () => attaches,
    /** Ends every link and stops taking new ones for `gapMs`, as the old service's bridge close and the new service's start do. */
    async drop(gapMs: number) {
      for (const link of links) link.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      reopen = setTimeout(() => { server = createServer(serve); void listen(); }, gapMs);
    },
    /** A reopen still pending would listen after the test, and its socket kept the test file running for good. */
    close: () => { clearTimeout(reopen); for (const link of links) link.destroy(); if (server.listening) server.close(); },
  };
}

test("an open Mac thread whose bridge link drops attaches again and its page never reads closed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relink-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-19T15:07:45.000Z", cwd: dir }) + "\n");
  const socketPath = join(dir, "mac.sock");
  const mac = await macDaemon(socketPath, file, dir);
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 1 }),
    hostOf: () => "mac", socketPathFor: () => socketPath, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    refresh: async () => {}, forget: () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(async () => { await hub.close(); mac.close(); });

  const events: ThreadEvent[] = [];
  await hub.subscribe(ID, event => events.push(event));
  const thread = await hub.open(ID);
  assert.ok(thread.live, "the thread attached");
  assert.equal(mac.attaches(), 1);

  const dropped = Date.now();
  const before = events.length;
  await mac.drop(500);
  const connected = () => events.slice(before).some(event => event.type === "status" && event.connection === "connected");
  const resynced = () => events.slice(before).some(event => event.type === "snapshot");
  // The SDK tries again for 60 s after a dropped link (DAEMON_RECONNECT_TIMEOUT_MS in prime-agent 0.9.8).
  const deadline = Date.now() + 60_000;
  while (!(thread.live && mac.attaches() === 2 && connected() && resynced()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const back = Date.now() - dropped;
  const after = events.slice(before);
  process.stderr.write(`after the drop: ${after.map(event => event.type === "status" ? `status ${event.connection}` : event.type).join(", ")} in ${back} ms\n`);

  const statuses = after.filter(event => event.type === "status");
  assert.deepEqual(statuses.filter(event => event.connection === "closed"), [], "the page got no closed status, so its feed keeps listening");
  assert.ok(statuses.some(event => event.connection === "reconnecting"), "the page reads reconnecting while the link is down");
  assert.ok(thread.live, `the thread is attached again (${back} ms after the drop)`);
  assert.equal(mac.attaches(), 2, "the hub attached once more");
  assert.ok(connected(), "the page reads connected again");
  assert.ok(resynced(), "the page got the thread's snapshot again");
});

test("a service stop that closes the bridge before the hub leaves the page reconnecting, so it resubscribes to the next service", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relink-stop-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-19T15:07:45.000Z", cwd: dir }) + "\n");
  const socketPath = join(dir, "mac.sock");
  const mac = await macDaemon(socketPath, file, dir);
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: ACTIVE, workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 1 }),
    hostOf: () => "mac", socketPathFor: () => socketPath, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    refresh: async () => {}, forget: () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => mac.close());

  const events: ThreadEvent[] = [];
  await hub.subscribe(ID, event => events.push(event));
  assert.ok((await hub.open(ID)).live, "the thread attached");
  await mac.drop(60_000);
  await new Promise(resolve => setTimeout(resolve, 300));
  await hub.close();
  await new Promise(resolve => setTimeout(resolve, 2500));

  const statuses = events.filter(event => event.type === "status");
  assert.deepEqual(statuses.map(event => event.connection), ["reconnecting"], "the page read reconnecting and never closed");
  assert.equal(mac.attaches(), 1, "the stopped hub attached nothing more");
});
