import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chatBackend } from "../src/daemon-sdk.ts";
import { HostAgentConnection, HostClient, type HostConnectionEvent } from "../src/pi-host-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const piStack = resolve(here, "../../../packages");
const noHost = !existsSync(join(piStack, "node_modules/@earendil-works/pi-coding-agent/package.json")) ? "packages has no npm install" : false;

/** Every method chat-threads.ts calls on a connection, read from its source, so a new call fails here before it fails on pi-host. */
function calledConnectionMethods(): string[] {
  const names = new Set<string>();
  for (const file of ["chat-threads.ts", "chat-images.ts", "chat-projection.ts"]) {
    const text = readFileSync(join(here, "../src", file), "utf8");
    for (const match of text.matchAll(/connection\.([a-zA-Z]+)\(/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

test("SIEUN_CHAT_BACKEND picks Prime unless it says pi-host, and refuses any other value", () => {
  assert.equal(chatBackend({}), "prime");
  assert.equal(chatBackend({ SIEUN_CHAT_BACKEND: "prime" }), "prime");
  assert.equal(chatBackend({ SIEUN_CHAT_BACKEND: "pi-host" }), "pi-host");
  assert.throws(() => chatBackend({ SIEUN_CHAT_BACKEND: "pi" }), /use "prime" or "pi-host"/);
});

test("the pi-host connection has every method the chat calls on a connection", () => {
  const called = calledConnectionMethods();
  assert.ok(called.length > 15, `read ${called.length} methods`);
  const missing = called.filter(name => typeof (HostAgentConnection.prototype as unknown as Record<string, unknown>)[name] !== "function");
  assert.deepEqual(missing, []);
  for (const name of ["request", "waitForHello", "connect", "close", "onMessage", "onClose", "reconnect"]) {
    assert.equal(typeof (HostClient.prototype as unknown as Record<string, unknown>)[name], "function", name);
  }
});

test("against a real pi-host: attach streams the snapshot in chunks, events arrive in order, and a queued steer is edited", { skip: noHost }, async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-pi-host-"));
  mkdirSync(join(root, "ws"), { recursive: true });
  const socket = join(root, "host.sock");
  const host = spawn(process.execPath, ["--import", "tsx", "pi-host/src/main.ts", "--socket", socket, "--agent-dir", join(root, "agent"),
    "--session-dir", join(root, "sessions"), "--cwd", join(root, "ws"), "--extension", "pi-host/test/fixtures/echo.ts", "--model", "echo/m"], {
    cwd: piStack, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  host.stderr!.on("data", chunk => { log += chunk; });
  const clients: HostClient[] = [];
  const connect = async () => {
    const client = new HostClient(socket);
    clients.push(client);
    await client.connect(3000);
    await client.waitForHello(10_000);
    return client;
  };
  try {
    for (let i = 0; i < 200 && !existsSync(socket); i++) await new Promise(r => setTimeout(r, 100));
    const control = await connect();
    assert.equal(control.hello?.host, "pi-host");
    const created = await control.request({ type: "create", config: { cwd: join(root, "ws") } });
    assert.ok(created.success, JSON.stringify(created));
    const id = (created.data as { activeSessionId: string }).activeSessionId;
    for (let n = 0; n < 3; n++) {
      const sent = await control.request({ type: "prompt", activeSessionId: id, message: `warm ${n} ${"x".repeat(200)}` });
      assert.ok(sent.success);
      await control.request({ type: "wait_for_idle", activeSessionId: id }, 20_000);
    }

    const connection = await HostAgentConnection.attach(await connect(), id, { deferSessionEvents: true, closeClientOnDispose: true });
    const snapshot = await connection.getInitialSnapshot();
    assert.equal(snapshot.messages.filter(m => (m as { role: string }).role === "user").length, 3);
    const events: HostConnectionEvent[] = [];
    connection.subscribe(event => { events.push(event); });
    await connection.flushBufferedSessionEvents();

    await connection.prompt("slow one");
    await new Promise(r => setTimeout(r, 300));
    await connection.steer("first steer");
    const queue = await connection.getQueue();
    assert.deepEqual(queue.steering, ["first steer"]);
    assert.equal(await connection.mutateQueuedMessage("steering", 0, "first steer", { type: "replace", text: "edited steer" }), "applied");
    assert.deepEqual((await connection.getQueue()).steering, ["edited steer"]);
    await connection.waitForIdle();
    await new Promise(r => setTimeout(r, 300));
    const texts = events.flatMap(event => event.type === "session_event" && event.event.type === "message_end"
      ? [JSON.stringify((event.event.message as { content: unknown }).content)] : []);
    assert.ok(texts.some(text => text.includes("echo: slow one")), texts.join("\n"));
    assert.ok(texts.some(text => text.includes("edited steer")), texts.join("\n"));
    const ends = events.filter(event => event.type === "session_event" && event.event.type === "agent_end").length;
    assert.ok(ends >= 1);

    await connection.setSessionName("walk thread");
    assert.equal((await connection.getState()).sessionName, "walk thread");
    const catalog = await connection.getModelCatalog();
    assert.ok(catalog.models.some(model => model.provider === "echo"));
    const failed = await control.request({ type: "no_such_command", activeSessionId: id });
    assert.equal(failed.success, false);
    await connection.dispose();

    const closed: HostConnectionEvent[] = [];
    const watcher = await HostAgentConnection.attach(await connect(), id, {});
    watcher.subscribe(event => { closed.push(event); });
    await control.request({ type: "kill", activeSessionId: id });
    for (let i = 0; i < 50 && !closed.some(event => event.type === "closed"); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(closed.some(event => event.type === "closed"), JSON.stringify(closed));
    await watcher.dispose();
  } finally {
    for (const client of clients) client.close();
    host.kill("SIGTERM");
    await new Promise(r => host.once("exit", r));
    rmSync(root, { recursive: true, force: true });
    if (process.exitCode) process.stderr.write(log);
  }
});

test("a pi-host restart reattaches an open connection, with no closed event, as Prime's connection does after a daemon shutdown", { skip: noHost }, async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-pi-host-restart-"));
  mkdirSync(join(root, "ws"), { recursive: true });
  const socket = join(root, "host.sock");
  const start = () => spawn(process.execPath, ["--import", "tsx", "pi-host/src/main.ts", "--socket", socket, "--agent-dir", join(root, "agent"),
    "--session-dir", join(root, "sessions"), "--cwd", join(root, "ws"), "--no-default-extensions", "--extension", "pi-host/test/fixtures/echo.ts", "--model", "echo/m"], {
    cwd: piStack, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: "ignore",
  });
  const up = async () => { for (let i = 0; i < 200 && !existsSync(socket); i++) await new Promise(r => setTimeout(r, 100)); };
  let host = start();
  const clients: HostClient[] = [];
  const connect = async () => { const client = new HostClient(socket); clients.push(client); await client.connect(3000); await client.waitForHello(10_000); return client; };
  try {
    await up();
    const control = await connect();
    const created = await control.request({ type: "create", config: { cwd: join(root, "ws") } });
    assert.ok(created.success);
    const id = (created.data as { activeSessionId: string }).activeSessionId;
    await control.request({ type: "prompt", activeSessionId: id, message: "before the restart" });
    await control.request({ type: "wait_for_idle", activeSessionId: id }, 20_000);
    const events: HostConnectionEvent[] = [];
    const connection = await HostAgentConnection.attach(await connect(), id, { closeClientOnDispose: true });
    connection.subscribe(event => { events.push(event); });
    host.kill("SIGTERM");
    await new Promise(r => host.once("exit", r));
    host = start();
    await up();
    for (let i = 0; i < 200 && !events.some(event => event.type === "connection_status" && event.status === "connected"); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(events.some(event => event.type === "connection_status" && event.status === "connected"), JSON.stringify(events));
    assert.ok(!events.some(event => event.type === "closed"), JSON.stringify(events));
    assert.ok(events.some(event => event.type === "session_resynced"));
    const snapshot = await connection.getInitialSnapshot();
    assert.ok(JSON.stringify(snapshot.messages).includes("before the restart"));
    await connection.dispose();
  } finally {
    for (const client of clients) client.close();
    host.kill("SIGTERM");
    await new Promise(r => host.once("exit", r));
    rmSync(root, { recursive: true, force: true });
  }
});
