// Guards the 10-18 scratch serve incident on us-metal02: at about 12:17:3xZ a --scratch serve on port 45102 (a copy of browser-chat, the live
// daemon socket) logged "chat 01a14d31: extension reloaded, build 101b49b4a1eb5663", which rebuilt the live chat's Python kernel and lost its
// REPL state. The copy's own-chats.json named 01a14d31, an open tab made the serve attach it, and the attach ran the build-change reload. A
// scratch serve now sends the daemon only reads (no attach, reload, restart or setting), and it refuses the live socket without --live-reads-only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";

const cli = fileURLToPath(new URL("../src/chat-service-cli.mjs", import.meta.url));
/** The daemon commands that only read: the session list, its roster stream, the heartbeat list and a session's state. No attach. */
const READS = new Set(["list", "roster_subscribe", "cron_list", "get_queue", "get_connection_state", "get_messages", "get_session_context", "get_state"]);
const CAPABILITIES = ["abort_and_send_queued", "acp_mcp_servers", "agent_roster", "authoritative_child_roster", "client_owned_sessions", "delete_rlm_subagent",
  "heartbeat_catalog", "heartbeat_management", "model_catalog", "owned_prompt_cancellation", "owned_session_recovery_context", "prompt_admission_cancellation",
  "queue_message_mutation", "rlm_quiescence_barrier", "session_input_admission", "session_input_pause"];
const CHAT = "01a14d31-0000-7000-8000-000000000001";

const freePort = () => new Promise<number>(resolve => {
  const server = createHttpServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

/** A copy of browser-chat whose own-chats.json names a resident chat that last loaded an older extension build, and its session file. */
function copiedDataDir(dir: string, socketPath: string, port: number) {
  const home = join(dir, "home"), data = join(dir, "data");
  mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
  const sessionFile = join(home, ".prime/agent/sessions", `${CHAT}.jsonl`);
  const now = new Date().toISOString();
  writeFileSync(sessionFile, [{ type: "session", version: 3, id: CHAT, timestamp: now, cwd: dir },
    { type: "message", id: "m1", parentId: null, timestamp: now, message: { role: "user", content: "scratch copy hello", timestamp: Date.now() } }]
    .map(line => JSON.stringify(line)).join("\n") + "\n");
  const row = { sessionId: CHAT, activeSessionId: "d31active", cwd: dir, sessionFile, messageCount: 1, name: "copied live chat", modified: now, workerState: "ready" };
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const secret = () => randomBytes(32).toString("hex");
  writeFileSync(join(data, "configuration.json"), JSON.stringify({ port, socketPath, capability: secret(), csrfToken: secret(), stopToken: secret(), publicOrigin: null, remoteAccess: "off", keepRunning: false, openAppAtLogin: false }), { mode: 0o600 });
  writeFileSync(join(data, "chats.json"), JSON.stringify({ ids: [CHAT] }));
  writeFileSync(join(data, "own-chats.json"), JSON.stringify({ ids: [CHAT] }));
  writeFileSync(join(data, "extension-loads.json"), JSON.stringify({ builds: { [CHAT]: "0000000000000000" }, briefs: {}, texts: {} }));
  return { home, data, row };
}

/** A daemon that answers every command with success, attach with a live snapshot, and records each command and connection. */
async function fakeDaemon(t: TestContext, socketPath: string, rows: unknown[]) {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createNetServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, schemaRevision: 30,
      serverCapabilities: CAPABILITIES, appVersion: "0.9.8" }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let wire: Record<string, unknown>;
        try { wire = JSON.parse(line); } catch { continue; }
        const command = (wire.type === "command" ? wire.command : wire) as Record<string, unknown>;
        const type = String(command.type);
        if (type === "ack_result") continue;
        commands.push(type);
        const summary = rows[0] as { activeSessionId: string; sessionFile: string };
        const state = { isStreaming: false, isCompacting: false, isBashRunning: false, isSessionActive: false, messageCount: 0, pendingMessageCount: 0,
          availableThinkingLevels: ["off", "high"], thinkingLevel: "high", steeringMode: "all", followUpMode: "all", sessionId: CHAT, sessionFile: summary.sessionFile, autoCompactionEnabled: true,
          cwd: "/", retryAttempt: 0, contextUsage: null, sessionActions: { active: null, queuedCount: 0, steering: [], followUps: [] } };
        const data = type === "list" ? { sessions: rows } : type === "cron_list" ? { jobs: [] } : type === "get_messages" ? { messages: [] } : type === "get_queue" ? { steering: [], followUp: [] }
          : type === "attach" ? { protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION }, activeSessionId: summary.activeSessionId,
            snapshot: { activeSessionId: summary.activeSessionId, summary, state, messages: [], lastEventSequence: 0 },
            replay: { status: "complete", toSequence: 0 }, lastEventSequence: 0, client: { id: "fake", capabilities: [] } }
          : type === "get_state" ? state : {};
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { commands, connections: () => connections };
}

