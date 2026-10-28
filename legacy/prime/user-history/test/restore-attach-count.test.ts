// Replays the load.3.3 update restart on us-metal02 on 10-28 (10:21:50Z to 10:22:48Z). Each attached thread's restore listed and attached
// every 0.2 s: about 1,400 lists and 418 attaches refused with "Session worker is starting", 46 to 67 for each of 7 sessions. Prime's own
// restore now answers a refused attach with one held get_state (load.3.8, Prime 94ae270). These tests run the SDK the chat loads, attached
// through the chat's own attach, against a fake supervisor on a real socket, so an SDK that goes back to polling fails here.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonAgentConnection } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { disposeConnection, ThreadHub } from "../src/chat-threads.ts";

const STARTING = "Session worker is starting";
type Line = { id: string; command: { type: string; activeSessionId?: string } };
type Counts = { attach: number; refused: number; getState: number; frames: number };

/**
 * A supervisor for `size` sessions. `restart(downMs)` closes every client with daemon_closing "update", stays down for `downMs`, then
 * comes back with new active ids. Session i's worker runs `readyMs(i)` after the restart: until then an attach is refused with
 * "Session worker is starting" and a get_state is held until the worker runs, as the real supervisor answered at 10:22:44Z and 10:22:46Z.
 */
async function supervisor(path: string, size: number, readyMs: (session: number) => number) {
  let generation = 0;
  let restartedAt = 0;
  let server: Server | null = null;
  let lists = 0;
  let connections = 0;
  const sockets = new Set<Socket>();
  const counts: Counts[] = Array.from({ length: size }, () => ({ attach: 0, refused: 0, getState: 0, frames: 0 }));
  const held = new Map<number, Socket>();
  const activeId = (session: number) => `${generation === 0 ? "old" : "new"}-${session}`;
  const sessionOf = (id: string | undefined) => (id ? Number(/^(?:old|new)-(\d+)$/.exec(id)?.[1] ?? NaN) : NaN);
  const ready = (session: number) => generation === 0 || Date.now() - restartedAt >= readyMs(session);
  const summary = (session: number) => ({ sessionId: `s-${session}`, activeSessionId: activeId(session), sessionFile: `/s-${session}.jsonl`, cwd: "/", lifecycle: "live", messageCount: 0 });
  const reply = (socket: Socket, line: Line, answer: { data?: unknown; error?: string }) => {
    if (socket.destroyed) return;
    socket.write(JSON.stringify({ type: "response", id: line.id, command: line.command.type, success: answer.error === undefined, ...answer }) + "\n");
  };
  const answer = (socket: Socket, line: Line) => {
    const type = line.command.type;
    if (type === "list") { lists++; return reply(socket, line, { data: { sessions: Array.from({ length: size }, (_, i) => summary(i)) } }); }
    const session = sessionOf(line.command.activeSessionId);
    if (Number.isInteger(session)) counts[session]!.frames++;
    if (type === "attach") {
      counts[session]!.attach++;
      if (!ready(session)) { counts[session]!.refused++; return reply(socket, line, { error: STARTING }); }
      return reply(socket, line, { data: summary(session) });
    }
    if (type === "get_state") {
      counts[session]!.getState++;
      if (ready(session)) return reply(socket, line, { data: {} });
      held.set(session, socket);
      const timer = setTimeout(() => { held.delete(session); reply(socket, line, { data: {} }); }, readyMs(session) - (Date.now() - restartedAt));
      socket.once("close", () => { clearTimeout(timer); held.delete(session); });
      return;
    }
    const data = type === "get_messages" ? { messages: [] } : type === "get_session_context" ? { context: { messages: [], thinkingLevel: "off", model: null } }
      : type === "get_connection_state" ? { sessionId: `s-${session}`, isStreaming: false, messageCount: 0 } : {};
    return reply(socket, line, { data });
  };
  const listen = () => new Promise<void>(resolve => {
    server = createServer(socket => {
      connections++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, schemaRevision: 30, clientId: `c${connections}`, serverCapabilities: [] }) + "\n");
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = JSON.parse(buffer.slice(0, end)) as Line;
          buffer = buffer.slice(end + 1);
          answer(socket, line);
        }
      });
    }).listen(path, resolve);
  });
  const stop = () => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    if (server) server.close(() => resolve()); else resolve();
    server = null;
  });
  await listen();
  return {
    counts, held, lists: () => lists, connections: () => connections, close: stop,
    async restart(downMs: number) {
      for (const socket of sockets) socket.end(JSON.stringify({ type: "daemon_closing", reason: "update" }) + "\n");
      await stop();
      await new Promise(resolve => setTimeout(resolve, downMs));
      generation = 1;
      restartedAt = Date.now();
      lists = 0;
      for (const count of counts) Object.assign(count, { attach: 0, refused: 0, getState: 0, frames: 0 });
      await listen();
    },
  };
}

