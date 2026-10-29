// The agent relay against a fake chat server and a real pi-host child with a faux model: hello and welcome, a delivery with a requestId, a link
// dropped mid-delivery and the same requestId sent again (pi-host keeps it once), watch events, feed rows from the server's cursor after a
// reconnect, file ops held to agentsDir, the check op, the chat proxy's 503 and pass-through, the v1 routes, and a pi-host stop closing the link.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createAgentRelay } from "../agents/main.ts";
import { loadAgentConfig } from "../agents/config.ts";
import { PiHostSocket } from "../agents/pi-host-socket.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "../../../packages");
const dir = mkdtempSync(join(tmpdir(), "agent-relay-"));
const socket = join(dir, "host.sock");
const agentsDir = join(dir, "agents");
const TOKEN = "t".repeat(40);
const noop = () => {};
let worker;
let relay;
let base;
let proxyBase;

const port = server => server.address().port;
const listen = (server, at) => new Promise(resolve => server.listen(0, at, resolve));

before(async () => {
  mkdirSync(agentsDir, { recursive: true });
  worker = spawn(process.execPath, ["--import", "tsx", join(here, "pi-host-worker.ts"), socket, dir], { cwd: packages, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    createInterface({ input: worker.stdout }).on("line", line => { if (JSON.parse(line).event === "ready") resolve(); });
    worker.once("exit", code => reject(new Error(`pi-host exited ${code}:\n${stderr}`)));
  });
  writeFileSync(join(dir, "token"), TOKEN);
  const file = join(dir, "relay.json");
  writeFileSync(file, JSON.stringify({ listen: "127.0.0.1", port: 0, daemonSocket: socket, roots: [dir], tokenFile: join(dir, "token"), box: "testbox", agentsDir, chatProxyPort: 0 }));
  const config = loadAgentConfig(file);
  assert.equal(config.piHostSocket, socket);
  relay = createAgentRelay(config, noop, { markOwnerTurn: async () => {}, lead: async () => {}, setPool: async () => {}, readPool: async () => ({}) });
  await listen(relay.relay, "127.0.0.1");
  await listen(relay.proxy, "127.0.0.1");
  base = `127.0.0.1:${port(relay.relay)}`;
  proxyBase = `http://127.0.0.1:${port(relay.proxy)}`;
});

