// Guards the 10-18 scratch serve incident on us-metal02: a CPU profile serve on port 44357 with a copy of browser-chat (not the live data dir,
// own chats only) ran the live service's loops against the live daemon from 08:25:10Z to 08:25:47Z. It woke 01a14dd7-ef9a and 01a14dd7-fa29,
// reopened 01a1180e to relay a wake for 01a14dbf, relayed one through 01a14dcf, timed out on 3 more sends, and ran pi-pool priority on
// 01a14d7d and 01a115e2. A serve outside the live data dir, or with --scratch, now only reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import { CHECK_IN_TICK_MS } from "../src/chats.ts";
import { DUTY_TICK_MS } from "../src/chat-duty-run.ts";
import { ARCHIVE_TICK_MS } from "../src/chat-archive-queue.ts";
import { TICK_MS as WAKE_TICK_MS } from "../src/wakes.ts";

const cli = fileURLToPath(new URL("../src/chat-service-cli.mjs", import.meta.url));
/** The daemon commands a serve may send while it only reads: the session list, its roster stream, the heartbeat list and a session's state. No attach (scratch-serve-live-chat.test.ts). */
const READS = new Set(["list", "roster_subscribe", "cron_list", "get_queue", "get_connection_state", "get_messages", "get_session_context", "get_state"]);
/** The pi-pool commands that only read the pool. */
const POOL_READS = new Set(["snapshot", "queue", "ls", "who", "config", "resolve"]);
const CAPABILITIES = ["abort_and_send_queued", "acp_mcp_servers", "agent_roster", "authoritative_child_roster", "client_owned_sessions", "delete_rlm_subagent",
  "heartbeat_catalog", "heartbeat_management", "model_catalog", "owned_prompt_cancellation", "owned_session_recovery_context", "prompt_admission_cancellation",
  "queue_message_mutation", "rlm_quiescence_barrier", "session_input_admission", "session_input_pause"];