function startServe(t: TestContext, args: string[], home: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SIEUN_PI_CHAT_START_DAEMON: "0", SIEUN_PI_CHAT_OPEN_AT_LOGIN: "0", SIEUN_PI_SLACK: "0", ...extraEnv };
  for (const name of ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES", "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"]) delete env[name];
  const child = spawn(process.execPath, [cli, "serve", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const out = { log: "" };
  child.stdout.on("data", chunk => { out.log += chunk; });
  child.stderr.on("data", chunk => { out.log += chunk; });
  t.after(() => { child.kill("SIGKILL"); });
  return { child, out };
}

async function waitListening(serve: ReturnType<typeof startServe>, port: number) {
  for (let waited = 0; !serve.out.log.includes(`http://127.0.0.1:${port}/`); waited += 200) {
    assert.ok(waited < 60_000 && serve.child.exitCode === null, `the serve did not start:\n${serve.out.log}`);
    await delay(200);
  }
}

/** Opens the chat's thread and the sessions feed over the socket, as the page's boot script does, and keeps the tab open for `ms`. */
async function openTab(t: TestContext, data: string, port: number, ms: number): Promise<string[]> {
  const config = JSON.parse(readFileSync(join(data, "configuration.json"), "utf8")) as { capability: string; csrfToken: string };
  const subs = JSON.stringify([{ sub: 1, feed: "thread", id: CHAT }, { sub: 2, feed: "sessions", delta: true }]);
  const page = new WebSocket(`ws://127.0.0.1:${port}/${config.capability}/api/ws?token=${config.csrfToken}&subs=${encodeURIComponent(subs)}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const frames: string[] = [];
  page.on("message", frame => { frames.push(String(frame)); });
  page.on("error", () => {});
  t.after(() => page.terminate());
  await delay(ms);
  page.close();
  return frames;
}

test("a scratch serve that opens its own chat on an older build sends no attach, reload or other session command", { timeout: 90_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "scratch-chat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "daemon.sock"), port = await freePort();
  const { home, data, row } = copiedDataDir(dir, socketPath, port);
  const daemon = await fakeDaemon(t, socketPath, [row]);
  const serve = startServe(t, ["--data-dir", data, "--port", String(port), "--socket", socketPath, "--scratch"], home);
  await waitListening(serve, port);
  const frames = await openTab(t, data, port, 10_000);
  serve.child.kill("SIGTERM");
  await new Promise(resolve => serve.child.once("exit", resolve));
  assert.ok(frames.some(frame => frame.includes("scratch copy hello")), `the tab got the chat's messages from its session file:\n${serve.out.log}`);
  assert.ok(daemon.commands.includes("list"), `the serve read the fake daemon's list:\n${serve.out.log}`);
  assert.deepEqual(daemon.commands.filter(type => !READS.has(type)), [], `the scratch serve acted on the chat:\n${serve.out.log}`);
  assert.doesNotMatch(serve.out.log, /extension reloaded/);
});

test("a scratch serve refuses the live daemon socket, and with --live-reads-only it only reads", { timeout: 90_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "scratch-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The live socket is the default one, under TMPDIR: /tmp/prime-agent-<uid>/daemon.sock on the box.
  const tmp = join(dir, "tmp"), liveDir = join(tmp, `prime-agent-${process.getuid?.() ?? "user"}`), live = join(liveDir, "daemon.sock");
  mkdirSync(liveDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const { home, data, row } = copiedDataDir(dir, live, port);
  const daemon = await fakeDaemon(t, live, [row]);
  const args = ["--data-dir", data, "--port", String(port), "--socket", live, "--scratch"];

  const refused = startServe(t, args, home, { TMPDIR: tmp });
  const code = await Promise.race([new Promise<number | null>(resolve => refused.child.once("exit", resolve)), delay(30_000, "still running")]);
  assert.notEqual(code, 0, `the serve started on the live socket:\n${refused.out.log}`);
  assert.match(refused.out.log, /live daemon socket/);
  assert.equal(daemon.connections(), 0, "the refused serve connected to the live daemon");

  const reader = startServe(t, [...args, "--live-reads-only"], home, { TMPDIR: tmp });
  await waitListening(reader, port);
  const frames = await openTab(t, data, port, 6_000);
  reader.child.kill("SIGTERM");
  await new Promise(resolve => reader.child.once("exit", resolve));
  assert.ok(frames.some(frame => frame.includes("scratch copy hello")), `the tab got the chat:\n${reader.out.log}`);
  assert.ok(daemon.commands.includes("list"), `the serve read the live daemon's list:\n${reader.out.log}`);
  assert.deepEqual(daemon.commands.filter(type => !READS.has(type)), [], `the serve acted on a live session:\n${reader.out.log}`);
});