after(async () => {
  await relay?.close();
  worker?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** The fake chat server's side of one link: it records every frame and answers chat_http calls with `chatAnswer`. */
class FakeServer {
  frames = [];
  waiters = [];
  nextId = 1;
  closed = new Promise(resolve => { this.onClosed = resolve; });

  constructor(token = TOKEN) {
    this.ws = new WebSocket(`ws://${base}/v2/agents`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on("message", data => {
      const frame = JSON.parse(String(data));
      this.frames.push(frame);
      if (frame.type === "call" && frame.op === "chat_http") this.ws.send(JSON.stringify({ type: "result", id: frame.id, ok: true, data: { status: 201, headers: { "content-type": "application/json", "x-seen": `${frame.args.method} ${frame.args.path} ${frame.args.body ?? ""}` }, body: "{\"posted\":true}" } }));
      for (const waiter of [...this.waiters]) if (waiter.match(frame)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(frame); }
    });
    this.ws.on("close", (code, reason) => this.onClosed({ code, reason: String(reason) }));
    this.ws.on("error", noop);
  }

  next(match, ms = 20_000) {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => reject(new Error(`no matching frame in ${ms} ms; frames: ${JSON.stringify(this.frames).slice(-1500)}`)), ms).unref();
    });
  }

  async welcome(feedAfter) {
    const hello = await this.next(frame => frame.type === "hello");
    this.ws.send(JSON.stringify({ type: "welcome", protocol: 1, feedAfter }));
    return hello;
  }

  send(op, args) {
    const id = `s${this.nextId++}`;
    this.ws.send(JSON.stringify({ type: "call", id, op, args }));
    return id;
  }

  async call(op, args) {
    const id = this.send(op, args);
    return this.next(frame => frame.type === "result" && frame.id === id, 60_000);
  }

  rows() {
    return this.frames.filter(frame => frame.type === "event").map(frame => frame.row);
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

function http(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const inputsWith = (entries, text) => entries.filter(entry => entry.kind === "pi.user" && JSON.stringify(entry).includes(text));
let thread;
let alphaSeq;
let betaSeq;

test("the v1 routes stay, and /v2/agents refuses a wrong token", async () => {
  assert.equal((await http(`http://${base}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  const refused = await new Promise(resolve => {
    const ws = new WebSocket(`ws://${base}/v2/agents`, { headers: { authorization: "Bearer wrong" } });
    ws.on("unexpected-response", (_req, response) => resolve(response.statusCode));
    ws.on("error", noop);
  });
  assert.equal(refused, 401);
  const piped = await new Promise((resolve, reject) => {
    const raw = connect(port(relay.relay), "127.0.0.1");
    let text = "";
    raw.on("data", chunk => { text += chunk; if (text.includes("daemon_hello")) { raw.destroy(); resolve(text); } });
    raw.on("error", reject);
    raw.write(`GET /v1/daemon HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: prime-daemon\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
  });
  assert.match(piped, /^HTTP\/1.1 101/);
});

test("the chat proxy answers 503 with no link", async () => {
  const answer = await http(`${proxyBase}/api/rooms`);
  assert.equal(answer.status, 503);
  assert.match(JSON.parse(answer.body).error, /no live link/);
});

test("hello, welcome, a delivery with its watch events and its feed row, then the chat proxy passes through", async () => {
  const server = new FakeServer();
  const hello = await server.welcome(0);
  assert.equal(hello.protocol, 1);
  assert.equal(hello.box, "testbox");
  assert.equal(hello.piHost.up, true);
  assert.equal(hello.info.agentsDir, agentsDir);
  assert.ok(Array.isArray(hello.info.projects));
  const created = await server.call("durable_create", { name: "relay test" });
  assert.equal(created.ok, true, JSON.stringify(created));
  thread = created.data.thread.id;
  assert.equal((await server.call("watch", { watch: "w1", thread })).ok, true);
  const submitted = await server.call("durable_submit", { thread, text: "SPEAK alpha", requestId: "d:p1:ag_test" });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const event = await server.next(frame => frame.type === "event" && frame.row.text === "alpha");
  assert.equal(event.row.thread, thread);
  assert.match(event.row.requestId, new RegExp(`^m:${thread}:`));
  alphaSeq = event.row.seq;
  server.ws.send(JSON.stringify({ type: "ack", seq: alphaSeq }));
  await server.next(frame => frame.type === "watch_event" && frame.watch === "w1" && frame.event.type === "events");
  assert.ok(server.frames.filter(frame => frame.type === "watch_event").every(frame => frame.watch === "w1"));
  assert.equal((await server.call("unwatch", { watch: "w1" })).ok, true);

  const proxied = await http(`${proxyBase}/api/rooms/dm_x/posts`, { method: "POST", headers: { "content-type": "application/json" } }, "{\"text\":\"hi\"}");
  assert.equal(proxied.status, 201);
  assert.equal(proxied.body, "{\"posted\":true}");
  assert.equal(proxied.headers["x-seen"], "POST /api/rooms/dm_x/posts {\"text\":\"hi\"}");
  await server.close();
  assert.equal((await http(`${proxyBase}/api/rooms`)).status, 503);
});

test("file ops stay inside agentsDir, and check runs a shell command from home", async () => {
  const server = new FakeServer();
  await server.welcome(alphaSeq);
  const outside = await server.call("file_get", { path: join(dir, "token") });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /outside/);
  const escape = await server.call("file_put", { path: join(agentsDir, "..", "evil.md"), text: "x" });
  assert.equal(escape.ok, false);
  const missing = await server.call("file_get", { path: join(agentsDir, "ag_test", "brief.md") });
  assert.deepEqual(missing.data, { exists: false });
  assert.equal((await server.call("file_put", { path: join(agentsDir, "ag_test", "brief.md"), text: "Be brief." })).ok, true);
  const read = await server.call("file_get", { path: join(agentsDir, "ag_test", "brief.md") });
  assert.equal(read.data.text, "Be brief.");
  assert.equal((await server.call("file_put", { path: join(agentsDir, "ag_test", "brief.md"), delete: true })).ok, true);
  const check = await server.call("check", { command: "echo hi; exit 3", timeoutMs: 10_000 });
  assert.deepEqual(check.data, { ok: false, code: 3, output: "hi\n" });
  assert.equal((await server.call("box_info", {})).data.box, "testbox");
  await server.close();
});

test("a link dropped mid-delivery, then the same requestId again: pi-host keeps one input and the feed sends one row", async () => {
  const first = new FakeServer();
  await first.welcome(alphaSeq);
  await first.next(frame => frame.type === "hello");
  // The frame is on the wire when the send callback runs, and the link drops before pi-host's answer can come back.
  first.ws.send(JSON.stringify({ type: "call", id: "s-drop", op: "durable_submit", args: { thread, text: "SLOW beta", requestId: "d:p2:ag_test" } }), () => first.ws.terminate());
  await first.closed;

  const second = new FakeServer();
  await second.welcome(alphaSeq);
  // The first copy reached pi-host before the link dropped, so the copy below is a true retry.
  for (let tries = 0; ; tries++) {
    const seen = await second.call("durable_entries", { thread, conversation: 1, limit: 200 });
    if (inputsWith(seen.data.entries, "SLOW beta").length) break;
    assert.ok(tries < 100, "the dropped submit never reached pi-host");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const again = await second.call("durable_submit", { thread, text: "SLOW beta", requestId: "d:p2:ag_test" });
  assert.equal(again.ok, true, JSON.stringify(again));
  const row = await second.next(frame => frame.type === "event" && frame.row.text === "beta");
  betaSeq = row.row.seq;
  assert.ok(betaSeq > alphaSeq);
  const settled = await second.call("durable_wait", { thread, submission: again.data.submission });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  const entries = await second.call("durable_entries", { thread, conversation: 1, limit: 200 });
  assert.equal(inputsWith(entries.data.entries, "SLOW beta").length, 1);
  assert.equal(second.rows().filter(r => r.text === "beta").length, 1);
  assert.equal(second.rows().filter(r => r.text === "alpha").length, 0);
  await second.close();
});

test("rows made while no link is up come on the next link from the server's cursor", async () => {
  const direct = await PiHostSocket.open(socket);
  const submitted = await direct.call("durable_submit", { thread, text: "SPEAK gamma", requestId: "d:p3:ag_test" });
  assert.equal(submitted.ok, true);
  assert.equal((await direct.call("durable_wait", { thread, submission: submitted.data.submission })).ok, true);
  direct.close();

  const server = new FakeServer();
  await server.welcome(betaSeq);
  await server.next(frame => frame.type === "event" && frame.row.text === "gamma");
  assert.deepEqual(server.rows().map(r => r.text), ["gamma"]);

  const fromStart = new FakeServer();
  await fromStart.welcome(0);
  await fromStart.next(frame => frame.type === "event" && frame.row.text === "gamma");
  assert.deepEqual(fromStart.rows().map(r => r.text), ["alpha", "beta", "gamma"]);
  await fromStart.close();

  worker.kill("SIGTERM");
  const closed = await server.closed;
  assert.equal(closed.code, 1011);
  assert.match(closed.reason, /pi-host closed/);
});
