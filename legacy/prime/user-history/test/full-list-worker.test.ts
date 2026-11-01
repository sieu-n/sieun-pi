// Guards the 11-01 06:24Z fix: this box's full list (8,530 rows, 65 MB) was read and parsed on the chat's main thread, which held its event
// loop 777 ms and a major GC 814 ms more, so the full list now runs in a worker thread (src/full-list.ts).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { fullListInWorker } from "../src/full-list.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const HELLO = `${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, appVersion: "fixture", serverCapabilities: ["agent_roster"] })}\n`;

/** A daemon that answers `list` with `answer` and records each command it got. */
async function daemon(t: TestContext, answer: (all: boolean) => object): Promise<{ path: string; lists: boolean[] }> {
  const dir = await mkdtemp(join(tmpdir(), "full-list-worker-"));
  const path = join(dir, "daemon.sock");
  const lists: boolean[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(HELLO);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { id: string; type: string; command?: { type: string; all?: boolean } };
        buffer = buffer.slice(end + 1);
        const command = line.command ?? line;
        if (command.type === "ack_result") continue;
        if (command.type !== "list") { socket.write(`${JSON.stringify({ type: "response", id: line.id, command: command.type, success: true, data: { sessions: [] } })}\n`); continue; }
        lists.push((command as { all?: boolean }).all === true);
        socket.write(`${JSON.stringify({ type: "response", id: line.id, command: "list", ...answer((command as { all?: boolean }).all === true) })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, lists };
}

const row = (n: number) => ({ sessionId: `s${n}`, cwd: "/w", name: `session ${n}`, text: "x".repeat(200) });

test("the worker lists every session in order, in batches, on a link of its own", async (t: TestContext) => {
  const rows = Array.from({ length: 1234 }, (_, n) => row(n));
  const box = await daemon(t, () => ({ success: true, data: { sessions: rows } }));
  const listed = await fullListInWorker(box.path, { socketMs: 5000, helloMs: 5000 }, 100);
  assert.deepEqual(listed.sessions, rows);
  assert.deepEqual(box.lists, [true]);
});

test("a refused list rejects with the daemon's error", async (t: TestContext) => {
  const box = await daemon(t, () => ({ success: false, error: "catalog busy" }));
  await assert.rejects(fullListInWorker(box.path, { socketMs: 5000, helloMs: 5000 }), /catalog busy/);
});

test("a daemon that is not there rejects instead of hanging", async () => {
  await assert.rejects(fullListInWorker(join(tmpdir(), "no-such-daemon.sock"), { socketMs: 500, helloMs: 500 }), /connect/i);
});

test("the catalog's full list of this box runs in the worker, not on its main link", async (t: TestContext) => {
  const rows = Array.from({ length: 50 }, (_, n) => row(n));
  const box = await daemon(t, all => ({ success: true, data: { sessions: all ? rows : [] } }));
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog(box.path, reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  catalog.listsInWorker = true;
  t.after(() => catalog.close());
  const onMainLink: unknown[] = [];
  const request = catalog.client.request.bind(catalog.client);
  t.mock.method(catalog.client, "request", (...args: Parameters<typeof request>) => { onMainLink.push(args[0]); return request(...args); });
  await catalog.connect();
  assert.equal((await catalog.summary("s49"))?.sessionId, "s49");
  assert.ok(box.lists.includes(true), "the daemon got a full list");
  assert.ok(!onMainLink.some(command => (command as { all?: boolean }).all === true), "no full list went over the main link");
});
