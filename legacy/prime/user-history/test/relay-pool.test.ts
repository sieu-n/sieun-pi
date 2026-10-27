// Guards the owner's 10-22 ask "Change this box's queue limits from the chat app on the box itself. bs": Settings > Hosts showed another box's
// turn queue but could not change it. The chat now writes any box's queue switch and limits, another box's through its relay's POST /v1/pool.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseHostQueueInput } from "../src/chat-agent-queue.ts";
import { asset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { parsePool } from "../src/chat-hosts.ts";
import { startChatServer } from "../src/chat-server.ts";
import { relayPool, type Host } from "../src/hosts.ts";
import type { AgentQueueInput, AgentQueueView } from "../src/shared/types.ts";

const TOKEN = "t".repeat(40);
type Key = "agent_queue_on" | "working_max" | "tree_working_max";
type SetPool = (key: Key, value: number) => Promise<void>;
type Settings = Record<Key, number>;

/** A box's `pi-pool queue --json` and `pi-pool config` for these settings, as the relay's pool reading passes them on. */
const reading = (state: Settings) => ({ queue: { enabled: state.agent_queue_on === 1, working_max: state.working_max, tree_working_max: state.tree_working_max, working: [], queued: [] },
  config: { ...state } });

async function relay(t: { after: (fn: () => unknown) => void }, state: Settings, calls: [Key, number][]): Promise<{ host: Host; base: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "relay-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "token"), TOKEN + "\n");
  const setPool: SetPool = async (key, value) => { calls.push([key, value]); state[key] = value; };
  const relayModule = "../../../../components/prime-relay/relay.mjs";
  const { createRelay } = await import(relayModule) as { createRelay: (config: object, log?: unknown, options?: { setPool?: SetPool; readPool?: () => Promise<unknown> }) => Server };
  const server = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(dir, "none.sock"), roots: [], token: TOKEN }, () => {}, { setPool, readPool: async () => reading(state) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  return { dir, base: `http://127.0.0.1:${port}`, host: { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: port, token: `file:${join(dir, "token")}`, daemonSocket: "/tmp/none.sock", ssh: null, roles: {} } };
}

test("relayPool sets working_max on another box through its relay, and the answer and GET /v1/host both read the new limit", async t => {
  const state: Settings = { agent_queue_on: 1, working_max: 4, tree_working_max: 2 };
  const calls: [Key, number][] = [];
  const { host, base } = await relay(t, state, calls);
  const reply = await relayPool(host, "working_max", 9);
  assert.deepEqual(calls, [["working_max", 9]]);
  const pool = parsePool(reply.pool, () => null);
  assert.ok(pool.state === "read");
  assert.equal(pool.workingMax, 9);
  assert.equal(pool.treeWorkingMax, 2);
  const stats = await (await fetch(`${base}/v1/host`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as { pool: unknown };
  const read = parsePool(stats.pool, () => null);
  assert.ok(read.state === "read");
  assert.equal(read.workingMax, 9, "the box's own reading carries the write");
  const off = parsePool((await relayPool(host, "agent_queue_on", 0)).pool, () => null);
  assert.ok(off.state === "read");
  assert.equal(off.enabled, false);
});

test("the relay's POST /v1/pool refuses a key or value outside its ranges with 400 and never calls pi-pool", async t => {
  const state: Settings = { agent_queue_on: 1, working_max: 4, tree_working_max: 2 };
  const calls: [Key, number][] = [];
  const { host, base } = await relay(t, state, calls);
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const bodies = ["not json", "null", JSON.stringify({ key: "rm -rf /", value: 1 }), JSON.stringify({ key: "constructor", value: 1 }), JSON.stringify({ key: "working_max", value: 0 }),
    JSON.stringify({ key: "working_max", value: 1000 }), JSON.stringify({ key: "working_max", value: 2.5 }), JSON.stringify({ key: "working_max", value: "6" }),
    JSON.stringify({ key: "tree_working_max", value: -1 }), JSON.stringify({ key: "agent_queue_on", value: 2 }), JSON.stringify({ value: 3 })];
  for (const body of bodies) {
    const response = await fetch(`${base}/v1/pool`, { method: "POST", body, headers });
    assert.equal(response.status, 400, body);
    assert.equal(typeof ((await response.json()) as { error?: unknown }).error, "string");
  }
  await assert.rejects(relayPool(host, "working_max", 1000), /relay mac answered 400 to \/v1\/pool: working_max takes a whole number from 1 to 999/);
  assert.equal((await fetch(`${base}/v1/pool`, { method: "POST", body: JSON.stringify({ key: "working_max", value: 5 }) })).status, 401);
  assert.deepEqual(calls, []);
  assert.deepEqual(state, { agent_queue_on: 1, working_max: 4, tree_working_max: 2 });
});

test("a relay from before /v1/pool answers 404, and the chat says to install the new relay on that box", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-pool-old-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "token"), TOKEN + "\n");
  // The 404 an old relay (VERSION 3) sends for every route it does not know.
  const old = createServer((_request, response) => { response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "unknown route" })); });
  old.listen(0, "127.0.0.1");
  await once(old, "listening");
  t.after(() => { old.closeAllConnections(); old.close(); });
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (old.address() as { port: number }).port, token: `file:${join(dir, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };
  await assert.rejects(relayPool(host, "working_max", 6), { message: "The relay on mac is too old to change its queue limits. Run components/prime-relay/install.mjs there." });
});

test("parseHostQueueInput takes a box and a queue switch or limit write, and refuses the idle time, a missing box and a bad value", () => {
  assert.deepEqual(parseHostQueueInput({ host: "mac", action: "mac", value: 8 }), { host: "mac", action: "mac", value: 8 });
  assert.deepEqual(parseHostQueueInput({ host: "us-metal02", action: "tree", value: 3 }), { host: "us-metal02", action: "tree", value: 3 });
  assert.deepEqual(parseHostQueueInput({ host: "mac", action: "queue", on: false }), { host: "mac", action: "queue", on: false });
  assert.throws(() => parseHostQueueInput({ action: "mac", value: 8 }), /Name the box/);
  assert.throws(() => parseHostQueueInput({ host: "", action: "mac", value: 8 }), /Name the box/);
  assert.throws(() => parseHostQueueInput({ host: "mac", action: "idle", value: 30 }), /idle unload time/);
  for (const value of [0, 1000, 2.5, "8", null]) assert.throws(() => parseHostQueueInput({ host: "mac", action: "mac", value }), /whole number from 1 to 999/);
  assert.throws(() => parseHostQueueInput({ host: "mac", action: "queue", on: "yes" }));
  assert.throws(() => parseHostQueueInput(null), /Name the box/);
});

test("POST api/hosts/queue writes this box through its own Agent queue and another box through its relay, and 404s a box not in hosts.json", async t => {
  const state: Settings = { agent_queue_on: 1, working_max: 4, tree_working_max: 2 };
  const calls: [Key, number][] = [];
  const { host, dir } = await relay(t, state, calls);
  const self = hostname().split(".")[0]!.toLowerCase();
  const hostsFile = join(dir, "hosts.json");
  await writeFile(hostsFile, JSON.stringify({ version: 1, hosts: [{ ...host, name: "box", hostname: self, address: "127.0.0.2" }, host] }));
  const before = process.env.SIEUN_PI_HOSTS;
  process.env.SIEUN_PI_HOSTS = hostsFile;
  t.after(() => { if (before === undefined) delete process.env.SIEUN_PI_HOSTS; else process.env.SIEUN_PI_HOSTS = before; });
  const applied: AgentQueueInput[] = [];
  const view = (): AgentQueueView => ({ pool: { state: "read", enabled: true, workingMax: 16, workingMaxSet: null, treeWorkingMax: 4, working: [], queued: [], rows: [] }, idleEvictionMinutes: "off", history: [] });
  const backend = { close: async () => {}, catalog: { title: () => null },
    agentQueue: { view: async () => view(), apply: async (input: AgentQueueInput) => { applied.push(input); return view(); } } } as unknown as ChatBackend;
  const empty = asset(Buffer.from(""), "text/plain");
  const server = await startChatServer({ backend, bundle: { js: empty, css: empty, version: "hosts-queue" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-hosts-queue.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const post = async (body: unknown) => {
    const response = await fetch(new URL("api/hosts/queue", server.url), { method: "POST", headers: { "content-type": "application/json", "x-chat-token": "token", origin: new URL(server.url).origin },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const remote = await post({ host: "mac", action: "tree", value: 5 });
  assert.equal(remote.status, 200);
  assert.equal(remote.body.state, "read");
  assert.equal(remote.body.treeWorkingMax, 5);
  assert.deepEqual(calls, [["tree_working_max", 5]]);
  const local = await post({ host: "box", action: "mac", value: 12 });
  assert.equal(local.status, 200);
  assert.equal(local.body.workingMax, 16);
  assert.deepEqual(applied, [{ host: "box", action: "mac", value: 12 }]);
  assert.equal((await post({ host: "nowhere", action: "mac", value: 3 })).status, 404);
  assert.equal((await post({ host: "mac", action: "mac", value: 0 })).status, 400);
  assert.equal((await post({ host: "mac", action: "idle", value: 30 })).status, 400);
  assert.deepEqual(calls, [["tree_working_max", 5]], "a refused write reaches no box");
});