const freePort = () => new Promise<number>(resolve => {
  const server = createHttpServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

test("a serve outside the live data dir sends no wake, prompt, reopen or pool write to the daemon over every tick", { timeout: 110_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "scratch-serve-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), data = join(dir, "data"), socketPath = join(dir, "daemon.sock"), poolLog = join(dir, "pool.log");
  const chat = "01a1face-0000-7000-8000-000000000001", job = "01a1face-0000-7000-8000-000000000002";
  mkdirSync(join(home, ".prime/agent/sessions"), { recursive: true });
  const sessionFile = (id: string) => join(home, ".prime/agent/sessions", `${id}.jsonl`);
  for (const id of [chat, job]) writeFileSync(sessionFile(id), JSON.stringify({ type: "session", id, timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  const row = (id: string, parent?: string) => ({ sessionId: id, activeSessionId: `${id.slice(-4)}active`, cwd: dir, sessionFile: sessionFile(id), messageCount: 1,
    name: id === chat ? "scratch test chat" : "scratch test job", modified: new Date().toISOString(), ...(parent ? { parentSessionId: parent } : {}) });
  const rows = [row(chat), row(job, chat)];

  // The fake daemon answers every command with success and records it.
  const commands: { type: string; target?: string }[] = [];
  const sockets = new Set<Socket>();
  const daemon = createNetServer(socket => {
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
        const target = command.targetActiveSessionId ?? command.activeSessionId ?? command.sessionId;
        commands.push({ type, ...(typeof target === "string" ? { target } : {}) });
        const data = type === "list" ? { sessions: rows } : type === "cron_list" ? { jobs: [] } : type === "get_messages" ? { messages: [] } : {};
        socket.write(JSON.stringify({ type: "response", id: wire.id, command: type, success: true, data }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); daemon.close(); });

  const pool = join(dir, "pi-pool"), snapshot = join(dir, "snapshot.json");
  const queue = { enabled: true, working: [], queued: [{ session: `duty:${chat}:checkin`, tree: chat, class: "low", since: 1, position: 1, total: 1, wait_s: 0 }], working_max: 4, tree_working_max: 2 };
  writeFileSync(snapshot, JSON.stringify({ queue: { code: 0, out: JSON.stringify(queue) + "\n", err: "" }, config: { code: 0, out: "{}\n", err: "" }, threads: [] }) + "\n");
  writeFileSync(pool, `#!/bin/sh\necho "$@" >> ${JSON.stringify(poolLog)}\n` +
    `case "$1" in snapshot) cat ${JSON.stringify(snapshot)};; queue) echo '${JSON.stringify(queue)}';; *) echo '{}';; esac\n`, { mode: 0o755 });

  // A copy of the live data dir: a due wake, a queued duty archive, and a chat with a priority label.
  const port = await freePort();
  const secret = () => randomBytes(32).toString("hex");
  mkdirSync(join(data, "wakes"), { recursive: true, mode: 0o700 });
  writeFileSync(join(data, "configuration.json"), JSON.stringify({ port, socketPath, capability: secret(), csrfToken: secret(), stopToken: secret(), publicOrigin: null, remoteAccess: "off", keepRunning: false, openAppAtLogin: false }), { mode: 0o600 });
  writeFileSync(join(data, "wakes", "w1.json"), JSON.stringify({ session: job, root: chat, on: { kind: "time", at: Date.now() - 60_000 }, note: "copied wake", since: Date.now() - 120_000 }));
  writeFileSync(join(data, "duty-archive-queue.json"), JSON.stringify([{ id: job, name: "copied duty job", queuedAt: 1, tries: 0, nextAt: 1 }]));
  writeFileSync(join(data, "chats.json"), JSON.stringify({ ids: [chat] }));
  writeFileSync(join(data, "labels.json"), JSON.stringify({ tags: [], threads: { [chat]: { priority: 2 } } }));

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_POOL_BIN: pool, SIEUN_PI_CHAT_START_DAEMON: "0", SIEUN_PI_CHAT_OPEN_AT_LOGIN: "0", SIEUN_PI_SLACK: "0" };
  for (const name of ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES", "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"]) delete env[name];
  const child = spawn(process.execPath, [cli, "serve", "--data-dir", data, "--port", String(port), "--socket", socketPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  t.after(() => { child.kill("SIGKILL"); });
  for (let waited = 0; !log.includes(`http://127.0.0.1:${port}/`); waited += 200) {
    assert.ok(waited < 60_000 && child.exitCode === null, `the serve did not start:\n${log}`);
    await delay(200);
  }
  // A profile drives the page: the sessions feed and the chat's thread, as the boot script opens them.
  const config = JSON.parse(readFileSync(join(data, "configuration.json"), "utf8")) as { capability: string; csrfToken: string };
  const subs = JSON.stringify([{ sub: 1, feed: "thread", id: chat }, { sub: 2, feed: "sessions", delta: true }]);
  const page = new WebSocket(`ws://127.0.0.1:${port}/${config.capability}/api/ws?token=${config.csrfToken}&subs=${encodeURIComponent(subs)}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const frames: string[] = [];
  page.on("message", data => { frames.push(String(data)); });
  page.on("error", () => {});
  t.after(() => page.terminate());
  // Every loop ticks at least once: the wakes and the brief keeper at start, then the duties, the check-ins and the archive queue each 30 s.
  await delay(Math.max(CHECK_IN_TICK_MS, DUTY_TICK_MS, ARCHIVE_TICK_MS, WAKE_TICK_MS) + 5_000);
  page.close();
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  assert.ok(frames.some(frame => frame.includes(chat)), "the page got the chat from the scratch serve");

  assert.ok(commands.some(command => command.type === "list"), `the serve read the fake daemon's list:\n${log}`);
  const poolCalls = (() => { try { return readFileSync(poolLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } })();
  assert.deepEqual({ daemon: commands.filter(command => !READS.has(command.type)), pool: poolCalls.filter(line => !POOL_READS.has(line.split(" ")[0]!)) },
    { daemon: [], pool: [] }, `the scratch serve acted on sessions or the pool:\n${log}`);
  assert.match(log, /scratch serve: it only reads/);
});
