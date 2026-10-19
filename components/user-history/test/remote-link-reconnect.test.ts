// Guards the 10-19 red bar: after the 15:19:50Z chat restart an open Mac thread showed "Lost connection to the Prime Agent daemon" for 7
// minutes and more, because a dropped link to another box ended the thread's feed instead of reconnecting it.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DaemonAgentConnection, DaemonClient } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { attachClients, disposeConnection, ThreadHub } from "../src/chat-threads.ts";

test("an attach to another box's session reconnects when its link drops, and this box's does not", async t => {
  const dir = await mkdtemp(join(tmpdir(), "remote-reconnect-"));
  const ids = { mac: "01a11ba8-0000-7000-8000-000000000001", box: "01a11ba8-0000-7000-8000-000000000002" };
  for (const id of Object.values(ids)) await writeFile(join(dir, id + ".jsonl"), JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-19T15:00:00.000Z", cwd: dir }) + "\n");
  t.mock.method(DaemonClient.prototype, "connect", async () => {});
  t.mock.method(DaemonClient.prototype, "waitForHello", async () => ({}));
  const recovers = new Map<string, boolean>();
  t.mock.method(DaemonAgentConnection, "attach", async (_client: unknown, activeSessionId: string, options: { recoverDaemon?: unknown }) => {
    recovers.set(activeSessionId, typeof options.recoverDaemon === "function");
    throw new Error("Unknown active session: " + activeSessionId);
  });
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: id === ids.mac ? "mac-worker" : "box-worker", workerState: "ready",
    sessionFile: join(dir, id + ".jsonl"), cwd: dir, lifecycle: "live", messageCount: 0 }),
    hostOf: (id: string) => id === ids.mac || id === "mac-worker" ? "mac" : null, localFile: async (summary: { sessionFile: string }) => summary.sessionFile,
    socketPathFor: () => join(dir, "mac.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "daemon.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await hub.open(ids.mac);
  await hub.open(ids.box);
  assert.equal(recovers.get("mac-worker"), true);
  assert.equal(recovers.get("box-worker"), false);
});

/** A daemon socket that answers hello, attach and the resync reads, and drops the first connection after its attach. */
async function droppingDaemon(path: string) {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    const nth = ++connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, clientId: "c", serverCapabilities: [] }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { id: string; command: { type: string } };
        buffer = buffer.slice(end + 1);
        const type = line.command.type;
        const data = type === "attach" ? { sessionId: "s", activeSessionId: "mac-worker", sessionFile: "/x.jsonl", cwd: "/", lifecycle: "live", messageCount: 0 }
          : type === "get_messages" ? { messages: [] } : type === "get_session_context" ? { context: { messages: [], thinkingLevel: "off", model: null } }
          : type === "get_connection_state" ? { sessionId: "s", isStreaming: false, messageCount: 0 } : {};
        socket.write(JSON.stringify({ type: "response", id: line.id, command: type, success: true, data }) + "\n");
        if (type === "attach" && nth === 1) setTimeout(() => socket.destroy(), 20);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return { connections: () => connections, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

for (const recover of [true, false]) {
  test(`a dropped link ${recover ? "reconnects and resyncs with recoverDaemon" : "ends the connection without it"}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "remote-drop-"));
    const daemon = await droppingDaemon(join(dir, "mac.sock"));
    const client = new DaemonClient(join(dir, "mac.sock"));
    await client.connect(3000);
    await client.waitForHello(3000);
    const connection = await DaemonAgentConnection.attach(client, "mac-worker", { directTransport: false, supportsExtensionUi: false, closeClientOnDispose: true,
      ...(recover ? { recoverDaemon: async () => {} } : {}) });
    attachClients.set(connection, client);
    const seen: string[] = [];
    const settled = new Promise<void>(resolve => connection.subscribe(event => {
      seen.push(event.type === "connection_status" ? `status ${event.status}` : event.type);
      if (event.type === "closed" || (event.type === "connection_status" && event.status === "connected")) resolve();
    }));
    await settled;
    if (recover) {
      assert.deepEqual(seen, ["status reconnecting", "session_resynced", "status connected"]);
      assert.equal(daemon.connections(), 2);
    } else assert.deepEqual(seen, ["closed"]);
    daemon.close();
    await disposeConnection(connection);
  });
}

test("a dispose while another box's link is down ends, though recoverDaemon keeps the detach for a reconnect that never comes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remote-dispose-"));
  const daemon = await droppingDaemon(join(dir, "mac.sock"));
  const client = new DaemonClient(join(dir, "mac.sock"));
  await client.connect(3000);
  await client.waitForHello(3000);
  const connection = await DaemonAgentConnection.attach(client, "mac-worker", { directTransport: false, supportsExtensionUi: false, closeClientOnDispose: true, recoverDaemon: async () => {} });
  attachClients.set(connection, client);
  await new Promise<void>(resolve => connection.subscribe(event => { if (event.type === "connection_status" && event.status === "connected") resolve(); }));
  daemon.close();
  const started = performance.now();
  await Promise.race([disposeConnection(connection), new Promise((_, reject) => setTimeout(() => reject(new Error("the dispose still waits after 10 s")), 10_000))]);
  assert.ok(performance.now() - started < 10_000);
});