/** Attaches every session through ThreadHub's own attach, so the client options are the ones the live chat uses. */
async function attachAll(path: string, size: number) {
  const hub = new ThreadHub(path, {} as Catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const attach = Reflect.get(hub, "attach") as (activeSessionId: string, host: string | null) => Promise<DaemonAgentConnection>;
  const connections: DaemonAgentConnection[] = [];
  for (let i = 0; i < size; i++) connections.push(await attach.call(hub, `old-${i}`, null));
  const connected = connections.map(connection => new Promise<void>(resolve => connection.subscribe(event => {
    if (event.type === "connection_status" && event.status === "connected") resolve();
  })));
  return { hub, connections, connected };
}

const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms))]);

test("a restart whose 7 workers start over 0.4 to 2.2 s costs each session at most one refused attach", async t => {
  const dir = await mkdtemp(join(tmpdir(), "restore-attach-"));
  const path = join(dir, "daemon.sock");
  const daemon = await supervisor(path, 7, i => 400 + 300 * i);
  const { hub, connections, connected } = await attachAll(path, 7);
  t.after(async () => { await Promise.all(connections.map(disposeConnection)); hub.close(); await daemon.close(); });
  await daemon.restart(500);
  await within(Promise.all(connected), 30_000, "reconnecting all 7 sessions");
  // Prime SDK 0.9.8 made 4 to 22 refused attaches per session here, one every 100 ms until its worker ran.
  for (const [i, count] of daemon.counts.entries()) assert.ok(count.refused <= 1, `session ${i}: ${count.refused} refused attaches, ${count.getState} get_state`);
  if (process.env.RESTORE_COUNTS) console.log(JSON.stringify({ lists: daemon.lists(), counts: daemon.counts }));
  assert.ok(daemon.lists() <= 2 * 7, `${daemon.lists()} list calls for 7 sessions`);
});

test("a dispose during a held get_state closes the chat's own client at once, and the restore sends nothing after it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "restore-dispose-"));
  const path = join(dir, "daemon.sock");
  const daemon = await supervisor(path, 2, i => (i === 0 ? 300 : 600_000));
  const { hub, connections, connected } = await attachAll(path, 2);
  t.after(async () => { await Promise.all(connections.map(disposeConnection)); hub.close(); await daemon.close(); });
  await daemon.restart(200);
  await within(connected[0]!, 30_000, "reconnecting session 0");
  await within((async () => { while (!daemon.held.has(1)) await new Promise(resolve => setTimeout(resolve, 20)); })(), 10_000, "session 1's held get_state");
  const socket = daemon.held.get(1)!;
  const started = performance.now();
  await within(disposeConnection(connections[1]!), 2_000, "the dispose");
  await within(new Promise(resolve => (socket.destroyed ? resolve(null) : socket.once("close", resolve))), 1_000, "the client's socket closing");
  const frames = daemon.counts[1]!.frames;
  const opened = daemon.connections();
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.equal(daemon.counts[1]!.frames, frames, "the disposed connection sent more frames");
  assert.equal(daemon.connections(), opened, "the disposed connection opened another socket");
  assert.equal(daemon.counts[1]!.refused, 1);
  assert.ok(performance.now() - started < 4_000);
});
